import {
  atomizerInstrumentEventSchema,
  analyzerConfigSchema,
  zeroSpanConfigSchema,
  type AtomizerInstrumentEvent,
  type AtomizerInstrumentState,
  type InstrumentConfigurationState,
  type InstrumentFeatureRequest,
  type InstrumentFeatureResult,
  type InstrumentSessionSnapshot,
  type SignalLabChannelState,
} from '@tinysa/contracts';
import {
  reconcileAnalyzerConfiguration,
  reconcileDetectedPowerConfiguration,
} from '../instrument-configuration.js';
import { reconcileComplexIqConfiguration, sameComplexIqConfiguration } from '../complex-iq.js';
import {
  errorMessage,
  featureResultAcknowledgesRequest,
  invalidatingFeatureReason,
  isInvalidatingFeatureRequest,
  sameAnalyzerConfiguration,
  sameStructuredValue,
  INVALIDATING_FEATURE_RECEIPT_TIMEOUT_MILLISECONDS,
  type ConfigurationInvalidatedEvent,
  type FeatureResultEvent,
  type InvalidatingFeatureReceipt,
  type RendererKernel,
} from './kernel.js';

export class InstrumentEventsController {
  constructor(private readonly k: RendererKernel) {}

  async initialize(generation: number): Promise<void> {
    const k = this.k;
    try {
      const stateEventSequence = k.instrumentStateEventSequence.current;
      const state = await window.atomizerInstrument.getState();
      if (!k.rendererMounted.current || k.initializationGeneration.current !== generation) return;
      // A subscribed lifecycle event is newer than a state snapshot whose IPC
      // request was still in flight. Never let that older snapshot disconnect or
      // deconfigure the renderer after the event has already been accepted.
      if (k.instrumentStateEventSequence.current === stateEventSequence) this.acceptInstrumentState(state);
      const discoveryEventSequence = k.instrumentDiscoveryEventSequence.current;
      const discovery = await window.atomizerInstrument.discover();
      if (!k.rendererMounted.current || k.initializationGeneration.current !== generation) return;
      if (k.instrumentDiscoveryEventSequence.current === discoveryEventSequence) {
        k.connection.acceptDiscovery(discovery.candidates, discovery.failures);
      }
    } catch (value) {
      if (k.rendererMounted.current && k.initializationGeneration.current === generation) {
        k.set({ error: errorMessage(value) });
      }
    }
  }

  readonly handleInstrumentEvent = (value: unknown): void => {
    const k = this.k;
    try {
      this.handleValidatedInstrumentEvent(atomizerInstrumentEventSchema.parse(value));
    } catch (failure) {
      const detail = errorMessage(failure).replace(/\s+/g, ' ').slice(0, 480);
      const message = `Instrument event rejected at the renderer boundary: ${detail}`;
      k.set({ error: message });
      const ownership = k.continuousStreamOwnership.current;
      if (k.continuousRequested.current && ownership) {
        k.set({ acquisition: 'failed' });
        k.acquisition.requestContinuousMeasurementStop(ownership, message);
      }
    }
  };

