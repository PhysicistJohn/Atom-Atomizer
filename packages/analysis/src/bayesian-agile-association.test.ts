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

  it('uses the three primary advertising channels as LE-compatible evidence', () => {
    const observations = [2_402, 2_426, 2_480, 2_402, 2_426, 2_480, 2_402, 2_426]
      .map((centerMhz, index) => observation(index, centerMhz * 1_000_000));
    const evidence = bayesianFrequencyAgileActivityEvidence(observations, 48);

    expect(evidence.advertisingChannelHitCount).toBe(8);
    expect(evidence.uniqueResolutionCellCount).toBe(3);
    expect(evidence.posteriorAgileDynamicsProbability).toBeGreaterThanOrEqual(0.99);
  });

  it('matches an independent closed-form beta-binomial likelihood fixture', () => {
    const observations = Array.from({ length: 8 }, (_, index) => observation(index, 2_402_000_000 + index * 8_000_000));
    const evidence = bayesianFrequencyAgileActivityEvidence(observations, observations.length);
    const classicAllChangedProbability = 78 / 85;
    const leAllChangedProbability = 2 / 9;
    const stationaryAllChangedProbability = factorial(7)
      / Array.from({ length: 7 }, (_, index) => 20 + index).reduce((product, value) => product * value, 1);
    const expectedLogBayesFactor = Math.log(
      0.5 * classicAllChangedProbability + 0.5 * leAllChangedProbability,
    ) - Math.log(stationaryAllChangedProbability);

    expect(evidence.classicLogMarginalLikelihood).toBeCloseTo(Math.log(classicAllChangedProbability), 12);
    expect(evidence.leLogMarginalLikelihood).toBeCloseTo(Math.log(leAllChangedProbability), 12);
    expect(evidence.stationaryLogMarginalLikelihood).toBeCloseTo(Math.log(stationaryAllChangedProbability), 12);
    expect(evidence.logBayesFactor).toBeCloseTo(expectedLogBayesFactor, 12);
  });

  it('keeps the exact eight-look promotion probability below 0.001 under a fixed 5% stationary-change null', () => {
    const stationaryChangeProbability = 0.05;
    let falsePromotionProbability = 0;
    for (let mask = 0; mask < 2 ** 7; mask++) {
      let centerHz = 2_402_000_000;
      let changes = 0;
      const observations = [observation(0, centerHz)];
      for (let transition = 0; transition < 7; transition++) {
        if ((mask & (1 << transition)) !== 0) {
          changes++;
          centerHz += 8_000_000;
        }
        observations.push(observation(transition + 1, centerHz));
      }
      const evidence = bayesianFrequencyAgileActivityEvidence(observations, observations.length);
      if (bayesianFrequencyAgileActivityQualifies(evidence, false)) {
        falsePromotionProbability += stationaryChangeProbability ** changes
          * (1 - stationaryChangeProbability) ** (7 - changes);
      }
    }

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
      targetPosteriorPredictiveNullProbability: 1e-4,
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

function factorial(value: number): number {
  let result = 1;
  for (let item = 2; item <= value; item++) result *= item;
  return result;
}
