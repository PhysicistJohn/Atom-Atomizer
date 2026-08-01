import {
  channelMeasurementConfigurationSchema,
  projectDetectedPowerTuneHz,
  type CanonicalInstrumentSurface,
  type CanonicalOperation,
  type ChannelMeasurementConfiguration,
  type DetectedSignal,
  type DetectedPowerCaptureReceipt,
  type InstrumentConfigurationState,
  type InstrumentSessionSnapshot,
  type Sweep,
  type ZeroSpanCapture,
  type SweptSpectrumConfiguration,
  type DetectedPowerTimeseriesConfiguration,
} from '@tinysa/contracts';
import { classifyZeroSpanEnvelope, createDetectedPowerCaptureReceipt } from '@tinysa/analysis';
import { projectDerivedSpectrumFromComplexIq, projectDetectedPowerMeasurement, projectSpectrumMeasurement } from '../instrument-measurement-projection.js';
import {
  type ComplexIqConfiguration,
  type ComplexIqMeasurement,
} from '../complex-iq.js';
import { formatFrequency } from '../format.js';
import { resolveVisibleClassificationTargetSelection } from '../classification-target-selection.js';
import { resolveRuntimeAdmittedCaptureTarget } from './classification-helpers.js';
import { HISTORY_LIMIT, selectIqCapability } from '../store.js';
import {
  CONTINUOUS_IQ_TRANSACTION,
  errorMessage,
  sameStructuredValue,
  type ContinuousIqConfigurationOwnership,
  type ContinuousMeasurementWork,
  type ContinuousStreamOwnership,
  type RendererConfigurationRevision,
  type RendererKernel,
} from './kernel.js';

// The renderer and analysis workers consume complete buffers. Ten complete
// I/Q buffers per second keeps the 500 ms classifier trend responsive without
// retaining an unbounded amount of evidence in the renderer.
const MAXIMUM_GLOBAL_IQ_FRAMES_PER_SECOND = 10;
type GlobalAcquisitionKind = 'complex-iq' | 'swept-spectrum';

/** Pace complete I/Q buffers to their admitted capture duration without
 * producing frames faster than the browser can present them. Each published
 * buffer is independently offered to the latest-wins classification worker. */
export function continuousIqFramePeriodMilliseconds(
  configuration: Pick<ComplexIqConfiguration, 'sampleCount' | 'sampleRateHz'>,
): number {
  return Math.max(
    1_000 / MAXIMUM_GLOBAL_IQ_FRAMES_PER_SECOND,
    configuration.sampleCount / configuration.sampleRateHz * 1_000,
  );
}

export class AcquisitionController {
  constructor(private readonly k: RendererKernel) {}

  admitContinuousMeasurement(work: ContinuousMeasurementWork): void {
    // IPC events already arrive serially on the renderer event loop. Perform
    // the bounded projection/detection/tracking ingest synchronously for every
    // sweep so history evidence is never silently replaced.
    this.processContinuousMeasurement(work);
  }

  processContinuousMeasurement(work: ContinuousMeasurementWork): void {
    const k = this.k;
    if (!this.isCurrentContinuousWork(work)) return;
    try {
      const { measurement, ownership } = work;
      if (measurement.kind !== 'swept-spectrum') {
        throw new Error(`Expected swept-spectrum streaming measurement, received ${measurement.kind}`);
      }
      const requested = this.requireConfiguration(measurement.configurationRevision, 'swept-spectrum', `Continuous measurement ${measurement.measurementId}`) as SweptSpectrumConfiguration;
      if (measurement.configurationRevision !== ownership.configurationRevision) {
        throw new Error(`Continuous measurement ${measurement.measurementId} referenced ${measurement.configurationRevision}; active stream owns ${ownership.configurationRevision}`);
      }
      const projected = projectSpectrumMeasurement(measurement, work.session, requested);
      const recorded = this.recordSweepEvidence(
        projected,
        measurement.configurationRevision,
      );
      if (!recorded) throw new Error(`Sweep ${projected.id} was acquired for a superseded analyzer configuration`);
    } catch (value) {
      if (!this.isCurrentContinuousWork(work)) return;
      const message = `Sweep analysis failed: ${errorMessage(value)}`;
      k.set({ acquisition: 'failed', error: message });
      this.requestContinuousMeasurementStop(work.ownership, message);
    }
  }

  isCurrentContinuousOwnership(ownership: ContinuousStreamOwnership): boolean {
    const k = this.k;
    const current = k.continuousStreamOwnership.current;
    return current === ownership
      && current.generation === ownership.generation
      && k.state.instrument.session?.sessionId === ownership.sessionId
      && k.continuousRequested.current;
  }

  isCurrentContinuousWork(work: ContinuousMeasurementWork): boolean {
    return this.isCurrentContinuousOwnership(work.ownership);
  }

  requestContinuousMeasurementStop(ownership: ContinuousStreamOwnership, message: string): void {
    const k = this.k;
    if (k.continuousStreamOwnership.current !== ownership
      || k.failedContinuousMeasurementStopGeneration.current === ownership.generation) return;
    k.continuousMeasurementStopRequest.current = { ownership, message };
    this.drainContinuousMeasurementStop();
  }

  drainContinuousMeasurementStop(): void {
    const k = this.k;
    if (k.continuousMeasurementStopTask.current || k.instrumentTransactionOwner.current) return;
    const request = k.continuousMeasurementStopRequest.current;
    if (!request) return;
    k.continuousMeasurementStopRequest.current = undefined;
    const task = this.runInstrumentTransaction('stop-invalid-continuous-measurement', async () => {
      if (k.continuousStreamOwnership.current !== request.ownership) return;
      k.continuousRequested.current = false;
      try {
        await this.stopStreamingAndReleaseConfiguration(request.ownership);
        k.set({ continuous: false });
      }
      catch (value) {
        k.failedContinuousMeasurementStopGeneration.current = request.ownership.generation;
        k.set({ error: `${request.message}. Stream stop also failed: ${errorMessage(value)}` });
        throw value;
      }
    });
    k.continuousMeasurementStopTask.current = task;
    void task.then(
      () => this.finishContinuousMeasurementStopTask(task),
      () => this.finishContinuousMeasurementStopTask(task),
    );
  }

