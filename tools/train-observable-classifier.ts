import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import {
  CLASSIFICATION_CORPUS_VERSION,
  canonicalClassificationScenarios,
  synthesizeCanonicalObservation,
  type CanonicalClassificationScenario,
} from '../../TinySA_SignalLab/src/classification-corpus.js';
import { extractObservableFeatures } from '../packages/analysis/src/observable-features.js';
import { observableRepresentativeIsEligibleForModelFit } from '../packages/analysis/src/observable-hypothesis-domain.js';
import { studentTModelTailProbability } from '../packages/analysis/src/bayesian-predictive.js';
import { classificationRepresentatives, SignalDetector, SignalTracker } from '../packages/analysis/src/index.js';
import { OBSERVABLE_LEAF_CLASSES, type ObservableClassifierModelAsset, type ObservableLeafClass } from '../packages/analysis/src/observable-classifier-model.js';
import type { DetectedSignal, DeviceIdentity, SignalDetectionConfig, Sweep, ZeroSpanCapture } from '../packages/contracts/src/index.js';

const OUTPUT = resolve('packages/analysis/src/models/bayesian-observable-v5.generated.ts');
const MANIFEST_OUTPUT = resolve('packages/analysis/src/models/bayesian-observable-v5.manifest.generated.ts');
const SOURCE_COMMIT = '03197cb5b4a03b85ef5efe6525f4f28ceedcaef3';
const CORPUS_SHA256 = 'd813b3268eee7240a86b2de725ec78080dc0f3ce829fe0c493bf582b62f8529e';
const STRICT_UNKNOWN_HOLDOUT_SCENARIO_IDS = [
  'unknown-chirp',
  'unknown-impulsive',
] as const;
const OBSERVABLE_AMBIGUITY_VALIDATION_ONLY_SCENARIO_IDS = [
  'unknown-regular-cw-comb-4',
  'unknown-regular-cw-comb-5',
  'unknown-irregular-cw-multitone-100-210-370k',
  'unknown-stationary-intermittent-2g4',
  'unknown-simultaneous-1mhz-raster-2g4',
  'unknown-interleaved-four-channel-2g4',
  'unknown-proprietary-off-raster-fhss-2g4',
] as const;
const EXACT_OBSERVABLE_EQUIVALENCE_NULL_SCENARIO_IDS = [
  'unknown-instrument-spur-rbw-line',
  'unknown-independent-am-equivalent-three-tone',
  'unknown-independent-fm-equivalent-bessel-comb',
  'unknown-generic-ofdm-20m',
  'unknown-generic-tdd-ofdm-10m',
  'unknown-generic-ofdm-80m',
  'unknown-proprietary-dsss-22m',
] as const;
const KNOWN_ACQUISITION_VALIDATION_ONLY_SCENARIO_IDS = [
  // A one-timeslot GSM source is deliberately time/frequency-skewed by the
  // 50 ms sample sweep and does not yield eight stable local admissions. The
  // separately canonized loaded BCCH/dummy-burst scenario fits GSM morphology.
  'gsm-900-tdma',
] as const;
// Exact scalar nulls are validation pairs, not a second physical class. Fitting
// their duplicate observations under `unknown-signal` would make the posterior
// odds depend on how many copies of an equivalent formula happen to be in the
// corpus, even though no observed scalar can distinguish the source stories.
const SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS = [
  ...KNOWN_ACQUISITION_VALIDATION_ONLY_SCENARIO_IDS,
  ...STRICT_UNKNOWN_HOLDOUT_SCENARIO_IDS,
  ...OBSERVABLE_AMBIGUITY_VALIDATION_ONLY_SCENARIO_IDS,
  ...EXACT_OBSERVABLE_EQUIVALENCE_NULL_SCENARIO_IDS,
] as const;
const SNR_DB = [6, 10, 16, 24, 32] as const;
const HIGH_SNR_MINIMUM_DB = 24;
// Fit across the complete pinned RBW nuisance support. Using only two interior
// points allowed a component to be estimated from one accidental acquisition
// cell even when the production pipeline was sensitive at other RBWs.
const RBW_DIVISORS = [12, 20, 35, 55, 80, 120] as const;
const SEEDS = [407, 1_407, 2_407, 3_407, 4_407, 5_407] as const;
const TAIL_CALIBRATION_RBW_DIVISORS = RBW_DIVISORS;
const TAIL_CALIBRATION_SEEDS = [6_407, 6_419, 6_421, 6_449, 6_451, 6_469, 6_473, 6_481] as const;
const SYNTHETIC_SUPPORT_REJECTION_ALPHA = 0.025;
// The conformal support p-value is (rank + 1) / (n + 1). At alpha=0.025,
// forty distinct calibration attempts are the minimum for the empirical p
// value to be capable of falling strictly below the rejection threshold.
const MINIMUM_DISTINCT_CALIBRATION_ATTEMPTS = Math.floor(1 / SYNTHETIC_SUPPORT_REJECTION_ALPHA);
const MINIMUM_DISTINCT_FITTING_ATTEMPTS = SEEDS.length;
const MINIMUM_FITTING_SNR_LEVELS = 2;
const MINIMUM_FITTING_RBW_DIVISORS = 2;
// BLE advertising is the sole sparse asynchronous exception: the swept scan
// and packet-event phase can miss one another for an entire finite horizon.
// Its gate still requires at least half of the independent event-phase seeds
// at each high-SNR level. Every other fitted scenario must cover every seed at
// at least one RBW; RBW is operator-selectable, whereas a lucky seed is not.
const HIGH_SNR_MINIMUM_SEED_COVERAGE_BY_SCENARIO: Readonly<Record<string, number>> = {
  'bluetooth-le-advertising': 0.5,
};
const CLASSIFICATION_SWEEPS = 8;
const STANDARD_OBSERVATION_OPPORTUNITIES = 24;
const FULL_BAND_2G4_OBSERVATION_OPPORTUNITIES = 96;
const FULL_BAND_2G4_START_HZ = 2_402_000_000;
const FULL_BAND_2G4_STOP_HZ = 2_480_000_000;
const PRODUCTION_DETECTION_CONFIG: SignalDetectionConfig = {
  threshold: { strategy: 'noise-relative', marginDb: 10 },
  minimumBandwidthHz: 0,
  minimumProminenceDb: 6,
  minimumConsecutiveSweeps: 2,
  releaseAfterMissedSweeps: 2,
};
const SELECTION_POLICY = 'online-first-ready-all-representatives-v3' as const;
const REPRESENTATIVE_WEIGHTING_POLICY = 'equal-weight-per-first-ready-production-representative-v2' as const;
const REPRESENTATIVE_ELIGIBILITY_POLICY = 'runtime-domain-qualified-known-representatives-v3' as const;
// A detector/tracker acquisition attempt is the exchangeable calibration
// unit. Multiple first-ready representatives from one attempt share the same
// synthesized noise/event phase, so flattening them would overstate the
// conformal sample size. For each class and evidence view, retain exactly one
// conservative score: the minimum known-class support among the attempt's
// fit-eligible representatives.
const TAIL_CALIBRATION_SCORE_UNIT = 'one-score-per-fit-eligible-acquisition-attempt-v1' as const;
const TAIL_CALIBRATION_REPRESENTATIVE_AGGREGATION_POLICY = 'minimum-support-across-fit-eligible-first-ready-representatives-v1' as const;

