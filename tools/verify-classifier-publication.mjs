#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_PATH = 'packages/analysis/src/models/bayesian-observable-v5.generated.ts';
const MANIFEST_PATH = 'packages/analysis/src/models/bayesian-observable-v5.manifest.generated.ts';
const REPORT_PATH = '.artifacts/classifier-validation/report.json';
const PINNED_SIGNAL_LAB_COMMIT = 'c036e063bce6c6cc1515750a4d5614f1c2ab5df8';
const PINNED_CORPUS_SHA256 = '38288f0e0437dbb687674308afecb4f30adadc9e93ea7abad3b8bf13d80ec918';
const PINNED_CORPUS_VERSION = 'observable-scalar-corpus-v13';
const PINNED_MODEL_ID = 'bayesian-observable-equivalence-v5';
const PINNED_PREPROCESSING_ID = 'scalar-observable-features-v6';
const PINNED_PRIOR_ID = 'engineering-design-class-weights-v1';
const PINNED_CALIBRATION_ID = 'synthetic-view-matched-stratified-online-attempt-min-support-rank-detector-conditioned-physical-uncalibrated-v10';
const PINNED_DECISION_POLICY_ID = 'observable-open-set-decision-v9';
const PINNED_ACCEPTANCE_POLICY_ID = 'synthetic-observable-classifier-full-corpus-release-gates-v1';
const PINNED_PRODUCTION_TEMPORAL_SCHEDULES = [
  { id: 'contiguous-from-zero-v1', sourceLookIndexOffset: 0, skipAfterSpectrumOpportunities: null, skippedSourceOpportunities: 0 },
  { id: 'post-eight-spectrum-single-capture-skip-v1', sourceLookIndexOffset: 0, skipAfterSpectrumOpportunities: 8, skippedSourceOpportunities: 1 },
  { id: 'profile-sequence-offset-225-post-eight-spectrum-single-capture-skip-v1', sourceLookIndexOffset: 225, skipAfterSpectrumOpportunities: 8, skippedSourceOpportunities: 1 },
];
const PINNED_PRODUCTION_TEMPORAL_SCHEDULE_IDS = PINNED_PRODUCTION_TEMPORAL_SCHEDULES
  .map((schedule) => schedule.id);
const PINNED_VALIDATION_TEMPORAL_SCHEDULE = {
  id: 'held-out-offset-347-post-eleven-single-skip-v1',
  sourceLookIndexOffset: 347,
  skipAfterSpectrumOpportunities: 11,
  skippedSourceOpportunities: 1,
};
const PINNED_DETECTED_POWER_SYNTHESIS_FILTER_POLICY = {
  id: 'explicit-generator-filter-width-by-acquisition-regime-v1',
  divisorAcquisitionRegimes: 'match-swept-spectrum-actual-rbw-nuisance-v1',
  signalLabProductionAcquisitionRegimes: 'fixed-generator-internal-width-v1',
  signalLabProductionSynthesisFilterWidthHz: 100_000,
  measurementActualRbwQualification: 'unavailable',
};
const PINNED_PRODUCTION_GEOMETRY_ID = 'signal-lab-recommended-span-450-point-grid-v1';
const PINNED_PRODUCTION_ACQUISITION_REGIME = {
  id: 'signal-lab-recommended-span-grid-with-session-sequence-nuisance-v1',
  geometry: {
    id: PINNED_PRODUCTION_GEOMETRY_ID,
    sourceKind: 'signal-lab',
    kind: 'recommended-span-inclusive-grid',
    sweepPoints: 450,
    spanPolicy: 'canonical-recommended-span-v1',
    resolutionScalePolicy: 'recommended-span-divided-by-points-minus-one-v1',
  },
  temporalSchedules: PINNED_PRODUCTION_TEMPORAL_SCHEDULES,
  componentFitIncluded: true,
  tailCalibrationIncluded: true,
};
const PINNED_ACQUISITION_REGIME_IDS = [
  ...[12, 20, 35, 55, 80, 120].map((divisor) =>
    `occupied-bandwidth-rbw-divisor:${divisor}/contiguous-from-zero-v1`),
  ...PINNED_PRODUCTION_TEMPORAL_SCHEDULE_IDS.map((scheduleId) =>
    `${PINNED_PRODUCTION_GEOMETRY_ID}/${scheduleId}`),
];
const PINNED_TAIL_SCORE_TOLERANCE = 1e-12;
const PINNED_KNOWN_CLASS_IDS = [
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
];
const PINNED_CLASS_IDS = [...PINNED_KNOWN_CLASS_IDS, 'unknown-signal'];
const PINNED_DIMENSIONS = [
  'association.logBayesFactor',
  'envelope.duty',
  'envelope.logTransitionRateHz',
  'envelope.periodicEnergy100Hz',
  'envelope.periodicEnergy1600Hz',
  'envelope.periodicEnergy1733Hz',
  'envelope.periodicEnergy2000Hz',
  'envelope.periodicEnergy200Hz',
  'envelope.rangeDb',
  'envelope.standardDeviationDb',
  'envelope.tuneOffsetFraction',
  'history.bleAdvertisingScore',
  'history.peakSpanFraction',
  'history.raster1MHzScore',
  'history.raster2MHzScore',
  'spectrum.centerFraction',
  'spectrum.centerNotch',
  'spectrum.entropy',
  'spectrum.flatness',
  'spectrum.logBandwidthHz',
  'spectrum.logBandwidthRbwRatio',
  'spectrum.logClusterCount',
  'spectrum.peakDensity',
  'spectrum.peakDriftFraction',
  'spectrum.powerVariationDb',
  'spectrum.prominenceDb',
  'spectrum.sidebandScore',
  'spectrum.symmetry',
];
const PINNED_COMPONENT_COUNT = 18;
const PINNED_FITTING_REPRESENTATIVE_COUNT = 4_755;
const PINNED_TAIL_CALIBRATION_ATTEMPT_COUNT = 3_055;
const PINNED_REPRESENTATIVE_ELIGIBILITY_POLICY = 'observation-only-hypothesis-domain-v5';
const PINNED_MINIMUM_KNOWN_SYNTHETIC_SUPPORT_RANK = 0.025;
const PINNED_PRIOR_VARIANT_IDS = [
  'engineering-baseline-v1',
  'unknown-mass-0.10-known-ratios-preserved-v1',
  'unknown-mass-0.30-known-ratios-preserved-v1',
  'cellular-family-up-within-family-ratios-preserved-v1',
  'unlicensed-families-up-within-family-ratios-preserved-v1',
];
const PINNED_ENGINEERING_PRIOR = {
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
};
const STALE_PUBLICATION_VALUES = [
  ['4,775', 'stale fitting-representative count'],
  ['3,057', 'stale tail-calibration attempt count'],
  ['8,140', 'stale fitting-representative count'],
  ['1,990', 'stale tail-calibration attempt count'],
  ['Calibration v8', 'stale shorthand calibration version'],
  ['observation-only-hypothesis-domain-v4', 'stale representative-eligibility policy'],
  ['a217b3b42d5ca4fd6baa4e59cf7d7905bada2c0e', 'stale SignalLab source commit'],
  ['28ed8e9d0dba9f7672880eee608b4328f4482d13', 'stale SignalLab source commit'],
  ['1197f2d46c9b4953253302a95a31cb7ff2212fca', 'stale SignalLab source commit'],
  ['3fc4f90b2b5b948c93316d70a6a924229044844474c9458844d980b864482f51', 'stale corpus source-manifest SHA-256'],
  ['deb9ed20a6995aeac66c74f7bd1df0ba02f7df5edba0ed493e72b623be65814f', 'stale corpus source-manifest SHA-256'],
  ['3207f1a8170fc44fd8886d9d11bb24367b8b45915fcecabcde1f77f4ddfe5cb4', 'stale corpus source-manifest SHA-256'],
  ['1c9d18cbdabf28ff7f52a6bd740172feaabaf3521068f757228fb39d57c0279f', 'stale model asset SHA-256'],
  ['b664d952ec4a7ca8fc87652c0c0586b2e5f9e09e88b7b24491bcaa567e166b09', 'stale model asset SHA-256'],
  ['05ec69aacc100f272446b7e00ba36cd112e516b8832585174312bac1f6af7d0c', 'stale model asset SHA-256'],
];
const PINNED_TAIL_VIEWS = ['spectrum-only', 'envelope-untimed', 'envelope-timed'];
const PINNED_FITTING_SEEDS = [407, 1_407, 2_407, 3_407, 4_407, 5_407];
const PINNED_CALIBRATION_SEEDS = [6_407, 6_419, 6_421, 6_449, 6_451, 6_469, 6_473, 6_481];
const PINNED_VALIDATION_SEEDS = [13_001, 13_019, 13_037, 13_063, 13_081, 13_099, 13_127, 13_151];
const PINNED_TRAINING_SNR_DB = [6, 10, 16, 24, 32];
const PINNED_TRAINING_RBW_DIVISORS = [12, 20, 35, 55, 80, 120];
const PINNED_VALIDATION_RBW_DIVISORS = [15.5, 44, 98];
const PINNED_PRODUCTION_HIGH_SNR_COVERAGE_POLICY = {
  id: 'detector-conditioned-production-regime-presence-v1',
  minimumDistinctSeedsPerHighSnrCell: 1,
  globalCoveragePolicy: 'all-seeds-at-one-or-more-regimes-except-declared-sparse-asynchronous-scenarios-v1',
};
const PINNED_TAIL_POLICIES = {
  scoreUnit: 'one-score-per-observation-domain-eligible-acquisition-attempt-v2',
  representativeSelection: 'online-all-ready-representatives-v1',
  representativeAggregation: 'minimum-support-across-observation-domain-eligible-online-representatives-v3',
  runtimeInterpretation: 'single-representative-rank-dominates-attempt-min-rank-v1',
  statisticalInterpretation: 'empirical-synthetic-reference-only-no-exchangeability-or-coverage-guarantee-v1',
};
const PINNED_CORPUS_SOURCE_PATHS = [
  'package-lock.json',
  'package.json',
  'src/canonical-timing.ts',
  'src/catalog.ts',
  'src/classification-corpus.ts',
  'src/contracts.ts',
  'src/source-provenance.ts',
  'src/waveforms.ts',
];
const PUBLICATION_PATHS = [
  'README.md',
  'docs/BAYESIAN_DETECTION_CLASSIFICATION_RESEARCH.md',
  'docs/SIGNALLAB_EMSO_CLASSIFIER_CONTRACT.md',
  'docs/UI_UX_CONTRACTS.md',
];

function valueAt(object, path) {
  let value = object;
  for (const segment of path.split('.')) {
    if (value === null || typeof value !== 'object' || !(segment in value)) {
      throw new Error(`${REPORT_PATH} is missing ${path}`);
    }
    value = value[segment];
  }
  return value;
}

function numberAt(object, path, { integer = false } = {}) {
  const value = valueAt(object, path);
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new Error(`${REPORT_PATH} ${path} must be a finite${integer ? ' integer' : ' number'}`);
  }
  return value;
}

