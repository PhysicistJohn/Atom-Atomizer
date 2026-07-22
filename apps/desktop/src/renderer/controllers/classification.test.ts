// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DetectedSignal, Sweep } from '@tinysa/contracts';
import type { ModulationClassification } from '../embedding-classifier-runtime.js';
import type { ComplexIqMeasurement } from '../complex-iq.js';
import { AtomizerStore, createInitialRendererState } from '../store.js';
import { RendererKernel } from './kernel.js';
import { ClassificationController, type ClassificationExecutor } from './classification.js';

describe('application-global classification controller', () => {
  it('classifies every completed I/Q capture immediately and keeps a 500 ms trend across workspaces', async () => {
    let now = 0;
    const executor = new ImmediateExecutor();
    const store = new AtomizerStore(createInitialRendererState({ initialWorkspace: 'spectrum', initialAgentOpen: false }));
    const kernel = new RendererKernel(store);
    const controller = new ClassificationController(kernel, executor, () => now);
    kernel.classification = controller;

    for (let sequence = 1; sequence <= 10; sequence++) {
      if (sequence === 5) store.set({ workspace: 'generator' });
      controller.ingestIq(capture(`iq-${sequence}`, sequence));
      await flushMicrotasks();
      now += 20;
    }

    expect(executor.iqFirstComponents).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(executor.iqSampleCounts).toEqual(Array.from({ length: 10 }, () => 4_096));
    expect(store.get().classification).toMatchObject({
      source: 'iq', pending: false, sampleCount: 10, result: { family: 'ofdm' },
    });
    controller.dispose();
  });

  it('runs one worker job at a time and immediately classifies only the newest waiting capture', async () => {
    let now = 0;
    const executor = new DeferredExecutor();
    const { store, controller } = setup(executor, () => now);

    controller.ingestIq(capture('iq-1', 1));
    now = 20;
    controller.ingestIq(capture('iq-2', 2));
    now = 40;
    controller.ingestIq(capture('iq-3', 3));
    expect(executor.iqFirstComponents).toEqual([1]);

    executor.resolve(0, result({ dsss: 0.9, ofdm: 0.1 }));
    await flushMicrotasks();
    expect(executor.iqFirstComponents).toEqual([1, 3]);
    expect(store.get().classification).toMatchObject({ pending: false, sampleCount: 1, result: { family: 'dsss' } });

    executor.resolve(1, result({ ofdm: 0.9, dsss: 0.1 }));
    await flushMicrotasks();
    expect(store.get().classification).toMatchObject({ sampleCount: 2, pending: false });

    now = 60;
    controller.ingestIq(capture('iq-4', 4));
    expect(executor.iqFirstComponents).toEqual([1, 3, 4]);
    expect(store.get().classification).toMatchObject({ sampleCount: 2, pending: false });
    executor.resolve(2, result({ ofdm: 1 }));
    await flushMicrotasks();
    expect(store.get().classification).toMatchObject({ sampleCount: 3, pending: false });
    controller.dispose();
  });

  it('resets immediately for geometry changes and rejects the stale in-flight result', async () => {
    let now = 0;
    const executor = new DeferredExecutor();
    const { store, controller } = setup(executor, () => now);

    controller.ingestIq(capture('reused-id', 1, { sampleRateHz: 56_000_000 }));
    now = 10;
    controller.ingestIq(capture('reused-id', 2, { sampleRateHz: 28_000_000 }));
    expect(store.get().classification).toMatchObject({ pending: true, sampleCount: 0, result: undefined });

    executor.resolve(0, result({ dsss: 1 }));
    await flushMicrotasks();
    expect(executor.iqFirstComponents).toEqual([1, 2]);
    expect(store.get().classification).toMatchObject({ pending: true, sampleCount: 0, result: undefined });

    executor.resolve(1, result({ ofdm: 1 }));
    await flushMicrotasks();
    expect(store.get().classification).toMatchObject({ pending: false, sampleCount: 1, result: { family: 'ofdm' } });
    controller.dispose();
  });

  it('re-admits the same evidence key after reset while the old generation is still in flight', async () => {
    let now = 0;
    const executor = new DeferredExecutor();
    const { store, controller } = setup(executor, () => now);
    const repeated = capture('same-id', 1);

    controller.ingestIq(repeated);
    controller.reset();
    now = 10;
    controller.ingestIq(repeated);
    executor.resolve(0, result({ dsss: 1 }));
    await flushMicrotasks();

    expect(executor.iqFirstComponents).toEqual([1, 1]);
    expect(store.get().classification).toMatchObject({ pending: true, sampleCount: 0, result: undefined });
    executor.resolve(1, result({ ofdm: 1 }));
    await flushMicrotasks();
    expect(store.get().classification).toMatchObject({ pending: false, sampleCount: 1, result: { family: 'ofdm' } });
    controller.dispose();
  });

  it('timestamps successful results at completion so a cold first inference still produces a sample', async () => {
    let now = 0;
    const executor = new DeferredExecutor();
    const { store, controller } = setup(executor, () => now);

    controller.ingestIq(capture('iq-cold', 1));
    now = 590;
    controller.ingestIq(capture('iq-current', 2));
    now = 600;
    executor.resolve(0, result({ dsss: 1 }));
    await flushMicrotasks();

    expect(executor.iqFirstComponents).toEqual([1, 2]);
    expect(store.get().classification).toMatchObject({ pending: false, sampleCount: 1, result: { family: 'dsss' } });
    executor.resolve(1, result({ ofdm: 1 }));
    await flushMicrotasks();
    expect(store.get().classification).toMatchObject({ pending: false, sampleCount: 2, result: { family: 'dsss' } });
    controller.dispose();
  });

  it('continues with the newest waiting capture after an inference failure', async () => {
    let now = 0;
    const executor = new DeferredExecutor();
    const { store, controller } = setup(executor, () => now);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    controller.ingestIq(capture('iq-broken', 1));
    now = 20;
    controller.ingestIq(capture('iq-next', 2));
    executor.reject(0, new Error('worker failure'));
    await flushMicrotasks();
    expect(executor.iqFirstComponents).toEqual([1, 2]);

    executor.resolve(1, result({ fm: 1 }));
    await flushMicrotasks();
    expect(store.get().classification).toMatchObject({ pending: false, sampleCount: 1, result: { family: 'fm' } });
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
    controller.dispose();
  });

  it('continuously classifies scalar fallback samples without a 500 ms dispatch timer', async () => {
    let now = 0;
    const executor = new ImmediateScalarExecutor();
    const { store, controller } = setup(executor, () => now);
    const target = scalarTarget();

    controller.ingestScalar(scalarSweep('sweep-1'), target);
    await flushMicrotasks();
    now = 20;
    controller.ingestScalar(scalarSweep('sweep-2'), target);
    await flushMicrotasks();

    expect(executor.sweepIds).toEqual(['sweep-1', 'sweep-2']);
    expect(store.get().classification).toMatchObject({
      source: 'scalar', pending: false, sampleCount: 2, result: { flavor: 'magnitude', family: 'fm' },
    });
    controller.dispose();
  });
});