  finishContinuousMeasurementStopTask(task: Promise<void>): void {
    if (this.k.continuousMeasurementStopTask.current !== task) return;
    this.k.continuousMeasurementStopTask.current = undefined;
    this.drainContinuousMeasurementStop();
  }

  requireConfiguration(
    revision: string,
    kind: RendererConfigurationRevision['kind'],
    context: string,
  ): RendererConfigurationRevision['admitted'] {
    const retained = this.k.configurationRevisions.current.read(revision);
    if (!retained) throw new Error(`${context} referenced unknown configuration ${revision}`);
    if (retained.kind !== kind) throw new Error(`${context} referenced ${retained.kind} configuration ${revision}, expected ${kind}`);
    return retained.admitted;
  }

  /** Kind-checked existence assertion for a committed revision (the retired
   * lease acquisition, minus the lease). */
  requireConfigurationEntry(revision: string, kind: RendererConfigurationRevision['kind']): void {
    const retained = this.k.configurationRevisions.current.read(revision);
    if (!retained) throw new Error(`Configuration revision ${revision} is not retained`);
    if (retained.kind !== kind) {
      throw new Error(`Configuration revision ${revision} is ${retained.kind}, expected ${kind}`);
    }
  }

  /**
   * The driver owns configuration resolution.  A canonical operation emits
   * this exact state through the ordinary session lifecycle; the renderer only
   * retains it for measurement binding and never rebuilds it from UI staging.
   */
  activeConfiguration(): InstrumentConfigurationState {
    const configuration = this.k.requireConnected().configuration;
    if (!configuration) throw new Error('Apply driver controls before acquiring');
    const admitted = configuration.configuration;
    if (admitted.kind === 'swept-spectrum') {
      this.k.configurationRevisions.current.commit(configuration.configurationRevision, {
        kind: 'swept-spectrum', admitted,
      });
    } else if (admitted.kind === 'detected-power-timeseries') {
      this.k.configurationRevisions.current.commit(configuration.configurationRevision, {
        kind: 'detected-power-timeseries', admitted,
      });
    } else {
      this.k.configurationRevisions.current.commit(configuration.configurationRevision, {
        kind: 'complex-iq', admitted,
      });
    }
    return configuration;
  }

  requireActiveConfiguration(
    kind: RendererConfigurationRevision['kind'],
    label: string,
  ): InstrumentConfigurationState {
    const configuration = this.activeConfiguration();
    if (configuration.configuration.kind !== kind) {
      throw new Error(`Apply driver controls for ${label} before acquiring`);
    }
    return configuration;
  }

  clearContinuousStreamOwnership(expected?: ContinuousStreamOwnership): void {
    const k = this.k;
    if (expected && k.continuousStreamOwnership.current !== expected) return;
    k.continuousStreamOwnership.current = undefined;
    if (!expected || k.continuousMeasurementStopRequest.current?.ownership === expected) {
      k.continuousMeasurementStopRequest.current = undefined;
    }
    k.failedContinuousMeasurementStopGeneration.current = undefined;
  }

  async stopStreamingAndReleaseConfiguration(expected?: ContinuousStreamOwnership): Promise<void> {
    // A rejected stop leaves the ownership flag intact. The main process may
    // still own a live acquisition run, so the renderer must keep consuming
    // its measurements and allow a later retry.
    const k = this.k;
    const ownership = expected ?? k.continuousStreamOwnership.current;
    if (expected && k.continuousStreamOwnership.current !== expected) return;
    await window.atomizerInstrument.stopStreaming();
    // Every operational caller uses the renderer transaction gate. This
    // identity check additionally prevents delayed event-failure cleanup from
    // releasing the ownership of a replacement stream generation.
    if (k.continuousStreamOwnership.current !== ownership) return;
    this.clearContinuousStreamOwnership(ownership);
  }

  async startStreamingWithConfiguration(revision: string): Promise<void> {
    const k = this.k;
    const sessionId = k.requireConnected().sessionId;
    if (k.continuousStreamOwnership.current) throw new Error('A continuous stream generation is already owned');
    this.requireConfigurationEntry(revision, 'swept-spectrum');
    const ownership: ContinuousStreamOwnership = {
      generation: ++k.continuousStreamGeneration.current,
      sessionId,
      configurationRevision: revision,
    };
    k.continuousStreamOwnership.current = ownership;
    k.failedContinuousMeasurementStopGeneration.current = undefined;
    try {
      await window.atomizerInstrument.startStreaming();
      if (k.state.instrument.session?.sessionId !== sessionId || k.continuousStreamOwnership.current !== ownership) {
        throw new Error(`Continuous acquisition start was invalidated with instrument session ${sessionId}`);
      }
    } catch (startFailure) {
      try {
        await this.stopStreamingAndReleaseConfiguration(ownership);
      } catch (stopFailure) {
        throw new AggregateError(
          [startFailure, stopFailure],
          `Continuous acquisition start was not acknowledged and compensating stop also failed: ${errorMessage(startFailure)}; ${errorMessage(stopFailure)}`,
        );
      }
      throw startFailure;
    }
  }

