import {
  atomizerInstrumentFeatureExecutionSchema,
  atomizerInstrumentEventSchema,
  atomizerInstrumentConnectionCleanupStateSchema,
  atomizerInstrumentPreferenceSelectionSchema,
  atomizerInstrumentPreferenceStateSchema,
  atomizerInstrumentStateSchema,
  atomizerInstrumentStartupStateSchema,
  atomizerInstrumentStreamingStateSchema,
  instrumentCandidateSchema,
  instrumentConfigurationSchema,
  instrumentConfigurationStateSchema,
  instrumentDiscoveryResultSchema,
  instrumentFeatureRequestSchema,
  instrumentFeatureResultSchema,
  instrumentManagerEventSchema,
  instrumentMeasurementSchema,
  instrumentSessionSnapshotSchema,
  instrumentTimestampSchema,
  type AtomizerInstrumentEvent,
  type AtomizerInstrumentConnectionCleanupState,
  type AtomizerInstrumentFeatureExecution,
  type AtomizerInstrumentPreferenceSelection,
  type AtomizerInstrumentPreferenceState,
  type AtomizerInstrumentState,
  type AtomizerInstrumentStartupState,
  type AtomizerInstrumentStreamingState,
  type InstrumentCandidate,
  type InstrumentConfiguration,
  type InstrumentConfigurationState,
  type InstrumentDiscoveryResult,
  type InstrumentDriverId,
  type InstrumentFeatureRequest,
  type InstrumentFeatureResult,
  type InstrumentManagerEvent,
  type InstrumentMeasurement,
  type InstrumentSessionSnapshot,
  type InstrumentSourceKind,
} from '@tinysa/contracts';
import type { InstrumentManager } from '@tinysa/instrument-runtime';
import type {
  InstrumentPreference,
  LoadedInstrumentPreference,
} from './instrument-preference.js';
import { selectPreferredInstrument } from './startup-admission.js';

const MAX_PENDING_HOST_OPERATIONS = 64;

export interface AtomizerInstrumentPreferencePort {
  load(): Promise<LoadedInstrumentPreference>;
  save(driverId: InstrumentDriverId, candidateKind: InstrumentSourceKind, candidateId: string): Promise<InstrumentPreference>;
}

export interface AtomizerInstrumentHostRuntime {
  now(): Date;
  /** Monotonic host clock used only to avoid double-sleeping after acquisition. */
  monotonicMilliseconds?(): number;
  /** One interruptible, cooperative cadence slot between acquisitions. */
  yieldToEventLoop(milliseconds?: number): Promise<void>;
}

const defaultRuntime: AtomizerInstrumentHostRuntime = Object.freeze({
  now: () => new Date(),
  monotonicMilliseconds: () => performance.now(),
  yieldToEventLoop: (milliseconds = 0) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
});

type ManagerPort = Pick<InstrumentManager,
  | 'subscribe'
  | 'snapshot'
  | 'pendingConnectionCleanup'
  | 'discover'
  | 'connect'
  | 'configure'
  | 'acquire'
  | 'executeFeature'
  | 'disconnect'> & {
  readonly registry: {
    get(driverId: InstrumentDriverId): { readonly sourceKinds: readonly InstrumentSourceKind[] } | undefined;
  };
};

interface StreamRun {
  stopRequested: boolean;
  externalFault?: string;
  readonly targetPeriodMilliseconds: number;
  readonly done: Promise<void>;
  readonly stopSignal: Promise<void>;
  resolveDone(): void;
  resolveStop(): void;
}

interface ScheduledHostOperation {
  readonly operation: () => Promise<unknown> | unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly releaseAdmission: () => void;
}

type HostLifecycle = 'open' | 'closing' | 'closed';

/**
 * The only application service allowed to invoke InstrumentManager from IPC.
 * It owns continuous acquisition, startup admission, preference persistence,
 * and event de-duplication while leaving every device operation in the manager.
 */
