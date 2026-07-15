import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import {
  BayesianWaveformClassifier,
  BAYESIAN_WAVEFORM_MODEL,
  inferPosterior,
  knownModelSupportRank,
  selectObservableDecision,
} from '../packages/analysis/src/bayesian-waveform-classifier.js';
import { BAYESIAN_OBSERVABLE_MODEL } from '../packages/analysis/src/models/bayesian-observable-v5.generated.js';
import { BAYESIAN_OBSERVABLE_MODEL_SHA256 } from '../packages/analysis/src/models/bayesian-observable-v5.manifest.generated.js';
import { OBSERVABLE_LEAF_CLASSES, type ObservableLeafClass } from '../packages/analysis/src/observable-classifier-model.js';
import {
  extractObservableFeatures,
  observableAssociationEvidenceIsCurrentlyQualified,
  type ObservableFeatureObservation,
} from '../packages/analysis/src/observable-features.js';
import { observableRepresentativeIsInClassDomain } from '../packages/analysis/src/observable-hypothesis-domain.js';
import {
  logSumExp,
  mixtureLogLikelihood,
  studentTModelTailProbability,
  type PosteriorCandidate,
} from '../packages/analysis/src/bayesian-predictive.js';
import { classificationRepresentatives, SignalDetector, SignalTracker } from '../packages/analysis/src/index.js';
import {
  CLASSIFICATION_CORPUS_VERSION,
  canonicalClassificationScenarios,
  synthesizeCanonicalObservation,
  type CanonicalClassificationScenario,
  type ObservableSignalClass,
} from '../../TinySA_SignalLab/src/classification-corpus.js';
import {
  CANONIZED_REPLAY_DETECTED_POWER_SYNTHESIS_FILTER_WIDTH_HZ,
} from '../../TinySA_SignalLab/src/waveforms.js';
import {
  detectedPowerTimeseriesConfigurationSchema,
  projectDetectedPowerTuneHz,
  SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1,
  type DetectedSignal,
  type DeviceIdentity,
  type SignalDetectionConfig,
  type Sweep,
  type ZeroSpanCapture,
} from '../packages/contracts/src/index.js';

// Independent of both model fitting/calibration and the transition-model
// design audit. Eight phase/noise shifts make the finite-acquisition coverage
// gate a genuine replicated test rather than a two-seed smoke check.
const NUISANCE_SHIFT_SEEDS = [
  13_001, 13_019, 13_037, 13_063, 13_081, 13_099, 13_127, 13_151,
] as const;
const SNR_DB = [6, 10, 16, 24, 32] as const;
const HIGH_SNR_MINIMUM_DB = 24;
// These partitions are validator-owned pins. They intentionally duplicate the
// trainer policy instead of accepting model metadata as ground truth: a model
// cannot redefine its own holdout set and thereby make validation pass.
const PINNED_FITTED_UNKNOWN_SCENARIO_IDS = [
  'unknown-narrow-fsk',
  'unknown-802154',
] as const;
const PINNED_STRICT_UNKNOWN_HOLDOUT_SCENARIO_IDS = [
  'unknown-impulsive',
] as const;
const PINNED_OBSERVABLE_AMBIGUITY_STRESS_SCENARIO_IDS = [
  'unknown-chirp',
  'unknown-regular-cw-comb-4',
  'unknown-regular-cw-comb-5',
  'unknown-irregular-cw-multitone-100-210-370k',
  'unknown-stationary-intermittent-2g4',
  'unknown-simultaneous-1mhz-raster-2g4',
  'unknown-interleaved-four-channel-2g4',
  'unknown-proprietary-off-raster-fhss-2g4',
] as const;
const PINNED_EXACT_OBSERVABLE_EQUIVALENCE_PAIRS = [
  { nullScenarioId: 'unknown-instrument-spur-rbw-line', referenceScenarioId: 'cw-rbw-line' },
  { nullScenarioId: 'unknown-independent-am-equivalent-three-tone', referenceScenarioId: 'am-dsb-25k' },
  { nullScenarioId: 'unknown-independent-fm-equivalent-bessel-comb', referenceScenarioId: 'fm-beta-3' },
  { nullScenarioId: 'unknown-generic-ofdm-20m', referenceScenarioId: 'lte-band3-fdd-20m' },
  { nullScenarioId: 'unknown-generic-tdd-ofdm-10m', referenceScenarioId: 'lte-band38-tdd-10m' },
  { nullScenarioId: 'unknown-generic-ofdm-80m', referenceScenarioId: 'wifi-ofdm-80m' },
  { nullScenarioId: 'unknown-proprietary-dsss-22m', referenceScenarioId: 'wifi-hr-dsss-11m' },
] as const;
const PINNED_EXACT_OBSERVABLE_EQUIVALENCE_NULL_SCENARIO_IDS = PINNED_EXACT_OBSERVABLE_EQUIVALENCE_PAIRS
  .map((pair) => pair.nullScenarioId);
const PINNED_KNOWN_ACQUISITION_VALIDATION_ONLY_SCENARIO_IDS = [
  'gsm-900-tdma',
] as const;
const PINNED_SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS = [
  ...PINNED_KNOWN_ACQUISITION_VALIDATION_ONLY_SCENARIO_IDS,
  ...PINNED_STRICT_UNKNOWN_HOLDOUT_SCENARIO_IDS,
  ...PINNED_OBSERVABLE_AMBIGUITY_STRESS_SCENARIO_IDS,
  ...PINNED_EXACT_OBSERVABLE_EQUIVALENCE_NULL_SCENARIO_IDS,
] as const;
// The one-timeslot GSM case is deliberately acquisition-limited. The chirp is
// an admitted observable-ambiguity stress case, not an expected non-admission.
// Any change to this exception list is a validator policy change, not
// something model metadata may silently broaden.
const PINNED_EXPECTED_CLASSIFICATION_NON_ADMISSION_SCENARIO_IDS = [
  'gsm-900-tdma',
] as const;
const EXACT_EQUIVALENCE_NUMERICAL_TOLERANCE = 1e-11;
// Held-out geometric interstitials between the fit/calibration divisors
// [12, 20, 35, 55, 80, 120]. None is a training or calibration grid point;
// the temporal schedule below also uses disjoint source look indices.
const RBW_DIVISORS = [15.5, 44, 98] as const;
const ADMISSION_SEED_COVERAGE_SNR_DB = [24, 32] as const;
const BLE_ADVERTISING_MINIMUM_SEED_COVERAGE = 0.5;
const ROLLING_MINIMUM_OVERALL_KNOWN_COVERAGE = 0.95;
const ROLLING_MINIMUM_OVERALL_HIERARCHICAL_ACCURACY = 0.95;
const ROLLING_MINIMUM_PER_SCENARIO_KNOWN_COVERAGE = 0.9;
const ROLLING_MINIMUM_PER_SCENARIO_HIERARCHICAL_ACCURACY = 0.9;
const CLASSIFICATION_ADMISSIONS = 8;
// A finite asynchronous Wi-Fi burst/noise phase missed the eight-admission
// requirement for one of eight held-out seeds at 24 dB under 24 looks.  The
// runtime has no 24-look stop condition, so validation uses 32 standard
// opportunities rather than weakening seed coverage or detector thresholds.
const STANDARD_OBSERVATION_OPPORTUNITIES = 32;
const FULL_BAND_2G4_OBSERVATION_OPPORTUNITIES = 96;
const FULL_BAND_2G4_START_HZ = 2_402_000_000;
const FULL_BAND_2G4_STOP_HZ = 2_480_000_000;
const SELECTION_POLICY = 'online-first-ready-all-representatives-v3' as const;
const PINNED_TAIL_CALIBRATION_SCORE_UNIT = 'one-score-per-observation-domain-eligible-acquisition-attempt-v2' as const;
const PINNED_TAIL_CALIBRATION_SELECTION_POLICY = 'online-all-ready-representatives-v1' as const;
const PINNED_TAIL_CALIBRATION_AGGREGATION_POLICY = 'minimum-support-across-observation-domain-eligible-online-representatives-v3' as const;
const PINNED_TAIL_CALIBRATION_RUNTIME_INTERPRETATION_POLICY = 'single-representative-rank-dominates-attempt-min-rank-v1' as const;
const PINNED_TAIL_CALIBRATION_STATISTICAL_INTERPRETATION = 'empirical-synthetic-reference-only-no-exchangeability-or-coverage-guarantee-v1' as const;
const PINNED_TAIL_CALIBRATION_SNR_DB = [6, 10, 16, 24, 32] as const;
const PINNED_TAIL_CALIBRATION_RBW_DIVISORS = [12, 20, 35, 55, 80, 120] as const;
const PINNED_TAIL_CALIBRATION_SEEDS = [6_407, 6_419, 6_421, 6_449, 6_451, 6_469, 6_473, 6_481] as const;
const PINNED_SIGNAL_LAB_PRODUCTION_GEOMETRY = Object.freeze({
  id: 'signal-lab-recommended-span-450-point-grid-v1',
  sourceKind: 'signal-lab',
  kind: 'recommended-span-inclusive-grid',
  sweepPoints: 450,
  spanPolicy: 'canonical-recommended-span-v1',
  resolutionScalePolicy: 'recommended-span-divided-by-points-minus-one-v1',
} as const);
interface PinnedTemporalSchedule {
  readonly id: string;
  readonly sourceLookIndexOffset: number;
  readonly skipAfterSpectrumOpportunities: number | null;
  readonly skippedSourceOpportunities: number;
}
const PINNED_SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES: readonly PinnedTemporalSchedule[] = Object.freeze([
  Object.freeze({ id: 'contiguous-from-zero-v1', sourceLookIndexOffset: 0, skipAfterSpectrumOpportunities: null, skippedSourceOpportunities: 0 } as const),
  Object.freeze({ id: 'post-eight-spectrum-single-capture-skip-v1', sourceLookIndexOffset: 0, skipAfterSpectrumOpportunities: 8, skippedSourceOpportunities: 1 } as const),
  Object.freeze({ id: 'profile-sequence-offset-225-post-eight-spectrum-single-capture-skip-v1', sourceLookIndexOffset: 225, skipAfterSpectrumOpportunities: 8, skippedSourceOpportunities: 1 } as const),
] as const);
const PINNED_VALIDATION_TEMPORAL_SCHEDULE: PinnedTemporalSchedule = Object.freeze({
  // 347 is the exact start of the final BLE profile in the owned live matrix
  // (ten standard profiles at 25 measurements, then 96 spectra plus one
  // envelope for Bluetooth Classic). It is outside every fitted look index.
  id: 'held-out-offset-347-post-eleven-single-skip-v1',
  sourceLookIndexOffset: 347,
  skipAfterSpectrumOpportunities: 11,
  skippedSourceOpportunities: 1,
} as const);
const PINNED_SIGNAL_LAB_PRODUCTION_ACQUISITION_REGIME = Object.freeze({
  id: 'signal-lab-recommended-span-grid-with-session-sequence-nuisance-v1',
  geometry: PINNED_SIGNAL_LAB_PRODUCTION_GEOMETRY,
  temporalSchedules: PINNED_SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES,
  componentFitIncluded: true,
  tailCalibrationIncluded: true,
} as const);
const PINNED_DETECTED_POWER_SYNTHESIS_FILTER_POLICY = Object.freeze({
  id: 'explicit-generator-filter-width-by-acquisition-regime-v1',
  divisorAcquisitionRegimes: 'match-swept-spectrum-actual-rbw-nuisance-v1',
  signalLabProductionAcquisitionRegimes: 'fixed-generator-internal-width-v1',
  signalLabProductionSynthesisFilterWidthHz: 100_000,
  measurementActualRbwQualification: 'unavailable',
} as const);
const PINNED_PRODUCTION_ACQUISITION_REGIME_HIGH_SNR_SEED_COVERAGE_POLICY = Object.freeze({
  id: 'detector-conditioned-production-regime-presence-v1',
  minimumDistinctSeedsPerHighSnrCell: 1,
  globalCoveragePolicy: 'all-seeds-at-one-or-more-regimes-except-declared-sparse-asynchronous-scenarios-v1',
} as const);
type PinnedCalibrationAcquisitionRegime = Readonly<{
  id: string;
  rbwDivisor: number | null;
  temporalSchedule: PinnedTemporalSchedule;
}>;
const PINNED_BASELINE_TEMPORAL_SCHEDULE = PINNED_SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES[0]!;
const PINNED_TAIL_CALIBRATION_ACQUISITION_REGIMES: readonly PinnedCalibrationAcquisitionRegime[] = Object.freeze([
  ...PINNED_TAIL_CALIBRATION_RBW_DIVISORS.map((rbwDivisor) => Object.freeze({
    id: `occupied-bandwidth-rbw-divisor:${rbwDivisor}/${PINNED_BASELINE_TEMPORAL_SCHEDULE.id}`,
    rbwDivisor,
    temporalSchedule: PINNED_BASELINE_TEMPORAL_SCHEDULE,
  })),
  ...PINNED_SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES.map((temporalSchedule) => Object.freeze({
    id: `${PINNED_SIGNAL_LAB_PRODUCTION_GEOMETRY.id}/${temporalSchedule.id}`,
    rbwDivisor: null,
    temporalSchedule,
  })),
]);
const PINNED_TAIL_CALIBRATION_ACQUISITION_REGIME_IDS = PINNED_TAIL_CALIBRATION_ACQUISITION_REGIMES
  .map((regime) => regime.id);
const TAIL_CALIBRATION_NUMERICAL_TOLERANCE = 1e-12;
const PINNED_ENGINEERING_PRIOR = Object.freeze({
  'cw-like': 0.08,
  'am-dsb-full-carrier-like': 0.08,
  'fm-angle-modulated-like': 0.08,
  'gsm-like': 0.04,
  'lte-fdd-like': 0.06,
  'lte-tdd-like': 0.06,
  'nr-fdd-like': 0.06,
  'nr-tdd-like': 0.06,
  'wifi-hr-dsss-like': 0.08,
  'wifi-ofdm-like': 0.08,
  'bluetooth-like': 0.12,
  'unknown-signal': 0.20,
} satisfies Record<ObservableLeafClass, number>);
const PRIOR_SENSITIVITY_GATES = Object.freeze({
  minimumKnownCoverage: 0.85,
  minimumHierarchicalAccuracy: 0.90,
  maximumIncompatibleNonUnknownRisk: 0,
  maximumFalseAcceptedUnknownRisk: 0,
  maximumDecisionChangeRate: 0.20,
});
const SWEEP_POINTS = 450;
const SWEEP_TIME_SECONDS = 0.05;
const ZERO_SPAN_POINTS = 450;
const ZERO_SPAN_SAMPLE_PERIOD_SECONDS = 1 / 9_000;
const REPORT_DIRECTORY = resolve('.artifacts/classifier-validation');
const REPORT_PATH = resolve(REPORT_DIRECTORY, 'report.json');
const REPORT_TEMP_PATH = resolve(REPORT_DIRECTORY, 'report.json.tmp');
const FAILED_REPORT_PATH = resolve(REPORT_DIRECTORY, 'report.failed.json');
const FAILED_REPORT_TEMP_PATH = resolve(REPORT_DIRECTORY, 'report.failed.json.tmp');
const VALIDATION_ACCEPTANCE_POLICY_ID = 'synthetic-observable-classifier-full-corpus-release-gates-v1';
const PINNED_SIGNAL_LAB_COMMIT = 'c036e063bce6c6cc1515750a4d5614f1c2ab5df8';
const SIGNAL_LAB_REPOSITORY_ROOT = resolve('../TinySA_SignalLab');
mkdirSync(REPORT_DIRECTORY, { recursive: true });
for (const path of [REPORT_PATH, REPORT_TEMP_PATH, FAILED_REPORT_PATH, FAILED_REPORT_TEMP_PATH]) {
  rmSync(path, { force: true });
}
let validationPublicationCommitted = false;
process.once('uncaughtException', publishUnexpectedValidationFailure);
process.once('unhandledRejection', publishUnexpectedValidationFailure);
const checkedOutSignalLabCommit = gitOutput(['rev-parse', 'HEAD']).toString('utf8').trim();
if (checkedOutSignalLabCommit !== PINNED_SIGNAL_LAB_COMMIT) {
  throw new Error(`SignalLab checked-out commit ${checkedOutSignalLabCommit} does not match pinned ${PINNED_SIGNAL_LAB_COMMIT}`);
}
assertSignalLabRepositoryIsClean();
if (CANONIZED_REPLAY_DETECTED_POWER_SYNTHESIS_FILTER_WIDTH_HZ
  !== PINNED_DETECTED_POWER_SYNTHESIS_FILTER_POLICY.signalLabProductionSynthesisFilterWidthHz) {
  throw new Error('Validator detected-power synthesis filter pin does not match SignalLab');
}
const diagnosticScenarioIds = (process.env.TINYSA_VALIDATION_SCENARIO_IDS ?? '')
  .split(',').map((value) => value.trim()).filter(Boolean);
const diagnosticScenarioIdSet = new Set(diagnosticScenarioIds);
const validationScenarios = diagnosticScenarioIdSet.size === 0
  ? canonicalClassificationScenarios
  : canonicalClassificationScenarios.filter((scenario) => diagnosticScenarioIdSet.has(scenario.id));
const invalidDiagnosticScenarioIds = diagnosticScenarioIds
  .filter((scenarioId) => !canonicalClassificationScenarios.some((scenario) => scenario.id === scenarioId));
if (invalidDiagnosticScenarioIds.length > 0) {
  throw new Error(`Unknown diagnostic validation scenario IDs: ${invalidDiagnosticScenarioIds.join(', ')}`);
}
const PRODUCTION_DETECTION_CONFIG: SignalDetectionConfig = {
  threshold: { strategy: 'noise-relative', marginDb: 10 },
  minimumBandwidthHz: 0,
  minimumProminenceDb: 6,
  minimumConsecutiveSweeps: 2,
  releaseAfterMissedSweeps: 2,
};
const classifier = new BayesianWaveformClassifier();
const PINNED_CORPUS_SOURCE_ARTIFACT_PATHS = [
  'package-lock.json',
  'package.json',
  'src/canonical-timing.ts',
  'src/catalog.ts',
  'src/classification-corpus.ts',
  'src/contracts.ts',
  'src/source-provenance.ts',
  'src/waveforms.ts',
] as const;
const PINNED_CORPUS_TYPESCRIPT_IMPORT_CLOSURE = [
  'src/canonical-timing.ts',
  'src/catalog.ts',
  'src/classification-corpus.ts',
  'src/contracts.ts',
  'src/source-provenance.ts',
  'src/waveforms.ts',
] as const;
assertCanonicalCorpusSourceArtifactPaths(PINNED_CORPUS_SOURCE_ARTIFACT_PATHS);
assertCorpusSourceImportClosure(
  'src/classification-corpus.ts',
  PINNED_CORPUS_TYPESCRIPT_IMPORT_CLOSURE,
  PINNED_CORPUS_SOURCE_ARTIFACT_PATHS,
);
const checkedOutCorpusSourceManifest = {
  schemaVersion: 1 as const,
  hashAlgorithm: 'sha256' as const,
  artifacts: PINNED_CORPUS_SOURCE_ARTIFACT_PATHS.map(corpusSourceArtifact),
};
const checkedOutCorpusSha256 = createHash('sha256')
  .update(JSON.stringify(checkedOutCorpusSourceManifest))
  .digest('hex');
const checkedInModelAssetSha256 = createHash('sha256')
  .update(readFileSync(resolve('packages/analysis/src/models/bayesian-observable-v5.generated.ts')))
  .digest('hex');
const identity: DeviceIdentity = {
  model: 'SignalLab production-pipeline synthetic validation corpus', hardwareVersion: 'offline', firmwareVersion: CLASSIFICATION_CORPUS_VERSION,
  firmwareQualification: 'protocol-test',
  port: { id: 'offline', path: 'offline://classification-validation', usbMatch: 'protocol-test-double', transport: 'protocol-test-double', execution: 'protocol-test-double' },
  simulated: true, usbIdentityVerified: false, execution: 'protocol-test-double',
};

interface AdmissionAttempt {
  attemptId: string;
  scenario: string;
  corpusTruth: ObservableSignalClass;
  modelTruth: ObservableLeafClass;
  allowedModelTruths: readonly ObservableLeafClass[];
  snrDb: number;
  rbwDivisor: number;
  actualRbwHz: number;
  detectedPowerSynthesisFilterWidthHz: number;
  binWidthHz: number;
  seed: number;
  observationHorizon: number;
  everReady: boolean;
  admitted: boolean;
  everReadyRepresentativeCount: number;
  finalReadyRepresentativeCount: number;
  finalActiveRepresentativeCount: number;
  selectedTrackAdmissions: number;
  maximumActiveAdmissions: number;
  maximumLocalTrackAdmissions: number;
  firstReadyOpportunity?: number;
  everAssociationModes: readonly string[];
  finalAssociationModes: readonly string[];
  regularAssociationsObserved: number;
  agileAssociationsObserved: number;
  regularAssociationExpirations: number;
}