  async runInstrumentTransaction<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const k = this.k;
    const backgroundGlobalAcquisition = k.continuousRequested.current
      && k.state.continuousMode === 'complex-iq'
      && name === CONTINUOUS_IQ_TRANSACTION;
    const pauseIq = !backgroundGlobalAcquisition
      && k.continuousRequested.current
      && k.state.continuousMode === 'complex-iq';
    if (pauseIq) k.continuousIqPauseDepth.current++;
    try {
      const active = k.instrumentTransactionOwner.current;
      if (active === CONTINUOUS_IQ_TRANSACTION && pauseIq) {
        const acquisition = k.continuousGlobalAcquisitionTask.current;
        if (!acquisition) throw new Error('Continuous global transaction has no owned bounded acquisition task');
        try { await acquisition; } catch { /* The pump reports its own capability-local failure. */ }
      }
      const admittedAfterPause = k.instrumentTransactionOwner.current;
      if (admittedAfterPause) {
        throw new Error(`Instrument operation ${admittedAfterPause} is already active; ${name} was not admitted`);
      }
      k.instrumentTransactionOwner.current = name;
      if (!backgroundGlobalAcquisition) k.set({ instrumentTransactionActive: true });
      try { return await operation(); }
      finally {
        if (k.instrumentTransactionOwner.current === name) {
          k.instrumentTransactionOwner.current = undefined;
          if (!backgroundGlobalAcquisition) k.set({ instrumentTransactionActive: false });
          this.drainContinuousMeasurementStop();
          this.drainOperatorContinuousStop();
        }
      }
    } finally {
      if (pauseIq) this.releaseContinuousIqPause();
    }
  }

  releaseContinuousIqPause(): void {
    const k = this.k;
    if (k.continuousIqPauseDepth.current < 1) return;
    k.continuousIqPauseDepth.current--;
    if (k.continuousIqPauseDepth.current !== 0) return;
    for (const resume of k.continuousIqResumeWaiters.current) resume();
    k.continuousIqResumeWaiters.current.clear();
  }

  isCurrentContinuousIqRun(generation: number): boolean {
    const k = this.k;
    return generation === k.continuousIqGeneration.current
      && k.continuousRequested.current
      && k.state.continuousMode === 'complex-iq';
  }

  async waitForContinuousIqAdmission(generation: number): Promise<boolean> {
    const k = this.k;
    while (this.isCurrentContinuousIqRun(generation)
      && k.continuousIqPauseDepth.current > 0) {
      await new Promise<void>((resolve) => k.continuousIqResumeWaiters.current.add(resolve));
    }
    return this.isCurrentContinuousIqRun(generation);
  }

  wakeContinuousIqAdmissionWaiters(): void {
    const k = this.k;
    for (const resume of k.continuousIqResumeWaiters.current) resume();
    k.continuousIqResumeWaiters.current.clear();
    k.continuousIqCadenceWake.current?.();
  }

  async waitForContinuousIqCadence(generation: number, delay: number): Promise<boolean> {
    const k = this.k;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (k.continuousIqCadenceWake.current === finish) k.continuousIqCadenceWake.current = undefined;
        resolve();
      };
      const timer = window.setTimeout(finish, delay);
      k.continuousIqCadenceWake.current = finish;
    });
    return this.isCurrentContinuousIqRun(generation);
  }

  async runWithContinuousPaused<T>(
    label: string,
    operation: () => Promise<T>,
    shouldResume: (result: T) => boolean = () => true,
  ): Promise<T> {
    const k = this.k;
    const ownership = k.continuousStreamOwnership.current;
    if (!ownership
      && k.continuousRequested.current
      && k.state.continuousMode === 'complex-iq') {
      return this.runWithContinuousIqPaused(label, operation, shouldResume);
    }
    if (!k.continuousRequested.current || !ownership) return operation();
    try {
      const sessionId = ownership.sessionId;
      k.set({ acquisition: 'retuning', notice: `Pausing continuous acquisition for ${label}…` });
      await this.stopStreamingAndReleaseConfiguration(ownership);
      const before = k.requireConnected();
      if (before.sessionId !== sessionId || before.fault) {
        throw new Error(`${label} was invalidated with instrument session ${sessionId}`);
      }

      const result = await operation();
      const after = k.requireConnected();
      if (after.sessionId !== sessionId || after.fault) {
        throw new Error(`${label} completed for a superseded instrument session ${sessionId}`);
      }
      if (!k.continuousRequested.current) {
        this.completeContinuousStop(`Continuous acquisition stopped after ${label}`);
        return result;
      }
      // Resume is admitted only after the conflicting operation and all of its
      // renderer-side acknowledgement checks succeed. RF-on intentionally
      // leaves collection stopped because acquisition is not safe in that state.
      if (!shouldResume(result)) {
        k.set({ acquisition: 'complete', notice: `Continuous acquisition stopped after ${label}` });
        return result;
      }
      if (k.currentGeneratorOutput() !== 'off') {
        throw new Error(`Continuous acquisition cannot resume after ${label} while RF output is ${k.currentGeneratorOutput()}`);
      }
      const resumed = await this.resumeContinuousWithActiveConfiguration(sessionId, label);
      if (!resumed) this.completeContinuousStop(`Continuous acquisition stopped after ${label}`);
      return result;
    } catch (value) {
      k.continuousRequested.current = false;
      if (!k.continuousStreamOwnership.current) k.set({ continuous: false });
      k.set({ acquisition: 'failed', notice: undefined, error: `${label} failed: ${errorMessage(value)}` });
      throw value;
    }
  }

  async runWithContinuousIqPaused<T>(
    label: string,
    operation: () => Promise<T>,
    shouldResume: (result: T) => boolean,
  ): Promise<T> {
    const k = this.k;
    const sessionId = k.requireConnected().sessionId;
    const generation = k.continuousIqGeneration.current;
    try {
      k.set({ acquisition: 'retuning', notice: `Pausing bounded I/Q acquisition for ${label}…` });
      const result = await operation();
      const after = k.requireConnected();
      if (after.sessionId !== sessionId || after.fault) {
        throw new Error(`${label} completed for a superseded instrument session ${sessionId}`);
      }
      if (!k.continuousRequested.current || generation !== k.continuousIqGeneration.current) {
        this.completeContinuousStop(`Continuous I/Q acquisition stopped after ${label}`);
        return result;
      }
      if (!shouldResume(result)) {
        this.completeContinuousStop(`Continuous I/Q acquisition stopped after ${label}`);
        return result;
      }
      if (k.currentGeneratorOutput() !== 'off') {
        throw new Error(`Continuous I/Q acquisition cannot resume after ${label} while RF output is ${k.currentGeneratorOutput()}`);
      }
      if (after.configuration?.configuration.kind !== 'complex-iq') {
        this.completeContinuousStop(`Continuous I/Q acquisition stopped after ${label}; apply driver controls to resume`);
        return result;
      }
      k.set({ acquisition: 'streaming', notice: `Continuous I/Q acquisition resumed after ${label}` });
      return result;
    } catch (value) {
      k.continuousRequested.current = false;
      this.wakeContinuousIqAdmissionWaiters();
      this.releaseContinuousIqConfiguration();
      k.set({ continuous: false, acquisition: 'failed', notice: undefined, error: `${label} failed: ${errorMessage(value)}` });
      throw value;
    }
  }

  /** Resume only the exact swept-spectrum configuration still admitted by the
   * driver. A renderer-side configuration cache must never reconstruct a
   * device command after a conflicting operation. */
  async resumeContinuousWithActiveConfiguration(sessionId: string, label: string): Promise<boolean> {
    const k = this.k;
    k.set({ acquisition: 'retuning' });
    if (!k.continuousRequested.current) return false;
    const active = k.requireConnected();
    if (active.sessionId !== sessionId || active.fault) {
      throw new Error(`Continuous acquisition resume was invalidated with instrument session ${sessionId}`);
    }
    if (active.configuration?.configuration.kind !== 'swept-spectrum') return false;
    const configuration = this.activeConfiguration();
    await this.startStreamingWithConfiguration(configuration.configurationRevision);
    if (!k.continuousRequested.current) {
      await this.stopStreamingAndReleaseConfiguration();
      return false;
    }
    if (k.state.instrument.session?.sessionId !== sessionId
      || k.state.instrument.session?.configuration?.configurationRevision !== configuration.configurationRevision
      || k.continuousStreamOwnership.current?.configurationRevision !== configuration.configurationRevision) {
      await this.stopStreamingAndReleaseConfiguration();
      return false;
    }
    k.set({ acquisition: 'streaming', notice: `Continuous acquisition resumed after ${label}` });
    return true;
  }

  recordSweepEvidence(
    next: Sweep,
    configurationRevision: string,
  ): boolean {
    const k = this.k;
    void configurationRevision;
    // A host-derived-from-complex-iq sweep is a post-hoc FFT projection, not
    // a native swept-spectrum acquisition -- it never corresponds to an
    // admitted swept-spectrum analyzer configuration, so the staleness check
    // below (which exists to reject sweeps from a superseded analyzer stage)
    // does not apply to it.
    if (next.source !== 'host-derived-from-complex-iq') {
      const active = k.state.instrument.session?.configuration;
      const currentAdmitted = active?.configuration.kind === 'swept-spectrum'
        ? active.configuration
        : undefined;
      if (!currentAdmitted || !sameStructuredValue(next.requested, currentAdmitted)) {
        console.warn('[Analyzer] rejected stale sweep for a superseded admitted configuration', { sweepId: next.id, requested: next.requested, admitted: currentAdmitted });
        return false;
      }
    }
    const channelConfiguration = reconcileChannelConfigurationToSweep(
      k.state.channelConfiguration,
      next,
    );
    k.analysisSequence.current++;
    const nextHistory = [next, ...k.state.history].slice(0, HISTORY_LIMIT);
    const nextTraceFrames = k.traceAccumulator.current.update(next);
    const basePatch = {
      sweep: next,
      history: nextHistory,
      traceFrames: nextTraceFrames,
      firmwareTraceFrames: next.firmwareTraces ?? [],
      ...(channelConfiguration === k.state.channelConfiguration ? {} : { channelConfiguration }),
    };
    let trackerRows: readonly DetectedSignal[];
    try {
      const candidates = k.detector.current.analyze(next);
      trackerRows = k.tracker.current.update(next, candidates);
    } catch (value) {
      // Trace accumulation is stateful. Publish the sweep whose trace was
      // already admitted so a later successful sweep cannot include hidden
      // evidence that is absent from the visible sweep history.
      k.set(basePatch);
      throw value;
    }
    k.set({
      ...basePatch,
      detections: trackerRows,
    });
    if (selectIqCapability(k.state) === undefined) {
      const target = trackerRows
        .filter((signal) => signal.state !== 'released')
        .reduce<DetectedSignal | undefined>((strongest, signal) =>
          strongest && strongest.peakDbm >= signal.peakDbm ? strongest : signal, undefined);
      if (target) k.classification.ingestScalar(next, target);
    }
    return true;
  }

  acquire(): Promise<Sweep> { return this.runInstrumentTransaction('acquire-spectrum', () => this.acquireOwned()); }

  async acquireOwned(options: { readonly background?: boolean } = {}): Promise<Sweep> {
    const k = this.k;
    const background = options.background === true;
    try {
      const configured = this.requireActiveConfiguration('swept-spectrum', 'a spectrum');
      this.requireConfigurationEntry(configured.configurationRevision, 'swept-spectrum');
      if (!background) k.set({ acquisition: 'acquiring' });
      const next = await this.acquireConfiguredSpectrum(configured);
      const recorded = this.recordSweepEvidence(next, configured.configurationRevision);
      if (!recorded) throw new Error(`Sweep ${next.id} was acquired for a superseded analyzer configuration`);
      if (!background) k.set({ acquisition: 'complete' });
      return next;
    } catch (value) {
      if (!background) k.set({ acquisition: 'failed', error: errorMessage(value) });
      throw value;
    }
  }

  async acquireConfiguredSpectrum(configured: InstrumentConfigurationState): Promise<Sweep> {
    const k = this.k;
    const sessionId = configured.sessionId;
    const measurement = await window.atomizerInstrument.acquire();
    if (measurement.kind !== 'swept-spectrum') throw new Error(`Expected swept-spectrum measurement, received ${measurement.kind}`);
    if (measurement.sessionId !== sessionId || k.state.instrument.session?.sessionId !== sessionId) {
      throw new Error(`Measurement ${measurement.measurementId} was invalidated with instrument session ${sessionId}`);
    }
    if (measurement.configurationRevision !== configured.configurationRevision) {
      throw new Error(`Measurement ${measurement.measurementId} referenced superseding configuration ${measurement.configurationRevision}; expected ${configured.configurationRevision}`);
    }
    const active = k.requireConnected();
    const requested = this.requireConfiguration(measurement.configurationRevision, 'swept-spectrum', `Measurement ${measurement.measurementId}`) as SweptSpectrumConfiguration;
    return projectSpectrumMeasurement(measurement, active, requested);
  }

  async acquireGlobalFrame(): Promise<{ readonly iq?: ComplexIqMeasurement; readonly sweep?: Sweep }> {
    const k = this.k;
    const configuration = this.activeConfiguration().configuration;
    k.classification.reset(true);
    if (configuration.kind === 'complex-iq') return { iq: await this.acquireIq() };
    if (configuration.kind === 'swept-spectrum') return { sweep: await this.acquire() };
    throw new Error('Apply driver controls for a spectrum or complex I/Q acquisition before acquiring');
  }

  async acquireFromUi(): Promise<void> {
    try {
      await this.admitGlobalConfigurationFromAutomaticPrimary();
      await this.acquireGlobalFrame();
    } catch (value) {
      this.k.set({ acquisition: 'failed', error: errorMessage(value) });
    }
  }

  /**
   * Global Run and Single are intentionally one-click operations.  Before a
   * source has an admitted capture shape, use a driver-declared acquisition
   * operation matching the generic result kind and explicit Auto intents.
   * Atomizer never derives a device setting or guesses a native control; a
   * manually admitted configuration always remains the next operation.
   */
  async admitGlobalConfigurationFromAutomaticPrimary(): Promise<void> {
    const k = this.k;
    const session = k.requireConnected();
    const expectedKind: GlobalAcquisitionKind = selectIqCapability(k.state) === undefined
      ? 'swept-spectrum'
      : 'complex-iq';
    if (session.configuration !== undefined) return;

    const readSurface = window.atomizerInstrument.canonicalSurface;
    if (!readSurface) throw new Error('The connected instrument does not publish canonical acquisition controls');
    const surface = await readSurface();
    if (!surface) throw new Error('The connected driver has not declared canonical acquisition controls');
    if (k.state.instrument.session?.sessionId !== session.sessionId) {
      throw new Error('Global acquisition setup was invalidated by a different instrument session');
    }
    const operation = automaticPrimaryAcquisitionOperation(surface, expectedKind);
    if (!operation) {
      throw new Error('The connected driver has no available automatic acquisition operation for Run or Single');
    }
    k.set({
      acquisition: 'configuring',
      error: undefined,
      notice: `Preparing ${operation.label} with driver-selected values…`,
    });
    await k.events.executeCanonicalOperation(surface, operation.id, operation.parameterIds.map((parameterId) => ({
      parameterId,
      intent: { mode: 'auto' } as const,
    })));
    // The canonical acknowledgement carries its refreshed controls but not
    // the admitted configuration. Read the authoritative state before the
    // next transaction so IPC event ordering can never turn one click into a
    // configuration race.
    const observed = await window.atomizerInstrument.getState();
    if (observed.session?.sessionId !== session.sessionId) {
      throw new Error('Global acquisition setup completed for a different instrument session');
    }
    k.events.acceptInstrumentState(observed);
    const configured = k.requireConnected().configuration;
    if (!configured || configured.configuration.kind !== expectedKind) {
      throw new Error(`The driver did not admit a ${expectedKind === 'complex-iq' ? 'complex I/Q' : 'spectrum'} configuration for Run or Single`);
    }
  }

  acquireIq(): Promise<ComplexIqMeasurement> {
    return this.runInstrumentTransaction('acquire-complex-iq', () => this.runWithContinuousPaused(
      'complex I/Q capture',
      () => this.acquireIqOwned(),
    ));
  }

  async acquireIqOwned(options: { readonly publish?: () => boolean } = {}): Promise<ComplexIqMeasurement> {
    const k = this.k;
    const configured = this.requireActiveConfiguration('complex-iq', 'a complex I/Q capture');
    this.requireConfigurationEntry(configured.configurationRevision, 'complex-iq');
    k.set({ error: undefined, acquisition: 'acquiring' });
    try {
      const measurement = await this.acquireConfiguredIq(configured, options.publish);
      k.set({ acquisition: 'complete' });
      return measurement;
    } catch (value) {
      k.set({ acquisition: 'failed', error: errorMessage(value) });
      throw value;
    }
  }

  async acquireConfiguredIq(
    configured: InstrumentConfigurationState,
    publish?: () => boolean,
  ): Promise<ComplexIqMeasurement> {
    const k = this.k;
    const sessionId = configured.sessionId;
    const measurement = await window.atomizerInstrument.acquire();
    if (measurement.kind !== 'complex-iq') throw new Error(`Expected complex-iq measurement, received ${measurement.kind}`);
    if (measurement.sessionId !== sessionId || k.state.instrument.session?.sessionId !== sessionId) {
      throw new Error(`Measurement ${measurement.measurementId} was invalidated with instrument session ${sessionId}`);
    }
    if (measurement.configurationRevision !== configured.configurationRevision) {
      throw new Error(`Measurement ${measurement.measurementId} referenced superseding configuration ${measurement.configurationRevision}; expected ${configured.configurationRevision}`);
    }
    const admitted = this.requireConfiguration(measurement.configurationRevision, 'complex-iq', `Measurement ${measurement.measurementId}`) as ComplexIqConfiguration;
    if (measurement.centerHz !== admitted.centerHz
      || measurement.sampleRateHz !== admitted.sampleRateHz
      || measurement.bandwidthHz !== admitted.bandwidthHz
      || measurement.sampleCount !== admitted.sampleCount
      || measurement.sampleFormat !== admitted.sampleFormat) {
      throw new Error(`Measurement ${measurement.measurementId} geometry differs from its admitted complex-I/Q configuration`);
    }
    if (!publish || publish()) {
      k.set({ iqCapture: measurement });
      k.classification.ingestIq(measurement);
      this.publishDerivedSpectrum(measurement, k.requireConnected());
    }
    return measurement;
  }

  /**
   * Every accepted complex-I/Q measurement from a complex-I/Q-only source
   * also derives a scalar spectrum (a projection of the I/Q vector, per
   * `projectDerivedSpectrumFromComplexIq`) so Spectrum, Waterfall, and
   * Channel stay populated for it. A source that also advertises native
   * swept-spectrum already publishes
   * proper device/twin-observed sweeps through that path -- deriving a
   * second, lower-fidelity sweep alongside it would only pollute history.
   * Best-effort and non-fatal: a projection failure must never fail the I/Q
   * acquisition it rides on.
   */
  publishDerivedSpectrum(measurement: ComplexIqMeasurement, session: InstrumentSessionSnapshot): void {
    const activeConfiguration = session.configuration?.configuration;
    if (activeConfiguration?.kind !== 'complex-iq'
      && session.capabilities.acquisitions.some((candidate) => candidate.kind === 'swept-spectrum')) return;
    try {
      const projected = projectDerivedSpectrumFromComplexIq(measurement, session);
      this.recordSweepEvidence(projected, measurement.configurationRevision);
    } catch (value) {
      console.warn('[Analyzer] failed to derive a scalar spectrum from a complex-I/Q measurement', errorMessage(value));
    }
  }

  startContinuous(): Promise<void> {
    try {
      const configuration = this.activeConfiguration();
      if (configuration.configuration.kind === 'complex-iq') return this.startContinuousIq();
      if (configuration.configuration.kind === 'swept-spectrum') {
        return this.runInstrumentTransaction('start-continuous-acquisition', () => this.startContinuousOwned());
      }
      return Promise.reject(new Error('Apply driver controls for a spectrum or complex I/Q acquisition before starting Run'));
    } catch (value) {
      return Promise.reject(value);
    }
  }

  startContinuousIq(): Promise<void> {
    const k = this.k;
    if (k.continuousRequested.current || k.state.continuous) {
      return Promise.reject(new Error('Continuous acquisition is already running'));
    }
    try { this.requireActiveConfiguration('complex-iq', 'a complex I/Q capture'); }
    catch (value) { return Promise.reject(value); }
    k.classification.reset(true);
    k.continuousRequested.current = true;
    k.continuousIqGeneration.current++;
    k.set({
      continuous: true,
      continuousMode: 'complex-iq',
      acquisition: 'streaming',
      iqCapture: undefined,
      error: undefined,
      notice: 'Global detection and I/Q classification started',
    });
    const task = this.runContinuousIqLoop();
    k.continuousIqTask.current = task;
    void task.then(
      () => this.finishContinuousIqLoop(task),
      (value) => this.finishContinuousIqLoop(task, value),
    );
    return Promise.resolve();
  }

  async runContinuousIqLoop(): Promise<void> {
    const k = this.k;
    const generation = k.continuousIqGeneration.current;
    let nextIqCaptureAt = Number.NEGATIVE_INFINITY;
    while (this.isCurrentContinuousIqRun(generation)) {
      if (!await this.waitForContinuousIqAdmission(generation)) break;
      const iqStartedAt = performance.now();
      const iqTask = this.runInstrumentTransaction(CONTINUOUS_IQ_TRANSACTION, async () => {
        const ownership = await this.ensureContinuousIqConfiguration(generation);
        return this.acquireConfiguredIq(ownership.configured, () =>
          generation === k.continuousIqGeneration.current
          && k.continuousIqConfigurationOwnership.current === ownership
          && k.state.instrument.session?.configuration?.configurationRevision
            === ownership.configured.configurationRevision);
      });
      k.continuousGlobalAcquisitionTask.current = iqTask;
      try {
        const measurement = await iqTask;
        nextIqCaptureAt = iqStartedAt + continuousIqFramePeriodMilliseconds(measurement);
      } finally {
        if (k.continuousGlobalAcquisitionTask.current === iqTask) {
          k.continuousGlobalAcquisitionTask.current = undefined;
        }
      }
      if (!this.isCurrentContinuousIqRun(generation)) break;
      k.set({ acquisition: 'streaming' });
      const delay = Math.max(0, nextIqCaptureAt - performance.now());
      if (!await this.waitForContinuousIqCadence(generation, delay)) break;
    }
    this.releaseContinuousIqConfiguration(generation);
  }

  async ensureContinuousIqConfiguration(generation: number): Promise<ContinuousIqConfigurationOwnership> {
    const k = this.k;
    const configured = this.requireActiveConfiguration('complex-iq', 'a complex I/Q capture');
    const session = k.requireConnected();
    if (configured.configuration.kind !== 'complex-iq') throw new Error('Active configuration is not complex I/Q');
    const existing = k.continuousIqConfigurationOwnership.current;
    if (existing
      && existing.generation === generation
      && existing.sessionId === session.sessionId
      && existing.configured.configurationRevision === configured.configurationRevision
      && k.configurationRevisions.current.has(existing.configured.configurationRevision)) {
      return existing;
    }
    this.releaseContinuousIqConfiguration();
    this.requireConfigurationEntry(configured.configurationRevision, 'complex-iq');
    const ownership: ContinuousIqConfigurationOwnership = {
      generation,
      sessionId: session.sessionId,
      configured,
    };
    k.continuousIqConfigurationOwnership.current = ownership;
    return ownership;
  }

  releaseContinuousIqConfiguration(generation?: number): void {
    const ownership = this.k.continuousIqConfigurationOwnership.current;
    if (generation !== undefined && ownership?.generation !== generation) return;
    this.k.continuousIqConfigurationOwnership.current = undefined;
  }

  finishContinuousIqLoop(task: Promise<void>, failure?: unknown): void {
    const k = this.k;
    if (k.continuousIqTask.current !== task) return;
    k.continuousIqTask.current = undefined;
    this.releaseContinuousIqConfiguration();
    if (failure === undefined || !k.continuousRequested.current) return;
    k.continuousRequested.current = false;
    k.set({
      continuous: false,
      acquisition: 'failed',
      notice: undefined,
      error: `Global analysis acquisition failed: ${errorMessage(failure)}`,
    });
  }

  async startContinuousOwned(): Promise<void> {
    const k = this.k;
    if (k.continuousRequested.current || k.state.continuous) throw new Error('Continuous acquisition is already running');
    const configured = this.requireActiveConfiguration('swept-spectrum', 'a spectrum');
    this.requireConfigurationEntry(configured.configurationRevision, 'swept-spectrum');
    k.classification.reset(true);
    k.continuousRequested.current = true;
    k.set({ continuous: true, continuousMode: 'spectrum' });
    try {
      k.set({ acquisition: 'streaming' });
      await this.startStreamingWithConfiguration(configured.configurationRevision);
      if (!k.continuousRequested.current) {
        await this.stopStreamingAndReleaseConfiguration();
        this.completeContinuousStop();
      }
    } catch (value) {
      k.set({ acquisition: 'failed' });
      if (!k.continuousStreamOwnership.current) {
        k.continuousRequested.current = false;
        k.set({ continuous: false });
      }
      k.set({ error: errorMessage(value) });
      throw value;
    }
  }

  stopContinuous(): Promise<void> {
    const k = this.k;
    const existing = k.operatorContinuousStopRequest.current;
    if (existing) return existing.promise;
    if (!k.state.continuous && !k.continuousStreamOwnership.current && !k.continuousRequested.current) {
      return Promise.reject(new Error('Continuous acquisition is not running'));
    }
    // This intent flag is deliberately outside the transaction gate. Stop is
    // admitted even while a pause/configure/resume transaction owns the
    // instrument; every continuation observes it before starting another
    // host acquisition.
    k.continuousRequested.current = false;
    this.wakeContinuousIqAdmissionWaiters();
    k.set({ acquisition: 'stopping', notice: 'Stopping continuous acquisition…' });
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const request = { promise, resolve, reject };
    k.operatorContinuousStopRequest.current = request;
    void promise.catch(() => undefined);
    this.drainOperatorContinuousStop();
    return promise;
  }

  drainOperatorContinuousStop(): void {
    const k = this.k;
    const request = k.operatorContinuousStopRequest.current;
    if (!request || k.operatorContinuousStopTask.current || k.instrumentTransactionOwner.current) return;
    if (!k.continuousStreamOwnership.current) {
      const iqTask = k.continuousIqTask.current;
      if (iqTask) {
        const task = iqTask.catch(() => undefined).then(() => this.completeContinuousStop());
        k.operatorContinuousStopTask.current = task;
        void task.then(
          () => this.finishOperatorContinuousStop(task),
          (value) => this.finishOperatorContinuousStop(task, value),
        );
        return;
      }
      this.completeContinuousStop();
      k.operatorContinuousStopRequest.current = undefined;
      request.resolve();
      return;
    }
    const task = this.runInstrumentTransaction('stop-continuous-acquisition', async () => {
      await this.stopStreamingAndReleaseConfiguration();
      this.completeContinuousStop();
    });
    k.operatorContinuousStopTask.current = task;
    void task.then(
      () => this.finishOperatorContinuousStop(task),
      (value) => this.finishOperatorContinuousStop(task, value),
    );
  }

  finishOperatorContinuousStop(task: Promise<void>, failure?: unknown): void {
    const k = this.k;
    if (k.operatorContinuousStopTask.current !== task) return;
    k.operatorContinuousStopTask.current = undefined;
    const request = k.operatorContinuousStopRequest.current;
    if (!request) return;
    k.operatorContinuousStopRequest.current = undefined;
    if (failure === undefined) {
      request.resolve();
      return;
    }
    k.set({ acquisition: 'failed', notice: undefined, error: `Continuous acquisition stop failed: ${errorMessage(failure)}` });
    request.reject(failure);
  }

  completeContinuousStop(message = 'Continuous acquisition stopped'): void {
    const k = this.k;
    k.continuousRequested.current = false;
    this.wakeContinuousIqAdmissionWaiters();
    this.releaseContinuousIqConfiguration();
    k.set({ continuous: false, acquisition: 'complete', notice: message });
  }

  async startContinuousFromUi(): Promise<void> {
    try {
      await this.admitGlobalConfigurationFromAutomaticPrimary();
      await this.startContinuous();
    } catch (value) {
      // A failed compensating stop leaves an intentionally ambiguous stream
      // owner behind. Preserve its Stop affordance instead of hiding a live
      // hardware-recovery path behind the same UI wrapper that reports an
      // ordinary setup failure.
      if (this.k.continuousStreamOwnership.current || this.k.state.continuous) {
        this.k.set({ error: errorMessage(value) });
        return;
      }
      this.k.continuousRequested.current = false;
      this.k.set({ continuous: false, acquisition: 'failed', error: errorMessage(value) });
    }
  }
  async stopContinuousFromUi(): Promise<void> { try { await this.stopContinuous(); } catch (value) { this.k.set({ error: errorMessage(value) }); } }

  acquireZeroSpan(): Promise<ZeroSpanCapture> {
    return this.runInstrumentTransaction('acquire-detected-power', () => this.runWithContinuousPaused(
      'detected-power capture',
      () => this.acquireZeroSpanOwned(),
    ));
  }

  async acquireZeroSpanOwned(): Promise<ZeroSpanCapture> {
    const k = this.k;
    const configuration = this.requireActiveConfiguration('detected-power-timeseries', 'a detected-power capture');
    const activeSession = k.requireConnected();
    const sessionId = activeSession.sessionId;
    const preCaptureSignals = structuredClone(k.state.detections);
    const preCaptureHistory = [...k.state.history];
    const preCaptureSweep = k.state.sweep;
    const requestedSelection = resolveVisibleClassificationTargetSelection(
      preCaptureSignals,
      preCaptureSweep,
      k.state.explicitClassificationId,
    );
    const requestedRawTargetId = requestedSelection.rawTargetId
      ?? requestedSelection.detectionId;
    const admittedTarget = resolveRuntimeAdmittedCaptureTarget(
      preCaptureSignals,
      preCaptureHistory,
      preCaptureSweep,
      requestedRawTargetId,
    );
    if (requestedRawTargetId !== undefined && admittedTarget === undefined) {
      const message = `Selected classification target ${requestedRawTargetId} is not available on an exact runtime-admitted eight-sweep window`;
      k.set({ error: message });
      throw new Error(message);
    }
    const preCaptureTarget = admittedTarget?.rawTarget;
    const preCaptureSweepIds = admittedTarget?.spectrumSweepIds ?? [];
    k.set({ error: undefined, acquisition: 'acquiring' });
    try {
      const capability = activeSession.capabilities.acquisitions.find((candidate) => candidate.kind === 'detected-power-timeseries');
      if (!capability || capability.kind !== 'detected-power-timeseries') {
        throw new Error('Active instrument does not advertise detected-power acquisition');
      }
      const requested = this.requireConfiguration(configuration.configurationRevision, 'detected-power-timeseries', 'Detected-power capture') as DetectedPowerTimeseriesConfiguration;
      const admittedTargetTuneHz = preCaptureTarget === undefined
        ? undefined
        : projectDetectedPowerTuneHz(preCaptureTarget.peakHz, capability.centerFrequencyHz);
      if (admittedTargetTuneHz !== undefined && requested.centerHz !== admittedTargetTuneHz) {
        throw new Error(`Apply driver controls at ${formatFrequency(admittedTargetTuneHz)} before capturing this envelope`);
      }
      this.requireConfigurationEntry(configuration.configurationRevision, 'detected-power-timeseries');
      {
        const measurement = await window.atomizerInstrument.acquire();
        if (measurement.kind !== 'detected-power-timeseries') throw new Error(`Expected detected-power-timeseries measurement, received ${measurement.kind}`);
        if (measurement.sessionId !== sessionId || k.state.instrument.session?.sessionId !== sessionId) {
          throw new Error(`Measurement ${measurement.measurementId} was invalidated with instrument session ${sessionId}`);
        }
        if (measurement.configurationRevision !== configuration.configurationRevision) {
          throw new Error(`Measurement ${measurement.measurementId} referenced superseding configuration ${measurement.configurationRevision}; expected ${configuration.configurationRevision}`);
        }
        const requested = this.requireConfiguration(measurement.configurationRevision, 'detected-power-timeseries', `Measurement ${measurement.measurementId}`) as DetectedPowerTimeseriesConfiguration;
        const capture = projectDetectedPowerMeasurement(
          measurement,
          activeSession,
          requested,
          preCaptureTarget?.id,
        );
        let captureReceipt: DetectedPowerCaptureReceipt | undefined;
        if (admittedTarget
          && preCaptureTarget
          && admittedTargetTuneHz === capture.frequencyHz
          && preCaptureSweepIds.length === 8) {
          try {
            captureReceipt = createDetectedPowerCaptureReceipt({
              activeSignals: preCaptureSignals,
              evidenceSweeps: preCaptureHistory,
              ...(requestedSelection.origin === 'explicit'
                ? { preferredDetectionId: preCaptureTarget.id }
                : {}),
              capture,
              admittedTargetTuneHz,
              spectrumSweepIds: preCaptureSweepIds,
            });
          } catch (value) {
            console.warn(
              '[ZeroSpan] detected-power capture remains unqualified',
              value,
            );
            k.set({
              notice: `Envelope captured without target qualification: ${errorMessage(value)}`,
            });
          }
        } else if (preCaptureTarget) {
          k.set({
            notice: 'Envelope captured without target qualification: target was not admitted on the exact eight-sweep window and tune',
          });
        }
        k.zeroCaptureReceiptRef.current = captureReceipt;
        k.set({ zeroCapture: capture, envelope: classifyZeroSpanEnvelope(capture) });
        k.set({ acquisition: 'complete' });
        return capture;
      }
    } catch (value) {
      k.set({ acquisition: 'failed', error: errorMessage(value) });
      throw value;
    }
  }

  async acquireZeroSpanFromUi(): Promise<void> { try { await this.acquireZeroSpan(); } catch { /* Visible in the workspace alert. */ } }
}

