import { structuralEqual } from './structural-equal.js';
import {
  instrumentCandidateSchema,
  instrumentCapabilitiesSchema,
  instrumentConfigurationCommandSchema,
  instrumentConfigurationCapabilityBindingIssues,
  instrumentConfigurationSchema,
  instrumentConfigurationStateSchema,
  instrumentDiscoveryResultSchema,
  instrumentFeatureCommandSchema,
  instrumentFeatureRequestSchema,
  instrumentFeatureResultSchema,
  instrumentManagerEventSchema,
  instrumentMeasurementSchema,
  instrumentOpaqueIdSchema,
  instrumentSessionSnapshotSchema,
  instrumentTimestampSchema,
  type InstrumentCandidate,
  type InstrumentCapabilities,
  type InstrumentConfiguration,
  type InstrumentConfigurationState,
  type InstrumentDiscoveryFailure,
  type InstrumentDiscoveryResult,
  type InstrumentFeatureRequest,
  type InstrumentFeatureResult,
  type InstrumentError,
  type InstrumentManagerEvent,
  type InstrumentMeasurement,
  type InstrumentRfOutputQualification,
  type InstrumentRfOutputState,
  type InstrumentReceiveOnlySafetyState,
  type InstrumentSessionEvent,
  type InstrumentSessionSnapshot,
  type InstrumentSourceKind,
} from '@tinysa/contracts';
import {
  InstrumentDriverContractError,
  parseInstrumentSessionEvent,
  validateDriverCandidate,
  validateInstrumentDriverDiscoveryResult,
  validateInstrumentSession,
  type InstrumentDriver,
  type InstrumentSession,
} from './instrument-driver.js';
import { InstrumentDriverRegistry } from './instrument-driver-registry.js';

export type InstrumentManagerErrorCode =
  | 'admission-limit'
  | 'operation-canceled'
  | 'stale-candidate'
  | 'session-active'
  | 'no-session'
  | 'unsupported-capability'
  | 'not-configured'
  | 'driver-contract'
  | 'driver-failure';

export class InstrumentManagerError extends Error {
  override readonly name = 'InstrumentManagerError';
  constructor(readonly code: InstrumentManagerErrorCode, message: string, options?: ErrorOptions) { super(message, options); }
}

export interface InstrumentManagerRuntime {
  now(): Date;
  opaqueId(scope: 'discovery' | 'configuration'): string;
}

const defaultRuntime: InstrumentManagerRuntime = Object.freeze({
  now: () => new Date(),
  opaqueId: (scope: 'discovery' | 'configuration') => `${scope}:${crypto.randomUUID()}`,
});

interface ActiveSession {
  driver: InstrumentDriver;
  session: InstrumentSession;
  capabilities: InstrumentCapabilities;
  unsubscribe: () => void;
  configuration?: InstrumentConfigurationState;
  producerConfigurationEpoch?: string;
  rfOutput: InstrumentRfOutputState;
  rfOutputQualification: InstrumentRfOutputQualification;
  receiveOnlySafety?: InstrumentReceiveOnlySafetyState;
  fault?: InstrumentError;
  faultRevision: number;
  lastMeasurementSequence: number;
  // One latch per admitted acquisition: whether the driver's session event for
  // the last returned measurement has already been delivered. Sequences are
  // positive integers, so plain integer tracking replaces content digests.
  lastMeasurementEventDelivered: boolean;
  acquisition?: { eventSequence?: number };
  announced: boolean;
}

interface RejectedSessionTeardown {
  readonly driverId: InstrumentDriver['driverId'];
  disconnect(): Promise<void>;
}

interface ScheduledManagerOperation {
  readonly operation: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly admission: 'normal' | 'teardown';
}

export interface InstrumentConnectionCleanupRequirement {
  readonly driverId: InstrumentDriver['driverId'];
  readonly phase: 'driver-pending' | 'rejected-session';
}

const MAX_SYNCHRONOUS_SESSION_EVENTS = 256;
const MAX_PENDING_MANAGER_OPERATIONS = 64;

export class InstrumentManager {
  readonly #listeners = new Set<(event: InstrumentManagerEvent) => void>();
  readonly #normalOperations: ScheduledManagerOperation[] = [];
  #teardownOperation: ScheduledManagerOperation | undefined;
  #operationRunning = false;
  #pendingOperations = 0;
  #pendingTeardownOperations = 0;
  #disconnectOperation: Promise<void> | undefined;
  #connectionEpoch: object = Object.freeze({});
  #latestDiscoveryRevision: string | undefined;
  #latestCandidates = new Map<string, InstrumentCandidate>();
  #active: ActiveSession | undefined;
  #rejectedSessionTeardown: RejectedSessionTeardown | undefined;
  #pendingDriverCleanupBarrier: InstrumentDriver['driverId'] | undefined;

  constructor(
    readonly registry: InstrumentDriverRegistry,
    private readonly runtime: InstrumentManagerRuntime = defaultRuntime,
  ) {}

