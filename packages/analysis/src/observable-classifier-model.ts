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
    /** Each calibrated support score represents one independent acquisition attempt. */
    tailCalibrationScoreUnit?: 'one-score-per-fit-eligible-acquisition-attempt-v1';
    /** Multiple correlated representatives within an attempt collapse to its least-supported representative. */
    tailCalibrationRepresentativeAggregationPolicy?: 'minimum-support-across-fit-eligible-first-ready-representatives-v1';
    /** Fit-eligible acquisition attempts contributing one score each, by canonical scenario. */
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
    /** Older policies remain readable only so the trainer can replace a checked-in asset; runtime asserts v3. */
    selectionPolicy?: 'endpoint-active-representative-v1' | 'endpoint-active-all-representatives-v2' | 'online-first-ready-all-representatives-v3';
    representativeWeightingPolicy?: 'equal-weight-per-endpoint-production-representative-v1' | 'equal-weight-per-first-ready-production-representative-v2';
    representativeEligibilityPolicy?: 'bluetooth-components-require-qualified-agile-association-v1'
      | 'observation-qualified-known-representatives-v2'
      | 'runtime-domain-qualified-known-representatives-v3';
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