function arrayAt(object, path) {
  const value = valueAt(object, path);
  if (!Array.isArray(value)) {
    throw new Error(`${REPORT_PATH} ${path} must be an array`);
  }
  return value;
}

function booleanAt(object, path) {
  const value = valueAt(object, path);
  if (typeof value !== 'boolean') throw new Error(`${REPORT_PATH} ${path} must be a boolean`);
  return value;
}

function formatInteger(value) {
  if (!Number.isInteger(value)) {
    throw new Error(`cannot publish non-integer ${value} as an integer`);
  }
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatFixed(value, digits) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`cannot publish non-finite value ${value}`);
  }
  return value.toFixed(digits);
}

function formatScientific(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
    throw new Error(`cannot publish ${value} in normalized scientific notation`);
  }
  const [rawCoefficient, rawExponent] = value.toExponential().split('e');
  const coefficient = rawCoefficient.replace(/0+$/, '').replace(/\.$/, '');
  return `${coefficient}e${Number(rawExponent)}`;
}

function formatOxford(values) {
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

function numberWord(value) {
  const words = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six',
    'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  ];
  return words[value] ?? String(value);
}

function pluralize(value, singular) {
  return value === 1 ? singular : `${singular}s`;
}

function expectedPriorVariants() {
  return [
    { id: PINNED_PRIOR_VARIANT_IDS[0], kind: 'declared-engineering-assumption', prior: { ...PINNED_ENGINEERING_PRIOR } },
    { id: PINNED_PRIOR_VARIANT_IDS[1], kind: 'unknown-mass-shift', prior: priorWithUnknownMass(0.10) },
    { id: PINNED_PRIOR_VARIANT_IDS[2], kind: 'unknown-mass-shift', prior: priorWithUnknownMass(0.30) },
    {
      id: PINNED_PRIOR_VARIANT_IDS[3], kind: 'family-mass-shift',
      prior: priorWithKnownFamilyMultipliers({ analog: 0.90, cellular: 1.35, wifi: 0.90, bluetooth: 0.90 }),
    },
    {
      id: PINNED_PRIOR_VARIANT_IDS[4], kind: 'family-mass-shift',
      prior: priorWithKnownFamilyMultipliers({ analog: 0.90, cellular: 0.90, wifi: 1.25, bluetooth: 1.25 }),
    },
  ];
}

function priorWithUnknownMass(unknownMass) {
  const knownBaselineMass = 1 - PINNED_ENGINEERING_PRIOR['unknown-signal'];
  return Object.fromEntries(PINNED_CLASS_IDS.map((id) => [
    id,
    id === 'unknown-signal'
      ? unknownMass
      : PINNED_ENGINEERING_PRIOR[id] * (1 - unknownMass) / knownBaselineMass,
  ]));
}

function priorWithKnownFamilyMultipliers(multipliers) {
  const unknownMass = PINNED_ENGINEERING_PRIOR['unknown-signal'];
  const weightedKnownTotal = PINNED_KNOWN_CLASS_IDS.reduce(
    (sum, id) => sum + PINNED_ENGINEERING_PRIOR[id] * multipliers[priorFamily(id)],
    0,
  );
  return Object.fromEntries(PINNED_CLASS_IDS.map((id) => [
    id,
    id === 'unknown-signal'
      ? unknownMass
      : PINNED_ENGINEERING_PRIOR[id] * multipliers[priorFamily(id)] * (1 - unknownMass) / weightedKnownTotal,
  ]));
}

function priorFamily(id) {
  if (id === 'cw-like' || id === 'am-dsb-full-carrier-like' || id === 'fm-angle-modulated-like') return 'analog';
  if (id === 'wifi-hr-dsss-like' || id === 'wifi-ofdm-like') return 'wifi';
  if (id === 'bluetooth-like') return 'bluetooth';
  return 'cellular';
}

function normalizeProse(value) {
  return value
    .replace(/([A-Za-z])-\s+([A-Za-z])/g, '$1-$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function visibleMarkdown(value) {
  const withoutComments = value.replace(/<!--[\s\S]*?-->/g, '');
  const visible = [];
  let fenceCharacter;
  let fenceLength = 0;
  for (const line of withoutComments.split(/\r?\n/)) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1];
      if (fenceCharacter === undefined) {
        fenceCharacter = marker[0];
        fenceLength = marker.length;
      } else if (marker[0] === fenceCharacter && marker.length >= fenceLength) {
        fenceCharacter = undefined;
        fenceLength = 0;
      }
      continue;
    }
    if (fenceCharacter === undefined) visible.push(line);
  }
  return visible.join('\n');
}

function expectRange(failures, value, minimum, maximum, label) {
  if (value < minimum || value > maximum) {
    failures.push(`${label}: expected ${minimum}..${maximum}, observed ${value}`);
  }
}

