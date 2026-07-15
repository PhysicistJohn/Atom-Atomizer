import { describe, expect, it } from 'vitest';
import type { ActivityAssociationObservation } from '@tinysa/contracts';
import {
  bayesianFrequencyAgileActivityEvidence,
  bayesianFrequencyAgileActivityQualifies,
} from './bayesian-agile-association.js';

describe('Bayesian frequency-agile activity evidence', () => {
  it('promotes a changed multi-cell sequence and conditions out missed opportunities', () => {
    const observations = [2_402, 2_410, 2_418, 2_426, 2_434, 2_442, 2_450, 2_480]
      .map((centerMhz, index) => observation(index, centerMhz * 1_000_000));
    const compact = bayesianFrequencyAgileActivityEvidence(observations, observations.length);
    const sparse = bayesianFrequencyAgileActivityEvidence(observations, 96);

    expect(compact).toMatchObject({
      positiveObservationCount: 8,
      transitionCount: 7,
      changedTransitionCount: 7,
      uniqueResolutionCellCount: 8,
    });
    expect(compact.logBayesFactor).toBeCloseTo(sparse.logBayesFactor, 12);
    expect(compact.posteriorAgileDynamicsProbability).toBeGreaterThanOrEqual(0.99);
    expect(bayesianFrequencyAgileActivityQualifies(compact, false)).toBe(true);
  });

  it('counts the three primary-channel centers without treating them as an LE protocol likelihood', () => {
    const observations = [2_402, 2_426, 2_480, 2_402, 2_426, 2_480, 2_402, 2_426]
      .map((centerMhz, index) => observation(index, centerMhz * 1_000_000));
    const evidence = bayesianFrequencyAgileActivityEvidence(observations, 48);

    expect(evidence.primaryChannelCenterHitCount).toBe(8);
    expect(evidence.uniqueResolutionCellCount).toBe(3);
    expect(evidence.posteriorAgileDynamicsProbability).toBeGreaterThanOrEqual(0.99);
  });

  it('matches independent closed-form agile marginals and the fixed stationary likelihood', () => {
    const observations = Array.from({ length: 8 }, (_, index) => observation(index, 2_402_000_000 + index * 8_000_000));
    const evidence = bayesianFrequencyAgileActivityEvidence(observations, observations.length);
    const fullBand79CellAllChangedProbability = 78 / 85;
    const threePrimaryChannelAllChangedProbability = 2 / 9;
    const stationaryAllChangedProbability = 0.05 ** 7;
    const expectedLogBayesFactor = Math.log(
      0.5 * fullBand79CellAllChangedProbability + 0.5 * threePrimaryChannelAllChangedProbability,
    ) - Math.log(stationaryAllChangedProbability);

    expect(evidence.fullBand79CellAgileLogMarginalLikelihood).toBeCloseTo(Math.log(fullBand79CellAllChangedProbability), 12);
    expect(evidence.threePrimaryChannelAgileLogMarginalLikelihood).toBeCloseTo(Math.log(threePrimaryChannelAllChangedProbability), 12);
    expect(evidence.stationaryLogMarginalLikelihood).toBeCloseTo(Math.log(stationaryAllChangedProbability), 12);
    expect(evidence.logBayesFactor).toBeCloseTo(expectedLogBayesFactor, 12);
  });

  it('keeps exact sequential promotion through 96 positive looks below 0.001 under its stationary null', () => {
    const stationaryChangeProbability = 0.05;
    // Dynamic programming over the sufficient statistic (transition count,
    // changed-transition count). This deliberately omits the independent
    // three-resolution-cell guard, so it is a conservative exact upper bound.
    let unpromoted = new Map<number, number>([[0, 1]]);
    let falsePromotionProbability = 0;
    for (let transitions = 1; transitions < 96; transitions++) {
      const next = new Map<number, number>();
      for (const [changed, pathProbability] of unpromoted) {
        for (const didChange of [0, 1] as const) {
          const nextChanged = changed + didChange;
          const probability = pathProbability * (didChange
            ? stationaryChangeProbability
            : 1 - stationaryChangeProbability);
          if (transitions + 1 >= 8 && posteriorAgileProbability(nextChanged, transitions) >= 0.99) {
            falsePromotionProbability += probability;
          } else {
            next.set(nextChanged, (next.get(nextChanged) ?? 0) + probability);
          }
        }
      }
      unpromoted = next;
    }

    expect(falsePromotionProbability).toBeCloseTo(1.3657385209e-5, 12);
    expect(falsePromotionProbability).toBeLessThan(0.001);
  });

  it('rejects a persistent local source and too little positive evidence', () => {
    const stationary = Array.from({ length: 12 }, (_, index) => observation(index, 2_440_000_000));
    const evidence = bayesianFrequencyAgileActivityEvidence(stationary, 12);

    expect(evidence.changedTransitionCount).toBe(0);
    expect(evidence.uniqueResolutionCellCount).toBe(1);
    expect(evidence.posteriorAgileDynamicsProbability).toBeLessThan(0.01);
    expect(bayesianFrequencyAgileActivityQualifies(evidence, true)).toBe(false);
    expect(bayesianFrequencyAgileActivityQualifies(
      bayesianFrequencyAgileActivityEvidence(stationary.slice(0, 2), 2),
      false,
    )).toBe(false);
  });

  it('rejects malformed provenance and impossible opportunity counts', () => {
    expect(() => bayesianFrequencyAgileActivityEvidence([], 0)).toThrow(/at least one positive/i);
    expect(() => bayesianFrequencyAgileActivityEvidence([observation(0, 2_402_000_000)], 0)).toThrow(/opportunity count/i);
    expect(() => bayesianFrequencyAgileActivityEvidence([
      { ...observation(0, 2_402_000_000), rbwHz: 0 },
    ], 1)).toThrow(/invalid local-look provenance/i);
    const weak = observation(0, 2_402_000_000);
    expect(() => bayesianFrequencyAgileActivityEvidence([{
      ...weak,
      localBayesianEvidence: { ...weak.localBayesianEvidence, posteriorSignalProbability: 0.98 },
    }], 1)).toThrow(/invalid local-look provenance/i);
    expect(() => bayesianFrequencyAgileActivityEvidence([{
      ...weak,
      localBayesianEvidence: {
        ...weak.localBayesianEvidence,
        posteriorPredictiveNullProbability: weak.localBayesianEvidence.targetPosteriorPredictiveNullProbability * 2,
      },
    }], 1)).toThrow(/invalid local-look provenance/i);
  });
});