interface ValidationCase {
  attemptId: string;
  representativeKey: string;
  scenario: string;
  corpusTruth: ObservableSignalClass;
  modelTruth: ObservableLeafClass;
  allowedModelTruths: readonly ObservableLeafClass[];
  nominalBandwidthHz: number;
  snrDb: number;
  rbwDivisor: number;
  actualRbwHz: number;
  detectedPowerSynthesisFilterWidthHz: number;
  binWidthHz: number;
  seed: number;
  firstReadyOpportunity: number;
  componentFitEligible: boolean;
  result: string;
  confidence: number;
  unknownPosterior: number;
  truthPosterior: number;
  topLeaf: string;
  topLeafPosterior: number;
  acceptedHierarchy: boolean;
  posterior: Readonly<Record<string, number>>;
  centerHz: number;
  occupiedStartHz: number;
  occupiedStopHz: number;
  bandwidthHz: number;
  selectedTrackAdmissions: number;
  localTrackAdmissions: number;
  associationMode: NonNullable<DetectedSignal['associationMode']>;
  associationId?: string;
  associationModelId?: string;
  associationMemberCount?: number;
  associationRegionBandwidthHz?: number;
  knownSupportRank: number;
  associationEvidenceQualification?: ObservableFeatureObservation['associationEvidenceQualification'];
  limitations: readonly string[];
  features: Readonly<Record<string, number>>;
}

interface EvidenceViewCase {
  attemptId: string;
  representativeKey: string;
  view: 'spectrum-only' | 'envelope-untimed';
  scenario: string;
  corpusTruth: ObservableSignalClass;
  modelTruth: ObservableLeafClass;
  allowedModelTruths: readonly ObservableLeafClass[];
  componentFitEligible: boolean;
  nominalBandwidthHz: number;
  measuredBandwidthHz: number;
  result: string;
  topLeaf: string;
  topLeafPosterior: number;
  truthPosterior: number;
  posterior: Readonly<Record<string, number>>;
  acceptedHierarchy: boolean;
  supportRank: number;
  features: Readonly<Record<string, number>>;
}

interface RollingWindowCase {
  attemptId: string;
  representativeKey: string;
  readyOpportunity: number;
  scenario: string;
  modelTruth: ObservableLeafClass;
  allowedModelTruths: readonly ObservableLeafClass[];
  snrDb: number;
  rbwDivisor: number;
  seed: number;
  result: string;
  acceptedHierarchy: boolean;
  truthClassDomainEligible: boolean;
  knownSupportRank: number;
  associationMode: NonNullable<DetectedSignal['associationMode']>;
}

interface ExactEquivalenceDiscrepancy {
  pair: string;
  nuisanceCell: string;
  representativeIndex?: number;
  view?: EvidenceViewCase['view'];
  field: string;
  reference: unknown;
  null: unknown;
}

type TailCalibrationView = 'spectrum-only' | 'envelope-untimed' | 'envelope-timed';

interface RecomputedTailCalibrationAudit {
  valid: boolean;
  scoreTolerance: number;
  recomputedAttemptCountsByScenario: Readonly<Record<string, number>>;
  attemptCountMismatches: readonly { scenarioId: string; expected: number; observed: number }[];
  scoreComparisons: readonly {
    classId: ObservableLeafClass;
    view: TailCalibrationView;
    expectedCount: number;
    observedCount: number;
    maximumAbsoluteDifference: number;
    expectedSha256: string;
    observedSha256: string;
  }[];
  lateMinimumCount: number;
  allOnlineAttemptCount: number;
  aggregationRegression: {
    firstOpportunity: number;
    minimumOpportunity: number;
    minimumSupport: number;
    passed: boolean;
  };
}

interface ExactEquivalencePairAudit {
  pair: string;
  referenceScenarioId: string;
  nullScenarioId: string;
  nuisanceCells: number;
  matchedAdmissionCells: number;
  matchedRepresentativePairs: number;
  matchedEvidenceViewPairs: number;
  discrepancyCount: number;
  discrepancies: readonly ExactEquivalenceDiscrepancy[];
}

interface FirstReadyRepresentative {
  detection: DetectedSignal;
  representativeKey: string;
  classificationAdmissions: number;
  localTrackAdmissions: number;
  firstReadyOpportunity: number;
  evidenceSweeps: readonly Sweep[];
}

interface OnlineReadyRepresentative {
  detection: DetectedSignal;
  representativeKey: string;
  classificationAdmissions: number;
  localTrackAdmissions: number;
  readyOpportunity: number;
  evidenceSweeps: readonly Sweep[];
}

interface ProductionOnlineSelection {
  representatives: readonly FirstReadyRepresentative[];
  onlineReadyRepresentatives: readonly OnlineReadyRepresentative[];
  everReadyRepresentativeKeys: readonly string[];
  finalReadyRepresentativeCount: number;
  finalActiveRepresentativeCount: number;
  maximumActiveAdmissions: number;
  maximumLocalTrackAdmissions: number;
  firstReadyOpportunity?: number;
  everAssociationModes: readonly string[];
  finalAssociationModes: readonly string[];
  regularAssociationIds: readonly string[];
  agileAssociationIds: readonly string[];
  regularAssociationExpirations: number;
}

const cases: ValidationCase[] = [];
const evidenceViewCases: EvidenceViewCase[] = [];
const rollingWindowCases: RollingWindowCase[] = [];
const admissionAttempts: AdmissionAttempt[] = [];
for (const scenario of validationScenarios) {
  for (const snrDb of SNR_DB) {
    for (const rbwDivisor of RBW_DIVISORS) {
      for (const seed of NUISANCE_SHIFT_SEEDS) {
        const nominalBinWidthHz = scenario.recommendedSpanHz / 449;
        const actualRbwHz = Math.max(nominalBinWidthHz * 0.8, scenario.occupiedBandwidthHz / rbwDivisor, 1_000);
        const detectedPowerSynthesisFilterWidthHz = actualRbwHz;
        const attemptId = validationAttemptId(scenario.id, snrDb, rbwDivisor, seed);
        const observationHorizon = observationOpportunityHorizon(scenario);
        const observations = Array.from({ length: observationHorizon }, (_, spectrumOpportunity) => synthesizeCanonicalObservation(scenario.id, {
          lookIndex: pinnedSourceLookIndex(PINNED_VALIDATION_TEMPORAL_SCHEDULE, spectrumOpportunity),
          seed,
          snrDb,
          actualRbwHz,
          detectedPowerSynthesisFilterWidthHz,
          points: SWEEP_POINTS,
          sweepTimeSeconds: SWEEP_TIME_SECONDS,
          zeroSpanPoints: ZERO_SPAN_POINTS,
          zeroSpanSamplePeriodSeconds: ZERO_SPAN_SAMPLE_PERIOD_SECONDS,
        }));
        for (const observation of observations) {
          assertDetectedPowerSynthesisProvenance(
            observation,
            detectedPowerSynthesisFilterWidthHz,
            `${attemptId} swept observation`,
          );
        }
        const sweeps = observations.map((observation) => asSweep(scenario, observation));
        const selection = selectProductionFirstReady(sweeps);
        const mappedTruth = modelTruth(scenario.truthClass);
        const allowedModelTruths = [...new Set(scenario.allowedObservableClasses.map(modelTruth))];
        const selectedAdmissions = selection.representatives.map((item) => item.classificationAdmissions);
        admissionAttempts.push({
          attemptId,
          scenario: scenario.id,
          corpusTruth: scenario.truthClass,
          modelTruth: mappedTruth,
          allowedModelTruths,
          snrDb,
          rbwDivisor,
          actualRbwHz,
          detectedPowerSynthesisFilterWidthHz,
          binWidthHz: nominalBinWidthHz,
          seed,
          observationHorizon,
          everReady: selection.everReadyRepresentativeKeys.length > 0,
          admitted: selection.representatives.length > 0,
          everReadyRepresentativeCount: selection.everReadyRepresentativeKeys.length,
          finalReadyRepresentativeCount: selection.finalReadyRepresentativeCount,
          finalActiveRepresentativeCount: selection.finalActiveRepresentativeCount,
          selectedTrackAdmissions: selectedAdmissions.length ? Math.max(...selectedAdmissions) : 0,
          maximumActiveAdmissions: selection.maximumActiveAdmissions,
          maximumLocalTrackAdmissions: selection.maximumLocalTrackAdmissions,
          ...(selection.firstReadyOpportunity === undefined ? {} : { firstReadyOpportunity: selection.firstReadyOpportunity }),
          everAssociationModes: selection.everAssociationModes,
          finalAssociationModes: selection.finalAssociationModes,
          regularAssociationsObserved: selection.regularAssociationIds.length,
          agileAssociationsObserved: selection.agileAssociationIds.length,
          regularAssociationExpirations: selection.regularAssociationExpirations,
        });
        if (mappedTruth !== 'unknown-signal' && snrDb >= HIGH_SNR_MINIMUM_DB) {
          for (const representative of selection.onlineReadyRepresentatives) {
            const detection = representative.detection;
            const featureObservation = extractObservableFeatures(detection, { sweeps: representative.evidenceSweeps });
            if (featureObservation.sweepIds.length !== CLASSIFICATION_ADMISSIONS) {
              throw new Error(`${scenario.id} rolling classifier extracted ${featureObservation.sweepIds.length} source sweeps, expected exactly ${CLASSIFICATION_ADMISSIONS}`);
            }
            const fitEligible = observableRepresentativeIsInClassDomain(
              mappedTruth,
              featureObservation,
            );
            const result = await classifier.classify(detection, { sweeps: representative.evidenceSweeps });
            rollingWindowCases.push({
              attemptId,
              representativeKey: representative.representativeKey,
              readyOpportunity: representative.readyOpportunity,
              scenario: scenario.id,
              modelTruth: mappedTruth,
              allowedModelTruths,
              snrDb,
              rbwDivisor,
              seed,
              result: result.label,
              acceptedHierarchy: acceptsAnyTruth(
                result.label,
                allowedModelTruths,
                scenario.occupiedBandwidthHz,
                featureObservation.bandwidthHz,
              ),
              truthClassDomainEligible: fitEligible,
              knownSupportRank: knownModelSupportRank(featureObservation),
              associationMode: detection.associationMode ?? 'frequency-local',
            });
          }
        }
        for (const representative of selection.representatives) {
          const detection = representative.detection;
          const evidenceSweeps = representative.evidenceSweeps;
          const expectedSweepIds = classificationSourceSweepIds(detection).slice(-CLASSIFICATION_ADMISSIONS);
          const classificationAdmissions = expectedSweepIds.length;
          if (classificationAdmissions !== CLASSIFICATION_ADMISSIONS) throw new Error(`${scenario.id} classifier admission window has ${classificationAdmissions} sweeps, expected exactly ${CLASSIFICATION_ADMISSIONS}`);

          // This is a fresh capture explicitly tuned when this production
          // representative first becomes ready. No later sweep is available
          // to either feature extraction or classification.
          const zeroSpanTuneHz = projectDetectedPowerTuneHz(
            detection.peakHz,
            SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1,
          );
          const zeroSpanObservation = synthesizeCanonicalObservation(scenario.id, {
            lookIndex: pinnedInterleavedCaptureLookIndex(
              PINNED_VALIDATION_TEMPORAL_SCHEDULE,
              representative.firstReadyOpportunity - 1,
            ),
            seed,
            snrDb,
            actualRbwHz,
            detectedPowerSynthesisFilterWidthHz,
            points: SWEEP_POINTS,
            sweepTimeSeconds: SWEEP_TIME_SECONDS,
            zeroSpanPoints: ZERO_SPAN_POINTS,
            zeroSpanSamplePeriodSeconds: ZERO_SPAN_SAMPLE_PERIOD_SECONDS,
            zeroSpanFrequencyHz: zeroSpanTuneHz,
          });
          assertDetectedPowerSynthesisProvenance(
            zeroSpanObservation,
            detectedPowerSynthesisFilterWidthHz,
            `${attemptId} detected-power observation`,
          );
          const zeroSpan = asZeroSpan(zeroSpanObservation, detection);
          const featureObservation = extractObservableFeatures(detection, { sweeps: evidenceSweeps, zeroSpan });
          const componentFitEligible = observableRepresentativeIsInClassDomain(
            mappedTruth,
            featureObservation,
          );
          if (featureObservation.sweepIds.length !== CLASSIFICATION_ADMISSIONS) {
            throw new Error(`${scenario.id} extracted ${featureObservation.sweepIds.length} source sweeps, expected exactly ${CLASSIFICATION_ADMISSIONS}`);
          }
          if ([...featureObservation.sweepIds].sort().some((sweepId, index) => sweepId !== [...expectedSweepIds].sort()[index])) {
            throw new Error(`${scenario.id} classifier did not preserve its latest ${CLASSIFICATION_ADMISSIONS} positive source sweeps`);
          }
          const posterior = inferPosterior(featureObservation);
          const result = await classifier.classify(detection, { sweeps: evidenceSweeps, zeroSpan });
          const topLeaf = posterior[0]!;
          const posteriorRecord = Object.fromEntries(posterior.map((item) => [item.id, item.probability]));
          cases.push({
            attemptId,
            representativeKey: representative.representativeKey,
            scenario: scenario.id,
            corpusTruth: scenario.truthClass,
            modelTruth: mappedTruth,
            allowedModelTruths,
            nominalBandwidthHz: scenario.occupiedBandwidthHz,
            snrDb,
            rbwDivisor,
            actualRbwHz,
            detectedPowerSynthesisFilterWidthHz,
            binWidthHz: nominalBinWidthHz,
            seed,
            firstReadyOpportunity: representative.firstReadyOpportunity,
            componentFitEligible,
            result: result.label,
            confidence: result.confidence,
            unknownPosterior: posterior.find((item) => item.id === 'unknown-signal')?.probability ?? 0,
            truthPosterior: posterior.find((item) => item.id === mappedTruth)?.probability ?? 0,
            topLeaf: topLeaf.id,
            topLeafPosterior: topLeaf.probability,
            acceptedHierarchy: acceptsAnyTruth(result.label, allowedModelTruths, scenario.occupiedBandwidthHz, featureObservation.bandwidthHz),
            posterior: posteriorRecord,
            centerHz: featureObservation.centerHz,
            occupiedStartHz: featureObservation.occupiedStartHz,
            occupiedStopHz: featureObservation.occupiedStopHz,
            bandwidthHz: featureObservation.bandwidthHz,
            selectedTrackAdmissions: representative.classificationAdmissions,
            localTrackAdmissions: representative.localTrackAdmissions,
            associationMode: detection.associationMode ?? 'frequency-local',
            ...(detection.associationId === undefined ? {} : { associationId: detection.associationId }),
            ...(detection.associationModelId === undefined ? {} : { associationModelId: detection.associationModelId }),
            ...(detection.associationMemberTrackIds === undefined ? {} : { associationMemberCount: detection.associationMemberTrackIds.length }),
            ...(detection.associationRegionStartHz === undefined || detection.associationRegionStopHz === undefined
              ? {}
              : { associationRegionBandwidthHz: detection.associationRegionStopHz - detection.associationRegionStartHz }),
            knownSupportRank: knownModelSupportRank(featureObservation),
            ...(featureObservation.associationEvidenceQualification === undefined
              ? {}
              : { associationEvidenceQualification: featureObservation.associationEvidenceQualification }),
            limitations: result.evidence.limitations ?? [],
            features: featureObservation.values,
          });
          for (const [view, values] of [
            ['spectrum-only', spectrumOnly(featureObservation.values)],
            ['envelope-untimed', envelopeUntimed(featureObservation.values)],
          ] as const) {
            const viewObservation = { ...featureObservation, values };
            const viewPosterior = inferPosterior(viewObservation);
            const viewDecision = selectObservableDecision(viewPosterior, viewObservation);
            const viewResult = viewDecision.label === 'unknown' ? 'unknown' : `observable:${viewDecision.label}`;
            evidenceViewCases.push({
              attemptId,
              representativeKey: representative.representativeKey,
              view,
              scenario: scenario.id,
              corpusTruth: scenario.truthClass,
              modelTruth: mappedTruth,
              allowedModelTruths,
              componentFitEligible,
              nominalBandwidthHz: scenario.occupiedBandwidthHz,
              measuredBandwidthHz: featureObservation.bandwidthHz,
              result: viewResult,
              topLeaf: viewPosterior[0]!.id,
              topLeafPosterior: viewPosterior[0]!.probability,
              truthPosterior: viewPosterior.find((item) => item.id === mappedTruth)?.probability ?? 0,
              posterior: Object.fromEntries(viewPosterior.map((item) => [item.id, item.probability])),
              acceptedHierarchy: acceptsAnyTruth(viewResult, allowedModelTruths, scenario.occupiedBandwidthHz, featureObservation.bandwidthHz),
              supportRank: knownModelSupportRank(viewObservation),
              features: values,
            });
          }
        }
      }
    }
  }
}

const exactEquivalencePairAudit = auditExactEquivalencePairs(admissionAttempts, cases, evidenceViewCases);
const exactEquivalenceDiscrepancies = exactEquivalencePairAudit.flatMap((audit) => audit.discrepancies);
const exactEquivalenceDiscrepancyCount = exactEquivalencePairAudit.reduce((sum, audit) => sum + audit.discrepancyCount, 0);
const expectedAttempts = validationScenarios.length * SNR_DB.length * RBW_DIVISORS.length * NUISANCE_SHIFT_SEEDS.length;
const modelFittingSeeds = [...BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.seeds];
const modelCalibrationSeeds = [...(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationSeeds ?? [])];
const modelFittingRbwDivisors = [...BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.rbwDivisors];
const modelCalibrationRbwDivisors = [...(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRbwDivisors ?? [])];
const modelFittingAcquisitionRegimeIds = [...(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.fittingAcquisitionRegimeIds ?? [])];
const modelCalibrationAcquisitionRegimeIds = [...(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationAcquisitionRegimeIds ?? [])];
const fittingCalibrationSeedOverlap = numericIntersection(modelFittingSeeds, modelCalibrationSeeds);
const validationFittingSeedOverlap = numericIntersection(NUISANCE_SHIFT_SEEDS, modelFittingSeeds);
const validationCalibrationSeedOverlap = numericIntersection(NUISANCE_SHIFT_SEEDS, modelCalibrationSeeds);
const validationFittingRbwOverlap = numericIntersection(RBW_DIVISORS, modelFittingRbwDivisors);
const validationCalibrationRbwOverlap = numericIntersection(RBW_DIVISORS, modelCalibrationRbwDivisors);
const modelTailCalibrationAttemptCounts = BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationAttemptCountsByScenario ?? {};
const expectedTailCalibrationScenarioIds = BAYESIAN_OBSERVABLE_MODEL.classModels
  .filter((model) => model.id !== 'unknown-signal')
  .flatMap((model) => model.components.map((component) => component.id))
  .sort();
const modelTailCalibrationScenarioIds = Object.keys(modelTailCalibrationAttemptCounts).sort();
const missingTailCalibrationScenarioIds = setDifference(expectedTailCalibrationScenarioIds, modelTailCalibrationScenarioIds);
const unexpectedTailCalibrationScenarioIds = setDifference(modelTailCalibrationScenarioIds, expectedTailCalibrationScenarioIds);
const invalidTailCalibrationAttemptCounts = Object.entries(modelTailCalibrationAttemptCounts)
  .filter(([, count]) => !Number.isInteger(count) || count < 40)
  .map(([scenarioId, count]) => ({ scenarioId, count }));
const tailCalibrationViewCountMismatches = BAYESIAN_OBSERVABLE_MODEL.classModels
  .filter((model) => model.id !== 'unknown-signal')
  .flatMap((model) => {
    const expected = model.components.reduce((sum, component) =>
      sum + (modelTailCalibrationAttemptCounts[component.id] ?? 0), 0);
    return (['spectrum-only', 'envelope-untimed', 'envelope-timed'] as const).flatMap((view) => {
      const observed = model.tailCalibrationScoresByView?.[view]?.length ?? 0;
      return observed === expected ? [] : [{ classId: model.id, view, expected, observed }];
    });
  });
const tailCalibrationMatrixPinsValid = JSON.stringify(modelCalibrationSeeds) === JSON.stringify(PINNED_TAIL_CALIBRATION_SEEDS)
  && JSON.stringify(modelCalibrationRbwDivisors) === JSON.stringify(PINNED_TAIL_CALIBRATION_RBW_DIVISORS)
  && JSON.stringify(modelCalibrationAcquisitionRegimeIds) === JSON.stringify(PINNED_TAIL_CALIBRATION_ACQUISITION_REGIME_IDS)
  && JSON.stringify(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.snrDb) === JSON.stringify(PINNED_TAIL_CALIBRATION_SNR_DB);
const productionAcquisitionRegimePinsValid =
  JSON.stringify(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.signalLabProductionAcquisitionRegime)
    === JSON.stringify(PINNED_SIGNAL_LAB_PRODUCTION_ACQUISITION_REGIME)
  && JSON.stringify(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.productionAcquisitionRegimeHighSnrSeedCoveragePolicy)
    === JSON.stringify(PINNED_PRODUCTION_ACQUISITION_REGIME_HIGH_SNR_SEED_COVERAGE_POLICY)
  && JSON.stringify(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.detectedPowerSynthesisFilterPolicy)
    === JSON.stringify(PINNED_DETECTED_POWER_SYNTHESIS_FILTER_POLICY)
  && JSON.stringify(modelFittingAcquisitionRegimeIds) === JSON.stringify(PINNED_TAIL_CALIBRATION_ACQUISITION_REGIME_IDS)
  && JSON.stringify(modelCalibrationAcquisitionRegimeIds) === JSON.stringify(PINNED_TAIL_CALIBRATION_ACQUISITION_REGIME_IDS);