export class AtomizerInstrumentHost {
  readonly #listeners = new Set<(event: AtomizerInstrumentEvent) => void>();
  readonly #unsubscribeManager: () => void;
  #lastPublishedMeasurement: { sessionId: string; configurationRevision: string; sequence: number } | undefined;
  readonly #normalOperations: ScheduledHostOperation[] = [];
  #safetyOperation: ScheduledHostOperation | undefined;
  #operationRunning = false;
  #pendingOperations = 0;
  #pendingSafetyOperations = 0;
  #preference: AtomizerInstrumentPreferenceState | undefined;
  #startup: AtomizerInstrumentStartupState = { status: 'not-started' };
  #streaming: AtomizerInstrumentStreamingState = { status: 'stopped' };
  #connectionCleanup: AtomizerInstrumentConnectionCleanupState = { status: 'not-required' };
  #streamRun: StreamRun | undefined;
  #streamBlockers = 0;
  #disconnectPromise: Promise<void> | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #connectionEpoch: object = Object.freeze({});
  #pendingAcquisition: { eventSequence?: number } | undefined;
  #lifecycle: HostLifecycle = 'open';

  constructor(
    private readonly manager: ManagerPort,
    private readonly preferences: AtomizerInstrumentPreferencePort,
    private readonly runtime: AtomizerInstrumentHostRuntime = defaultRuntime,
    private readonly selectPreference: typeof selectPreferredInstrument = selectPreferredInstrument,
  ) {
    this.#unsubscribeManager = manager.subscribe((event) => this.#acceptManagerEvent(event));
  }