function occurrenceCount(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function expectExactlyOnce(failures, path, text, expected, label) {
  const normalizedExpected = normalizeProse(expected);
  const count = occurrenceCount(text, normalizedExpected);
  if (count !== 1) {
    failures.push(
      `${path} must contain exactly one ${label} publication (found ${count}). Expected:\n${normalizedExpected}`,
    );
  }
}

function expectEqual(failures, actual, expected, label) {
  if (actual !== expected) {
    failures.push(`${label}: expected ${expected}, observed ${actual}`);
  }
}

function expectNear(failures, actual, expected, tolerance, label) {
  if (typeof actual !== 'number' || typeof expected !== 'number'
    || !Number.isFinite(actual) || !Number.isFinite(expected)
    || Math.abs(actual - expected) > tolerance) {
    failures.push(`${label}: expected ${expected} ± ${tolerance}, observed ${actual}`);
  }
}

function expectDeepEqual(failures, actual, expected, label) {
  expectEqual(failures, JSON.stringify(actual), JSON.stringify(expected), label);
}

function parseGeneratedModel(source) {
  const match = source.match(
    /export const BAYESIAN_OBSERVABLE_MODEL: ObservableClassifierModelAsset = (\{[\s\S]*\});\s*$/,
  );
  if (!match) throw new Error(`${MODEL_PATH} does not contain one generated JSON model payload`);
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`${MODEL_PATH} generated payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sourceLookIndex(schedule, opportunity) {
  const skipped = schedule.skipAfterSpectrumOpportunities !== null
    && opportunity >= schedule.skipAfterSpectrumOpportunities
    ? schedule.skippedSourceOpportunities
    : 0;
  return schedule.sourceLookIndexOffset + opportunity + skipped;
}

function sumPairMetric(pairs, key) {
  return pairs.reduce((sum, pair, index) => {
    if (pair === null || typeof pair !== 'object') {
      throw new Error(`${REPORT_PATH} corpus.exactObservableEquivalencePairAudit.pairs.${index} must be an object`);
    }
    const value = pair[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(
        `${REPORT_PATH} corpus.exactObservableEquivalencePairAudit.pairs.${index}.${key} must be a non-negative integer`,
      );
    }
    return sum + value;
  }, 0);
}

function collectMetrics(report, failures, expectedRollingScenarioIds) {
  const pairs = arrayAt(report, 'corpus.exactObservableEquivalencePairAudit.pairs');
  const nuisanceCells = sumPairMetric(pairs, 'nuisanceCells');
  const representativePairs = sumPairMetric(pairs, 'matchedRepresentativePairs');
  const evidenceViewPairs = sumPairMetric(pairs, 'matchedEvidenceViewPairs');
  const pairDiscrepancies = sumPairMetric(pairs, 'discrepancyCount');
  const reportedDiscrepancies = numberAt(
    report,
    'corpus.exactObservableEquivalencePairAudit.discrepancyCount',
    { integer: true },
  );
  expectEqual(
    failures,
    reportedDiscrepancies,
    pairDiscrepancies,
    'exact-equivalence aggregate discrepancy count',
  );

  const representatives = numberAt(report, 'admission.uniqueFirstReadyRepresentativeSamples', { integer: true });
  if (representatives <= 0) failures.push('first-ready representative count must be positive');
  for (const path of [
    'admission.firstReadyRepresentativeSamples',
    'admission.expectedFirstReadyRepresentativeSamples',
    'classificationConditionalOnAdmission.samples',
  ]) {
    expectEqual(failures, numberAt(report, path, { integer: true }), representatives, path);
  }

  const blePath = 'admission.highSnrUniqueSeedCoverage.byKnownScenario.bluetooth-le-advertising.bySnr';
  const ble24Covered = numberAt(report, `${blePath}.24.uniqueSeedsCovered`, { integer: true });
  const ble24Total = numberAt(report, `${blePath}.24.totalSeeds`, { integer: true });
  const ble32Covered = numberAt(report, `${blePath}.32.uniqueSeedsCovered`, { integer: true });
  const ble32Total = numberAt(report, `${blePath}.32.totalSeeds`, { integer: true });
  expectEqual(failures, ble24Total, ble32Total, 'BLE high-SNR seed denominator');
  if (ble24Total <= 0 || ble24Covered < 0 || ble32Covered < 0
    || ble24Covered > ble24Total || ble32Covered > ble32Total) {
    failures.push('BLE high-SNR seed coverage must use positive denominators and covered counts within each denominator');
  }

  const bleRepresentatives = numberAt(
    report,
    'classificationConditionalOnAdmission.association.byScenario.bluetooth-le-advertising.firstReadyRepresentativeSamples',
    { integer: true },
  );
  const bleBluetoothLike = numberAt(
    report,
    'classificationConditionalOnAdmission.association.byScenario.bluetooth-le-advertising.results.observable:bluetooth-like',
    { integer: true },
  );
  expectEqual(
    failures,
    bleBluetoothLike,
    bleRepresentatives,
    'published all-admitted-BLE-resolved-to-Bluetooth-like claim',
  );
  const bleResults = valueAt(
    report,
    'classificationConditionalOnAdmission.association.byScenario.bluetooth-le-advertising.results',
  );
  if (bleResults === null || typeof bleResults !== 'object' || Array.isArray(bleResults)) {
    throw new Error(`${REPORT_PATH} admitted BLE result counts must be an object`);
  }
  const bleResultEntries = Object.entries(bleResults);
  if (bleResultEntries.some(([, count]) => !Number.isInteger(count) || count < 0)) {
    failures.push('admitted BLE result counts must be non-negative integers');
  }
  expectEqual(
    failures,
    bleResultEntries.reduce((sum, [, count]) => sum + count, 0),
    bleRepresentatives,
    'admitted BLE result denominator',
  );
  for (const [label, count] of bleResultEntries) {
    if (label !== 'observable:bluetooth-like' && count !== 0) {
      failures.push(`admitted BLE result ${label} must be zero to publish an exclusive Bluetooth-like result`);
    }
  }

  const nuisanceSeeds = arrayAt(report, 'matrix.nuisanceShiftSeeds');
  const snrDb = arrayAt(report, 'matrix.snrDb');
  const rbwDivisors = arrayAt(report, 'matrix.rbwDivisors');
  const strictUnknownHoldouts = arrayAt(
    report,
    'corpus.manifestSplit.validatorOwnedPins.strictUnknownHoldout',
  ).length;
  const ambiguityStressCases = arrayAt(
    report,
    'corpus.manifestSplit.validatorOwnedPins.observableAmbiguityStress',
  ).length;
  const knownAcquisitionValidationCases = arrayAt(
    report,
    'corpus.manifestSplit.validatorOwnedPins.knownAcquisitionValidationOnly',
  ).length;
  for (const [path, values] of [
    ['matrix.nuisanceShiftSeeds', nuisanceSeeds],
    ['matrix.snrDb', snrDb],
    ['matrix.rbwDivisors', rbwDivisors],
  ]) {
    if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(`${REPORT_PATH} ${path} must contain only finite numbers`);
    }
  }
  expectEqual(failures, nuisanceSeeds.length, ble24Total, 'validation and BLE seed counts');
  expectEqual(
    failures,
    knownAcquisitionValidationCases,
    1,
    'published one-timeslot GSM acquisition-only case count',
  );

  const rollingCases = numberAt(report, 'productionRollingWindowValidation.cases', { integer: true });
  const rollingUniqueCases = numberAt(report, 'productionRollingWindowValidation.uniqueCases', { integer: true });
  if (rollingCases <= 0) failures.push('rolling-window case count must be positive');
  expectEqual(failures, rollingUniqueCases, rollingCases, 'rolling-window unique case count');
  const missingRollingScenarios = arrayAt(report, 'productionRollingWindowValidation.missingScenarios');
  expectEqual(failures, missingRollingScenarios.length, 0, 'rolling-window missing fitted known scenarios');
  const rollingKnownCoverage = numberAt(report, 'productionRollingWindowValidation.knownCoverage');
  const rollingHierarchicalAccuracy = numberAt(report, 'productionRollingWindowValidation.hierarchicalAccuracy');
  const rollingIncompatibleNonUnknownCount = numberAt(
    report,
    'productionRollingWindowValidation.incompatibleNonUnknownCount',
    { integer: true },
  );
  expectEqual(failures, rollingIncompatibleNonUnknownCount, 0, 'rolling-window incompatible non-unknown count');
  const rollingMinimumScenarioKnownCoverage = numberAt(
    report,
    'productionRollingWindowValidation.minimumScenarioKnownCoverage',
  );
  const rollingMinimumScenarioHierarchicalAccuracy = numberAt(
    report,
    'productionRollingWindowValidation.minimumScenarioHierarchicalAccuracy',
  );
  const rollingByScenario = valueAt(report, 'productionRollingWindowValidation.byScenario');
  if (rollingByScenario === null || typeof rollingByScenario !== 'object' || Array.isArray(rollingByScenario)) {
    throw new Error(`${REPORT_PATH} productionRollingWindowValidation.byScenario must be an object`);
  }
  expectDeepEqual(
    failures,
    Object.keys(rollingByScenario).sort(),
    [...expectedRollingScenarioIds].sort(),
    'rolling-window fitted known scenario IDs',
  );
  let rollingScenarioCaseTotal = 0;
  let rollingScenarioKnownCoveredTotal = 0;
  let rollingScenarioHierarchicallyCorrectTotal = 0;
  const rollingScenarioCoverages = [];
  const rollingScenarioAccuracies = [];
  for (const [scenarioId, value] of Object.entries(rollingByScenario)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${REPORT_PATH} rolling scenario ${scenarioId} must be an object`);
    }
    const cases = value.cases;
    if (!Number.isInteger(cases) || cases <= 0) failures.push(`rolling scenario ${scenarioId} cases must be a positive integer`);
    else rollingScenarioCaseTotal += cases;
    if (typeof value.knownCoverage !== 'number' || !Number.isFinite(value.knownCoverage)) {
      failures.push(`rolling scenario ${scenarioId} known coverage must be finite`);
    } else {
      expectRange(failures, value.knownCoverage, 0, 1, `rolling scenario ${scenarioId} known coverage`);
      rollingScenarioCoverages.push(value.knownCoverage);
      if (Number.isInteger(cases) && cases > 0) rollingScenarioKnownCoveredTotal += cases * value.knownCoverage;
    }
    if (typeof value.hierarchicalAccuracy !== 'number' || !Number.isFinite(value.hierarchicalAccuracy)) {
      failures.push(`rolling scenario ${scenarioId} hierarchical accuracy must be finite`);
    } else {
      expectRange(failures, value.hierarchicalAccuracy, 0, 1, `rolling scenario ${scenarioId} hierarchical accuracy`);
      rollingScenarioAccuracies.push(value.hierarchicalAccuracy);
      if (Number.isInteger(cases) && cases > 0) rollingScenarioHierarchicallyCorrectTotal += cases * value.hierarchicalAccuracy;
    }
  }
  expectEqual(failures, rollingScenarioCaseTotal, rollingCases, 'rolling-window by-scenario case total');
  if (rollingScenarioCaseTotal > 0) {
    expectNear(failures, rollingScenarioKnownCoveredTotal / rollingScenarioCaseTotal, rollingKnownCoverage, 1e-12, 'rolling-window aggregate known coverage');
    expectNear(failures, rollingScenarioHierarchicallyCorrectTotal / rollingScenarioCaseTotal, rollingHierarchicalAccuracy, 1e-12, 'rolling-window aggregate hierarchical accuracy');
  }
  if (rollingScenarioCoverages.length > 0) {
    expectEqual(failures, Math.min(...rollingScenarioCoverages), rollingMinimumScenarioKnownCoverage, 'rolling-window minimum scenario known coverage');
  }
  if (rollingScenarioAccuracies.length > 0) {
    expectEqual(failures, Math.min(...rollingScenarioAccuracies), rollingMinimumScenarioHierarchicalAccuracy, 'rolling-window minimum scenario hierarchical accuracy');
  }
  for (const [value, label] of [
    [rollingKnownCoverage, 'rolling known coverage'],
    [rollingHierarchicalAccuracy, 'rolling hierarchical accuracy'],
    [rollingMinimumScenarioKnownCoverage, 'rolling minimum scenario known coverage'],
    [rollingMinimumScenarioHierarchicalAccuracy, 'rolling minimum scenario hierarchical accuracy'],
  ]) expectRange(failures, value, 0, 1, label);
  for (const [metric, thresholdPath, label] of [
    [rollingKnownCoverage, 'productionRollingWindowValidation.acceptanceThresholds.overallKnownCoverage', 'rolling known coverage'],
    [rollingHierarchicalAccuracy, 'productionRollingWindowValidation.acceptanceThresholds.overallHierarchicalAccuracy', 'rolling hierarchical accuracy'],
    [rollingMinimumScenarioKnownCoverage, 'productionRollingWindowValidation.acceptanceThresholds.perScenarioKnownCoverage', 'minimum rolling per-scenario known coverage'],
    [rollingMinimumScenarioHierarchicalAccuracy, 'productionRollingWindowValidation.acceptanceThresholds.perScenarioHierarchicalAccuracy', 'minimum rolling per-scenario hierarchical accuracy'],
  ]) {
    const threshold = numberAt(report, thresholdPath);
    if (metric < threshold) failures.push(`${label}: ${metric} is below publication threshold ${threshold}`);
  }

  expectEqual(failures, booleanAt(report, 'matrix.tailCalibrationAudit.independentRecomputation.valid'), true, 'independent tail-calibration recomputation');
  expectEqual(failures, booleanAt(report, 'matrix.tailCalibrationAudit.independentRecomputation.aggregationRegression.passed'), true, 'all-online attempt-min regression');
  for (const path of [
    'matrix.tailCalibrationAudit.missingScenarioIds',
    'matrix.tailCalibrationAudit.unexpectedScenarioIds',
    'matrix.tailCalibrationAudit.invalidAttemptCounts',
    'matrix.tailCalibrationAudit.viewCountMismatches',
    'matrix.tailCalibrationAudit.independentRecomputation.attemptCountMismatches',
  ]) {
    expectEqual(failures, arrayAt(report, path).length, 0, `${path} length`);
  }
  const tailCalibrationLateMinimumCount = numberAt(
    report,
    'matrix.tailCalibrationAudit.independentRecomputation.lateMinimumCount',
    { integer: true },
  );
  if (tailCalibrationLateMinimumCount < 1) failures.push('independent tail-calibration audit must observe at least one later-online attempt minimum');
  const tailCalibrationAttemptCount = numberAt(
    report,
    'matrix.tailCalibrationAudit.independentRecomputation.allOnlineAttemptCount',
    { integer: true },
  );
  if (tailCalibrationAttemptCount <= 0 || tailCalibrationLateMinimumCount > tailCalibrationAttemptCount) {
    failures.push(`tail-calibration counts must satisfy 0 <= late minima <= positive all-online attempts; observed ${tailCalibrationLateMinimumCount}/${tailCalibrationAttemptCount}`);
  }
  const tailScoreComparisons = arrayAt(report, 'matrix.tailCalibrationAudit.independentRecomputation.scoreComparisons');
  const expectedTailComparisonKeys = PINNED_KNOWN_CLASS_IDS.flatMap((classId) =>
    PINNED_TAIL_VIEWS.map((view) => `${classId}/${view}`)).sort();
  const observedTailComparisonKeys = tailScoreComparisons.map((comparison, index) => {
    if (comparison === null || typeof comparison !== 'object'
      || typeof comparison.classId !== 'string' || typeof comparison.view !== 'string') {
      throw new Error(`${REPORT_PATH} tail score comparison ${index} must publish classId and view`);
    }
    return `${comparison.classId}/${comparison.view}`;
  }).sort();
  expectDeepEqual(
    failures,
    observedTailComparisonKeys,
    expectedTailComparisonKeys,
    'independent tail-calibration comparison key set',
  );
  const tailScoreTolerance = numberAt(report, 'matrix.tailCalibrationAudit.independentRecomputation.scoreTolerance');
  expectEqual(failures, tailScoreTolerance, PINNED_TAIL_SCORE_TOLERANCE, 'independent tail-calibration score tolerance');
  for (const [index, comparison] of tailScoreComparisons.entries()) {
    if (comparison === null || typeof comparison !== 'object') throw new Error(`${REPORT_PATH} tail score comparison ${index} must be an object`);
    if (!Number.isInteger(comparison.expectedCount) || comparison.expectedCount <= 0
      || !Number.isInteger(comparison.observedCount) || comparison.observedCount <= 0) {
      failures.push(`tail score comparison ${index} counts must be positive integers`);
    }
    expectEqual(failures, comparison.expectedCount, comparison.observedCount, `tail score comparison ${index} count`);
    if (typeof comparison.maximumAbsoluteDifference !== 'number'
      || !Number.isFinite(comparison.maximumAbsoluteDifference)
      || comparison.maximumAbsoluteDifference < 0
      || comparison.maximumAbsoluteDifference > tailScoreTolerance) {
      failures.push(`tail score comparison ${index} exceeds ${tailScoreTolerance}`);
    }
    if (typeof comparison.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(comparison.expectedSha256)
      || typeof comparison.observedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(comparison.observedSha256)) {
      failures.push(`tail score comparison ${index} hashes must be lowercase SHA-256`);
    }
    expectEqual(failures, comparison.expectedSha256, comparison.observedSha256, `tail score comparison ${index} hash`);
  }

  expectEqual(failures, booleanAt(report, 'priorSensitivity.valid'), true, 'engineering-prior sensitivity audit');
  expectEqual(failures, booleanAt(report, 'priorSensitivity.fieldPrevalenceCalibrated'), false, 'field-prevalence calibration claim');
  const priorVariants = arrayAt(report, 'priorSensitivity.variants');
  expectDeepEqual(
    failures,
    priorVariants.map((variant) => variant?.id),
    PINNED_PRIOR_VARIANT_IDS,
    'prior sensitivity variant IDs and order',
  );
  const pinnedPriorVariants = expectedPriorVariants();
  expectEqual(failures, booleanAt(report, 'priorSensitivity.modelPriorMatchesPinned'), true, 'engineering-prior model pin');
  expectEqual(failures, numberAt(report, 'priorSensitivity.baselineDecisionMismatchCount', { integer: true }), 0, 'engineering-prior baseline decision mismatch count');
  for (const [index, variant] of priorVariants.entries()) {
    if (variant === null || typeof variant !== 'object') throw new Error(`${REPORT_PATH} priorSensitivity.variants.${index} must be an object`);
    expectEqual(failures, variant.passed, true, `prior sensitivity variant ${index}`);
    expectEqual(failures, variant.kind, pinnedPriorVariants[index]?.kind, `prior sensitivity variant ${index} kind`);
    expectDeepEqual(failures, variant.prior, pinnedPriorVariants[index]?.prior, `prior sensitivity variant ${index} weights`);
    const cases = numberAt(report, `priorSensitivity.variants.${index}.cases`, { integer: true });
    const knownCases = numberAt(report, `priorSensitivity.variants.${index}.knownCases`, { integer: true });
    const unknownCases = numberAt(report, `priorSensitivity.variants.${index}.unknownCases`, { integer: true });
    const incompatibleCount = numberAt(report, `priorSensitivity.variants.${index}.incompatibleNonUnknownCount`, { integer: true });
    const falseAcceptedUnknownCount = numberAt(report, `priorSensitivity.variants.${index}.falseAcceptedUnknownCount`, { integer: true });
    const decisionChangeCount = numberAt(report, `priorSensitivity.variants.${index}.decisionChangeCount`, { integer: true });
    if (cases <= 0 || knownCases < 0 || unknownCases < 0 || incompatibleCount < 0
      || falseAcceptedUnknownCount < 0 || decisionChangeCount < 0) {
      failures.push(`prior sensitivity variant ${index} counts must be non-negative with a positive case denominator`);
    }
    expectEqual(failures, knownCases + unknownCases, cases, `prior sensitivity variant ${index} case partition`);
    expectEqual(
      failures,
      numberAt(report, `priorSensitivity.variants.${index}.priorTotal`),
      Object.values(pinnedPriorVariants[index]?.prior ?? {}).reduce((sum, value) => sum + value, 0),
      `prior sensitivity variant ${index} prior total`,
    );
    expectEqual(
      failures,
      numberAt(report, `priorSensitivity.variants.${index}.incompatibleNonUnknownRisk`),
      incompatibleCount / Math.max(1, cases),
      `prior sensitivity variant ${index} incompatible risk`,
    );
    expectEqual(
      failures,
      numberAt(report, `priorSensitivity.variants.${index}.falseAcceptedUnknownRisk`),
      falseAcceptedUnknownCount / Math.max(1, unknownCases),
      `prior sensitivity variant ${index} false-accepted-unknown risk`,
    );
    expectEqual(
      failures,
      numberAt(report, `priorSensitivity.variants.${index}.decisionChangeRate`),
      decisionChangeCount / Math.max(1, cases),
      `prior sensitivity variant ${index} decision-change rate`,
    );
  }
  const priorCaseCounts = priorVariants.map((_, index) => numberAt(report, `priorSensitivity.variants.${index}.cases`, { integer: true }));
  if (new Set(priorCaseCounts).size !== 1) failures.push('prior sensitivity variants must share one complete case denominator');
  const priorKnownCoverages = priorVariants.map((variant, index) => numberAt(report, `priorSensitivity.variants.${index}.knownCoverage`));
  const priorHierarchicalAccuracies = priorVariants.map((variant, index) => numberAt(report, `priorSensitivity.variants.${index}.hierarchicalAccuracy`));
  const priorIncompatibleRisks = priorVariants.map((variant, index) => numberAt(report, `priorSensitivity.variants.${index}.incompatibleNonUnknownRisk`));
  const priorFalseAcceptedUnknownRisks = priorVariants.map((variant, index) => numberAt(report, `priorSensitivity.variants.${index}.falseAcceptedUnknownRisk`));
  const priorDecisionChangeRates = priorVariants.map((variant, index) => numberAt(report, `priorSensitivity.variants.${index}.decisionChangeRate`));

  for (const [values, label] of [
    [priorKnownCoverages, 'prior known coverage'],
    [priorHierarchicalAccuracies, 'prior hierarchical accuracy'],
    [priorIncompatibleRisks, 'prior incompatible risk'],
    [priorFalseAcceptedUnknownRisks, 'prior false-accepted-unknown risk'],
    [priorDecisionChangeRates, 'prior decision-change rate'],
  ]) for (const value of values) expectRange(failures, value, 0, 1, label);

  const attempts = numberAt(report, 'admission.attempted', { integer: true });
  const admitted = numberAt(report, 'admission.admitted', { integer: true });
  const admissionRate = numberAt(report, 'admission.admissionRate');
  if (attempts <= 0 || admitted < 0 || admitted > attempts) {
    failures.push(`admission counts must satisfy 0 <= admitted <= attempted with a positive denominator; observed ${admitted}/${attempts}`);
  }
  expectRange(failures, admissionRate, 0, 1, 'admission rate');
  if (attempts > 0) expectEqual(failures, admissionRate, admitted / attempts, 'admission rate recomputation');

  return {
    attempts,
    admitted,
    admissionRate,
    representatives,
    properScoreSamples: numberAt(
      report,
      'classificationConditionalOnAdmission.singletonAllowedTruthProperScoreSamples',
      { integer: true },
    ),
    hierarchicalAccuracy: numberAt(report, 'classificationConditionalOnAdmission.hierarchicalAccuracy'),
    knownTopLeafAccuracy: numberAt(report, 'classificationConditionalOnAdmission.knownTopLeafAccuracy'),
    knownCoverage: numberAt(report, 'classificationConditionalOnAdmission.knownCoverage'),
    coveredKnownHierarchicalAccuracy: numberAt(
      report,
      'classificationConditionalOnAdmission.coveredKnownHierarchicalAccuracy',
    ),
    minimumHighSnrKnownClassHierarchicalAccuracy: numberAt(
      report,
      'classificationConditionalOnAdmission.minimumHighSnrKnownClassHierarchicalAccuracy',
    ),
    fittedUnknownTemplateRejectionRate: numberAt(
      report,
      'classificationConditionalOnAdmission.fittedUnknownTemplateRejectionRate',
    ),
    fittedUnknownPosteriorAuroc: numberAt(
      report,
      'classificationConditionalOnAdmission.fittedUnknownPosteriorAuroc',
    ),
    strictUnknownRejectionRate: numberAt(
      report,
      'classificationConditionalOnAdmission.scenarioExcludedStrictUnknownRejectionRate',
    ),
    strictTypicalityAuroc: numberAt(
      report,
      'classificationConditionalOnAdmission.scenarioExcludedStrictTypicalityAuroc',
    ),
    exactEquivalenceCompatibleRate: numberAt(
      report,
      'classificationConditionalOnAdmission.exactEquivalenceCompatibleRate',
    ),
    fittedTemplateLogLoss: numberAt(report, 'classificationConditionalOnAdmission.fittedTemplateLogLoss'),
    fittedTemplateMulticlassBrier: numberAt(
      report,
      'classificationConditionalOnAdmission.fittedTemplateMulticlassBrier',
    ),
    fittedTemplateExpectedCalibrationError: numberAt(
      report,
      'classificationConditionalOnAdmission.fittedTemplateExpectedCalibrationError',
    ),
    falseAcceptedUnknownCount: numberAt(
      report,
      'classificationConditionalOnAdmission.falseAcceptedUnknownCount',
      { integer: true },
    ),
    falseAcceptAttemptCount: numberAt(
      report,
      'classificationConditionalOnAdmission.anyFalseAcceptAttemptCount',
      { integer: true },
    ),
    tolerance: numberAt(report, 'corpus.exactObservableEquivalencePairAudit.numericalTolerance'),
    nuisanceCells,
    representativePairs,
    evidenceViewPairs,
    discrepancies: reportedDiscrepancies,
    exactEquivalencePairs: pairs.length,
    nuisanceSeeds,
    snrDb,
    rbwDivisors,
    classificationAdmissions: numberAt(report, 'matrix.classificationAdmissions', { integer: true }),
    standardObservationHorizon: numberAt(
      report,
      'matrix.observationOpportunityHorizons.standard',
      { integer: true },
    ),
    fullBandObservationHorizon: numberAt(
      report,
      'matrix.observationOpportunityHorizons.fullBand2g4',
      { integer: true },
    ),
    strictUnknownHoldouts,
    ambiguityStressCases,
    knownAcquisitionValidationCases,
    ble24Covered,
    ble24Total,
    ble32Covered,
    ble32Total,
    bleRepresentatives,
    rollingCases,
    rollingKnownCoverage,
    rollingHierarchicalAccuracy,
    rollingIncompatibleNonUnknownCount,
    rollingMinimumScenarioKnownCoverage,
    rollingMinimumScenarioHierarchicalAccuracy,
    tailCalibrationAttemptCount,
    tailCalibrationLateMinimumCount,
    tailScoreComparisons: tailScoreComparisons.length,
    priorVariantCount: priorVariants.length,
    minimumPriorKnownCoverage: Math.min(...priorKnownCoverages),
    maximumPriorKnownCoverage: Math.max(...priorKnownCoverages),
    minimumPriorHierarchicalAccuracy: Math.min(...priorHierarchicalAccuracies),
    maximumPriorHierarchicalAccuracy: Math.max(...priorHierarchicalAccuracies),
    maximumPriorIncompatibleRisk: Math.max(...priorIncompatibleRisks),
    maximumPriorFalseAcceptedUnknownRisk: Math.max(...priorFalseAcceptedUnknownRisks),
    maximumPriorDecisionChangeRate: Math.max(...priorDecisionChangeRates),
  };
}

