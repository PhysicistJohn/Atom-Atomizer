import type { ClassLikelihoodModel } from './bayesian-predictive.js';

export const OBSERVABLE_LEAF_CLASSES = [
  'cw-like',
  'am-dsb-full-carrier-like',
  'fm-angle-modulated-like',
  'gsm-like',
  'lte-fdd-like',
  'lte-tdd-like',
  'nr-fdd-like',
  'nr-tdd-like',
  'wifi-hr-dsss-like',
  'wifi-ofdm-like',
  'bluetooth-like',
  'unknown-signal',
] as const;

export type ObservableLeafClass = typeof OBSERVABLE_LEAF_CLASSES[number];
export type ObservableDecisionClass = Exclude<ObservableLeafClass, 'unknown-signal'>
  | 'cellular-ofdm-ambiguous'
  | 'lte-like'
  | 'nr-like'
  | 'wifi-like';

export interface ObservableClassifierModelAsset {
  id: string;
  corpusVersion: string;
  sourceCommit: string;
  corpusSourceManifest: {
    schemaVersion: 1;
    hashAlgorithm: 'sha256';
    artifacts: readonly {
      /** Path relative to the SignalLab repository root. */
      path: string;
      sha256: string;
    }[];
  };
  /** SHA-256 of the canonical JSON serialization of corpusSourceManifest. */
  corpusSha256: string;
  preprocessing: string;
  priorId: string;
  calibrationId: string;
  generatedAt: string;
  dimensions: readonly string[];
  trainingMatrix: {
    snrDb: readonly number[];
    rbwDivisors: readonly number[];
    seeds: readonly number[];
    /** Complete fitted acquisition cells, including named production regimes that are not honest global RBW divisors. */
    fittingAcquisitionRegimeIds?: readonly string[];
    /**
     * The production SignalLab sweep geometry and session-sequence phase
     * schedules included in both component fitting and independent-seed tail
     * calibration. This is explicit because its effective occupied-bandwidth
     * divisor varies by scenario and must not be serialized as a fake scalar.
     */
    signalLabProductionAcquisitionRegime?: {
      id: 'signal-lab-recommended-span-grid-with-session-sequence-nuisance-v1';
      geometry: {
        id: 'signal-lab-recommended-span-450-point-grid-v1';
        sourceKind: 'signal-lab';
        kind: 'recommended-span-inclusive-grid';
        sweepPoints: 450;
        spanPolicy: 'canonical-recommended-span-v1';
        resolutionScalePolicy: 'recommended-span-divided-by-points-minus-one-v1';
      };
      temporalSchedules: readonly {
        id: string;
        sourceLookIndexOffset: number;
        skipAfterSpectrumOpportunities: number | null;
        skippedSourceOpportunities: number;
      }[];
      componentFitIncluded: true;
      tailCalibrationIncluded: true;
    };
    /**
     * Generator-only detected-power filter geometry used by the synthetic
     * reference matrix. It is never projected as measured RBW evidence.
     */
    detectedPowerSynthesisFilterPolicy?: {
      id: 'explicit-generator-filter-width-by-acquisition-regime-v1';
      divisorAcquisitionRegimes: 'match-swept-spectrum-actual-rbw-nuisance-v1';
      signalLabProductionAcquisitionRegimes: 'fixed-generator-internal-width-v1';
      signalLabProductionSynthesisFilterWidthHz: 100_000;
      measurementActualRbwQualification: 'unavailable';
    };
    productionAcquisitionRegimeHighSnrSeedCoveragePolicy?: {
      id: 'detector-conditioned-production-regime-presence-v1';
      minimumDistinctSeedsPerHighSnrCell: number;
      globalCoveragePolicy: 'all-seeds-at-one-or-more-regimes-except-declared-sparse-asynchronous-scenarios-v1';
    };
    classificationSweeps?: number;
    observationOpportunityHorizons?: {
      standard: number;
      fullBand2g4: number;
    };
    /** @deprecated Present only on pre-v5 generated assets. */
    observationOpportunitiesPerExample?: number;
    /** @deprecated Present only on pre-v4 generated assets. */
    sweepsPerExample?: number;
    tailCalibrationSeeds?: readonly number[];
    tailCalibrationRbwDivisors?: readonly number[];
    /** Complete independent-seed calibration cells, including named production regimes. */
    tailCalibrationAcquisitionRegimeIds?: readonly string[];
    /** Each score represents one distinct observation-domain-eligible acquisition cell; this does not assert statistical independence. */
    tailCalibrationScoreUnit?: 'one-score-per-fit-eligible-acquisition-attempt-v1'
      | 'one-score-per-observation-domain-eligible-acquisition-attempt-v2';
    /** Every ready representative at every online opportunity enters the conservative attempt minimum. */
    tailCalibrationRepresentativeSelectionPolicy?: 'online-all-ready-representatives-v1';
    /** Multiple correlated representatives within an attempt collapse to its least-supported representative. */
    tailCalibrationRepresentativeAggregationPolicy?: 'minimum-support-across-fit-eligible-first-ready-representatives-v1'
      | 'minimum-support-across-fit-eligible-online-representatives-v2'
      | 'minimum-support-across-observation-domain-eligible-online-representatives-v3';
    /** A member representative's monotone rank cannot be smaller than its attempt-minimum rank. */
    tailCalibrationRuntimeInterpretationPolicy?: 'single-representative-rank-dominates-attempt-min-rank-v1';
    /** Fixed synthetic nuisance grids are reference data, not exchangeable operational calibration samples. */
    tailCalibrationStatisticalInterpretation?: 'empirical-synthetic-reference-only-no-exchangeability-or-coverage-guarantee-v1';
    /** Observation-domain-eligible acquisition attempts contributing one score each, by canonical scenario. */
    tailCalibrationAttemptCountsByScenario?: Readonly<Record<string, number>>;
    detectorConditionedFitMisses?: readonly string[];
    detectorConditionedCalibrationMisses?: readonly string[];
    fitEligibilityExcludedFitAttempts?: readonly string[];
    fitEligibilityExcludedCalibrationAttempts?: readonly string[];
    scenarioExcludedFromComponentFitIds?: readonly string[];
    /**
     * Unknown-source scenarios that are exactly equivalent to one or more
     * fitted observable classes. They are validation nulls only: fitting them
     * as unknown components would duplicate a likelihood under another label.
     */
    exactObservableEquivalenceNullScenarioIds?: readonly string[];
    /** Known-class scenarios retained only to test/report acquisition non-admission. */
    knownAcquisitionValidationOnlyScenarioIds?: readonly string[];
    /** Older policies remain readable only so the trainer can replace a checked-in asset; runtime asserts v5. */
    selectionPolicy?: 'endpoint-active-representative-v1' | 'endpoint-active-all-representatives-v2' | 'online-first-ready-all-representatives-v3';
    representativeWeightingPolicy?: 'equal-weight-per-endpoint-production-representative-v1' | 'equal-weight-per-first-ready-production-representative-v2';
    representativeEligibilityPolicy?: 'bluetooth-components-require-qualified-agile-association-v1'
      | 'observation-qualified-known-representatives-v2'
      | 'runtime-domain-qualified-known-representatives-v3'
      | 'observation-only-hypothesis-domain-v4'
      | 'observation-only-hypothesis-domain-v5';
  };
  classModels: readonly (ClassLikelihoodModel & { id: ObservableLeafClass })[];
}

