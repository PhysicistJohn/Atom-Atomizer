import { describe, expect, it, vi } from 'vitest';
import type { RecoveredConstellation } from '../embedding-classifier-runtime.js';
import type { ComplexIqMeasurement } from '../complex-iq.js';
import {
  IQ_RECOVERY_MINIMUM_PERIOD_MILLISECONDS,
  IqRecoveryController,
  type IqRecoveryExecutor,
  type IqRecoveryScheduling,
} from './iq-recovery.js';

describe('I/Q constellation recovery', () => {
  it('runs one recovery at a time, drops queued intermediates, and resets across source scope', async () => {
    const executor = new DeferredRecoveryExecutor();
    const published: Array<RecoveredConstellation | undefined> = [];
    const controller = new IqRecoveryController((result) => published.push(result), executor, immediateScheduling());

    controller.submit(capture('iq-1', 1));
    controller.submit(capture('iq-2', 2));
    controller.submit(capture('iq-3', 3));
    expect(executor.ids).toEqual(['iq-1']);

    executor.resolve(0, recovery(1));
    await flushMicrotasks();
    expect(executor.ids).toEqual(['iq-1', 'iq-3']);
    expect(published).toEqual([undefined, recovery(1)]);

    // A producer may reuse an ID after its epoch changes. Scope is part of the
    // recovery key, so the first capture of the replacement source is retained.
    controller.submit(capture('iq-3', 4, 'producer-epoch:2'));
    executor.resolve(1, recovery(3));
    await flushMicrotasks();
    expect(executor.ids).toEqual(['iq-1', 'iq-3', 'iq-3']);
    expect(published).toEqual([undefined, recovery(1), undefined]);

    executor.resolve(2, recovery(4));
    await flushMicrotasks();
    expect(published).toEqual([undefined, recovery(1), undefined, recovery(4)]);
    controller.dispose();
    expect(executor.dispose).toHaveBeenCalledOnce();
  });

  it('turns a synchronous executor failure into a local rejection and continues with the newest capture', async () => {
    const executor = new ThrowOnceRecoveryExecutor();
    const published: Array<RecoveredConstellation | undefined> = [];
    const controller = new IqRecoveryController((result) => published.push(result), executor, immediateScheduling());

    expect(() => controller.submit(capture('iq-broken', 1))).not.toThrow();
    controller.submit(capture('iq-next', 2));
    await flushMicrotasks();

    expect(executor.ids).toEqual(['iq-broken', 'iq-next']);
    expect(published).toEqual([undefined, recovery(2)]);
    controller.dispose();
  });

  it('publishes the first recovery immediately and caps live work to the newest capture at 4 Hz', async () => {
    const executor = new DeferredRecoveryExecutor();
    const scheduler = new ManualRecoveryScheduling();
    const published: Array<RecoveredConstellation | undefined> = [];
    const controller = new IqRecoveryController(
      (result) => published.push(result),
      executor,
      scheduler,
    );

    controller.submit(capture('iq-1', 1));
    controller.submit(capture('iq-2', 2));
    controller.submit(capture('iq-3', 3));
    expect(executor.ids).toEqual(['iq-1']);

    executor.resolve(0, recovery(1));
    await flushMicrotasks();
    expect(executor.ids).toEqual(['iq-1']);
    expect(scheduler.nextDelay()).toBe(IQ_RECOVERY_MINIMUM_PERIOD_MILLISECONDS);

    scheduler.advance(IQ_RECOVERY_MINIMUM_PERIOD_MILLISECONDS - 1);
    controller.submit(capture('iq-4', 4));
    expect(executor.ids).toEqual(['iq-1']);

    scheduler.advance(1);
    expect(executor.ids).toEqual(['iq-1', 'iq-4']);
    executor.resolve(1, recovery(4));
    await flushMicrotasks();
    expect(published).toEqual([undefined, recovery(1), recovery(4)]);

    controller.dispose();
    expect(scheduler.pendingCount()).toBe(0);
  });
});

class DeferredRecoveryExecutor implements IqRecoveryExecutor {
  readonly ids: string[] = [];
  readonly dispose = vi.fn();
  private readonly pending: Array<(result: RecoveredConstellation) => void> = [];

  recover(capture: ComplexIqMeasurement): Promise<RecoveredConstellation> {
    this.ids.push(capture.measurementId);
    return new Promise((resolve) => this.pending.push(resolve));
  }

  resolve(index: number, result: RecoveredConstellation): void {
    this.pending[index]!(result);
  }
}

class ThrowOnceRecoveryExecutor implements IqRecoveryExecutor {
  readonly ids: string[] = [];

  recover(capture: ComplexIqMeasurement): Promise<RecoveredConstellation> {
    this.ids.push(capture.measurementId);
    if (this.ids.length === 1) throw new Error('synchronous recovery failure');
    return Promise.resolve(recovery(capture.sequence));
  }

  dispose(): void {}
}

function immediateScheduling(): IqRecoveryScheduling {
  return {
    minimumPeriodMilliseconds: 0,
    nowMilliseconds: () => 0,
    schedule: (callback) => globalThis.setTimeout(callback, 0),
    cancel: (timer) => globalThis.clearTimeout(timer),
  };
}

class ManualRecoveryScheduling implements IqRecoveryScheduling {
  readonly minimumPeriodMilliseconds = IQ_RECOVERY_MINIMUM_PERIOD_MILLISECONDS;
  private now = 0;
  private nextTimerId = 0;
  private readonly timers = new Map<number, { readonly due: number; readonly callback: () => void }>();

  nowMilliseconds(): number { return this.now; }

  schedule(callback: () => void, delayMilliseconds: number): ReturnType<typeof setTimeout> {
    const id = ++this.nextTimerId;
    this.timers.set(id, { due: this.now + delayMilliseconds, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  cancel(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer as unknown as number);
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.due <= this.now)
      .sort((left, right) => left[1].due - right[1].due);
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue;
      timer.callback();
    }
  }

  nextDelay(): number | undefined {
    const next = [...this.timers.values()].sort((left, right) => left.due - right.due)[0];
    return next === undefined ? undefined : next.due - this.now;
  }

  pendingCount(): number { return this.timers.size; }
}

function capture(
  measurementId: string,
  sequence: number,
  producerConfigurationEpoch = 'producer-epoch:1',
): ComplexIqMeasurement {
  return {
    schemaVersion: 1, kind: 'complex-iq', measurementId, sessionId: 'session-1',
    configurationRevision: 'configuration-1', producerConfigurationEpoch, sequence,
    capturedAt: new Date(Date.UTC(2026, 6, 22, 0, 0, sequence)).toISOString(), elapsedMilliseconds: 5,
    resolutionBandwidthHz: null, attenuationDb: null, qualification: 'analytic-complex-baseband', complete: true,
    centerHz: 100_000_000, sampleRateHz: 56_000_000, bandwidthHz: 40_000_000,
    sampleFormat: 'cf32le', sampleCount: 2, samples: new Uint8Array(16),
  };
}

function recovery(id: number): RecoveredConstellation {
  return { points: [{ i: id, q: -id }], sps: 8, residualIsi: 0.1, snrDb: 20, clean: true };
}

async function flushMicrotasks(turns = 5): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}
