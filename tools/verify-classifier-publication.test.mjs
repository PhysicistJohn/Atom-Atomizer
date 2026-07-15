import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFIER_PATH = 'tools/verify-classifier-publication.mjs';
const MODEL_PATH = 'packages/analysis/src/models/bayesian-observable-v5.generated.ts';
const MANIFEST_PATH = 'packages/analysis/src/models/bayesian-observable-v5.manifest.generated.ts';
const REPORT_PATH = '.artifacts/classifier-validation/report.json';
const PUBLICATION_PATHS = [
  'README.md',
  'docs/BAYESIAN_DETECTION_CLASSIFICATION_RESEARCH.md',
  'docs/SIGNALLAB_EMSO_CLASSIFIER_CONTRACT.md',
  'docs/UI_UX_CONTRACTS.md',
];
const FIXTURE_PATHS = [VERIFIER_PATH, MODEL_PATH, MANIFEST_PATH, REPORT_PATH, ...PUBLICATION_PATHS];
const MODEL_PAYLOAD_PATTERN = /export const BAYESIAN_OBSERVABLE_MODEL: ObservableClassifierModelAsset = (\{[\s\S]*\});\s*$/;
const MODEL_MANIFEST_PATTERN = /(BAYESIAN_OBSERVABLE_MODEL_SHA256 = ')([a-f0-9]{64})(' as const;)/;
const CURRENT_CALIBRATION_ID =
  'synthetic-view-matched-stratified-online-attempt-min-support-rank-detector-conditioned-physical-uncalibrated-v10';