export const observableClassDefinitions: Readonly<Record<ObservableDecisionClass, { label: string; family: string; claim: string }>> = {
  'cw-like': { label: 'CW-like carrier', family: 'analog', claim: 'RBW-limited stable carrier evidence' },
  'am-dsb-full-carrier-like': { label: 'DSB full-carrier AM-like', family: 'analog', claim: 'Carrier, mirrored sideband and envelope evidence' },
  'fm-angle-modulated-like': { label: 'FM / angle-modulated-like', family: 'analog', claim: 'Symmetric frequency-spread evidence; not phase or protocol identity' },
  'gsm-like': { label: 'GSM / GERAN-like', family: 'cellular', claim: '200 kHz GERAN-compatible spectral/timing evidence' },
  'lte-fdd-like': { label: 'LTE FDD-like', family: 'cellular', claim: 'LTE-compatible width and FDD-context evidence' },
  'lte-tdd-like': { label: 'LTE TDD-like', family: 'cellular', claim: 'LTE-compatible width and TDD-context/envelope evidence' },
  'nr-fdd-like': { label: '5G NR FDD-like', family: 'cellular', claim: 'NR-compatible width and FDD-context evidence' },
  'nr-tdd-like': { label: '5G NR TDD-like', family: 'cellular', claim: 'NR-compatible width and TDD-context/envelope evidence' },
  'cellular-ofdm-ambiguous': { label: 'OFDM-shaped · LTE/NR-compatible', family: 'ofdm', claim: 'Wide OFDM morphology; generic OFDM, LTE and NR remain observationally equivalent' },
  'lte-like': { label: 'LTE-compatible OFDM · duplex ambiguous', family: 'ofdm', claim: 'LTE-shaped evidence without protocol or FDD/TDD identity' },
  'nr-like': { label: '5G NR-compatible OFDM · duplex ambiguous', family: 'ofdm', claim: 'NR-shaped evidence without protocol or FDD/TDD identity' },
  'wifi-hr-dsss-like': { label: 'Wi-Fi HR-DSSS-like', family: 'wifi', claim: 'DSSS/CCK-like 802.11 channel evidence' },
  'wifi-ofdm-like': { label: 'Wi-Fi OFDM-like', family: 'wifi', claim: '802.11 OFDM width/traffic evidence; generation unresolved' },
  'wifi-like': { label: '802.11-compatible channel morphology · PHY unresolved', family: 'wifi', claim: 'Scalar channel morphology compatible with 802.11; proprietary DSSS/OFDM and protocol identity remain unresolved' },
  'bluetooth-like': { label: '2.4 GHz agile activity · Bluetooth-compatible', family: 'bluetooth', claim: 'Bluetooth-compatible activity transitions without Classic/LE, protocol, or emitter identity resolution' },
};