function setup(executor: ClassificationExecutor, now: () => number) {
  const store = new AtomizerStore(createInitialRendererState({ initialWorkspace: 'spectrum', initialAgentOpen: false }));
  const kernel = new RendererKernel(store);
  const controller = new ClassificationController(kernel, executor, now);
  kernel.classification = controller;
  return { store, kernel, controller };
}

class ImmediateExecutor implements ClassificationExecutor {
  readonly iqFirstComponents: number[] = [];
  readonly iqSampleCounts: number[] = [];
  classifyIq(real: Float64Array): Promise<ModulationClassification> {
    this.iqFirstComponents.push(real[0]!);
    this.iqSampleCounts.push(real.length);
    return Promise.resolve(result({ ofdm: 0.8, dsss: 0.2 }));
  }
  classifyScalar(): Promise<undefined> { return Promise.resolve(undefined); }
  dispose(): void {}
}

class DeferredExecutor implements ClassificationExecutor {
  readonly iqFirstComponents: number[] = [];
  private readonly pending: Array<{
    readonly resolve: (value: ModulationClassification) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];

  classifyIq(real: Float64Array): Promise<ModulationClassification> {
    this.iqFirstComponents.push(real[0]!);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  classifyScalar(): Promise<undefined> { return Promise.resolve(undefined); }
  resolve(index: number, value: ModulationClassification): void { this.pending[index]!.resolve(value); }
  reject(index: number, reason: unknown): void { this.pending[index]!.reject(reason); }
  dispose(): void {}
}

class ImmediateScalarExecutor implements ClassificationExecutor {
  readonly sweepIds: string[] = [];
  classifyIq(): Promise<ModulationClassification> { return Promise.resolve(result({ fm: 1 })); }
  classifyScalar(powerDbm: readonly number[]): Promise<ModulationClassification> {
    this.sweepIds.push(powerDbm[0] === -81 ? 'sweep-1' : 'sweep-2');
    return Promise.resolve({ ...result({ fm: 1 }), flavor: 'magnitude' });
  }
  dispose(): void {}
}

function capture(
  measurementId: string,
  sequence: number,
  overrides: Partial<Pick<ComplexIqMeasurement, 'producerConfigurationEpoch' | 'sampleRateHz' | 'bandwidthHz'>> = {},
): ComplexIqMeasurement {
  const sampleCount = 16_384;
  const samples = new Uint8Array(sampleCount * 8);
  const view = new DataView(samples.buffer);
  view.setFloat32(0, sequence, true);
  view.setFloat32(4, -sequence, true);
  return {
    schemaVersion: 1, kind: 'complex-iq', measurementId, sessionId: 'session-1',
    configurationRevision: 'configuration-1', producerConfigurationEpoch: 'producer-epoch-1', sequence,
    capturedAt: new Date(Date.UTC(2026, 6, 22, 0, 0, sequence)).toISOString(), elapsedMilliseconds: 5,
    resolutionBandwidthHz: null, attenuationDb: null, qualification: 'analytic-complex-baseband', complete: true,
    centerHz: 100_000_000, sampleRateHz: 56_000_000, bandwidthHz: 40_000_000,
    sampleFormat: 'cf32le', sampleCount, samples,
    ...overrides,
  };
}

function result(distribution: Record<string, number>): ModulationClassification {
  const candidates = Object.entries(distribution)
    .map(([label, confidence]) => ({ label, confidence }))
    .sort((left, right) => right.confidence - left.confidence);
  const winner = candidates[0]!;
  return {
    flavor: 'iq', family: winner.label, modulation: winner.label, confidence: winner.confidence,
    isUnknown: false, posterior: distribution, candidates, bwFraction: 0.5,
  };
}

function scalarSweep(id: string): Sweep {
  const sequence = id === 'sweep-1' ? 1 : 2;
  return {
    id,
    powerDbm: [-(80 + sequence), -40, -90],
    frequencyHz: [99_000_000, 100_000_000, 101_000_000],
    requested: { kind: 'swept-spectrum', startHz: 99_000_000, stopHz: 101_000_000, points: 3 },
  } as unknown as Sweep;
}

function scalarTarget(): DetectedSignal {
  return { id: 'target-1', peakHz: 100_000_000, bandwidthHz: 200_000 } as unknown as DetectedSignal;
}

async function flushMicrotasks(turns = 10): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}