assertUniqueNumbers('fitting seeds', SEEDS);
assertUniqueNumbers('tail-calibration seeds', TAIL_CALIBRATION_SEEDS);
assertDisjointNumbers('fitting seeds', SEEDS, 'tail-calibration seeds', TAIL_CALIBRATION_SEEDS);
assertUniqueNumbers('fitting RBW divisors', RBW_DIVISORS);
assertUniqueNumbers('tail-calibration RBW divisors', TAIL_CALIBRATION_RBW_DIVISORS);
// RBW grids intentionally overlap so calibration covers the entire pinned
// production nuisance support. Independent seeds, not disjoint RBW values,
// isolate calibration from component fitting. Both grids remain serialized in
// trainingMatrix so the independent validator can enforce its own held-out
// RBW partition.

interface RepresentativeSamplingAudit {
  attemptCount: number;
  attemptsWithAnyFirstReadyRepresentative: number;
  attemptsWithFitEligibleRepresentative: number;
  firstReadyRepresentativeCount: number;
  fitEligibleRepresentativeCount: number;
  fitIneligibleRepresentativeCount: number;
  multiRepresentativeAttemptCount: number;
  maximumFirstReadyRepresentativesPerAttempt: number;
  observationHorizonCounts: Record<string, number>;
  firstReadyOpportunityCounts: Record<string, number>;
}

interface FirstReadyFeatureSample {
  values: Readonly<Record<string, number>>;
  representativeKey: string;
  firstReadyOpportunity: number;
  associationMode: NonNullable<DetectedSignal['associationMode']>;
  fitEligible: boolean;
}

interface FeatureSamplingAttempt {
  observationHorizon: number;
  representatives: readonly FirstReadyFeatureSample[];
}

interface ScenarioSamplingAttempt {
  scenarioId: string;
  snrDb: number;
  rbwDivisor: number;
  seed: number;
  representativeCount: number;
  fitEligibleRepresentativeCount: number;
}

const identity: DeviceIdentity = {
  model: 'SignalLab canonical scalar corpus', hardwareVersion: 'offline', firmwareVersion: CLASSIFICATION_CORPUS_VERSION,
  firmwareQualification: 'protocol-test',
  port: { id: 'offline', path: 'offline://classification-corpus', usbMatch: 'protocol-test-double', transport: 'protocol-test-double', execution: 'protocol-test-double' },
  simulated: true, usbIdentityVerified: false, execution: 'protocol-test-double',
};

const checkedOutCorpusSha256 = createHash('sha256').update(readFileSync(resolve('../TinySA_SignalLab/src/classification-corpus.ts'))).digest('hex');
if (checkedOutCorpusSha256 !== CORPUS_SHA256) throw new Error(`SignalLab corpus source hash ${checkedOutCorpusSha256} does not match pinned ${CORPUS_SHA256}`);
const scenarioById = new Map(canonicalClassificationScenarios.map((scenario) => [scenario.id, scenario]));
if (new Set(SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS).size !== SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS.length) {
  throw new Error('Component-fit exclusion policy contains duplicate scenario IDs');
}
for (const scenarioId of EXACT_OBSERVABLE_EQUIVALENCE_NULL_SCENARIO_IDS) {
  const scenario = scenarioById.get(scenarioId);
  if (!scenario) throw new Error(`Exact observable-equivalence null ${scenarioId} is missing from the SignalLab corpus`);
  if (scenario.truthClass !== 'unknown-signal') throw new Error(`Exact observable-equivalence null ${scenarioId} must have unknown-signal corpus truth`);
  if (!scenario.allowedObservableClasses.includes('unknown-signal')
    || !scenario.allowedObservableClasses.some((truth) => truth !== 'unknown-signal')) {
    throw new Error(`Exact observable-equivalence null ${scenarioId} must allow unknown-signal and at least one observationally equivalent known label`);
  }
}
for (const scenarioId of KNOWN_ACQUISITION_VALIDATION_ONLY_SCENARIO_IDS) {
  const scenario = scenarioById.get(scenarioId);
  if (!scenario) throw new Error(`Known acquisition-validation scenario ${scenarioId} is missing from the SignalLab corpus`);
  if (scenario.truthClass === 'unknown-signal') throw new Error(`Known acquisition-validation scenario ${scenarioId} must have known corpus truth`);
  if (!SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS.includes(scenarioId)) {
    throw new Error(`Known acquisition-validation scenario ${scenarioId} must be excluded from component fitting`);
  }
}
for (const scenario of canonicalClassificationScenarios) {
  if (scenario.truthClass !== 'unknown-signal') continue;
  const declaresKnownEquivalent = scenario.allowedObservableClasses.some((truth) => truth !== 'unknown-signal');
  const excluded = SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS.includes(
    scenario.id as typeof SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS[number],
  );
  if (declaresKnownEquivalent && !excluded) {
    throw new Error(`Ambiguous unknown scenario ${scenario.id} must remain validation-only instead of duplicating a known-class likelihood`);
  }
}