const validationTemporalScheduleIdOverlap = PINNED_SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES
  .map((schedule) => schedule.id)
  .filter((id) => id === PINNED_VALIDATION_TEMPORAL_SCHEDULE.id);
const pinnedFitTemporalSourceLookIndices = [...new Set(PINNED_SIGNAL_LAB_PRODUCTION_TEMPORAL_SCHEDULES.flatMap(
  (schedule) => Array.from({ length: FULL_BAND_2G4_OBSERVATION_OPPORTUNITIES }, (_, opportunity) =>
    pinnedSourceLookIndex(schedule, opportunity)),
))];
const pinnedValidationTemporalSourceLookIndices = Array.from(
  { length: FULL_BAND_2G4_OBSERVATION_OPPORTUNITIES },
  (_, opportunity) => pinnedSourceLookIndex(PINNED_VALIDATION_TEMPORAL_SCHEDULE, opportunity),
);
const validationFitTemporalSourceLookIndexOverlap = numericIntersection(
  pinnedValidationTemporalSourceLookIndices,
  pinnedFitTemporalSourceLookIndices,
);
const validationTemporalPartitionDisjoint = validationTemporalScheduleIdOverlap.length === 0
  && validationFitTemporalSourceLookIndexOverlap.length === 0;
const tailCalibrationPolicyValid = BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationScoreUnit
    === PINNED_TAIL_CALIBRATION_SCORE_UNIT
  && BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRepresentativeSelectionPolicy
    === PINNED_TAIL_CALIBRATION_SELECTION_POLICY
  && BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRepresentativeAggregationPolicy
    === PINNED_TAIL_CALIBRATION_AGGREGATION_POLICY
  && BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRuntimeInterpretationPolicy
    === PINNED_TAIL_CALIBRATION_RUNTIME_INTERPRETATION_POLICY
  && BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationStatisticalInterpretation
    === PINNED_TAIL_CALIBRATION_STATISTICAL_INTERPRETATION
  && missingTailCalibrationScenarioIds.length === 0
  && unexpectedTailCalibrationScenarioIds.length === 0
  && invalidTailCalibrationAttemptCounts.length === 0
  && tailCalibrationViewCountMismatches.length === 0
  && tailCalibrationMatrixPinsValid
  && productionAcquisitionRegimePinsValid;
const samplingPartitionsDisjoint = modelCalibrationSeeds.length > 0
  && modelCalibrationRbwDivisors.length > 0
  && productionAcquisitionRegimePinsValid
  && validationTemporalPartitionDisjoint
  && fittingCalibrationSeedOverlap.length === 0
  && validationFittingSeedOverlap.length === 0
  && validationCalibrationSeedOverlap.length === 0
  && validationFittingRbwOverlap.length === 0
  && validationCalibrationRbwOverlap.length === 0;
const admissionMisses = admissionAttempts.filter((item) => !item.admitted);
const known = cases.filter((item) => item.modelTruth !== 'unknown-signal');
const unknown = cases.filter((item) => item.modelTruth === 'unknown-signal');
const modelScenarioExcludedIdList = [...(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.scenarioExcludedFromComponentFitIds ?? [])];
const modelExactEquivalenceIdList = [...(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.exactObservableEquivalenceNullScenarioIds ?? [])];
const modelKnownAcquisitionValidationIdList = [...(BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.knownAcquisitionValidationOnlyScenarioIds ?? [])];
const scenarioExcludedIdList = [...PINNED_SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS];
const scenarioExcludedIds = new Set<string>(scenarioExcludedIdList);
const exactEquivalenceIdList = [...PINNED_EXACT_OBSERVABLE_EQUIVALENCE_NULL_SCENARIO_IDS];
const exactEquivalenceIds = new Set<string>(exactEquivalenceIdList);
const knownAcquisitionValidationIdList = [...PINNED_KNOWN_ACQUISITION_VALIDATION_ONLY_SCENARIO_IDS];
const knownAcquisitionValidationIds = new Set<string>(knownAcquisitionValidationIdList);
const duplicateExcludedScenarioIds = duplicateStrings(modelScenarioExcludedIdList);
const duplicateExactEquivalenceScenarioIds = duplicateStrings(modelExactEquivalenceIdList);
const duplicateKnownAcquisitionValidationIds = duplicateStrings(modelKnownAcquisitionValidationIdList);
const modelExcludedMissingPinnedIds = setDifference(scenarioExcludedIdList, modelScenarioExcludedIdList);
const modelExcludedUnexpectedIds = setDifference(modelScenarioExcludedIdList, scenarioExcludedIdList);
const modelExactEquivalenceMissingPinnedIds = setDifference(exactEquivalenceIdList, modelExactEquivalenceIdList);
const modelExactEquivalenceUnexpectedIds = setDifference(modelExactEquivalenceIdList, exactEquivalenceIdList);
const modelKnownAcquisitionMissingPinnedIds = setDifference(knownAcquisitionValidationIdList, modelKnownAcquisitionValidationIdList);
const modelKnownAcquisitionUnexpectedIds = setDifference(modelKnownAcquisitionValidationIdList, knownAcquisitionValidationIdList);
const corpusScenarioById = new Map(canonicalClassificationScenarios.map((scenario) => [scenario.id, scenario]));
const invalidPinnedStrictUnknownHoldoutIds = PINNED_STRICT_UNKNOWN_HOLDOUT_SCENARIO_IDS.filter((scenarioId) => {
  const scenario = corpusScenarioById.get(scenarioId);
  return scenario === undefined
    || modelTruth(scenario.truthClass) !== 'unknown-signal'
    || [...new Set(scenario.allowedObservableClasses.map(modelTruth))].join('|') !== 'unknown-signal';
});
const invalidPinnedAmbiguityStressIds = PINNED_OBSERVABLE_AMBIGUITY_STRESS_SCENARIO_IDS.filter((scenarioId) => {
  const scenario = corpusScenarioById.get(scenarioId);
  const allowed = scenario ? [...new Set(scenario.allowedObservableClasses.map(modelTruth))] : [];
  return scenario === undefined
    || modelTruth(scenario.truthClass) !== 'unknown-signal'
    || !allowed.includes('unknown-signal')
    || !allowed.some((truth) => truth !== 'unknown-signal');
});
const invalidPinnedFittedUnknownIds = PINNED_FITTED_UNKNOWN_SCENARIO_IDS.filter((scenarioId) => {
  const scenario = corpusScenarioById.get(scenarioId);
  return scenario === undefined
    || modelTruth(scenario.truthClass) !== 'unknown-signal'
    || [...new Set(scenario.allowedObservableClasses.map(modelTruth))].join('|') !== 'unknown-signal';
});
const invalidPinnedExactEquivalencePairs = PINNED_EXACT_OBSERVABLE_EQUIVALENCE_PAIRS.filter((pair) => {
  const nullScenario = corpusScenarioById.get(pair.nullScenarioId);
  const referenceScenario = corpusScenarioById.get(pair.referenceScenarioId);
  const allowedNullTruths = nullScenario ? [...new Set(nullScenario.allowedObservableClasses.map(modelTruth))] : [];
  return nullScenario === undefined
    || referenceScenario === undefined
    || modelTruth(nullScenario.truthClass) !== 'unknown-signal'
    || modelTruth(referenceScenario.truthClass) === 'unknown-signal'
    || !allowedNullTruths.includes('unknown-signal')
    || !allowedNullTruths.includes(modelTruth(referenceScenario.truthClass));
}).map((pair) => `${pair.referenceScenarioId}<=>${pair.nullScenarioId}`);
const excludedScenarioSplit = [...scenarioExcludedIds].sort().map((scenarioId) => ({
  scenarioId,
  existsInCorpus: corpusScenarioById.has(scenarioId),
  corpusTruth: corpusScenarioById.get(scenarioId)?.truthClass,
  modelTruth: corpusScenarioById.has(scenarioId) ? modelTruth(corpusScenarioById.get(scenarioId)!.truthClass) : undefined,
  category: knownAcquisitionValidationIds.has(scenarioId)
    ? 'known-acquisition-validation-only'
    : exactEquivalenceIds.has(scenarioId)
    ? 'exact-observable-equivalence-null'
    : (PINNED_OBSERVABLE_AMBIGUITY_STRESS_SCENARIO_IDS as readonly string[]).includes(scenarioId)
      ? 'observable-ambiguity-stress'
      : 'strict-unknown-stress',
}));
const invalidExcludedScenarioIds = excludedScenarioSplit.filter((item) => !item.existsInCorpus).map((item) => item.scenarioId);
const nonUnknownExcludedScenarioIds = excludedScenarioSplit
  .filter((item) => item.existsInCorpus
    && item.modelTruth !== 'unknown-signal'
    && !knownAcquisitionValidationIds.has(item.scenarioId))
  .map((item) => item.scenarioId);
const excludedUnknownScenarioIds = excludedScenarioSplit.filter((item) => item.modelTruth === 'unknown-signal').map((item) => item.scenarioId);
const knownAcquisitionValidationSplit = [...knownAcquisitionValidationIds].sort().map((scenarioId) => {
  const scenario = corpusScenarioById.get(scenarioId);
  return {
    scenarioId,
    existsInCorpus: scenario !== undefined,
    modelTruth: scenario ? modelTruth(scenario.truthClass) : undefined,
    excludedFromComponentFit: scenarioExcludedIds.has(scenarioId),
  };
});
const invalidKnownAcquisitionValidationIds = knownAcquisitionValidationSplit
  .filter((item) => !item.existsInCorpus)
  .map((item) => item.scenarioId);
const unknownTruthKnownAcquisitionValidationIds = knownAcquisitionValidationSplit
  .filter((item) => item.modelTruth === 'unknown-signal')
  .map((item) => item.scenarioId);
const knownAcquisitionValidationNotExcludedIds = knownAcquisitionValidationSplit
  .filter((item) => !item.excludedFromComponentFit)
  .map((item) => item.scenarioId);
const exactEquivalenceSplit = [...exactEquivalenceIds].sort().map((scenarioId) => {
  const scenario = corpusScenarioById.get(scenarioId);
  const allowedModelTruths = scenario ? [...new Set(scenario.allowedObservableClasses.map(modelTruth))] : [];
  return {
    scenarioId,
    existsInCorpus: scenario !== undefined,
    corpusTruth: scenario?.truthClass,
    modelTruth: scenario ? modelTruth(scenario.truthClass) : undefined,
    allowedModelTruths,
    excludedFromComponentFit: scenarioExcludedIds.has(scenarioId),
  };
});
const invalidExactEquivalenceScenarioIds = exactEquivalenceSplit.filter((item) => !item.existsInCorpus).map((item) => item.scenarioId);
const nonUnknownExactEquivalenceScenarioIds = exactEquivalenceSplit
  .filter((item) => item.existsInCorpus && item.modelTruth !== 'unknown-signal')
  .map((item) => item.scenarioId);
const exactEquivalenceNotExcludedScenarioIds = exactEquivalenceSplit
  .filter((item) => !item.excludedFromComponentFit)
  .map((item) => item.scenarioId);
const exactEquivalenceWithoutDeclaredAlternativeIds = exactEquivalenceSplit
  .filter((item) => !item.allowedModelTruths.includes('unknown-signal')
    || !item.allowedModelTruths.some((truth) => truth !== 'unknown-signal'))
  .map((item) => item.scenarioId);
const fittedComponentIds = new Set(BAYESIAN_OBSERVABLE_MODEL.classModels.flatMap((model) => model.components.map((component) => component.id)));
const fittedUnknownModel = BAYESIAN_OBSERVABLE_MODEL.classModels.find((model) => model.id === 'unknown-signal');
const modelFittedUnknownScenarioIds = (fittedUnknownModel?.components.map((component) => component.id) ?? []).sort();
const fittedUnknownMissingPinnedIds = setDifference(PINNED_FITTED_UNKNOWN_SCENARIO_IDS, modelFittedUnknownScenarioIds);
const fittedUnknownUnexpectedIds = setDifference(modelFittedUnknownScenarioIds, PINNED_FITTED_UNKNOWN_SCENARIO_IDS);
const exactEquivalenceFittedComponentIds = [...exactEquivalenceIds].filter((scenarioId) => fittedComponentIds.has(scenarioId)).sort();
const knownAcquisitionValidationFittedComponentIds = [...knownAcquisitionValidationIds]
  .filter((scenarioId) => fittedComponentIds.has(scenarioId))
  .sort();
const expectedComponentAssignments = canonicalClassificationScenarios
  .filter((scenario) => !scenarioExcludedIds.has(scenario.id))
  .map((scenario) => ({ scenarioId: scenario.id, classId: modelTruth(scenario.truthClass) }))
  .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
const independentTailCalibrationAudit = recomputeTailCalibrationAudit(expectedComponentAssignments);
const expectedComponentClassByScenario = new Map(expectedComponentAssignments
  .map((assignment) => [assignment.scenarioId, assignment.classId] as const));
const actualComponentAssignments = BAYESIAN_OBSERVABLE_MODEL.classModels
  .flatMap((model) => model.components.map((component) => ({ scenarioId: component.id, classId: model.id })))
  .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
const actualComponentScenarioIds = actualComponentAssignments.map((assignment) => assignment.scenarioId);
const expectedComponentScenarioIds = expectedComponentAssignments.map((assignment) => assignment.scenarioId);
const duplicateFittedComponentScenarioIds = duplicateStrings(actualComponentScenarioIds);
const missingFittedComponentScenarioIds = setDifference(expectedComponentScenarioIds, actualComponentScenarioIds);
const unexpectedFittedComponentScenarioIds = setDifference(actualComponentScenarioIds, expectedComponentScenarioIds);
const wrongClassFittedComponents = actualComponentAssignments
  .filter((assignment) => expectedComponentClassByScenario.has(assignment.scenarioId)
    && expectedComponentClassByScenario.get(assignment.scenarioId) !== assignment.classId)
  .map((assignment) => ({
    ...assignment,
    expectedClassId: expectedComponentClassByScenario.get(assignment.scenarioId)!,
  }));
const duplicateModelClassIds = duplicateStrings(BAYESIAN_OBSERVABLE_MODEL.classModels.map((model) => model.id));
const missingModelClassIds = setDifference(OBSERVABLE_LEAF_CLASSES, BAYESIAN_OBSERVABLE_MODEL.classModels.map((model) => model.id));
const unexpectedModelClassIds = setDifference(BAYESIAN_OBSERVABLE_MODEL.classModels.map((model) => model.id), OBSERVABLE_LEAF_CLASSES);
const ambiguousUnknownIncludedInComponentFitIds = canonicalClassificationScenarios
  .filter((scenario) => modelTruth(scenario.truthClass) === 'unknown-signal'
    && scenario.allowedObservableClasses.some((truth) => modelTruth(truth) !== 'unknown-signal')
    && !scenarioExcludedIds.has(scenario.id))
  .map((scenario) => scenario.id)
  .sort();
const fittedUnknownScenarioIds = canonicalClassificationScenarios
  .filter((scenario) => modelTruth(scenario.truthClass) === 'unknown-signal' && !scenarioExcludedIds.has(scenario.id))
  .map((scenario) => scenario.id)
  .sort();
const corpusFittedUnknownMissingPinnedIds = setDifference(PINNED_FITTED_UNKNOWN_SCENARIO_IDS, fittedUnknownScenarioIds);
const corpusFittedUnknownUnexpectedIds = setDifference(fittedUnknownScenarioIds, PINNED_FITTED_UNKNOWN_SCENARIO_IDS);
const manifestSplitValid = invalidExcludedScenarioIds.length === 0
  && nonUnknownExcludedScenarioIds.length === 0
  && duplicateExcludedScenarioIds.length === 0
  && modelExcludedMissingPinnedIds.length === 0
  && modelExcludedUnexpectedIds.length === 0
  && invalidPinnedStrictUnknownHoldoutIds.length === 0
  && invalidPinnedAmbiguityStressIds.length === 0
  && invalidPinnedFittedUnknownIds.length === 0
  && invalidPinnedExactEquivalencePairs.length === 0
  && knownAcquisitionValidationIds.size > 0
  && duplicateKnownAcquisitionValidationIds.length === 0
  && modelKnownAcquisitionMissingPinnedIds.length === 0
  && modelKnownAcquisitionUnexpectedIds.length === 0
  && invalidKnownAcquisitionValidationIds.length === 0
  && unknownTruthKnownAcquisitionValidationIds.length === 0
  && knownAcquisitionValidationNotExcludedIds.length === 0
  && knownAcquisitionValidationFittedComponentIds.length === 0
  && duplicateFittedComponentScenarioIds.length === 0
  && missingFittedComponentScenarioIds.length === 0
  && unexpectedFittedComponentScenarioIds.length === 0
  && wrongClassFittedComponents.length === 0
  && duplicateModelClassIds.length === 0
  && missingModelClassIds.length === 0
  && unexpectedModelClassIds.length === 0
  && exactEquivalenceIds.size > 0
  && duplicateExactEquivalenceScenarioIds.length === 0
  && modelExactEquivalenceMissingPinnedIds.length === 0
  && modelExactEquivalenceUnexpectedIds.length === 0
  && invalidExactEquivalenceScenarioIds.length === 0
  && nonUnknownExactEquivalenceScenarioIds.length === 0
  && exactEquivalenceNotExcludedScenarioIds.length === 0
  && exactEquivalenceWithoutDeclaredAlternativeIds.length === 0
  && exactEquivalenceFittedComponentIds.length === 0
  && ambiguousUnknownIncludedInComponentFitIds.length === 0
  && excludedUnknownScenarioIds.length > 0
  && fittedUnknownScenarioIds.length > 0
  && fittedUnknownMissingPinnedIds.length === 0
  && fittedUnknownUnexpectedIds.length === 0
  && corpusFittedUnknownMissingPinnedIds.length === 0
  && corpusFittedUnknownUnexpectedIds.length === 0;