  handleValidatedInstrumentEvent(event: AtomizerInstrumentEvent): void {
    const k = this.k;
    if (event.type !== 'discovery' && event.type !== 'measurement') {
      k.instrumentStateEventSequence.current++;
    }
    if (event.type === 'discovery') {
      k.instrumentDiscoveryEventSequence.current++;
      k.connection.acceptDiscovery(event.result.candidates, event.result.failures);
    }
    else if (event.type === 'connected') this.acceptSession(event.session);
    else if (event.type === 'configured') this.acceptConfiguration(event.configuration);
    else if (event.type === 'configuration-invalidated') {
      if (k.state.instrument.session?.sessionId === event.sessionId) {
        k.invalidateAcquiredEvidence(true);
        this.acceptInstrumentState({ ...k.state.instrument, session: event.session }, true);
        this.observeInvalidatingFeatureLifecycle(event);
      }
    }
    else if (event.type === 'session-state') {
      if (k.state.instrument.session?.sessionId === event.session.sessionId) {
        if (event.reason === 'session-faulted') k.invalidateAcquiredEvidence(true);
        this.acceptInstrumentState({ ...k.state.instrument, session: event.session });
      }
    }
    else if (event.type === 'disconnected') {
      if (k.state.instrument.session?.sessionId !== event.sessionId) return;
      k.acquisition.clearContinuousStreamOwnership();
      k.continuousRequested.current = false;
      k.acquisition.wakeContinuousIqAdmissionWaiters();
      k.set({ continuous: false });
      this.acceptInstrumentState({ ...k.state.instrument, session: undefined, streaming: { status: 'stopped' } });
      k.invalidateAcquiredEvidence();
    }
    else if (event.type === 'preference') this.acceptInstrumentState({ ...k.state.instrument, preference: event.preference });
    else if (event.type === 'startup') this.acceptInstrumentState({ ...k.state.instrument, startup: event.startup });
    else if (event.type === 'streaming') {
      this.acceptInstrumentState({ ...k.state.instrument, streaming: event.streaming });
      if (event.streaming.status === 'stopped') {
        // Invoke acknowledgements own renderer stream generations. A stopped
        // event can cross the stop invoke response after a pause/resume has
        // already begun; it must never clear a replacement generation.
        if (!k.continuousRequested.current && !k.continuousStreamOwnership.current) {
          k.setKey('acquisition', (current) => current === 'failed' || current === 'stopping' ? current : 'complete');
        }
      } else if (event.streaming.status === 'faulted') {
        k.acquisition.clearContinuousStreamOwnership();
        k.continuousRequested.current = false;
        k.acquisition.wakeContinuousIqAdmissionWaiters();
        k.set({ continuous: false, acquisition: 'failed' });
        k.invalidateAcquiredEvidence();
        k.set({ error: event.streaming.message });
      }
    }
    else if (event.type === 'connection-cleanup') {
      this.acceptInstrumentState({ ...k.state.instrument, connectionCleanup: event.connectionCleanup });
    }
    else if (event.type === 'feature-result') {
      if (k.state.instrument.session?.sessionId !== event.session.sessionId) return;
      this.acceptInstrumentState({ ...k.state.instrument, session: event.session }, event.result.kind === 'signal-lab-profile-selection');
      this.acceptFeatureResult(event.result);
      this.observeInvalidatingFeatureLifecycle(event);
    }
    else if (event.type === 'measurement' && k.continuousRequested.current) {
      const currentSession = k.state.instrument.session;
      const ownership = k.continuousStreamOwnership.current;
      if (!currentSession || !ownership || event.measurement.sessionId !== currentSession.sessionId) return;
      k.acquisition.admitContinuousMeasurement({ ownership, session: currentSession, measurement: event.measurement });
    }
    else if (event.type === 'status') {
      if (k.state.instrument.session?.sessionId !== event.sessionId) return;
      if (event.status === 'faulted') {
        k.continuousRequested.current = false;
        k.acquisition.wakeContinuousIqAdmissionWaiters();
        k.set({ continuous: false, acquisition: 'failed' });
        k.invalidateAcquiredEvidence(true);
        k.set({ error: event.message ?? 'The active instrument session faulted' });
      }
    }
    else if (event.type === 'error') {
      if (k.state.instrument.session?.sessionId !== event.sessionId) return;
      if (!event.error.recoverable) {
        k.continuousRequested.current = false;
        k.acquisition.wakeContinuousIqAdmissionWaiters();
        k.set({ continuous: false, acquisition: 'failed' });
        k.invalidateAcquiredEvidence(true);
      }
      k.set({ error: `${event.error.code}: ${event.error.message}` });
    }
  }