test('classifier publication verifier is fail-closed under isolated mutations', async (t) => {
  assert.ok(Number.parseInt(process.versions.node, 10) >= 22, 'mutation tests require Node 22 or newer');

  await t.test('accepts an unmodified publication fixture', async () => {
    await withFixture(async (root) => assertVerifierPasses(root));
  });

  await mutationTest(t, 'rejects a changed corpus version', /corpus version/, async (root) => {
    await mutateGeneratedModel(root, (model) => { model.corpusVersion = 'observable-scalar-corpus-v999'; });
    await mutateReport(root, (report) => {
      report.corpus.version = 'observable-scalar-corpus-v999';
      report.validationAcceptance.corpusVersion = 'observable-scalar-corpus-v999';
    }, { seal: false });
    await rebindModelAsset(root);
  });

  const identifierMutations = [
    {
      name: 'model ID', expected: /classifier model ID|generated classifier model ID/,
      generatedField: 'id', reportField: 'id', attestationField: 'modelId', value: 'bayesian-observable-equivalence-v999',
    },
    {
      name: 'preprocessing ID', expected: /preprocessing ID/,
      generatedField: 'preprocessing', reportField: 'preprocessing', attestationField: 'preprocessing', value: 'scalar-observable-features-v999',
    },
    {
      name: 'prior ID', expected: /prior ID/,
      generatedField: 'priorId', reportField: 'priorId', attestationField: 'priorId', value: 'engineering-design-class-weights-v999',
    },
    {
      name: 'calibration ID', expected: /calibration ID/,
      generatedField: 'calibrationId', reportField: 'calibrationId', attestationField: 'calibrationId',
      value: 'synthetic-view-matched-stratified-online-attempt-min-support-rank-detector-conditioned-physical-uncalibrated-v999',
    },
    {
      name: 'decision-policy ID', expected: /decision-policy ID|validator acceptance decisionPolicyId/,
      reportField: 'decisionPolicyId', attestationField: 'decisionPolicyId', value: 'observable-open-set-decision-v999',
    },
    {
      name: 'source-commit provenance', expected: /source commit/,
      generatedField: 'sourceCommit', reportField: 'sourceCommit', attestationField: 'sourceCommit',
      value: '0000000000000000000000000000000000000000',
    },
  ];
  for (const mutation of identifierMutations) {
    await mutationTest(t, `rejects a changed ${mutation.name}`, mutation.expected, async (root) => {
      if (mutation.generatedField) {
        await mutateGeneratedModel(root, (model) => { model[mutation.generatedField] = mutation.value; });
      }
      await mutateReport(root, (report) => {
        report.model[mutation.reportField] = mutation.value;
        report.validationAcceptance[mutation.attestationField] = mutation.value;
      }, { seal: !mutation.generatedField });
      if (mutation.generatedField) await rebindModelAsset(root);
    });
  }

  await mutationTest(t, 'rejects a changed detected-power synthesis filter width', /synthesis-filter policy/, async (root) => {
    await mutateGeneratedModel(root, (model) => {
      model.trainingMatrix.detectedPowerSynthesisFilterPolicy.signalLabProductionSynthesisFilterWidthHz = 100_001;
    });
    await mutateReport(root, (report) => {
      report.matrix.detectedPowerSynthesisFilterPolicy.signalLabProductionSynthesisFilterWidthHz = 100_001;
    }, { seal: false });
    await rebindModelAsset(root);
  });

  await mutationTest(t, 'rejects a changed detected-power RBW qualification', /synthesis-filter policy/, async (root) => {
    await mutateGeneratedModel(root, (model) => {
      model.trainingMatrix.detectedPowerSynthesisFilterPolicy.measurementActualRbwQualification = 'available';
    });
    await mutateReport(root, (report) => {
      report.matrix.detectedPowerSynthesisFilterPolicy.measurementActualRbwQualification = 'available';
    }, { seal: false });
    await rebindModelAsset(root);
  });

  await mutationTest(t, 'rejects a changed production temporal offset', /production acquisition regime/, async (root) => {
    await mutateProductionSchedule(root, 2, (schedule) => { schedule.sourceLookIndexOffset += 1; });
  });

  await mutationTest(t, 'rejects a changed production temporal capture skip', /production acquisition regime/, async (root) => {
    await mutateProductionSchedule(root, 1, (schedule) => { schedule.skipAfterSpectrumOpportunities += 1; });
  });

  await mutationTest(t, 'rejects a relaxed tail-comparison tolerance', /score tolerance/, async (root) => {
    await mutateReport(root, (report) => {
      report.matrix.tailCalibrationAudit.independentRecomputation.scoreTolerance = 1e-11;
    });
  });

  await mutationTest(t, 'rejects a duplicate tail-comparison key', /comparison key set/, async (root) => {
    await mutateReport(root, (report) => {
      const comparisons = report.matrix.tailCalibrationAudit.independentRecomputation.scoreComparisons;
      assert.ok(comparisons.length >= 2, 'baseline must contain at least two tail comparisons');
      comparisons[1].classId = comparisons[0].classId;
      comparisons[1].view = comparisons[0].view;
    });
  });

  await mutationTest(t, 'rejects a missing tail-comparison key', /comparison key set/, async (root) => {
    await mutateReport(root, (report) => {
      const comparisons = report.matrix.tailCalibrationAudit.independentRecomputation.scoreComparisons;
      assert.ok(comparisons.length > 0, 'baseline must contain tail comparisons');
      comparisons.pop();
    });
  });

  await mutationTest(t, 'rejects a false tail-calibration audit boolean', /tail-calibration audit/, async (root) => {
    await mutateReport(root, (report) => { report.matrix.tailCalibrationAudit.valid = false; });
  });

  await mutationTest(t, 'rejects a failed validation attestation', /validator acceptance status/, async (root) => {
    await mutateReport(root, (report) => { report.validationAcceptance.status = 'failed'; });
  });

  await mutationTest(t, 'rejects a forged validation evidence hash', /validator acceptance evidence SHA-256/, async (root) => {
    await mutateReport(root, (report) => {
      report.validationAcceptance.evidenceSha256 = '0'.repeat(64);
    }, { seal: false });
  });

  await mutationTest(t, 'rejects a stale documentation calibration ID', /README\.md.*calibration ID/s, async (root) => {
    const path = resolve(root, 'README.md');
    const source = await readFile(path, 'utf8');
    assert.ok(source.includes(CURRENT_CALIBRATION_ID), 'baseline README must publish the current calibration ID');
    await writeFile(path, source.replaceAll(CURRENT_CALIBRATION_ID,
      'synthetic-view-matched-stratified-online-attempt-min-support-rank-detector-conditioned-physical-uncalibrated-v999'));
  });

  await mutationTest(t, 'rejects a changed ordered feature dimension', /ordered dimensions/, async (root) => {
    await mutateGeneratedModel(root, (model) => { model.dimensions[0] = 'forged.dimension'; });
    await rebindModelAsset(root);
  });

  await mutationTest(t, 'rejects a changed leaf class ID', /class IDs and order/, async (root) => {
    await mutateGeneratedModel(root, (model) => { model.classModels[0].id = 'forged-class'; });
    await rebindModelAsset(root);
  });

  await mutationTest(t, 'rejects a missing likelihood component', /component count/, async (root) => {
    await mutateGeneratedModel(root, (model) => { model.classModels[0].components.pop(); });
    await rebindModelAsset(root);
  });

  await mutationTest(t, 'rejects a changed representative eligibility policy', /representative eligibility policy/, async (root) => {
    await mutateGeneratedModel(root, (model) => {
      model.trainingMatrix.representativeEligibilityPolicy = 'runtime-domain-qualified-known-representatives-v3';
    });
    await mutateReport(root, (report) => {
      report.matrix.representativeEligibilityPolicy = 'runtime-domain-qualified-known-representatives-v3';
    }, { seal: false });
    await rebindModelAsset(root);
  });

  await mutationTest(t, 'rejects a changed support-rank cutoff', /minimum known synthetic support rank/, async (root) => {
    await mutateReport(root, (report) => { report.model.minimumKnownSyntheticSupportRank = 0.03; });
  });

  await mutationTest(t, 'rejects duplicate prior-sensitivity variant identity', /prior sensitivity variant IDs/, async (root) => {
    await mutateReport(root, (report) => {
      report.priorSensitivity.variants[1].id = report.priorSensitivity.variants[0].id;
    });
  });

  await mutationTest(t, 'rejects a negative tail-score difference', /tail score comparison/, async (root) => {
    await mutateReport(root, (report) => {
      report.matrix.tailCalibrationAudit.independentRecomputation.scoreComparisons[0].maximumAbsoluteDifference = -1;
    });
  });

  await mutationTest(t, 'rejects a non-Bluetooth admitted BLE result', /exclusive Bluetooth-like result|BLE result denominator/, async (root) => {
    await mutateReport(root, (report) => {
      report.classificationConditionalOnAdmission.association.byScenario['bluetooth-le-advertising']
        .results.unknown = 1;
    });
  });

  await mutationTest(t, 'rejects an out-of-range published probability', /knownCoverage.*0\.\.1/, async (root) => {
    await mutateReport(root, (report) => {
      report.classificationConditionalOnAdmission.knownCoverage = 1.01;
    });
  });

  await mutationTest(t, 'does not accept a model hash hidden in an HTML comment', /README\.md must publish model asset SHA-256/, async (root) => {
    const report = JSON.parse(await readFile(resolve(root, REPORT_PATH), 'utf8'));
    const path = resolve(root, 'README.md');
    const source = await readFile(path, 'utf8');
    assert.ok(source.includes(report.model.modelAssetSha256), 'baseline README must publish the model hash');
    await writeFile(path, source.replace(report.model.modelAssetSha256, `<!--${report.model.modelAssetSha256}-->`));
  });

  await mutationTest(t, 'does not accept required prose hidden in a fenced block', /production-acquisition-summary/, async (root) => {
    const path = resolve(root, 'README.md');
    const source = await readFile(path, 'utf8');
    const required = "The fitted and independently regenerated tail-calibration matrix includes SignalLab's 450-point recommended-span grid under the contiguous-zero, post-eight-capture-skip, and full-matrix offset-225 source-clock schedules. Public detected-power synthesis uses the generator-internal 100 kHz filter; measured detected-power RBW remains unavailable and is never classifier evidence.";
    assert.ok(source.includes(required), 'baseline README must publish production acquisition prose');
    await writeFile(path, source.replace(required, `\n\`\`\`text\n${required}\n\`\`\`\n`));
  });

  await mutationTest(t, 'rejects a stale fitting count in visible prose', /stale fitting-representative count|model-structure-summary/, async (root) => {
    const path = resolve(root, 'README.md');
    const source = await readFile(path, 'utf8');
    assert.ok(source.includes('4,755'), 'baseline README must publish current fitting count');
    await writeFile(path, source.replaceAll('4,755', '8,140'));
  });
});