const scenarioExcludedUnknown = unknown.filter((item) => scenarioExcludedIds.has(item.scenario));
const strictUnknownHoldoutIds = new Set<string>(PINNED_STRICT_UNKNOWN_HOLDOUT_SCENARIO_IDS);
const ambiguityStressIds = new Set<string>(PINNED_OBSERVABLE_AMBIGUITY_STRESS_SCENARIO_IDS);
const scenarioExcludedStrictUnknown = scenarioExcludedUnknown.filter((item) => strictUnknownHoldoutIds.has(item.scenario));
const scenarioExcludedExactEquivalence = scenarioExcludedUnknown.filter((item) => exactEquivalenceIds.has(item.scenario));
const scenarioExcludedNonExactAmbiguous = scenarioExcludedUnknown.filter((item) => ambiguityStressIds.has(item.scenario));
const fittedTemplateCases = cases.filter((item) => !scenarioExcludedIds.has(item.scenario) && item.componentFitEligible);
const identifiableFitEligibleKnown = known.filter((item) => !scenarioExcludedIds.has(item.scenario) && item.componentFitEligible);
const fittedUnknownTemplates = unknown.filter((item) => !scenarioExcludedIds.has(item.scenario) && item.componentFitEligible);
const knownCovered = identifiableFitEligibleKnown.filter((item) => item.result !== 'unknown');
const labels = [...OBSERVABLE_LEAF_CLASSES];
// A one-hot target is a proper score only where the corpus declares one
// allowed observable truth. Ambiguous/equivalent cases remain decision- and
// set-compatibility tests, never secretly scored against one privileged label.
const singletonAllowedTruthFittedTemplateCases = fittedTemplateCases.filter((item) => item.allowedModelTruths.length === 1);
const singletonAllowedTruthCases = cases.filter((item) => item.allowedModelTruths.length === 1);
const fittedTemplateBrier = mean(singletonAllowedTruthFittedTemplateCases.map((item) => labels.reduce((sum, label) => {
  const probability = item.posterior[label] ?? 0;
  const target = label === item.modelTruth ? 1 : 0;
  return sum + (probability - target) ** 2;
}, 0)));
const fittedTemplateLogLoss = -mean(singletonAllowedTruthFittedTemplateCases.map((item) => Math.log(Math.max(1e-15, item.truthPosterior))));
const fittedTemplateEce = expectedCalibrationError(singletonAllowedTruthFittedTemplateCases.map((item) => ({ confidence: item.topLeafPosterior, correct: item.topLeaf === item.modelTruth })), 10);
const allSingletonAllowedTruthLogLossDiagnostic = -mean(singletonAllowedTruthCases.map((item) => Math.log(Math.max(1e-15, item.truthPosterior))));
const fittedUnknownPosteriorAuroc = auroc([
  ...fittedUnknownTemplates.map((item) => ({ score: item.unknownPosterior, positive: true })),
  ...identifiableFitEligibleKnown.map((item) => ({ score: item.unknownPosterior, positive: false })),
]);
const scenarioExcludedStrictTypicalityAuroc = auroc([
  ...scenarioExcludedStrictUnknown.map((item) => ({ score: 1 - item.knownSupportRank, positive: true })),
  ...identifiableFitEligibleKnown.map((item) => ({ score: 1 - item.knownSupportRank, positive: false })),
]);
const exactEquivalenceCompatibleRate = fraction(scenarioExcludedExactEquivalence, (item) => item.acceptedHierarchy);
const strictHoldoutRejectionRate = fraction(scenarioExcludedStrictUnknown, (item) => item.result === 'unknown');
const confusion = Object.fromEntries(canonicalClassificationScenarios.map((scenario) => [
  scenario.id,
  counts(cases.filter((item) => item.scenario === scenario.id).map((item) => item.result)),
]));
const classwiseKnown = Object.fromEntries(OBSERVABLE_LEAF_CLASSES.filter((truth) => truth !== 'unknown-signal').map((truth) => {
  const selected = identifiableFitEligibleKnown.filter((item) => item.modelTruth === truth);
  return [truth, {
    samples: selected.length,
    topLeafAccuracy: fraction(selected, (item) => item.topLeaf === item.modelTruth),
    hierarchicalAccuracy: fraction(selected, (item) => item.acceptedHierarchy),
    coverage: fraction(selected, (item) => item.result !== 'unknown'),
  }];
}));
const minimumKnownClassHierarchicalAccuracy = Math.min(...Object.values(classwiseKnown).map((value) => value.hierarchicalAccuracy));
// A per-class sensitivity floor is meaningful only in the SNR region where
// acquisition itself is required to be reliable. Lower-SNR rows remain in the
// all-SNR diagnostics and global proper scores, but an honest open-set model is
// allowed to abstain there instead of being forced to label an atypical trace.
const classwiseKnownHighSnr = Object.fromEntries(OBSERVABLE_LEAF_CLASSES.filter((truth) => truth !== 'unknown-signal').map((truth) => {
  const selected = identifiableFitEligibleKnown.filter((item) => item.modelTruth === truth && item.snrDb >= HIGH_SNR_MINIMUM_DB);
  return [truth, {
    samples: selected.length,
    topLeafAccuracy: fraction(selected, (item) => item.topLeaf === item.modelTruth),
    hierarchicalAccuracy: fraction(selected, (item) => item.acceptedHierarchy),
    coverage: fraction(selected, (item) => item.result !== 'unknown'),
  }];
}));
const minimumHighSnrKnownClassHierarchicalAccuracy = Math.min(
  ...Object.values(classwiseKnownHighSnr).map((value) => value.hierarchicalAccuracy),
);
const admissionByScenario = Object.fromEntries(canonicalClassificationScenarios.map((scenario) => {
  const selected = admissionAttempts.filter((item) => item.scenario === scenario.id);
  return [scenario.id, {
    corpusTruth: scenario.truthClass,
    modelTruth: modelTruth(scenario.truthClass),
    allowedModelTruths: [...new Set(scenario.allowedObservableClasses.map(modelTruth))],
    allSnr: admissionSummary(selected),
    highSnr: admissionSummary(selected.filter((item) => item.snrDb >= HIGH_SNR_MINIMUM_DB)),
  }];
}));
const bySnr = Object.fromEntries(SNR_DB.map((snrDb) => {
  const selected = cases.filter((item) => item.snrDb === snrDb);
  return [snrDb, {
    attempts: admissionSummary(admissionAttempts.filter((item) => item.snrDb === snrDb)),
    firstReadyRepresentativeSamples: selected.length,
    topLeafAccuracy: fraction(selected, (item) => item.topLeaf === item.modelTruth),
    hierarchicalAccuracy: fraction(selected, (item) => item.acceptedHierarchy),
    knownCoverage: fraction(selected.filter((item) => item.modelTruth !== 'unknown-signal'), (item) => item.result !== 'unknown'),
    unknownRejection: fraction(selected.filter((item) => item.modelTruth === 'unknown-signal'), (item) => item.result === 'unknown'),
  }];
}));
const byRbwDivisor = Object.fromEntries(RBW_DIVISORS.map((rbwDivisor) => {
  const selectedAttempts = admissionAttempts.filter((item) => item.rbwDivisor === rbwDivisor);
  const selectedCases = cases.filter((item) => item.rbwDivisor === rbwDivisor);
  return [rbwDivisor, {
    attempts: admissionSummary(selectedAttempts),
    firstReadyRepresentativeSamples: selectedCases.length,
    actualRbwHz: numericSummary(selectedAttempts.map((item) => item.actualRbwHz)),
    detectedPowerSynthesisFilterWidthHz: numericSummary(
      selectedAttempts.map((item) => item.detectedPowerSynthesisFilterWidthHz),
    ),
    binWidthHz: numericSummary(selectedAttempts.map((item) => item.binWidthHz)),
    rbwToBinWidthRatio: numericSummary(selectedAttempts.map((item) => item.actualRbwHz / item.binWidthHz)),
    hierarchicalAccuracy: fraction(selectedCases, (item) => item.acceptedHierarchy),
    unknownRejection: fraction(selectedCases.filter((item) => item.modelTruth === 'unknown-signal'), (item) => item.result === 'unknown'),
  }];
}));
const evidenceViews = Object.fromEntries((['spectrum-only', 'envelope-untimed'] as const).map((view) => {
  const selected = evidenceViewCases.filter((item) => item.view === view);
  const selectedKnown = selected.filter((item) => item.modelTruth !== 'unknown-signal'
    && !scenarioExcludedIds.has(item.scenario)
    && item.componentFitEligible);
  const selectedFittedUnknown = selected.filter((item) => item.modelTruth === 'unknown-signal'
    && !scenarioExcludedIds.has(item.scenario)
    && item.componentFitEligible);
  const selectedScenarioExcluded = selected.filter((item) => scenarioExcludedIds.has(item.scenario));
  const selectedScenarioExcludedStrict = selectedScenarioExcluded.filter((item) => strictUnknownHoldoutIds.has(item.scenario));
  const selectedExactEquivalence = selectedScenarioExcluded.filter((item) => exactEquivalenceIds.has(item.scenario));
  const selectedFittedDomain = selected.filter((item) => !scenarioExcludedIds.has(item.scenario) && item.componentFitEligible);
  const selectedSingletonTruthFittedDomain = selectedFittedDomain.filter((item) => item.allowedModelTruths.length === 1);
  const falseAcceptedUnknown = selected.filter((item) => item.modelTruth === 'unknown-signal' && !item.acceptedHierarchy);
  const falseAcceptedAttemptIds = [...new Set(falseAcceptedUnknown.map((item) => item.attemptId))].sort();
  return [view, {
    admittedSamples: selected.length,
    hierarchicalAccuracy: fraction(selected, (item) => item.acceptedHierarchy),
    knownCoverage: fraction(selectedKnown, (item) => item.result !== 'unknown'),
    coveredKnownHierarchicalAccuracy: fraction(selectedKnown.filter((item) => item.result !== 'unknown'), (item) => item.acceptedHierarchy),
    fittedUnknownTemplateRejectionRate: fraction(selectedFittedUnknown, (item) => item.result === 'unknown'),
    validationOnlyUnknownDecisionRate: fraction(selectedScenarioExcluded, (item) => item.result === 'unknown'),
    exactEquivalenceSamples: selectedExactEquivalence.length,
    exactEquivalenceCompatibleRate: fraction(selectedExactEquivalence, (item) => item.acceptedHierarchy),
    strictHoldoutSamples: selectedScenarioExcludedStrict.length,
    strictHoldoutRejectionRate: fraction(selectedScenarioExcludedStrict, (item) => item.result === 'unknown'),
    falseAcceptedUnknownCount: falseAcceptedUnknown.length,
    anyFalseAcceptAttemptCount: falseAcceptedAttemptIds.length,
    anyFalseAcceptAttemptIds: falseAcceptedAttemptIds.slice(0, 50),
    falseAcceptedUnknownExamples: falseAcceptedUnknown.slice(0, 20),
    scenarioExcludedStrictSupportAuroc: auroc([
      ...selectedScenarioExcludedStrict.map((item) => ({ score: 1 - item.supportRank, positive: true })),
      ...selectedKnown.map((item) => ({ score: 1 - item.supportRank, positive: false })),
    ]),
    singletonAllowedTruthProperScoreSamples: selectedSingletonTruthFittedDomain.length,
    fittedTemplateLogLoss: -mean(selectedSingletonTruthFittedDomain.map((item) => Math.log(Math.max(1e-15, item.truthPosterior)))),
    fittedTemplateMulticlassBrier: mean(selectedSingletonTruthFittedDomain.map((item) => labels.reduce((sum, label) => {
      const probability = item.posterior[label] ?? 0;
      const target = label === item.modelTruth ? 1 : 0;
      return sum + (probability - target) ** 2;
    }, 0))),
    fittedTemplateExpectedCalibrationError: expectedCalibrationError(selectedSingletonTruthFittedDomain.map((item) => ({ confidence: item.topLeafPosterior, correct: item.topLeaf === item.modelTruth })), 10),
    knownSupport: numericSummary(selectedKnown.map((item) => item.supportRank)),
    scenarioExcludedStrictSupport: numericSummary(selectedScenarioExcludedStrict.map((item) => item.supportRank)),
  }];
}));
const falseAcceptedUnknown = unknown.filter((item) => !item.acceptedHierarchy);
const falseAcceptedUnknownAttemptIds = [...new Set(falseAcceptedUnknown.map((item) => item.attemptId))].sort();
const everReadyAttempts = admissionAttempts.filter((item) => item.everReady);
const firstReadyAttempts = admissionAttempts.filter((item) => item.admitted);
const expectedFirstReadyRepresentativeSamples = admissionAttempts.reduce((sum, item) => sum + item.everReadyRepresentativeCount, 0);
const uniqueFirstReadyRepresentativeSamples = new Set(cases.map((item) => `${item.attemptId}|${item.representativeKey}`)).size;
const associationModes = [
  'frequency-local',
  'frequency-agile-2g4-activity',
  'regular-spectral-component-activity',
] as const;
const associationByMode = Object.fromEntries(associationModes.map((associationMode) => {
  const selected = cases.filter((item) => item.associationMode === associationMode);
  const selectedUnknown = selected.filter((item) => item.modelTruth === 'unknown-signal');
  return [associationMode, {
    firstReadyRepresentativeSamples: selected.length,
    scenarios: [...new Set(selected.map((item) => item.scenario))].sort(),
    results: counts(selected.map((item) => item.result)),
    hierarchicalAccuracy: fraction(selected, (item) => item.acceptedHierarchy),
    unknownRejection: fraction(selectedUnknown, (item) => item.result === 'unknown'),
    falseAcceptedUnknownCount: selectedUnknown.filter((item) => !item.acceptedHierarchy).length,
    effectiveAdmissions: numericSummary(selected.map((item) => item.selectedTrackAdmissions)),
    localTrackAdmissions: numericSummary(selected.map((item) => item.localTrackAdmissions)),
    memberCount: numericSummary(selected.flatMap((item) => item.associationMemberCount === undefined ? [] : [item.associationMemberCount])),
    regionBandwidthHz: numericSummary(selected.flatMap((item) => item.associationRegionBandwidthHz === undefined ? [] : [item.associationRegionBandwidthHz])),
  }];
}));
const associationByScenario = Object.fromEntries(canonicalClassificationScenarios.map((scenario) => {
  const selectedAttempts = admissionAttempts.filter((item) => item.scenario === scenario.id);
  const selectedCases = cases.filter((item) => item.scenario === scenario.id);
  return [scenario.id, {
    firstReadyRepresentativeSamples: selectedCases.length,
    firstReadyModes: counts(selectedCases.map((item) => item.associationMode)),
    results: counts(selectedCases.map((item) => item.result)),
    attemptsEverRegularAssociation: selectedAttempts.filter((item) => item.everAssociationModes.includes('regular-spectral-component-activity')).length,
    attemptsFinalRegularAssociation: selectedAttempts.filter((item) => item.finalAssociationModes.includes('regular-spectral-component-activity')).length,
    attemptsEverAgileAssociation: selectedAttempts.filter((item) => item.everAssociationModes.includes('frequency-agile-2g4-activity')).length,
    attemptsFinalAgileAssociation: selectedAttempts.filter((item) => item.finalAssociationModes.includes('frequency-agile-2g4-activity')).length,
    regularAssociationsObserved: selectedAttempts.reduce((sum, item) => sum + item.regularAssociationsObserved, 0),
    agileAssociationsObserved: selectedAttempts.reduce((sum, item) => sum + item.agileAssociationsObserved, 0),
    regularAssociationExpirations: selectedAttempts.reduce((sum, item) => sum + item.regularAssociationExpirations, 0),
  }];
}));
const limitationCounts = counts(cases.flatMap((item) => item.limitations));
const scenariosWithoutHighSnrAdmission = Object.entries(admissionByScenario)
  .filter(([, value]) => value.highSnr.admitted === 0)
  .map(([scenario]) => scenario);
const expectedClassificationNonAdmissionIds = new Set<string>(PINNED_EXPECTED_CLASSIFICATION_NON_ADMISSION_SCENARIO_IDS);
const expectedNonAdmissionScenariosWithAdmission = [...expectedClassificationNonAdmissionIds]
  .filter((scenario) => (admissionByScenario[scenario]?.allSnr.admitted ?? 0) > 0)
  .sort();
const knownAcquisitionWrongAdmissions = cases
  .filter((item) => knownAcquisitionValidationIds.has(item.scenario) && !item.acceptedHierarchy);
const ordinaryKnownScenarioIds = canonicalClassificationScenarios
  .filter((scenario) => modelTruth(scenario.truthClass) !== 'unknown-signal'
    && !knownAcquisitionValidationIds.has(scenario.id))
  .map((scenario) => scenario.id);
const admissionSeedCoverageByKnownScenario = Object.fromEntries(ordinaryKnownScenarioIds.map((scenarioId) => {
  const minimumCoverage = scenarioId === 'bluetooth-le-advertising' ? BLE_ADVERTISING_MINIMUM_SEED_COVERAGE : 1;
  const requiredSeeds = Math.ceil(NUISANCE_SHIFT_SEEDS.length * minimumCoverage);
  const bySnr = Object.fromEntries(ADMISSION_SEED_COVERAGE_SNR_DB.map((snrDb) => {
    const coveredSeeds = NUISANCE_SHIFT_SEEDS.filter((seed) => admissionAttempts.some((item) =>
      item.scenario === scenarioId && item.snrDb === snrDb && item.seed === seed && item.admitted));
    const uncoveredSeeds = NUISANCE_SHIFT_SEEDS.filter((seed) => !coveredSeeds.includes(seed));
    return [snrDb, {
      coveredSeeds,
      uncoveredSeeds,
      uniqueSeedsCovered: coveredSeeds.length,
      totalSeeds: NUISANCE_SHIFT_SEEDS.length,
      coverage: coveredSeeds.length / NUISANCE_SHIFT_SEEDS.length,
      requiredSeeds,
      passed: coveredSeeds.length >= requiredSeeds,
      admittingRbwDivisorsBySeed: Object.fromEntries(coveredSeeds.map((seed) => [seed, admissionAttempts
        .filter((item) => item.scenario === scenarioId && item.snrDb === snrDb && item.seed === seed && item.admitted)
        .map((item) => item.rbwDivisor)
        .sort((left, right) => left - right)])),
    }];
  }));
  return [scenarioId, { minimumCoverage, requiredSeeds, bySnr }];
}));
const knownAdmissionSeedCoverageFailures = Object.entries(admissionSeedCoverageByKnownScenario).flatMap(([scenarioId, audit]) =>
  Object.entries(audit.bySnr)
    .filter(([, cell]) => !cell.passed)
    .map(([snrDb, cell]) => ({ scenarioId, snrDb: Number(snrDb), ...cell })));

const expectedRollingKnownScenarioIds = expectedComponentAssignments
  .filter((assignment) => assignment.classId !== 'unknown-signal')
  .map((assignment) => assignment.scenarioId)
  .sort();
const observedRollingKnownScenarioIds = [...new Set(rollingWindowCases.map((item) => item.scenario))].sort();
const missingRollingKnownScenarioIds = setDifference(expectedRollingKnownScenarioIds, observedRollingKnownScenarioIds);
const rollingWindowKeys = rollingWindowCases.map((item) =>
  `${item.attemptId}:${item.readyOpportunity}:${item.representativeKey}`);
const uniqueRollingWindowCases = new Set(rollingWindowKeys).size;
const duplicateRollingWindowKeys = duplicateStrings(rollingWindowKeys);
const rollingKnownCoverage = fraction(rollingWindowCases, (item) => item.result !== 'unknown');
const rollingKnownHierarchicalAccuracy = fraction(rollingWindowCases, (item) => item.acceptedHierarchy);
const rollingIncompatibleNonUnknown = rollingWindowCases.filter((item) => item.result !== 'unknown' && !item.acceptedHierarchy);
const truthClassDomainRollingWindowCases = rollingWindowCases.filter((item) => item.truthClassDomainEligible);
const rollingByScenario = Object.fromEntries(expectedRollingKnownScenarioIds.map((scenarioId) => {
  const selected = rollingWindowCases.filter((item) => item.scenario === scenarioId);
  return [scenarioId, {
    cases: selected.length,
    knownCoverage: fraction(selected, (item) => item.result !== 'unknown'),
    hierarchicalAccuracy: fraction(selected, (item) => item.acceptedHierarchy),
    minimumSupportRank: selected.length ? Math.min(...selected.map((item) => item.knownSupportRank)) : 0,
    truthClassDomainEligibleCases: selected.filter((item) => item.truthClassDomainEligible).length,
  }];
}));
const minimumRollingScenarioCoverage = Math.min(...Object.values(rollingByScenario).map((item) => item.knownCoverage));
const minimumRollingScenarioHierarchicalAccuracy = Math.min(
  ...Object.values(rollingByScenario).map((item) => item.hierarchicalAccuracy),
);
const priorSensitivityAudit = auditPriorSensitivity(cases);