  acceptInstrumentState(next: AtomizerInstrumentState, initializeSelection = false): void {
    const k = this.k;
    const previousSessionId = k.state.instrument.session?.sessionId;
    const admittedSession = next.session;
    const admittedProvenance = admittedSession?.provenance;
    if (admittedSession
      && admittedSession.sessionId !== previousSessionId
      && admittedProvenance?.sourceKind === 'signal-lab') {
      const provenance = admittedProvenance;
      console.info(`[ATOMIZER-SIGNAL-LAB-SESSION] ${JSON.stringify({
        schemaVersion: 1,
        event: 'admitted',
        sessionId: admittedSession.sessionId,
        driverId: admittedSession.driverId,
        provenance: {
          sourceKind: provenance.sourceKind,
          sourceId: provenance.sourceId,
          execution: provenance.execution,
          transport: provenance.transport,
          qualification: provenance.qualification,
          contractId: provenance.contractId,
          contractVersion: provenance.contractVersion,
          contractSha256: provenance.contractSha256,
          catalogSha256: provenance.catalogSha256,
          generatorSha256: provenance.generatorSha256,
          claims: provenance.claims,
        },
      })}`);
    }
    if (next.session?.sessionId !== previousSessionId) k.invalidateAcquiredEvidence(true);
    k.set({ instrument: next });
    if (next.session && (initializeSelection || next.session.sessionId !== previousSessionId)) this.initializeSessionSelection(next.session);
  }

  acceptSession(next: InstrumentSessionSnapshot): void {
    this.acceptInstrumentState({ ...this.k.state.instrument, session: next }, true);
    this.k.set({ diagnostics: [], screenFrame: undefined });
  }

  acceptConfiguration(configuration: InstrumentConfigurationState): void {
    const k = this.k;
    const active = k.state.instrument.session;
    if (!active || active.sessionId !== configuration.sessionId) return;
    this.acceptInstrumentState({ ...k.state.instrument, session: { ...active, configuration } });
  }

  acceptFeatureResult(result: InstrumentFeatureResult): void {
    const k = this.k;
    if (k.state.instrument.session?.sessionId !== result.sessionId) return;
    if (result.kind === 'screen') k.set({ screenFrame: result.frame });
    else if (result.kind === 'diagnostics') k.set({ diagnostics: result.lines });
    else if (result.kind === 'signal-lab-profile-selection') {
      k.invalidateAcquiredEvidence(true);
      const active = k.state.instrument.session;
      if (result.action === 'select-profile') {
        if (active) this.initializeSessionSelection(active, result.profileId, k.state.selectedSignalLabChannel);
      } else {
        k.set({ selectedSignalLabChannel: result.channel });
      }
    }
  }

  async executeInstrumentFeature(request: InstrumentFeatureRequest): Promise<InstrumentFeatureResult> {
    const k = this.k;
    const receipt = this.beginInvalidatingFeatureReceipt(request);
    try {
      const execution = await window.atomizerInstrument.executeFeature(request);
      const currentSessionId = k.state.instrument.session?.sessionId;
      if (!currentSessionId || execution.session.sessionId !== currentSessionId) {
        throw new Error('Instrument feature acknowledgement is stale for the active session');
      }
      if (receipt) {
        receipt.execution = execution;
        this.reconcileInvalidatingFeatureReceipt(receipt);
        await receipt.promise;
        if (k.state.instrument.session?.sessionId !== execution.session.sessionId) {
          throw new Error('Instrument feature lifecycle receipt was superseded before renderer admission');
        }
        // Both manager events have already crossed the renderer boundary and
        // synchronously applied their lifecycle invalidation. Only now may a
        // caller reserve/configure the replacement acquisition revision.
        return execution.result;
      }
      this.acceptInstrumentState(
        { ...k.state.instrument, session: execution.session },
        execution.result.kind === 'signal-lab-profile-selection',
      );
      this.acceptFeatureResult(execution.result);
      return execution.result;
    } catch (value) {
      if (receipt && !receipt.settled) this.rejectInvalidatingFeatureReceipt(value, receipt);
      throw value;
    }
  }