async function mutationTest(t, name, expectedFailure, mutate) {
  await t.test(name, async () => {
    await withFixture(async (root) => {
      await mutate(root);
      await assertVerifierRejects(root, expectedFailure);
    });
  });
}

async function withFixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'tinysa-classifier-publication-'));
  try {
    for (const relativePath of FIXTURE_PATHS) {
      const destination = resolve(root, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(resolve(REPOSITORY_ROOT, relativePath), destination);
    }
    return await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runVerifier(root) {
  try {
    const result = await execFileAsync(process.execPath, [resolve(root, VERIFIER_PATH)], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
    });
    return { passed: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      passed: false,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : String(error),
    };
  }
}

async function assertVerifierPasses(root) {
  const result = await runVerifier(root);
  assert.equal(result.passed, true, `unmodified publication fixture failed:\n${result.stdout}\n${result.stderr}`);
}

async function assertVerifierRejects(root, expectedFailure) {
  const result = await runVerifier(root);
  assert.equal(result.passed, false, `mutated publication fixture unexpectedly passed:\n${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, expectedFailure);
}

async function mutateGeneratedModel(root, mutate) {
  const path = resolve(root, MODEL_PATH);
  const source = await readFile(path, 'utf8');
  const match = source.match(MODEL_PAYLOAD_PATTERN);
  assert.ok(match, 'generated model fixture must contain one JSON payload');
  const model = JSON.parse(match[1]);
  mutate(model);
  await writeFile(path, source.replace(match[1], JSON.stringify(model, null, 2)));
}

async function mutateReport(root, mutate, { seal = true } = {}) {
  const path = resolve(root, REPORT_PATH);
  const report = JSON.parse(await readFile(path, 'utf8'));
  mutate(report);
  if (seal) sealValidationEvidence(report);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}

async function mutateProductionSchedule(root, scheduleIndex, mutate) {
  await mutateGeneratedModel(root, (model) => {
    mutate(model.trainingMatrix.signalLabProductionAcquisitionRegime.temporalSchedules[scheduleIndex]);
  });
  await mutateReport(root, (report) => {
    mutate(report.matrix.tailCalibrationAudit.pinnedSignalLabProductionAcquisitionRegime
      .temporalSchedules[scheduleIndex]);
  }, { seal: false });
  await rebindModelAsset(root);
}

async function rebindModelAsset(root) {
  const modelBytes = await readFile(resolve(root, MODEL_PATH));
  const modelSha256 = sha256(modelBytes);
  const manifestPath = resolve(root, MANIFEST_PATH);
  const manifest = await readFile(manifestPath, 'utf8');
  const manifestMatch = manifest.match(MODEL_MANIFEST_PATTERN);
  assert.ok(manifestMatch, 'generated model manifest fixture must contain one SHA-256');
  const previousManifestSha256 = manifestMatch[2];
  await writeFile(manifestPath, manifest.replace(
    MODEL_MANIFEST_PATTERN,
    (_match, prefix, _previous, suffix) => `${prefix}${modelSha256}${suffix}`,
  ));

  const reportPath = resolve(root, REPORT_PATH);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const previousReportSha256 = report.model.modelAssetSha256;
  report.model.modelAssetSha256 = modelSha256;
  report.integrity.checkedInModelAssetSha256 = modelSha256;
  report.integrity.modelAssetManifestSha256 = modelSha256;
  report.validationAcceptance.modelAssetSha256 = modelSha256;
  sealValidationEvidence(report);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  for (const relativePath of PUBLICATION_PATHS) {
    const path = resolve(root, relativePath);
    let source = await readFile(path, 'utf8');
    for (const previous of new Set([previousManifestSha256, previousReportSha256])) {
      source = source.replaceAll(previous, modelSha256);
    }
    await writeFile(path, source);
  }
}

function sealValidationEvidence(report) {
  const { validationAcceptance, ...evidence } = report;
  assert.ok(validationAcceptance && typeof validationAcceptance === 'object',
    'report fixture must contain validationAcceptance');
  validationAcceptance.evidenceSha256 = sha256(JSON.stringify(evidence));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
