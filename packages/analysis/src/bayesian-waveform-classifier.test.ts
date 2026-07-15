import { describe, expect, it } from 'vitest';
import { BAYESIAN_WAVEFORM_MODEL, empiricalSyntheticSupportRank } from './bayesian-waveform-classifier.js';
import { BAYESIAN_OBSERVABLE_MODEL } from './models/bayesian-observable-v5.generated.js';

describe('synthetic support rank contract', () => {
  it('computes a smoothed lower-tail empirical rank with deterministic tie handling', () => {
    const reference = [0.1, 0.2, 0.2, 0.8];

    expect(empiricalSyntheticSupportRank(0.05, reference)).toBe(1 / 5);
    expect(empiricalSyntheticSupportRank(0.2, reference)).toBe(4 / 5);
    expect(empiricalSyntheticSupportRank(1, reference)).toBe(1);
  });

  it('keeps every member rank at least as large as its attempt-minimum rank', () => {
    const reference = [0.03, 0.08, 0.12, 0.4, 0.9];
    const representativeSupports = [0.07, 0.22, 0.81];
    const attemptMinimumRank = empiricalSyntheticSupportRank(Math.min(...representativeSupports), reference);

    for (const support of representativeSupports) {
      expect(empiricalSyntheticSupportRank(support, reference)).toBeGreaterThanOrEqual(attemptMinimumRank);
    }
  });

  it('treats 0.025 as a discrete engineering cutoff rather than a coverage claim', () => {
    expect(BAYESIAN_WAVEFORM_MODEL.minimumKnownSyntheticSupportRank).toBe(0.025);
    expect(empiricalSyntheticSupportRank(0, Array<number>(39).fill(0.1))).toBe(0.025);
    expect(empiricalSyntheticSupportRank(0, Array<number>(40).fill(0.1))).toBeLessThan(0.025);
  });

  it('rejects malformed reference ranks instead of silently changing their meaning', () => {
    expect(() => empiricalSyntheticSupportRank(Number.NaN, [0.1])).toThrow(/within \[0, 1\]/);
    expect(() => empiricalSyntheticSupportRank(0.1, [])).toThrow(/must not be empty/);
    expect(() => empiricalSyntheticSupportRank(0.1, [0.2, 0.1])).toThrow(/must be sorted/);
    expect(() => empiricalSyntheticSupportRank(0.1, [0.1, 1.1])).toThrow(/must be sorted/);
  });

  it('pins the non-conformal statistical interpretation in the generated asset', () => {
    expect(BAYESIAN_OBSERVABLE_MODEL.calibrationId).toBe(
      'synthetic-view-matched-stratified-online-attempt-min-support-rank-detector-conditioned-physical-uncalibrated-v10',
    );
    expect(BAYESIAN_OBSERVABLE_MODEL.calibrationId).not.toContain('conformal');
    expect(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRepresentativeSelectionPolicy)
      .toBe('online-all-ready-representatives-v1');
    expect(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationScoreUnit)
      .toBe('one-score-per-observation-domain-eligible-acquisition-attempt-v2');
    expect(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRepresentativeAggregationPolicy)
      .toBe('minimum-support-across-observation-domain-eligible-online-representatives-v3');
    expect(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRuntimeInterpretationPolicy)
      .toBe('single-representative-rank-dominates-attempt-min-rank-v1');
    expect(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationStatisticalInterpretation)
      .toBe('empirical-synthetic-reference-only-no-exchangeability-or-coverage-guarantee-v1');
    expect(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.representativeEligibilityPolicy)
      .toBe('observation-only-hypothesis-domain-v5');
    expect(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.signalLabProductionAcquisitionRegime).toEqual({
      id: 'signal-lab-recommended-span-grid-with-session-sequence-nuisance-v1',
      geometry: {
        id: 'signal-lab-recommended-span-450-point-grid-v1',
        sourceKind: 'signal-lab',
        kind: 'recommended-span-inclusive-grid',
        sweepPoints: 450,
        spanPolicy: 'canonical-recommended-span-v1',
        resolutionScalePolicy: 'recommended-span-divided-by-points-minus-one-v1',
      },
      temporalSchedules: [
        { id: 'contiguous-from-zero-v1', sourceLookIndexOffset: 0, skipAfterSpectrumOpportunities: null, skippedSourceOpportunities: 0 },
        { id: 'post-eight-spectrum-single-capture-skip-v1', sourceLookIndexOffset: 0, skipAfterSpectrumOpportunities: 8, skippedSourceOpportunities: 1 },
        { id: 'profile-sequence-offset-225-post-eight-spectrum-single-capture-skip-v1', sourceLookIndexOffset: 225, skipAfterSpectrumOpportunities: 8, skippedSourceOpportunities: 1 },
      ],
      componentFitIncluded: true,
      tailCalibrationIncluded: true,
    });
    expect(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.detectedPowerSynthesisFilterPolicy).toEqual({
      id: 'explicit-generator-filter-width-by-acquisition-regime-v1',
      divisorAcquisitionRegimes: 'match-swept-spectrum-actual-rbw-nuisance-v1',
      signalLabProductionAcquisitionRegimes: 'fixed-generator-internal-width-v1',
      signalLabProductionSynthesisFilterWidthHz: 100_000,
      measurementActualRbwQualification: 'unavailable',
    });
    expect(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.productionAcquisitionRegimeHighSnrSeedCoveragePolicy)
      .toEqual({
        id: 'detector-conditioned-production-regime-presence-v1',
        minimumDistinctSeedsPerHighSnrCell: 1,
        globalCoveragePolicy: 'all-seeds-at-one-or-more-regimes-except-declared-sparse-asynchronous-scenarios-v1',
      });
  });
});