  beginInvalidatingFeatureReceipt(request: InstrumentFeatureRequest): InvalidatingFeatureReceipt | undefined {
    const k = this.k;
    if (!isInvalidatingFeatureRequest(request)) return undefined;
    const reason = invalidatingFeatureReason(request);
    if (!reason) throw new Error('Invalidating feature request has no lifecycle invalidation reason');
    if (k.pendingInvalidatingFeatureReceipt.current) {
      throw new Error('Another invalidating feature lifecycle receipt is already pending');
    }
    const sessionId = k.requireConnected().sessionId;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    let receipt!: InvalidatingFeatureReceipt;
    const timeout = window.setTimeout(() => {
      this.rejectInvalidatingFeatureReceipt(new Error(
        `Instrument feature lifecycle did not deliver a matching feature-result and ${reason} invalidation within ${INVALIDATING_FEATURE_RECEIPT_TIMEOUT_MILLISECONDS} ms`,
      ), receipt);
    }, INVALIDATING_FEATURE_RECEIPT_TIMEOUT_MILLISECONDS);
    receipt = {
      request,
      sessionId,
      reason,
      promise,
      resolve,
      reject,
      timeout,
      settled: false,
    };
    // The event path can reject before the invoke path reaches `await`.
    // Retain the original Promise for the caller while suppressing a transient
    // unhandled-rejection report from that legitimate ordering.
    void promise.catch(() => undefined);
    k.pendingInvalidatingFeatureReceipt.current = receipt;
    return receipt;
  }

  observeInvalidatingFeatureLifecycle(event: FeatureResultEvent | ConfigurationInvalidatedEvent): void {
    const receipt = this.k.pendingInvalidatingFeatureReceipt.current;
    if (!receipt || receipt.settled) return;
    const eventSessionId = event.type === 'feature-result'
      ? event.session.sessionId
      : event.sessionId;
    // Ignore a stale prior-session delivery. Active-session mismatches below
    // are fail-closed because the transaction gate permits only one such
    // mutation at a time.
    if (eventSessionId !== receipt.sessionId) return;
    if (event.type === 'feature-result') {
      if (!featureResultAcknowledgesRequest(event.result, receipt.request)) {
        this.rejectInvalidatingFeatureReceipt(new Error(
          `Invalidating feature lifecycle returned ${event.result.kind}/${event.result.action} for a different request`,
        ), receipt);
        return;
      }
      if (receipt.featureResult) {
        this.rejectInvalidatingFeatureReceipt(new Error('Invalidating feature lifecycle delivered a duplicate feature-result receipt'), receipt);
        return;
      }
      receipt.featureResult = event;
    } else {
      if (event.reason !== receipt.reason) {
        this.rejectInvalidatingFeatureReceipt(new Error(
          `Invalidating feature lifecycle delivered ${event.reason}; expected ${receipt.reason}`,
        ), receipt);
        return;
      }
      if (receipt.invalidation) {
        this.rejectInvalidatingFeatureReceipt(new Error('Invalidating feature lifecycle delivered a duplicate configuration-invalidated receipt'), receipt);
        return;
      }
      receipt.invalidation = event;
    }
    this.reconcileInvalidatingFeatureReceipt(receipt);
  }

  reconcileInvalidatingFeatureReceipt(receipt: InvalidatingFeatureReceipt): void {
    if (receipt.settled || !receipt.execution || !receipt.featureResult || !receipt.invalidation) return;
    const execution = receipt.execution;
    if (!sameStructuredValue(receipt.featureResult.result, execution.result)
      || !sameStructuredValue(receipt.featureResult.session, execution.session)
      || !sameStructuredValue(receipt.invalidation.session, execution.session)) {
      this.rejectInvalidatingFeatureReceipt(new Error(
        'Instrument feature invoke acknowledgement did not match its ordered lifecycle event receipts',
      ), receipt);
      return;
    }
    receipt.settled = true;
    window.clearTimeout(receipt.timeout);
    if (this.k.pendingInvalidatingFeatureReceipt.current === receipt) this.k.pendingInvalidatingFeatureReceipt.current = undefined;
    receipt.resolve();
  }