  subscribe(listener: (event: InstrumentManagerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(): InstrumentSessionSnapshot | undefined {
    return this.#active ? this.#snapshot(this.#active) : undefined;
  }

  pendingConnectionCleanup(): InstrumentConnectionCleanupRequirement | undefined {
    if (this.#active && !this.#active.announced) {
      return Object.freeze({ driverId: this.#active.driver.driverId, phase: 'rejected-session' });
    }
    if (this.#rejectedSessionTeardown) {
      return Object.freeze({ driverId: this.#rejectedSessionTeardown.driverId, phase: 'rejected-session' });
    }
    if (this.#pendingDriverCleanupBarrier) {
      return Object.freeze({ driverId: this.#pendingDriverCleanupBarrier, phase: 'driver-pending' });
    }
    return undefined;
  }

  discover(): Promise<InstrumentDiscoveryResult> {
    return this.#serialize(() => this.#discover());
  }

  connect(candidate: InstrumentCandidate): Promise<InstrumentSessionSnapshot> {
    return this.#serializeSessionOperation(() => this.#connect(candidate));
  }

  configure(configuration: InstrumentConfiguration): Promise<InstrumentConfigurationState> {
    return this.#serializeSessionOperation(() => this.#configure(configuration));
  }

  acquire(): Promise<InstrumentMeasurement> {
    return this.#serializeSessionOperation(() => this.#acquire());
  }

  executeFeature(request: InstrumentFeatureRequest): Promise<InstrumentFeatureResult> {
    return this.#serializeSessionOperation(() => this.#executeFeature(request));
  }

  disconnect(): Promise<void> {
    if (this.#disconnectOperation) return this.#disconnectOperation;
    // RF-safe teardown is allowed to overtake the bounded normal queue. Make
    // that priority a cancellation barrier as well: a connect/configure/
    // acquire/feature call admitted against the old session epoch must never
    // execute after teardown and silently create or mutate a new session.
    this.#connectionEpoch = Object.freeze({});
    const operation = this.#serialize(async () => {
      // Admitted-session ownership is always released first. If that fails,
      // do not let a driver's pre-session cleanup hook bypass the active
      // session's RF-safety lifecycle. A later call retries this whole order.
      await this.#disconnect();
      await this.#cleanupRejectedSession();
      await this.#cleanupPendingConnections();
    }, 'teardown');
    this.#disconnectOperation = operation;
    void operation.then(
      () => { if (this.#disconnectOperation === operation) this.#disconnectOperation = undefined; },
      () => { if (this.#disconnectOperation === operation) this.#disconnectOperation = undefined; },
    );
    return operation;
  }

  async #discover(): Promise<InstrumentDiscoveryResult> {
    const discoveryRevision = this.#opaqueId('discovery');
    const outcomes = await Promise.all(this.registry.list().map(async (driver) => {
      try {
        const discovered = validateInstrumentDriverDiscoveryResult(driver, await driver.discover());
        const candidates = discovered.candidates.map((value) => validateDriverCandidate(driver, value));
        return {
          candidates: candidates.map((candidate) => instrumentCandidateSchema.parse({ ...candidate, discoveryRevision })),
          failures: discovered.failures.map((failure): InstrumentDiscoveryFailure => ({
            driverId: driver.driverId,
            ...failure,
          })),
        };
      } catch (value) {
        const failure: InstrumentDiscoveryFailure = {
          driverId: driver.driverId,
          code: 'driver-failure',
          recoverable: false,
          message: message(value),
        };
        return { candidates: [] as InstrumentCandidate[], failures: [failure] };
      }
    }));

    const candidates = outcomes.flatMap((outcome) => outcome.candidates);
    const failures = outcomes.flatMap((outcome) => outcome.failures);
    const result = instrumentDiscoveryResultSchema.parse({
      discoveryRevision,
      discoveredAt: this.#timestamp(),
      candidates,
      failures,
    });
    // Commit discovery ownership only after the aggregate public boundary is
    // admitted. An oversized multi-driver result must not replace or retain
    // the last usable candidate map.
    this.#latestDiscoveryRevision = discoveryRevision;
    this.#latestCandidates = new Map(result.candidates.map((candidate) => {
      // Discovery results are public mutable objects. Retain an isolated,
      // immutable copy so a caller cannot rewrite the evidence later used for
      // stale-candidate admission.
      const evidence = deepFreeze(instrumentCandidateSchema.parse(structuredClone(candidate)));
      return [candidateKey(evidence), evidence] as const;
    }));
    this.#emit({ type: 'discovery', result });
    return result;
  }

  async #connect(candidateValue: InstrumentCandidate): Promise<InstrumentSessionSnapshot> {
    if (this.#active) throw new InstrumentManagerError('session-active', `Instrument session ${this.#active.session.sessionId} is already active`);
    if (this.#rejectedSessionTeardown) {
      throw new InstrumentManagerError(
        'session-active',
        `Driver ${this.#rejectedSessionTeardown.driverId} still owns a rejected session teardown; disconnect before reconnecting`,
      );
    }
    if (this.#pendingDriverCleanupBarrier) {
      throw new InstrumentManagerError(
        'session-active',
        `Driver ${this.#pendingDriverCleanupBarrier} returned an invalid session without a usable teardown; disconnect before reconnecting`,
      );
    }
    const candidate = instrumentCandidateSchema.parse(candidateValue);
    const current = this.#latestCandidates.get(candidateKey(candidate));
    if (!this.#latestDiscoveryRevision
      || candidate.discoveryRevision !== this.#latestDiscoveryRevision
      || !current
      || !structuralEqual(current, candidate)) {
      throw new InstrumentManagerError('stale-candidate', 'Instrument candidate is stale or was not produced by the latest completed discovery');
    }
    // Dispatch an immutable clone of the retained evidence, not the caller's
    // object, so the driver cannot mutate the candidate after admission.
    const admittedCandidate = deepFreeze(instrumentCandidateSchema.parse(structuredClone(current)));
    const driver = this.registry.require(admittedCandidate.driverId);
    if (!driver.sourceKinds.includes(admittedCandidate.sourceKind)) {
      throw new InstrumentManagerError('driver-contract', `Driver ${driver.driverId} does not declare source kind ${admittedCandidate.sourceKind}`);
    }

    let session: InstrumentSession | undefined;
    let returnedSession: unknown;
    let driverConnectReturned = false;
    let active: ActiveSession | undefined;
    let eventMode: 'buffering' | 'forwarding' | 'discarding' = 'buffering';
    try {
      returnedSession = await driver.connect(admittedCandidate);
      driverConnectReturned = true;
      session = validateInstrumentSession(driver, admittedCandidate, returnedSession);
      const initialReceiveOnlySafety = session.receiveOnlySafety;
      active = {
        driver,
        session,
        capabilities: session.capabilities,
        unsubscribe: () => undefined,
        ...(session.provenance.sourceKind === 'signal-lab'
          ? { producerConfigurationEpoch: session.provenance.producerConfigurationEpoch }
          : {}),
        rfOutput: session.rfOutput,
        rfOutputQualification: rfOutputQualification(session.provenance.sourceKind, session.rfOutput),
        ...(initialReceiveOnlySafety
          ? { receiveOnlySafety: deepFreeze(structuredClone(initialReceiveOnlySafety)) }
          : {}),
        faultRevision: 0,
        lastMeasurementSequence: 0,
        lastMeasurementEventDelivered: true,
        announced: false,
      };
      this.#active = active;
      const eventOwner = active;
      const pendingEvents: InstrumentSessionEvent[] = [];
      let synchronousEventLimitExceeded = false;
      const unsubscribe = session.subscribe((event) => {
        if (eventMode === 'forwarding') this.#forward(eventOwner, event);
        else if (eventMode === 'buffering') {
          if (pendingEvents.length >= MAX_SYNCHRONOUS_SESSION_EVENTS) {
            eventMode = 'discarding';
            synchronousEventLimitExceeded = true;
            this.#faultActive(eventOwner, new InstrumentDriverContractError(
              `Driver ${driver.driverId} exceeded ${MAX_SYNCHRONOUS_SESSION_EVENTS} synchronous subscription events`,
            ), false);
          } else pendingEvents.push(event);
        }
        else this.#forward(eventOwner, event, false);
      });
      if (typeof unsubscribe !== 'function') throw new InstrumentDriverContractError(`Driver ${driver.driverId} session subscribe did not return an unsubscribe function`);
      active.unsubscribe = unsubscribe;
      const initialPendingEvents = pendingEvents.splice(0);
      const admittedPendingEvents = initialPendingEvents
        .map((event) => this.#forward(eventOwner, event, false))
        .filter((event): event is InstrumentSessionEvent => event !== undefined);
      if (active.fault) throw faultedSessionError(active);
      const snapshot = this.#snapshot(active);
      // Announce the session only after synchronous subscription events pass
      // admission. Valid non-terminal observations retain connected-first
      // ordering without being applied twice.
      active.announced = true;
      this.#emit({ type: 'connected', session: snapshot });
      const publicationQueue = [...admittedPendingEvents];
      let publicationIndex = 0;
      let admissionEventCount = initialPendingEvents.length;
      // Manager listeners may synchronously provoke a driver event while the
      // connected notification is being delivered. Keep buffering until the
      // connected event and every causally queued session event have been
      // published in FIFO order to every listener; otherwise a late append can
      // disappear after the original subscription buffer snapshot.
      while (!synchronousEventLimitExceeded
        && (publicationIndex < publicationQueue.length || pendingEvents.length > 0)) {
        if (pendingEvents.length > 0) {
          const reentrantEvents = pendingEvents.splice(0);
          admissionEventCount += reentrantEvents.length;
          if (admissionEventCount > MAX_SYNCHRONOUS_SESSION_EVENTS) {
            synchronousEventLimitExceeded = true;
            eventMode = 'discarding';
            this.#faultActive(eventOwner, new InstrumentDriverContractError(
              `Driver ${driver.driverId} exceeded ${MAX_SYNCHRONOUS_SESSION_EVENTS} synchronous admission events`,
            ), false);
            break;
          }
          for (const reentrantEvent of reentrantEvents) {
            const admitted = this.#forward(eventOwner, reentrantEvent, false);
            if (admitted) publicationQueue.push(admitted);
          }
        }
        const event = publicationQueue[publicationIndex++];
        if (event) this.#publishForwardedEvent(eventOwner, event);
      }
      eventMode = 'forwarding';
      if (synchronousEventLimitExceeded) {
        pendingEvents.length = 0;
        this.#emit({ type: 'session-state', reason: 'session-faulted', session: this.#snapshot(active) });
      }
      return this.#snapshot(active);
    } catch (value) {
      // Once admission has failed, never retain further driver events in the
      // synchronous-admission buffer. A session whose teardown also fails may
      // remain attached indefinitely; validate and discard its later events
      // while it is exposed only for a teardown retry.
      eventMode = 'discarding';
      if (active && this.#active === active) {
        try { await this.#cleanupUnannouncedSession(active); }
        catch (cleanup) {
          if (this.#active === active) {
            this.#faultActive(active, asManagerError(cleanup, 'driver-contract', 'Rejected session cleanup failed'), false);
          }
          throw new InstrumentManagerError(
            'driver-contract',
            `${message(value)}. Admitted-session RF-safe cleanup also failed: ${message(cleanup)}`,
            { cause: new AggregateError([value, cleanup]) },
          );
        }
      } else if (driverConnectReturned) {
        const disconnect = captureRejectedSessionDisconnect(returnedSession);
        if (disconnect) {
          const rejected: RejectedSessionTeardown = { driverId: driver.driverId, disconnect };
          this.#rejectedSessionTeardown = rejected;
          try {
            await rejected.disconnect();
            if (this.#rejectedSessionTeardown === rejected) this.#rejectedSessionTeardown = undefined;
          }
          catch (cleanup) {
            throw new InstrumentManagerError('driver-contract', `${message(value)}. Invalid-session cleanup also failed: ${message(cleanup)}`, { cause: new AggregateError([value, cleanup]) });
          }
        } else {
          // Never retain an impossible closure. The driver's required pending
          // cleanup hook is now the only valid owner, and reconnect remains
          // blocked until atomic disconnect runs that hook successfully.
          this.#pendingDriverCleanupBarrier = driver.driverId;
        }
      } else {
        // A driver owns every resource opened before connect() returns. Invoke
        // its idempotent hook immediately; only a failed cleanup creates the
        // explicit barrier that blocks reconnect and is exposed to the host.
        try { await driver.cleanupPendingConnection(); }
        catch (cleanup) {
          this.#pendingDriverCleanupBarrier = driver.driverId;
          throw new InstrumentManagerError(
            'driver-failure',
            `${message(value)}. Failed-connect cleanup also failed: ${message(cleanup)}`,
            { cause: new AggregateError([value, cleanup]) },
          );
        }
      }
      throw asManagerError(value, value instanceof InstrumentDriverContractError ? 'driver-contract' : 'driver-failure', `Driver ${driver.driverId} could not open the selected candidate`);
    }
  }

  async #cleanupUnannouncedSession(active: ActiveSession): Promise<void> {
    const failures: unknown[] = [];
    let rfOutputOffAcknowledged = true;
    if (active.capabilities.features.some((feature) => feature.kind === 'rf-generator')) {
      const request = { kind: 'rf-generator', action: 'set-output', enabled: false } as const;
      const command = instrumentFeatureCommandSchema.parse({ ...request, sessionId: active.session.sessionId });
      this.#setRfOutput(active, 'unknown');
      const faultRevision = active.faultRevision;
      try {
        const result = instrumentFeatureResultSchema.parse(await active.session.executeFeature(command));
        assertFeatureResult(result, request, active);
        this.#assertPostAwaitState(active, faultRevision, true);
        this.#setRfOutput(active, 'off');
      } catch (error) {
        rfOutputOffAcknowledged = false;
        failures.push(asManagerError(error, 'driver-contract', 'Rejected session did not acknowledge RF output-off'));
      }
    }

    // Do not trade an invalid session for an unowned RF hazard. The retained
    // session is faulted and teardown-only, so a later disconnect attempt can
    // retry the sole admitted operation: acknowledged output-off.
    if (!rfOutputOffAcknowledged) {
      this.#faultActive(active, failures[0] instanceof Error ? failures[0] : new Error('Rejected session RF output-off was not acknowledged'), false);
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, 'Rejected session RF-safe cleanup failed');
    }

    let disconnected = false;
    try {
      await active.session.disconnect();
      disconnected = true;
    } catch (error) {
      failures.push(asManagerError(error, 'driver-failure', `Driver ${active.driver.driverId} rejected-session disconnect failed`));
    }

    if (disconnected) {
      try { active.unsubscribe(); }
      catch (error) { failures.push(asManagerError(error, 'driver-contract', `Driver ${active.driver.driverId} rejected-session event unsubscription failed`)); }
      if (this.#active === active) this.#active = undefined;
    } else {
      this.#faultActive(active, failures[0] instanceof Error ? failures[0] : new Error('Rejected session cleanup failed'), false);
    }

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Rejected session cleanup encountered multiple failures');
  }

  async #configure(configurationValue: InstrumentConfiguration): Promise<InstrumentConfigurationState> {
    const active = this.#requireOperationalActive();
    const admissionFaultRevision = active.faultRevision;
    const configuration = instrumentConfigurationSchema.parse(configurationValue);
    // Schema parsing crosses an untrusted caller boundary and can invoke
    // accessors. A getter may synchronously deliver a terminal driver event;
    // never dispatch a command after that causal fault/ownership change.
    this.#assertPostAwaitState(active, admissionFaultRevision);
    requireCapability(active, configuration);
    const configurationRevision = this.#opaqueId('configuration');
    const command = deepFreeze(instrumentConfigurationCommandSchema.parse({
      sessionId: active.session.sessionId,
      configurationRevision,
      configuration,
    }));
    this.#assertPostAwaitState(active, admissionFaultRevision);
    // A failed reconfiguration leaves the acquisition state unknown. Never
    // continue acquiring against the prior revision by assumption.
    this.#invalidateConfiguration(active);
    const changesRfMode = active.rfOutput !== 'not-supported';
    if (changesRfMode) {
      this.#setRfOutput(active, 'unknown');
      this.#emit({ type: 'session-state', reason: 'rf-output-changed', session: this.#snapshot(active) });
    }
    const faultRevision = active.faultRevision;
    const receiveOnlySafetyBefore = active.receiveOnlySafety;
    try {
      const dispatch = instrumentConfigurationCommandSchema.parse(structuredClone(command));
      await active.session.configure(dispatch);
      this.#assertPostAwaitState(active, faultRevision);
      if (changesRfMode) {
        await this.#acknowledgeRfOutputOff(
          active,
          `Driver ${active.driver.driverId} did not acknowledge RF output-off after configuration`,
        );
      }
      if (receiveOnlySafetyBefore) {
        active.receiveOnlySafety = advanceReceiveOnlySafety(
          active,
          receiveOnlySafetyBefore,
          'analyzer-configuration',
        );
        this.#emit({
          type: 'session-state',
          reason: 'receive-only-safety-advanced',
          session: this.#snapshot(active),
        });
      } else if (active.session.receiveOnlySafety !== undefined) {
        throw new InstrumentDriverContractError('Driver introduced receive-only safety state after session admission');
      }
    }
    catch (value) {
      const failure = asManagerError(value, 'driver-failure', `Driver ${active.driver.driverId} configuration failed`);
      if (changesRfMode) this.#faultActive(active, failure);
      throw failure;
    }
    const admittedCommand = instrumentConfigurationCommandSchema.parse(structuredClone(command));
    requireCapability(active, admittedCommand.configuration);
    const state = deepFreeze(instrumentConfigurationStateSchema.parse({ ...admittedCommand, configuredAt: this.#timestamp() }));
    active.configuration = state;
    this.#resetMeasurementState(active);
    this.#emit({ type: 'configured', configuration: state });
    if (changesRfMode) {
      this.#emit({ type: 'session-state', reason: 'rf-output-changed', session: this.#snapshot(active) });
    }
    return state;
  }

  async #acquire(): Promise<InstrumentMeasurement> {
    const active = this.#requireOperationalActive();
    const configuration = active.configuration;
    if (!configuration) throw new InstrumentManagerError('not-configured', 'Instrument session has no admitted configuration revision');
    if (active.rfOutput === 'on' || active.rfOutput === 'unknown') {
      throw new InstrumentManagerError('driver-failure', `Acquisition is blocked while RF output is ${active.rfOutput}`);
    }
    await this.#reassertRfOff(active);
    if (active.acquisition) throw new InstrumentManagerError('driver-contract', 'Driver acquisition re-entered an active measurement transaction');
    const acquisition: NonNullable<ActiveSession['acquisition']> = {};
    active.acquisition = acquisition;
    const faultRevision = active.faultRevision;
    const receiveOnlySafetyBefore = active.receiveOnlySafety;
    let value: unknown;
    try {
      try { value = await active.session.acquire(); }
      catch (error) {
        if (active.fault) throw faultedSessionError(active);
        throw asManagerError(error, 'driver-failure', `Driver ${active.driver.driverId} acquisition failed`);
      }
      let measurement: InstrumentMeasurement;
      try { measurement = instrumentMeasurementSchema.parse(value); }
      catch (error) { throw asManagerError(error, 'driver-contract', `Driver ${active.driver.driverId} returned an invalid measurement`); }
      assertMeasurementBinding(measurement, active, configuration);
      if (receiveOnlySafetyBefore) {
        const receiveOnlySafetyAfter = advanceReceiveOnlySafety(
          active,
          receiveOnlySafetyBefore,
          'pre-acquisition',
        );
        if (!structuralEqual(measurement.receiveOnlySafetyReceipt, receiveOnlySafetyAfter.currentReceipt)) {
          throw new InstrumentManagerError(
            'driver-contract',
            'Measurement receive-only safety receipt does not match the current post-acquisition driver receipt',
          );
        }
        active.receiveOnlySafety = receiveOnlySafetyAfter;
        this.#emit({
          type: 'session-state',
          reason: 'receive-only-safety-advanced',
          session: this.#snapshot(active),
        });
      } else if (active.session.receiveOnlySafety !== undefined) {
        throw new InstrumentManagerError('driver-contract', 'Driver introduced receive-only safety state after session admission');
      }
      this.#assertPostAwaitState(active, faultRevision);
      if (acquisition.eventSequence !== undefined && acquisition.eventSequence !== measurement.sequence) {
        const failure = new InstrumentManagerError('driver-contract', 'Driver measurement event and acquisition return disagree');
        this.#faultActive(active, failure);
        throw failure;
      }
      this.#admitReturnedMeasurement(active, measurement, acquisition.eventSequence !== undefined);
      this.#emit({ type: 'measurement', measurement });
      return measurement;
    } catch (error) {
      if (error instanceof InstrumentManagerError && error.code === 'driver-contract' && !active.fault) {
        this.#faultActive(active, error);
      }
      throw error;
    } finally {
      if (active.acquisition === acquisition) active.acquisition = undefined;
    }
  }

  async #executeFeature(requestValue: InstrumentFeatureRequest): Promise<InstrumentFeatureResult> {
    const active = this.#requireActive();
    const receiveOnlySafetyBefore = active.receiveOnlySafety;
    const request = instrumentFeatureRequestSchema.parse(requestValue);
    const safeFaultedTeardown = request.kind === 'rf-generator'
      && request.action === 'set-output'
      && request.enabled === false;
    if (active.fault && !safeFaultedTeardown) throw faultedSessionError(active);
    const safeRfRecovery = request.kind === 'rf-generator'
      && (request.action === 'configure' || request.enabled === false);
    if ((active.rfOutput === 'on' || active.rfOutput === 'unknown') && !safeRfRecovery) {
      throw new InstrumentManagerError('driver-failure', `Feature ${request.kind}/${request.action} is blocked while RF output is ${active.rfOutput}`);
    }
    requireFeatureCapability(active, request);
    const command = instrumentFeatureCommandSchema.parse({ ...request, sessionId: active.session.sessionId });
    const invalidationReason = request.kind === 'signal-lab-profile-selection'
      ? request.action === 'select-profile'
        ? 'source-profile-changed' as const
        : 'source-channel-changed' as const
      : (request.kind === 'rf-generator' && request.action === 'configure') || request.kind === 'touch'
        ? 'instrument-mode-changed' as const
        : undefined;
    const previousProducerEpoch = active.producerConfigurationEpoch;
    if (invalidationReason) this.#invalidateConfiguration(active);
    const changesRfState = request.kind === 'rf-generator'
      || (request.kind === 'touch' && active.rfOutput !== 'not-supported');
    if (changesRfState) {
      this.#setRfOutput(active, 'unknown');
      this.#emit({ type: 'session-state', reason: 'rf-output-changed', session: this.#snapshot(active) });
    }
    const faultRevision = active.faultRevision;
    let value: unknown;
    try {
      value = await active.session.executeFeature(command);
      this.#assertPostAwaitState(active, faultRevision, safeFaultedTeardown);
    }
    catch (error) {
      const failure = asManagerError(error, 'driver-failure', `Driver ${active.driver.driverId} feature ${request.kind}/${request.action} failed`);
      if (invalidationReason || changesRfState) this.#faultActive(active, failure);
      throw failure;
    }
    let result: InstrumentFeatureResult;
    try {
      result = instrumentFeatureResultSchema.parse(value);
      assertFeatureResult(result, request, active);
      // Parsing is also an untrusted driver boundary and may invoke accessors.
      // Recheck before committing any authoritative post-command state.
      this.#assertPostAwaitState(active, faultRevision, safeFaultedTeardown);
      if (request.kind === 'signal-lab-profile-selection') {
        if (result.kind !== 'signal-lab-profile-selection'
          || previousProducerEpoch === undefined
          || result.producerConfigurationEpoch === previousProducerEpoch) {
          throw new InstrumentManagerError('driver-contract', 'SignalLab source mutation did not advance its producer configuration epoch');
        }
        active.producerConfigurationEpoch = result.producerConfigurationEpoch;
        active.capabilities = request.action === 'select-profile'
          ? withSelectedSignalLabProfile(active.capabilities, request.profileId)
          : withSignalLabChannel(active.capabilities, request.channel);
      } else if (request.kind === 'rf-generator') {
        if (request.action === 'configure') {
          await this.#acknowledgeRfOutputOff(
            active,
            `Driver ${active.driver.driverId} did not acknowledge RF output-off after generator configuration`,
          );
        } else {
          this.#setRfOutput(active, request.enabled ? 'on' : 'off');
        }
      }
      if (receiveOnlySafetyBefore) {
        const observed = active.session.receiveOnlySafety;
        if (!observed) {
          throw new InstrumentManagerError('driver-contract', 'Driver withdrew receive-only safety state during a feature operation');
        }
        if (!structuralEqual(observed, receiveOnlySafetyBefore)) {
          if (request.kind !== 'touch') {
            throw new InstrumentManagerError('driver-contract', 'Driver advanced receive-only safety state for an unrelated feature');
          }
          active.receiveOnlySafety = advanceReceiveOnlySafety(
            active,
            receiveOnlySafetyBefore,
            'post-interaction-recovery',
          );
          this.#emit({
            type: 'session-state',
            reason: 'receive-only-safety-advanced',
            session: this.#snapshot(active),
          });
        }
      } else if (active.session.receiveOnlySafety !== undefined) {
        throw new InstrumentManagerError('driver-contract', 'Driver introduced receive-only safety state during a feature operation');
      }
    } catch (error) {
      const failure = asManagerError(error, 'driver-contract', `Driver ${active.driver.driverId} returned an invalid feature result`);
      if (invalidationReason || changesRfState) this.#faultActive(active, failure);
      throw failure;
    }
    this.#emit({ type: 'feature-result', result, session: this.#snapshot(active) });
    if (invalidationReason) {
      this.#emit({
        type: 'configuration-invalidated',
        sessionId: active.session.sessionId,
        reason: invalidationReason,
        session: this.#snapshot(active),
      });
    }
    return result;
  }

  async #disconnect(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    if (active.capabilities.features.some((feature) => feature.kind === 'rf-generator')) {
      // An RF-capable session is never closed by assumption. Require the
      // driver to acknowledge output-off before releasing the session.
      await this.#executeFeature({ kind: 'rf-generator', action: 'set-output', enabled: false });
    }
    try { await active.session.disconnect(); }
    catch (value) {
      const failure = asManagerError(value, 'driver-failure', `Driver ${active.driver.driverId} disconnect failed`);
      // A rejected disconnect has an uncertain transport/session state. Keep
      // the session visible for another teardown attempt, but never permit it
      // to resume normal configuration or acquisition.
      this.#faultActive(active, failure);
      throw failure;
    }
    let unsubscribeFailure: unknown;
    try { active.unsubscribe(); }
    catch (error) {
      unsubscribeFailure = error;
      // Transport ownership is already closed, but the exact event lease is
      // still live. Retain that closure as session teardown work; a driver's
      // pre-session cleanup hook does not own it and may legitimately no-op.
      // Reconnect remains blocked until this same unsubscribe succeeds.
      this.#rejectedSessionTeardown = {
        driverId: active.driver.driverId,
        disconnect: async () => { active.unsubscribe(); },
      };
    }
    if (this.#active === active) this.#active = undefined;
    this.#emit({ type: 'disconnected', sessionId: active.session.sessionId, driverId: active.driver.driverId });
    if (unsubscribeFailure !== undefined) {
      throw asManagerError(unsubscribeFailure, 'driver-contract', `Driver ${active.driver.driverId} event unsubscription failed after disconnect`);
    }
  }

  async #cleanupPendingConnections(): Promise<void> {
    if (this.#active) {
      throw new InstrumentManagerError(
        'session-active',
        'Pending connection cleanup requires the admitted instrument session to disconnect first',
      );
    }
    const failures: { driverId: InstrumentDriver['driverId']; error: Error }[] = [];
    for (const driver of this.registry.list()) {
      try { await driver.cleanupPendingConnection(); }
      catch (value) {
        failures.push({
          driverId: driver.driverId,
          error: asManagerError(
            value,
            'driver-failure',
            `Driver ${driver.driverId} pending connection cleanup failed`,
          ),
        });
      }
    }
    if (failures.length > 0) this.#pendingDriverCleanupBarrier = failures[0]!.driverId;
    if (failures.length === 1) throw failures[0]!.error;
    if (failures.length > 1) {
      throw new InstrumentManagerError(
        'driver-failure',
        'Multiple instrument drivers retained connections that could not be cleaned',
        { cause: new AggregateError(failures.map((failure) => failure.error)) },
      );
    }
    this.#pendingDriverCleanupBarrier = undefined;
  }

  async #cleanupRejectedSession(): Promise<void> {
    const rejected = this.#rejectedSessionTeardown;
    if (!rejected) return;
    try { await rejected.disconnect(); }
    catch (value) {
      throw asManagerError(
        value,
        'driver-failure',
        `Driver ${rejected.driverId} rejected-session teardown retry failed`,
      );
    }
    if (this.#rejectedSessionTeardown === rejected) this.#rejectedSessionTeardown = undefined;
  }

  #requireActive(): ActiveSession {
    if (!this.#active) throw new InstrumentManagerError('no-session', 'No instrument session is active');
    return this.#active;
  }

  #requireOperationalActive(): ActiveSession {
    const active = this.#requireActive();
    if (active.fault) throw faultedSessionError(active);
    return active;
  }

  #snapshot(active: ActiveSession): InstrumentSessionSnapshot {
    const provenance = active.session.provenance.sourceKind === 'signal-lab'
      ? {
        ...active.session.provenance,
        producerConfigurationEpoch: active.producerConfigurationEpoch,
      }
      : active.session.provenance;
    return instrumentSessionSnapshotSchema.parse({
      sessionId: active.session.sessionId,
      driverId: active.driver.driverId,
      candidate: active.session.candidate,
      provenance,
      capabilities: active.capabilities,
      rfOutput: active.rfOutput,
      rfOutputQualification: active.rfOutputQualification,
      ...(active.receiveOnlySafety ? { receiveOnlySafety: active.receiveOnlySafety } : {}),
      ...(active.fault ? { fault: active.fault } : {}),
      ...(active.configuration ? { configuration: active.configuration } : {}),
    });
  }

  #forward(active: ActiveSession, value: InstrumentSessionEvent, publish = true): InstrumentSessionEvent | undefined {
    if (this.#active !== active) return;
    try {
      const event = parseInstrumentSessionEvent(value);
      const sessionId = event.type === 'measurement' ? event.measurement.sessionId : event.sessionId;
      if (sessionId !== active.session.sessionId) throw new InstrumentDriverContractError('Driver event session ID does not match the active session');
      if (active.fault && event.type === 'measurement') {
        throw new InstrumentDriverContractError('Driver emitted a measurement after the session faulted');
      }
      if (event.type === 'measurement') {
        if (!active.configuration) throw new InstrumentDriverContractError('Driver emitted a measurement without an admitted configuration');
        assertMeasurementBinding(event.measurement, active, active.configuration);
        const acquisition = active.acquisition;
        if (acquisition) {
          if (acquisition.eventSequence !== undefined) throw new InstrumentDriverContractError('Driver emitted more than one measurement for one acquisition');
          acquisition.eventSequence = event.measurement.sequence;
          return undefined;
        }
        // A late event may reconcile only against the most recently returned
        // measurement, exactly once. Sequences are positive, so the initial
        // sentinel 0 can never admit an event before the first return.
        if (event.measurement.sequence !== active.lastMeasurementSequence) {
          throw new InstrumentDriverContractError('Driver emitted a measurement outside an acquisition transaction');
        }
        if (active.lastMeasurementEventDelivered) throw new InstrumentDriverContractError('Driver repeated a measurement event');
        active.lastMeasurementEventDelivered = true;
        return undefined;
      } else if (event.type === 'status' && event.status === 'faulted') {
        this.#faultActive(active, {
          code: 'session-fault',
          message: event.message ?? 'Instrument session reported a terminal fault',
          recoverable: false,
        }, false);
      } else if (event.type === 'error' && !event.error.recoverable) {
        this.#faultActive(active, event.error, false);
      }
      if (publish) {
        this.#publishForwardedEvent(active, event);
      }
      return event;
    } catch (value) {
      const error = { code: 'driver-contract' as const, message: message(value), recoverable: false };
      this.#faultActive(active, error, publish);
      return undefined;
    }
  }

  #publishForwardedEvent(active: ActiveSession, event: InstrumentSessionEvent): void {
    this.#emit(event);
    if ((event.type === 'status' && event.status === 'faulted')
      || (event.type === 'error' && !event.error.recoverable)) {
      this.#emit({ type: 'session-state', reason: 'session-faulted', session: this.#snapshot(active) });
    }
  }

  #invalidateConfiguration(active: ActiveSession): void {
    active.configuration = undefined;
    this.#resetMeasurementState(active);
  }

  #resetMeasurementState(active: ActiveSession): void {
    active.lastMeasurementSequence = 0;
    active.lastMeasurementEventDelivered = true;
    active.acquisition = undefined;
  }

  #admitReturnedMeasurement(
    active: ActiveSession,
    measurement: InstrumentMeasurement,
    hasEvent: boolean,
  ): void {
    if (measurement.sequence === active.lastMeasurementSequence) {
      throw new InstrumentManagerError('driver-contract', `Measurement sequence ${measurement.sequence} was returned more than once`);
    }
    if (measurement.sequence < active.lastMeasurementSequence) {
      throw new InstrumentManagerError('driver-contract', `Measurement sequence ${measurement.sequence} is not newer than ${active.lastMeasurementSequence}`);
    }
    active.lastMeasurementSequence = measurement.sequence;
    active.lastMeasurementEventDelivered = hasEvent;
  }

  #faultActive(active: ActiveSession, error: InstrumentError | Error, emit = true): void {
    this.#invalidateConfiguration(active);
    if (active.rfOutput !== 'not-supported') this.#setRfOutput(active, 'unknown');
    active.faultRevision++;
    if (active.fault) return;
    const admitted: InstrumentError = error instanceof InstrumentManagerError
      && (error.code === 'driver-contract' || error.code === 'driver-failure')
      ? { code: error.code, message: message(error.message), recoverable: false }
      : error instanceof InstrumentDriverContractError
        ? { code: 'driver-contract', message: message(error.message), recoverable: false }
      : 'code' in error
        && (error.code === 'driver-contract' || error.code === 'driver-failure' || error.code === 'session-fault')
        && 'recoverable' in error
        ? { code: error.code, message: message(error.message), recoverable: false }
        : { code: 'session-fault', message: message(error), recoverable: false };
    active.fault = admitted;
    if (!emit) return;
    this.#emit({ type: 'status', sessionId: active.session.sessionId, status: 'faulted', message: admitted.message });
    this.#emit({ type: 'error', sessionId: active.session.sessionId, error: admitted });
    this.#emit({ type: 'session-state', reason: 'session-faulted', session: this.#snapshot(active) });
  }

  #setRfOutput(active: ActiveSession, state: InstrumentRfOutputState): void {
    active.rfOutput = state;
    active.rfOutputQualification = rfOutputQualification(active.session.provenance.sourceKind, state);
  }

  async #acknowledgeRfOutputOff(active: ActiveSession, context: string): Promise<void> {
    const request = { kind: 'rf-generator', action: 'set-output', enabled: false } as const;
    const command = instrumentFeatureCommandSchema.parse({ ...request, sessionId: active.session.sessionId });
    const faultRevision = active.faultRevision;
    let value: unknown;
    try {
      value = await active.session.executeFeature(command);
      this.#assertPostAwaitState(active, faultRevision);
    } catch (error) {
      throw asManagerError(error, 'driver-failure', context);
    }
    try {
      const result = instrumentFeatureResultSchema.parse(value);
      assertFeatureResult(result, request, active);
      // Parsing untrusted driver output can invoke accessors. Recheck session
      // ownership/fault state before the acknowledgement becomes RF truth.
      this.#assertPostAwaitState(active, faultRevision);
    } catch (error) {
      throw asManagerError(error, 'driver-contract', `${context}: invalid output-off result`);
    }
    this.#setRfOutput(active, 'off');
  }

  async #reassertRfOff(active: ActiveSession): Promise<void> {
    if (active.rfOutput === 'not-supported') return;
    this.#setRfOutput(active, 'unknown');
    this.#emit({ type: 'session-state', reason: 'rf-output-changed', session: this.#snapshot(active) });
    try {
      await this.#acknowledgeRfOutputOff(
        active,
        `Driver ${active.driver.driverId} could not reassert RF output-off before acquisition`,
      );
      this.#emit({ type: 'session-state', reason: 'rf-output-changed', session: this.#snapshot(active) });
    } catch (error) {
      const failure = asManagerError(error, 'driver-failure', `Driver ${active.driver.driverId} could not reassert RF output-off before acquisition`);
      this.#faultActive(active, failure);
      throw failure;
    }
  }

  #assertPostAwaitState(active: ActiveSession, faultRevision: number, allowExistingFault = false): void {
    if (this.#active !== active) {
      throw new InstrumentManagerError('driver-contract', 'Instrument session ownership changed while a driver operation was in flight');
    }
    if (active.faultRevision !== faultRevision || (active.fault && !allowExistingFault)) {
      throw faultedSessionError(active);
    }
  }

  #emit(value: InstrumentManagerEvent): void {
    const event = instrumentManagerEventSchema.parse(value);
    for (const listener of [...this.#listeners]) {
      try { listener(structuredClone(event)); }
      catch { /* A consumer cannot corrupt manager or driver lifecycle. */ }
    }
  }

  #serializeSessionOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#disconnectOperation) {
      return Promise.reject(new InstrumentManagerError(
        'operation-canceled',
        'Instrument session operation is unavailable while disconnect is pending',
      ));
    }
    const admittedEpoch = this.#connectionEpoch;
    return this.#serialize(async () => {
      if (this.#connectionEpoch !== admittedEpoch) {
        throw new InstrumentManagerError(
          'operation-canceled',
          'Instrument session operation was canceled by disconnect',
        );
      }
      return operation();
    });
  }

  #serialize<T>(operation: () => Promise<T>, admission: 'normal' | 'teardown' = 'normal'): Promise<T> {
    // The renderer IPC layer has its own smaller global admission limit, but
    // InstrumentManager is also a public driver-layer boundary. Keep its
    // retention bounded for future in-process callers such as NeptuneSDR.
    if (admission === 'normal' && this.#pendingOperations >= MAX_PENDING_MANAGER_OPERATIONS) {
      return Promise.reject(new InstrumentManagerError(
        'admission-limit',
        `Instrument manager admission limit of ${MAX_PENDING_MANAGER_OPERATIONS} pending operations was reached`,
      ));
    }
    // One separately bounded slot means RF-safe teardown cannot be crowded
    // out by a full normal queue. Repeated disconnect calls share one promise.
    if (admission === 'teardown' && this.#pendingTeardownOperations >= 1) {
      return Promise.reject(new InstrumentManagerError('admission-limit', 'Instrument manager teardown is already pending'));
    }
    if (admission === 'normal') this.#pendingOperations++;
    else this.#pendingTeardownOperations++;
    return new Promise<T>((resolve, reject) => {
      const scheduled: ScheduledManagerOperation = {
        operation,
        resolve: (value) => resolve(value as T),
        reject,
        admission,
      };
      if (admission === 'teardown') this.#teardownOperation = scheduled;
      else this.#normalOperations.push(scheduled);
      this.#drainOperations();
    });
  }

  #drainOperations(): void {
    if (this.#operationRunning) return;
    const scheduled = this.#teardownOperation ?? this.#normalOperations.shift();
    if (!scheduled) return;
    if (this.#teardownOperation === scheduled) this.#teardownOperation = undefined;
    this.#operationRunning = true;
    void Promise.resolve().then(scheduled.operation).then(
      (value) => this.#settleOperation(scheduled, true, value),
      (reason: unknown) => this.#settleOperation(scheduled, false, reason),
    );
  }

  #settleOperation(scheduled: ScheduledManagerOperation, succeeded: boolean, value: unknown): void {
    if (scheduled.admission === 'normal') this.#pendingOperations--;
    else this.#pendingTeardownOperations--;
    this.#operationRunning = false;
    if (succeeded) scheduled.resolve(value);
    else scheduled.reject(value);
    this.#drainOperations();
  }

  #timestamp(): string { return instrumentTimestampSchema.parse(this.runtime.now().toISOString()); }
  #opaqueId(scope: 'discovery' | 'configuration'): string {
    try { return instrumentOpaqueIdSchema.parse(this.runtime.opaqueId(scope)); }
    catch (error) { throw new InstrumentManagerError('driver-contract', `Runtime returned an invalid ${scope} revision`, { cause: error }); }
  }
}

