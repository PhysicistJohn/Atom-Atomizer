import {
  atomizerInstrumentEventSchema,
  type AtomizerInstrumentEvent,
  type AtomizerInstrumentState,
  type CanonicalInstrumentSurface,
  type CanonicalOperationParameterIntent,
  type CanonicalOperationResult,
  type InstrumentConfigurationState,
  type InstrumentFeatureRequest,
  type InstrumentFeatureResult,
  type InstrumentSessionSnapshot,
} from '@tinysa/contracts';
import {
  errorMessage,
  featureResultAcknowledgesRequest,
  invalidatingFeatureReason,
  isInvalidatingFeatureRequest,
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
      this.acceptInstrumentState({ ...k.state.instrument, session: event.session }, true);
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

  acceptInstrumentState(next: AtomizerInstrumentState, refreshCanonicalSurface = false): void {
    const k = this.k;
    const previousSessionId = k.state.instrument.session?.sessionId;
    const admittedSession = next.session;
    if (next.session?.sessionId !== previousSessionId) k.invalidateAcquiredEvidence(true);
    k.set({
      instrument: next,
      ...(next.session?.sessionId === previousSessionId ? {} : { canonicalSurface: undefined }),
    });
    if (next.session && (refreshCanonicalSurface || next.session.sessionId !== previousSessionId)) {
      this.refreshCanonicalSurface(next.session.sessionId);
    }
  }

  acceptSession(next: InstrumentSessionSnapshot): void {
    this.acceptInstrumentState({ ...this.k.state.instrument, session: next }, true);
    this.k.set({ diagnostics: [], screenFrame: undefined });
  }

  acceptConfiguration(configuration: InstrumentConfigurationState): void {
    const k = this.k;
    const active = k.state.instrument.session;
    if (!active || active.sessionId !== configuration.sessionId) return;
    const current = active.configuration;
    if (current?.configurationRevision === configuration.configurationRevision) {
      if (!sameStructuredValue(current, configuration)) {
        throw new Error(`Instrument configuration revision ${configuration.configurationRevision} changed after admission`);
      }
      return;
    }
    this.acceptInstrumentState({ ...k.state.instrument, session: { ...active, configuration } });
    this.refreshCanonicalSurface(configuration.sessionId);
  }

  /**
   * Resolve a generic operation against the current driver surface.  The
   * renderer sends only its chosen Auto/manual intents; the driver is solely
   * responsible for translating those into device controls and for returning
   * the resulting effective values and their verification.
   */
  async executeCanonicalOperation(
    surface: CanonicalInstrumentSurface,
    operationId: string,
    parameters: readonly CanonicalOperationParameterIntent[],
  ): Promise<CanonicalOperationResult> {
    const k = this.k;
    const execute = window.atomizerInstrument.executeCanonicalOperation;
    if (!execute) throw new Error('The connected instrument does not publish generic operations yet');
    try {
      return await k.acquisition.runInstrumentTransaction('execute-canonical-operation', async () => {
        const session = k.requireConnected();
        // A generic operation may retune or otherwise replace the admitted
        // measurement geometry. Never leave evidence from the old geometry
        // visible while its driver-owned configuration is being applied.
        k.invalidateAcquiredEvidence(true);
        const result = await execute({
          sessionId: session.sessionId,
          surfaceRevision: surface.revision,
          operationId,
          parameters: [...parameters],
        });
        if (k.state.instrument.session?.sessionId !== result.sessionId) {
          throw new Error('Generic operation acknowledgement belongs to a stale instrument session');
        }
        k.set({
          canonicalSurface: result.surface,
          error: undefined,
          notice: 'Instrument operation applied',
        });
        return result;
      });
    } catch (value) {
      if (k.state.instrument.session) k.set({ error: errorMessage(value) });
      throw value;
    }
  }

  /** Latest-wins refresh so a late IPC response can never restore a prior session's controls. */
  refreshCanonicalSurface(sessionId: string): void {
    // Isolated controller tests intentionally exercise lifecycle admission
    // without an Electron preload.  A real renderer always has this bridge.
    const read = window.atomizerInstrument?.canonicalSurface;
    if (!read) return;
    void read().then((surface) => {
      if (this.k.state.instrument.session?.sessionId !== sessionId) return;
      this.k.set({ canonicalSurface: surface });
    }).catch((value) => {
      if (this.k.state.instrument.session?.sessionId !== sessionId) return;
      this.k.set({ canonicalSurface: undefined, error: `Could not refresh instrument controls: ${errorMessage(value)}` });
    });
  }

  acceptFeatureResult(result: InstrumentFeatureResult): void {
    const k = this.k;
    if (k.state.instrument.session?.sessionId !== result.sessionId) return;
    if (result.kind === 'screen') k.set({ screenFrame: result.frame });
    else if (result.kind === 'diagnostics') k.set({ diagnostics: result.lines });
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
      this.acceptInstrumentState({ ...k.state.instrument, session: execution.session }, true);
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

}