  rejectInvalidatingFeatureReceipt(reason: unknown, expected = this.k.pendingInvalidatingFeatureReceipt.current): void {
    if (!expected || expected.settled) return;
    expected.settled = true;
    window.clearTimeout(expected.timeout);
    if (this.k.pendingInvalidatingFeatureReceipt.current === expected) this.k.pendingInvalidatingFeatureReceipt.current = undefined;
    expected.reject(reason);
  }

  initializeSessionSelection(next: InstrumentSessionSnapshot, selectedProfileId?: string, selectedChannel?: SignalLabChannelState): void {
    const k = this.k;
    const profileCapability = next.capabilities.features.find((feature) => feature.kind === 'signal-lab-profile-selection');
    const profileId = selectedProfileId ?? profileCapability?.selectedProfileId;
    k.set({ selectedProfile: profileId, selectedSignalLabChannel: selectedChannel ?? profileCapability?.channel });
    const selectedProfileEntry = profileCapability?.profiles.find((profile) => profile.profileId === profileId);
    const detectedPower = next.capabilities.acquisitions.find((capability) => capability.kind === 'detected-power-timeseries');
    if (selectedProfileEntry) k.measurement.updateZeroSpanConfiguration((current) => {
      const staged = zeroSpanConfigSchema.parse({ ...current, frequencyHz: selectedProfileEntry.centerFrequencyHz });
      return detectedPower?.kind === 'detected-power-timeseries'
        ? reconcileDetectedPowerConfiguration(detectedPower, staged)
        : staged;
    });
    else if (detectedPower?.kind === 'detected-power-timeseries') {
      k.measurement.updateZeroSpanConfiguration((current) => reconcileDetectedPowerConfiguration(detectedPower, current));
    }
    const spectrum = next.capabilities.acquisitions.find((capability) => capability.kind === 'swept-spectrum');
    if (!spectrum) {
      k.invalidateAcquiredEvidence();
    } else {
      const current = k.state.analyzer;
      const maximumSpanHz = spectrum.frequencyHz.max - spectrum.frequencyHz.min;
      const profileSpanHz = selectedProfileEntry ? Math.min(selectedProfileEntry.recommendedSpanHz, maximumSpanHz) : undefined;
      const profileStartHz = selectedProfileEntry && profileSpanHz !== undefined
        ? Math.max(
          spectrum.frequencyHz.min,
          Math.min(Math.round(selectedProfileEntry.centerFrequencyHz - profileSpanHz / 2), spectrum.frequencyHz.max - profileSpanHz),
        )
        : undefined;
      const startHz = profileStartHz ?? Math.max(spectrum.frequencyHz.min, Math.min(current.startHz, spectrum.frequencyHz.max - 1));
      const stopHz = profileStartHz !== undefined && profileSpanHz !== undefined
        ? profileStartHz + profileSpanHz
        : Math.max(startHz + 1, Math.min(current.stopHz, spectrum.frequencyHz.max));
      const points = Math.max(spectrum.points.min, Math.min(current.points, spectrum.points.max));
      const staged = analyzerConfigSchema.parse({
        ...current,
        startHz,
        stopHz,
        points,
      });
      const reconciled = reconcileAnalyzerConfiguration(spectrum, staged);
      if (!sameAnalyzerConfiguration(current, reconciled)) {
        k.analyzerRevision.current++;
        k.set({ analyzer: reconciled });
      }
    }
    const iq = next.capabilities.acquisitions.find((capability) => capability.kind === 'complex-iq');
    if (iq?.kind === 'complex-iq') {
      const staged = selectedProfileEntry
        ? { ...k.state.iqConfiguration, centerHz: selectedProfileEntry.centerFrequencyHz }
        : k.state.iqConfiguration;
      const reconciled = reconcileComplexIqConfiguration(iq, staged);
      if (!sameComplexIqConfiguration(reconciled, k.state.iqConfiguration)) {
        k.iqConfigurationRevision.current++;
        k.set({ iqConfiguration: reconciled });
      }
    } else {
      k.set({ iqCapture: undefined });
    }
  }
}
