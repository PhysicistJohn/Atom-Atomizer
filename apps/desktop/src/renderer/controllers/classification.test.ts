// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type {
  DetectedSignal,
  InstrumentSessionSnapshot,
  Sweep,
} from '@tinysa/contracts';
import type {
  IqClassifierPrototypeSource,
  ModulationClassification,
  TrustedIqGeometryContext,
} from '../embedding-classifier-runtime.js';
import { TRUSTED_IQ_GEOMETRY_CONTEXT_KIND } from '../iq-classification-geometry.js';
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
    expect(executor.iqSampleCounts).toEqual(Array.from({ length: 10 }, () => 16_384));
    expect(store.get().classification).toMatchObject({
      source: 'iq', pending: false, sampleCount: 10, result: { family: 'ofdm' },
    });
    controller.dispose();
  });

  it('admits only tested I/Q lengths and selects the corresponding contiguous prefix', async () => {
    const executor = new ImmediateExecutor();
    const { store, controller } = setup(executor, () => 0);

    controller.ingestIq(capture('too-short', 1, { sampleCount: 4_095 }));
    await flushMicrotasks();
    expect(executor.iqSampleCounts).toEqual([]);
    expect(store.get().classification).toMatchObject({
      source: 'iq', pending: false, sampleCount: 0, result: undefined,
      issue: {
        kind: 'unavailable',
        message: expect.stringMatching(/at least 4,096 complex samples.*Increase Complex samples/i),
      },
    });

    const admitted: readonly [number, number][] = [
      [4_096, 4_096],
      [8_191, 4_096],
      [8_192, 8_192],
      [16_383, 8_192],
      [16_384, 16_384],
      [20_000, 16_384],
      [32_768, 16_384],
      [32_769, 16_384],
    ];
    for (const [sampleCount] of admitted) {
      controller.ingestIq(capture(`iq-${sampleCount}`, sampleCount, { sampleCount }));
      await flushMicrotasks();
    }

    expect(executor.iqSampleCounts).toEqual(admitted.map(([, expected]) => expected));
    expect(store.get().classification.issue).toBeUndefined();
    controller.dispose();
  });

  it('routes native and scaled fixed-profile geometry without exposing profile/class features', async () => {
    const executor = new ImmediateExecutor();
    const { store, controller } = setup(executor, () => 0);
    store.set({
      instrument: {
        ...store.get().instrument,
        session: fixedProfileSignalLabSession(),
      },
    });

    controller.ingestIq(capture('signal-lab-native', 1, {
      qualification: 'independently-verified-digital-baseband',
      nativeSampleRateHz: 56_000_000,
    }));
    await flushMicrotasks();
    expect(executor.prototypeSources).toEqual(['current']);
    expect(executor.iqSampleCounts).toEqual([16_384]);
    expect(executor.trustedGeometries).toEqual([{
      kind: TRUSTED_IQ_GEOMETRY_CONTEXT_KIND,
      sampleRateHz: 56_000_000,
      nativeSampleRateHz: 56_000_000,
    }]);

    controller.ingestIq(capture('signal-lab-scaled', 2, {
      sampleRateHz: 28_000_000,
      qualification: 'derived-from-independently-verified-digital-baseband',
      nativeSampleRateHz: 56_000_000,
    }));
    await flushMicrotasks();
    expect(executor.prototypeSources).toEqual(['current', 'current']);
    expect(executor.trustedGeometries[1]).toEqual({
      kind: TRUSTED_IQ_GEOMETRY_CONTEXT_KIND,
      sampleRateHz: 28_000_000,
      nativeSampleRateHz: 56_000_000,
    });
    expect(Object.keys(executor.trustedGeometries[1]!).sort()).toEqual([
      'kind',
      'nativeSampleRateHz',
      'sampleRateHz',
    ]);

    controller.ingestIq(capture('stale-same-session', 3, {
      producerConfigurationEpoch: 'producer-epoch-0',
    }));
    await flushMicrotasks();
    expect(executor.prototypeSources).toEqual([
      'current',
      'current',
      'historical',
    ]);
    expect(executor.trustedGeometries.at(-1)).toBeUndefined();

    store.set({
      instrument: {
        ...store.get().instrument,
        session: {
          sessionId: 'session-1',
          provenance: {
            sourceKind: 'signal-lab',
            producerConfigurationEpoch: 'producer-epoch-1',
          },
          capabilities: {
            features: [{
              kind: 'signal-lab-profile-selection',
              selectedProfileId: 'am',
            }],
          },
        } as unknown as InstrumentSessionSnapshot,
      },
    });
    controller.ingestIq(capture('signal-lab-analog', 4));
    await flushMicrotasks();
    expect(executor.prototypeSources).toEqual([
      'current',
      'current',
      'historical',
      'historical',
    ]);

    controller.ingestIq({
      ...capture('stale-other-session', 5),
      sessionId: 'other-session',
    });
    await flushMicrotasks();
    expect(executor.prototypeSources).toEqual([
      'current',
      'current',
      'historical',
      'historical',
      'historical',
    ]);

    store.set({
      instrument: {
        ...store.get().instrument,
        session: {
          sessionId: 'session-1',
          provenance: { sourceKind: 'serial-port' },
        } as unknown as InstrumentSessionSnapshot,
      },
    });
    controller.ingestIq(capture('physical-sdr', 6));
    await flushMicrotasks();
    expect(executor.prototypeSources).toEqual([
      'current',
      'current',
      'historical',
      'historical',
      'historical',
      'historical',
    ]);
    controller.dispose();
  });

  it.each([
    {
      name: 'measurement omits native rate',
      sessionNativeSampleRateHz: 56_000_000,
      captureNativeSampleRateHz: undefined,
    },
    {
      name: 'measurement and capability native rates disagree',
      sessionNativeSampleRateHz: 56_000_000,
      captureNativeSampleRateHz: 122_880_000,
    },
    {
      name: 'current profile has no fixed native capability',
      sessionNativeSampleRateHz: null,
      captureNativeSampleRateHz: 56_000_000,
    },
  ])('fails closed when $name', async ({
    sessionNativeSampleRateHz,
    captureNativeSampleRateHz,
  }) => {
    const executor = new ImmediateExecutor();
    const { store, controller } = setup(executor, () => 0);
    store.set({
      instrument: {
        ...store.get().instrument,
        session: fixedProfileSignalLabSession(sessionNativeSampleRateHz),
      },
    });

    controller.ingestIq(capture('untrusted-current-geometry', 1, {
      qualification: 'independently-verified-digital-baseband',
      ...(captureNativeSampleRateHz === undefined
        ? {}
        : { nativeSampleRateHz: captureNativeSampleRateHz }),
    }));
    await flushMicrotasks();

    expect(executor.prototypeSources).toEqual([]);
    expect(store.get().classification).toMatchObject({
      source: 'iq',
      pending: false,
      sampleCount: 0,
      result: undefined,
      issue: {
        kind: 'failure',
        message: expect.stringMatching(
          /Current-route native geometry is unavailable/i,
        ),
      },
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
    expect(store.get().classification.issue).toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
    controller.dispose();
  });

  it('publishes actionable current-scope failures and clears them on success, scope change, and reset', async () => {
    let now = 0;
    const executor = new DeferredExecutor();
    const { store, controller } = setup(executor, () => now);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    controller.ingestIq(capture('iq-broken', 1));
    executor.reject(0, new Error('worker unavailable'));
    await flushMicrotasks();
    expect(store.get().classification).toMatchObject({
      source: 'iq',
      pending: false,
      sampleCount: 0,
      result: undefined,
      issue: {
        kind: 'failure',
        message: expect.stringMatching(/worker unavailable.*Capture again/i),
      },
    });

    now = 20;
    controller.ingestIq(capture('iq-retry', 2));
    expect(store.get().classification.pending).toBe(true);
    expect(store.get().classification.issue).toBeUndefined();
    executor.resolve(1, result({ fm: 1 }));
    await flushMicrotasks();
    expect(store.get().classification).toMatchObject({
      pending: false,
      sampleCount: 1,
      result: { family: 'fm' },
      issue: undefined,
    });

    now = 40;
    controller.ingestIq(capture('iq-broken-again', 3));
    executor.reject(2, new Error('second failure'));
    await flushMicrotasks();
    expect(store.get().classification.issue).toMatchObject({ kind: 'failure' });

    now = 60;
    controller.ingestIq(capture('iq-new-scope', 4, { sampleRateHz: 28_000_000 }));
    expect(store.get().classification).toMatchObject({
      pending: true,
      sampleCount: 0,
      result: undefined,
      issue: undefined,
    });
    executor.resolve(3, result({ ofdm: 1 }));
    await flushMicrotasks();

    now = 80;
    controller.ingestIq(capture('iq-new-scope-failure', 5, { sampleRateHz: 28_000_000 }));
    executor.reject(4, new Error('third failure'));
    await flushMicrotasks();
    expect(store.get().classification.issue).toMatchObject({ kind: 'failure' });

    controller.reset();
    expect(store.get().classification).toEqual({
      source: 'none',
      pending: false,
      sampleCount: 0,
      result: undefined,
      issue: undefined,
    });
    expect(error).toHaveBeenCalledTimes(3);
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
  readonly prototypeSources: IqClassifierPrototypeSource[] = [];
  readonly trustedGeometries: Array<
    TrustedIqGeometryContext | undefined
  > = [];
  classifyIq(
    real: Float64Array,
    _imaginary: Float64Array,
    _bandwidthHz: number,
    prototypeSource: IqClassifierPrototypeSource,
    trustedGeometry?: TrustedIqGeometryContext,
  ): Promise<ModulationClassification> {
    this.iqFirstComponents.push(real[0]!);
    this.iqSampleCounts.push(real.length);
    this.prototypeSources.push(prototypeSource);
    this.trustedGeometries.push(trustedGeometry);
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
  overrides: Partial<Pick<ComplexIqMeasurement,
    | 'producerConfigurationEpoch'
    | 'sampleRateHz'
    | 'nativeSampleRateHz'
    | 'bandwidthHz'
    | 'sampleCount'
    | 'qualification'
  >> = {},
): ComplexIqMeasurement {
  const sampleCount = overrides.sampleCount ?? 16_384;
  const samples = new Uint8Array(sampleCount * 8);
  const view = new DataView(samples.buffer);
  view.setFloat32(0, sequence, true);
  view.setFloat32(4, -sequence, true);
  const sampleRateHz = overrides.sampleRateHz ?? 56_000_000;
  const trustedGeometry = overrides.nativeSampleRateHz === undefined
    ? {}
    : {
        nativeSampleRateHz: overrides.nativeSampleRateHz,
        transformReceipt: {
          sourceSampleRateHz: overrides.nativeSampleRateHz,
          outputSampleRateHz: sampleRateHz,
        } as NonNullable<ComplexIqMeasurement['transformReceipt']>,
      };
  return {
    schemaVersion: 1, kind: 'complex-iq', measurementId, sessionId: 'session-1',
    configurationRevision: 'configuration-1', producerConfigurationEpoch: 'producer-epoch-1', sequence,
    capturedAt: new Date(Date.UTC(2026, 6, 22, 0, 0, sequence)).toISOString(), elapsedMilliseconds: 5,
    resolutionBandwidthHz: null, attenuationDb: null, qualification: 'analytic-complex-baseband', complete: true,
    centerHz: 100_000_000, sampleRateHz, bandwidthHz: 40_000_000,
    sampleFormat: 'cf32le', sampleCount, samples,
    ...trustedGeometry,
    ...overrides,
  };
}

function fixedProfileSignalLabSession(
  nativeSampleRateHz: number | null = 56_000_000,
): InstrumentSessionSnapshot {
  return {
    sessionId: 'session-1',
    provenance: {
      sourceKind: 'signal-lab',
      producerConfigurationEpoch: 'producer-epoch-1',
    },
    capabilities: {
      features: [{
        kind: 'signal-lab-profile-selection',
        selectedProfileId: 'wifi-hr-dsss-11m',
        profiles: [{
          profileId: 'wifi-hr-dsss-11m',
          qualification: 'independently-verified-digital-baseband',
        }],
        iqProfiles: [{
          profileId: 'wifi-hr-dsss-11m',
          nativeSampleRateHz,
        }],
      }],
    },
  } as unknown as InstrumentSessionSnapshot;
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
