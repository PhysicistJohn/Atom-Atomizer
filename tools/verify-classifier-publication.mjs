#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_PATH = 'packages/analysis/src/models/bayesian-observable-v5.generated.ts';
const MANIFEST_PATH = 'packages/analysis/src/models/bayesian-observable-v5.manifest.generated.ts';
const REPORT_PATH = '.artifacts/classifier-validation/report.json';
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

function normalizeProse(value) {
  return value
    .replace(/([A-Za-z])-\s+([A-Za-z])/g, '$1-$2')
    .replace(/\s+/g, ' ')
    .trim();
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

function sumPairMetric(pairs, key) {
  return pairs.reduce((sum, pair, index) => {
    if (pair === null || typeof pair !== 'object') {
      throw new Error(`${REPORT_PATH} corpus.exactObservableEquivalencePairAudit.pairs.${index} must be an object`);
    }
    const value = pair[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error(
        `${REPORT_PATH} corpus.exactObservableEquivalencePairAudit.pairs.${index}.${key} must be an integer`,
      );
    }
    return sum + value;
  }, 0);
}

function collectMetrics(report, failures) {
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

  return {
    attempts: numberAt(report, 'admission.attempted', { integer: true }),
    admitted: numberAt(report, 'admission.admitted', { integer: true }),
    admissionRate: numberAt(report, 'admission.admissionRate'),
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
  };
}

function formatMetrics(metrics, failures) {
  const formatted = {
    attempts: formatInteger(metrics.attempts),
    admitted: formatInteger(metrics.admitted),
    admissionRate: formatFixed(metrics.admissionRate, 6),
    representatives: formatInteger(metrics.representatives),
    properScoreSamples: formatInteger(metrics.properScoreSamples),
    hierarchicalAccuracy: formatFixed(metrics.hierarchicalAccuracy, 6),
    knownTopLeafAccuracy: formatFixed(metrics.knownTopLeafAccuracy, 6),
    knownCoverage: formatFixed(metrics.knownCoverage, 6),
    coveredKnownHierarchicalAccuracy: formatFixed(metrics.coveredKnownHierarchicalAccuracy, 1),
    minimumHighSnrKnownClassHierarchicalAccuracy: formatFixed(
      metrics.minimumHighSnrKnownClassHierarchicalAccuracy,
      4,
    ),
    fittedUnknownTemplateRejectionRate: formatFixed(metrics.fittedUnknownTemplateRejectionRate, 1),
    fittedUnknownPosteriorAuroc: formatFixed(metrics.fittedUnknownPosteriorAuroc, 1),
    strictUnknownRejectionRate: formatFixed(metrics.strictUnknownRejectionRate, 1),
    strictTypicalityAuroc: formatFixed(metrics.strictTypicalityAuroc, 6),
    exactEquivalenceCompatibleRate: formatFixed(metrics.exactEquivalenceCompatibleRate, 1),
    fittedTemplateLogLoss: formatFixed(metrics.fittedTemplateLogLoss, 7),
    fittedTemplateMulticlassBrier: formatFixed(metrics.fittedTemplateMulticlassBrier, 8),
    fittedTemplateExpectedCalibrationError: formatFixed(metrics.fittedTemplateExpectedCalibrationError, 8),
    tolerance: formatScientific(metrics.tolerance),
    nuisanceCells: formatInteger(metrics.nuisanceCells),
    representativePairs: formatInteger(metrics.representativePairs),
    evidenceViewPairs: formatInteger(metrics.evidenceViewPairs),
    bleRepresentatives: formatInteger(metrics.bleRepresentatives),
  };

  expectEqual(
    failures,
    formatted.fittedUnknownTemplateRejectionRate,
    formatted.strictUnknownRejectionRate,
    'README/UI combined fitted-unknown and strict-holdout rejection publication',
  );
  expectEqual(
    failures,
    formatted.fittedUnknownPosteriorAuroc,
    formatted.fittedUnknownTemplateRejectionRate,
    'normative-doc combined fitted-unknown AUROC and rejection publication',
  );
  expectEqual(failures, metrics.falseAcceptedUnknownCount, 0, 'published unknown false-accept count');
  expectEqual(failures, metrics.falseAcceptAttemptCount, 0, 'published disallowed false-accept attempt count');
  expectEqual(failures, metrics.discrepancies, 0, 'published exact-equivalence discrepancy count');
  return formatted;
}

function verifyPublicationProse(documents, modelSha256, metrics, formatted, failures) {
  for (const path of PUBLICATION_PATHS) {
    const text = documents.get(path);
    const hashCount = occurrenceCount(text, modelSha256);
    if (hashCount !== 1) {
      failures.push(`${path} must publish model asset SHA-256 ${modelSha256} exactly once (found ${hashCount})`);
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
    `The run covered ${formatted.attempts} acquisition attempts, admitted ${formatted.admitted} (${formatted.admissionRate}), and produced ${formatted.representatives} unique first-ready representatives. Conditional hierarchical accuracy was ${formatted.hierarchicalAccuracy}, known coverage ${formatted.knownCoverage}, covered-known hierarchical accuracy ${formatted.coveredKnownHierarchicalAccuracy}, known top-leaf accuracy ${formatted.knownTopLeafAccuracy}, and minimum high-SNR known-class hierarchical accuracy ${formatted.minimumHighSnrKnownClassHierarchicalAccuracy}. On ${formatted.properScoreSamples} singleton-truth, fit-eligible proper-score samples, fitted-template log loss was ${formatted.fittedTemplateLogLoss}, multiclass Brier score ${formatted.fittedTemplateMulticlassBrier}, and expected calibration error ${formatted.fittedTemplateExpectedCalibrationError}. Fitted-unknown AUROC and rejection were ${formatted.fittedUnknownPosteriorAuroc}; scenario-excluded strict-typicality AUROC was ${formatted.strictTypicalityAuroc} and admitted strict-holdout rejection was ${formatted.strictUnknownRejectionRate}.`,
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
  expectEqual(failures, manifestSha256, modelSha256, 'generated model manifest SHA-256');
  for (const path of [
    'model.modelAssetSha256',
    'integrity.checkedInModelAssetSha256',
    'integrity.modelAssetManifestSha256',
  ]) {
    expectEqual(failures, valueAt(report, path), modelSha256, `${REPORT_PATH} ${path}`);
  }

  const metrics = collectMetrics(report, failures);
  const formatted = formatMetrics(metrics, failures);
  const documents = new Map(
    PUBLICATION_PATHS.map((path) => [path, normalizeProse(byPath.get(path).toString('utf8'))]),
  );
  verifyPublicationProse(documents, modelSha256, metrics, formatted, failures);

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