function automaticPrimaryAcquisitionOperation(
  surface: CanonicalInstrumentSurface,
  expectedKind: GlobalAcquisitionKind,
): CanonicalOperation | undefined {
  const candidates = surface.operations.filter((operation) =>
    (operation.scope === undefined || operation.scope === 'acquisition')
    && operation.availability === 'available'
    && operation.confirmation === 'none');
  const typed = candidates.filter((operation) => operation.acquisitionKind === expectedKind);
  if (typed.length > 0) return typed.find((operation) => operation.primary) ?? typed[0];

  // Compatibility for a v1 single-operation surface: its one result remains
  // unambiguous, while a multi-operation legacy surface must declare kinds
  // before Atomizer can safely auto-admit it.
  const legacy = candidates.filter((operation) => operation.acquisitionKind === undefined);
  return legacy.length === 1 ? legacy[0] : undefined;
}

// --- Pure functions retained from App.tsx (test-pinned exports) ---

export function fitChannelConfigurationToSpan(input: ChannelMeasurementConfiguration, startHz: number, stopHz: number): ChannelMeasurementConfiguration {
  const current = channelMeasurementConfigurationSchema.parse(input);
  if (!Number.isInteger(startHz) || !Number.isInteger(stopHz) || stopHz <= startHz) throw new Error('Channel measurement reconciliation requires a valid analyzer span');
  const spanHz = stopHz - startHz;
  const extent = (configuration: ChannelMeasurementConfiguration) => Math.max(
    configuration.mainBandwidthHz / 2,
    configuration.adjacentChannelCount * configuration.channelSpacingHz + configuration.adjacentBandwidthHz / 2,
  );
  const requestedExtent = extent(current);
  const marginHz = spanHz * 0.01;
  if (current.centerHz - requestedExtent >= startHz + marginHz && current.centerHz + requestedExtent <= stopHz - marginHz) return current;

  const centerHz = Math.round((startHz + stopHz) / 2);
  if (requestedExtent <= spanHz * 0.45) return channelMeasurementConfigurationSchema.parse({ ...current, centerHz });
  if (spanHz < 16) return current;

  const unitHz = Math.max(1, Math.floor(spanHz / (3 * current.adjacentChannelCount + 4)));
  const mainBandwidthHz = Math.max(1, unitHz * 2);
  const adjacentBandwidthHz = unitHz;
  const channelSpacingHz = Math.max(1, Math.ceil((mainBandwidthHz + adjacentBandwidthHz) / 2));
  return channelMeasurementConfigurationSchema.parse({
    ...current,
    centerHz,
    mainBandwidthHz,
    adjacentBandwidthHz,
    channelSpacingHz,
  });
}