const samplesByScenario = new Map<string, Array<Readonly<Record<string, number>>>>();
const detectorConditionedFitMisses: string[] = [];
const fitEligibilityExcludedFitAttempts: string[] = [];
const fittingSampling = emptyRepresentativeSamplingAudit();
const fittingAttempts: ScenarioSamplingAttempt[] = [];
for (const scenario of canonicalClassificationScenarios) {
  if (SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS.includes(scenario.id as typeof SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS[number])) continue;
  const samples: Array<Readonly<Record<string, number>>> = [];
  for (const snrDb of SNR_DB) {
    for (const rbwDivisor of RBW_DIVISORS) {
      for (const seed of SEEDS) {
        try {
          const attempt = featureSamples(scenario, snrDb, rbwDivisor, seed);
          recordRepresentativeSamplingAttempt(fittingSampling, attempt);
          fittingAttempts.push(scenarioSamplingAttempt(scenario.id, snrDb, rbwDivisor, seed, attempt));
          const attemptSamples = attempt.representatives.filter((sample) => sample.fitEligible).map((sample) => sample.values);
          if (attemptSamples.length > 0) samples.push(...attemptSamples);
          else if (attempt.representatives.length === 0) detectorConditionedFitMisses.push(`${scenario.id}:snr=${snrDb}:rbw=${rbwDivisor}:seed=${seed}`);
          else fitEligibilityExcludedFitAttempts.push(`${scenario.id}:snr=${snrDb}:rbw=${rbwDivisor}:seed=${seed}`);
        } catch (error) {
          throw new Error(`Feature extraction failed for ${scenario.id} at SNR ${snrDb} dB, RBW divisor ${rbwDivisor}, seed ${seed}`, { cause: error });
        }
      }
    }
  }
  if (samples.length < 3) throw new Error(`${scenario.id} has only ${samples.length} detector-conditioned first-ready training observations`);
  const scenarioAttempts = fittingAttempts.filter((attempt) => attempt.scenarioId === scenario.id);
  assertCompleteAttemptMatrix('fitting', scenario.id, scenarioAttempts, SNR_DB, RBW_DIVISORS, SEEDS);
  assertFittingCoverage(scenario, scenarioAttempts);
  assertHighSnrSeedCoverage('fitting', scenario, scenarioAttempts, SEEDS);
  samplesByScenario.set(scenario.id, samples);
}

const dimensions = [...new Set([...samplesByScenario.values()].flatMap((samples) => samples.flatMap((sample) => Object.keys(sample))))].sort();
for (const [scenarioId, samples] of samplesByScenario) {
  for (const sample of samples) {
    const missing = dimensions.filter((dimension) => sample[dimension] === undefined);
    if (missing.length) throw new Error(`${scenarioId} training observation is missing ${missing.join(', ')}`);
  }
}

const prior = new Map<ObservableLeafClass, number>([
  ['cw-like', 0.08],
  ['am-dsb-full-carrier-like', 0.08],
  ['fm-angle-modulated-like', 0.08],
  ['gsm-like', 0.04],
  ['lte-fdd-like', 0.06],
  ['lte-tdd-like', 0.06],
  ['nr-fdd-like', 0.06],
  ['nr-tdd-like', 0.06],
  ['wifi-hr-dsss-like', 0.08],
  ['wifi-ofdm-like', 0.08],
  ['bluetooth-like', 0.12],
  ['unknown-signal', 0.20],
]);
const priorTotal = [...prior.values()].reduce((sum, value) => sum + value, 0);
if (Math.abs(priorTotal - 1) > 1e-12) throw new Error(`Observable class prior sums to ${priorTotal}`);

