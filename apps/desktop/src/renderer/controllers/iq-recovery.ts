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

export const IQ_RECOVERY_MINIMUM_PERIOD_MILLISECONDS = 250;
export const IQ_RECOVERY_WORKER_RESPONSE_TIMEOUT_MILLISECONDS = 15_000;

export interface IqRecoveryScheduling {
  readonly minimumPeriodMilliseconds: number;
  nowMilliseconds(): number;
  schedule(callback: () => void, delayMilliseconds: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
}

const DEFAULT_IQ_RECOVERY_SCHEDULING: IqRecoveryScheduling = {
  minimumPeriodMilliseconds: IQ_RECOVERY_MINIMUM_PERIOD_MILLISECONDS,
  nowMilliseconds: () => performance.now(),
  schedule: (callback, delayMilliseconds) => globalThis.setTimeout(callback, delayMilliseconds),
  cancel: (timer) => globalThis.clearTimeout(timer),
};

/**
 * Runs at most one constellation recovery at a time and retains only the newest
 * waiting capture. Recovery is decorative and intentionally capped at 4 Hz:
 * the first result remains immediate while a live 12–20 Hz acquisition cannot
 * pin a CPU core on blind equalization. Raw preview/canvas updates are never
 * coupled to recovery or classifier throughput.
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
  private nextRecoveryAt = Number.NEGATIVE_INFINITY;
  private scheduledDrain: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly publish: (result: RecoveredConstellation | undefined) => void,
    executor: IqRecoveryExecutor = createIqRecoveryExecutor(),
    private readonly scheduling: IqRecoveryScheduling = DEFAULT_IQ_RECOVERY_SCHEDULING,
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
      this.nextRecoveryAt = Number.NEGATIVE_INFINITY;
      this.cancelScheduledDrain();
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
    this.nextRecoveryAt = Number.NEGATIVE_INFINITY;
    this.cancelScheduledDrain();
    this.publish(undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.latest = undefined;
    this.cancelScheduledDrain();
    this.executor.dispose();
  }

  private drain(): void {
    if (this.disposed || this.inFlight || !this.latest) return;
    const delay = this.nextRecoveryAt - this.scheduling.nowMilliseconds();
    if (delay > 0) {
      if (this.scheduledDrain === undefined) {
        this.scheduledDrain = this.scheduling.schedule(() => {
          this.scheduledDrain = undefined;
          this.drain();
        }, delay);
      }
      return;
    }
    const work = this.latest;
    const generation = this.generation;
    this.latest = undefined;
    this.inFlight = true;
    this.inFlightKey = work.key;
    this.nextRecoveryAt = this.scheduling.nowMilliseconds()
      + Math.max(0, this.scheduling.minimumPeriodMilliseconds);
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

  private cancelScheduledDrain(): void {
    if (this.scheduledDrain === undefined) return;
    this.scheduling.cancel(this.scheduledDrain);
    this.scheduledDrain = undefined;
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
    readonly timeout: ReturnType<typeof setTimeout>;
  }>();

  async recover(capture: ComplexIqMeasurement): Promise<RecoveredConstellation> {
    const { re: real, im: imaginary } = decodeComplexIqChannels(capture, COMPLEX_IQ_RECOVERY_SAMPLE_LIMIT);
    const request: IqRecoveryWorkerRequest = { id: ++this.nextId, real, imaginary };
    const worker = this.requireWorker();
    return new Promise((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        if (!this.pending.has(request.id)) return;
        this.failWorker(
          worker,
          new Error(
            `I/Q recovery worker did not respond within ${IQ_RECOVERY_WORKER_RESPONSE_TIMEOUT_MILLISECONDS / 1_000} seconds`,
          ),
        );
      }, IQ_RECOVERY_WORKER_RESPONSE_TIMEOUT_MILLISECONDS);
      this.pending.set(request.id, { resolve, reject, timeout });
      try { worker.postMessage(request, [real.buffer, imaginary.buffer]); }
      catch (failure) {
        globalThis.clearTimeout(timeout);
        this.pending.delete(request.id);
        reject(failure);
      }
    });
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = undefined;
    worker?.terminate();
    this.rejectAll(new Error('I/Q recovery worker disposed'));
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
      globalThis.clearTimeout(pending.timeout);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error));
    };
    worker.onerror = (event) => {
      this.failWorker(
        worker,
        new Error(event.message || 'I/Q recovery worker failed'),
      );
    };
    this.worker = worker;
    return worker;
  }

  private failWorker(worker: Worker, failure: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    worker.terminate();
    this.rejectAll(failure);
  }

  private rejectAll(failure: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      globalThis.clearTimeout(request.timeout);
      request.reject(failure);
    }
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

export function createIqRecoveryExecutor(): IqRecoveryExecutor {
  return typeof Worker === 'undefined'
    ? new InlineIqRecoveryExecutor()
    : new BrowserIqRecoveryExecutor();
}