function formatMetrics(metrics, failures) {
  for (const key of [
    'admissionRate',
    'hierarchicalAccuracy',
    'knownTopLeafAccuracy',
    'knownCoverage',
    'coveredKnownHierarchicalAccuracy',
    'minimumHighSnrKnownClassHierarchicalAccuracy',
    'fittedUnknownTemplateRejectionRate',
    'fittedUnknownPosteriorAuroc',
    'strictUnknownRejectionRate',
    'strictTypicalityAuroc',
    'exactEquivalenceCompatibleRate',
    'fittedTemplateExpectedCalibrationError',
  ]) expectRange(failures, metrics[key], 0, 1, key);
  expectRange(failures, metrics.fittedTemplateMulticlassBrier, 0, 2, 'fittedTemplateMulticlassBrier');
  if (metrics.fittedTemplateLogLoss < 0) failures.push('fitted-template log loss must be non-negative');
  if (metrics.tolerance <= 0) failures.push('exact-equivalence numerical tolerance must be positive');
  for (const key of [
    'attempts', 'admitted', 'representatives', 'properScoreSamples', 'falseAcceptedUnknownCount',
    'falseAcceptAttemptCount', 'nuisanceCells', 'representativePairs', 'evidenceViewPairs',
    'discrepancies', 'exactEquivalencePairs', 'ble24Covered', 'ble24Total', 'ble32Covered',
    'ble32Total', 'bleRepresentatives', 'rollingCases', 'rollingIncompatibleNonUnknownCount',
    'tailCalibrationAttemptCount', 'tailCalibrationLateMinimumCount', 'tailScoreComparisons',
    'priorVariantCount',
  ]) {
    if (!Number.isInteger(metrics[key]) || metrics[key] < 0) failures.push(`${key} must be a non-negative integer`);
  }
  for (const key of ['attempts', 'representatives', 'properScoreSamples', 'nuisanceCells', 'exactEquivalencePairs']) {
    if (metrics[key] <= 0) failures.push(`${key} must be positive`);
  }

  const formatted = {
    attempts: formatInteger(metrics.attempts),
    admitted: formatInteger(metrics.admitted),
    admissionRate: formatFixed(metrics.admissionRate, 6),
    representatives: formatInteger(metrics.representatives),
    properScoreSamples: formatInteger(metrics.properScoreSamples),
    hierarchicalAccuracy: formatFixed(metrics.hierarchicalAccuracy, 6),
    knownTopLeafAccuracy: formatFixed(metrics.knownTopLeafAccuracy, 6),
    knownCoverage: formatFixed(metrics.knownCoverage, 6),
    coveredKnownHierarchicalAccuracy: formatFixed(metrics.coveredKnownHierarchicalAccuracy, 6),
    minimumHighSnrKnownClassHierarchicalAccuracy: formatFixed(
      metrics.minimumHighSnrKnownClassHierarchicalAccuracy,
      4,
    ),
    fittedUnknownTemplateRejectionRate: formatFixed(metrics.fittedUnknownTemplateRejectionRate, 6),
    fittedUnknownPosteriorAuroc: formatFixed(metrics.fittedUnknownPosteriorAuroc, 6),
    strictUnknownRejectionRate: formatFixed(metrics.strictUnknownRejectionRate, 6),
    strictTypicalityAuroc: formatFixed(metrics.strictTypicalityAuroc, 6),
    exactEquivalenceCompatibleRate: formatFixed(metrics.exactEquivalenceCompatibleRate, 6),
    fittedTemplateLogLoss: formatFixed(metrics.fittedTemplateLogLoss, 7),
    fittedTemplateMulticlassBrier: formatFixed(metrics.fittedTemplateMulticlassBrier, 8),
    fittedTemplateExpectedCalibrationError: formatFixed(metrics.fittedTemplateExpectedCalibrationError, 8),
    tolerance: formatScientific(metrics.tolerance),
    nuisanceCells: formatInteger(metrics.nuisanceCells),
    representativePairs: formatInteger(metrics.representativePairs),
    evidenceViewPairs: formatInteger(metrics.evidenceViewPairs),
    bleRepresentatives: formatInteger(metrics.bleRepresentatives),
    rollingCases: formatInteger(metrics.rollingCases),
    rollingKnownCoverage: formatFixed(metrics.rollingKnownCoverage, 6),
    rollingHierarchicalAccuracy: formatFixed(metrics.rollingHierarchicalAccuracy, 6),
    rollingMinimumScenarioKnownCoverage: formatFixed(metrics.rollingMinimumScenarioKnownCoverage, 6),
    rollingMinimumScenarioHierarchicalAccuracy: formatFixed(
      metrics.rollingMinimumScenarioHierarchicalAccuracy,
      6,
    ),
    tailCalibrationAttemptCount: formatInteger(metrics.tailCalibrationAttemptCount),
    tailCalibrationLateMinimumCount: formatInteger(metrics.tailCalibrationLateMinimumCount),
    priorVariantCount: formatInteger(metrics.priorVariantCount),
    minimumPriorKnownCoverage: formatFixed(metrics.minimumPriorKnownCoverage, 6),
    maximumPriorKnownCoverage: formatFixed(metrics.maximumPriorKnownCoverage, 6),
    minimumPriorHierarchicalAccuracy: formatFixed(metrics.minimumPriorHierarchicalAccuracy, 6),
    maximumPriorHierarchicalAccuracy: formatFixed(metrics.maximumPriorHierarchicalAccuracy, 6),
    maximumPriorIncompatibleRisk: formatFixed(metrics.maximumPriorIncompatibleRisk, 6),
    maximumPriorFalseAcceptedUnknownRisk: formatFixed(metrics.maximumPriorFalseAcceptedUnknownRisk, 6),
    maximumPriorDecisionChangeRate: formatFixed(metrics.maximumPriorDecisionChangeRate, 6),
  };

  expectEqual(
    failures,
    metrics.fittedUnknownTemplateRejectionRate,
    metrics.strictUnknownRejectionRate,
    'README/UI combined fitted-unknown and strict-holdout rejection publication',
  );
  expectEqual(
    failures,
    metrics.fittedUnknownPosteriorAuroc,
    metrics.fittedUnknownTemplateRejectionRate,
    'normative-doc combined fitted-unknown AUROC and rejection publication',
  );
  expectEqual(failures, metrics.falseAcceptedUnknownCount, 0, 'published unknown false-accept count');
  expectEqual(failures, metrics.falseAcceptAttemptCount, 0, 'published disallowed false-accept attempt count');
  expectEqual(failures, metrics.discrepancies, 0, 'published exact-equivalence discrepancy count');
  return formatted;
}