const scenariosByClass = new Map<ObservableLeafClass, CanonicalClassificationScenario[]>();
for (const scenario of canonicalClassificationScenarios) {
  if (SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS.includes(scenario.id as typeof SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS[number])) continue;
  const modelClass = scenario.truthClass === 'bluetooth-classic-like' || scenario.truthClass === 'bluetooth-le-like'
    ? 'bluetooth-like'
    : scenario.truthClass;
  scenariosByClass.set(modelClass, [...(scenariosByClass.get(modelClass) ?? []), scenario]);
}
const fittedClassModels: ObservableClassifierModelAsset['classModels'] = OBSERVABLE_LEAF_CLASSES.map((classId) => {
  const scenarios = scenariosByClass.get(classId);
  const classPrior = prior.get(classId);
  if (!scenarios?.length || classPrior === undefined) throw new Error(`Training data/prior is missing for ${classId}`);
  // Keep Classic and LE as separate likelihood components under the honest
  // mode-ambiguous Bluetooth leaf. Pooling them can hide missing LE support
  // and fit an unphysical centroid between two acquisition regimes.
  const components = scenarios.map((scenario) => fitStudentTComponent(
    scenario.id,
    samplesByScenario.get(scenario.id)!,
    dimensions,
    -Math.log(scenarios.length),
  ));
  return {
    id: classId,
    logPrior: Math.log(classPrior),
    components,
  };
});
const detectorConditionedCalibrationMisses: string[] = [];
const fitEligibilityExcludedCalibrationAttempts: string[] = [];
const calibrationSampling = emptyRepresentativeSamplingAudit();
const calibrationAttemptsByScenario = new Map<string, number>();
const calibrationAttempts: ScenarioSamplingAttempt[] = [];
const classModels: ObservableClassifierModelAsset['classModels'] = fittedClassModels.map((model) => {
  if (model.id === 'unknown-signal') return model;
  const scenarios = scenariosByClass.get(model.id)!;
  const calibrationScoresByView = {
    'spectrum-only': [] as number[],
    'envelope-untimed': [] as number[],
    'envelope-timed': [] as number[],
  };
  for (const scenario of scenarios) {
    let scenarioCalibrationAttemptCount = 0;
    for (const snrDb of SNR_DB) for (const rbwDivisor of TAIL_CALIBRATION_RBW_DIVISORS) for (const seed of TAIL_CALIBRATION_SEEDS) {
      try {
        const attempt = featureSamples(scenario, snrDb, rbwDivisor, seed);
        recordRepresentativeSamplingAttempt(calibrationSampling, attempt);
        calibrationAttempts.push(scenarioSamplingAttempt(scenario.id, snrDb, rbwDivisor, seed, attempt));
        const attemptSamples = attempt.representatives.filter((sample) => sample.fitEligible).map((sample) => sample.values);
        if (attemptSamples.length > 0) {
          const attemptSamplesByView = {
            'spectrum-only': attemptSamples.map(spectrumOnly),
            'envelope-untimed': attemptSamples.map(envelopeUntimed),
            'envelope-timed': attemptSamples,
          } as const;
          for (const view of ['spectrum-only', 'envelope-untimed', 'envelope-timed'] as const) {
            const representativeSupportScores = attemptSamplesByView[view].map((sample) =>
              Math.max(...model.components.map((component) => studentTModelTailProbability(sample, component))));
            calibrationScoresByView[view].push(Math.min(...representativeSupportScores));
          }
          scenarioCalibrationAttemptCount += 1;
        } else if (attempt.representatives.length === 0) detectorConditionedCalibrationMisses.push(`${scenario.id}:snr=${snrDb}:rbw=${rbwDivisor}:seed=${seed}`);
        else fitEligibilityExcludedCalibrationAttempts.push(`${scenario.id}:snr=${snrDb}:rbw=${rbwDivisor}:seed=${seed}`);
      } catch (error) {
        throw new Error(`Tail calibration extraction failed for ${scenario.id} at SNR ${snrDb} dB, RBW divisor ${rbwDivisor}, seed ${seed}`, { cause: error });
      }
    }
    if (scenarioCalibrationAttemptCount < MINIMUM_DISTINCT_CALIBRATION_ATTEMPTS) {
      throw new Error(`${scenario.id} has only ${scenarioCalibrationAttemptCount} detector-conditioned fit-eligible tail-calibration attempts`);
    }
    const scenarioAttempts = calibrationAttempts.filter((attempt) => attempt.scenarioId === scenario.id);
    assertCompleteAttemptMatrix('calibration', scenario.id, scenarioAttempts, SNR_DB, TAIL_CALIBRATION_RBW_DIVISORS, TAIL_CALIBRATION_SEEDS);
    assertCalibrationCoverage(scenario, scenarioAttempts);
    assertHighSnrSeedCoverage('calibration', scenario, scenarioAttempts, TAIL_CALIBRATION_SEEDS);
    calibrationAttemptsByScenario.set(scenario.id, scenarioCalibrationAttemptCount);
  }
  const calibrationAttemptCount = calibrationScoresByView['envelope-timed'].length;
  const expectedCalibrationAttemptCount = scenarios.reduce((sum, scenario) =>
    sum + (calibrationAttemptsByScenario.get(scenario.id) ?? 0), 0);
  for (const view of ['spectrum-only', 'envelope-untimed', 'envelope-timed'] as const) {
    if (calibrationScoresByView[view].length !== expectedCalibrationAttemptCount) {
      throw new Error(`${model.id} ${view} calibration has ${calibrationScoresByView[view].length} scores for ${expectedCalibrationAttemptCount} fit-eligible acquisition attempts`);
    }
  }
  if (calibrationAttemptCount < MINIMUM_DISTINCT_CALIBRATION_ATTEMPTS) {
    throw new Error(`${model.id} has only ${calibrationAttemptCount} detector-conditioned fit-eligible tail-calibration attempts`);
  }
  const tailCalibrationScoresByView = {
    'spectrum-only': calibrationScoresByView['spectrum-only'].sort((left, right) => left - right),
    'envelope-untimed': calibrationScoresByView['envelope-untimed'].sort((left, right) => left - right),
    'envelope-timed': calibrationScoresByView['envelope-timed'].sort((left, right) => left - right),
  };
  return { ...model, tailCalibrationScoresByView };
});

const trainingMatrix = {
  snrDb: SNR_DB,
  rbwDivisors: RBW_DIVISORS,
  seeds: SEEDS,
  classificationSweeps: CLASSIFICATION_SWEEPS,
  observationOpportunityHorizons: {
    standard: STANDARD_OBSERVATION_OPPORTUNITIES,
    fullBand2g4: FULL_BAND_2G4_OBSERVATION_OPPORTUNITIES,
  },
  // The validator uses both explicit fitting and calibration grids to prove
  // its nuisance seeds/RBWs are held out. Fit/calibration RBWs intentionally
  // overlap; their seed arrays are asserted disjoint above.
  tailCalibrationSeeds: TAIL_CALIBRATION_SEEDS,
  tailCalibrationRbwDivisors: TAIL_CALIBRATION_RBW_DIVISORS,
  tailCalibrationScoreUnit: TAIL_CALIBRATION_SCORE_UNIT,
  tailCalibrationRepresentativeAggregationPolicy: TAIL_CALIBRATION_REPRESENTATIVE_AGGREGATION_POLICY,
  tailCalibrationAttemptCountsByScenario: Object.fromEntries(calibrationAttemptsByScenario),
  detectorConditionedFitMisses,
  detectorConditionedCalibrationMisses,
  fitEligibilityExcludedFitAttempts,
  fitEligibilityExcludedCalibrationAttempts,
  scenarioExcludedFromComponentFitIds: SCENARIO_EXCLUDED_FROM_COMPONENT_FIT_IDS,
  exactObservableEquivalenceNullScenarioIds: EXACT_OBSERVABLE_EQUIVALENCE_NULL_SCENARIO_IDS,
  knownAcquisitionValidationOnlyScenarioIds: KNOWN_ACQUISITION_VALIDATION_ONLY_SCENARIO_IDS,
  selectionPolicy: SELECTION_POLICY,
  representativeWeightingPolicy: REPRESENTATIVE_WEIGHTING_POLICY,
  representativeEligibilityPolicy: REPRESENTATIVE_ELIGIBILITY_POLICY,
} as const;