const report = {
  qualification: 'production-detector-conditioned-mixed-nuisance-shift-and-scenario-excluded-synthetic-only',
  interpretation: 'This is development-regression evidence from re-simulated SignalLab scalar formulas. The primary matrix uses the production detector and tracker and classifies each production representative exactly once, at the first opportunity where that representative has eight admitted effective sweeps. Evidence is restricted to the prefix ending at that opportunity; no endpoint, future-look, or retrospective best-track selection is used. A separate high-SNR spectrum-only rolling-window matrix classifies every current-qualified production representative at every subsequent online-ready opportunity; no corpus-truth or nominal-bandwidth oracle removes cases from its primary denominator. Acquisition runs for 24 opportunities under standard geometry and 96 only when the swept geometry covers the complete 2402-2480 MHz activity band. Each first-ready representative receives a separately synthesized zero-span capture tuned at its then-current peak. Local fragments that later participate in an activity association remain separate production-validation cases. The fitted formulas, SNR grid, and acquisition geometry overlap development, so this is not untouched validation, physical receiver calibration, waveform conformance, emitter identity, or protocol validation.',
  selectionPolicy: SELECTION_POLICY,
  model: BAYESIAN_WAVEFORM_MODEL,
  priorSensitivity: priorSensitivityAudit,
  integrity: {
    checkedOutCorpusSourceManifest,
    checkedOutCorpusSha256,
    checkedInModelAssetSha256,
    modelAssetManifestSha256: BAYESIAN_OBSERVABLE_MODEL_SHA256,
  },
  corpus: {
    version: CLASSIFICATION_CORPUS_VERSION,
    scenarios: canonicalClassificationScenarios.length,
    scenarioExcludedFromComponentFit: scenarioExcludedIds.size,
    manifestSplit: {
      valid: manifestSplitValid,
      validatorOwnedPins: {
        fittedUnknown: PINNED_FITTED_UNKNOWN_SCENARIO_IDS,
        strictUnknownHoldout: PINNED_STRICT_UNKNOWN_HOLDOUT_SCENARIO_IDS,
        observableAmbiguityStress: PINNED_OBSERVABLE_AMBIGUITY_STRESS_SCENARIO_IDS,
        exactObservableEquivalencePairs: PINNED_EXACT_OBSERVABLE_EQUIVALENCE_PAIRS,
        knownAcquisitionValidationOnly: PINNED_KNOWN_ACQUISITION_VALIDATION_ONLY_SCENARIO_IDS,
        excludedFromComponentFit: PINNED_SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS,
      },
      modelDeclared: {
        fittedUnknown: modelFittedUnknownScenarioIds,
        exactObservableEquivalenceNulls: modelExactEquivalenceIdList,
        knownAcquisitionValidationOnly: modelKnownAcquisitionValidationIdList,
        excludedFromComponentFit: modelScenarioExcludedIdList,
        componentAssignments: actualComponentAssignments,
      },
      expectedComponentAssignments,
      excludedScenarios: excludedScenarioSplit,
      exactObservableEquivalenceNulls: exactEquivalenceSplit,
      knownAcquisitionValidationOnly: knownAcquisitionValidationSplit,
      invalidExcludedScenarioIds,
      nonUnknownExcludedScenarioIds,
      duplicateExcludedScenarioIds,
      duplicateExactEquivalenceScenarioIds,
      duplicateKnownAcquisitionValidationIds,
      modelExcludedMissingPinnedIds,
      modelExcludedUnexpectedIds,
      modelExactEquivalenceMissingPinnedIds,
      modelExactEquivalenceUnexpectedIds,
      modelKnownAcquisitionMissingPinnedIds,
      modelKnownAcquisitionUnexpectedIds,
      invalidPinnedStrictUnknownHoldoutIds,
      invalidPinnedAmbiguityStressIds,
      invalidPinnedFittedUnknownIds,
      invalidPinnedExactEquivalencePairs,
      fittedUnknownMissingPinnedIds,
      fittedUnknownUnexpectedIds,
      corpusFittedUnknownMissingPinnedIds,
      corpusFittedUnknownUnexpectedIds,
      invalidKnownAcquisitionValidationIds,
      unknownTruthKnownAcquisitionValidationIds,
      knownAcquisitionValidationNotExcludedIds,
      knownAcquisitionValidationFittedComponentIds,
      duplicateFittedComponentScenarioIds,
      missingFittedComponentScenarioIds,
      unexpectedFittedComponentScenarioIds,
      wrongClassFittedComponents,
      duplicateModelClassIds,
      missingModelClassIds,
      unexpectedModelClassIds,
      invalidExactEquivalenceScenarioIds,
      nonUnknownExactEquivalenceScenarioIds,
      exactEquivalenceNotExcludedScenarioIds,
      exactEquivalenceWithoutDeclaredAlternativeIds,
      exactEquivalenceFittedComponentIds,
      ambiguousUnknownIncludedInComponentFitIds,
      excludedUnknownScenarioIds,
      fittedUnknownScenarioIds,
    },
    exactObservableEquivalencePairAudit: {
      numericalTolerance: EXACT_EQUIVALENCE_NUMERICAL_TOLERANCE,
      pairs: exactEquivalencePairAudit,
      discrepancyCount: exactEquivalenceDiscrepancyCount,
      discrepancies: exactEquivalenceDiscrepancies.slice(0, 100),
    },
  },
  productionRollingWindowValidation: {
    qualification: 'held-out-high-snr-spectrum-only-all-online-ready-representatives',
    cases: rollingWindowCases.length,
    uniqueCases: uniqueRollingWindowCases,
    knownCoverage: rollingKnownCoverage,
    hierarchicalAccuracy: rollingKnownHierarchicalAccuracy,
    incompatibleNonUnknownCount: rollingIncompatibleNonUnknown.length,
    minimumScenarioKnownCoverage: minimumRollingScenarioCoverage,
    minimumScenarioHierarchicalAccuracy: minimumRollingScenarioHierarchicalAccuracy,
    acceptanceThresholds: {
      overallKnownCoverage: ROLLING_MINIMUM_OVERALL_KNOWN_COVERAGE,
      overallHierarchicalAccuracy: ROLLING_MINIMUM_OVERALL_HIERARCHICAL_ACCURACY,
      perScenarioKnownCoverage: ROLLING_MINIMUM_PER_SCENARIO_KNOWN_COVERAGE,
      perScenarioHierarchicalAccuracy: ROLLING_MINIMUM_PER_SCENARIO_HIERARCHICAL_ACCURACY,
    },
    missingScenarios: missingRollingKnownScenarioIds,
    byScenario: rollingByScenario,
    failures: rollingWindowCases.filter((item) => !item.acceptedHierarchy).slice(0, 50),
    truthConditionedClassDomainDiagnostic: {
      qualification: 'secondary-diagnostic-not-primary-denominator',
      cases: truthClassDomainRollingWindowCases.length,
      knownCoverage: fraction(truthClassDomainRollingWindowCases, (item) => item.result !== 'unknown'),
      hierarchicalAccuracy: fraction(truthClassDomainRollingWindowCases, (item) => item.acceptedHierarchy),
    },
  },
  matrix: {
    scenarioSelection: diagnosticScenarioIdSet.size === 0
      ? { mode: 'full-corpus', scenarioIds: validationScenarios.map((scenario) => scenario.id) }
      : { mode: 'diagnostic-subset', scenarioIds: validationScenarios.map((scenario) => scenario.id) },
    nuisanceShiftSeeds: NUISANCE_SHIFT_SEEDS,
    snrDb: SNR_DB,
    rbwDivisors: RBW_DIVISORS,
    temporalSchedule: PINNED_VALIDATION_TEMPORAL_SCHEDULE,
    observationOpportunityHorizons: {
      standard: STANDARD_OBSERVATION_OPPORTUNITIES,
      fullBand2g4: FULL_BAND_2G4_OBSERVATION_OPPORTUNITIES,
    },
    attemptsByObservationHorizon: counts(admissionAttempts.map((item) => String(item.observationHorizon))),
    classificationAdmissions: CLASSIFICATION_ADMISSIONS,
    sweepPoints: SWEEP_POINTS,
    sweepTimeSeconds: SWEEP_TIME_SECONDS,
    zeroSpanPoints: ZERO_SPAN_POINTS,
    zeroSpanSamplePeriodSeconds: ZERO_SPAN_SAMPLE_PERIOD_SECONDS,
    detectedPowerSynthesisFilterPolicy: PINNED_DETECTED_POWER_SYNTHESIS_FILTER_POLICY,
    detectionConfig: PRODUCTION_DETECTION_CONFIG,
    selectionPolicy: SELECTION_POLICY,
    representativeEligibilityPolicy: 'observation-only-hypothesis-domain-v5',
    samplingPartitionAudit: {
      valid: samplingPartitionsDisjoint,
      modelFittingSeeds,
      modelCalibrationSeeds,
      validationSeeds: NUISANCE_SHIFT_SEEDS,
      modelFittingRbwDivisors,
      modelCalibrationRbwDivisors,
      modelFittingAcquisitionRegimeIds,
      modelCalibrationAcquisitionRegimeIds,
      validationRbwDivisors: RBW_DIVISORS,
      fittingCalibrationSeedOverlap,
      validationFittingSeedOverlap,
      validationCalibrationSeedOverlap,
      validationFittingRbwOverlap,
      validationCalibrationRbwOverlap,
      validationTemporalPartitionDisjoint,
      validationTemporalScheduleIdOverlap,
      validationFitTemporalSourceLookIndexOverlap,
    },
    tailCalibrationAudit: {
      valid: tailCalibrationPolicyValid,
      pinnedScoreUnit: PINNED_TAIL_CALIBRATION_SCORE_UNIT,
      modelScoreUnit: BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationScoreUnit,
      pinnedRepresentativeSelectionPolicy: PINNED_TAIL_CALIBRATION_SELECTION_POLICY,
      modelRepresentativeSelectionPolicy: BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRepresentativeSelectionPolicy,
      pinnedRepresentativeAggregationPolicy: PINNED_TAIL_CALIBRATION_AGGREGATION_POLICY,
      modelRepresentativeAggregationPolicy: BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRepresentativeAggregationPolicy,
      pinnedRuntimeInterpretationPolicy: PINNED_TAIL_CALIBRATION_RUNTIME_INTERPRETATION_POLICY,
      modelRuntimeInterpretationPolicy: BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRuntimeInterpretationPolicy,
      pinnedStatisticalInterpretation: PINNED_TAIL_CALIBRATION_STATISTICAL_INTERPRETATION,
      modelStatisticalInterpretation: BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationStatisticalInterpretation,
      attemptCountsByScenario: modelTailCalibrationAttemptCounts,
      missingScenarioIds: missingTailCalibrationScenarioIds,
      unexpectedScenarioIds: unexpectedTailCalibrationScenarioIds,
      invalidAttemptCounts: invalidTailCalibrationAttemptCounts,
      viewCountMismatches: tailCalibrationViewCountMismatches,
      matrixPinsValid: tailCalibrationMatrixPinsValid,
      productionAcquisitionRegimePinsValid,
      pinnedSignalLabProductionAcquisitionRegime: PINNED_SIGNAL_LAB_PRODUCTION_ACQUISITION_REGIME,
      validatorOwnedMatrix: {
        snrDb: PINNED_TAIL_CALIBRATION_SNR_DB,
        rbwDivisors: PINNED_TAIL_CALIBRATION_RBW_DIVISORS,
        acquisitionRegimeIds: PINNED_TAIL_CALIBRATION_ACQUISITION_REGIME_IDS,
        seeds: PINNED_TAIL_CALIBRATION_SEEDS,
      },
      independentRecomputation: independentTailCalibrationAudit,
    },
  },
  admission: {
    attempted: admissionAttempts.length,
    everReady: everReadyAttempts.length,
    firstReady: firstReadyAttempts.length,
    admitted: firstReadyAttempts.length,
    firstReadyRepresentativeSamples: cases.length,
    expectedFirstReadyRepresentativeSamples,
    uniqueFirstReadyRepresentativeSamples,
    misses: admissionMisses.length,
    everReadyRate: fraction(admissionAttempts, (item) => item.everReady),
    firstReadyRate: fraction(admissionAttempts, (item) => item.admitted),
    admissionRate: fraction(admissionAttempts, (item) => item.admitted),
    missExamples: admissionMisses.slice(0, 50),
    highSnrMinimumDb: HIGH_SNR_MINIMUM_DB,
    highSnr: admissionSummary(admissionAttempts.filter((item) => item.snrDb >= HIGH_SNR_MINIMUM_DB)),
    scenariosWithoutHighSnrAdmission,
    expectedClassificationNonAdmissionScenarios: [...expectedClassificationNonAdmissionIds].sort(),
    expectedNonAdmissionScenariosWithAdmission,
    knownAcquisitionWrongAdmissionCount: knownAcquisitionWrongAdmissions.length,
    knownAcquisitionWrongAdmissionExamples: knownAcquisitionWrongAdmissions.slice(0, 50)
      .map(({ posterior: _posterior, features: _features, ...item }) => item),
    highSnrUniqueSeedCoverage: {
      snrDb: ADMISSION_SEED_COVERAGE_SNR_DB,
      validationSeeds: NUISANCE_SHIFT_SEEDS,
      ordinaryKnownRequiredCoverage: 1,
      bluetoothLeAdvertisingRequiredCoverage: BLE_ADVERTISING_MINIMUM_SEED_COVERAGE,
      byKnownScenario: admissionSeedCoverageByKnownScenario,
      failures: knownAdmissionSeedCoverageFailures,
    },
    byScenario: admissionByScenario,
    byRbwDivisor,
  },
  classificationConditionalOnAdmission: {
    samples: cases.length,
    identifiableFitEligibleSamples: fittedTemplateCases.length,
    singletonAllowedTruthProperScoreSamples: singletonAllowedTruthFittedTemplateCases.length,
    properScoreQualification: 'one-hot log loss, multiclass Brier score, and ECE include only fit-domain cases with exactly one declared allowed observable truth',
    identifiableFitEligibleKnownSamples: identifiableFitEligibleKnown.length,
    validationOnlyExcludedSamples: scenarioExcludedUnknown.length,
    componentFitEligibleSamples: cases.filter((item) => item.componentFitEligible).length,
    componentFitIneligibleSamples: cases.filter((item) => !item.componentFitEligible).length,
    componentFitIneligibleByScenario: counts(cases.filter((item) => !item.componentFitEligible).map((item) => item.scenario)),
    componentFitIneligibleByAssociationMode: counts(cases.filter((item) => !item.componentFitEligible).map((item) => item.associationMode)),
    hierarchicalAccuracy: fraction(cases, (item) => item.acceptedHierarchy),
    fittedTemplateTopLeafAccuracy: fraction(fittedTemplateCases, (item) => item.topLeaf === item.modelTruth),
    knownTopLeafAccuracy: fraction(identifiableFitEligibleKnown, (item) => item.topLeaf === item.modelTruth),
    knownCoverage: fraction(identifiableFitEligibleKnown, (item) => item.result !== 'unknown'),
    coveredKnownHierarchicalAccuracy: fraction(knownCovered, (item) => item.acceptedHierarchy),
    minimumKnownClassHierarchicalAccuracy,
    classwiseKnown,
    highSnrMinimumDb: HIGH_SNR_MINIMUM_DB,
    minimumHighSnrKnownClassHierarchicalAccuracy,
    classwiseKnownHighSnr,
    fittedUnknownTemplateRejectionRate: fraction(fittedUnknownTemplates, (item) => item.result === 'unknown'),
    fittedUnknownPosteriorAuroc,
    scenarioExcludedFromComponentFitScenarios: [...scenarioExcludedIds],
    knownAcquisitionValidationOnlyScenarios: [...knownAcquisitionValidationIds],
    scenarioExcludedUnknownSamples: scenarioExcludedUnknown.length,
    validationOnlyUnknownDecisionRate: fraction(scenarioExcludedUnknown, (item) => item.result === 'unknown'),
    scenarioExcludedStrictUnknownSamples: scenarioExcludedStrictUnknown.length,
    scenarioExcludedStrictUnknownRejectionRate: strictHoldoutRejectionRate,
    scenarioExcludedNonExactAmbiguousSamples: scenarioExcludedNonExactAmbiguous.length,
    exactEquivalenceSamples: scenarioExcludedExactEquivalence.length,
    exactEquivalenceCompatibleRate,
    exactEquivalenceDecisionCounts: counts(scenarioExcludedExactEquivalence.map((item) => item.result)),
    validationOnlyAllowedDecisionRate: fraction(scenarioExcludedUnknown, (item) => item.acceptedHierarchy),
    scenarioExcludedStrictTypicalityAuroc,
    falseAcceptedUnknownCount: falseAcceptedUnknown.length,
    anyFalseAcceptAttemptCount: falseAcceptedUnknownAttemptIds.length,
    anyFalseAcceptAttemptIds: falseAcceptedUnknownAttemptIds,
    falseAcceptedUnknownExamples: falseAcceptedUnknown.slice(0, 50),
    modelSupportRank: {
      identifiableFitEligibleKnown: numericSummary(identifiableFitEligibleKnown.map((item) => item.knownSupportRank)),
      scenarioExcludedUnknown: numericSummary(scenarioExcludedUnknown.map((item) => item.knownSupportRank)),
    },
    fittedTemplateLogLoss,
    fittedTemplateMulticlassBrier: fittedTemplateBrier,
    fittedTemplateExpectedCalibrationError: fittedTemplateEce,
    allSingletonAllowedTruthLogLossDiagnostic: {
      value: allSingletonAllowedTruthLogLossDiagnostic,
      samples: singletonAllowedTruthCases.length,
      qualification: 'one-hot diagnostic restricted to cases declaring exactly one allowed observable truth',
    },
    evidenceViews,
    bySnr,
    byRbwDivisor,
    association: {
      firstReadySelectionModes: counts(cases.map((item) => item.associationMode)),
      everAttemptModes: counts(admissionAttempts.flatMap((item) => item.everAssociationModes)),
      finalAttemptModes: counts(admissionAttempts.flatMap((item) => item.finalAssociationModes)),
      byMode: associationByMode,
      byScenario: associationByScenario,
    },
    limitations: limitationCounts,
    confusion,
    failures: cases.filter((item) => !item.acceptedHierarchy).slice(0, 50).map(({ posterior: _posterior, features: _features, ...item }) => item),
  },
};
const conditional = report.classificationConditionalOnAdmission;
const acceptanceFailures = [
  diagnosticScenarioIdSet.size > 0 ? 'diagnostic scenario subset is never an acceptance run' : undefined,
  BAYESIAN_OBSERVABLE_MODEL.classModels.length !== 12 ? `expected 12 v5 model classes, observed ${BAYESIAN_OBSERVABLE_MODEL.classModels.length}` : undefined,
  BAYESIAN_OBSERVABLE_MODEL.sourceCommit !== PINNED_SIGNAL_LAB_COMMIT ? `model source commit ${BAYESIAN_OBSERVABLE_MODEL.sourceCommit} does not match pinned ${PINNED_SIGNAL_LAB_COMMIT}` : undefined,
  BAYESIAN_OBSERVABLE_MODEL.corpusVersion !== CLASSIFICATION_CORPUS_VERSION ? `model corpus version ${BAYESIAN_OBSERVABLE_MODEL.corpusVersion} does not match checked-out ${CLASSIFICATION_CORPUS_VERSION}` : undefined,
  JSON.stringify(BAYESIAN_OBSERVABLE_MODEL.corpusSourceManifest) !== JSON.stringify(checkedOutCorpusSourceManifest)
    ? 'model corpus source manifest does not match the validator-owned checked-out artifact set'
    : undefined,
  BAYESIAN_OBSERVABLE_MODEL.corpusSha256 !== checkedOutCorpusSha256 ? `model corpus SHA-256 ${BAYESIAN_OBSERVABLE_MODEL.corpusSha256} does not match checked-out ${checkedOutCorpusSha256}` : undefined,
  checkedInModelAssetSha256 !== BAYESIAN_OBSERVABLE_MODEL_SHA256 ? `model asset SHA-256 ${checkedInModelAssetSha256} does not match manifest ${BAYESIAN_OBSERVABLE_MODEL_SHA256}` : undefined,
  admissionAttempts.length !== expectedAttempts ? `expected ${expectedAttempts} production-pipeline attempts, observed ${admissionAttempts.length}` : undefined,
  cases.length !== expectedFirstReadyRepresentativeSamples ? `classified ${cases.length} first-ready representatives, expected ${expectedFirstReadyRepresentativeSamples}` : undefined,
  uniqueFirstReadyRepresentativeSamples !== cases.length ? `first-ready classification contains ${cases.length - uniqueFirstReadyRepresentativeSamples} duplicate attempt/representative samples` : undefined,
  cases.length === 0 ? 'production detector/tracker admitted no validation cases' : undefined,
  rollingWindowCases.length === 0 ? 'production rolling-window validation admitted no current-qualified known cases' : undefined,
  duplicateRollingWindowKeys.length !== 0
    ? `production rolling-window validation contains ${rollingWindowCases.length - uniqueRollingWindowCases} extra samples across ${duplicateRollingWindowKeys.length} duplicate attempt/opportunity/representative keys`
    : undefined,
  missingRollingKnownScenarioIds.length !== 0
    ? `production rolling-window validation is missing fitted known scenarios: ${missingRollingKnownScenarioIds.join(', ')}`
    : undefined,
  rollingKnownCoverage < ROLLING_MINIMUM_OVERALL_KNOWN_COVERAGE
    ? `production rolling-window known coverage ${rollingKnownCoverage} < ${ROLLING_MINIMUM_OVERALL_KNOWN_COVERAGE}`
    : undefined,
  rollingKnownHierarchicalAccuracy < ROLLING_MINIMUM_OVERALL_HIERARCHICAL_ACCURACY
    ? `production rolling-window hierarchical accuracy ${rollingKnownHierarchicalAccuracy} < ${ROLLING_MINIMUM_OVERALL_HIERARCHICAL_ACCURACY}`
    : undefined,
  rollingIncompatibleNonUnknown.length !== 0
    ? `production rolling-window validation emitted ${rollingIncompatibleNonUnknown.length} incompatible non-unknown decisions`
    : undefined,
  minimumRollingScenarioCoverage < ROLLING_MINIMUM_PER_SCENARIO_KNOWN_COVERAGE
    ? `minimum per-scenario production rolling-window known coverage ${minimumRollingScenarioCoverage} < ${ROLLING_MINIMUM_PER_SCENARIO_KNOWN_COVERAGE}`
    : undefined,
  minimumRollingScenarioHierarchicalAccuracy < ROLLING_MINIMUM_PER_SCENARIO_HIERARCHICAL_ACCURACY
    ? `minimum per-scenario production rolling-window hierarchical accuracy ${minimumRollingScenarioHierarchicalAccuracy} < ${ROLLING_MINIMUM_PER_SCENARIO_HIERARCHICAL_ACCURACY}`
    : undefined,
  !samplingPartitionsDisjoint
    ? `sampling partitions overlap or lack metadata (fit/cal seeds=${fittingCalibrationSeedOverlap.join(',') || 'none'}; validation/fit seeds=${validationFittingSeedOverlap.join(',') || 'none'}; validation/cal seeds=${validationCalibrationSeedOverlap.join(',') || 'none'}; validation/fit RBWs=${validationFittingRbwOverlap.join(',') || 'none'}; validation/cal RBWs=${validationCalibrationRbwOverlap.join(',') || 'none'}; validation/fit temporal IDs=${validationTemporalScheduleIdOverlap.join(',') || 'none'}; validation/fit temporal source indices=${validationFitTemporalSourceLookIndexOverlap.join(',') || 'none'}; calibration-seed-count=${modelCalibrationSeeds.length}; calibration-RBW-count=${modelCalibrationRbwDivisors.length}; production-regime-pins=${productionAcquisitionRegimePinsValid})`
    : undefined,
  !tailCalibrationPolicyValid
    ? `tail-calibration policy/manifest is invalid (score-unit=${BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationScoreUnit ?? 'missing'}; selection=${BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRepresentativeSelectionPolicy ?? 'missing'}; aggregation=${BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRepresentativeAggregationPolicy ?? 'missing'}; runtime-interpretation=${BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationRuntimeInterpretationPolicy ?? 'missing'}; statistical-interpretation=${BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationStatisticalInterpretation ?? 'missing'}; matrix-pins=${tailCalibrationMatrixPinsValid}; production-regime-pins=${productionAcquisitionRegimePinsValid}; missing-scenarios=${missingTailCalibrationScenarioIds.join(',') || 'none'}; unexpected-scenarios=${unexpectedTailCalibrationScenarioIds.join(',') || 'none'}; invalid-counts=${invalidTailCalibrationAttemptCounts.map((item) => `${item.scenarioId}:${item.count}`).join(',') || 'none'}; view-count-mismatches=${tailCalibrationViewCountMismatches.map((item) => `${item.classId}/${item.view}:${item.observed}/${item.expected}`).join(',') || 'none'})`
    : undefined,
  !independentTailCalibrationAudit.valid
    ? `independent tail-calibration recomputation failed (attempt-count-mismatches=${independentTailCalibrationAudit.attemptCountMismatches.length}; score-mismatches=${independentTailCalibrationAudit.scoreComparisons.filter((item) => item.expectedCount !== item.observedCount || item.maximumAbsoluteDifference > independentTailCalibrationAudit.scoreTolerance).length}; late-minima=${independentTailCalibrationAudit.lateMinimumCount}; aggregation-regression=${independentTailCalibrationAudit.aggregationRegression.passed})`
    : undefined,
  !priorSensitivityAudit.valid
    ? `engineering-prior sensitivity failed (model-prior-pin=${priorSensitivityAudit.modelPriorMatchesPinned}; baseline-mismatches=${priorSensitivityAudit.baselineDecisionMismatchCount}; failing-variants=${priorSensitivityAudit.variants.filter((variant) => !variant.passed).map((variant) => variant.id).join(',') || 'none'})`
    : undefined,
  !manifestSplitValid ? `model manifest split is invalid (missing-pinned-exclusions=${modelExcludedMissingPinnedIds.join(',') || 'none'}; unexpected-model-exclusions=${modelExcludedUnexpectedIds.join(',') || 'none'}; missing-pinned-exact=${modelExactEquivalenceMissingPinnedIds.join(',') || 'none'}; unexpected-model-exact=${modelExactEquivalenceUnexpectedIds.join(',') || 'none'}; missing-pinned-known-acquisition=${modelKnownAcquisitionMissingPinnedIds.join(',') || 'none'}; unexpected-model-known-acquisition=${modelKnownAcquisitionUnexpectedIds.join(',') || 'none'}; missing-fitted-unknown=${fittedUnknownMissingPinnedIds.join(',') || 'none'}; unexpected-fitted-unknown=${fittedUnknownUnexpectedIds.join(',') || 'none'}; missing-exclusions=${invalidExcludedScenarioIds.join(',') || 'none'}; unexpected-non-unknown-exclusions=${nonUnknownExcludedScenarioIds.join(',') || 'none'}; duplicate-exclusions=${duplicateExcludedScenarioIds.join(',') || 'none'}; invalid-known-acquisition=${invalidKnownAcquisitionValidationIds.join(',') || 'none'}; unknown-truth-known-acquisition=${unknownTruthKnownAcquisitionValidationIds.join(',') || 'none'}; known-acquisition-not-excluded=${knownAcquisitionValidationNotExcludedIds.join(',') || 'none'}; fitted-known-acquisition=${knownAcquisitionValidationFittedComponentIds.join(',') || 'none'}; missing-exact=${invalidExactEquivalenceScenarioIds.join(',') || 'none'}; non-unknown-exact=${nonUnknownExactEquivalenceScenarioIds.join(',') || 'none'}; exact-not-excluded=${exactEquivalenceNotExcludedScenarioIds.join(',') || 'none'}; exact-without-alternative=${exactEquivalenceWithoutDeclaredAlternativeIds.join(',') || 'none'}; fitted-exact-components=${exactEquivalenceFittedComponentIds.join(',') || 'none'}; fitted-ambiguous-unknown=${ambiguousUnknownIncludedInComponentFitIds.join(',') || 'none'}; fitted-unknown=${fittedUnknownScenarioIds.length}; excluded-unknown=${excludedUnknownScenarioIds.length})` : undefined,
  !manifestSplitValid ? `component assignment audit (duplicate=${duplicateFittedComponentScenarioIds.join(',') || 'none'}; missing=${missingFittedComponentScenarioIds.join(',') || 'none'}; unexpected=${unexpectedFittedComponentScenarioIds.join(',') || 'none'}; wrong-class=${wrongClassFittedComponents.map((item) => `${item.scenarioId}:${item.classId}->${item.expectedClassId}`).join(',') || 'none'}; duplicate-classes=${duplicateModelClassIds.join(',') || 'none'}; missing-classes=${missingModelClassIds.join(',') || 'none'}; unexpected-classes=${unexpectedModelClassIds.join(',') || 'none'})` : undefined,
  exactEquivalenceDiscrepancyCount !== 0 ? `${exactEquivalenceDiscrepancyCount} exact-equivalence paired nuisance checks differ` : undefined,
  knownAdmissionSeedCoverageFailures.length ? `${knownAdmissionSeedCoverageFailures.length} per-scenario/per-SNR known admission seed-coverage cells failed` : undefined,
  expectedNonAdmissionScenariosWithAdmission.length
    ? `expected-non-admission policy is stale: admissions observed for ${expectedNonAdmissionScenariosWithAdmission.join(', ')}` : undefined,
  knownAcquisitionWrongAdmissions.length ? `${knownAcquisitionWrongAdmissions.length} admitted known-acquisition-validation cases had incompatible decisions` : undefined,
  singletonAllowedTruthFittedTemplateCases.length === 0 ? 'no singleton-allowed-truth fitted cases available for proper-score diagnostics' : undefined,
  fittedUnknownTemplates.length === 0 ? 'no fitted unknown-template cases reached classification admission' : undefined,
  scenarioExcludedUnknown.length === 0 ? 'no scenario-excluded unknown cases reached classification admission' : undefined,
  scenarioExcludedStrictUnknown.length === 0 ? 'no strict unknown holdout cases reached classification admission' : undefined,
  strictHoldoutRejectionRate < 1 ? `strict unknown holdout rejection rate ${strictHoldoutRejectionRate} < 1` : undefined,
  scenarioExcludedExactEquivalence.length === 0 ? 'no exact observable-equivalence null cases reached classification admission' : undefined,
  exactEquivalenceCompatibleRate < 1 ? `exact observable-equivalence compatibility ${exactEquivalenceCompatibleRate} < 1` : undefined,
  falseAcceptedUnknown.length !== 0 ? `false-accepted ${falseAcceptedUnknown.length} admitted unknown scenarios` : undefined,
  falseAcceptedUnknownAttemptIds.length !== 0 ? `${falseAcceptedUnknownAttemptIds.length} attempts had at least one false-accepted unknown first-ready representative` : undefined,
  conditional.hierarchicalAccuracy < 0.95 ? `admission-conditional hierarchical accuracy ${conditional.hierarchicalAccuracy} < 0.95` : undefined,
  conditional.knownTopLeafAccuracy < 0.85 ? `admission-conditional known top-leaf accuracy ${conditional.knownTopLeafAccuracy} < 0.85` : undefined,
  conditional.knownCoverage < 0.95 ? `admission-conditional known coverage ${conditional.knownCoverage} < 0.95` : undefined,
  conditional.minimumHighSnrKnownClassHierarchicalAccuracy < 0.9
    ? `minimum >=${HIGH_SNR_MINIMUM_DB} dB known-class hierarchical accuracy ${conditional.minimumHighSnrKnownClassHierarchicalAccuracy} < 0.9` : undefined,
  conditional.fittedTemplateLogLoss > 0.5 ? `fitted-template log loss ${conditional.fittedTemplateLogLoss} > 0.5` : undefined,
  conditional.fittedTemplateMulticlassBrier > 0.2 ? `fitted-template Brier score ${conditional.fittedTemplateMulticlassBrier} > 0.2` : undefined,
  conditional.fittedTemplateExpectedCalibrationError > 0.1 ? `fitted-template ECE ${conditional.fittedTemplateExpectedCalibrationError} > 0.1` : undefined,
  !Number.isFinite(conditional.fittedUnknownPosteriorAuroc) || conditional.fittedUnknownPosteriorAuroc < 0.9
    ? `fitted-unknown posterior AUROC ${conditional.fittedUnknownPosteriorAuroc} < 0.9 or non-finite` : undefined,
  !Number.isFinite(conditional.scenarioExcludedStrictTypicalityAuroc) || conditional.scenarioExcludedStrictTypicalityAuroc < 0.9
    ? `strict scenario-excluded support AUROC ${conditional.scenarioExcludedStrictTypicalityAuroc} < 0.9 or non-finite` : undefined,
  ...Object.entries(conditional.evidenceViews).flatMap(([view, metrics]) => [
    metrics.admittedSamples !== cases.length ? `${view} expected ${cases.length} admission-conditional cases, observed ${metrics.admittedSamples}` : undefined,
    metrics.falseAcceptedUnknownCount !== 0 ? `${view} false-accepted ${metrics.falseAcceptedUnknownCount} admitted unknown scenarios` : undefined,
    metrics.anyFalseAcceptAttemptCount !== 0 ? `${view} has ${metrics.anyFalseAcceptAttemptCount} attempts with at least one false-accepted unknown first-ready representative` : undefined,
    metrics.exactEquivalenceSamples === 0 ? `${view} has no admitted exact observable-equivalence null cases` : undefined,
    metrics.exactEquivalenceCompatibleRate < 1 ? `${view} exact observable-equivalence compatibility ${metrics.exactEquivalenceCompatibleRate} < 1` : undefined,
    metrics.strictHoldoutSamples === 0 ? `${view} has no admitted strict unknown holdout cases` : undefined,
    metrics.strictHoldoutRejectionRate < 1 ? `${view} strict unknown holdout rejection rate ${metrics.strictHoldoutRejectionRate} < 1` : undefined,
    metrics.knownCoverage < 0.8 ? `${view} known coverage ${metrics.knownCoverage} < 0.8` : undefined,
    metrics.coveredKnownHierarchicalAccuracy < 0.9 ? `${view} covered-known hierarchical accuracy ${metrics.coveredKnownHierarchicalAccuracy} < 0.9` : undefined,
    !Number.isFinite(metrics.scenarioExcludedStrictSupportAuroc) || metrics.scenarioExcludedStrictSupportAuroc < 0.9
      ? `${view} strict scenario-excluded support AUROC ${metrics.scenarioExcludedStrictSupportAuroc} < 0.9 or non-finite` : undefined,
  ]),
].filter((value): value is string => value !== undefined);
const validationAcceptance = {
  schemaVersion: 1,
  status: acceptanceFailures.length === 0 ? 'passed' : 'failed',
  acceptancePolicyId: VALIDATION_ACCEPTANCE_POLICY_ID,
  scope: diagnosticScenarioIdSet.size === 0 ? 'full-corpus' : 'diagnostic-subset',
  failureCount: acceptanceFailures.length,
  modelAssetSha256: checkedInModelAssetSha256,
  modelId: BAYESIAN_OBSERVABLE_MODEL.id,
  sourceCommit: BAYESIAN_OBSERVABLE_MODEL.sourceCommit,
  corpusVersion: BAYESIAN_OBSERVABLE_MODEL.corpusVersion,
  corpusSha256: BAYESIAN_OBSERVABLE_MODEL.corpusSha256,
  preprocessing: BAYESIAN_OBSERVABLE_MODEL.preprocessing,
  priorId: BAYESIAN_OBSERVABLE_MODEL.priorId,
  calibrationId: BAYESIAN_OBSERVABLE_MODEL.calibrationId,
  decisionPolicyId: BAYESIAN_WAVEFORM_MODEL.decisionPolicyId,
  evidenceSha256: sha256Canonical(report),
  failures: acceptanceFailures,
} as const;
const publicationReport = {
  ...report,
  validationAcceptance,
} as const;
const publishedPath = acceptanceFailures.length === 0 ? REPORT_PATH : FAILED_REPORT_PATH;
const temporaryPublishedPath = acceptanceFailures.length === 0 ? REPORT_TEMP_PATH : FAILED_REPORT_TEMP_PATH;
writeFileSync(temporaryPublishedPath, `${JSON.stringify(publicationReport, null, 2)}\n`);
renameSync(temporaryPublishedPath, publishedPath);
validationPublicationCommitted = true;
console.log(JSON.stringify({ reportPath: publishedPath, ...publicationReport }, null, 2));
if (acceptanceFailures.length) {
  console.error(`Synthetic observable-class development regression failed:\n- ${acceptanceFailures.join('\n- ')}`);
  process.exitCode = 1;
}