function requireCapability(active: ActiveSession, configuration: InstrumentConfiguration): void {
  const issue = instrumentConfigurationCapabilityBindingIssues(configuration, active.capabilities)[0];
  if (issue) {
    throw new InstrumentManagerError(
      'unsupported-capability',
      `${issue.path.join('.')} ${issue.message}`,
    );
  }
}

function requireFeatureCapability(active: ActiveSession, request: InstrumentFeatureRequest): void {
  const capability = active.capabilities.features.find((candidate) => candidate.kind === request.kind);
  if (!capability) throw new InstrumentManagerError('unsupported-capability', `Instrument does not support ${request.kind}`);
  if (request.kind === 'rf-generator') {
    if (capability.kind !== 'rf-generator') throw new InstrumentManagerError('driver-contract', 'RF generator capability lookup was inconsistent');
    if (request.action === 'configure') {
      const path = capability.paths.find((candidate) => candidate.path === request.path);
      if (!path) throw new InstrumentManagerError('unsupported-capability', `RF generator path ${request.path} is not advertised`);
      requireRange(request.frequencyHz, path.frequencyHz, `RF generator ${request.path} frequency`);
      requireRange(request.levelDbm, capability.levelDbm, 'RF generator level');
      if (request.modulation.mode === 'am') {
        const am = capability.modulation.am;
        if (!am) throw new InstrumentManagerError('unsupported-capability', 'RF generator does not advertise AM');
        requireRange(request.modulation.modulationFrequencyHz, am.modulationFrequencyHz, 'AM modulation frequency');
        requireRange(request.modulation.depthPercent, am.depthPercent, 'AM depth');
      } else if (request.modulation.mode === 'fm') {
        const fm = capability.modulation.fm;
        if (!fm) throw new InstrumentManagerError('unsupported-capability', 'RF generator does not advertise FM');
        requireRange(request.modulation.modulationFrequencyHz, fm.modulationFrequencyHz, 'FM modulation frequency');
        requireRange(request.modulation.deviationHz, fm.deviationHz, 'FM deviation');
      }
    }
  } else if (request.kind === 'screen') {
    if (capability.kind !== 'screen') throw new InstrumentManagerError('driver-contract', 'Screen capability lookup was inconsistent');
  } else if (request.kind === 'touch') {
    if (capability.kind !== 'touch') throw new InstrumentManagerError('driver-contract', 'Touch capability lookup was inconsistent');
    if (request.x >= capability.width || request.y >= capability.height) {
      throw new InstrumentManagerError('unsupported-capability', `Touch coordinate (${request.x}, ${request.y}) is outside the advertised surface`);
    }
  } else if (request.kind === 'diagnostics') {
    if (capability.kind !== 'diagnostics') throw new InstrumentManagerError('driver-contract', 'Diagnostics capability lookup was inconsistent');
    if (!capability.reports.includes(request.report)) {
      throw new InstrumentManagerError('unsupported-capability', `Diagnostic report ${request.report} is not advertised`);
    }
  } else {
    if (capability.kind !== 'signal-lab-profile-selection') {
      throw new InstrumentManagerError('driver-contract', 'SignalLab profile capability lookup was inconsistent');
    }
    if (active.session.candidate.sourceKind !== 'signal-lab') {
      throw new InstrumentManagerError('driver-contract', 'SignalLab profile selection is bound to a non-SignalLab candidate');
    }
    if (request.action === 'select-profile'
      && !capability.profiles.some((profile) => profile.profileId === request.profileId)) {
      throw new InstrumentManagerError('unsupported-capability', `SignalLab profile ${request.profileId} is not advertised`);
    }
    if (request.action === 'configure-channel' && capability.channel === undefined) {
      throw new InstrumentManagerError('unsupported-capability', 'SignalLab channel configuration is not advertised');
    }
  }
}