const asset: ObservableClassifierModelAsset = {
  id: 'bayesian-observable-equivalence-v5',
  corpusVersion: CLASSIFICATION_CORPUS_VERSION,
  sourceCommit: SOURCE_COMMIT,
  corpusSha256: CORPUS_SHA256,
  preprocessing: 'scalar-observable-features-v5',
  priorId: 'engineering-design-class-weights-v1',
  calibrationId: 'synthetic-view-matched-conformal-independent-attempt-min-support-detector-conditioned-physical-uncalibrated-v6',
  generatedAt: '2026-07-14T00:00:00.000Z',
  dimensions,
  trainingMatrix,
  classModels,
};

const source = `/* Generated by tools/train-observable-classifier.ts; do not hand edit. */\n`
  + `import type { ObservableClassifierModelAsset } from '../observable-classifier-model.js';\n\n`
  + `export const BAYESIAN_OBSERVABLE_MODEL: ObservableClassifierModelAsset = ${JSON.stringify(asset, null, 2)};\n`;
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, source);
const modelAssetSha256 = createHash('sha256').update(source).digest('hex');
writeFileSync(MANIFEST_OUTPUT, `/* Generated by tools/train-observable-classifier.ts; do not hand edit. */\nexport const BAYESIAN_OBSERVABLE_MODEL_SHA256 = '${modelAssetSha256}' as const;\n`);
console.log(JSON.stringify({
  output: OUTPUT,
  manifest: MANIFEST_OUTPUT,
  modelAssetSha256,
  classes: classModels.length,
  components: classModels.reduce((sum, model) => sum + model.components.length, 0),
  dimensions: dimensions.length,
  fittingExamples: [...samplesByScenario.values()].reduce((sum, samples) => sum + samples.length, 0),
  fittingExamplesByScenario: Object.fromEntries([...samplesByScenario].map(([scenarioId, samples]) => [scenarioId, samples.length])),
  calibrationAttemptsByScenario: Object.fromEntries(calibrationAttemptsByScenario),
  fittingAttemptCoverageByScenario: attemptCoverageByScenario(fittingAttempts),
  calibrationAttemptCoverageByScenario: attemptCoverageByScenario(calibrationAttempts),
  tailCalibrationAttemptScoresPerView: classModels.reduce((sum, model) => sum + (model.tailCalibrationScoresByView?.['envelope-timed'].length ?? 0), 0),
  tailCalibrationScoreUnit: TAIL_CALIBRATION_SCORE_UNIT,
  tailCalibrationRepresentativeAggregationPolicy: TAIL_CALIBRATION_REPRESENTATIVE_AGGREGATION_POLICY,
  representativeWeightingPolicy: REPRESENTATIVE_WEIGHTING_POLICY,
  coverageGates: {
    highSnrMinimumDb: HIGH_SNR_MINIMUM_DB,
    defaultHighSnrMinimumSeedCoverage: 1,
    highSnrMinimumSeedCoverageByScenario: HIGH_SNR_MINIMUM_SEED_COVERAGE_BY_SCENARIO,
    minimumDistinctFittingAttempts: MINIMUM_DISTINCT_FITTING_ATTEMPTS,
    minimumFittingSnrLevels: MINIMUM_FITTING_SNR_LEVELS,
    minimumFittingRbwDivisors: MINIMUM_FITTING_RBW_DIVISORS,
    syntheticSupportRejectionAlpha: SYNTHETIC_SUPPORT_REJECTION_ALPHA,
    minimumDistinctCalibrationAttempts: MINIMUM_DISTINCT_CALIBRATION_ATTEMPTS,
  },
  fittingSampling,
  calibrationSampling,
}, null, 2));

function spectrumOnly(sample: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.entries(sample).filter(([name]) => !name.startsWith('envelope.')));
}

function envelopeUntimed(sample: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.entries(sample).filter(([name]) => !name.startsWith('envelope.periodicEnergy') && name !== 'envelope.logTransitionRateHz'));
}

