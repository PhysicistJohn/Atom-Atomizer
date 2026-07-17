import type { DetectedSignal, WaveformClassification } from '@tinysa/contracts';
import type { WaveformEvidence } from '@tinysa/analysis';
import { createBundledBayesianClassifier } from './bayesian-classifier-provider.js';

export interface BayesianClassificationEngine {
  readonly modelId: string;
  classify(
    detection: DetectedSignal,
    evidence: WaveformEvidence,
    signal?: AbortSignal,
  ): Promise<WaveformClassification>;
}

export type BayesianClassifierRuntime =
  | {
    readonly status: 'ready';
    readonly classifier: BayesianClassificationEngine;
  }
  | {
    readonly status: 'unavailable';
    readonly classifier: BayesianClassificationEngine;
    readonly issue: string;
  };

/**
 * Keep a rejected generated model local to the classification capability.
 *
 * The optional build provider imports the generated-model-dependent classifier
 * only when the complete generated pair exists. Its constructor then performs
 * the full asset admission audit. Either an absent provider or a constructor
 * rejection remains local: no classifier instance escapes and no Bayesian
 * score can be produced, while the rest of the renderer remains available.
 */
export function createBayesianClassifierRuntime(
  factory: () => BayesianClassificationEngine = createBundledBayesianClassifier,
): BayesianClassifierRuntime {
  try {
    return { status: 'ready', classifier: factory() };
  } catch (error) {
    return {
      status: 'unavailable',
      classifier: new UnavailableBayesianClassifier(),
      issue: errorMessage(error),
    };
  }
}

class UnavailableBayesianClassifier implements BayesianClassificationEngine {
  readonly modelId = 'bayesian-observable-model-unavailable';

  async classify(
    detection: DetectedSignal,
    _evidence: WaveformEvidence,
    signal?: AbortSignal,
  ): Promise<WaveformClassification> {
    signal?.throwIfAborted();
    return {
      detectionId: detection.id,
      label: 'unknown',
      confidence: 0,
      candidates: [],
      modelId: this.modelId,
      qualification: 'unavailable',
      scoreKind: 'none',
      decisionLevel: 'unknown',
      classifiedAt: new Date().toISOString(),
      unknownReason: 'model-unavailable',
      evidence: {
        centerHz: detection.peakHz,
        bandwidthHz: detection.bandwidthHz,
        peakDbm: detection.peakDbm,
        sweepIds: detection.sweepIds,
        limitations: ['bayesian-model-contract-unavailable'],
      },
    };
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