function publishUnexpectedValidationFailure(reason: unknown): void {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  process.exitCode = 1;
  if (validationPublicationCommitted) {
    console.error(`Observable classifier validation failed after publishing its terminal report: ${error.stack ?? error.message}`);
    return;
  }
  const failure = {
    schemaVersion: 1,
    validationAcceptance: {
      schemaVersion: 1,
      status: 'failed',
      acceptancePolicyId: VALIDATION_ACCEPTANCE_POLICY_ID,
      scope: 'preflight-or-unexpected-failure',
      failureCount: 1,
      failures: [`Unexpected validator failure: ${error.message}`],
    },
    unexpectedFailure: {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    },
  } as const;
  try {
    for (const path of [REPORT_PATH, REPORT_TEMP_PATH, FAILED_REPORT_PATH, FAILED_REPORT_TEMP_PATH]) {
      rmSync(path, { force: true });
    }
    writeFileSync(FAILED_REPORT_TEMP_PATH, `${JSON.stringify(failure, null, 2)}\n`);
    renameSync(FAILED_REPORT_TEMP_PATH, FAILED_REPORT_PATH);
    console.error(`Observable classifier validation failed before acceptance publication; diagnostic: ${FAILED_REPORT_PATH}\n${error.stack ?? error.message}`);
  } catch (publicationError) {
    const diagnostic = publicationError instanceof Error ? publicationError.stack ?? publicationError.message : String(publicationError);
    console.error(`Observable classifier validation failed and its diagnostic report could not be published: ${diagnostic}\nOriginal failure: ${error.stack ?? error.message}`);
  }
}

function auditExactEquivalencePairs(
  attempts: readonly AdmissionAttempt[],
  validationCases: readonly ValidationCase[],
  viewCases: readonly EvidenceViewCase[],
): ExactEquivalencePairAudit[] {
  return PINNED_EXACT_OBSERVABLE_EQUIVALENCE_PAIRS.map(({ referenceScenarioId, nullScenarioId }) => {
    const pair = `${referenceScenarioId}<=>${nullScenarioId}`;
    const discrepancies: ExactEquivalenceDiscrepancy[] = [];
    let nuisanceCells = 0;
    let matchedAdmissionCells = 0;
    let matchedRepresentativePairs = 0;
    let matchedEvidenceViewPairs = 0;
    const add = (
      nuisanceCell: string,
      field: string,
      reference: unknown,
      nullValue: unknown,
      representativeIndex?: number,
      view?: EvidenceViewCase['view'],
    ) => discrepancies.push({
      pair,
      nuisanceCell,
      ...(representativeIndex === undefined ? {} : { representativeIndex }),
      ...(view === undefined ? {} : { view }),
      field,
      reference,
      null: nullValue,
    });

    for (const snrDb of SNR_DB) for (const rbwDivisor of RBW_DIVISORS) for (const seed of NUISANCE_SHIFT_SEEDS) {
      nuisanceCells += 1;
      const nuisanceCell = `snr=${snrDb}:rbw=${rbwDivisor}:seed=${seed}`;
      const referenceAttempt = attempts.find((item) => item.scenario === referenceScenarioId
        && item.snrDb === snrDb && item.rbwDivisor === rbwDivisor && item.seed === seed);
      const nullAttempt = attempts.find((item) => item.scenario === nullScenarioId
        && item.snrDb === snrDb && item.rbwDivisor === rbwDivisor && item.seed === seed);
      if (!referenceAttempt || !nullAttempt) {
        add(nuisanceCell, 'admission-attempt-present', referenceAttempt !== undefined, nullAttempt !== undefined);
        continue;
      }
      const admissionFields: readonly (keyof AdmissionAttempt)[] = [
        'observationHorizon',
        'everReady',
        'admitted',
        'everReadyRepresentativeCount',
        'finalReadyRepresentativeCount',
        'finalActiveRepresentativeCount',
        'selectedTrackAdmissions',
        'maximumActiveAdmissions',
        'maximumLocalTrackAdmissions',
        'firstReadyOpportunity',
        'regularAssociationsObserved',
        'agileAssociationsObserved',
        'regularAssociationExpirations',
      ];
      let admissionMatches = true;
      for (const field of admissionFields) {
        if (!equivalentValue(referenceAttempt[field], nullAttempt[field])) {
          admissionMatches = false;
          add(nuisanceCell, `admission.${field}`, referenceAttempt[field], nullAttempt[field]);
        }
      }
      for (const field of ['everAssociationModes', 'finalAssociationModes'] as const) {
        const referenceValue = [...referenceAttempt[field]].sort().join('|');
        const nullValue = [...nullAttempt[field]].sort().join('|');
        if (referenceValue !== nullValue) {
          admissionMatches = false;
          add(nuisanceCell, `admission.${field}`, referenceValue, nullValue);
        }
      }
      if (admissionMatches) matchedAdmissionCells += 1;

      const referenceCases = validationCases
        .filter((item) => item.scenario === referenceScenarioId && item.snrDb === snrDb && item.rbwDivisor === rbwDivisor && item.seed === seed)
        .sort(compareValidationCasesForPairing);
      const nullCases = validationCases
        .filter((item) => item.scenario === nullScenarioId && item.snrDb === snrDb && item.rbwDivisor === rbwDivisor && item.seed === seed)
        .sort(compareValidationCasesForPairing);
      if (referenceCases.length !== nullCases.length) add(nuisanceCell, 'representative-count', referenceCases.length, nullCases.length);
      for (let index = 0; index < Math.min(referenceCases.length, nullCases.length); index++) {
        const referenceCase = referenceCases[index]!;
        const nullCase = nullCases[index]!;
        matchedRepresentativePairs += 1;
        compareExactCase(referenceCase, nullCase, nuisanceCell, index, add);
      }

      for (const view of ['spectrum-only', 'envelope-untimed'] as const) {
        const referenceViews = viewCases
          .filter((item) => item.scenario === referenceScenarioId && item.view === view
            && item.attemptId === validationAttemptId(referenceScenarioId, snrDb, rbwDivisor, seed))
          .sort(compareEvidenceViewCasesForPairing);
        const nullViews = viewCases
          .filter((item) => item.scenario === nullScenarioId && item.view === view
            && item.attemptId === validationAttemptId(nullScenarioId, snrDb, rbwDivisor, seed))
          .sort(compareEvidenceViewCasesForPairing);
        if (referenceViews.length !== nullViews.length) add(nuisanceCell, 'evidence-view-count', referenceViews.length, nullViews.length, undefined, view);
        for (let index = 0; index < Math.min(referenceViews.length, nullViews.length); index++) {
          matchedEvidenceViewPairs += 1;
          compareExactEvidenceView(referenceViews[index]!, nullViews[index]!, nuisanceCell, index, view, add);
        }
      }
    }
    if (matchedRepresentativePairs === 0) add('all', 'matched-representative-pairs', '>0', matchedRepresentativePairs);
    if (matchedEvidenceViewPairs === 0) add('all', 'matched-evidence-view-pairs', '>0', matchedEvidenceViewPairs);
    return {
      pair,
      referenceScenarioId,
      nullScenarioId,
      nuisanceCells,
      matchedAdmissionCells,
      matchedRepresentativePairs,
      matchedEvidenceViewPairs,
      discrepancyCount: discrepancies.length,
      discrepancies: discrepancies.slice(0, 50),
    };
  });
}

function compareExactCase(
  referenceCase: ValidationCase,
  nullCase: ValidationCase,
  nuisanceCell: string,
  representativeIndex: number,
  add: (nuisanceCell: string, field: string, reference: unknown, nullValue: unknown, representativeIndex?: number) => void,
): void {
  for (const field of [
    'firstReadyOpportunity',
    'result',
    'confidence',
    'topLeaf',
    'topLeafPosterior',
    'bandwidthHz',
    'selectedTrackAdmissions',
    'localTrackAdmissions',
    'associationMode',
    'associationMemberCount',
    'associationRegionBandwidthHz',
    'knownSupportRank',
  ] as const) {
    if (!equivalentValue(referenceCase[field], nullCase[field])) {
      add(nuisanceCell, `case.${field}`, referenceCase[field], nullCase[field], representativeIndex);
    }
  }
  compareNumericRecords(referenceCase.features, nullCase.features, 'features', nuisanceCell, representativeIndex, add);
  compareNumericRecords(referenceCase.posterior, nullCase.posterior, 'posterior', nuisanceCell, representativeIndex, add);
}

function compareExactEvidenceView(
  referenceCase: EvidenceViewCase,
  nullCase: EvidenceViewCase,
  nuisanceCell: string,
  representativeIndex: number,
  view: EvidenceViewCase['view'],
  add: (
    nuisanceCell: string,
    field: string,
    reference: unknown,
    nullValue: unknown,
    representativeIndex?: number,
    view?: EvidenceViewCase['view'],
  ) => void,
): void {
  for (const field of [
    'measuredBandwidthHz',
    'result',
    'topLeaf',
    'topLeafPosterior',
    'supportRank',
  ] as const) {
    if (!equivalentValue(referenceCase[field], nullCase[field])) {
      add(nuisanceCell, `evidence.${field}`, referenceCase[field], nullCase[field], representativeIndex, view);
    }
  }
  compareNumericRecords(referenceCase.posterior, nullCase.posterior, 'evidence.posterior', nuisanceCell, representativeIndex,
    (cell, field, reference, nullValue, index) => add(cell, field, reference, nullValue, index, view));
}