function featureSamples(scenario: CanonicalClassificationScenario, snrDb: number, rbwDivisor: number, seed: number): FeatureSamplingAttempt {
  const nominalBinWidthHz = scenario.recommendedSpanHz / 449;
  const actualRbwHz = Math.max(nominalBinWidthHz * 0.8, scenario.occupiedBandwidthHz / rbwDivisor, 1_000);
  const observationHorizon = observationOpportunityHorizon(scenario);
  const observations = Array.from({ length: observationHorizon }, (_, lookIndex) => synthesizeCanonicalObservation(scenario.id, {
    lookIndex,
    seed,
    snrDb,
    actualRbwHz,
    points: 450,
    sweepTimeSeconds: 0.05,
    zeroSpanPoints: 450,
    zeroSpanSamplePeriodSeconds: 1 / 9_000,
  }));
  const sweeps = observations.map((observation) => asSweep(scenario, observation));
  const detector = new SignalDetector(PRODUCTION_DETECTION_CONFIG);
  const tracker = new SignalTracker(PRODUCTION_DETECTION_CONFIG);
  const recordedRepresentativeKeys = new Set<string>();
  const representatives: FirstReadyFeatureSample[] = [];
  for (const [lookIndex, sweep] of sweeps.entries()) {
    const tracks = tracker.update(sweep, detector.analyze(sweep));
    const ready = classificationRepresentatives(tracks.filter((track) => track.state === 'active'))
      .filter((track) => classificationSourceSweepIds(track).length >= CLASSIFICATION_SWEEPS)
      .map((detection) => ({ detection, representativeKey: classificationRepresentativeKey(detection) }))
      .sort((left, right) => left.representativeKey.localeCompare(right.representativeKey));
    for (const { detection, representativeKey } of ready) {
      if (recordedRepresentativeKeys.has(representativeKey)) continue;
      recordedRepresentativeKeys.add(representativeKey);
      const evidenceSweeps = sweeps.slice(0, lookIndex + 1);
      const expectedSweepIds = classificationSourceSweepIds(detection).slice(-CLASSIFICATION_SWEEPS);
      const zeroSpanObservation = synthesizeCanonicalObservation(scenario.id, {
        lookIndex: lookIndex + 1,
        seed,
        snrDb,
        actualRbwHz,
        points: 450,
        sweepTimeSeconds: 0.05,
        zeroSpanPoints: 450,
        zeroSpanSamplePeriodSeconds: 1 / 9_000,
        zeroSpanFrequencyHz: detection.peakHz,
      });
      const featureObservation = extractObservableFeatures(detection, {
        sweeps: evidenceSweeps,
        zeroSpan: asZeroSpan(zeroSpanObservation, detection),
      });
      if (expectedSweepIds.length !== CLASSIFICATION_SWEEPS || featureObservation.sweepIds.length !== CLASSIFICATION_SWEEPS) {
        throw new Error(`Classifier fitting window has ${expectedSweepIds.length} admitted / ${featureObservation.sweepIds.length} extracted source sweeps, expected ${CLASSIFICATION_SWEEPS}`);
      }
      const observedSweepIds = [...featureObservation.sweepIds].sort();
      const admittedSweepIds = [...expectedSweepIds].sort();
      if (observedSweepIds.some((id, index) => id !== admittedSweepIds[index])) {
        throw new Error(`Classifier fitting window does not preserve the latest ${CLASSIFICATION_SWEEPS} effective source sweeps for ${detection.id}`);
      }
      const associationMode = detection.associationMode ?? 'frequency-local';
      representatives.push({
        values: featureObservation.values,
        representativeKey,
        firstReadyOpportunity: lookIndex + 1,
        associationMode,
        fitEligible: observableRepresentativeIsEligibleForModelFit(
          scenario.truthClass === 'bluetooth-classic-like' || scenario.truthClass === 'bluetooth-le-like'
            ? 'bluetooth-like'
            : scenario.truthClass,
          scenario.occupiedBandwidthHz,
          detection,
          featureObservation,
        ),
      });
    }
  }
  return { observationHorizon, representatives };
}

function emptyRepresentativeSamplingAudit(): RepresentativeSamplingAudit {
  return {
    attemptCount: 0,
    attemptsWithAnyFirstReadyRepresentative: 0,
    attemptsWithFitEligibleRepresentative: 0,
    firstReadyRepresentativeCount: 0,
    fitEligibleRepresentativeCount: 0,
    fitIneligibleRepresentativeCount: 0,
    multiRepresentativeAttemptCount: 0,
    maximumFirstReadyRepresentativesPerAttempt: 0,
    observationHorizonCounts: {},
    firstReadyOpportunityCounts: {},
  };
}

function recordRepresentativeSamplingAttempt(audit: RepresentativeSamplingAudit, attempt: FeatureSamplingAttempt): void {
  const representativeCount = attempt.representatives.length;
  const eligibleCount = attempt.representatives.filter((sample) => sample.fitEligible).length;
  audit.attemptCount += 1;
  if (representativeCount > 0) audit.attemptsWithAnyFirstReadyRepresentative += 1;
  if (eligibleCount > 0) audit.attemptsWithFitEligibleRepresentative += 1;
  if (representativeCount > 1) audit.multiRepresentativeAttemptCount += 1;
  audit.firstReadyRepresentativeCount += representativeCount;
  audit.fitEligibleRepresentativeCount += eligibleCount;
  audit.fitIneligibleRepresentativeCount += representativeCount - eligibleCount;
  audit.maximumFirstReadyRepresentativesPerAttempt = Math.max(audit.maximumFirstReadyRepresentativesPerAttempt, representativeCount);
  audit.observationHorizonCounts[attempt.observationHorizon] = (audit.observationHorizonCounts[attempt.observationHorizon] ?? 0) + 1;
  for (const sample of attempt.representatives) {
    audit.firstReadyOpportunityCounts[sample.firstReadyOpportunity] = (audit.firstReadyOpportunityCounts[sample.firstReadyOpportunity] ?? 0) + 1;
  }
}

function scenarioSamplingAttempt(
  scenarioId: string,
  snrDb: number,
  rbwDivisor: number,
  seed: number,
  attempt: FeatureSamplingAttempt,
): ScenarioSamplingAttempt {
  return {
    scenarioId,
    snrDb,
    rbwDivisor,
    seed,
    representativeCount: attempt.representatives.length,
    fitEligibleRepresentativeCount: attempt.representatives.filter((sample) => sample.fitEligible).length,
  };
}

function assertCompleteAttemptMatrix(
  purpose: 'fitting' | 'calibration',
  scenarioId: string,
  attempts: readonly ScenarioSamplingAttempt[],
  snrLevels: readonly number[],
  rbwDivisors: readonly number[],
  seeds: readonly number[],
): void {
  const keys = attempts.map(samplingAttemptKey);
  const uniqueKeys = new Set(keys);
  if (uniqueKeys.size !== attempts.length) {
    throw new Error(`${scenarioId} ${purpose} matrix contains ${attempts.length - uniqueKeys.size} duplicate acquisition attempts`);
  }
  const expectedKeys = snrLevels.flatMap((snrDb) => rbwDivisors.flatMap((rbwDivisor) => seeds.map((seed) =>
    samplingAttemptKey({ scenarioId, snrDb, rbwDivisor, seed }))));
  const missingKeys = expectedKeys.filter((key) => !uniqueKeys.has(key));
  const unexpectedKeys = keys.filter((key) => !expectedKeys.includes(key));
  if (missingKeys.length > 0 || unexpectedKeys.length > 0) {
    throw new Error(`${scenarioId} ${purpose} matrix is incomplete (missing=${missingKeys.length}, unexpected=${unexpectedKeys.length})`);
  }
}

