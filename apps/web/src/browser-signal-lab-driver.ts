import type {
  InstrumentCandidate,
  InstrumentCapabilities,
  InstrumentConfigurationCommand,
  InstrumentDriverDiscoveryResult,
  InstrumentFeatureCommand,
  InstrumentFeatureResult,
  InstrumentMeasurement,
  InstrumentReceiveOnlySafetyState,
  InstrumentRfOutputState,
  InstrumentSessionEvent,
  InstrumentSessionProvenance,
} from '@tinysa/contracts';
import type { InstrumentDriver, InstrumentSession } from '@tinysa/instrument-runtime';
import {
  BROWSER_SIGNAL_LAB_CANDIDATE_ID,
  BROWSER_SIGNAL_LAB_DRIVER_ID,
  type SignalLabWorkerFeatureExecution,
  type SignalLabWorkerMessage,
  type SignalLabWorkerRequest,
  type SignalLabWorkerSessionDescriptor,
} from './signal-lab-worker-protocol.js';

export interface SignalLabWorkerPort {
  onmessage: ((event: MessageEvent<SignalLabWorkerMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: SignalLabWorkerRequest, transfer?: readonly Transferable[]): void;
  terminate(): void;
}

export type SignalLabWorkerFactory = () => SignalLabWorkerPort;

function createSignalLabWorker(): SignalLabWorkerPort {
  return new Worker(new URL('./signal-lab-worker.ts', import.meta.url), {
    type: 'module',
    name: 'atomizer-signal-lab',
  }) as unknown as SignalLabWorkerPort;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export class BrowserSignalLabWorkerDriver implements InstrumentDriver {
  readonly driverId = BROWSER_SIGNAL_LAB_DRIVER_ID;
  readonly sourceKinds = Object.freeze(['signal-lab'] as const);
  readonly #workerFactory: SignalLabWorkerFactory;
  #worker: SignalLabWorkerPort | undefined;
  readonly #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;
  #session: BrowserSignalLabWorkerSession | undefined;
  #fatalError: Error | undefined;

  constructor(workerFactory: SignalLabWorkerFactory = createSignalLabWorker) {
    this.#workerFactory = workerFactory;
    this.#startWorker();
  }

  async discover(): Promise<InstrumentDriverDiscoveryResult> {
    // Discovery has no remote session ownership. If a prior idle/discovery
    // Worker generation died, acknowledge its terminated state here so a
    // normal refresh can recreate the source without requiring a page reload.
    if (!this.#session) this.#acknowledgeTerminatedWorker();
    return this.#request('discover');
  }

  async connect(candidate: InstrumentCandidate): Promise<InstrumentSession> {
    if (this.#session) throw new Error('SignalLab worker already has an active session');
    const descriptor = await this.#request<SignalLabWorkerSessionDescriptor>('connect', candidate);
    const session = new BrowserSignalLabWorkerSession(this, descriptor);
    this.#session = session;
    return session;
  }

  async cleanupPendingConnection(): Promise<void> {
    // A fatal Worker event synchronously terminates the sole transport owner,
    // so there is no remote connection left to clean up. Acknowledge that
    // locally and create a replacement lazily on the next real request.
    if (this.#acknowledgeTerminatedWorker()) return;
    try {
      await this.#request('cleanup-pending-connection');
    } catch (value) {
      if (this.#acknowledgeTerminatedWorker()) return;
      throw value;
    }
  }

  configure(command: InstrumentConfigurationCommand): Promise<void> {
    return this.#request('configure', command);
  }

  acquire(): Promise<InstrumentMeasurement> {
    return this.#request('acquire');
  }

  async executeFeature(command: InstrumentFeatureCommand): Promise<SignalLabWorkerFeatureExecution> {
    return this.#request('execute-feature', command);
  }

  async disconnect(session: BrowserSignalLabWorkerSession): Promise<void> {
    if (this.#session !== session) return;
    if (this.#acknowledgeTerminatedWorker()) {
      this.#session = undefined;
      return;
    }
    try {
      await this.#request('disconnect');
    } catch (value) {
      // If the Worker died while processing disconnect, termination itself
      // released the browser-side resource owner. Preserve ordinary remote
      // disconnect failures, but make this terminal transport case idempotent.
      if (!this.#acknowledgeTerminatedWorker()) throw value;
    }
    if (this.#session === session) this.#session = undefined;
  }

  #request<T>(method: SignalLabWorkerRequest['method'], payload?: unknown): Promise<T> {
    if (this.#fatalError) return Promise.reject(this.#fatalError);
    let worker: SignalLabWorkerPort;
    try { worker = this.#worker ?? this.#startWorker(); }
    catch (value) { return Promise.reject(value); }
    const requestId = this.#nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(requestId, { resolve: (value) => resolve(value as T), reject });
      try {
        worker.postMessage({ kind: 'request', requestId, method, ...(payload === undefined ? {} : { payload }) });
      } catch (value) {
        this.#pending.delete(requestId);
        reject(value);
      }
    });
  }

  #startWorker(): SignalLabWorkerPort {
    const worker = this.#workerFactory();
    this.#worker = worker;
    worker.onmessage = (event) => {
      if (this.#worker === worker) this.#acceptMessage(event.data);
    };
    worker.onerror = (event) => {
      if (this.#worker !== worker) return;
      event.preventDefault?.();
      this.#fail(new Error(event.message || 'SignalLab worker failed'));
    };
    worker.onmessageerror = () => {
      if (this.#worker === worker) this.#fail(new Error('SignalLab worker returned an unreadable message'));
    };
    return worker;
  }

  #acknowledgeTerminatedWorker(): boolean {
    if (this.#worker) return false;
    this.#fatalError = undefined;
    return true;
  }

  #acceptMessage(message: SignalLabWorkerMessage): void {
    if (message.kind === 'session-event') {
      this.#session?.acceptEvent(message.event);
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (!pending) return;
    this.#pending.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else {
      const error = new Error(message.error.message);
      error.name = message.error.name;
      pending.reject(error);
    }
  }

  #fail(error: Error): void {
    if (this.#fatalError) return;
    this.#fatalError = error;
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#session?.acceptEvent({
      type: 'error',
      sessionId: this.#session.sessionId,
      error: { code: 'driver-failure', message: error.message || 'SignalLab worker failed', recoverable: false },
    });
  }
}

class BrowserSignalLabWorkerSession implements InstrumentSession {
  readonly #listeners = new Set<(event: InstrumentSessionEvent) => void>();
  #descriptor: SignalLabWorkerSessionDescriptor;
  #closed = false;

  constructor(
    private readonly driver: BrowserSignalLabWorkerDriver,
    descriptor: SignalLabWorkerSessionDescriptor,
  ) {
    this.#descriptor = descriptor;
  }

  get sessionId(): string { return this.#descriptor.sessionId; }
  get driverId(): typeof BROWSER_SIGNAL_LAB_DRIVER_ID { return this.#descriptor.driverId; }
  get candidate(): InstrumentCandidate { return this.#descriptor.candidate; }
  get provenance(): InstrumentSessionProvenance { return this.#descriptor.provenance; }
  get capabilities(): InstrumentCapabilities { return this.#descriptor.capabilities; }
  get rfOutput(): InstrumentRfOutputState { return this.#descriptor.rfOutput; }
  get receiveOnlySafety(): InstrumentReceiveOnlySafetyState | undefined { return this.#descriptor.receiveOnlySafety; }

  async configure(command: InstrumentConfigurationCommand): Promise<void> {
    this.#requireOpen();
    await this.driver.configure(command);
  }

  async acquire(): Promise<InstrumentMeasurement> {
    this.#requireOpen();
    return this.driver.acquire();
  }

  async executeFeature(command: InstrumentFeatureCommand): Promise<InstrumentFeatureResult> {
    this.#requireOpen();
    const execution = await this.driver.executeFeature(command);
    this.#descriptor = execution.session;
    return execution.result;
  }

  async disconnect(): Promise<void> {
    if (this.#closed) return;
    await this.driver.disconnect(this);
    this.#closed = true;
    this.#listeners.clear();
  }

  subscribe(listener: (event: InstrumentSessionEvent) => void): () => void {
    this.#requireOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  acceptEvent(event: InstrumentSessionEvent): void {
    const eventSessionId = event.type === 'measurement' ? event.measurement.sessionId : event.sessionId;
    if (this.#closed || eventSessionId !== this.sessionId) return;
    for (const listener of [...this.#listeners]) listener(event);
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error('SignalLab worker session is closed');
  }
}

export { BROWSER_SIGNAL_LAB_CANDIDATE_ID, BROWSER_SIGNAL_LAB_DRIVER_ID };