function compareNumericRecords(
  reference: Readonly<Record<string, number>>,
  nullValue: Readonly<Record<string, number>>,
  prefix: string,
  nuisanceCell: string,
  representativeIndex: number,
  add: (nuisanceCell: string, field: string, reference: unknown, nullValue: unknown, representativeIndex?: number) => void,
): void {
  const keys = [...new Set([...Object.keys(reference), ...Object.keys(nullValue)])].sort();
  for (const key of keys) {
    if (!(key in reference) || !(key in nullValue) || !equivalentValue(reference[key], nullValue[key])) {
      add(nuisanceCell, `${prefix}.${key}`, reference[key], nullValue[key], representativeIndex);
    }
  }
}

function equivalentValue(reference: unknown, nullValue: unknown): boolean {
  if (typeof reference === 'number' && typeof nullValue === 'number') {
    if (Object.is(reference, nullValue)) return true;
    if (!Number.isFinite(reference) || !Number.isFinite(nullValue)) return false;
    return Math.abs(reference - nullValue) <= EXACT_EQUIVALENCE_NUMERICAL_TOLERANCE
      * Math.max(1, Math.abs(reference), Math.abs(nullValue));
  }
  return Object.is(reference, nullValue);
}

function compareValidationCasesForPairing(left: ValidationCase, right: ValidationCase): number {
  return left.firstReadyOpportunity - right.firstReadyOpportunity
    || left.associationMode.localeCompare(right.associationMode)
    || left.bandwidthHz - right.bandwidthHz
    || left.representativeKey.localeCompare(right.representativeKey);
}

function compareEvidenceViewCasesForPairing(left: EvidenceViewCase, right: EvidenceViewCase): number {
  return left.measuredBandwidthHz - right.measuredBandwidthHz
    || left.representativeKey.localeCompare(right.representativeKey);
}

function assertCanonicalCorpusSourceArtifactPaths(paths: readonly string[]): void {
  if (new Set(paths).size !== paths.length) throw new Error('SignalLab corpus source manifest contains duplicate artifact paths');
  for (const path of paths) assertRepositoryRelativePath(path, 'SignalLab corpus source artifact');
  const canonical = [...paths].sort((left, right) => left.localeCompare(right));
  if (paths.some((path, index) => path !== canonical[index])) throw new Error('SignalLab corpus source manifest paths must be in canonical lexical order');
}

function assertRepositoryRelativePath(path: string, label: string): void {
  if (!path || path.includes('\\') || posix.isAbsolute(path) || posix.normalize(path) !== path
    || path === '..' || path.startsWith('../') || path.includes('/../')) {
    throw new Error(`${label} ${JSON.stringify(path)} must be a canonical repository-relative POSIX path`);
  }
}

function corpusSourceArtifact(path: string): { path: string; sha256: string } {
  const file = resolve(SIGNAL_LAB_REPOSITORY_ROOT, path);
  const status = lstatSync(file);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`SignalLab corpus source artifact ${path} must be a regular non-symlink file`);
  gitOutput(['ls-files', '--error-unmatch', '--', path]);
  const bytes = readFileSync(file);
  const committedBytes = gitOutput(['show', `${PINNED_SIGNAL_LAB_COMMIT}:${path}`]);
  if (!bytes.equals(committedBytes)) {
    throw new Error(`SignalLab corpus source artifact ${path} differs from pinned commit ${PINNED_SIGNAL_LAB_COMMIT}`);
  }
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function assertSignalLabRepositoryIsClean(): void {
  const status = gitOutput(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.length !== 0) {
    throw new Error('SignalLab repository must have a clean index and worktree, including no untracked files, before classifier validation');
  }
}

function assertCorpusSourceImportClosure(
  entryPath: string,
  expectedPaths: readonly string[],
  manifestPaths: readonly string[],
): void {
  const discovered = new Set<string>();
  const pending = [entryPath];
  while (pending.length > 0) {
    const path = pending.pop()!;
    assertRepositoryRelativePath(path, 'SignalLab corpus import');
    if (discovered.has(path)) continue;
    discovered.add(path);
    const source = readFileSync(resolve(SIGNAL_LAB_REPOSITORY_ROOT, path), 'utf8');
    for (const specifier of relativeTypeScriptModuleSpecifiers(source)) {
      if (!specifier.endsWith('.js') && !specifier.endsWith('.ts')) {
        throw new Error(`SignalLab corpus import ${JSON.stringify(specifier)} from ${path} must declare a .js or .ts TypeScript module target`);
      }
      const resolvedPath = posix.normalize(posix.join(
        posix.dirname(path),
        specifier.endsWith('.js') ? `${specifier.slice(0, -3)}.ts` : specifier,
      ));
      assertRepositoryRelativePath(resolvedPath, 'Resolved SignalLab corpus import');
      pending.push(resolvedPath);
    }
  }
  const actual = [...discovered].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedPaths)) {
    throw new Error(`SignalLab corpus TypeScript import closure ${JSON.stringify(actual)} does not match validator-owned ${JSON.stringify(expectedPaths)}`);
  }
  const manifest = new Set(manifestPaths);
  const omitted = actual.filter((path) => !manifest.has(path));
  if (omitted.length > 0) throw new Error(`SignalLab corpus source manifest omits import-closure artifacts: ${omitted.join(', ')}`);
}

function relativeTypeScriptModuleSpecifiers(source: string): string[] {
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'\";]*?\s+from\s+)?['\"](\.[^'\"]+)['\"]/g,
    /\bimport\s*\(\s*['\"](\.[^'\"]+)['\"]/g,
    /\brequire\s*\(\s*['\"](\.[^'\"]+)['\"]/g,
  ];
  return [...new Set(patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]!)))].sort();
}