function assertFittingCoverage(
  scenario: CanonicalClassificationScenario,
  attempts: readonly ScenarioSamplingAttempt[],
): void {
  const eligibleAttempts = attempts.filter((attempt) => attempt.fitEligibleRepresentativeCount > 0);
  if (eligibleAttempts.length < MINIMUM_DISTINCT_FITTING_ATTEMPTS) {
    throw new Error(`${scenario.id} has only ${eligibleAttempts.length} distinct fit-eligible acquisition attempts; expected at least one ${MINIMUM_DISTINCT_FITTING_ATTEMPTS}-seed block`);
  }
  if (scenario.truthClass === 'unknown-signal') return;
  const coveredSnrLevels = new Set(eligibleAttempts.map((attempt) => attempt.snrDb));
  const coveredRbwDivisors = new Set(eligibleAttempts.map((attempt) => attempt.rbwDivisor));
  if (coveredSnrLevels.size < MINIMUM_FITTING_SNR_LEVELS) {
    throw new Error(`${scenario.id} fit-eligible attempts cover only ${coveredSnrLevels.size} SNR level(s); expected at least ${MINIMUM_FITTING_SNR_LEVELS}`);
  }
  if (coveredRbwDivisors.size < MINIMUM_FITTING_RBW_DIVISORS) {
    throw new Error(`${scenario.id} fit-eligible attempts cover only ${coveredRbwDivisors.size} RBW divisor(s); expected at least ${MINIMUM_FITTING_RBW_DIVISORS}`);
  }
}

function assertCalibrationCoverage(
  scenario: CanonicalClassificationScenario,
  attempts: readonly ScenarioSamplingAttempt[],
): void {
  const eligibleAttempts = attempts.filter((attempt) => attempt.fitEligibleRepresentativeCount > 0);
  if (eligibleAttempts.length < MINIMUM_DISTINCT_CALIBRATION_ATTEMPTS) {
    throw new Error(`${scenario.id} has only ${eligibleAttempts.length} distinct fit-eligible calibration attempts; ${MINIMUM_DISTINCT_CALIBRATION_ATTEMPTS} are required to resolve a p-value below ${SYNTHETIC_SUPPORT_REJECTION_ALPHA}`);
  }
}

function assertHighSnrSeedCoverage(
  purpose: 'fitting' | 'calibration',
  scenario: CanonicalClassificationScenario,
  attempts: readonly ScenarioSamplingAttempt[],
  seeds: readonly number[],
): void {
  assertUniqueNumbers(`${purpose} high-SNR coverage seeds`, seeds);
  const configuredSeeds = new Set(seeds);
  const minimumCoverage = HIGH_SNR_MINIMUM_SEED_COVERAGE_BY_SCENARIO[scenario.id] ?? 1;
  const requiredSeedCount = Math.ceil(configuredSeeds.size * minimumCoverage);
  for (const snrDb of SNR_DB.filter((value) => value >= HIGH_SNR_MINIMUM_DB)) {
    const coveredSeeds = new Set(attempts
      .filter((attempt) => attempt.snrDb === snrDb
        && configuredSeeds.has(attempt.seed)
        && attempt.fitEligibleRepresentativeCount > 0)
      .map((attempt) => attempt.seed));
    if (coveredSeeds.size < requiredSeedCount) {
      throw new Error(`${scenario.id} ${purpose} high-SNR fit-eligible acquisition covered ${coveredSeeds.size}/${configuredSeeds.size} distinct seeds at ${snrDb} dB; required ${requiredSeedCount}/${configuredSeeds.size}`);
    }
  }
}

function attemptCoverageByScenario(
  attempts: readonly ScenarioSamplingAttempt[],
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const scenarioIds = [...new Set(attempts.map((attempt) => attempt.scenarioId))].sort();
  return Object.fromEntries(scenarioIds.map((scenarioId) => {
    const selected = attempts.filter((attempt) => attempt.scenarioId === scenarioId);
    return [scenarioId, {
      distinctAttempts: new Set(selected.map(samplingAttemptKey)).size,
      attemptsWithAnyFirstReadyRepresentative: selected.filter((attempt) => attempt.representativeCount > 0).length,
      attemptsWithFitEligibleRepresentative: selected.filter((attempt) => attempt.fitEligibleRepresentativeCount > 0).length,
      fitEligibleSnrLevels: [...new Set(selected.filter((attempt) => attempt.fitEligibleRepresentativeCount > 0).map((attempt) => attempt.snrDb))].sort((left, right) => left - right),
      fitEligibleRbwDivisors: [...new Set(selected.filter((attempt) => attempt.fitEligibleRepresentativeCount > 0).map((attempt) => attempt.rbwDivisor))].sort((left, right) => left - right),
      highSnrSeedCoverage: Object.fromEntries(SNR_DB.filter((snrDb) => snrDb >= HIGH_SNR_MINIMUM_DB).map((snrDb) => [
        snrDb,
        new Set(selected
          .filter((attempt) => attempt.snrDb === snrDb && attempt.fitEligibleRepresentativeCount > 0)
          .map((attempt) => attempt.seed)).size,
      ])),
      highSnrSeedCoverageUnit: 'distinct-seeds-with-fit-eligible-representative',
    }];
  }));
}