/** Keep channel windows inside the scalar evidence that was actually accepted.
 * Host-derived FFT bounds may be fractional even though the channel contract is
 * integer-Hz, so reconcile against the conservative whole-Hz interior. */
export function reconcileChannelConfigurationToSweep(
  input: ChannelMeasurementConfiguration,
  sweep: Pick<Sweep, 'actualStartHz' | 'actualStopHz'>,
): ChannelMeasurementConfiguration {
  if (!Number.isFinite(sweep.actualStartHz) || !Number.isFinite(sweep.actualStopHz)) {
    throw new Error('Channel measurement reconciliation requires finite sweep bounds');
  }
  const startHz = Math.ceil(sweep.actualStartHz);
  const stopHz = Math.floor(sweep.actualStopHz);
  if (stopHz <= startHz) {
    throw new Error('Channel measurement reconciliation requires at least one whole-Hz interval');
  }
  const current = channelMeasurementConfigurationSchema.parse(input);
  const requestedExtent = Math.max(
    current.mainBandwidthHz / 2,
    current.adjacentChannelCount * current.channelSpacingHz + current.adjacentBandwidthHz / 2,
  );
  if (current.centerHz - requestedExtent >= startHz
    && current.centerHz + requestedExtent <= stopHz) return input;
  const fitted = fitChannelConfigurationToSpan(current, startHz, stopHz);
  return sameStructuredValue(fitted, input) ? input : fitted;
}

export function coherentSweepCount(history: readonly Sweep[], depth: number): number {
  const reference = history[0];
  if (!reference) return 0;
  return history.filter((candidate) => candidate.frequencyHz.length === reference.frequencyHz.length
    && candidate.frequencyHz.every((frequency, index) => frequency === reference.frequencyHz[index])).slice(0, depth).length;
}