function gitOutput(arguments_: readonly string[]): Buffer {
  return execFileSync('git', arguments_, {
    cwd: SIGNAL_LAB_REPOSITORY_ROOT,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function selectProductionFirstReady(sweeps: readonly Sweep[]): ProductionOnlineSelection {
  const detector = new SignalDetector(PRODUCTION_DETECTION_CONFIG);
  const tracker = new SignalTracker(PRODUCTION_DETECTION_CONFIG);
  const everReadyRepresentativeKeys = new Set<string>();
  const representatives: FirstReadyRepresentative[] = [];
  const onlineReadyRepresentatives: OnlineReadyRepresentative[] = [];
  const everAssociationModes = new Set<string>();
  const regularAssociationIds = new Set<string>();
  const agileAssociationIds = new Set<string>();
  const expiredRegularAssociationIds = new Set<string>();
  let previousRegularAssociationByTrack = new Map<string, string>();
  let finalTracks: readonly DetectedSignal[] = [];
  let maximumActiveAdmissions = 0;
  let maximumLocalTrackAdmissions = 0;
  let firstReadyOpportunity: number | undefined;
  for (const [lookIndex, sweep] of sweeps.entries()) {
    const tracks = tracker.update(sweep, detector.analyze(sweep));
    finalTracks = tracks;
    const activeRepresentatives = classificationRepresentatives(tracks.filter((track) => track.state === 'active'));
    const readyRepresentatives = activeRepresentatives
      .filter((track) => classificationSourceSweepIds(track).length >= CLASSIFICATION_ADMISSIONS)
      // Retained operator-visible associations below their current promotion
      // gate are honest insufficient-evidence results, not observation-domain-eligible
      // rolling classifier windows.
      .filter(observableAssociationEvidenceIsCurrentlyQualified)
      .map((detection) => ({ detection, representativeKey: classificationRepresentativeKey(detection) }))
      .sort((left, right) => left.representativeKey.localeCompare(right.representativeKey));
    if (readyRepresentatives.length > 0 && firstReadyOpportunity === undefined) firstReadyOpportunity = lookIndex + 1;
    for (const { detection, representativeKey } of readyRepresentatives) {
      onlineReadyRepresentatives.push({
        detection: structuredClone(detection),
        representativeKey,
        classificationAdmissions: classificationSourceSweepIds(detection).length,
        localTrackAdmissions: detection.sweepIds.length,
        readyOpportunity: lookIndex + 1,
        evidenceSweeps: sweeps.slice(0, lookIndex + 1),
      });
      if (everReadyRepresentativeKeys.has(representativeKey)) continue;
      everReadyRepresentativeKeys.add(representativeKey);
      representatives.push({
        detection: structuredClone(detection),
        representativeKey,
        classificationAdmissions: classificationSourceSweepIds(detection).length,
        localTrackAdmissions: detection.sweepIds.length,
        firstReadyOpportunity: lookIndex + 1,
        evidenceSweeps: sweeps.slice(0, lookIndex + 1),
      });
    }
    for (const representative of activeRepresentatives) {
      const associationMode = representative.associationMode ?? 'frequency-local';
      everAssociationModes.add(associationMode);
      maximumActiveAdmissions = Math.max(maximumActiveAdmissions, classificationSourceSweepIds(representative).length);
      maximumLocalTrackAdmissions = Math.max(maximumLocalTrackAdmissions, representative.sweepIds.length);
      if (associationMode === 'regular-spectral-component-activity' && representative.associationId) regularAssociationIds.add(representative.associationId);
      if (associationMode === 'frequency-agile-2g4-activity' && representative.associationId) agileAssociationIds.add(representative.associationId);
    }
    const currentRegularAssociationByTrack = new Map(tracks.flatMap((track) =>
      track.associationMode === 'regular-spectral-component-activity' && track.associationId
        ? [[track.id, track.associationId] as const]
        : []));
    for (const [trackId, associationId] of previousRegularAssociationByTrack) {
      if (currentRegularAssociationByTrack.get(trackId) !== associationId) expiredRegularAssociationIds.add(associationId);
    }
    previousRegularAssociationByTrack = currentRegularAssociationByTrack;
  }
  const finalActiveRepresentatives = classificationRepresentatives(finalTracks.filter((track) => track.state === 'active'));
  const finalReadyRepresentatives = finalActiveRepresentatives
    .filter((track) => classificationSourceSweepIds(track).length >= CLASSIFICATION_ADMISSIONS);
  return {
    representatives: representatives.sort((left, right) => left.firstReadyOpportunity - right.firstReadyOpportunity
      || left.representativeKey.localeCompare(right.representativeKey)),
    onlineReadyRepresentatives: onlineReadyRepresentatives.sort((left, right) => left.readyOpportunity - right.readyOpportunity
      || left.representativeKey.localeCompare(right.representativeKey)),
    everReadyRepresentativeKeys: [...everReadyRepresentativeKeys].sort(),
    finalReadyRepresentativeCount: finalReadyRepresentatives.length,
    finalActiveRepresentativeCount: finalActiveRepresentatives.length,
    maximumActiveAdmissions,
    maximumLocalTrackAdmissions,
    ...(firstReadyOpportunity === undefined ? {} : { firstReadyOpportunity }),
    everAssociationModes: [...everAssociationModes].sort(),
    finalAssociationModes: [...new Set(finalReadyRepresentatives.map((detection) => detection.associationMode ?? 'frequency-local'))].sort(),
    regularAssociationIds: [...regularAssociationIds].sort(),
    agileAssociationIds: [...agileAssociationIds].sort(),
    regularAssociationExpirations: expiredRegularAssociationIds.size,
  };
}

function observationOpportunityHorizon(scenario: CanonicalClassificationScenario): number {
  const startHz = scenario.centerHz - scenario.recommendedSpanHz / 2;
  const stopHz = scenario.centerHz + scenario.recommendedSpanHz / 2;
  return startHz <= FULL_BAND_2G4_START_HZ && stopHz >= FULL_BAND_2G4_STOP_HZ
    ? FULL_BAND_2G4_OBSERVATION_OPPORTUNITIES
    : STANDARD_OBSERVATION_OPPORTUNITIES;
}

function validationAttemptId(scenarioId: string, snrDb: number, rbwDivisor: number, seed: number): string {
  return `${scenarioId}:snr=${snrDb}:rbw=${rbwDivisor}:seed=${seed}`;
}

function classificationRepresentativeKey(track: DetectedSignal): string {
  const associationMode = track.associationMode ?? 'frequency-local';
  return `${associationMode}:${associationMode === 'frequency-local' ? track.id : track.associationId ?? track.id}`;
}

function classificationSourceSweepIds(track: DetectedSignal): readonly string[] {
  return track.associationMode !== undefined && track.associationMode !== 'frequency-local'
    ? track.associationRegionSweepIds ?? []
    : track.sweepIds;
}

function assertDetectedPowerSynthesisProvenance(
  observation: ReturnType<typeof synthesizeCanonicalObservation>,
  expectedFilterWidthHz: number,
  context: string,
): void {
  if (observation.detectedPowerActualRbwHz !== null
    || observation.detectedPowerSynthesisFilterWidthHz !== expectedFilterWidthHz) {
    throw new Error(`${context} does not preserve unavailable measured RBW and the explicit synthesis-filter width`);
  }
}

function asSweep(scenario: CanonicalClassificationScenario, observation: ReturnType<typeof synthesizeCanonicalObservation>): Sweep {
  const startHz = observation.frequencyHz[0]!;
  const stopHz = observation.frequencyHz.at(-1)!;
  return {
    kind: 'spectrum', id: `${scenario.id}-${observation.seed}-${observation.lookIndex}`, sequence: observation.lookIndex + 1,
    capturedAt: new Date(Date.UTC(2026, 0, 1) + observation.lookIndex * observation.sweepTimeSeconds * 1_000).toISOString(), elapsedMilliseconds: observation.sweepTimeSeconds * 1_000,
    frequencyHz: observation.frequencyHz, powerDbm: observation.powerDbm,
    requested: {
      kind: 'swept-spectrum', startHz, stopHz, points: observation.frequencyHz.length,
      sweepTimeSeconds: observation.sweepTimeSeconds,
      controls: {
        schemaVersion: 1, model: 'receiver', acquisitionFormat: 'text',
        resolutionBandwidthKhz: observation.actualRbwHz / 1_000, attenuationDb: 'auto',
        detector: 'sample', spurRejection: 'off', lowNoiseAmplifier: 'off', avoidSpurs: 'off',
        trigger: { mode: 'auto' },
      },
    },
    // This offline corpus is a protocol-test double for RBW-filtered receiver
    // observations, not a SignalLab bridge measurement. The separate live
    // bridge gate exercises synthetic-grid-equivalent session provenance.
    actualStartHz: startHz, actualStopHz: stopHz, actualRbwHz: observation.actualRbwHz, actualAttenuationDb: 0,
    source: 'scan-text', complete: true, identity,
  };
}

function asZeroSpan(observation: ReturnType<typeof synthesizeCanonicalObservation>, detection: DetectedSignal): ZeroSpanCapture {
  const projectedTuneHz = projectDetectedPowerTuneHz(
    observation.zeroSpanFrequencyHz,
    SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1,
  );
  if (projectedTuneHz !== observation.zeroSpanFrequencyHz) {
    throw new Error(`SignalLab zero-span synthesis used unprojected ${observation.zeroSpanFrequencyHz} Hz instead of admitted ${projectedTuneHz} Hz`);
  }
  const sweepTimeSeconds = observation.zeroSpanPowerDbm.length * observation.zeroSpanSamplePeriodSeconds;
  const requested = detectedPowerTimeseriesConfigurationSchema.parse({
    kind: 'detected-power-timeseries', centerHz: observation.zeroSpanFrequencyHz,
    sampleCount: observation.zeroSpanPowerDbm.length, sweepTimeSeconds,
    controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' },
  });
  return {
    kind: 'zero-span', id: `zero-${observation.scenarioId}-${observation.seed}-${observation.lookIndex}`, sequence: 1,
    capturedAt: new Date(Date.UTC(2026, 0, 1) + observation.lookIndex * observation.sweepTimeSeconds * 1_000).toISOString(), elapsedMilliseconds: sweepTimeSeconds * 1_000,
    frequencyHz: observation.zeroSpanFrequencyHz, samplePeriodSeconds: observation.zeroSpanSamplePeriodSeconds, timingQualification: 'simulation-exact',
    targetDetectionId: detection.id,
    powerDbm: observation.zeroSpanPowerDbm,
    requested,
    actualRbwHz: null, actualAttenuationDb: null,
    resolutionBandwidthQualification: 'unavailable', attenuationQualification: 'not-applicable',
    source: 'signal-lab-synthetic', complete: true, identity,
  };
}

function auditPriorSensitivity(validationCases: readonly ValidationCase[]) {
  const variants = [
    {
      id: 'engineering-baseline-v1',
      kind: 'declared-engineering-assumption',
      description: 'Pinned design weights; not an estimate of field prevalence.',
      prior: { ...PINNED_ENGINEERING_PRIOR },
    },
    {
      id: 'unknown-mass-0.10-known-ratios-preserved-v1',
      kind: 'unknown-mass-shift',
      description: 'Unknown mass reduced to 0.10 while preserving every known-class prior ratio.',
      prior: priorWithUnknownMass(0.10),
    },
    {
      id: 'unknown-mass-0.30-known-ratios-preserved-v1',
      kind: 'unknown-mass-shift',
      description: 'Unknown mass increased to 0.30 while preserving every known-class prior ratio.',
      prior: priorWithUnknownMass(0.30),
    },
    {
      id: 'cellular-family-up-within-family-ratios-preserved-v1',
      kind: 'family-mass-shift',
      description: 'Cellular family mass is weighted 1.35x and other known families 0.90x; unknown mass and every within-family ratio are preserved.',
      prior: priorWithKnownFamilyMultipliers({ analog: 0.90, cellular: 1.35, wifi: 0.90, bluetooth: 0.90 }),
    },
    {
      id: 'unlicensed-families-up-within-family-ratios-preserved-v1',
      kind: 'family-mass-shift',
      description: 'Wi-Fi/Bluetooth family masses are weighted 1.25x and analog/cellular 0.90x; unknown mass and every within-family ratio are preserved.',
      prior: priorWithKnownFamilyMultipliers({ analog: 0.90, cellular: 0.90, wifi: 1.25, bluetooth: 1.25 }),
    },
  ] as const;
  const modelPriorMatchesPinned = OBSERVABLE_LEAF_CLASSES.every((id) => {
    const model = BAYESIAN_OBSERVABLE_MODEL.classModels.find((candidate) => candidate.id === id);
    return model !== undefined && Math.abs(Math.exp(model.logPrior) - PINNED_ENGINEERING_PRIOR[id]) <= 1e-12;
  });
  const evaluated = variants.map((variant) => {
    const priorTotal = OBSERVABLE_LEAF_CLASSES.reduce((sum, id) => sum + variant.prior[id], 0);
    const decisions = validationCases.map((item) => {
      const observation: ObservableFeatureObservation = {
        values: item.features,
        limitations: item.limitations as ObservableFeatureObservation['limitations'],
        ...(item.associationEvidenceQualification === undefined
          ? {}
          : { associationEvidenceQualification: item.associationEvidenceQualification }),
        occupiedStartHz: item.occupiedStartHz,
        occupiedStopHz: item.occupiedStopHz,
        centerHz: item.centerHz,
        bandwidthHz: item.bandwidthHz,
        binWidthHz: item.binWidthHz,
        sweepIds: Array.from({ length: CLASSIFICATION_ADMISSIONS }, (_unused, index) => `prior-audit-${index}`),
        views: item.features['envelope.logTransitionRateHz'] === undefined
          ? Object.keys(item.features).some((name) => name.startsWith('envelope.'))
            ? ['scalar-spectrum', 'detected-power-envelope']
            : ['scalar-spectrum']
          : ['scalar-spectrum', 'detected-power-envelope'],
      };
      const posterior = posteriorUnderDeclaredPrior(observation, variant.prior);
      const selected = item.limitations.includes('partial-span-boundary-censoring')
        ? { label: 'unknown' as const }
        : selectObservableDecision(posterior, observation, item.knownSupportRank);
      const result = selected.label === 'unknown' ? 'unknown' : `observable:${selected.label}`;
      const acceptedHierarchy = acceptsAnyTruth(
        result,
        item.allowedModelTruths,
        item.nominalBandwidthHz,
        item.bandwidthHz,
      );
      return { item, result, acceptedHierarchy };
    });
    const knownDecisions = decisions.filter(({ item }) => item.modelTruth !== 'unknown-signal');
    const unknownDecisions = decisions.filter(({ item }) => item.modelTruth === 'unknown-signal');
    const incompatibleNonUnknown = decisions.filter(({ result, acceptedHierarchy }) => result !== 'unknown' && !acceptedHierarchy);
    const falseAcceptedUnknown = unknownDecisions.filter(({ result, acceptedHierarchy }) => result !== 'unknown' && !acceptedHierarchy);
    const decisionChanges = decisions.filter(({ item, result }) => result !== item.result);
    const knownCoverage = fraction(knownDecisions, ({ result }) => result !== 'unknown');
    const hierarchicalAccuracy = fraction(decisions, ({ acceptedHierarchy }) => acceptedHierarchy);
    const incompatibleNonUnknownRisk = incompatibleNonUnknown.length / Math.max(1, decisions.length);
    const falseAcceptedUnknownRisk = falseAcceptedUnknown.length / Math.max(1, unknownDecisions.length);
    const decisionChangeRate = decisionChanges.length / Math.max(1, decisions.length);
    const passed = Math.abs(priorTotal - 1) <= 1e-12
      && knownCoverage >= PRIOR_SENSITIVITY_GATES.minimumKnownCoverage
      && hierarchicalAccuracy >= PRIOR_SENSITIVITY_GATES.minimumHierarchicalAccuracy
      && incompatibleNonUnknownRisk <= PRIOR_SENSITIVITY_GATES.maximumIncompatibleNonUnknownRisk
      && falseAcceptedUnknownRisk <= PRIOR_SENSITIVITY_GATES.maximumFalseAcceptedUnknownRisk
      && decisionChangeRate <= PRIOR_SENSITIVITY_GATES.maximumDecisionChangeRate;
    return {
      id: variant.id,
      kind: variant.kind,
      description: variant.description,
      prior: variant.prior,
      priorTotal,
      cases: decisions.length,
      knownCases: knownDecisions.length,
      unknownCases: unknownDecisions.length,
      knownCoverage,
      hierarchicalAccuracy,
      incompatibleNonUnknownCount: incompatibleNonUnknown.length,
      incompatibleNonUnknownRisk,
      falseAcceptedUnknownCount: falseAcceptedUnknown.length,
      falseAcceptedUnknownRisk,
      decisionChangeCount: decisionChanges.length,
      decisionChangeRate,
      passed,
    };
  });
  const baselineDecisionMismatchCount = evaluated[0]?.decisionChangeCount ?? Number.MAX_SAFE_INTEGER;
  return {
    valid: modelPriorMatchesPinned
      && baselineDecisionMismatchCount === 0
      && evaluated.every((variant) => variant.passed),
    qualification: 'deterministic-synthetic-engineering-prior-sensitivity-not-field-prevalence-calibration',
    fieldPrevalenceCalibrated: false,
    fieldValidationLimitation: 'Operational class prevalence and prior calibration remain unmeasured release limitations requiring representative physical survey data.',
    gates: PRIOR_SENSITIVITY_GATES,
    modelPriorMatchesPinned,
    baselineDecisionMismatchCount,
    variants: evaluated,
  };
}

function posteriorUnderDeclaredPrior(
  observation: ObservableFeatureObservation,
  prior: Readonly<Record<ObservableLeafClass, number>>,
): readonly PosteriorCandidate[] {
  const values = BAYESIAN_OBSERVABLE_MODEL.classModels.map((model) => {
    const logLikelihood = mixtureLogLikelihood(observation.values, model.components);
    const logJoint = observableRepresentativeIsInClassDomain(model.id, observation)
      ? Math.log(prior[model.id]) + logLikelihood
      : Number.NEGATIVE_INFINITY;
    return { id: model.id, logLikelihood, logJoint };
  });
  const normalization = logSumExp(values.map((value) => value.logJoint));
  return values.map((value) => ({ ...value, probability: Math.exp(value.logJoint - normalization) }))
    .sort((left, right) => right.probability - left.probability);
}

function priorWithUnknownMass(unknownMass: number): Record<ObservableLeafClass, number> {
  const knownBaselineMass = 1 - PINNED_ENGINEERING_PRIOR['unknown-signal'];
  return Object.fromEntries(OBSERVABLE_LEAF_CLASSES.map((id) => [
    id,
    id === 'unknown-signal'
      ? unknownMass
      : PINNED_ENGINEERING_PRIOR[id] * (1 - unknownMass) / knownBaselineMass,
  ])) as Record<ObservableLeafClass, number>;
}

function priorWithKnownFamilyMultipliers(
  multipliers: Readonly<Record<'analog' | 'cellular' | 'wifi' | 'bluetooth', number>>,
): Record<ObservableLeafClass, number> {
  const unknownMass = PINNED_ENGINEERING_PRIOR['unknown-signal'];
  const weightedKnownTotal = OBSERVABLE_LEAF_CLASSES
    .filter((id) => id !== 'unknown-signal')
    .reduce((sum, id) => sum + PINNED_ENGINEERING_PRIOR[id] * multipliers[priorFamily(id)], 0);
  return Object.fromEntries(OBSERVABLE_LEAF_CLASSES.map((id) => [
    id,
    id === 'unknown-signal'
      ? unknownMass
      : PINNED_ENGINEERING_PRIOR[id] * multipliers[priorFamily(id)] * (1 - unknownMass) / weightedKnownTotal,
  ])) as Record<ObservableLeafClass, number>;
}

function priorFamily(id: Exclude<ObservableLeafClass, 'unknown-signal'>): 'analog' | 'cellular' | 'wifi' | 'bluetooth' {
  if (id === 'cw-like' || id === 'am-dsb-full-carrier-like' || id === 'fm-angle-modulated-like') return 'analog';
  if (id === 'wifi-hr-dsss-like' || id === 'wifi-ofdm-like') return 'wifi';
  if (id === 'bluetooth-like') return 'bluetooth';
  return 'cellular';
}

function pinnedCalibrationActualRbwHz(
  scenario: CanonicalClassificationScenario,
  acquisitionRegime: PinnedCalibrationAcquisitionRegime,
): number {
  const inclusiveGridSpacingHz = scenario.recommendedSpanHz / (SWEEP_POINTS - 1);
  return acquisitionRegime.rbwDivisor === null
    ? inclusiveGridSpacingHz
    : Math.max(inclusiveGridSpacingHz * 0.8, scenario.occupiedBandwidthHz / acquisitionRegime.rbwDivisor, 1_000);
}

function pinnedCalibrationDetectedPowerSynthesisFilterWidthHz(
  actualRbwHz: number,
  acquisitionRegime: PinnedCalibrationAcquisitionRegime,
): number {
  return acquisitionRegime.rbwDivisor === null
    ? PINNED_DETECTED_POWER_SYNTHESIS_FILTER_POLICY.signalLabProductionSynthesisFilterWidthHz
    : actualRbwHz;
}

function pinnedSourceLookIndex(
  temporalSchedule: PinnedTemporalSchedule,
  zeroBasedSpectrumOpportunity: number,
): number {
  const skipped = temporalSchedule.skipAfterSpectrumOpportunities !== null
    && zeroBasedSpectrumOpportunity >= temporalSchedule.skipAfterSpectrumOpportunities
    ? temporalSchedule.skippedSourceOpportunities
    : 0;
  return temporalSchedule.sourceLookIndexOffset + zeroBasedSpectrumOpportunity + skipped;
}

function pinnedInterleavedCaptureLookIndex(
  temporalSchedule: PinnedTemporalSchedule,
  zeroBasedSpectrumOpportunity: number,
): number {
  return pinnedSourceLookIndex(temporalSchedule, zeroBasedSpectrumOpportunity) + 1;
}

function recomputeTailCalibrationAudit(
  assignments: readonly { scenarioId: string; classId: ObservableLeafClass }[],
): RecomputedTailCalibrationAudit {
  const views = ['spectrum-only', 'envelope-untimed', 'envelope-timed'] as const;
  const scoresByClass = new Map<ObservableLeafClass, Record<TailCalibrationView, number[]>>();
  const recomputedAttemptCountsByScenario: Record<string, number> = {};
  let lateMinimumCount = 0;
  let allOnlineAttemptCount = 0;
  for (const assignment of assignments) {
    if (assignment.classId === 'unknown-signal') continue;
    const scenario = canonicalClassificationScenarios.find((candidate) => candidate.id === assignment.scenarioId);
    const model = BAYESIAN_OBSERVABLE_MODEL.classModels.find((candidate) => candidate.id === assignment.classId);
    if (!scenario || !model) throw new Error(`Independent tail audit cannot resolve ${assignment.scenarioId}/${assignment.classId}`);
    const classScores = scoresByClass.get(assignment.classId) ?? {
      'spectrum-only': [],
      'envelope-untimed': [],
      'envelope-timed': [],
    };
    scoresByClass.set(assignment.classId, classScores);
    let scenarioAttemptCount = 0;
    for (const snrDb of PINNED_TAIL_CALIBRATION_SNR_DB) {
      for (const acquisitionRegime of PINNED_TAIL_CALIBRATION_ACQUISITION_REGIMES) {
        for (const seed of PINNED_TAIL_CALIBRATION_SEEDS) {
          const actualRbwHz = pinnedCalibrationActualRbwHz(scenario, acquisitionRegime);
          const detectedPowerSynthesisFilterWidthHz =
            pinnedCalibrationDetectedPowerSynthesisFilterWidthHz(actualRbwHz, acquisitionRegime);
          const observations = Array.from(
            { length: observationOpportunityHorizon(scenario) },
            (_, spectrumOpportunity) => synthesizeCanonicalObservation(scenario.id, {
              lookIndex: pinnedSourceLookIndex(acquisitionRegime.temporalSchedule, spectrumOpportunity),
              seed,
              snrDb,
              actualRbwHz,
              detectedPowerSynthesisFilterWidthHz,
              points: SWEEP_POINTS,
              sweepTimeSeconds: SWEEP_TIME_SECONDS,
              zeroSpanPoints: ZERO_SPAN_POINTS,
              zeroSpanSamplePeriodSeconds: ZERO_SPAN_SAMPLE_PERIOD_SECONDS,
            }),
          );
          for (const observation of observations) {
            assertDetectedPowerSynthesisProvenance(
              observation,
              detectedPowerSynthesisFilterWidthHz,
              `${assignment.scenarioId} tail-calibration swept observation`,
            );
          }
          const sweeps = observations.map((observation) => asSweep(scenario, observation));
          const selection = selectProductionFirstReady(sweeps);
          const representativeScores: Record<TailCalibrationView, Array<{
            opportunity: number;
            representativeKey: string;
            support: number;
          }>> = {
            'spectrum-only': [],
            'envelope-untimed': [],
            'envelope-timed': [],
          };
          for (const representative of selection.onlineReadyRepresentatives) {
            const zeroSpanTuneHz = projectDetectedPowerTuneHz(
              representative.detection.peakHz,
              SIGNAL_LAB_SCALAR_FREQUENCY_RANGE_V1,
            );
            const zeroSpanObservation = synthesizeCanonicalObservation(scenario.id, {
              lookIndex: pinnedInterleavedCaptureLookIndex(
                acquisitionRegime.temporalSchedule,
                representative.readyOpportunity - 1,
              ),
              seed,
              snrDb,
              actualRbwHz,
              detectedPowerSynthesisFilterWidthHz,
              points: SWEEP_POINTS,
              sweepTimeSeconds: SWEEP_TIME_SECONDS,
              zeroSpanPoints: ZERO_SPAN_POINTS,
              zeroSpanSamplePeriodSeconds: ZERO_SPAN_SAMPLE_PERIOD_SECONDS,
              zeroSpanFrequencyHz: zeroSpanTuneHz,
            });
            assertDetectedPowerSynthesisProvenance(
              zeroSpanObservation,
              detectedPowerSynthesisFilterWidthHz,
              `${assignment.scenarioId} tail-calibration detected-power observation`,
            );
            const observation = extractObservableFeatures(representative.detection, {
              sweeps: representative.evidenceSweeps,
              zeroSpan: asZeroSpan(zeroSpanObservation, representative.detection),
            });
            if (!observableRepresentativeIsInClassDomain(assignment.classId, observation)) continue;
            const valuesByView: Record<TailCalibrationView, Readonly<Record<string, number>>> = {
              'spectrum-only': spectrumOnly(observation.values),
              'envelope-untimed': envelopeUntimed(observation.values),
              'envelope-timed': observation.values,
            };
            for (const view of views) {
              representativeScores[view].push({
                opportunity: representative.readyOpportunity,
                representativeKey: representative.representativeKey,
                support: Math.max(...model.components.map((component) =>
                  studentTModelTailProbability(valuesByView[view], component))),
              });
            }
          }
          if (representativeScores['envelope-timed'].length === 0) continue;
          scenarioAttemptCount++;
          allOnlineAttemptCount++;
          for (const view of views) {
            const minimum = aggregateAttemptMinimum(representativeScores[view]);
            classScores[view].push(minimum.minimumSupport);
            if (minimum.minimumOpportunity > minimum.firstOpportunity
              && minimum.minimumSupport < minimum.firstSupport - Number.EPSILON) lateMinimumCount++;
          }
        }
      }
    }
    recomputedAttemptCountsByScenario[scenario.id] = scenarioAttemptCount;
  }

  const scoreComparisons = BAYESIAN_OBSERVABLE_MODEL.classModels
    .filter((model) => model.id !== 'unknown-signal')
    .flatMap((model) => views.map((view) => {
      const expected = [...(model.tailCalibrationScoresByView?.[view] ?? [])];
      const observed = [...(scoresByClass.get(model.id)?.[view] ?? [])].sort((left, right) => left - right);
      const maximumAbsoluteDifference = expected.length === observed.length
        ? Math.max(0, ...expected.map((value, index) => Math.abs(value - observed[index]!)))
        : Number.MAX_VALUE;
      return {
        classId: model.id,
        view,
        expectedCount: expected.length,
        observedCount: observed.length,
        maximumAbsoluteDifference,
        expectedSha256: sha256Canonical(expected),
        observedSha256: sha256Canonical(observed),
      };
    }));
  const modelAttemptCounts = BAYESIAN_OBSERVABLE_MODEL.trainingMatrix.tailCalibrationAttemptCountsByScenario ?? {};
  const attemptCountMismatches = [...new Set([
    ...Object.keys(modelAttemptCounts),
    ...Object.keys(recomputedAttemptCountsByScenario),
  ])].sort().flatMap((scenarioId) => {
    const expected = modelAttemptCounts[scenarioId] ?? 0;
    const observed = recomputedAttemptCountsByScenario[scenarioId] ?? 0;
    return expected === observed ? [] : [{ scenarioId, expected, observed }];
  });
  const aggregationRegressionResult = aggregateAttemptMinimum([
    { opportunity: 8, representativeKey: 'first-ready', support: 0.8 },
    { opportunity: 9, representativeKey: 'later-online', support: 0.2 },
  ]);
  const aggregationRegression = {
    firstOpportunity: aggregationRegressionResult.firstOpportunity,
    minimumOpportunity: aggregationRegressionResult.minimumOpportunity,
    minimumSupport: aggregationRegressionResult.minimumSupport,
    passed: aggregationRegressionResult.firstOpportunity === 8
      && aggregationRegressionResult.minimumOpportunity === 9
      && aggregationRegressionResult.minimumSupport === 0.2,
  };
  const valid = attemptCountMismatches.length === 0
    && scoreComparisons.every((comparison) => comparison.expectedCount === comparison.observedCount
      && comparison.maximumAbsoluteDifference <= TAIL_CALIBRATION_NUMERICAL_TOLERANCE)
    && lateMinimumCount > 0
    && aggregationRegression.passed;
  return {
    valid,
    scoreTolerance: TAIL_CALIBRATION_NUMERICAL_TOLERANCE,
    recomputedAttemptCountsByScenario,
    attemptCountMismatches,
    scoreComparisons,
    lateMinimumCount,
    allOnlineAttemptCount,
    aggregationRegression,
  };
}

function aggregateAttemptMinimum(
  values: readonly { opportunity: number; representativeKey: string; support: number }[],
): { firstOpportunity: number; firstSupport: number; minimumOpportunity: number; minimumSupport: number } {
  if (values.length === 0) throw new Error('Tail calibration attempt minimum requires an online-ready representative');
  const ordered = [...values].sort((left, right) => left.opportunity - right.opportunity
    || left.representativeKey.localeCompare(right.representativeKey));
  const first = ordered[0]!;
  const minimum = ordered.reduce((selected, candidate) => candidate.support < selected.support ? candidate : selected, first);
  return {
    firstOpportunity: first.opportunity,
    firstSupport: first.support,
    minimumOpportunity: minimum.opportunity,
    minimumSupport: minimum.support,
  };
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function modelTruth(truth: ObservableSignalClass): ObservableLeafClass {
  if (truth === 'bluetooth-classic-like' || truth === 'bluetooth-le-like') return 'bluetooth-like';
  if (OBSERVABLE_LEAF_CLASSES.includes(truth as ObservableLeafClass)) return truth as ObservableLeafClass;
  throw new Error(`Corpus truth ${truth} has no v4 observable-model mapping`);
}

function acceptsTruth(
  result: string,
  truth: ObservableLeafClass,
  nominalBandwidthHz: number,
  measuredBandwidthHz: number,
): boolean {
  if (truth === 'unknown-signal') return result === 'unknown';
  if (result === `observable:${truth}`) return true;
  if ((truth === 'lte-fdd-like' || truth === 'lte-tdd-like') && result === 'observable:lte-like') return true;
  if ((truth === 'nr-fdd-like' || truth === 'nr-tdd-like') && result === 'observable:nr-like') return true;
  if ((truth === 'lte-fdd-like' || truth === 'lte-tdd-like' || truth === 'nr-fdd-like' || truth === 'nr-tdd-like')
    && result === 'observable:cellular-ofdm-ambiguous') {
    return nominalBandwidthHz <= 25_000_000 && measuredBandwidthHz <= 25_000_000;
  }
  if ((truth === 'wifi-hr-dsss-like' || truth === 'wifi-ofdm-like') && result === 'observable:wifi-like') return true;
  return false;
}

function acceptsAnyTruth(
  result: string,
  allowedTruths: readonly ObservableLeafClass[],
  nominalBandwidthHz: number,
  measuredBandwidthHz: number,
): boolean {
  return allowedTruths.some((truth) => acceptsTruth(result, truth, nominalBandwidthHz, measuredBandwidthHz));
}

function admissionSummary(values: readonly AdmissionAttempt[]) {
  const everReady = values.filter((item) => item.everReady);
  const admitted = values.filter((item) => item.admitted);
  return {
    attempted: values.length,
    everReady: everReady.length,
    everReadyRate: fraction(values, (item) => item.everReady),
    firstReady: admitted.length,
    firstReadyRate: fraction(values, (item) => item.admitted),
    admitted: admitted.length,
    misses: values.length - admitted.length,
    admissionRate: fraction(values, (item) => item.admitted),
    observationHorizons: counts(values.map((item) => String(item.observationHorizon))),
    everReadyRepresentativeCount: numericSummary(values.map((item) => item.everReadyRepresentativeCount)),
    finalReadyRepresentativeCount: numericSummary(values.map((item) => item.finalReadyRepresentativeCount)),
    finalActiveRepresentativeCount: numericSummary(values.map((item) => item.finalActiveRepresentativeCount)),
    selectedTrackAdmissions: numericSummary(admitted.map((item) => item.selectedTrackAdmissions)),
    maximumActiveAdmissions: numericSummary(values.map((item) => item.maximumActiveAdmissions)),
    maximumLocalTrackAdmissions: numericSummary(values.map((item) => item.maximumLocalTrackAdmissions)),
    firstReadyOpportunity: numericSummary(values.flatMap((item) => item.firstReadyOpportunity === undefined ? [] : [item.firstReadyOpportunity])),
    everAssociationModes: counts(values.flatMap((item) => item.everAssociationModes)),
    finalAssociationModes: counts(values.flatMap((item) => item.finalAssociationModes)),
    regularAssociationsObserved: values.reduce((sum, item) => sum + item.regularAssociationsObserved, 0),
    agileAssociationsObserved: values.reduce((sum, item) => sum + item.agileAssociationsObserved, 0),
    regularAssociationExpirations: values.reduce((sum, item) => sum + item.regularAssociationExpirations, 0),
  };
}

function expectedCalibrationError(values: readonly { confidence: number; correct: boolean }[], bins: number): number {
  if (!values.length) return Number.NaN;
  let result = 0;
  for (let bin = 0; bin < bins; bin++) {
    const lower = bin / bins;
    const upper = (bin + 1) / bins;
    const selected = values.filter((item) => item.confidence >= lower && (bin === bins - 1 ? item.confidence <= upper : item.confidence < upper));
    if (!selected.length) continue;
    result += selected.length / values.length * Math.abs(mean(selected.map((item) => item.confidence)) - fraction(selected, (item) => item.correct));
  }
  return result;
}

function auroc(values: readonly { score: number; positive: boolean }[]): number {
  const positive = values.filter((item) => item.positive);
  const negative = values.filter((item) => !item.positive);
  if (!positive.length || !negative.length) return Number.NaN;
  let wins = 0;
  for (const left of positive) for (const right of negative) wins += left.score > right.score ? 1 : left.score === right.score ? 0.5 : 0;
  return wins / (positive.length * negative.length);
}

function counts(values: readonly string[]): Record<string, number> { return values.reduce<Record<string, number>>((result, value) => ({ ...result, [value]: (result[value] ?? 0) + 1 }), {}); }
function duplicateStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();
}
function setDifference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((value) => !rightSet.has(value)))].sort();
}
function numericIntersection(left: readonly number[], right: readonly number[]): number[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((value) => rightSet.has(value)))].sort((a, b) => a - b);
}
function numericSummary(values: readonly number[]): { minimum: number; median: number; maximum: number } | undefined {
  if (!values.length) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  return { minimum: ordered[0]!, median: ordered[Math.floor(ordered.length / 2)]!, maximum: ordered.at(-1)! };
}
function fraction<T>(values: readonly T[], predicate: (value: T) => boolean): number { return values.length ? values.filter(predicate).length / values.length : 0; }
function mean(values: readonly number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN; }
function spectrumOnly(values: Readonly<Record<string, number>>): Readonly<Record<string, number>> { return Object.fromEntries(Object.entries(values).filter(([name]) => !name.startsWith('envelope.'))); }
function envelopeUntimed(values: Readonly<Record<string, number>>): Readonly<Record<string, number>> { return Object.fromEntries(Object.entries(values).filter(([name]) => !name.startsWith('envelope.periodicEnergy') && name !== 'envelope.logTransitionRateHz')); }
