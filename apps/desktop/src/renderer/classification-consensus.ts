import type { ModulationClassification } from './embedding-classifier-runtime.js';

export const DETECT_CONSENSUS_FIFO_LOOKS = 8;

/** The newest classifier results retained for one global source/configuration scope. */
export interface ModulationConsensusState {
  readonly lookCount: number;
  readonly frames: readonly ModulationClassification[];
}

export interface ModulationConsensusProjection {
  readonly lookCount: number;
  readonly result: ModulationClassification;
}

export function emptyModulationConsensus(): ModulationConsensusState {
  return { lookCount: 0, frames: [] };
}

/**
 * Push one independently classified look into an eight-look FIFO and project
 * its arithmetic-mean posterior. At the 500 ms sampler cadence this is a live
 * four-second evidence window: new evidence continually replaces stale looks
 * instead of an old, long-running consensus becoming impossible to move.
 */
export function accumulateModulationConsensus(
  previous: ModulationConsensusState,
  result: ModulationClassification,
): { readonly state: ModulationConsensusState; readonly projection: ModulationConsensusProjection } {
  const frames = [...previous.frames, result].slice(-DETECT_CONSENSUS_FIFO_LOOKS);
  const posteriorMass: Record<string, number> = {};
  for (const frame of frames) for (const candidate of frame.candidates) {
    if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0) continue;
    posteriorMass[candidate.label] = (posteriorMass[candidate.label] ?? 0) + candidate.confidence;
  }
  const lookCount = frames.length;
  const ranked = Object.entries(posteriorMass)
    .map(([label, total]) => ({ label, confidence: total / lookCount }))
    .sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label));
  const winner = ranked[0]?.label ?? result.family;
  const representative = [...frames].reverse().find((frame) => frame.family === winner) ?? result;
  const matchesWinner = representative.family === winner;
  const candidates = [
    { label: winner, confidence: posteriorMass[winner]! / lookCount },
    ...ranked.filter((candidate) => candidate.label !== winner),
  ].slice(0, 4);
  const projection: ModulationClassification = {
    ...representative,
    family: winner,
    modulation: matchesWinner ? representative.modulation : winner,
    confidence: candidates[0]!.confidence,
    isUnknown: matchesWinner ? representative.isUnknown : false,
    candidates,
    topLeaf: matchesWinner ? representative.topLeaf : undefined,
  };
  return {
    state: { lookCount, frames },
    projection: { lookCount, result: projection },
  };
}