function verifyPublicationProse(documents, modelSha256, corpusSha256, metrics, formatted, failures) {
  for (const path of PUBLICATION_PATHS) {
    const text = documents.get(path);
    for (const [staleValue, label] of STALE_PUBLICATION_VALUES) {
      if (text.includes(staleValue)) failures.push(`${path} contains ${label}: ${staleValue}`);
    }
    for (const [id, pattern, label] of [
      [PINNED_MODEL_ID, /bayesian-observable-equivalence-v\d+/g, 'model ID'],
      [PINNED_PREPROCESSING_ID, /scalar-observable-features-v\d+/g, 'preprocessing ID'],
      [PINNED_PRIOR_ID, /engineering-design-class-weights-v\d+/g, 'prior ID'],
      [PINNED_CALIBRATION_ID, /synthetic-view-matched-stratified-online-attempt-min-support-rank-detector-conditioned-physical-uncalibrated-v\d+/g, 'calibration ID'],
      [PINNED_DECISION_POLICY_ID, /observable-open-set-decision-v\d+/g, 'decision-policy ID'],
    ]) {
      const matches = [...text.matchAll(pattern)].map((match) => match[0]);
      if (!matches.includes(id)) failures.push(`${path} must publish current ${label} ${id}`);
      if (matches.some((value) => value !== id)) {
        failures.push(`${path} contains stale ${label} values: ${matches.join(', ')}`);
      }
    }
    const hashCount = occurrenceCount(text, modelSha256);
    if (hashCount !== 1) {
      failures.push(`${path} must publish model asset SHA-256 ${modelSha256} exactly once (found ${hashCount})`);
    }
    const commitCount = occurrenceCount(text, PINNED_SIGNAL_LAB_COMMIT);
    if (commitCount !== 1) {
      failures.push(`${path} must publish SignalLab source commit ${PINNED_SIGNAL_LAB_COMMIT} exactly once (found ${commitCount})`);
    }
    const corpusHashCount = occurrenceCount(text, corpusSha256);
    if (corpusHashCount !== 1) {
      failures.push(`${path} must publish corpus source-manifest SHA-256 ${corpusSha256} exactly once (found ${corpusHashCount})`);
    }
    const corpusVersionCount = occurrenceCount(text, PINNED_CORPUS_VERSION);
    if (corpusVersionCount < 1) {
      failures.push(`${path} must publish corpus version ${PINNED_CORPUS_VERSION}`);
    }
    const publishedCorpusVersions = [...text.matchAll(/observable-scalar-corpus-v\d+/g)]
      .map((match) => match[0]);
    if (publishedCorpusVersions.some((version) => version !== PINNED_CORPUS_VERSION)) {
      failures.push(`${path} contains stale corpus versions: ${publishedCorpusVersions.join(', ')}`);
    }
  }

  const seedList = formatOxford(metrics.nuisanceSeeds.map(String));
  const codeSeedList = formatOxford(metrics.nuisanceSeeds.map((seed) => `\`${seed}\``));
  const snrList = metrics.snrDb.join('/');
  const rbwList = metrics.rbwDivisors.join('/');
  const seedCountWord = numberWord(metrics.nuisanceSeeds.length);
  const rbwCountWord = numberWord(metrics.rbwDivisors.length);
  const pairCountWord = numberWord(metrics.exactEquivalencePairs);
  const strictHoldoutCountWord = numberWord(metrics.strictUnknownHoldouts);
  const ambiguityCountWord = numberWord(metrics.ambiguityStressCases);
  const classificationAdmissionCountWord = numberWord(metrics.classificationAdmissions);
  const bleCoverage = `${metrics.ble24Covered}/${metrics.ble24Total}`;
  const ble32Coverage = `${metrics.ble32Covered}/${metrics.ble32Total}`;
  const rollingSummary = `The complete-denominator all-online high-SNR spectrum-only regression classified ${formatted.rollingCases} unique current-qualified attempt/opportunity/representative windows across every fitted known scenario without a truth-conditioned filter: known coverage was ${formatted.rollingKnownCoverage}, hierarchical accuracy ${formatted.rollingHierarchicalAccuracy}, minimum per-scenario known coverage ${formatted.rollingMinimumScenarioKnownCoverage}, minimum per-scenario hierarchical accuracy ${formatted.rollingMinimumScenarioHierarchicalAccuracy}, and incompatible non-unknown decisions zero.`;
  const priorSummary = `The deterministic engineering-prior sensitivity audit evaluated ${formatted.priorVariantCount} declared baseline, unknown-mass, and family-mass variants: known coverage ranged ${formatted.minimumPriorKnownCoverage}-${formatted.maximumPriorKnownCoverage}, hierarchical accuracy ${formatted.minimumPriorHierarchicalAccuracy}-${formatted.maximumPriorHierarchicalAccuracy}, maximum incompatible-non-unknown risk was ${formatted.maximumPriorIncompatibleRisk}, maximum false-accepted-unknown risk ${formatted.maximumPriorFalseAcceptedUnknownRisk}, and maximum decision-change rate ${formatted.maximumPriorDecisionChangeRate}. These priors are engineering assumptions, not field-prevalence calibration; operational prevalence remains an unmeasured physical-validation limitation.`;
  const tailSummary = `The validator independently regenerated ${formatted.tailCalibrationAttemptCount} observation-domain-eligible all-online calibration attempts and matched all ${metrics.tailScoreComparisons} class/view score arrays to the checked-in asset within the declared tolerance; ${formatted.tailCalibrationLateMinimumCount} view-attempt minima occurred after the first-ready opportunity, proving that later online representatives affect the stored attempt minimum.`;
  const productionAcquisitionSummary = `The fitted and independently regenerated tail-calibration matrix includes SignalLab's 450-point recommended-span grid under the contiguous-zero, post-eight-capture-skip, and full-matrix offset-225 source-clock schedules. Public detected-power synthesis uses the generator-internal 100 kHz filter; measured detected-power RBW remains unavailable and is never classifier evidence.`;
  const modelStructureSummary = `The checked-in model has ${PINNED_DIMENSIONS.length} ordered feature dimensions, ${PINNED_CLASS_IDS.length} exact leaf class IDs, and ${PINNED_COMPONENT_COUNT} Student-t components; deterministic training retained ${formatInteger(PINNED_FITTING_REPRESENTATIVE_COUNT)} observation-domain-eligible first-ready representatives under ${PINNED_REPRESENTATIVE_ELIGIBILITY_POLICY}.`;
  const decisionThresholdSummary = `The open-set rejection cutoff is a minimum maximum-known synthetic support rank of ${PINNED_MINIMUM_KNOWN_SYNTHETIC_SUPPORT_RANK}; it is an engineering threshold, not a p-value or coverage guarantee.`;
  for (const path of PUBLICATION_PATHS) {
    expectExactlyOnce(failures, path, documents.get(path), rollingSummary, 'rolling-window-summary');
    expectExactlyOnce(failures, path, documents.get(path), priorSummary, 'prior-sensitivity-summary');
    expectExactlyOnce(failures, path, documents.get(path), tailSummary, 'tail-calibration-recomputation-summary');
    expectExactlyOnce(failures, path, documents.get(path), productionAcquisitionSummary, 'production-acquisition-summary');
    expectExactlyOnce(failures, path, documents.get(path), modelStructureSummary, 'model-structure-summary');
    expectExactlyOnce(failures, path, documents.get(path), decisionThresholdSummary, 'decision-threshold-summary');
  }

  expectExactlyOnce(
    failures,
    'README.md',
    documents.get('README.md'),
    `The final ${seedCountWord}-seed, ${rbwCountWord}-interstitial-RBW regression ran ${formatted.attempts} acquisition attempts and classified ${formatted.representatives} first-ready representatives: hierarchical accuracy was ${formatted.hierarchicalAccuracy}, known coverage ${formatted.knownCoverage}, covered-known hierarchical accuracy ${formatted.coveredKnownHierarchicalAccuracy}, fitted-unknown and strict-holdout rejection ${formatted.fittedUnknownTemplateRejectionRate}, and there were zero disallowed false-accept attempts. All ${formatted.nuisanceCells} exact-equivalence nuisance cells, ${formatted.representativePairs} representative pairs, and ${formatted.evidenceViewPairs} evidence-view pairs matched within \`${formatted.tolerance}\` with zero discrepancies.`,
    'validation-summary',
  );
  expectExactlyOnce(
    failures,
    'README.md',
    documents.get('README.md'),
    `On the final held-out event-phase seeds, BLE acquired at one or more tested RBWs for ${bleCoverage} seeds at 24 dB and ${ble32Coverage} at 32 dB; all ${formatted.bleRepresentatives} admitted BLE representatives resolved only to Bluetooth-like band activity.`,
    'BLE-summary',
  );

  const researchPath = 'docs/BAYESIAN_DETECTION_CLASSIFICATION_RESEARCH.md';
  expectExactlyOnce(
    failures,
    researchPath,
    documents.get(researchPath),
    `The final regression matrix uses held-out nuisance seeds ${seedList}; SNR ${snrList} dB; and interstitial RBW divisors ${rbwList} rather than a fitted or support-calibration grid point. It audits the fitted unknowns, ${strictHoldoutCountWord} strict unknown ${pluralize(metrics.strictUnknownHoldouts, 'holdout')}, ${ambiguityCountWord} ambiguity-only ${pluralize(metrics.ambiguityStressCases, 'case')}, ${pairCountWord} exact-equivalence ${pluralize(metrics.exactEquivalencePairs, 'pair')}, and the acquisition-only one-timeslot GSM case separately.`,
    'validation-matrix',
  );
  expectExactlyOnce(
    failures,
    researchPath,
    documents.get(researchPath),
    `The run covered ${formatted.attempts} acquisition attempts, admitted ${formatted.admitted} (${formatted.admissionRate}), and produced ${formatted.representatives} unique first-ready representatives. Conditional hierarchical accuracy was ${formatted.hierarchicalAccuracy}, known coverage ${formatted.knownCoverage}, covered-known hierarchical accuracy ${formatted.coveredKnownHierarchicalAccuracy}, known top-leaf accuracy ${formatted.knownTopLeafAccuracy}, and minimum high-SNR known-class hierarchical accuracy ${formatted.minimumHighSnrKnownClassHierarchicalAccuracy}. On ${formatted.properScoreSamples} singleton-truth, observation-domain-eligible proper-score samples, fitted-template log loss was ${formatted.fittedTemplateLogLoss}, multiclass Brier score ${formatted.fittedTemplateMulticlassBrier}, and expected calibration error ${formatted.fittedTemplateExpectedCalibrationError}. Fitted-unknown AUROC and rejection were ${formatted.fittedUnknownPosteriorAuroc}; scenario-excluded strict-typicality AUROC was ${formatted.strictTypicalityAuroc} and admitted strict-holdout rejection was ${formatted.strictUnknownRejectionRate}.`,
    'validation-metrics',
  );
  expectExactlyOnce(
    failures,
    researchPath,
    documents.get(researchPath),
    `The exact-pair audit covered ${formatted.nuisanceCells} nuisance cells, ${formatted.representativePairs} representative pairs, and ${formatted.evidenceViewPairs} evidence-view pairs with zero discrepancies at \`${formatted.tolerance}\` tolerance. Compatibility was ${formatted.exactEquivalenceCompatibleRate}, with zero unknown false accepts and zero disallowed false-accept attempts. BLE high-SNR acquisition covered ${bleCoverage} independent seeds at 24 dB and ${ble32Coverage} at 32 dB at one or more held-out RBWs.`,
    'equivalence-and-BLE-metrics',
  );
  expectExactlyOnce(
    failures,
    researchPath,
    documents.get(researchPath),
    `Across the final ${seedCountWord} held-out event-phase seeds and ${rbwCountWord} interstitial RBWs, at least one RBW acquired BLE in ${bleCoverage} seeds at 24 dB and ${ble32Coverage} at 32 dB; all ${formatted.bleRepresentatives} admitted BLE first-ready representatives returned only Bluetooth-like band activity.`,
    'BLE-detail',
  );

  const emsoPath = 'docs/SIGNALLAB_EMSO_CLASSIFIER_CONTRACT.md';
  expectExactlyOnce(
    failures,
    emsoPath,
    documents.get(emsoPath),
    `The held-out nuisance-shift validator uses unseen seeds ${codeSeedList}; SNR values ${snrList} dB; interstitial RBW divisors ${rbwList}; standard ${metrics.standardObservationHorizon}- and full-band 2.4 GHz ${metrics.fullBandObservationHorizon}-opportunity horizons; and an exact ${classificationAdmissionCountWord}-admission classification window.`,
    'validation-matrix',
  );
  expectExactlyOnce(
    failures,
    emsoPath,
    documents.get(emsoPath),
    `The final regression ran ${formatted.attempts} acquisition attempts. It admitted ${formatted.admitted} attempts (${formatted.admissionRate}) and produced ${formatted.representatives} unique first-ready representatives. Conditional hierarchical accuracy was ${formatted.hierarchicalAccuracy}, known coverage ${formatted.knownCoverage}, covered-known hierarchical accuracy ${formatted.coveredKnownHierarchicalAccuracy}, known top-leaf accuracy ${formatted.knownTopLeafAccuracy}, and the minimum high-SNR known-class hierarchical accuracy was ${formatted.minimumHighSnrKnownClassHierarchicalAccuracy}. On ${formatted.properScoreSamples} singleton-truth proper-score samples, fitted-template log loss was ${formatted.fittedTemplateLogLoss}, multiclass Brier score ${formatted.fittedTemplateMulticlassBrier}, and ECE ${formatted.fittedTemplateExpectedCalibrationError}. Fitted-unknown AUROC and rejection were both ${formatted.fittedUnknownPosteriorAuroc}; scenario-excluded strict-typicality AUROC was ${formatted.strictTypicalityAuroc} and admitted strict-holdout rejection was ${formatted.strictUnknownRejectionRate}.`,
    'validation-metrics',
  );
  expectExactlyOnce(
    failures,
    emsoPath,
    documents.get(emsoPath),
    `All ${formatted.nuisanceCells} exact-equivalence nuisance cells yielded ${formatted.representativePairs} matched representative pairs and ${formatted.evidenceViewPairs} matched evidence-view pairs with zero discrepancies at \`${formatted.tolerance}\` tolerance. Exact-equivalence compatibility was ${formatted.exactEquivalenceCompatibleRate}, and both the unknown false-accept count and disallowed false-accept attempt count were zero.`,
    'equivalence-metrics',
  );
  expectExactlyOnce(
    failures,
    emsoPath,
    documents.get(emsoPath),
    `Across the final ${seedCountWord} held-out event-phase seeds and ${rbwCountWord} interstitial RBWs, BLE acquired at one or more RBWs for ${bleCoverage} seeds at 24 dB and ${ble32Coverage} at 32 dB. All ${formatted.bleRepresentatives} admitted BLE first-ready representatives returned Bluetooth-like band activity.`,
    'BLE-detail',
  );

  const uiPath = 'docs/UI_UX_CONTRACTS.md';
  expectExactlyOnce(
    failures,
    uiPath,
    documents.get(uiPath),
    `The final development regression uses held-out seeds ${seedList} and interstitial RBW divisors ${rbwList}. It covers ${formatted.attempts} attempts and ${formatted.representatives} first-ready representatives. Hierarchical accuracy is ${formatted.hierarchicalAccuracy}, known coverage ${formatted.knownCoverage}, covered-known hierarchical accuracy ${formatted.coveredKnownHierarchicalAccuracy}, fitted-unknown and strict-holdout rejection ${formatted.fittedUnknownTemplateRejectionRate}, and disallowed false-accept attempts zero. All ${formatted.nuisanceCells} exact-equivalence cells, ${formatted.representativePairs} representative pairs, and ${formatted.evidenceViewPairs} evidence-view pairs match within \`${formatted.tolerance}\` with zero discrepancies.`,
    'validation-summary',
  );
  expectExactlyOnce(
    failures,
    uiPath,
    documents.get(uiPath),
    `The final held-out synthetic run acquired BLE at one or more tested RBWs for ${bleCoverage} event-phase seeds at 24 dB and ${ble32Coverage} at 32 dB; all ${formatted.bleRepresentatives} admitted BLE representatives returned only Bluetooth-like band activity.`,
    'BLE-summary',
  );
}

