// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModulationClassification } from '../embedding-classifier-runtime.js';
import type { ComplexIqMeasurement } from '../complex-iq.js';
import { AtomizerStore, createInitialRendererState } from '../store.js';
import { RendererKernel } from './kernel.js';
import {
  ClassificationController,
  GLOBAL_CLASSIFICATION_INTERVAL_MS,
  type ClassificationExecutor,
} from './classification.js';

afterEach(() => vi.useRealTimers());

describe('application-global classification controller', () => {
  it('continues an eight-look I/Q FIFO independently of the selected workspace', async () => {
    vi.useFakeTimers();
    const executor = new StubExecutor([
      result({ dsss: 0.9, ofdm: 0.1 }),
      result({ ofdm: 1, dsss: 0 }),
    ]);
    const store = new AtomizerStore(createInitialRendererState({ initialWorkspace: 'spectrum', initialAgentOpen: false }));
    const kernel = new RendererKernel(store);
    const controller = new ClassificationController(kernel, executor);
    kernel.classification = controller;

    controller.ingestIq(capture('iq-1', 1));
    await vi.runOnlyPendingTimersAsync();
    expect(store.get().classification).toMatchObject({ source: 'iq', evidenceLooks: 1, result: { family: 'dsss' } });

    store.set({ workspace: 'generator' });
    for (let sequence = 2; sequence <= 30; sequence++) {
      controller.ingestIq(capture(`iq-${sequence}`, sequence));
    }
    await vi.advanceTimersByTimeAsync(GLOBAL_CLASSIFICATION_INTERVAL_MS - 1);
    expect(executor.iqCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.get().classification).toMatchObject({ source: 'iq', evidenceLooks: 2, result: { family: 'ofdm' } });
    expect(executor.iqCalls).toBe(2);
    expect(executor.iqFirstComponents).toEqual([1, 30]);
    controller.dispose();
  });
});

class StubExecutor implements ClassificationExecutor {
  iqCalls = 0;
  readonly iqFirstComponents: number[] = [];
  constructor(private readonly results: readonly ModulationClassification[]) {}
  classifyIq(real: Float64Array): Promise<ModulationClassification> {
    this.iqFirstComponents.push(real[0]!);
    return Promise.resolve(this.results[this.iqCalls++]!);
  }
  classifyScalar(): Promise<undefined> { return Promise.resolve(undefined); }
  dispose(): void {}
}

function capture(measurementId: string, sequence: number): ComplexIqMeasurement {
  const samples = new Uint8Array(4_096 * 8);
  const view = new DataView(samples.buffer);
  view.setFloat32(0, sequence, true);
  view.setFloat32(4, -sequence, true);
  return {
    schemaVersion: 1, kind: 'complex-iq', measurementId, sessionId: 'session-1',
    configurationRevision: 'configuration-1', producerConfigurationEpoch: 'producer-epoch-1', sequence,
    capturedAt: new Date(Date.UTC(2026, 6, 22, 0, 0, sequence)).toISOString(), elapsedMilliseconds: 5,
    resolutionBandwidthHz: null, attenuationDb: null, qualification: 'analytic-complex-baseband', complete: true,
    centerHz: 100_000_000, sampleRateHz: 56_000_000, bandwidthHz: 40_000_000,
    sampleFormat: 'cf32le', sampleCount: 4_096, samples,
  };
}

function result(distribution: Record<string, number>): ModulationClassification {
  const candidates = Object.entries(distribution).map(([label, confidence]) => ({ label, confidence }));
  const winner = candidates.reduce((best, candidate) => best.confidence >= candidate.confidence ? best : candidate);
  return {
    flavor: 'iq', family: winner.label, modulation: winner.label, confidence: winner.confidence,
    isUnknown: false, candidates, bwFraction: 0.5,
  };
}
