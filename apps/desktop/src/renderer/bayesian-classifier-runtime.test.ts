import { describe, expect, it, vi } from 'vitest';
import type { DetectedSignal, WaveformClassification } from '@tinysa/contracts';
import type { WaveformEvidence } from '@tinysa/analysis';
import {
  createBayesianClassifierRuntime,
  type BayesianClassificationEngine,
} from './bayesian-classifier-runtime.js';

const detection = {
  id: 'signal-0001',
  peakHz: 100_000_000,
  bandwidthHz: 20_000,
  peakDbm: -48,
  sweepIds: ['sweep-1'],
} as unknown as DetectedSignal;
const evidence = { sweeps: [] } as unknown as WaveformEvidence;

describe('Bayesian classifier renderer boundary', () => {
  it('keeps the renderer available when no classifier assets were bundled', async () => {
    const runtime = createBayesianClassifierRuntime(() => {
      throw new Error('Bayesian classifier model assets are not bundled');
    });

    expect(runtime).toMatchObject({
      status: 'unavailable',
      issue: 'Bayesian classifier model assets are not bundled',
      classifier: { modelId: 'bayesian-observable-model-unavailable' },
    });
    await expect(runtime.classifier.classify(detection, evidence)).resolves.toMatchObject({
      qualification: 'unavailable',
      unknownReason: 'model-unavailable',
    });
  });

  it('passes through a model that completed constructor admission', async () => {
    const result = {
      detectionId: detection.id,
      label: 'unknown',
      confidence: 0,
      candidates: [],
      modelId: 'admitted-model',
      qualification: 'bayesian-observable-equivalence',
      scoreKind: 'none',
      decisionLevel: 'unknown',
      classifiedAt: '2026-07-16T00:00:00.000Z',
      unknownReason: 'insufficient-evidence',
      evidence: {
        centerHz: detection.peakHz,
        bandwidthHz: detection.bandwidthHz,
        peakDbm: detection.peakDbm,
        sweepIds: detection.sweepIds,
      },
    } satisfies WaveformClassification;
    const classify = vi.fn(async () => result);
    const classifier = {
      modelId: 'admitted-model',
      classify,
    } satisfies BayesianClassificationEngine;

    const runtime = createBayesianClassifierRuntime(() => classifier);

    expect(runtime).toMatchObject({ status: 'ready', classifier });
    await expect(runtime.classifier.classify(detection, evidence)).resolves.toBe(result);
    expect(classify).toHaveBeenCalledOnce();
  });

  it('keeps the renderer available while making rejected-model inference explicitly unavailable', async () => {
    const runtime = createBayesianClassifierRuntime(() => {
      throw new Error('Observable model asset does not match the v8 production admission contract');
    });

    expect(runtime).toMatchObject({
      status: 'unavailable',
      issue: 'Observable model asset does not match the v8 production admission contract',
      classifier: { modelId: 'bayesian-observable-model-unavailable' },
    });
    await expect(runtime.classifier.classify(detection, evidence)).resolves.toMatchObject({
      detectionId: detection.id,
      label: 'unknown',
      confidence: 0,
      candidates: [],
      modelId: 'bayesian-observable-model-unavailable',
      qualification: 'unavailable',
      scoreKind: 'none',
      decisionLevel: 'unknown',
      unknownReason: 'model-unavailable',
      evidence: {
        centerHz: detection.peakHz,
        sweepIds: detection.sweepIds,
        limitations: ['bayesian-model-contract-unavailable'],
      },
    });
  });
});