  subscribe(listener: (event: AtomizerInstrumentEvent) => void): () => void {
    this.#requireOpen();
    if (typeof listener !== 'function') throw new TypeError('Instrument event listener must be a function');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  state(): AtomizerInstrumentState {
    // A schema-valid session can still have failed pre-announcement admission
    // (for example, synchronous event validation followed by failed teardown).
    // Keep that teardown lease explicit without presenting it as connected.
    const session = this.#connectionCleanup.status === 'required'
      && this.#connectionCleanup.phase === 'rejected-session'
      ? undefined
      : this.manager.snapshot();
    return atomizerInstrumentStateSchema.parse({
      schemaVersion: 1,
      startup: this.#startup,
      streaming: this.#streaming,
      connectionCleanup: this.#connectionCleanup,
      ...(this.#preference ? { preference: this.#preference } : {}),
      ...(session ? { session } : {}),
    });
  }

  discover(): Promise<InstrumentDiscoveryResult> {
    return this.#serializeOpen(async () => instrumentDiscoveryResultSchema.parse(await this.manager.discover()));
  }

  connect(candidateValue: InstrumentCandidate): Promise<InstrumentSessionSnapshot> {
    this.#requireOpen();
    const candidate = instrumentCandidateSchema.parse(candidateValue);
    return this.#withStreamingStopped(async () => {
      try { return instrumentSessionSnapshotSchema.parse(await this.manager.connect(candidate)); }
      finally { this.#syncConnectionCleanup(); }
    });
  }

  configure(configurationValue: InstrumentConfiguration): Promise<InstrumentConfigurationState> {
    this.#requireOpen();
    const configuration = instrumentConfigurationSchema.parse(configurationValue);
    return this.#withStreamingStopped(async () => {
      return instrumentConfigurationStateSchema.parse(await this.manager.configure(configuration));
    });
  }

  acquire(): Promise<InstrumentMeasurement> {
    this.#requireSessionWorkAvailable('Manual acquisition');
    return this.#serializeSessionOpen(async () => {
      if (this.#streamRun) throw new Error('Manual acquisition is unavailable while continuous acquisition is running');
      return this.#acquireAndPublish();
    });
  }

  async executeFeature(requestValue: InstrumentFeatureRequest): Promise<AtomizerInstrumentFeatureExecution> {
    this.#requireSessionWorkAvailable('Instrument feature execution');
    const request = instrumentFeatureRequestSchema.parse(requestValue);
    if (request.kind === 'signal-lab-profile-selection'
      || request.kind === 'touch'
      || (request.kind === 'rf-generator' && request.action === 'configure')) {
      return this.#withStreamingStopped(async () => {
        return this.#executeFeatureAndSnapshot(request);
      });
    }
    return this.#serializeSessionOpen(async () => {
      return this.#executeFeatureAndSnapshot(request);
    });
  }

  disconnect(): Promise<void> {
    // Teardown is intentionally idempotent across Electron lifecycle races.
    // A renderer-gone event can arrive while before-quit already owns shutdown;
    // attach to that terminal operation instead of throwing synchronously.
    if (this.#lifecycle === 'closing' && this.#shutdownPromise) return this.#shutdownPromise;
    if (this.#lifecycle === 'closed') return Promise.resolve();
    this.#requireOpen();
    if (this.#disconnectPromise) return this.#disconnectPromise;

    let resolveDisconnect!: () => void;
    let rejectDisconnect!: (reason: unknown) => void;
    const tracked = new Promise<void>((resolve, reject) => {
      resolveDisconnect = resolve;
      rejectDisconnect = reject;
    });
    // Reserve the operation before stopping a faulted stream can emit an
    // event and synchronously re-enter this method through an observer.
    this.#disconnectPromise = tracked;
    // Teardown overtakes ordinary host work. Invalidate every session mutation
    // admitted before this point so none can run after teardown and reopen or
    // mutate a connection the caller has just closed.
    this.#connectionEpoch = Object.freeze({});
    this.#streamBlockers++;
    const run = this.#requestStreamingStop();
    void (async () => {
      try {
        await run?.done;
        // Disconnect is an admitted RF-safety operation. If shutdown starts
        // while it is queued, it must still reach the manager exactly once.
        await this.#enqueue(() => this.#disconnectOwnedConnections(), 'rf-safe-teardown');
      } finally {
        this.#streamBlockers--;
      }
    })().then(() => {
      if (this.#disconnectPromise === tracked) this.#disconnectPromise = undefined;
      resolveDisconnect();
    }, (reason: unknown) => {
      if (this.#disconnectPromise === tracked) this.#disconnectPromise = undefined;
      rejectDisconnect(reason);
    });
    return tracked;
  }

  startStreaming(): Promise<AtomizerInstrumentStreamingState> {
    this.#requireSessionWorkAvailable('Continuous acquisition');
    if (this.#streamRun) {
      const run = this.#streamRun;
      // A run remains installed while its in-flight acquisition drains.  Do
      // not acknowledge that stopping run as the caller's requested start:
      // wait for its terminal state, then perform a fresh admission check and
      // create a genuinely live run.
      if (run.stopRequested) return run.done.then(() => this.startStreaming());
      return Promise.resolve(atomizerInstrumentStreamingStateSchema.parse(this.#streaming));
    }
    const session = this.manager.snapshot();
    if (!session) return Promise.reject(new Error('Continuous acquisition requires an active instrument session'));
    if (!session.configuration) return Promise.reject(new Error('Continuous acquisition requires an admitted configuration'));
    if (session.configuration.configuration.kind === 'complex-iq') {
      return Promise.reject(new Error('Complex-I/Q v1 is a bounded single acquisition and does not support continuous streaming'));
    }

    let resolveDone!: () => void;
    let resolveStop!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const stopSignal = new Promise<void>((resolve) => { resolveStop = resolve; });
    const sweepTimeSeconds = session.configuration.configuration.sweepTimeSeconds;
    const run: StreamRun = {
      stopRequested: false,
      // `auto` is receiver-owned timing: the blocking firmware acquisition is
      // already its backpressure. Exact/manual numeric timing can pace a fast
      // synthetic producer to the admitted period without adding a second full
      // sleep after a physical acquisition.
      targetPeriodMilliseconds: typeof sweepTimeSeconds === 'number' && Number.isFinite(sweepTimeSeconds)
        ? sweepTimeSeconds * 1_000
        : 0,
      done,
      stopSignal,
      resolveDone,
      resolveStop,
    };
    this.#streamRun = run;
    this.#setStreaming({ status: 'running', startedAt: this.#timestamp() });
    queueMicrotask(() => { void this.#pump(run); });
    return Promise.resolve(atomizerInstrumentStreamingStateSchema.parse(this.#streaming));
  }

  async stopStreaming(): Promise<AtomizerInstrumentStreamingState> {
    this.#requireOpen();
    const run = this.#requestStreamingStop();
    await run?.done;
    return atomizerInstrumentStreamingStateSchema.parse(this.#streaming);
  }

  readPreference(): Promise<AtomizerInstrumentPreferenceState> {
    return this.#serializeOpen(async () => this.#acceptPreference(await this.preferences.load()));
  }

  writePreference(selectionValue: AtomizerInstrumentPreferenceSelection): Promise<AtomizerInstrumentPreferenceState> {
    this.#requirePreferenceMutationSafe();
    return this.#serializeOpen(async () => {
      // Recheck after queue admission: a connect scheduled immediately before
      // this operation may have established a session while the preference
      // write was waiting in the serialized host tail.
      this.#requirePreferenceMutationSafe();
      const selection = atomizerInstrumentPreferenceSelectionSchema.parse(selectionValue);
      this.#requireRegisteredPreference(selection.driverId, selection.candidateKind);
      const discovery = instrumentDiscoveryResultSchema.parse(await this.manager.discover());
      this.selectPreference(discovery, {
        schemaVersion: 1,
        ...selection,
        updatedAt: this.#timestamp(),
      });
      // Discovery is source-owned and may itself surface a retained cleanup
      // lease. Never persist a candidate until that lifecycle remains clean.
      this.#syncConnectionCleanup();
      this.#requirePreferenceMutationSafe();
      const preference = await this.preferences.save(
        selection.driverId,
        selection.candidateKind,
        selection.candidateId,
      );
      return this.#acceptPreference({ source: 'persisted', preference });
    });
  }

  /** Attempts the configured startup candidate once, without fallback. */
  startPreferredInstrument(): Promise<AtomizerInstrumentState> {
    this.#requireOpen();
    if (this.#startup.status !== 'not-started') return Promise.resolve(this.state());
    return this.#withStreamingStopped(async () => {
      if (this.#startup.status !== 'not-started') return this.state();

      let preference: AtomizerInstrumentPreferenceState;
      try { preference = this.#acceptPreference(await this.preferences.load()); }
      catch (value) { return this.#failStartup('preference-load', value); }
      this.#requireOpen();

      let discovery: InstrumentDiscoveryResult;
      try { discovery = instrumentDiscoveryResultSchema.parse(await this.manager.discover()); }
      catch (value) { return this.#failStartup('discovery', value); }
      this.#requireOpen();

      let candidate: InstrumentCandidate;
      try { candidate = this.selectPreference(discovery, preference.preference); }
      catch (value) { return this.#failStartup('admission', value); }

      try { await this.manager.connect(candidate); }
      catch (value) {
        this.#syncConnectionCleanup();
        return this.#failStartup('connect', value);
      }
      this.#syncConnectionCleanup();

      this.#setStartup({ status: 'connected', connectedAt: this.#timestamp() });
      return this.state();
    });
  }

  /** Stops acquisition, tears down admitted sessions, then cleans any pre-admission connection lease. */
  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;

    let resolveShutdown!: () => void;
    let rejectShutdown!: (reason: unknown) => void;
    const tracked = new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });
    // Publish the terminal promise before any state event can synchronously
    // re-enter shutdown from a renderer observer.
    this.#shutdownPromise = tracked;
    this.#lifecycle = 'closing';
    this.#connectionEpoch = Object.freeze({});
    const run = this.#requestStreamingStop();
    const admittedDisconnect = this.#disconnectPromise;
    void (async () => {
      await run?.done;
      if (admittedDisconnect) await admittedDisconnect;
      else await this.#enqueue(() => this.#disconnectOwnedConnections(), 'rf-safe-teardown');
    })().then(() => {
      this.#lifecycle = 'closed';
      this.#unsubscribeManager();
      this.#listeners.clear();
      resolveShutdown();
    }, (reason: unknown) => {
      this.#lifecycle = 'open';
      if (this.#shutdownPromise === tracked) this.#shutdownPromise = undefined;
      rejectShutdown(reason);
    });
    return tracked;
  }

  async #pump(run: StreamRun): Promise<void> {
    let failure: unknown;
    try {
      while (!run.stopRequested && this.#streamRun === run) {
        const startedAt = this.#monotonicMilliseconds();
        await this.#serializeOpen(async () => {
          if (!run.stopRequested && this.#streamRun === run) await this.#acquireAndPublish();
        });
        if (!run.stopRequested && this.#streamRun === run) {
          const elapsed = Math.max(0, this.#monotonicMilliseconds() - startedAt);
          // Hardware/firmware acquisition normally consumes the requested
          // period itself; SignalLab synthesis does not. Wait only the
          // remainder, then always yield at least one event-loop turn via a
          // zero-delay timer when the producer already exceeded its period.
          const remaining = Math.max(0, run.targetPeriodMilliseconds - elapsed);
          await Promise.race([this.runtime.yieldToEventLoop(remaining), run.stopSignal]);
        }
      }
    } catch (value) {
      failure = value;
    } finally {
      if (this.#streamRun === run) {
        this.#streamRun = undefined;
        const fault = run.externalFault ?? (failure !== undefined && !run.stopRequested ? errorMessage(failure) : undefined);
        if (fault !== undefined) {
          this.#setStreaming({ status: 'faulted', message: fault, failedAt: this.#timestamp() });
        } else {
          this.#setStreaming({ status: 'stopped' });
        }
      }
      run.resolveDone();
    }
  }

  #monotonicMilliseconds(): number {
    const value = this.runtime.monotonicMilliseconds?.() ?? performance.now();
    if (!Number.isFinite(value)) throw new Error('Instrument host monotonic clock returned a non-finite value');
    return value;
  }

  async #acquireAndPublish(): Promise<InstrumentMeasurement> {
    if (this.#pendingAcquisition) throw new Error('Instrument host acquisition transaction re-entered');
    const pending: { eventSequence?: number } = {};
    this.#pendingAcquisition = pending;
    try {
      const measurement = instrumentMeasurementSchema.parse(await this.manager.acquire());
      if (pending.eventSequence !== undefined && pending.eventSequence !== measurement.sequence) {
        throw new Error('Instrument manager measurement event and acquisition return disagree');
      }
      this.#emitMeasurementOnce(measurement, true);
      return measurement;
    } finally {
      if (this.#pendingAcquisition === pending) this.#pendingAcquisition = undefined;
    }
  }

  #acceptManagerEvent(value: InstrumentManagerEvent): void {
    const event = instrumentManagerEventSchema.parse(value);
    if (event.type === 'measurement') {
      if (this.#pendingAcquisition) {
        if (this.#pendingAcquisition.eventSequence !== undefined) {
          this.#faultActiveStream('Instrument manager emitted more than one measurement for one acquisition');
          return;
        }
        this.#pendingAcquisition.eventSequence = event.measurement.sequence;
      } else {
        this.#emitMeasurementOnce(event.measurement, false);
      }
    } else {
      if ((event.type === 'status' && event.status === 'faulted') || event.type === 'error') {
        this.#faultActiveStream(event.type === 'error' ? event.error.message : event.message ?? 'Instrument session faulted');
      }
      this.#emit(event);
    }
    if (event.type === 'disconnected') {
      this.#lastPublishedMeasurement = undefined;
    }
  }

  #emitMeasurementOnce(measurement: InstrumentMeasurement, allowNovel: boolean): void {
    // The manager already polices sequence monotonicity and content identity;
    // the host only needs once-only publication when the same measurement is
    // delivered through both the manager event and the acquisition return.
    const last = this.#lastPublishedMeasurement;
    if (last
      && last.sessionId === measurement.sessionId
      && last.configurationRevision === measurement.configurationRevision
      && last.sequence === measurement.sequence) {
      return;
    }
    if (!allowNovel) {
      const message = 'Instrument manager emitted a novel measurement outside a host acquisition transaction';
      this.#faultActiveStream(message);
      throw new Error(message);
    }
    this.#lastPublishedMeasurement = {
      sessionId: measurement.sessionId,
      configurationRevision: measurement.configurationRevision,
      sequence: measurement.sequence,
    };
    this.#emit({ type: 'measurement', measurement });
  }

  async #executeFeatureAndSnapshot(request: InstrumentFeatureRequest): Promise<AtomizerInstrumentFeatureExecution> {
    const result = instrumentFeatureResultSchema.parse(await this.manager.executeFeature(request));
    const session = this.manager.snapshot();
    if (!session) throw new Error('Instrument feature completed without an active session snapshot');
    return atomizerInstrumentFeatureExecutionSchema.parse({ result, session });
  }

  async #disconnectOwnedConnections(): Promise<void> {
    // InstrumentManager.disconnect is the atomic teardown boundary: admitted
    // session first, then every driver's retained pre-session connection.
    try { await this.manager.disconnect(); }
    finally { this.#syncConnectionCleanup(); }
  }

  #syncConnectionCleanup(): void {
    const pending = this.manager.pendingConnectionCleanup();
    const next = atomizerInstrumentConnectionCleanupStateSchema.parse(pending
      ? { status: 'required', driverId: pending.driverId, phase: pending.phase }
      : { status: 'not-required' });
    if (next.status === this.#connectionCleanup.status
      && (next.status === 'not-required'
        || (this.#connectionCleanup.status === 'required'
          && next.driverId === this.#connectionCleanup.driverId
          && next.phase === this.#connectionCleanup.phase))) return;
    this.#connectionCleanup = next;
    this.#emit({ type: 'connection-cleanup', connectionCleanup: next });
  }

  #faultActiveStream(message: string): void {
    const run = this.#streamRun;
    if (!run) return;
    run.externalFault = errorMessage(message);
    if (!run.stopRequested) {
      run.stopRequested = true;
      run.resolveStop();
    }
  }

  #acceptPreference(value: LoadedInstrumentPreference): AtomizerInstrumentPreferenceState {
    const preference = atomizerInstrumentPreferenceStateSchema.parse(value);
    this.#requireRegisteredPreference(preference.preference.driverId, preference.preference.candidateKind);
    this.#preference = preference;
    this.#emit({ type: 'preference', preference });
    return preference;
  }

  #requireRegisteredPreference(driverId: InstrumentDriverId, candidateKind?: InstrumentSourceKind): void {
    const driver = this.manager.registry.get(driverId);
    if (!driver) throw new Error(`Instrument driver ${driverId} is not statically registered`);
    if (candidateKind && !driver.sourceKinds.includes(candidateKind)) {
      throw new Error(`Instrument driver ${driverId} does not own source kind ${candidateKind}`);
    }
  }

  #failStartup(stage: Extract<AtomizerInstrumentStartupState, { status: 'failed' }>['stage'], value: unknown): AtomizerInstrumentState {
    this.#setStartup({ status: 'failed', stage, message: errorMessage(value), failedAt: this.#timestamp() });
    return this.state();
  }

  #setStartup(value: AtomizerInstrumentStartupState): void {
    this.#startup = atomizerInstrumentStartupStateSchema.parse(value);
    this.#emit({ type: 'startup', startup: this.#startup });
  }

  #setStreaming(value: AtomizerInstrumentStreamingState): void {
    this.#streaming = atomizerInstrumentStreamingStateSchema.parse(value);
    this.#emit({ type: 'streaming', streaming: this.#streaming });
  }

  #emit(value: AtomizerInstrumentEvent): void {
    const event = atomizerInstrumentEventSchema.parse(value);
    for (const listener of [...this.#listeners]) {
      try { listener(structuredClone(event)); } catch { /* Renderer observers cannot break lifecycle state. */ }
    }
  }

  #requestStreamingStop(): StreamRun | undefined {
    const run = this.#streamRun;
    if (run && !run.stopRequested) {
      run.stopRequested = true;
      run.resolveStop();
    }
    else if (this.#streaming.status === 'faulted') this.#setStreaming({ status: 'stopped' });
    return run;
  }

  async #withStreamingStopped<T>(operation: () => Promise<T> | T): Promise<T> {
    this.#requireOpen();
    if (this.#disconnectPromise) throw new Error('Instrument connection is disconnecting');
    const admittedEpoch = this.#connectionEpoch;
    // Reserve bounded tail ownership before waiting for the current stream to
    // finish. Otherwise an arbitrary number of connect/configure/feature
    // callers can all retain closures while awaiting the same `run.done`, and
    // only encounter the queue ceiling after that wait has completed.
    const releaseAdmission = this.#reserveAdmission('normal');
    this.#streamBlockers++;
    const run = this.#requestStreamingStop();
    let handedToTail = false;
    try {
      await run?.done;
      const result = this.#enqueueAdmitted(() => {
        this.#requireOpen();
        this.#requireConnectionEpoch(admittedEpoch);
        return operation();
      }, releaseAdmission, 'normal');
      handedToTail = true;
      return await result;
    } finally {
      this.#streamBlockers--;
      if (!handedToTail) releaseAdmission();
    }
  }

  #serializeOpen<T>(operation: () => Promise<T> | T): Promise<T> {
    this.#requireOpen();
    return this.#enqueue(() => {
      this.#requireOpen();
      return operation();
    });
  }

  #serializeSessionOpen<T>(operation: () => Promise<T> | T): Promise<T> {
    this.#requireOpen();
    if (this.#disconnectPromise) return Promise.reject(new Error('Instrument connection is disconnecting'));
    const admittedEpoch = this.#connectionEpoch;
    return this.#enqueue(() => {
      this.#requireOpen();
      this.#requireConnectionEpoch(admittedEpoch);
      return operation();
    });
  }

  #enqueue<T>(operation: () => Promise<T> | T, admission: 'normal' | 'rf-safe-teardown' = 'normal'): Promise<T> {
    // Privileged IPC has a smaller global cap, but the host is independently
    // usable and continuously self-schedules acquisitions. Bound this layer
    // as well so future in-process consumers cannot grow its Promise tail.
    let releaseAdmission: () => void;
    try { releaseAdmission = this.#reserveAdmission(admission); }
    catch (error) { return Promise.reject(error); }
    return this.#enqueueAdmitted(operation, releaseAdmission, admission);
  }

  #enqueueAdmitted<T>(
    operation: () => Promise<T> | T,
    releaseAdmission: () => void,
    admission: 'normal' | 'rf-safe-teardown',
  ): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      const scheduled: ScheduledHostOperation = {
        operation,
        resolve: (value) => resolve(value as T),
        reject,
        releaseAdmission,
      };
      if (admission === 'rf-safe-teardown') this.#safetyOperation = scheduled;
      else this.#normalOperations.push(scheduled);
      this.#drainOperations();
    });
    return result;
  }

  #drainOperations(): void {
    if (this.#operationRunning) return;
    const scheduled = this.#safetyOperation ?? this.#normalOperations.shift();
    if (!scheduled) return;
    if (this.#safetyOperation === scheduled) this.#safetyOperation = undefined;
    this.#operationRunning = true;
    void Promise.resolve().then(scheduled.operation).then(
      (value) => this.#settleOperation(scheduled, true, value),
      (reason: unknown) => this.#settleOperation(scheduled, false, reason),
    );
  }

  #settleOperation(scheduled: ScheduledHostOperation, succeeded: boolean, value: unknown): void {
    scheduled.releaseAdmission();
    this.#operationRunning = false;
    if (succeeded) scheduled.resolve(value);
    else scheduled.reject(value);
    this.#drainOperations();
  }

  #reserveAdmission(admission: 'normal' | 'rf-safe-teardown'): () => void {
    if (admission === 'normal' && this.#pendingOperations >= MAX_PENDING_HOST_OPERATIONS) {
      throw new Error(`Instrument host admission limit of ${MAX_PENDING_HOST_OPERATIONS} pending operations was reached`);
    }
    // Disconnect/shutdown are idempotently coalesced by their public methods
    // and own one separately bounded slot so normal traffic cannot crowd out
    // the RF-safe teardown path.
    if (admission === 'rf-safe-teardown' && this.#pendingSafetyOperations >= 1) {
      throw new Error('Instrument host RF-safe teardown is already pending');
    }
    if (admission === 'normal') this.#pendingOperations++;
    else this.#pendingSafetyOperations++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (admission === 'normal') this.#pendingOperations--;
      else this.#pendingSafetyOperations--;
    };
  }

  #requireSessionWorkAvailable(operation: string): void {
    this.#requireOpen();
    if (this.#disconnectPromise) throw new Error(`${operation} is unavailable while the instrument is disconnecting`);
    if (this.#streamBlockers > 0) throw new Error(`${operation} is unavailable during an instrument connection or configuration transition`);
  }

  #requirePreferenceMutationSafe(): void {
    this.#requireOpen();
    if (this.manager.snapshot() || this.#streamRun || this.#disconnectPromise
      || this.#connectionCleanup.status === 'required'
      || this.manager.pendingConnectionCleanup()) {
      throw new Error('Disconnect the active instrument and complete connection cleanup before changing the startup default');
    }
  }

  #requireOpen(): void {
    if (this.#lifecycle !== 'open') throw new Error('Atomizer instrument host is closed');
  }

  #requireConnectionEpoch(admittedEpoch: object): void {
    if (this.#connectionEpoch !== admittedEpoch) {
      throw new Error('Instrument session operation was canceled by disconnect');
    }
  }
  #timestamp(): string { return instrumentTimestampSchema.parse(this.runtime.now().toISOString()); }
}

function errorMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return (raw.trim() || 'Unknown error').slice(0, 4_096);
}