async function main() {
  const paths = [MODEL_PATH, MANIFEST_PATH, REPORT_PATH, ...PUBLICATION_PATHS];
  const contents = await Promise.all(paths.map((path) => readFile(resolve(REPOSITORY_ROOT, path))));
  const byPath = new Map(paths.map((path, index) => [path, contents[index]]));
  const modelSha256 = createHash('sha256').update(byPath.get(MODEL_PATH)).digest('hex');
  const generatedModel = parseGeneratedModel(byPath.get(MODEL_PATH).toString('utf8'));
  const manifest = byPath.get(MANIFEST_PATH).toString('utf8');
  const manifestMatches = [...manifest.matchAll(/BAYESIAN_OBSERVABLE_MODEL_SHA256 = '([a-f0-9]{64})'/g)];
  if (manifestMatches.length !== 1) {
    throw new Error(`${MANIFEST_PATH} must contain exactly one classifier model SHA-256 declaration`);
  }
  const manifestSha256 = manifestMatches[0][1];

  let report;
  try {
    report = JSON.parse(byPath.get(REPORT_PATH).toString('utf8'));
  } catch (error) {
    throw new Error(`${REPORT_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const failures = [];
  const { validationAcceptance, ...reportEvidence } = report;
  if (validationAcceptance === null || typeof validationAcceptance !== 'object'
    || Array.isArray(validationAcceptance)) {
    throw new Error(`${REPORT_PATH} validationAcceptance must be an object`);
  }
  expectEqual(failures, validationAcceptance.schemaVersion, 1, 'validator acceptance schema');
  expectEqual(failures, valueAt(report, 'validationAcceptance.status'), 'passed', 'validator acceptance status');
  expectEqual(failures, validationAcceptance.acceptancePolicyId, PINNED_ACCEPTANCE_POLICY_ID, 'validator acceptance policy');
  expectEqual(failures, validationAcceptance.scope, 'full-corpus', 'validator acceptance scope');
  expectEqual(failures, validationAcceptance.failureCount, 0, 'validator acceptance failure count field');
  expectEqual(failures, arrayAt(report, 'validationAcceptance.failures').length, 0, 'validator acceptance failure count');
  expectEqual(
    failures,
    validationAcceptance.evidenceSha256,
    createHash('sha256').update(JSON.stringify(reportEvidence)).digest('hex'),
    'validator acceptance evidence SHA-256',
  );
  expectEqual(failures, valueAt(report, 'corpus.version'), PINNED_CORPUS_VERSION, 'classifier corpus version');
  expectEqual(failures, valueAt(report, 'model.id'), PINNED_MODEL_ID, 'classifier model ID');
  expectEqual(failures, valueAt(report, 'model.preprocessing'), PINNED_PREPROCESSING_ID, 'classifier preprocessing ID');
  expectEqual(failures, valueAt(report, 'model.priorId'), PINNED_PRIOR_ID, 'classifier prior ID');
  expectEqual(failures, valueAt(report, 'model.calibrationId'), PINNED_CALIBRATION_ID, 'classifier calibration ID');
  expectEqual(failures, valueAt(report, 'model.decisionPolicyId'), PINNED_DECISION_POLICY_ID, 'classifier decision-policy ID');
  expectEqual(failures, numberAt(report, 'model.classCount', { integer: true }), 12, 'classifier class count');
  expectEqual(failures, generatedModel.id, PINNED_MODEL_ID, 'generated classifier model ID');
  expectEqual(failures, generatedModel.corpusVersion, PINNED_CORPUS_VERSION, 'generated classifier corpus version');
  expectEqual(failures, generatedModel.sourceCommit, PINNED_SIGNAL_LAB_COMMIT, 'generated classifier source commit');
  expectEqual(failures, generatedModel.preprocessing, PINNED_PREPROCESSING_ID, 'generated classifier preprocessing ID');
  expectEqual(failures, generatedModel.priorId, PINNED_PRIOR_ID, 'generated classifier prior ID');
  expectEqual(failures, generatedModel.calibrationId, PINNED_CALIBRATION_ID, 'generated classifier calibration ID');
  expectEqual(failures, Array.isArray(generatedModel.classModels) ? generatedModel.classModels.length : -1, 12, 'generated classifier class count');
  expectDeepEqual(failures, generatedModel.dimensions, PINNED_DIMENSIONS, 'generated classifier ordered dimensions');
  const generatedClassIds = Array.isArray(generatedModel.classModels)
    ? generatedModel.classModels.map((model) => model.id)
    : [];
  expectDeepEqual(failures, generatedClassIds, PINNED_CLASS_IDS, 'generated classifier class IDs and order');
  for (const [index, model] of generatedModel.classModels.entries()) {
    expectEqual(
      failures,
      model.logPrior,
      Math.log(PINNED_ENGINEERING_PRIOR[model.id]),
      `generated classifier class ${index} log prior`,
    );
  }
  const generatedComponents = Array.isArray(generatedModel.classModels)
    ? generatedModel.classModels.flatMap((model) => Array.isArray(model.components) ? model.components : [])
    : [];
  expectEqual(failures, generatedComponents.length, PINNED_COMPONENT_COUNT, 'generated classifier component count');
  for (const [index, component] of generatedComponents.entries()) {
    expectDeepEqual(failures, component.dimensions, PINNED_DIMENSIONS, `generated classifier component ${index} dimensions`);
  }
  expectEqual(
    failures,
    generatedModel.trainingMatrix?.representativeEligibilityPolicy,
    PINNED_REPRESENTATIVE_ELIGIBILITY_POLICY,
    'generated representative eligibility policy',
  );
  expectEqual(
    failures,
    valueAt(report, 'model.minimumKnownSyntheticSupportRank'),
    PINNED_MINIMUM_KNOWN_SYNTHETIC_SUPPORT_RANK,
    'classifier minimum known synthetic support rank',
  );
  for (const [field, expected] of [
    ['modelAssetSha256', modelSha256],
    ['modelId', generatedModel.id],
    ['sourceCommit', generatedModel.sourceCommit],
    ['corpusVersion', generatedModel.corpusVersion],
    ['corpusSha256', generatedModel.corpusSha256],
    ['preprocessing', generatedModel.preprocessing],
    ['priorId', generatedModel.priorId],
    ['calibrationId', generatedModel.calibrationId],
    ['decisionPolicyId', PINNED_DECISION_POLICY_ID],
  ]) {
    expectEqual(failures, validationAcceptance[field], expected, `validator acceptance ${field}`);
  }
  expectDeepEqual(
    failures,
    generatedModel.trainingMatrix?.signalLabProductionAcquisitionRegime,
    PINNED_PRODUCTION_ACQUISITION_REGIME,
    'generated production acquisition regime',
  );
  expectDeepEqual(
    failures,
    generatedModel.trainingMatrix?.detectedPowerSynthesisFilterPolicy,
    PINNED_DETECTED_POWER_SYNTHESIS_FILTER_POLICY,
    'generated detected-power synthesis-filter policy',
  );
  expectDeepEqual(
    failures,
    generatedModel.trainingMatrix?.productionAcquisitionRegimeHighSnrSeedCoveragePolicy,
    PINNED_PRODUCTION_HIGH_SNR_COVERAGE_POLICY,
    'generated production high-SNR coverage policy',
  );
  for (const [key, expected] of [
    ['snrDb', PINNED_TRAINING_SNR_DB],
    ['rbwDivisors', PINNED_TRAINING_RBW_DIVISORS],
    ['seeds', PINNED_FITTING_SEEDS],
    ['tailCalibrationRbwDivisors', PINNED_TRAINING_RBW_DIVISORS],
    ['tailCalibrationSeeds', PINNED_CALIBRATION_SEEDS],
  ]) {
    expectDeepEqual(failures, generatedModel.trainingMatrix?.[key], expected, `generated ${key}`);
  }
  for (const [key, expected] of [
    ['tailCalibrationScoreUnit', PINNED_TAIL_POLICIES.scoreUnit],
    ['tailCalibrationRepresentativeSelectionPolicy', PINNED_TAIL_POLICIES.representativeSelection],
    ['tailCalibrationRepresentativeAggregationPolicy', PINNED_TAIL_POLICIES.representativeAggregation],
    ['tailCalibrationRuntimeInterpretationPolicy', PINNED_TAIL_POLICIES.runtimeInterpretation],
    ['tailCalibrationStatisticalInterpretation', PINNED_TAIL_POLICIES.statisticalInterpretation],
  ]) {
    expectEqual(failures, generatedModel.trainingMatrix?.[key], expected, `generated ${key}`);
  }
  for (const key of ['fittingAcquisitionRegimeIds', 'tailCalibrationAcquisitionRegimeIds']) {
    expectDeepEqual(
      failures,
      generatedModel.trainingMatrix?.[key],
      PINNED_ACQUISITION_REGIME_IDS,
      `generated ${key}`,
    );
  }
  expectEqual(failures, valueAt(report, 'matrix.scenarioSelection.mode'), 'full-corpus', 'validation scenario selection');
  expectEqual(
    failures,
    valueAt(report, 'matrix.representativeEligibilityPolicy'),
    PINNED_REPRESENTATIVE_ELIGIBILITY_POLICY,
    'validation representative eligibility policy',
  );
  expectEqual(failures, booleanAt(report, 'matrix.samplingPartitionAudit.valid'), true, 'sampling-partition audit');
  expectEqual(failures, booleanAt(report, 'matrix.samplingPartitionAudit.validationTemporalPartitionDisjoint'), true, 'validation temporal partition');
  expectEqual(failures, arrayAt(report, 'matrix.samplingPartitionAudit.validationTemporalScheduleIdOverlap').length, 0, 'validation temporal schedule-ID overlap');
  expectEqual(failures, arrayAt(report, 'matrix.samplingPartitionAudit.validationFitTemporalSourceLookIndexOverlap').length, 0, 'validation source-look overlap');
  expectEqual(failures, booleanAt(report, 'matrix.tailCalibrationAudit.valid'), true, 'tail-calibration audit');
  expectEqual(failures, booleanAt(report, 'matrix.tailCalibrationAudit.matrixPinsValid'), true, 'tail-calibration matrix pins');
  expectEqual(failures, booleanAt(report, 'matrix.tailCalibrationAudit.productionAcquisitionRegimePinsValid'), true, 'production-acquisition pins');
  expectDeepEqual(
    failures,
    valueAt(report, 'matrix.tailCalibrationAudit.pinnedSignalLabProductionAcquisitionRegime'),
    PINNED_PRODUCTION_ACQUISITION_REGIME,
    'complete production acquisition regime',
  );
  expectDeepEqual(
    failures,
    valueAt(report, 'matrix.temporalSchedule'),
    PINNED_VALIDATION_TEMPORAL_SCHEDULE,
    'held-out validation temporal schedule',
  );
  const fittedSourceLookIndices = new Set(PINNED_PRODUCTION_TEMPORAL_SCHEDULES.flatMap((schedule) =>
    Array.from({ length: 96 }, (_, opportunity) => sourceLookIndex(schedule, opportunity))));
  const independentlyRecomputedTemporalOverlap = Array.from(
    { length: 96 },
    (_, opportunity) => sourceLookIndex(PINNED_VALIDATION_TEMPORAL_SCHEDULE, opportunity),
  ).filter((lookIndex) => fittedSourceLookIndices.has(lookIndex));
  expectEqual(
    failures,
    independentlyRecomputedTemporalOverlap.length,
    0,
    'independently recomputed fit/validation source-look overlap',
  );
  expectDeepEqual(
    failures,
    valueAt(report, 'matrix.detectedPowerSynthesisFilterPolicy'),
    PINNED_DETECTED_POWER_SYNTHESIS_FILTER_POLICY,
    'detected-power synthesis-filter policy',
  );
  for (const [path, expected] of [
    ['matrix.samplingPartitionAudit.modelFittingSeeds', PINNED_FITTING_SEEDS],
    ['matrix.samplingPartitionAudit.modelCalibrationSeeds', PINNED_CALIBRATION_SEEDS],
    ['matrix.samplingPartitionAudit.validationSeeds', PINNED_VALIDATION_SEEDS],
    ['matrix.samplingPartitionAudit.modelFittingRbwDivisors', PINNED_TRAINING_RBW_DIVISORS],
    ['matrix.samplingPartitionAudit.modelCalibrationRbwDivisors', PINNED_TRAINING_RBW_DIVISORS],
    ['matrix.samplingPartitionAudit.validationRbwDivisors', PINNED_VALIDATION_RBW_DIVISORS],
    ['matrix.tailCalibrationAudit.validatorOwnedMatrix.snrDb', PINNED_TRAINING_SNR_DB],
    ['matrix.tailCalibrationAudit.validatorOwnedMatrix.rbwDivisors', PINNED_TRAINING_RBW_DIVISORS],
    ['matrix.tailCalibrationAudit.validatorOwnedMatrix.seeds', PINNED_CALIBRATION_SEEDS],
  ]) {
    expectDeepEqual(failures, arrayAt(report, path), expected, path);
  }
  for (const [path, expected] of [
    ['matrix.tailCalibrationAudit.pinnedScoreUnit', PINNED_TAIL_POLICIES.scoreUnit],
    ['matrix.tailCalibrationAudit.modelScoreUnit', PINNED_TAIL_POLICIES.scoreUnit],
    ['matrix.tailCalibrationAudit.pinnedRepresentativeSelectionPolicy', PINNED_TAIL_POLICIES.representativeSelection],
    ['matrix.tailCalibrationAudit.modelRepresentativeSelectionPolicy', PINNED_TAIL_POLICIES.representativeSelection],
    ['matrix.tailCalibrationAudit.pinnedRepresentativeAggregationPolicy', PINNED_TAIL_POLICIES.representativeAggregation],
    ['matrix.tailCalibrationAudit.modelRepresentativeAggregationPolicy', PINNED_TAIL_POLICIES.representativeAggregation],
    ['matrix.tailCalibrationAudit.pinnedRuntimeInterpretationPolicy', PINNED_TAIL_POLICIES.runtimeInterpretation],
    ['matrix.tailCalibrationAudit.modelRuntimeInterpretationPolicy', PINNED_TAIL_POLICIES.runtimeInterpretation],
    ['matrix.tailCalibrationAudit.pinnedStatisticalInterpretation', PINNED_TAIL_POLICIES.statisticalInterpretation],
    ['matrix.tailCalibrationAudit.modelStatisticalInterpretation', PINNED_TAIL_POLICIES.statisticalInterpretation],
  ]) {
    expectEqual(failures, valueAt(report, path), expected, path);
  }
  expectEqual(
    failures,
    valueAt(report, 'matrix.tailCalibrationAudit.pinnedSignalLabProductionAcquisitionRegime.geometry.id'),
    PINNED_PRODUCTION_GEOMETRY_ID,
    'production acquisition geometry ID',
  );
  expectDeepEqual(
    failures,
    arrayAt(report, 'matrix.tailCalibrationAudit.pinnedSignalLabProductionAcquisitionRegime.temporalSchedules')
      .map((schedule) => schedule.id),
    PINNED_PRODUCTION_TEMPORAL_SCHEDULE_IDS,
    'production temporal schedule IDs',
  );
  for (const path of [
    'matrix.samplingPartitionAudit.modelFittingAcquisitionRegimeIds',
    'matrix.samplingPartitionAudit.modelCalibrationAcquisitionRegimeIds',
    'matrix.tailCalibrationAudit.validatorOwnedMatrix.acquisitionRegimeIds',
  ]) {
    expectDeepEqual(failures, arrayAt(report, path), PINNED_ACQUISITION_REGIME_IDS, path);
  }
  const recomputedAttemptCounts = valueAt(
    report,
    'matrix.tailCalibrationAudit.independentRecomputation.recomputedAttemptCountsByScenario',
  );
  if (recomputedAttemptCounts === null || typeof recomputedAttemptCounts !== 'object'
    || Array.isArray(recomputedAttemptCounts)) {
    throw new Error(`${REPORT_PATH} recomputed tail-calibration attempt counts must be an object`);
  }
  for (const [scenarioId, count] of Object.entries(recomputedAttemptCounts)) {
    if (!Number.isInteger(count) || count <= 0) {
      failures.push(`recomputed tail-calibration attempt count ${scenarioId} must be a positive integer`);
    }
  }
  expectDeepEqual(
    failures,
    recomputedAttemptCounts,
    generatedModel.trainingMatrix?.tailCalibrationAttemptCountsByScenario,
    'recomputed/model tail-calibration attempt counts',
  );
  expectDeepEqual(
    failures,
    valueAt(report, 'matrix.tailCalibrationAudit.attemptCountsByScenario'),
    generatedModel.trainingMatrix?.tailCalibrationAttemptCountsByScenario,
    'reported/model tail-calibration attempt counts',
  );
  expectEqual(
    failures,
    numberAt(report, 'matrix.tailCalibrationAudit.independentRecomputation.allOnlineAttemptCount', { integer: true }),
    Object.values(recomputedAttemptCounts).reduce((sum, count) => sum + count, 0),
    'all-online tail-calibration attempt count',
  );
  expectEqual(
    failures,
    Object.values(recomputedAttemptCounts).reduce((sum, count) => sum + count, 0),
    PINNED_TAIL_CALIBRATION_ATTEMPT_COUNT,
    'pinned tail-calibration attempt count',
  );
  expectEqual(failures, manifestSha256, modelSha256, 'generated model manifest SHA-256');
  for (const path of [
    'model.modelAssetSha256',
    'integrity.checkedInModelAssetSha256',
    'integrity.modelAssetManifestSha256',
  ]) {
    expectEqual(failures, valueAt(report, path), modelSha256, `${REPORT_PATH} ${path}`);
  }
  expectEqual(failures, valueAt(report, 'model.sourceCommit'), PINNED_SIGNAL_LAB_COMMIT, 'published SignalLab source commit');
  const checkedOutCorpusSourceManifest = valueAt(report, 'integrity.checkedOutCorpusSourceManifest');
  if (checkedOutCorpusSourceManifest === null || typeof checkedOutCorpusSourceManifest !== 'object') {
    throw new Error(`${REPORT_PATH} integrity.checkedOutCorpusSourceManifest must be an object`);
  }
  expectEqual(failures, checkedOutCorpusSourceManifest.schemaVersion, 1, 'corpus source manifest schema version');
  expectEqual(failures, checkedOutCorpusSourceManifest.hashAlgorithm, 'sha256', 'corpus source manifest hash algorithm');
  const sourceArtifacts = arrayAt(report, 'integrity.checkedOutCorpusSourceManifest.artifacts');
  const sourceArtifactPaths = sourceArtifacts.map((artifact, index) => {
    if (artifact === null || typeof artifact !== 'object' || typeof artifact.path !== 'string') {
      throw new Error(`${REPORT_PATH} integrity.checkedOutCorpusSourceManifest.artifacts.${index}.path must be a string`);
    }
    if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error(`${REPORT_PATH} integrity.checkedOutCorpusSourceManifest.artifacts.${index}.sha256 must be SHA-256`);
    }
    return artifact.path;
  });
  expectEqual(
    failures,
    JSON.stringify(sourceArtifactPaths),
    JSON.stringify(PINNED_CORPUS_SOURCE_PATHS),
    'complete corpus source artifact closure',
  );
  const corpusSha256 = createHash('sha256')
    .update(JSON.stringify(checkedOutCorpusSourceManifest))
    .digest('hex');
  expectEqual(failures, corpusSha256, PINNED_CORPUS_SHA256, 'pinned corpus source-manifest SHA-256');
  expectEqual(failures, valueAt(report, 'integrity.checkedOutCorpusSha256'), corpusSha256, 'checked-out corpus source-manifest SHA-256');
  expectEqual(failures, valueAt(report, 'model.corpusSha256'), corpusSha256, 'model corpus source-manifest SHA-256');
  expectDeepEqual(failures, generatedModel.corpusSourceManifest, checkedOutCorpusSourceManifest, 'generated corpus source manifest');
  expectEqual(failures, generatedModel.corpusSha256, corpusSha256, 'generated corpus source-manifest SHA-256');

  const expectedRollingScenarioIds = generatedModel.classModels
    .filter((model) => model.id !== 'unknown-signal')
    .flatMap((model) => model.components.map((component) => component.id));
  const metrics = collectMetrics(report, failures, expectedRollingScenarioIds);
  const formatted = formatMetrics(metrics, failures);
  const documents = new Map(PUBLICATION_PATHS.map((path) => [
    path,
    normalizeProse(visibleMarkdown(byPath.get(path).toString('utf8'))),
  ]));
  for (const path of [
    'docs/BAYESIAN_DETECTION_CLASSIFICATION_RESEARCH.md',
    'docs/SIGNALLAB_EMSO_CLASSIFIER_CONTRACT.md',
  ]) {
    const document = documents.get(path);
    for (const artifact of sourceArtifacts) {
      const hashCount = occurrenceCount(document, artifact.sha256);
      if (hashCount !== 1) {
        failures.push(`${path} must publish ${artifact.path} SHA-256 ${artifact.sha256} exactly once (found ${hashCount})`);
      }
    }
  }
  verifyPublicationProse(documents, modelSha256, corpusSha256, metrics, formatted, failures);

  if (failures.length > 0) {
    throw new Error(`classifier publication is stale or internally inconsistent:\n- ${failures.join('\n- ')}`);
  }

  console.log(JSON.stringify({
    status: 'verified',
    modelAssetSha256: modelSha256,
    report: REPORT_PATH,
    publications: PUBLICATION_PATHS,
    metrics: {
      attempts: metrics.attempts,
      admitted: metrics.admitted,
      representatives: metrics.representatives,
      hierarchicalAccuracy: metrics.hierarchicalAccuracy,
      knownCoverage: metrics.knownCoverage,
      exactEquivalencePairs: metrics.exactEquivalencePairs,
      exactEquivalenceDiscrepancies: metrics.discrepancies,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
