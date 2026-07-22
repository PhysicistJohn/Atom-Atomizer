import type { ModulationClassification } from './embedding-classifier-runtime.js';

/** Wall-clock horizon represented by the live classification trend. */
export const DETECT_CONSENSUS_WINDOW_MS = 500;

/** One independently classified capture in the rolling wall-clock window. */
export interface ModulationConsensusSample {
  readonly completedAtMilliseconds: number;
  readonly result: ModulationClassification;
}

/** Successful classifier samples retained for one source/configuration scope. */
export interface ModulationConsensusState {
  readonly samples: readonly ModulationConsensusSample[];
}

export interface ModulationConsensusProjection {
  readonly sampleCount: number;
  readonly result: ModulationClassification;
}

export function emptyModulationConsensus(): ModulationConsensusState {
  return { samples: [] };
}

/**
 * Add one instantaneous classifier sample and project the equal-sample mean
 * posterior over the trailing 500 ms. The window is timestamp bounded rather
 * than count bounded: at the normal 60 Hz acquisition ceiling it contains
 * roughly 30 successful samples, while a slower worker retains fewer. Samples
 * exactly 500 ms old remain in the inclusive window.
 */
export function accumulateModulationConsensus(
  previous: ModulationConsensusState,
  result: ModulationClassification,
  completedAtMilliseconds: number,
): { readonly state: ModulationConsensusState; readonly projection: ModulationConsensusProjection } {
  if (!Number.isFinite(completedAtMilliseconds)) {
    throw new RangeError('Classification completion timestamp must be finite');
  }
  const newest = previous.samples.at(-1);
  if (newest && completedAtMilliseconds < newest.completedAtMilliseconds) {
    throw new RangeError('Classification sample timestamps must be monotonic');
  }
  const cutoff = completedAtMilliseconds - DETECT_CONSENSUS_WINDOW_MS;
  const samples = [
    ...previous.samples.filter((sample) => sample.completedAtMilliseconds >= cutoff),
    { completedAtMilliseconds, result },
  ];
  const posteriorMass: Record<string, number> = {};
  for (const sample of samples) {
    const posterior = sample.result.posterior
      ?? Object.fromEntries(sample.result.candidates.map((candidate) => [candidate.label, candidate.confidence]));
    for (const [label, confidence] of Object.entries(posterior)) {
      if (!Number.isFinite(confidence) || confidence < 0) continue;
      posteriorMass[label] = (posteriorMass[label] ?? 0) + confidence;
    }
  }
  const sampleCount = samples.length;
  const ranked = Object.entries(posteriorMass)
    .map(([label, total]) => ({ label, confidence: total / sampleCount }))
    .sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label));
  const posterior = Object.fromEntries(ranked.map(({ label, confidence }) => [label, confidence]));
  const unknownSamples = samples.filter((sample) => sample.result.isUnknown);
  if (unknownSamples.length > sampleCount / 2) {
    const representative = unknownSamples.at(-1)!.result;
    const projection: ModulationClassification = {
      ...representative,
      family: 'unknown',
      modulation: 'unknown',
      // For an unknown trend, confidence is the integrated open-set vote share;
      // the ranked candidates remain the mean conditional family posterior.
      confidence: unknownSamples.length / sampleCount,
      isUnknown: true,
      posterior,
      candidates: ranked.slice(0, 4),
      topLeaf: undefined,
    };
    return { state: { samples }, projection: { sampleCount, result: projection } };
  }
  const winner = ranked[0]?.label ?? result.family;
  const representative = [...samples].reverse()
    .find((sample) => !sample.result.isUnknown && sample.result.family === winner)?.result
    ?? result;
  const matchesWinner = !representative.isUnknown && representative.family === winner;
  const candidates = [
    { label: winner, confidence: posteriorMass[winner]! / sampleCount },
    ...ranked.filter((candidate) => candidate.label !== winner),
  ].slice(0, 4);
  const projection: ModulationClassification = {
    ...representative,
    family: winner,
    modulation: matchesWinner ? representative.modulation : winner,
    confidence: candidates[0]!.confidence,
    isUnknown: false,
    posterior,
    candidates,
    topLeaf: matchesWinner ? representative.topLeaf : undefined,
  };
  return {
    state: { samples },
    projection: { sampleCount, result: projection },
  };
}