function withSelectedSignalLabProfile(
  capabilities: InstrumentCapabilities,
  profileId: string,
): InstrumentCapabilities {
  let updated = false;
  const features = capabilities.features.map((feature) => {
    if (feature.kind !== 'signal-lab-profile-selection') return feature;
    if (!feature.profiles.some((profile) => profile.profileId === profileId)) {
      throw new InstrumentManagerError('driver-contract', `Selected SignalLab profile ${profileId} disappeared from capabilities`);
    }
    updated = true;
    return { ...feature, selectedProfileId: profileId };
  });
  if (!updated) throw new InstrumentManagerError('driver-contract', 'SignalLab profile result has no matching capability');
  return instrumentCapabilitiesSchema.parse({ ...capabilities, features });
}

function withSignalLabChannel(
  capabilities: InstrumentCapabilities,
  channel: Extract<InstrumentFeatureRequest, { kind: 'signal-lab-profile-selection'; action: 'configure-channel' }>['channel'],
): InstrumentCapabilities {
  let updated = false;
  const features = capabilities.features.map((feature) => {
    if (feature.kind !== 'signal-lab-profile-selection') return feature;
    if (feature.channel === undefined) {
      throw new InstrumentManagerError('driver-contract', 'SignalLab channel result has no matching capability');
    }
    updated = true;
    return { ...feature, channel };
  });
  if (!updated) throw new InstrumentManagerError('driver-contract', 'SignalLab channel result has no matching capability');
  return instrumentCapabilitiesSchema.parse({ ...capabilities, features });
}