function observation(index: number, centerHz: number): ActivityAssociationObservation {
  return {
    sweepId: `sweep-${index}`,
    trackId: `track-${index}`,
    centerHz,
    startHz: centerHz - 250_000,
    stopHz: centerHz + 250_000,
    rbwHz: 200_000,
    binWidthHz: 200_000,
    detectorId: 'bayesian-exponential-multiscale-cfar-v3',
    localBayesianEvidence: {
      modelId: 'bayesian-exponential-multiscale-cfar-v3',
      posteriorScope: 'selected-local-region',
      priorSignalProbability: 0.01,
      posteriorSignalProbability: 0.999,
      logBayesFactor: 12,
      effectiveIndependentBins: 1,
      effectiveReferenceCells: 24,
      noiseShape: 1,
      posteriorPredictiveNullProbability: 1e-6,
      targetPosteriorPredictiveNullProbability: 1e-5,
      targetSweepFalseAlarmProbability: 0.001,
      multiplicityAdjustedTests: 100,
      testedRegionStartHz: centerHz - 250_000,
      testedRegionStopHz: centerHz + 250_000,
      qualification: 'ideal-exponential-not-physically-calibrated',
      noiseSigmaDb: 1,
      observedMeanShiftDb: 20,
      looks: 1,
    },
  };
}

function posteriorAgileProbability(changed: number, total: number): number {
  const logBeta = (alpha: number, beta: number): number =>
    logGammaFixture(alpha) + logGammaFixture(beta) - logGammaFixture(alpha + beta);
  const marginal = (alpha: number, beta: number): number =>
    logBeta(changed + alpha, total - changed + beta) - logBeta(alpha, beta);
  const fullBand79Cell = marginal(78, 1);
  const threePrimaryChannel = marginal(2, 1);
  const maximum = Math.max(fullBand79Cell, threePrimaryChannel);
  const agile = maximum + Math.log(0.5 * Math.exp(fullBand79Cell - maximum) + 0.5 * Math.exp(threePrimaryChannel - maximum));
  const stationary = changed * Math.log(0.05) + (total - changed) * Math.log(0.95);
  const logOdds = Math.log(0.01 / 0.99) + agile - stationary;
  return logOdds >= 0 ? 1 / (1 + Math.exp(-logOdds)) : Math.exp(logOdds) / (1 + Math.exp(logOdds));
}

// Integer arguments only in this independent fixture: log Gamma(n) = log((n-1)!).
function logGammaFixture(value: number): number {
  let result = 0;
  for (let item = 2; item < value; item++) result += Math.log(item);
  return result;
}