function assertUniqueNumbers(label: string, values: readonly number[]): void {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  if (duplicates.length > 0) {
    throw new Error(`${label} contains duplicate values: ${[...new Set(duplicates)].join(', ')}`);
  }
}

function assertDisjointNumbers(
  leftLabel: string,
  left: readonly number[],
  rightLabel: string,
  right: readonly number[],
): void {
  const rightValues = new Set(right);
  const overlap = left.filter((value) => rightValues.has(value));
  if (overlap.length > 0) {
    throw new Error(`${leftLabel} and ${rightLabel} overlap: ${overlap.join(', ')}`);
  }
}

function samplingAttemptKey(attempt: Pick<ScenarioSamplingAttempt, 'scenarioId' | 'snrDb' | 'rbwDivisor' | 'seed'>): string {
  return `${attempt.scenarioId}:snr=${attempt.snrDb}:rbw=${attempt.rbwDivisor}:seed=${attempt.seed}`;
}

function observationOpportunityHorizon(scenario: CanonicalClassificationScenario): number {
  const startHz = scenario.centerHz - scenario.recommendedSpanHz / 2;
  const stopHz = scenario.centerHz + scenario.recommendedSpanHz / 2;
  return startHz <= FULL_BAND_2G4_START_HZ && stopHz >= FULL_BAND_2G4_STOP_HZ
    ? FULL_BAND_2G4_OBSERVATION_OPPORTUNITIES
    : STANDARD_OBSERVATION_OPPORTUNITIES;
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

function asSweep(scenario: CanonicalClassificationScenario, observation: ReturnType<typeof synthesizeCanonicalObservation>): Sweep {
  const startHz = observation.frequencyHz[0]!;
  const stopHz = observation.frequencyHz.at(-1)!;
  return {
    kind: 'spectrum', id: `${scenario.id}-${observation.seed}-${observation.lookIndex}`, sequence: observation.lookIndex + 1,
    capturedAt: new Date(Date.UTC(2026, 0, 1) + observation.lookIndex * observation.sweepTimeSeconds * 1_000).toISOString(), elapsedMilliseconds: observation.sweepTimeSeconds * 1_000,
    frequencyHz: observation.frequencyHz, powerDbm: observation.powerDbm,
    requested: { startHz, stopHz, points: observation.frequencyHz.length, acquisitionFormat: 'text', rbwKhz: observation.actualRbwHz / 1_000, attenuationDb: 'auto', sweepTimeSeconds: observation.sweepTimeSeconds, detector: 'sample', spurRejection: 'off', lna: 'off', avoidSpurs: 'off', trigger: { mode: 'auto' } },
    actualStartHz: startHz, actualStopHz: stopHz, actualRbwHz: observation.actualRbwHz, actualAttenuationDb: 0,
    source: 'scan-text', complete: true, identity,
  };
}

function asZeroSpan(observation: ReturnType<typeof synthesizeCanonicalObservation>, detection: DetectedSignal): ZeroSpanCapture {
  const sweepTimeSeconds = observation.zeroSpanPowerDbm.length * observation.zeroSpanSamplePeriodSeconds;
  return {
    kind: 'zero-span', id: `zero-${observation.scenarioId}-${observation.seed}`, sequence: 1, capturedAt: '2026-01-01T00:00:00.000Z', elapsedMilliseconds: sweepTimeSeconds * 1_000,
    frequencyHz: observation.zeroSpanFrequencyHz, samplePeriodSeconds: observation.zeroSpanSamplePeriodSeconds, timingQualification: 'simulation-exact',
    targetDetectionId: detection.id,
    powerDbm: observation.zeroSpanPowerDbm,
    requested: { frequencyHz: observation.zeroSpanFrequencyHz, points: observation.zeroSpanPowerDbm.length, rbwKhz: observation.actualRbwHz / 1_000, attenuationDb: 'auto', sweepTimeSeconds, trigger: { mode: 'auto' } },
    actualRbwHz: observation.actualRbwHz, actualAttenuationDb: 0, source: 'scan-text', complete: true, identity,
  };
}

function fitStudentTComponent(id: string, samples: readonly Readonly<Record<string, number>>[], dimensions: readonly string[], logWeight: number) {
  if (samples.length < 3) throw new Error(`${id} requires at least three training observations`);
  const rows = samples.map((sample) => dimensions.map((dimension) => sample[dimension]!));
  const location = dimensions.map((_dimension, index) => mean(rows.map((row) => row[index]!)));
  const degreesOfFreedom = 7;
  const scale = dimensions.map((_rowDimension, row) => dimensions.map((_columnDimension, column) => {
    const covariance = rows.reduce((sum, values) => sum + (values[row]! - location[row]!) * (values[column]! - location[column]!), 0) / (rows.length - 1);
    const regularizedCovariance = (row === column ? covariance : covariance * 0.35)
      + (row === column ? regularizationVariance(dimensions[row]!) : 0);
    // In this parameterization Cov[T_nu(0, scale)] = nu/(nu-2) * scale.
    // Convert the intended regularized empirical covariance to scale instead
    // of silently inflating it by 7/5.
    return regularizedCovariance * (degreesOfFreedom - 2) / degreesOfFreedom;
  }));
  return { id, logWeight, degreesOfFreedom, dimensions, location, scale };
}

function regularizationVariance(dimension: string): number {
  if (dimension === 'association.logBayesFactor') return 0.25 ** 2;
  if (dimension.includes('logBandwidth')) return 0.04 ** 2;
  if (dimension === 'spectrum.prominenceDb' || dimension === 'spectrum.powerVariationDb' || dimension === 'envelope.rangeDb' || dimension === 'envelope.standardDeviationDb') return 1.5 ** 2;
  if (dimension === 'envelope.logTransitionRateHz') return 0.08 ** 2;
  if (dimension === 'spectrum.logClusterCount') return 0.06 ** 2;
  return 0.035 ** 2;
}

function mean(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function median(values: readonly number[]): number { const ordered = [...values].sort((left, right) => left - right); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2; }