function requireRange(value: number, range: { min: number; max: number; step?: number }, label: string): void {
  const stepOffset = range.step === undefined ? 0 : (value - range.min) / range.step;
  const missesStep = range.step !== undefined
    && Math.abs(stepOffset - Math.round(stepOffset)) > Number.EPSILON * Math.max(8, Math.abs(stepOffset) * 8);
  if (value < range.min || value > range.max || missesStep) {
    throw new InstrumentManagerError('unsupported-capability', `${label} ${value} is outside the advertised capability`);
  }
}

function deepFreeze<Value>(value: Value): Value {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}

function advanceReceiveOnlySafety(
  active: ActiveSession,
  previous: InstrumentReceiveOnlySafetyState,
  expectedReason: InstrumentReceiveOnlySafetyState['currentReceipt']['reason'],
): InstrumentReceiveOnlySafetyState {
  let current: InstrumentReceiveOnlySafetyState | undefined;
  try { current = active.session.receiveOnlySafety; }
  catch (error) {
    throw new InstrumentManagerError(
      'driver-contract',
      `Driver ${active.driver.driverId} exposed invalid receive-only safety state`,
      { cause: error },
    );
  }
  if (!current) {
    throw new InstrumentManagerError('driver-contract', 'Driver withdrew receive-only safety state during an active physical session');
  }
  if (!structuralEqual(current.connectionReceipt, previous.connectionReceipt)) {
    throw new InstrumentManagerError('driver-contract', 'Driver rewrote its receive-only connection receipt');
  }
  if (current.currentReceipt.sessionId !== active.session.sessionId) {
    throw new InstrumentManagerError('driver-contract', 'Current receive-only safety receipt belongs to another session');
  }
  if (current.currentReceipt.sequence <= previous.currentReceipt.sequence) {
    throw new InstrumentManagerError('driver-contract', 'Driver did not advance its receive-only safety receipt');
  }
  if (current.currentReceipt.receiptId === previous.currentReceipt.receiptId) {
    throw new InstrumentManagerError('driver-contract', 'Driver reused a receive-only safety receipt ID for a new sequence');
  }
  if (current.currentReceipt.reason !== expectedReason) {
    throw new InstrumentManagerError(
      'driver-contract',
      `Driver receive-only safety receipt reason must be ${expectedReason}`,
    );
  }
  return deepFreeze(structuredClone(current));
}

