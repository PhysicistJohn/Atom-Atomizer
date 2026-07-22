import {
  COMPLEX_IQ_RECOVERY_SAMPLE_LIMIT,
  decodeComplexIqChannels,
  type ComplexIqMeasurement,
} from '../complex-iq.js';
import type { RecoveredConstellation } from '../embedding-classifier-runtime.js';
import type { IqRecoveryWorkerRequest, IqRecoveryWorkerResponse } from '../iq-recovery-worker-protocol.js';

export interface IqRecoveryExecutor {
  recover(capture: ComplexIqMeasurement): Promise<RecoveredConstellation>;
  dispose(): void;
}

interface PendingRecovery {
  readonly key: string;
  readonly capture: ComplexIqMeasurement;
}

/**
 * Runs at most one constellation recovery at a time and retains only the newest
 * waiting capture. Raw preview/canvas updates are never coupled to recovery or
 * classifier throughput.
 */
export class IqRecoveryController {
  private readonly executor: IqRecoveryExecutor;
  private activeScope: string | undefined;
  private latest: PendingRecovery | undefined;
  private inFlight = false;
  private inFlightKey: string | undefined;
  private lastCompletedKey: string | undefined;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly publish: (result: RecoveredConstellation | undefined) => void,
    executor: IqRecoveryExecutor = createIqRecoveryExecutor(),
  ) {
    this.executor = executor;
  }

  submit(capture: ComplexIqMeasurement): void {
    if (this.disposed) return;
    const scope = recoveryScope(capture);
    if (scope !== this.activeScope) {
      this.generation++;
      this.activeScope = scope;
      this.latest = undefined;
      this.lastCompletedKey = undefined;
      this.publish(undefined);
    }
    const key = JSON.stringify([scope, capture.measurementId]);
    if (key === this.inFlightKey || key === this.latest?.key || key === this.lastCompletedKey) return;
    this.latest = { key, capture };
    this.drain();
  }

  reset(): void {
    if (this.disposed) return;
    this.generation++;
    this.activeScope = undefined;
    this.latest = undefined;
    this.lastCompletedKey = undefined;
    this.publish(undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.latest = undefined;
    this.executor.dispose();
  }

  private drain(): void {
    if (this.disposed || this.inFlight || !this.latest) return;
    const work = this.latest;
    const generation = this.generation;
    this.latest = undefined;
    this.inFlight = true;
    this.inFlightKey = work.key;
    let recovery: Promise<RecoveredConstellation>;
    try { recovery = this.executor.recover(work.capture); }
    catch (failure) { recovery = Promise.reject(failure); }
    void recovery.then(
      (result) => {
        if (this.disposed || generation !== this.generation) return;
        this.lastCompletedKey = work.key;
        this.publish(result);
      },
      () => { /* Preserve the last good recovery for capability-local failures. */ },
    ).finally(() => {
      this.inFlight = false;
      this.inFlightKey = undefined;
      this.drain();
    });
  }
}

function recoveryScope(capture: ComplexIqMeasurement): string {
  return JSON.stringify([
    capture.sessionId,
    capture.producerConfigurationEpoch ?? null,
    capture.centerHz,
    capture.sampleRateHz,
    capture.bandwidthHz,
    capture.sampleFormat,
    capture.sampleCount,
  ]);
}

class BrowserIqRecoveryExecutor implements IqRecoveryExecutor {
  private worker: Worker | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, {
    readonly resolve: (result: RecoveredConstellation) => void;
    readonly reject: (reason: unknown) => void;
  }>();

  async recover(capture: ComplexIqMeasurement): Promise<RecoveredConstellation> {
    const { re: real, im: imaginary } = decodeComplexIqChannels(capture, COMPLEX_IQ_RECOVERY_SAMPLE_LIMIT);
    const request: IqRecoveryWorkerRequest = { id: ++this.nextId, real, imaginary };
    const worker = this.requireWorker();
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      try { worker.postMessage(request, [real.buffer, imaginary.buffer]); }
      catch (failure) {
        this.pending.delete(request.id);
        reject(failure);
      }
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const { reject } of this.pending.values()) reject(new Error('I/Q recovery worker disposed'));
    this.pending.clear();
  }

  private requireWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../iq-recovery-worker.ts', import.meta.url), {
      type: 'module',
      name: 'atomizer-iq-recovery',
    });
    worker.onmessage = (event: MessageEvent<IqRecoveryWorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error));
    };
    worker.onerror = (event) => {
      const failure = new Error(event.message || 'I/Q recovery worker failed');
      for (const { reject } of this.pending.values()) reject(failure);
      this.pending.clear();
      worker.terminate();
      if (this.worker === worker) this.worker = undefined;
    };
    this.worker = worker;
    return worker;
  }
}

class InlineIqRecoveryExecutor implements IqRecoveryExecutor {
  async recover(capture: ComplexIqMeasurement): Promise<RecoveredConstellation> {
    const { re, im } = decodeComplexIqChannels(capture, COMPLEX_IQ_RECOVERY_SAMPLE_LIMIT);
    const { recoverIqConstellation } = await import('../embedding-classifier-runtime.js');
    return recoverIqConstellation(re, im);
  }

  dispose(): void {}
}

function createIqRecoveryExecutor(): IqRecoveryExecutor {
  return typeof Worker === 'undefined'
    ? new InlineIqRecoveryExecutor()
    : new BrowserIqRecoveryExecutor();
}
