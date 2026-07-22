import {
  analyzerConfigPatchSchema,
  analyzerConfigSchema,
  channelMeasurementConfigurationSchema,
  complexIqConfigurationSchema,
  projectDetectedPowerTuneHz,
  zeroSpanConfigSchema,
  type AnalyzerConfig,
  type AnalyzerConfigPatch,
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
import { projectDetectedPowerMeasurement, projectSpectrumMeasurement } from '../instrument-measurement-projection.js';
import {
  detectedPowerConfigurationFor,
  sameSweptSpectrumConfiguration,
  sweptSpectrumConfigurationFor,
} from '../instrument-configuration.js';
import {
  complexIqConfigurationFor,
  reconcileComplexIqConfiguration,
  sameComplexIqConfiguration,
  type ComplexIqConfiguration,
  type ComplexIqMeasurement,
} from '../complex-iq.js';
import { resolveVisibleClassificationTargetSelection } from '../classification-target-selection.js';
import { resolveRuntimeAdmittedCaptureTarget } from './classification-helpers.js';
import { acquisitionModeForSession, HISTORY_LIMIT, selectIqCapability } from '../store.js';
import {
  CONTINUOUS_GLOBAL_SPECTRUM_TRANSACTION,
  CONTINUOUS_IQ_TRANSACTION,
  errorMessage,
  sameAnalyzerConfiguration,
  sameStructuredValue,
  type ContinuousIqConfigurationOwnership,
  type ContinuousMeasurementWork,
  type ContinuousStreamOwnership,
  type RendererConfigurationRevision,
  type RendererKernel,
} from './kernel.js';

const MAXIMUM_GLOBAL_DISPLAY_HZ = 60;

/** Pace complete I/Q buffers to their admitted capture duration without
 * producing frames faster than the browser can present them. Each published
 * buffer is independently offered to the latest-wins classification worker. */
export function continuousIqFramePeriodMilliseconds(
  configuration: Pick<ComplexIqConfiguration, 'sampleCount' | 'sampleRateHz'>,
): number {
  return Math.max(
    1_000 / MAXIMUM_GLOBAL_DISPLAY_HZ,
    configuration.sampleCount / configuration.sampleRateHz * 1_000,
  );
}

/** Backpressure a projected spectrum to its admitted sweep duration without
 * producing frames faster than the browser can present them. */
export function continuousSpectrumFramePeriodMilliseconds(
  configuration: Pick<SweptSpectrumConfiguration, 'sweepTimeSeconds'>,
): number {
  const admittedMilliseconds = typeof configuration.sweepTimeSeconds === 'number'
    ? configuration.sweepTimeSeconds * 1_000
    : 0;
  return Math.max(1_000 / MAXIMUM_GLOBAL_DISPLAY_HZ, admittedMilliseconds);
}

interface ContinuousSpectrumConfigurationOwnership {
  readonly generation: number;
  readonly sessionId: string;
  readonly producerConfigurationEpoch?: string;
  readonly analyzerRevision: number;
  readonly configured: InstrumentConfigurationState;
}

interface ContinuousSourceIdentity {
  readonly sessionId: string;
  readonly producerConfigurationEpoch?: string;
}

function continuousSourceIdentity(session: InstrumentSessionSnapshot): ContinuousSourceIdentity {
  const producerConfigurationEpoch = session.provenance.sourceKind === 'signal-lab'
    ? session.provenance.producerConfigurationEpoch
    : undefined;
  return {
    sessionId: session.sessionId,
    ...(producerConfigurationEpoch === undefined ? {} : { producerConfigurationEpoch }),
  };
}

function sameContinuousSourceIdentity(
  left: ContinuousSourceIdentity | undefined,
  right: ContinuousSourceIdentity,
): boolean {
  return left?.sessionId === right.sessionId
    && left.producerConfigurationEpoch === right.producerConfigurationEpoch;
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

  async configureAnalyzer(
    config: AnalyzerConfig,
    operation: 'configuring' | 'retuning' = 'configuring',
    background = false,
  ): Promise<InstrumentConfigurationState> {
    const k = this.k;
    const session = k.requireConnected();
    const sessionId = session.sessionId;
    const validated = analyzerConfigSchema.parse(config);
    const capability = session.capabilities.acquisitions.find((candidate) => candidate.kind === 'swept-spectrum');
    if (!capability || capability.kind !== 'swept-spectrum') throw new Error('Active instrument does not advertise swept-spectrum acquisition');
    const requested = sweptSpectrumConfigurationFor(capability, validated);
    if (!background) k.set({ error: undefined, acquisition: operation });
    const next = await window.atomizerInstrument.configure(requested);
    if (next.sessionId !== sessionId || k.state.instrument.session?.sessionId !== sessionId) {
      throw new Error(`Swept-spectrum configuration response was invalidated with instrument session ${sessionId}`);
    }
    if (next.configuration.kind !== 'swept-spectrum'
      || !sameSweptSpectrumConfiguration(next.configuration, requested)) {
      throw new Error('Instrument host returned a different swept-spectrum configuration than it admitted');
    }
    k.configurationRevisions.current.commit(next.configurationRevision, { kind: 'swept-spectrum', admitted: next.configuration });
    k.events.acceptConfiguration(next);
    return next;
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
      && (name === CONTINUOUS_IQ_TRANSACTION || name === CONTINUOUS_GLOBAL_SPECTRUM_TRANSACTION);
    const pauseIq = !backgroundGlobalAcquisition
      && k.continuousRequested.current
      && k.state.continuousMode === 'complex-iq';
    if (pauseIq) k.continuousIqPauseDepth.current++;
    try {
      const active = k.instrumentTransactionOwner.current;
      if ((active === CONTINUOUS_IQ_TRANSACTION || active === CONTINUOUS_GLOBAL_SPECTRUM_TRANSACTION) && pauseIq) {
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
      const resumed = await this.resumeContinuousAfterConflict(sessionId, label);
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
      this.requireIqAcquisitionAdmission(after);
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

  requireIqAcquisitionAdmission(session: InstrumentSessionSnapshot): void {
    const iq = session.capabilities.acquisitions.find((candidate) => candidate.kind === 'complex-iq');
    if (iq?.kind !== 'complex-iq') throw new Error('The active session no longer advertises complex-I/Q acquisition');
    const profile = session.capabilities.features.find((candidate) => candidate.kind === 'signal-lab-profile-selection');
    if (profile?.kind === 'signal-lab-profile-selection'
      && profile.iqProfileIds !== undefined
      && !profile.iqProfileIds.includes(profile.selectedProfileId)) {
      throw new Error(`SignalLab profile ${profile.selectedProfileId} is not admitted for complex-I/Q acquisition`);
    }
  }

  async resumeContinuousAfterConflict(sessionId: string, label: string): Promise<boolean> {
    const k = this.k;
    k.set({ acquisition: 'retuning' });
    while (true) {
      if (!k.continuousRequested.current) return false;
      const active = k.requireConnected();
      if (active.sessionId !== sessionId || active.fault) {
        throw new Error(`Continuous acquisition resume was invalidated with instrument session ${sessionId}`);
      }
      const targetRevision = k.analyzerRevision.current;
      const configured = await this.configureAnalyzer(k.state.analyzer, 'retuning');
      if (!k.continuousRequested.current) return false;
      if (configured.sessionId !== sessionId || targetRevision !== k.analyzerRevision.current) continue;
      await this.startStreamingWithConfiguration(configured.configurationRevision);
      if (!k.continuousRequested.current) {
        await this.stopStreamingAndReleaseConfiguration();
        return false;
      }
      if (k.state.instrument.session?.sessionId === sessionId
        && targetRevision === k.analyzerRevision.current
        && k.continuousStreamOwnership.current?.configurationRevision === configured.configurationRevision) break;
      await this.stopStreamingAndReleaseConfiguration();
    }
    k.set({ acquisition: 'streaming', notice: `Continuous acquisition resumed after ${label}` });
    return true;
  }

  stageAnalyzerPatch(input: AnalyzerConfigPatch): { configuration: AnalyzerConfig; changed: boolean } {
    const k = this.k;
    const patch = analyzerConfigPatchSchema.parse(input);
    const previous = k.state.analyzer;
    const next = analyzerConfigSchema.parse({ ...previous, ...patch });
    const capability = k.state.instrument.session?.capabilities.acquisitions.find((candidate) => candidate.kind === 'swept-spectrum');
    if (capability?.kind === 'swept-spectrum') {
      if (capability.controls.model === 'synthetic-scalar') {
        const receiverOnly = [
          'acquisitionFormat', 'rbwKhz', 'attenuationDb', 'detector',
          'spurRejection', 'lna', 'avoidSpurs', 'trigger',
        ].find((key) => key in patch);
        if (receiverOnly) throw new Error(`${receiverOnly} is not applicable to synthetic scalar acquisition`);
      }
      sweptSpectrumConfigurationFor(capability, next);
    }
    if (sameAnalyzerConfiguration(previous, next)) return { configuration: previous, changed: false };
    k.analyzerRevision.current++;
    k.set({ analyzer: next });
    k.setKey('channelConfiguration', (current) => fitChannelConfigurationToSpan(current, next.startHz, next.stopHz));
    k.invalidateAcquiredEvidence();
    return { configuration: next, changed: true };
  }

  synchronizeContinuousAnalyzer(): Promise<void> {
    const k = this.k;
    // The global I/Q analysis loop reads the latest staged analyzer geometry
    // before its next scalar look; no workspace-owned stream needs retargeting.
    if (k.state.continuousMode === 'complex-iq') return Promise.resolve();
    const active = k.analyzerRetuneTask.current;
    if (active) return active;
    if (!k.continuousRequested.current) return Promise.resolve();
    const task = this.runInstrumentTransaction('retune-continuous-analyzer', () => this.retuneContinuousToLatest());
    k.analyzerRetuneTask.current = task;
    void task.then(
      () => { if (k.analyzerRetuneTask.current === task) k.analyzerRetuneTask.current = undefined; },
      () => { if (k.analyzerRetuneTask.current === task) k.analyzerRetuneTask.current = undefined; },
    );
    return task;
  }

  async retuneContinuousToLatest(): Promise<void> {
    const k = this.k;
    try {
      k.set({ acquisition: 'retuning', notice: 'Retuning continuous acquisition…' });
      await this.stopStreamingAndReleaseConfiguration();
      while (true) {
        if (!k.continuousRequested.current) {
          this.completeContinuousStop();
          return;
        }
        const targetRevision = k.analyzerRevision.current;
        const configured = await this.configureAnalyzer(k.state.analyzer, 'retuning');
        if (!k.continuousRequested.current) {
          this.completeContinuousStop();
          return;
        }
        if (targetRevision !== k.analyzerRevision.current) continue;
        await this.startStreamingWithConfiguration(configured.configurationRevision);
        if (!k.continuousRequested.current) {
          await this.stopStreamingAndReleaseConfiguration();
          this.completeContinuousStop();
          return;
        }
        if (targetRevision === k.analyzerRevision.current) break;
        await this.stopStreamingAndReleaseConfiguration();
      }
      k.set({ acquisition: 'streaming', notice: 'Continuous acquisition retuned' });
    } catch (value) {
      k.set({ acquisition: 'failed', error: `Analyzer retune failed: ${errorMessage(value)}` });
      throw value;
    }
  }

  async updateAnalyzer(input: AnalyzerConfigPatch): Promise<AnalyzerConfig> {
    const staged = this.stageAnalyzerPatch(input);
    if (staged.changed && (this.k.continuousRequested.current || this.k.analyzerRetuneTask.current)) await this.synchronizeContinuousAnalyzer();
    return staged.configuration;
  }

  updateAnalyzerFromUi(input: AnalyzerConfigPatch): void {
    try {
      const staged = this.stageAnalyzerPatch(input);
      if (staged.changed && (this.k.continuousRequested.current || this.k.analyzerRetuneTask.current)) void this.synchronizeContinuousAnalyzer().catch(() => undefined);
    } catch (value) {
      this.k.set({ error: `Analyzer configuration failed: ${errorMessage(value)}` });
      throw value;
    }
  }

  recordSweepEvidence(
    next: Sweep,
    configurationRevision: string,
  ): boolean {
    const k = this.k;
    void configurationRevision;
    const capability = k.state.instrument.session?.capabilities.acquisitions.find((candidate) => candidate.kind === 'swept-spectrum');
    const currentAdmitted = capability?.kind === 'swept-spectrum'
      ? sweptSpectrumConfigurationFor(capability, k.state.analyzer)
      : undefined;
    if (!currentAdmitted || !sameSweptSpectrumConfiguration(next.requested, currentAdmitted)) {
      console.warn('[Analyzer] rejected stale sweep for a superseded staged configuration', { sweepId: next.id, requested: next.requested, staged: k.state.analyzer });
      return false;
    }
    k.analysisSequence.current++;
    const nextHistory = [next, ...k.state.history].slice(0, HISTORY_LIMIT);
    const nextTraceFrames = k.traceAccumulator.current.update(next);
    const basePatch = {
      sweep: next,
      history: nextHistory,
      traceFrames: nextTraceFrames,
      firmwareTraceFrames: next.firmwareTraces ?? [],
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
      const configured = await this.configureAnalyzer(k.state.analyzer, 'configuring', background);
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
    const session = k.requireConnected();
    const iqAvailable = session.capabilities.acquisitions.some((capability) => capability.kind === 'complex-iq');
    const spectrumAvailable = session.capabilities.acquisitions.some((capability) => capability.kind === 'swept-spectrum');
    k.classification.reset(true);
    const iq = iqAvailable ? await this.acquireIq() : undefined;
    const sweep = spectrumAvailable ? await this.acquire() : undefined;
    if (!iq && !sweep) throw new Error('The connected source advertises no globally processable acquisition');
    return { ...(iq ? { iq } : {}), ...(sweep ? { sweep } : {}) };
  }

  async acquireFromUi(): Promise<void> {
    try {
      await this.acquireGlobalFrame();
    } catch { /* The owned acquisition path presents its boundary failure. */ }
  }

  stageIqConfiguration(input: ComplexIqConfiguration): void {
    const k = this.k;
    try {
      const capability = k.state.instrument.session?.capabilities.acquisitions.find((candidate) => candidate.kind === 'complex-iq');
      const next = capability?.kind === 'complex-iq'
        ? reconcileComplexIqConfiguration(capability, input)
        : complexIqConfigurationSchema.parse(input);
      if (sameComplexIqConfiguration(next, k.state.iqConfiguration)) return;
      k.iqConfigurationRevision.current++;
      k.set({ iqConfiguration: next, error: undefined });
    } catch (value) {
      k.set({ error: `I/Q configuration failed: ${errorMessage(value)}` });
    }
  }

  acquireIq(): Promise<ComplexIqMeasurement> {
    return this.runInstrumentTransaction('acquire-complex-iq', () => this.runWithContinuousPaused(
      'complex I/Q capture',
      () => this.acquireIqOwned(),
    ));
  }

  async acquireIqOwned(options: {
    readonly configuration?: ComplexIqConfiguration;
    readonly publish?: () => boolean;
  } = {}): Promise<ComplexIqMeasurement> {
    const k = this.k;
    const activeSession = k.requireConnected();
    this.requireIqAcquisitionAdmission(activeSession);
    const capability = activeSession.capabilities.acquisitions.find((candidate) => candidate.kind === 'complex-iq');
    if (capability?.kind !== 'complex-iq') throw new Error('Active instrument does not advertise complex-I/Q acquisition');
    const requested = complexIqConfigurationFor(
      capability,
      options.configuration ?? k.state.iqConfiguration,
    );
    k.set({ error: undefined, acquisition: 'configuring' });
    const configured = await this.configureIqOwned(requested, false);
    this.requireConfigurationEntry(configured.configurationRevision, 'complex-iq');
    k.set({ acquisition: 'acquiring' });
    try {
      const measurement = await this.acquireConfiguredIq(configured, options.publish);
      k.set({ acquisition: 'complete' });
      return measurement;
    } catch (value) {
      k.set({ acquisition: 'failed', error: errorMessage(value) });
      throw value;
    }
  }

  async configureIqOwned(
    requested: ComplexIqConfiguration,
    background: boolean,
  ): Promise<InstrumentConfigurationState> {
    const k = this.k;
    const sessionId = k.requireConnected().sessionId;
    try {
      const configured = await window.atomizerInstrument.configure(requested);
      if (configured.sessionId !== sessionId || k.state.instrument.session?.sessionId !== sessionId) {
        throw new Error(`Complex-I/Q configuration response was invalidated with instrument session ${sessionId}`);
      }
      if (configured.configuration.kind !== 'complex-iq'
        || !sameComplexIqConfiguration(configured.configuration, requested)) {
        throw new Error('Instrument host returned a different complex-I/Q configuration than it admitted');
      }
      k.configurationRevisions.current.commit(configured.configurationRevision, { kind: 'complex-iq', admitted: configured.configuration });
      k.events.acceptConfiguration(configured);
      return configured;
    } catch (value) {
      if (!background) {
        k.set({ acquisition: 'failed', error: errorMessage(value) });
      }
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
    }
    return measurement;
  }

  startContinuous(): Promise<void> {
    const mode = acquisitionModeForSession(selectIqCapability(this.k.state) !== undefined);
    return mode === 'complex-iq'
      ? this.startContinuousIq()
      : this.runInstrumentTransaction('start-continuous-acquisition', () => this.startContinuousOwned());
  }

  startContinuousIq(): Promise<void> {
    const k = this.k;
    if (k.continuousRequested.current || k.state.continuous) {
      return Promise.reject(new Error('Continuous acquisition is already running'));
    }
    const active = k.requireConnected();
    this.requireIqAcquisitionAdmission(active);
    const capability = active.capabilities.acquisitions.find((candidate) => candidate.kind === 'complex-iq');
    if (capability?.kind !== 'complex-iq') {
      return Promise.reject(new Error('Active instrument does not advertise complex-I/Q acquisition'));
    }
    complexIqConfigurationFor(capability, k.state.iqConfiguration);
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
    let nextSpectrumFrameAt = Number.NEGATIVE_INFINITY;
    let spectrumOwnership: ContinuousSpectrumConfigurationOwnership | undefined;
    let latestIqSource: ContinuousSourceIdentity | undefined;
    let lastCompletedKind: 'iq' | 'spectrum' | undefined;
    while (this.isCurrentContinuousIqRun(generation)) {
      if (!await this.waitForContinuousIqAdmission(generation)) break;

      const loopStartedAt = performance.now();
      const sourceBeforeIq = continuousSourceIdentity(k.requireConnected());
      const spectrumAvailableBeforeIq = k.state.instrument.session?.capabilities.acquisitions
        .some((candidate) => candidate.kind === 'swept-spectrum') === true;
      // When both independent display deadlines have expired, preserve the
      // scalar frame's 20 Hz reservation once I/Q has established current
      // source identity. Initial and post-profile frames still begin with I/Q.
      const currentSpectrumDue = spectrumAvailableBeforeIq
        && loopStartedAt >= nextSpectrumFrameAt
        && sameContinuousSourceIdentity(latestIqSource, sourceBeforeIq);
      const iqDue = loopStartedAt >= nextIqCaptureAt
        && (!currentSpectrumDue || lastCompletedKind !== 'iq');
      if (iqDue) {
        const iqStartedAt = performance.now();
        const iqTask = this.runInstrumentTransaction(CONTINUOUS_IQ_TRANSACTION, async () => {
          const ownership = await this.ensureContinuousIqConfiguration(generation);
          return this.acquireConfiguredIq(ownership.configured, () =>
            generation === k.continuousIqGeneration.current
            && k.continuousIqConfigurationOwnership.current === ownership
            && k.iqConfigurationRevision.current === ownership.stagedRevision
            && sameComplexIqConfiguration(k.state.iqConfiguration, ownership.configuration));
        });
        k.continuousGlobalAcquisitionTask.current = iqTask;
        try {
          const measurement = await iqTask;
          nextIqCaptureAt = iqStartedAt + continuousIqFramePeriodMilliseconds(measurement);
          lastCompletedKind = 'iq';
          latestIqSource = {
            sessionId: measurement.sessionId,
            ...(measurement.producerConfigurationEpoch === undefined
              ? {}
              : { producerConfigurationEpoch: measurement.producerConfigurationEpoch }),
          };
        }
        finally {
          if (k.continuousGlobalAcquisitionTask.current === iqTask) {
            k.continuousGlobalAcquisitionTask.current = undefined;
          }
        }
        if (!this.isCurrentContinuousIqRun(generation)) break;
        spectrumOwnership = undefined;
        // A conflicting source/profile transaction may have queued while the
        // I/Q buffer was in flight. Do not begin a scalar look until it ends.
        if (!await this.waitForContinuousIqAdmission(generation)) break;
      }

      const currentSource = continuousSourceIdentity(k.requireConnected());
      if (!sameContinuousSourceIdentity(latestIqSource, currentSource)) {
        // Profile/channel changes advance the producer epoch. Re-establish the
        // I/Q side of the global frame before publishing scalar evidence from
        // that new source state.
        nextIqCaptureAt = Number.NEGATIVE_INFINITY;
        continue;
      }

      const spectrumAvailable = k.state.instrument.session?.capabilities.acquisitions
        .some((candidate) => candidate.kind === 'swept-spectrum') === true;
      if (spectrumAvailable && performance.now() >= nextSpectrumFrameAt) {
        const spectrumStartedAt = performance.now();
        this.releaseContinuousIqConfiguration(generation);
        const spectrumTask = this.runInstrumentTransaction(
          CONTINUOUS_GLOBAL_SPECTRUM_TRANSACTION,
          async () => {
            const session = k.requireConnected();
            const source = continuousSourceIdentity(session);
            let ownership = spectrumOwnership;
            if (!(ownership
              && ownership.generation === generation
              && ownership.sessionId === source.sessionId
              && ownership.producerConfigurationEpoch === source.producerConfigurationEpoch
              && ownership.analyzerRevision === k.analyzerRevision.current
              && ownership.configured.configurationRevision === session.configuration?.configurationRevision
              && k.configurationRevisions.current.has(ownership.configured.configurationRevision))) {
              ownership = {
                generation,
                sessionId: source.sessionId,
                ...(source.producerConfigurationEpoch === undefined
                  ? {}
                  : { producerConfigurationEpoch: source.producerConfigurationEpoch }),
                analyzerRevision: k.analyzerRevision.current,
                configured: await this.configureAnalyzer(k.state.analyzer, 'configuring', true),
              };
            }
            this.requireConfigurationEntry(ownership.configured.configurationRevision, 'swept-spectrum');
            const sweep = await this.acquireConfiguredSpectrum(ownership.configured);
            const currentSession = k.state.instrument.session;
            const currentSource = currentSession === undefined
              ? undefined
              : continuousSourceIdentity(currentSession);
            const publish = generation === k.continuousIqGeneration.current
              && currentSource !== undefined
              && sameContinuousSourceIdentity(currentSource, ownership)
              && ownership.analyzerRevision === k.analyzerRevision.current;
            if (publish) {
              const recorded = this.recordSweepEvidence(sweep, ownership.configured.configurationRevision);
              if (!recorded) throw new Error(`Sweep ${sweep.id} was acquired for a superseded analyzer configuration`);
            }
            return { ownership, publish, sweep };
          },
        );
        k.continuousGlobalAcquisitionTask.current = spectrumTask;
        let result: Awaited<typeof spectrumTask>;
        try { result = await spectrumTask; }
        finally {
          if (k.continuousGlobalAcquisitionTask.current === spectrumTask) {
            k.continuousGlobalAcquisitionTask.current = undefined;
          }
        }
        spectrumOwnership = result.publish ? result.ownership : undefined;
        lastCompletedKind = 'spectrum';
        nextSpectrumFrameAt = result.publish
          ? spectrumStartedAt + continuousSpectrumFramePeriodMilliseconds(result.sweep.requested)
          : Number.NEGATIVE_INFINITY;
        if (!this.isCurrentContinuousIqRun(generation)) break;
        k.set({ acquisition: 'streaming' });
      }

      const nextDeadline = spectrumAvailable
        ? Math.min(nextIqCaptureAt, nextSpectrumFrameAt)
        : nextIqCaptureAt;
      const delay = Math.max(0, nextDeadline - performance.now());
      if (!await this.waitForContinuousIqCadence(generation, delay)) break;
    }
    this.releaseContinuousIqConfiguration(generation);
  }

  async ensureContinuousIqConfiguration(generation: number): Promise<ContinuousIqConfigurationOwnership> {
    const k = this.k;
    const session = k.requireConnected();
    const stagedRevision = k.iqConfigurationRevision.current;
    const configuration = structuredClone(k.state.iqConfiguration);
    const existing = k.continuousIqConfigurationOwnership.current;
    if (existing
      && existing.generation === generation
      && existing.sessionId === session.sessionId
      && existing.stagedRevision === stagedRevision
      && sameComplexIqConfiguration(existing.configuration, configuration)
      && existing.configured.configurationRevision === session.configuration?.configurationRevision
      && k.configurationRevisions.current.has(existing.configured.configurationRevision)) {
      return existing;
    }
    this.releaseContinuousIqConfiguration();
    const capability = session.capabilities.acquisitions.find((candidate) => candidate.kind === 'complex-iq');
    if (capability?.kind !== 'complex-iq') throw new Error('Active instrument does not advertise complex-I/Q acquisition');
    const requested = complexIqConfigurationFor(capability, configuration);
    const configured = await this.configureIqOwned(requested, true);
    this.requireConfigurationEntry(configured.configurationRevision, 'complex-iq');
    const ownership: ContinuousIqConfigurationOwnership = {
      generation,
      sessionId: session.sessionId,
      stagedRevision,
      configuration: requested,
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
    k.classification.reset(true);
    k.continuousRequested.current = true;
    k.set({ continuous: true, continuousMode: 'spectrum' });
    try {
      while (true) {
        const targetRevision = k.analyzerRevision.current;
        const configured = await this.configureAnalyzer(k.state.analyzer);
        if (!k.continuousRequested.current) {
          this.completeContinuousStop();
          return;
        }
        if (targetRevision !== k.analyzerRevision.current) continue;
        k.set({ acquisition: 'streaming' });
        await this.startStreamingWithConfiguration(configured.configurationRevision);
        if (!k.continuousRequested.current) {
          await this.stopStreamingAndReleaseConfiguration();
          this.completeContinuousStop();
          return;
        }
        if (targetRevision === k.analyzerRevision.current) break;
        await this.stopStreamingAndReleaseConfiguration();
        if (!k.continuousRequested.current) {
          this.completeContinuousStop();
          return;
        }
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

  async startContinuousFromUi(): Promise<void> { try { await this.startContinuous(); } catch { /* Visible in the workspace alert. */ } }
  async stopContinuousFromUi(): Promise<void> { try { await this.stopContinuous(); } catch (value) { this.k.set({ error: errorMessage(value) }); } }

  acquireZeroSpan(): Promise<ZeroSpanCapture> {
    return this.runInstrumentTransaction('acquire-detected-power', () => this.runWithContinuousPaused(
      'detected-power capture',
      () => this.acquireZeroSpanOwned(),
    ));
  }

  async acquireZeroSpanOwned(): Promise<ZeroSpanCapture> {
    const k = this.k;
    const activeSession = k.requireConnected();
    const sessionId = activeSession.sessionId;
    const validated = zeroSpanConfigSchema.parse(k.state.zeroConfig);
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
      let configuration: InstrumentConfigurationState;
      let admittedTargetTuneHz: number | undefined;
      {
        const capability = activeSession.capabilities.acquisitions.find((candidate) => candidate.kind === 'detected-power-timeseries');
        if (!capability || capability.kind !== 'detected-power-timeseries') {
          throw new Error('Active instrument does not advertise detected-power acquisition');
        }
        const projectedTargetTuneHz = preCaptureTarget === undefined
          ? undefined
          : projectDetectedPowerTuneHz(
            preCaptureTarget.peakHz,
            capability.centerFrequencyHz,
          );
        admittedTargetTuneHz = admittedTarget === undefined
          ? undefined
          : projectedTargetTuneHz;
        const captureConfiguration = admittedTargetTuneHz === undefined
          ? validated
          : zeroSpanConfigSchema.parse({
            ...validated,
            frequencyHz: admittedTargetTuneHz,
          });
        const requested = detectedPowerConfigurationFor(
          capability,
          captureConfiguration,
        );
        if (admittedTargetTuneHz !== undefined) {
          k.measurement.commitZeroSpanConfiguration(captureConfiguration);
        }
        configuration = await window.atomizerInstrument.configure(requested);
        if (configuration.sessionId !== sessionId || k.state.instrument.session?.sessionId !== sessionId) {
          throw new Error(`Detected-power configuration response was invalidated with instrument session ${sessionId}`);
        }
        if (configuration.configuration.kind !== 'detected-power-timeseries'
          || JSON.stringify(configuration.configuration) !== JSON.stringify(requested)) {
          throw new Error('Instrument host returned a different detected-power configuration than it admitted');
        }
        k.configurationRevisions.current.commit(configuration.configurationRevision, { kind: 'detected-power-timeseries', admitted: configuration.configuration });
      }
      k.events.acceptConfiguration(configuration);
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
        try {
          await this.configureAnalyzer(k.state.analyzer);
        } catch (value) {
          throw new Error(`Zero-span capture ${capture.id} completed, but restoring the staged swept-analyzer configuration failed: ${errorMessage(value)}`);
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

export function coherentSweepCount(history: readonly Sweep[], depth: number): number {
  const reference = history[0];
  if (!reference) return 0;
  return history.filter((candidate) => candidate.frequencyHz.length === reference.frequencyHz.length
    && candidate.frequencyHz.every((frequency, index) => frequency === reference.frequencyHz[index])).slice(0, depth).length;
}