function assertMeasurementBinding(
  measurement: InstrumentMeasurement,
  active: ActiveSession,
  configuration: InstrumentConfigurationState,
): void {
  if (measurement.sessionId !== active.session.sessionId) throw new InstrumentManagerError('driver-contract', 'Measurement session ID does not match the active session');
  if (measurement.configurationRevision !== configuration.configurationRevision) throw new InstrumentManagerError('driver-contract', 'Measurement configuration revision does not match the active revision');
  const expectedQualification = expectedMeasurementQualification(active, measurement);
  if (measurement.qualification !== expectedQualification) {
    throw new InstrumentManagerError('driver-contract', 'Measurement qualification does not match the admitted source and measurement kind');
  }
  if (active.receiveOnlySafety) {
    const receipt = measurement.receiveOnlySafetyReceipt;
    if (!receipt) {
      throw new InstrumentManagerError('driver-contract', 'Receive-only physical measurement omitted its pre-acquisition safety receipt');
    }
    if (receipt.sessionId !== active.session.sessionId) {
      throw new InstrumentManagerError('driver-contract', 'Measurement receive-only safety receipt belongs to another session');
    }
    if (receipt.reason !== 'pre-acquisition') {
      throw new InstrumentManagerError('driver-contract', 'Measurement receive-only safety receipt is not a pre-acquisition acknowledgement');
    }
    if (receipt.sequence <= active.receiveOnlySafety.currentReceipt.sequence) {
      throw new InstrumentManagerError('driver-contract', 'Measurement receive-only safety receipt is stale');
    }
  } else if (measurement.receiveOnlySafetyReceipt !== undefined) {
    throw new InstrumentManagerError('driver-contract', 'Measurement fabricated receive-only safety evidence for a session without that state');
  }
  if (active.session.provenance.sourceKind === 'signal-lab') {
    if (active.producerConfigurationEpoch === undefined
      || measurement.producerConfigurationEpoch !== active.producerConfigurationEpoch) {
      throw new InstrumentManagerError('driver-contract', 'SignalLab measurement producer configuration epoch is stale or mismatched');
    }
    if (measurement.resolutionBandwidthHz !== null || measurement.attenuationDb !== null) {
      throw new InstrumentManagerError('driver-contract', 'SignalLab measurements must not claim physical RBW or attenuation readback');
    }
  } else if (measurement.producerConfigurationEpoch !== undefined) {
    throw new InstrumentManagerError('driver-contract', 'Non-SignalLab measurement claimed a producer configuration epoch');
  } else if ((measurement.kind === 'swept-spectrum' || measurement.kind === 'detected-power-timeseries')
    && (measurement.resolutionBandwidthHz === null || measurement.attenuationDb === null)) {
    throw new InstrumentManagerError('driver-contract', 'TinySA measurements require observed RBW and attenuation readback');
  }
  const requested = configuration.configuration;
  if (measurement.kind !== requested.kind) throw new InstrumentManagerError('driver-contract', 'Measurement kind does not match the active configuration');
  if (measurement.kind === 'swept-spectrum' && requested.kind === 'swept-spectrum') {
    if (measurement.frequencyHz.length !== requested.points
      || !matchesRequestedSpectrumGrid(measurement.frequencyHz, requested.startHz, requested.stopHz)) {
      throw new InstrumentManagerError('driver-contract', 'Swept-spectrum measurement does not match configured geometry');
    }
  } else if (measurement.kind === 'detected-power-timeseries' && requested.kind === 'detected-power-timeseries') {
    if (measurement.centerHz !== requested.centerHz
      || measurement.powerDbm.length !== requested.sampleCount) {
      throw new InstrumentManagerError('driver-contract', 'Detected-power measurement does not match configured geometry');
    }
    if (requested.controls.model === 'synthetic-scalar' && measurement.timingQualification !== 'simulation-exact') {
      throw new InstrumentManagerError('driver-contract', 'Synthetic detected-power measurement did not preserve its admitted simulation-exact timing qualification');
    }
    if (requested.controls.model === 'receiver' && measurement.timingQualification === 'simulation-exact') {
      throw new InstrumentManagerError('driver-contract', 'Receiver detected-power measurement falsely claimed simulation-exact timing');
    }
    if (requested.controls.model === 'synthetic-scalar'
      && measurement.sampleIntervalSeconds !== requested.sweepTimeSeconds / requested.sampleCount) {
      throw new InstrumentManagerError('driver-contract', 'Simulation-exact detected-power cadence does not match the configured interval');
    }
  } else if (measurement.kind === 'complex-iq' && requested.kind === 'complex-iq') {
    if (measurement.centerHz !== requested.centerHz
      || measurement.sampleRateHz !== requested.sampleRateHz
      || measurement.bandwidthHz !== requested.bandwidthHz
      || measurement.sampleCount !== requested.sampleCount
      || measurement.sampleFormat !== requested.sampleFormat) {
      throw new InstrumentManagerError('driver-contract', 'Complex-I/Q measurement does not match configured geometry');
    }
  }
}

function expectedMeasurementQualification(
  active: ActiveSession,
  measurement: InstrumentMeasurement,
): InstrumentMeasurement['qualification'] {
  if (active.session.provenance.sourceKind !== 'signal-lab' || measurement.kind !== 'complex-iq') {
    return active.session.provenance.qualification;
  }
  const source = active.capabilities.features.find((feature) => feature.kind === 'signal-lab-profile-selection');
  const selected = source?.kind === 'signal-lab-profile-selection'
    ? source.profiles.find((profile) => profile.profileId === source.selectedProfileId)
    : undefined;
  if (!selected || !('qualification' in selected)) {
    throw new InstrumentManagerError('driver-contract', 'SignalLab I/Q measurement has no complete admitted selected-profile qualification');
  }
  return selected.qualification === 'visual'
    ? 'analytic-complex-baseband'
    : 'standards-derived-complex-baseband';
}

function assertFeatureResult(
  result: InstrumentFeatureResult,
  request: InstrumentFeatureRequest,
  active: ActiveSession,
): void {
  if (result.sessionId !== active.session.sessionId) {
    throw new InstrumentManagerError('driver-contract', 'Feature result session ID does not match the active session');
  }
  if (request.kind === 'rf-generator' && request.action === 'configure') {
    if (result.kind !== 'rf-generator' || result.action !== 'configure'
      || !structuralEqual(result, { ...request, sessionId: active.session.sessionId })) {
      throw new InstrumentManagerError('driver-contract', 'RF generator configuration result does not match the request');
    }
  } else if (request.kind === 'rf-generator') {
    if (result.kind !== 'rf-generator' || result.action !== 'set-output'
      || !structuralEqual(result, { ...request, sessionId: active.session.sessionId })) {
      throw new InstrumentManagerError('driver-contract', 'RF generator output result does not match the request');
    }
  } else if (request.kind === 'screen') {
    const capability = active.capabilities.features.find((candidate) => candidate.kind === 'screen');
    if (result.kind !== 'screen' || capability?.kind !== 'screen'
      || result.frame.width !== capability.width
      || result.frame.height !== capability.height
      || result.frame.pixelFormat !== capability.pixelFormat) {
      throw new InstrumentManagerError('driver-contract', 'Screen result does not match the advertised frame geometry');
    }
  } else if (request.kind === 'touch') {
    if (result.kind !== 'touch' || result.x !== request.x || result.y !== request.y) {
      throw new InstrumentManagerError('driver-contract', 'Touch result does not match the request');
    }
  } else if (request.kind === 'diagnostics') {
    if (result.kind !== 'diagnostics' || result.report !== request.report) {
      throw new InstrumentManagerError('driver-contract', 'Diagnostics result does not match the request');
    }
  } else if (request.action === 'select-profile') {
    if (result.kind !== 'signal-lab-profile-selection'
      || result.action !== 'select-profile'
      || result.profileId !== request.profileId) {
      throw new InstrumentManagerError('driver-contract', 'SignalLab profile result does not match the request');
    }
  } else if (result.kind !== 'signal-lab-profile-selection'
    || result.action !== 'configure-channel'
    || !structuralEqual(result.channel, request.channel)) {
    throw new InstrumentManagerError('driver-contract', 'SignalLab channel result does not match the request');
  }
}

function captureRejectedSessionDisconnect(session: unknown): (() => Promise<void>) | undefined {
  try {
    if ((typeof session !== 'object' && typeof session !== 'function') || session === null) return undefined;
    const disconnect: unknown = Reflect.get(session as object, 'disconnect');
    if (typeof disconnect !== 'function') return undefined;
    return async () => { await Reflect.apply(disconnect, session, []); };
  } catch {
    return undefined;
  }
}

function candidateDescriptorKey(candidate: { driverId: string; sourceKind: string; candidateId: string }): string {
  return `${candidate.driverId}\u0000${candidate.sourceKind}\u0000${candidate.candidateId}`;
}

function rfOutputQualification(
  sourceKind: InstrumentSourceKind,
  state: InstrumentRfOutputState,
): InstrumentRfOutputQualification {
  if (state === 'unknown') return 'unverified';
  if (state === 'not-supported') return 'not-applicable';
  if (sourceKind === 'serial-port') return 'command-acknowledged';
  if (sourceKind === 'tinysa-firmware-twin') return 'firmware-executed-twin';
  throw new InstrumentManagerError('driver-contract', `Source ${sourceKind} cannot expose RF output state ${state}`);
}
function candidateKey(candidate: InstrumentCandidate): string { return candidateDescriptorKey(candidate); }

function matchesRequestedSpectrumGrid(
  frequencyHz: readonly number[],
  startHz: number,
  stopHz: number,
): boolean {
  if (frequencyHz.length < 2) return false;
  const spanHz = stopHz - startHz;
  const closedStepHz = spanHz / (frequencyHz.length - 1);
  const halfOpenStepHz = spanHz / frequencyHz.length;
  return matchesUniformGrid(frequencyHz, startHz, closedStepHz)
    || matchesUniformGrid(frequencyHz, startHz, halfOpenStepHz);
}

function matchesUniformGrid(
  frequencyHz: readonly number[],
  startHz: number,
  stepHz: number,
): boolean {
  const toleranceHz = Math.max(1, Math.abs(stepHz) * 1e-9);
  return Number.isFinite(stepHz)
    && stepHz > 0
    && frequencyHz.every((frequency, index) => Math.abs(frequency - (startHz + stepHz * index)) <= toleranceHz);
}

function faultedSessionError(active: ActiveSession): InstrumentManagerError {
  return new InstrumentManagerError(
    active.fault?.code === 'driver-contract' ? 'driver-contract' : 'driver-failure',
    `Instrument session ${active.session.sessionId} is faulted and must be disconnected before further operation: ${active.fault?.message ?? 'unknown fault'}`,
  );
}

function asManagerError(value: unknown, code: InstrumentManagerErrorCode, context: string): InstrumentManagerError {
  if (value instanceof InstrumentManagerError) return value;
  return new InstrumentManagerError(code, `${context}: ${message(value)}`, { cause: value });
}
function message(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return (raw.trim() || 'Unknown error').slice(0, 4_096);
}
