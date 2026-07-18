import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  CANONICAL_SIGNAL_LAB_PROFILE_IDS,
  createAtomizerLogRendererMemorySampler,
  createAtomizerLogSignalLabSessionInspector,
  EXPECTED_SIGNAL_LAB_PROFILE_COUNT,
  finalizeSignalLabLiveVisualReview,
  liveButtonIsEnabled,
  liveButtonExists,
  liveChannelSummary,
  liveDetectCandidateRankingSummary,
  liveDetectAcceptanceSummary,
  liveGlobalSweepIdentitySummary,
  liveIqSummary,
  liveLayoutContractSummary,
  liveMarkerSummary,
  liveMarkerCharacterizationSummary,
  liveMarkerM1ReadoutIsNormal,
  liveScreenshotMeetsMinimum,
  liveScreenshotDimensions,
  livePngPixelEvidence,
  liveSignalLabAtomOpenSoakConfiguration,
  liveSignalLabClassificationTimeoutMs,
  liveSignalLabClassificationEvidenceSatisfied,
  liveSignalLabClassificationExpectation,
  liveSignalLabDefaultGeometrySmokeOpportunities,
  liveSignalLabMarkerExpectation,
  liveSignalLabProducerSessionEvidence,
  liveSignalLabRequiredClassificationOpportunities,
  liveSignalLabRunKind,
  liveSignalLabSourceSessionSummary,
  liveSweepGeometrySummary,
  liveSweepIdentitySummary,
  liveWaterfallSummary,
  liveWorkspaceIsVisible,
  loadSignalLabLiveCatalog,
  parseAtomizerRendererMemoryLog,
  parseAtomizerSignalLabReadyLog,
  parseAtomizerSignalLabSessionLog,
  SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS,
  SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_SOURCE_PLAN,
  SIGNAL_LAB_DEFAULT_GEOMETRY_SMOKE_PROFILE_IDS,
  SIGNAL_LAB_MINIMUM_SCREENSHOT_HEIGHT,
  SIGNAL_LAB_MINIMUM_SCREENSHOT_WIDTH,
  screenshotArtifactExtension,
  signalLabLiveCoverageMatrix,
  summarizeSignalLabLiveRun,
  validateLiveMarkerEvidence,
  validateLiveChannelEvidence,
  validateLiveIqEvidence,
  validateLiveLayoutContract,
  validateLiveStressEvidence,
  validateLiveWaterfallEvidence,
  validateFreshIqCapture,
  validateFreshMarkerEvidence,
  validateGlobalSweepMatchesSpectrum,
  validateRendererMemorySamples,
  validateSignalLabAtomOpenSoakCompletion,
} from './live-signal-lab-exercise.mjs';

const FULL_REQUIRED_STEPS = Object.freeze([
  'select',
  'single',
  'continuous-detect',
  'marker',
  'waterfall',
  'channel',
  'iq',
]);

const COMPLETE_STOPPED_LAYOUT = Object.freeze({
  routeCounts: Object.freeze({
    Spectrum: 1,
    Waterfall: 1,
    Channel: 1,
    'I/Q': 1,
    Detect: 1,
    Generate: 1,
    Device: 1,
  }),
  routeOrder: Object.freeze([
    'Spectrum',
    'Waterfall',
    'Channel',
    'I/Q',
    'Detect',
    'Generate',
    'Device',
  ]),
  acquisitionCounts: Object.freeze({ run: 1, single: 1, stop: 0 }),
  acquisitionLandmarkCount: 1,
  acquisitionLandmarkPrecedesControls: true,
  acquisitionLandmarkControlBinding: true,
  globalSweepIdentity: Object.freeze({
    evidenceCount: 1,
    valid: true,
    controls: 'Run,Single',
    sweepId: null,
    sequence: null,
    evidence: 'DEV ACQUISITION LANDMARK fixture',
  }),
  forbiddenNavigation: Object.freeze([]),
  localIqCaptureControls: Object.freeze([]),
});

const COMPLETE_RUNNING_LAYOUT = Object.freeze({
  ...COMPLETE_STOPPED_LAYOUT,
  acquisitionCounts: Object.freeze({ run: 0, single: 0, stop: 1 }),
  globalSweepIdentity: Object.freeze({
    evidenceCount: 1,
    valid: true,
    controls: 'Stop',
    sweepId: 'sweep-11',
    sequence: 11,
    evidence: 'DEV ACQUISITION LANDMARK running fixture',
  }),
});

function screenshotManifestEntry(path, index) {
  return {
    path,
    extension: '.png',
    bytes: 128,
    width: 1_532,
    height: 821,
    sampledPixels: 20_000,
    distinctColors: 128,
    minimumLuminance: 1,
    maximumLuminance: 240,
    luminanceRange: 239,
    sha256: index.toString(16).padStart(64, '0'),
    pixelSha256: (index + 1).toString(16).padStart(64, '0'),
    claim: 'fresh-frame-dimensions-pixel-nondegeneracy-and-duplicate-content',
  };
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  // The harness does not need a PNG CRC implementation; its own decoder is
  // deliberately geometry/pixel focused and the fixture never leaves tests.
  return chunk;
}

function pngScreenshotFixture(seed, width = 8, height = 2, options = {}) {
  const rgba = options.rgba === true;
  const channels = rgba ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, rgba ? 6 : 2, 0, 0, 0], 8);
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    const rowOffset = row * (stride + 1);
    raw[rowOffset] = 0;
    for (let column = 0; column < width; column++) {
      const pixel = row * width + column;
      const base = rowOffset + 1 + column * channels;
      raw[base] = pixel * 17 % 256;
      raw[base + 1] = pixel * 43 % 256;
      raw[base + 2] = (pixel * 71 + seed) % 256;
      if (rgba) {
        raw[base + 3] = typeof options.alpha === 'function'
          ? options.alpha(pixel)
          : options.alpha ?? 255;
      }
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function screenshotManifestEntryFromBytes(path, bytes) {
  return {
    path,
    extension: '.png',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...livePngPixelEvidence(bytes),
    claim: 'fresh-frame-dimensions-pixel-nondegeneracy-and-duplicate-content',
  };
}

function classifierFixtureLabel(profileId) {
  if (profileId === 'cw') return 'CW-like carrier';
  if (profileId === 'am') return 'DSB full-carrier AM-like';
  if (profileId === 'fm') return 'FM / angle-modulated-like';
  if (profileId === 'gsm-900-loaded-bcch') return 'GSM / GERAN-like';
  if (['lte-band3-fdd-20m', 'lte-band38-tdd-10m', 'nr-n3-fdd-20m'].includes(profileId)) {
    return 'OFDM-shaped · LTE/NR-compatible';
  }
  if (profileId === 'nr-n78-tdd-100m') return '5G NR TDD-like';
  if (['wifi-hr-dsss-11m', 'wifi-ofdm-20m'].includes(profileId)) {
    return '802.11-compatible channel morphology · PHY unresolved';
  }
  if (['bluetooth-classic-connected', 'bluetooth-le-advertising'].includes(profileId)) {
    return '2.4 GHz agile activity · Bluetooth-compatible';
  }
  return 'Current non-protocol morphology result';
}

function fullRunFixture(catalog, screenshotRoot = '/tmp/live-signal-lab-fixture') {
  const profiles = catalog.map(({ id }) => ({
    id,
    failures: [],
    steps: Object.fromEntries(FULL_REQUIRED_STEPS.map((step) => [step, {
      ok: true,
      screenshot: join(screenshotRoot, `${id}--${step}.png`),
      ...(step === 'select' ? { layout: COMPLETE_STOPPED_LAYOUT } : {}),
      ...(step === 'single' ? { geometry: { plotPoints: 450 } } : {}),
      ...(step === 'marker' ? {
        markerGeometry: { plotPoints: 450 },
        markerFreshness: { status: 'fresh-current-sweep-marker-validated' },
        markerCenterOracle: {
          status: id === 'cw' ? 'validated-known-center' : 'not-applicable',
        },
      } : {}),
      ...(step === 'waterfall' ? {
        waterfallOracle: { status: 'coherent-nondegenerate-render-input-validated' },
      } : {}),
      ...(step === 'channel' ? {
        channelOracle: {
          status: id === 'cw'
            ? 'validated-resolution-limited-narrow'
            : id === 'lte-etm3.1'
              ? 'validated-resolved-wideband'
              : 'measured-sanity-validated',
        },
      } : {}),
      ...(step === 'iq' ? {
        iqOracle: { status: 'nondegenerate-capture-and-scaling-validated' },
        freshCapture: { status: 'fresh-current-profile-capture-validated' },
      } : {}),
      ...(step === 'continuous-detect' ? {
        detectAcceptance: {
          autoTargetIsMaximumIntegratedExcess: true,
          candidateRanking: {
            rankingEvidenceComplete: true,
            evidenceSource: 'development-complete-rank-population',
          },
        },
        sweepProgression: {
          classificationEvidence: {
            resultLabel: classifierFixtureLabel(id),
            resultQualification: 'BAYESIAN EVIDENCE CLASS · NOT PROTOCOL',
            resultLinkedToAutoTarget: true,
          },
        },
      } : {}),
    }])),
  }));
  const run = {
    schemaVersion: 2,
    kind: 'full-profile-exercise',
    startedAt: '2026-07-18T08:00:00.000Z',
    completedAt: '2026-07-18T08:02:00.000Z',
    options: Object.fromEntries([
      'exerciseSingle',
      'exerciseContinuous',
      'exerciseMarker',
      'exerciseDetect',
      'exerciseWaterfall',
      'exerciseChannel',
      'exerciseIq',
      'requireClassification',
      'requireDetectAutoTarget',
      'requireDetectNoInnerScroll',
      'requireLiveScreenshots',
      'requireNoLocalIqCaptureButton',
    ].map((option) => [option, true])),
    catalog,
    profiles,
    failures: [],
    stress: {
      actionLatencies: [],
      accessibilitySnapshotLatencies: [],
      sweepProgressions: [],
      rendererMemorySamples: [],
      bounds: { status: 'control-latency-and-sweep-progression-validated' },
      rendererMemory: {
        status: 'plateau-and-hard-bound-validated',
        samples: 8,
        identity: 'pid:91500:created:2026-07-18T08:00:00.000Z',
        runWindowValidated: true,
        checkpointCoverageValidated: true,
      },
    },
    visualContentReview: {
      automatedClaim: 'fresh-frame-dimensions-pixel-nondegeneracy-and-duplicate-content',
      status: 'manual-review-required',
    },
    geometry: {
      policyId: 'signal-lab-marker-oracle-recommended-span-450-points-v1',
      requiredPoints: 450,
      requiredSweepTimeSeconds: 0.05,
      configured: { configuredPoints: 450, configuredSweepTimeSeconds: 0.05 },
    },
  };
  Object.assign(run.options, {
    profileTimeoutMs: 8_000,
    acquisitionTimeoutMs: 12_000,
    classificationTimeoutMs: 15_000,
    maximumControlResponseMs: 7_000,
    maximumAccessibilitySnapshotMs: 7_000,
    maximumFirstSweepLatencyMs: 3_000,
    maximumStopLatencyMs: 3_000,
    maximumMillisecondsPerSweepOpportunity: 500,
    maximumResponsivenessTourMs: 30_000,
    minimumContinuousSweepProgressions: 2,
    minimumScreenshotWidth: SIGNAL_LAB_MINIMUM_SCREENSHOT_WIDTH,
    minimumScreenshotHeight: SIGNAL_LAB_MINIMUM_SCREENSHOT_HEIGHT,
    rendererMemoryPlateauWindow: 4,
    rendererMemoryMaximumPlateauGrowthBytes: 64 * 1_024 * 1_024,
    rendererMemoryHardLimitBytes: 2 * 1_024 * 1_024 * 1_024,
    screenshotPolicy: 'all',
    narrowMarkerProfileIds: ['cw'],
    wideMarkerProfileIds: ['lte-etm3.1'],
    iqZoomProfileIds: [...CANONICAL_SIGNAL_LAB_PROFILE_IDS],
    iqContinuousProfileIds: ['cw', 'lte-etm3.1', 'bluetooth-classic-connected'],
  });
  const screenshotPaths = profiles.flatMap((profile) => (
    FULL_REQUIRED_STEPS.map((step) => profile.steps[step].screenshot)
  ));
  run.visualContentReview.automatedScreenshotManifest = screenshotPaths
    .map(screenshotManifestEntry);
  return run;
}

test('live SignalLab harness is closed over the complete built profile catalog', async () => {
  const catalog = await loadSignalLabLiveCatalog();
  const matrix = await signalLabLiveCoverageMatrix();

  assert.equal(catalog.length, EXPECTED_SIGNAL_LAB_PROFILE_COUNT);
  assert.equal(new Set(catalog.map(({ id }) => id)).size, EXPECTED_SIGNAL_LAB_PROFILE_COUNT);
  assert.deepEqual(catalog.map(({ id }) => id), CANONICAL_SIGNAL_LAB_PROFILE_IDS);
  assert.deepEqual(matrix.map(({ profileId }) => profileId), catalog.map(({ id }) => id));
  assert.ok(matrix.every((row) => row.scalarSingle
    && row.scalarContinuous
    && row.detectVisualization
    && row.detectAutoMostProminent
    && row.detectNoInnerScroll
    && row.bayesianClassification
    && row.peakMarkerAndLocalCharacterization
    && row.waterfall
    && row.channelAndThreeDecibelBandwidth
    && row.complexIqSingle
    && row.noRedundantLocalIqCapture
    && row.boundedControlLatencyAndSweepProgression));
  assert.deepEqual(
    matrix.find(({ profileId }) => profileId === 'cw')?.markerWidthExpectation,
    ['resolution-limited-narrow'],
  );
  assert.deepEqual(
    matrix.find(({ profileId }) => profileId === 'lte-etm3.1')?.markerWidthExpectation,
    ['resolved-wideband'],
  );
  assert.ok(matrix.every(({ classificationClaim }) => (
    classificationClaim === 'linked-current-non-protocol-result-only'
  )));
  assert.equal(matrix.filter(({ fittedClassifierReleaseGateEligible }) => (
    fittedClassifierReleaseGateEligible
  )).length, 12);
  assert.ok(matrix.every(({ screenshotClaim }) => (
    screenshotClaim === 'fresh-frame-dimensions-pixel-nondegeneracy-and-duplicate-content'
  )));
  assert.ok(matrix.every(({ screenshotContentReview }) => screenshotContentReview === 'manual-review-required'));
});

test('full and debug-subset live runs have non-overlapping honest kinds', () => {
  assert.equal(liveSignalLabRunKind('full-profile-exercise', 34), 'full-profile-exercise');
  assert.equal(liveSignalLabRunKind('full-profile-exercise', 1), 'profile-subset-exercise');
  assert.equal(
    liveSignalLabRunKind('continuous-profile-switch-soak', 3),
    'continuous-profile-switch-subset-soak',
  );
  assert.throws(
    () => liveSignalLabRunKind('full-profile-exercise', 35),
    /profileCount must be between 1 and 34/u,
  );
});

test('scientific classifier summary requires a fresh exact-12 Single-acquisition source plan', async () => {
  const visibleSource = { sourceState: 'READY', sessionState: 'READY', sourceSequence: 0 };
  const inspected = liveSignalLabProducerSessionEvidence({
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    driverId: 'signal-lab',
    provenance: {
      sourceKind: 'signal-lab',
      contractId: 'contract',
      producerConfigurationEpoch: 'epoch:initial',
      claims: { rfEmitted: false },
    },
  }, visibleSource, '2026-07-18T08:00:00.000Z');
  const reordered = liveSignalLabProducerSessionEvidence({
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    driverId: 'signal-lab',
    provenance: {
      claims: { rfEmitted: false },
      producerConfigurationEpoch: 'epoch:after-profile-selection',
      contractId: 'contract',
      sourceKind: 'signal-lab',
    },
  }, visibleSource, '2026-07-18T08:00:00.000Z');
  assert.equal(inspected.identitySha256, reordered.identitySha256);
  assert.throws(
    () => liveSignalLabProducerSessionEvidence({
      sessionId: 'friendly-label-not-an-opaque-session',
      driverId: 'signal-lab',
      provenance: { sourceKind: 'signal-lab' },
    }, visibleSource),
    /actual opaque UUID/u,
  );
  const fullCatalog = await loadSignalLabLiveCatalog();
  const catalog = fullCatalog.filter(({ id }) => (
    SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS.includes(id)
  ));
  const profiles = SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_SOURCE_PLAN.map((sourcePlan) => {
    const spectrumSequences = Array.from(
      { length: sourcePlan.spectrumOpportunities },
      (_, look) => sourcePlan.sourceLookIndexOffset + look + 1,
    );
    const catalogProfile = catalog[sourcePlan.profileOrdinal];
    return {
      id: sourcePlan.profileId,
      failures: [],
      steps: {
        'classifier-release-gate': {
          ok: true,
          sourcePlan,
          sourceClockEvidence: {
            firstSpectrumSequence: spectrumSequences[0],
            lastSpectrumSequence: spectrumSequences.at(-1),
            spectrumSequences,
            producerSourceSequences: [...spectrumSequences],
            sweepLatenciesMs: spectrumSequences.map(() => 50),
            automaticDetectedPowerCaptures: 0,
            classificationCaptureId: `capture-${sourcePlan.profileId}`,
          },
          geometryEvidence: {
            configured: { configuredPoints: 450, configuredSweepTimeSeconds: 0.05 },
            result: { plotPoints: 450, pinnedBayesianGeometryVisible: true },
            expectedStartHz: Math.round(
              catalogProfile.centerHz - catalogProfile.recommendedSpanHz / 2,
            ),
            expectedStopHz: Math.round(
              catalogProfile.centerHz + catalogProfile.recommendedSpanHz / 2,
            ),
            observedRangeHz: {
              startHz: Math.round(
                catalogProfile.centerHz - catalogProfile.recommendedSpanHz / 2,
              ),
              stopHz: Math.round(
                catalogProfile.centerHz + catalogProfile.recommendedSpanHz / 2,
              ),
            },
          },
          classificationEvidence: {
            resultLabel: classifierFixtureLabel(sourcePlan.profileId),
            resultQualification: 'BAYESIAN EVIDENCE CLASS · NOT PROTOCOL',
            resultLinkedToAutoTarget: true,
          },
        },
      },
    };
  });
  const run = {
    schemaVersion: 2,
    kind: 'classifier-release-gate',
    startedAt: '2026-07-18T08:00:00.000Z',
    completedAt: '2026-07-18T08:02:00.000Z',
    catalog,
    profiles,
    failures: [],
    stress: { actionLatencies: [], accessibilitySnapshotLatencies: [], sweepProgressions: [] },
    sourceClock: {
      policyId: 'shared-monotonic-source-clock-v1',
      plan: SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_SOURCE_PLAN,
      initialSweepSequence: null,
      initialSourceSequence: 0,
      finalSourceSequence: 512,
      session: {
        initial: {
          sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          driverId: 'signal-lab',
          identity: { sourceKind: 'signal-lab' },
          identitySha256: 'a'.repeat(64),
          visibleSource: { sourceState: 'READY', sessionState: 'READY', sourceSequence: 0 },
        },
        final: {
          sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          driverId: 'signal-lab',
          identity: { sourceKind: 'signal-lab' },
          identitySha256: 'a'.repeat(64),
          visibleSource: { sourceState: 'READY', sessionState: 'READY', sourceSequence: 512 },
        },
      },
      status: 'fresh-pinned-order-and-horizons-observed',
    },
    geometry: {
      policyId: 'signal-lab-recommended-span-450-point-grid-v1',
      requiredPoints: 450,
      requiredSweepTimeSeconds: 0.05,
      configured: { configuredPoints: 450, configuredSweepTimeSeconds: 0.05 },
    },
  };
  const summary = summarizeSignalLabLiveRun(run);
  assert.equal(summary.ok, true);
  assert.equal(summary.classifierOracle.status, 'exact-12-of-12-classifier-oracle-validated');
  assert.equal(summary.classifierOracle.sourceClockPlanComplete, true);
  assert.equal(summary.classifierOracle.producerSessionComplete, true);
  assert.equal(summary.classifierOracle.validatedProfiles, 12);

  const hiddenCapture = structuredClone(run);
  hiddenCapture.profiles[1].steps['classifier-release-gate']
    .sourceClockEvidence.spectrumSequences[0] += 1;
  assert.equal(summarizeSignalLabLiveRun(hiddenCapture).ok, false);
  const notFresh = structuredClone(run);
  notFresh.sourceClock.initialSweepSequence = 9;
  assert.equal(summarizeSignalLabLiveRun(notFresh).ok, false);
  const changedSession = structuredClone(run);
  changedSession.sourceClock.session.final.sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  assert.equal(summarizeSignalLabLiveRun(changedSession).ok, false);
});

test('default 1024 geometry is recorded separately from fitted 450-point claims', async () => {
  const geometryText = [
    '40 disclosure triangle Description: Edit Sweep points, Help: Sweep points 1024 points',
    '41 text Receiver controls not applicable · synthetic scalar source · exact 50 ms timing',
    '56 text Peak -79.0 dBm 98 MHz Sweep 1 ms 1024 points · COMPLETE History 1 / 50',
  ].join('\n');
  assert.deepEqual(liveSweepGeometrySummary(geometryText), {
    configuredPoints: 1_024,
    configuredSweepTimeSeconds: 0.05,
    plotPoints: 1_024,
    sweepElapsedMs: 1,
    pinnedBayesianGeometryVisible: false,
  });
  assert.deepEqual(liveSignalLabSourceSessionSummary([
    '34 container SignalLab source and session state',
    '35 text SOURCE',
    '36 text READY',
    '37 text SESSION',
    '38 text READY',
    '39 text SEQUENCE 0 · SYNTHETIC VISUAL PROJECTION · SignalLab',
  ].join('\n')), {
    sourceState: 'READY',
    sessionState: 'READY',
    sourceSequence: 0,
    footer: 'text SEQUENCE 0 · SYNTHETIC VISUAL PROJECTION · SignalLab',
  });
  const catalog = (await loadSignalLabLiveCatalog()).filter(({ id }) => (
    SIGNAL_LAB_DEFAULT_GEOMETRY_SMOKE_PROFILE_IDS.includes(id)
  ));
  let nextSequence = 1;
  const profiles = catalog.map((profile) => {
    const spectrumOpportunities = liveSignalLabDefaultGeometrySmokeOpportunities(profile);
    const spectrumSequences = Array.from(
      { length: spectrumOpportunities },
      () => nextSequence++,
    );
    return {
      id: profile.id,
      family: profile.family,
      failures: [],
      steps: {
        'default-geometry-smoke': {
          ok: true,
          spectrumOpportunities,
          sweepGeometry: { plotPoints: 1_024 },
          markerGeometry: { plotPoints: 1_024 },
          markerOracleStatus: 'not-applicable-unfitted-1024-point-geometry',
          sourceClockEvidence: {
            firstSpectrumSequence: spectrumSequences[0],
            lastSpectrumSequence: spectrumSequences.at(-1),
            spectrumSequences,
            producerSourceSequences: [...spectrumSequences],
          },
        },
      },
    };
  });
  assert.deepEqual(
    profiles.map((profile) => profile.steps['default-geometry-smoke'].spectrumOpportunities),
    [1, 1, 32, 96],
  );
  const run = {
    schemaVersion: 2,
    kind: 'default-1024-user-path-smoke',
    startedAt: '2026-07-18T08:00:00.000Z',
    completedAt: '2026-07-18T08:01:00.000Z',
    catalog,
    profiles,
    failures: [],
    stress: { actionLatencies: [], accessibilitySnapshotLatencies: [], sweepProgressions: [] },
    geometry: {
      policyId: 'shipped-default-1024-user-path-v1',
      configured: { configuredPoints: 1_024, configuredSweepTimeSeconds: 0.05 },
      profileIds: SIGNAL_LAB_DEFAULT_GEOMETRY_SMOKE_PROFILE_IDS,
      initialSource: { sourceState: 'READY', sessionState: 'READY', sourceSequence: 0 },
      markerOracleStatus: 'not-applicable-unfitted-1024-point-geometry',
    },
  };
  const summary = summarizeSignalLabLiveRun(run);
  assert.equal(summary.ok, true);
  assert.equal(summary.expectedProfiles, 4);
  assert.equal(summary.geometry.defaultGeometryComplete, true);
  assert.equal(summarizeSignalLabLiveRun({
    ...run,
    geometry: { ...run.geometry, markerOracleStatus: 'validated' },
  }).ok, false);
  const shortenedBluetooth = structuredClone(run);
  shortenedBluetooth.profiles.at(-1).steps['default-geometry-smoke']
    .sourceClockEvidence.spectrumSequences.pop();
  assert.equal(summarizeSignalLabLiveRun(shortenedBluetooth).ok, false);
});

test('full summaries bind the canonical 34/34 catalog, required steps, stress, and memory', async () => {
  const catalog = await loadSignalLabLiveCatalog();
  const full = fullRunFixture(catalog);
  const screenshotManifest = full.visualContentReview.automatedScreenshotManifest;
  full.visualContentReview = {
    automatedClaim: 'fresh-frame-dimensions-pixel-nondegeneracy-and-duplicate-content',
    status: 'reviewed',
    passed: true,
    reviewedAt: '2026-07-18T08:03:00.000Z',
    reviewer: 'manual-visual-review',
    automatedScreenshotManifest: screenshotManifest,
    reviewScreenshotManifest: screenshotManifest,
  };
  const completeSummary = summarizeSignalLabLiveRun(full);
  assert.equal(completeSummary.ok, true);
  assert.equal(completeSummary.releasePolicy.status, 'canonical-release-policy-bound');
  assert.deepEqual(completeSummary.releasePolicy.violations, []);
  assert.equal(completeSummary.classifierOracle.status, 'linked-results-recorded-no-scientific-oracle');
  assert.equal(completeSummary.classifierOracle.validatedProfiles, 0);
  assert.equal(completeSummary.classifierOracle.unvalidatedProfiles, 34);
  assert.equal(summarizeSignalLabLiveRun(full).visualContentReview.status, 'reviewed');
  const pendingVisualReview = summarizeSignalLabLiveRun({
    ...full,
    visualContentReview: {
      automatedClaim: 'fresh-frame-dimensions-pixel-nondegeneracy-and-duplicate-content',
      status: 'manual-review-required',
      automatedScreenshotManifest: screenshotManifest,
    },
  });
  assert.equal(pendingVisualReview.automatedChecksOk, true);
  assert.equal(pendingVisualReview.automatedOk, true);
  assert.equal(pendingVisualReview.ok, false);
  assert.equal(summarizeSignalLabLiveRun({
    ...full,
    visualContentReview: {
      ...full.visualContentReview,
      reviewScreenshotManifest: full.visualContentReview.reviewScreenshotManifest.slice(1),
    },
  }).ok, false);
  const duplicateAutomatedFrame = structuredClone(full);
  duplicateAutomatedFrame.visualContentReview.automatedScreenshotManifest[1].pixelSha256 =
    duplicateAutomatedFrame.visualContentReview.automatedScreenshotManifest[0].pixelSha256;
  assert.equal(summarizeSignalLabLiveRun(duplicateAutomatedFrame).automatedChecksOk, false);
  assert.equal(summarizeSignalLabLiveRun({ ...full, schemaVersion: 1 }).ok, false);
  assert.equal(summarizeSignalLabLiveRun({
    ...full,
    stress: { ...full.stress, rendererMemory: { status: 'not-supplied', samples: 0 } },
  }).ok, false);
  assert.equal(summarizeSignalLabLiveRun({
    ...full,
    catalog: full.catalog.slice(0, 1),
    profiles: full.profiles.slice(0, 1),
  }).expectedProfiles, EXPECTED_SIGNAL_LAB_PROFILE_COUNT);
  assert.equal(summarizeSignalLabLiveRun({
    ...full,
    catalog: full.catalog.slice(0, 1),
    profiles: full.profiles.slice(0, 1),
  }).ok, false);
  assert.equal(summarizeSignalLabLiveRun({
    ...full,
    catalog: full.catalog.map((entry, index) => index === 1 ? full.catalog[0] : entry),
  }).ok, false);
  assert.equal(summarizeSignalLabLiveRun({
    ...full,
    catalog: full.catalog.map((entry, index) => index === 1 ? { ...entry, id: 'fabricated' } : entry),
    profiles: full.profiles.map((entry, index) => index === 1 ? { ...entry, id: 'fabricated' } : entry),
  }).ok, false);
  assert.equal(summarizeSignalLabLiveRun({
    ...full,
    profiles: [...full.profiles].reverse(),
  }).ok, false);
  assert.equal(summarizeSignalLabLiveRun({
    ...full,
    profiles: full.profiles.map((entry, index) => index === 0
      ? { ...entry, steps: { ...entry.steps, marker: undefined } }
      : entry),
  }).ok, false);
  assert.equal(summarizeSignalLabLiveRun({
    ...full,
    options: { ...full.options, exerciseDetect: false },
  }).ok, false);
  assert.equal(summarizeSignalLabLiveRun({
    ...full,
    stress: { ...full.stress, bounds: undefined },
  }).ok, false);
  const weakenedReleaseOptions = [
    ['profileTimeoutMs', 8_001],
    ['acquisitionTimeoutMs', 12_001],
    ['classificationTimeoutMs', 15_001],
    ['maximumControlResponseMs', 7_001],
    ['maximumAccessibilitySnapshotMs', 7_001],
    ['maximumFirstSweepLatencyMs', 3_001],
    ['maximumStopLatencyMs', 3_001],
    ['maximumMillisecondsPerSweepOpportunity', 501],
    ['maximumResponsivenessTourMs', 30_001],
    ['minimumContinuousSweepProgressions', 1],
    ['minimumScreenshotWidth', SIGNAL_LAB_MINIMUM_SCREENSHOT_WIDTH - 1],
    ['minimumScreenshotHeight', SIGNAL_LAB_MINIMUM_SCREENSHOT_HEIGHT - 1],
    ['rendererMemoryPlateauWindow', 3],
    ['rendererMemoryPlateauWindow', 5],
    ['rendererMemoryMaximumPlateauGrowthBytes', 64 * 1_024 * 1_024 + 1],
    ['rendererMemoryHardLimitBytes', 2 * 1_024 * 1_024 * 1_024 + 1],
    ['narrowMarkerProfileIds', []],
    ['narrowMarkerProfileIds', ['cw', 'am']],
    ['wideMarkerProfileIds', []],
    ['wideMarkerProfileIds', ['lte-etm3.1', 'cw']],
    ['iqZoomProfileIds', CANONICAL_SIGNAL_LAB_PROFILE_IDS.slice(0, -1)],
    ['iqZoomProfileIds', [...CANONICAL_SIGNAL_LAB_PROFILE_IDS].reverse()],
    ['iqContinuousProfileIds', ['cw', 'lte-etm3.1']],
    ['iqContinuousProfileIds', ['lte-etm3.1', 'cw', 'bluetooth-classic-connected']],
  ];
  for (const [key, value] of weakenedReleaseOptions) {
    const summary = summarizeSignalLabLiveRun({
      ...full,
      options: { ...full.options, [key]: value },
    });
    assert.equal(summary.releasePolicy.bound, false, key);
    assert.equal(summary.automatedOk, false, key);
  }
  assert.equal(summarizeSignalLabLiveRun({
    ...full,
    options: {
      ...full.options,
      maximumControlResponseMs: 6_999,
      minimumContinuousSweepProgressions: 3,
      minimumScreenshotWidth: SIGNAL_LAB_MINIMUM_SCREENSHOT_WIDTH + 1,
      minimumScreenshotHeight: SIGNAL_LAB_MINIMUM_SCREENSHOT_HEIGHT + 1,
    },
  }).automatedOk, true);
  const visibleRowsOnly = structuredClone(full);
  visibleRowsOnly.profiles[0].steps['continuous-detect']
    .detectAcceptance.candidateRanking.evidenceSource = 'visible-candidate-rows';
  assert.equal(summarizeSignalLabLiveRun(visibleRowsOnly).fullScientificUiEvidenceComplete, false);
  assert.equal(summarizeSignalLabLiveRun(visibleRowsOnly).automatedOk, false);
  for (const layoutPatch of [
    { acquisitionLandmarkCount: 0 },
    { acquisitionLandmarkCount: 2 },
    { acquisitionLandmarkPrecedesControls: false },
  ]) {
    const invalidStoredLayout = structuredClone(full);
    Object.assign(
      invalidStoredLayout.profiles[0].steps.select.layout,
      layoutPatch,
    );
    assert.equal(
      summarizeSignalLabLiveRun(invalidStoredLayout).fullScientificUiEvidenceComplete,
      false,
    );
    assert.equal(summarizeSignalLabLiveRun(invalidStoredLayout).automatedOk, false);
  }
  const continuousFull = structuredClone(full);
  continuousFull.kind = 'continuous-profile-switch-soak';
  continuousFull.profiles = continuousFull.profiles.map((profile) => ({
    id: profile.id,
    failures: [],
    steps: { switch: { ok: true } },
  }));
  assert.equal(summarizeSignalLabLiveRun(continuousFull).automatedOk, true);
  const continuousNumericReleaseKeys = new Set([
    'profileTimeoutMs',
    'acquisitionTimeoutMs',
    'classificationTimeoutMs',
    'maximumControlResponseMs',
    'maximumAccessibilitySnapshotMs',
    'maximumFirstSweepLatencyMs',
    'maximumStopLatencyMs',
    'maximumMillisecondsPerSweepOpportunity',
    'maximumResponsivenessTourMs',
    'minimumContinuousSweepProgressions',
    'rendererMemoryPlateauWindow',
    'rendererMemoryMaximumPlateauGrowthBytes',
    'rendererMemoryHardLimitBytes',
  ]);
  for (const [key, value] of weakenedReleaseOptions.filter(([key]) => (
    continuousNumericReleaseKeys.has(key)
  ))) {
    assert.equal(summarizeSignalLabLiveRun({
      ...continuousFull,
      options: { ...continuousFull.options, [key]: value },
    }).automatedOk, false, `continuous ${key}`);
  }
  assert.equal(summarizeSignalLabLiveRun({
    ...continuousFull,
    options: {
      ...continuousFull.options,
      minimumScreenshotWidth: 1,
      minimumScreenshotHeight: 1,
      narrowMarkerProfileIds: [],
      wideMarkerProfileIds: [],
      iqZoomProfileIds: [],
      iqContinuousProfileIds: [],
    },
  }).automatedOk, true);
  const wrongCanonizedLabelProfiles = full.profiles.map((profile) => profile.id === 'cw'
    ? {
        ...profile,
        steps: {
          ...profile.steps,
          'continuous-detect': {
            ...profile.steps['continuous-detect'],
            sweepProgression: {
              classificationEvidence: {
                ...profile.steps['continuous-detect'].sweepProgression.classificationEvidence,
                resultLabel: '2.4 GHz agile activity · Bluetooth-compatible',
              },
            },
          },
        },
      }
    : profile);
  const interleavedCanonizedLabel = summarizeSignalLabLiveRun({
    ...full,
    profiles: wrongCanonizedLabelProfiles,
    visualContentReview: {
      ...full.visualContentReview,
      reviewScreenshotManifest: wrongCanonizedLabelProfiles.flatMap((profile) => (
        FULL_REQUIRED_STEPS.map((step) => profile.steps[step].screenshot)
      )).map(screenshotManifestEntry),
      automatedScreenshotManifest: wrongCanonizedLabelProfiles.flatMap((profile) => (
        FULL_REQUIRED_STEPS.map((step) => profile.steps[step].screenshot)
      )).map(screenshotManifestEntry),
    },
  });
  assert.equal(interleavedCanonizedLabel.classifierOracle.releaseGateComplete, false);
  assert.deepEqual(interleavedCanonizedLabel.classifierOracle.failedProfileIds, ['cw']);
  assert.equal(interleavedCanonizedLabel.classifierOracle.unvalidatedProfiles, 33);
  assert.deepEqual(
    interleavedCanonizedLabel.classifierOracle.fittedProfileCompatibilityFailedIds,
    ['cw'],
  );
  assert.equal(interleavedCanonizedLabel.ok, false);
  const unknownObservation = structuredClone(full);
  unknownObservation.profiles[4].steps['continuous-detect']
    .sweepProgression.classificationEvidence.resultLabel = 'Unknown';
  assert.equal(
    summarizeSignalLabLiveRun(unknownObservation).classifierOracle.allProfileObservationsComplete,
    true,
  );
  assert.equal(summarizeSignalLabLiveRun(unknownObservation).ok, true);
  const fittedUnknownObservation = structuredClone(full);
  fittedUnknownObservation.profiles[0].steps['continuous-detect']
    .sweepProgression.classificationEvidence.resultLabel = 'Unknown';
  assert.equal(
    summarizeSignalLabLiveRun(fittedUnknownObservation).classifierOracle
      .allProfileObservationsComplete,
    false,
  );
  assert.equal(summarizeSignalLabLiveRun(fittedUnknownObservation).ok, false);

  const subset = {
    ...full,
    kind: 'profile-subset-exercise',
    options: {
      ...full.options,
      maximumControlResponseMs: 99_999,
      minimumContinuousSweepProgressions: 1,
      minimumScreenshotWidth: 1,
      minimumScreenshotHeight: 1,
      narrowMarkerProfileIds: [],
      wideMarkerProfileIds: [],
      iqZoomProfileIds: [],
      iqContinuousProfileIds: [],
    },
    catalog: full.catalog.slice(0, 1),
    profiles: full.profiles.slice(0, 1),
    stress: { ...full.stress, bounds: undefined, rendererMemory: { status: 'not-supplied', samples: 0 } },
  };
  assert.deepEqual(
    {
      kind: summarizeSignalLabLiveRun(subset).kind,
      coverage: summarizeSignalLabLiveRun(subset).catalogCoverage,
      expected: summarizeSignalLabLiveRun(subset).expectedProfiles,
      ok: summarizeSignalLabLiveRun(subset).ok,
    },
    { kind: 'profile-subset-exercise', coverage: 'debug-subset', expected: 1, ok: true },
  );
  assert.equal(summarizeSignalLabLiveRun(subset).releasePolicy.status,
    'not-applicable-debug-or-specialized-run');
});

test('post-run visual finalizer rehashes reduced fixtures without certifying them for release', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'live-signal-lab-review-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const catalog = await loadSignalLabLiveCatalog();
  const run = fullRunFixture(catalog, directory);
  const screenshotPaths = run.profiles.flatMap((profile) => (
    FULL_REQUIRED_STEPS.map((step) => profile.steps[step].screenshot)
  ));
  run.options.minimumScreenshotWidth = 8;
  run.options.minimumScreenshotHeight = 2;
  const screenshotBytes = screenshotPaths.map((_, index) => pngScreenshotFixture(index));
  await Promise.all(screenshotPaths.map((path, index) => writeFile(
    path,
    screenshotBytes[index],
  )));
  const captureTimeScreenshotManifest = screenshotPaths.map((path, index) => (
    screenshotManifestEntryFromBytes(path, screenshotBytes[index])
  ));
  run.visualContentReview.automatedScreenshotManifest = captureTimeScreenshotManifest;
  const reportPath = join(directory, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');

  assert.equal(summarizeSignalLabLiveRun(run).automatedOk, false);
  assert.equal(summarizeSignalLabLiveRun(run).releasePolicy.bound, false);
  assert.equal(summarizeSignalLabLiveRun(run).ok, false);
  await writeFile(screenshotPaths.at(-1), pngScreenshotFixture(0));
  await assert.rejects(
    finalizeSignalLabLiveVisualReview({
      reportPath,
      reviewer: 'visual-reviewer',
      reviewedAt: '2026-07-18T08:03:00.000Z',
      passed: true,
      findings: ['Duplicate should be rejected before review finalization.'],
    }),
    /duplicate screenshot content/u,
  );
  await writeFile(screenshotPaths.at(-1), pngScreenshotFixture(screenshotPaths.length - 1));
  await writeFile(screenshotPaths.at(-1), pngScreenshotFixture(250));
  await assert.rejects(
    finalizeSignalLabLiveVisualReview({
      reportPath,
      reviewer: 'visual-reviewer',
      reviewedAt: '2026-07-18T08:03:00.000Z',
      passed: true,
      findings: ['Post-capture mutation must be rejected.'],
    }),
    /changed since capture/u,
  );
  await writeFile(screenshotPaths.at(-1), pngScreenshotFixture(screenshotPaths.length - 1));
  const finalized = await finalizeSignalLabLiveVisualReview({
    reportPath,
    reviewer: 'visual-reviewer',
    reviewedAt: '2026-07-18T08:03:00.000Z',
    passed: true,
    findings: ['No clipping, overlap, or stale-frame mismatch observed.'],
  });
  assert.equal(finalized.summary.visualContentReviewComplete, true);
  assert.equal(finalized.summary.automatedOk, false);
  assert.equal(finalized.summary.ok, false);
  assert.deepEqual(
    finalized.visualContentReview.automatedScreenshotManifest,
    captureTimeScreenshotManifest,
  );
  assert.equal(finalized.visualContentReview.reviewScreenshotManifest.length, 238);
  assert.ok(finalized.visualContentReview.reviewScreenshotManifest.every(({
    bytes,
    width,
    height,
    distinctColors,
    luminanceRange,
    sha256,
    pixelSha256,
  }) => (
    bytes > 0
      && width === 8
      && height === 2
      && distinctColors >= 8
      && luminanceRange >= 8
      && /^[a-f0-9]{64}$/u.test(sha256)
      && /^[a-f0-9]{64}$/u.test(pixelSha256)
  )));
  const persisted = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(persisted.summary.ok, false);
  assert.deepEqual(
    persisted.visualContentReview.reviewScreenshotManifest.map(({ path }) => path),
    screenshotPaths,
  );
  assert.deepEqual(
    persisted.visualContentReview.automatedScreenshotManifest,
    captureTimeScreenshotManifest,
  );
});

test('classification timeout covers canonical Wi-Fi and Bluetooth opportunity windows', () => {
  assert.equal(liveSignalLabClassificationTimeoutMs({ family: 'tone' }), 15_000);
  assert.equal(liveSignalLabClassificationTimeoutMs({ family: 'wlan' }), 60_000);
  assert.equal(liveSignalLabClassificationTimeoutMs({ family: 'bluetooth' }), 120_000);
  assert.equal(liveSignalLabClassificationTimeoutMs({ family: 'wlan' }, 90_000), 90_000);
  assert.equal(liveSignalLabRequiredClassificationOpportunities({ id: 'cw', family: 'tone' }), 32);
  assert.equal(liveSignalLabRequiredClassificationOpportunities({ id: 'lte-etm3.1', family: 'e-utra' }), 8);
  assert.equal(liveSignalLabRequiredClassificationOpportunities({ id: 'wifi6-he-su', family: 'wlan' }), 32);
  assert.equal(liveSignalLabRequiredClassificationOpportunities({ id: 'bluetooth-le-advertising', family: 'bluetooth' }), 96);

  const staticAcceptance = { autoTargetPersistenceSweeps: 8 };
  assert.equal(liveSignalLabClassificationEvidenceSatisfied(
    { id: 'cw', family: 'tone' },
    staticAcceptance,
    32,
  ), true);
  assert.equal(liveSignalLabClassificationEvidenceSatisfied(
    { id: 'cw', family: 'tone' },
    staticAcceptance,
    31,
  ), false);
  const agileAcceptance = {
    autoTargetPositiveLooks: 8,
    autoTargetOpportunityLooks: 96,
  };
  assert.equal(liveSignalLabClassificationEvidenceSatisfied(
    { id: 'bluetooth-classic-connected', family: 'bluetooth' },
    agileAcceptance,
    96,
  ), true);
  assert.equal(liveSignalLabClassificationEvidenceSatisfied(
    { id: 'bluetooth-classic-connected', family: 'bluetooth' },
    { ...agileAcceptance, autoTargetOpportunityLooks: 95 },
    96,
  ), false);

  assert.equal(liveSignalLabClassificationExpectation(
    { id: 'cw' },
    'CW-like carrier',
  ).compatible, true);
  assert.equal(liveSignalLabClassificationExpectation(
    { id: 'cw' },
    '2.4 GHz agile activity · Bluetooth-compatible',
  ).compatible, false);
  assert.equal(liveSignalLabClassificationExpectation(
    { id: 'lte-band3-fdd-20m' },
    'OFDM-shaped · LTE/NR-compatible',
  ).compatible, true);
  assert.equal(liveSignalLabClassificationExpectation(
    { id: 'lte-band3-fdd-20m' },
    'LTE FDD-like',
  ).compatible, false);
  assert.equal(liveSignalLabClassificationExpectation(
    { id: 'nr-n78-tdd-100m' },
    '5G NR TDD-like',
  ).compatible, true);
  assert.equal(liveSignalLabClassificationExpectation(
    { id: 'nr-n78-tdd-100m' },
    'OFDM-shaped · LTE/NR-compatible',
  ).compatible, false);
  assert.equal(liveSignalLabClassificationExpectation(
    { id: 'lte-etm3.1' },
    'OFDM-shaped · LTE/NR-compatible',
  ).compatible, null);
  const unvalidatedUnknown = liveSignalLabClassificationExpectation(
    { id: 'lte-etm3.1' },
    'Unknown',
  );
  assert.equal(unvalidatedUnknown.known, false);
  assert.equal(unvalidatedUnknown.compatible, null);
  assert.equal(unvalidatedUnknown.oracleStatus, 'classification-oracle-unvalidated');
  assert.equal(unvalidatedUnknown.claim, 'classification-oracle-unvalidated');
});

test('live evidence preserves the actual Computer Use screenshot encoding', () => {
  assert.equal(screenshotArtifactExtension('file:///tmp/atomizer.jpg'), '.jpg');
  assert.equal(screenshotArtifactExtension('file:///tmp/atomizer.JPEG'), '.jpeg');
  assert.equal(screenshotArtifactExtension('file:///tmp/atomizer.png'), '.png');
  assert.throws(
    () => screenshotArtifactExtension('file:///tmp/atomizer.webp'),
    /Unsupported Computer Use screenshot extension/u,
  );
});

test('Detect embedded plot is not mistaken for the standalone Spectrum workspace', () => {
  const detect = [
    'button Spectrum',
    'button Detect',
    'container Spectrum plot',
    'text Evidence',
    'text Detection',
  ].join('\n');
  const spectrum = [
    'button Spectrum',
    'toolbar Measurement utilities',
    'button Sweep setup',
    'button Traces & markers',
    'container Spectrum plot',
  ].join('\n');

  assert.equal(liveWorkspaceIsVisible(detect, 'Detect'), true);
  assert.equal(liveWorkspaceIsVisible(detect, 'Spectrum'), false);
  assert.equal(liveWorkspaceIsVisible(spectrum, 'Spectrum'), true);
  assert.equal(liveWorkspaceIsVisible('44 text Instrument source', 'Device'), true);
  assert.equal(liveWorkspaceIsVisible('44 button Device', 'Device'), false);
});

test('exact button matching does not confuse Peak with Peak tracking', () => {
  assert.equal(liveButtonIsEnabled('button Peak', 'Peak'), true);
  assert.equal(liveButtonIsEnabled('button Peak, Help: Move M1', 'Peak'), true);
  assert.equal(liveButtonIsEnabled('button Peak tracking Off', 'Peak'), false);
  assert.equal(liveButtonIsEnabled('button Peak (disabled)', 'Peak'), false);
});

test('Marker 1 Normal readout guard rejects persisted Delta and noise-density modes', () => {
  const markerOne = '41 button Marker 1, visible, selected';
  assert.equal(liveMarkerM1ReadoutIsNormal([
    markerOne,
    '42 pop up button Description: Readout, Value: Normal',
  ].join('\n')), true);
  assert.equal(liveMarkerM1ReadoutIsNormal([
    markerOne,
    '42 pop up button Description: Readout, Value: Delta',
  ].join('\n')), false);
  assert.equal(liveMarkerM1ReadoutIsNormal([
    markerOne,
    '42 pop up button Description: Readout, Value: Noise density',
  ].join('\n')), false);
  assert.equal(liveMarkerM1ReadoutIsNormal([
    '41 button Marker 2, visible, selected',
    '42 pop up button Description: Readout, Value: Normal',
  ].join('\n')), false);
});

test('Peak marker freshness binds a cleared M1 reading to the newly acquired sweep', () => {
  const previous = liveSweepIdentitySummary(
    '12 region Spectrum plot, Description: sweepId=sweep-41; sequence=41',
  );
  const current = liveSweepIdentitySummary(
    '12 region Spectrum plot, Description: sweepId=sweep-42; sequence=42',
  );
  const marker = liveMarkerSummary([
    '21 text M 1 · NORMAL',
    '22 text -31.4 dBm',
    '23 text 98.000 MHz',
    '24 group Marker M1 current reading, Description: sourceSweepId=sweep-42',
  ].join('\n'));
  assert.equal(marker.powerDbm, -31.4);
  assert.equal(validateFreshMarkerEvidence(
    previous,
    current,
    marker,
    { markerWasHidden: true, markerVisible: true },
  ).status, 'fresh-current-sweep-marker-validated');
  assert.throws(
    () => validateFreshMarkerEvidence(
      previous,
      current,
      { ...marker, powerDbm: null },
      { markerWasHidden: true, markerVisible: true },
    ),
    /omitted its fresh finite M1 power/u,
  );
  assert.throws(
    () => validateFreshMarkerEvidence(
      previous,
      current,
      { ...marker, powerDbm: Number.NaN },
      { markerWasHidden: true, markerVisible: true },
    ),
    /omitted its fresh finite M1 power/u,
  );
  const powerOutsideM1Readout = liveMarkerSummary([
    '21 text M 1 · NORMAL',
    '22 text 98.000 MHz',
    '23 group Marker M1 current reading, Description: sourceSweepId=sweep-42',
    '24 text No current power',
    '25 text Unrelated candidate -12.0 dBm',
  ].join('\n'));
  assert.equal(powerOutsideM1Readout.powerDbm, null);
  assert.throws(
    () => validateFreshMarkerEvidence(
      previous,
      current,
      powerOutsideM1Readout,
      { markerWasHidden: true, markerVisible: true },
    ),
    /omitted its fresh finite M1 power/u,
  );
  assert.throws(
    () => validateFreshMarkerEvidence(
      previous,
      { ...current, sweepId: previous.sweepId },
      marker,
      { markerWasHidden: true, markerVisible: true },
    ),
    /reused stale sweep/u,
  );
  assert.throws(
    () => validateFreshMarkerEvidence(
      previous,
      { ...current, sequence: previous.sequence },
      marker,
      { markerWasHidden: true, markerVisible: true },
    ),
    /sequence did not advance/u,
  );
  assert.throws(
    () => validateFreshMarkerEvidence(
      previous,
      current,
      { ...marker, sourceSweepId: 'sweep-41' },
      { markerWasHidden: true, markerVisible: true },
    ),
    /did not match current sweep/u,
  );
  assert.throws(
    () => validateFreshMarkerEvidence(
      previous,
      current,
      marker,
      { markerWasHidden: false, markerVisible: true },
    ),
    /was not cleared/u,
  );

  const global = (sweepId, sequence) => (
    `1 container Acquisition controls, Description: DEV ACQUISITION LANDMARK; controls=Stop; sweepId=${sweepId}; sequence=${sequence}`
  );
  const local = (sweepId, sequence) => (
    `2 region Spectrum plot, Description: sweepId=${sweepId}; sequence=${sequence}`
  );
  const matching = `${global('sweep-42', 42)}\n${local('sweep-42', 42)}`;
  assert.deepEqual(liveSweepIdentitySummary(matching), { sweepId: 'sweep-42', sequence: 42 });
  assert.equal(liveGlobalSweepIdentitySummary(matching).sequence, 42);
  assert.doesNotThrow(() => validateGlobalSweepMatchesSpectrum(matching, 'fixture'));

  const globalFirstStaleLocal = `${global('sweep-43', 43)}\n${local('sweep-42', 42)}`;
  assert.deepEqual(liveSweepIdentitySummary(globalFirstStaleLocal), {
    sweepId: 'sweep-42',
    sequence: 42,
  });
  assert.throws(
    () => validateGlobalSweepMatchesSpectrum(globalFirstStaleLocal, 'stale local fixture'),
    /did not match the mounted Spectrum plot identity/u,
  );
  assert.throws(
    () => validateGlobalSweepMatchesSpectrum(global('sweep-43', 43), 'missing local fixture'),
    /did not match the mounted Spectrum plot identity/u,
  );
  assert.throws(
    () => validateGlobalSweepMatchesSpectrum(
      `${global('sweep-42', 43)}\n${local('sweep-42', 42)}`,
      'mismatched sequence fixture',
    ),
    /did not match the mounted Spectrum plot identity/u,
  );
});

test('I/Q local capture absence checks disabled and enabled controls', () => {
  assert.equal(liveButtonExists('12 button Capture I/Q', 'Capture I/Q'), true);
  assert.equal(liveButtonExists('12 button Capture I/Q (disabled)', 'Capture I/Q'), true);
  assert.equal(liveButtonExists('12 button Capture envelope', 'Capture I/Q'), false);
});

test('live layout contract requires one sidebar route and one global acquisition surface', () => {
  const stopped = [
    '1 container Acquisition controls, Description: DEV ACQUISITION LANDMARK; controls=Run,Single; sweepId=none; sequence=none',
    '2 button Spectrum, selected',
    '3 button Waterfall',
    '4 button Channel',
    '5 button I/Q',
    '6 button Detect',
    '7 button Generate',
    '8 button Device',
    '9 button Run',
    '10 button Single',
  ].join('\n');
  assert.deepEqual(liveLayoutContractSummary(stopped).acquisitionCounts, {
    run: 1,
    single: 1,
    stop: 0,
  });
  assert.equal(liveLayoutContractSummary(stopped).acquisitionLandmarkCount, 1);
  assert.equal(liveLayoutContractSummary(stopped).acquisitionLandmarkPrecedesControls, true);
  assert.equal(liveLayoutContractSummary(stopped).acquisitionLandmarkControlBinding, true);
  assert.doesNotThrow(() => validateLiveLayoutContract(stopped));
  const running = stopped
    .replace('controls=Run,Single', 'controls=Stop')
    .replace('sweepId=none; sequence=none', 'sweepId=sweep-42; sequence=42')
    .replace('9 button Run\n10 button Single', '9 button Stop');
  assert.doesNotThrow(() => validateLiveLayoutContract(running, { running: true }));
  assert.throws(
    () => validateLiveLayoutContract(`${stopped}\n11 tab Spectrum`),
    /Spectrum=2/u,
  );
  assert.throws(
    () => validateLiveLayoutContract(stopped.replace(
      '2 button Spectrum, selected\n3 button Waterfall',
      '2 button Waterfall\n3 button Spectrum, selected',
    )),
    /route order changed/u,
  );
  assert.throws(
    () => validateLiveLayoutContract(`${stopped}\n11 button Time \/ STFT \(disabled\)`),
    /Removed navigation resurfaced/u,
  );
  assert.throws(
    () => validateLiveLayoutContract(`${stopped}\n11 button Capture I\/Q \(disabled\)`),
    /redundant local capture control/u,
  );
  assert.throws(
    () => validateLiveLayoutContract(`${stopped}\n11 button Run`),
    /not unique/u,
  );
  assert.throws(
    () => validateLiveLayoutContract(stopped.replace(
      '1 container Acquisition controls, Description: DEV ACQUISITION LANDMARK; controls=Run,Single; sweepId=none; sequence=none\n',
      '',
    )),
    /landmark must occur exactly once; observed 0/u,
  );
  assert.throws(
    () => validateLiveLayoutContract(`${stopped}\n11 region Acquisition controls`),
    /landmark must occur exactly once; observed 2/u,
  );
  assert.throws(
    () => validateLiveLayoutContract(
      `${stopped.replace(
        '1 container Acquisition controls, Description: DEV ACQUISITION LANDMARK; controls=Run,Single; sweepId=none; sequence=none\n',
        '',
      )}\n11 container Acquisition controls, Description: DEV ACQUISITION LANDMARK; controls=Run,Single; sweepId=none; sequence=none`,
    ),
    /not nested after the Acquisition controls landmark/u,
  );
  assert.throws(
    () => validateLiveLayoutContract(stopped.replace(
      'DEV ACQUISITION LANDMARK; controls=Run,Single',
      'DEV ACQUISITION LANDMARK; controls=Stop',
    )),
    /omitted its development child-control binding/u,
  );
});

test('Waterfall live evidence rejects one-row and one-color canvases', () => {
  const text = [
    '21 image Measured power by frequency and sweep time, Description: rows=3; bins=450; colors=37; minDbm=-112.4; maxDbm=-31.2',
    '22 text 3 / 35 COHERENT',
    '23 text COHERENT HISTORY',
    '24 text 3 / 35',
  ].join('\n');
  const summary = liveWaterfallSummary(text);
  assert.equal(summary.coherentRows, 3);
  assert.equal(summary.renderedBins, 450);
  assert.equal(summary.renderedColors, 37);
  assert.equal(
    validateLiveWaterfallEvidence(summary, { id: 'cw' }).status,
    'coherent-nondegenerate-render-input-validated',
  );
  assert.throws(
    () => validateLiveWaterfallEvidence(liveWaterfallSummary(
      text.replaceAll('rows=3', 'rows=1').replaceAll('3 / 35', '1 / 35'),
    )),
    /at least two coherent rows/u,
  );
  assert.throws(
    () => validateLiveWaterfallEvidence(liveWaterfallSummary(
      text.replace('colors=37', 'colors=1'),
    )),
    /blank or degenerate/u,
  );
});

test('I/Q live evidence anchors plots, metrics, nonzero preview, and scaling', () => {
  const text = [
    '31 group I/Q plot scale',
    '32 button Zoom I/Q plots out',
    '33 button Fit I/Q plots to capture (disabled)',
    '34 button Zoom I/Q plots in',
    '35 text 1×, Description: I/Q plot zoom',
    '36 image I and Q sample amplitude over capture time',
    '37 image Complex I Q constellation preview',
    '38 text Samples',
    '39 text 16,384',
    '40 text Duration',
    '41 text 1.25 ms',
    '42 text Preview RMS',
    '43 text -18.25 dBFS',
    '44 text Preview peak',
    '45 text -2.50 dBFS',
    '46 text Capture 12345678-1234-1234-1234-123456789abc · measured',
    '47 text 4,096 evenly sampled preview points',
    '48 region Complex I/Q workspace, Description: captureId=12345678-1234-1234-1234-123456789abc; sequence=42; centerHz=98000000',
  ].join('\n');
  const summary = liveIqSummary(text);
  assert.deepEqual({
    samples: summary.samples,
    previewPoints: summary.previewPoints,
    zoom: summary.zoom,
    rms: summary.previewRmsDbfs,
    peak: summary.previewPeakDbfs,
    sequence: summary.captureSequence,
    centerHz: summary.captureCenterHz,
  }, {
    samples: 16_384,
    previewPoints: 4_096,
    zoom: '1×',
    rms: -18.25,
    peak: -2.5,
    sequence: 42,
    centerHz: 98_000_000,
  });
  assert.equal(
    validateLiveIqEvidence(summary, { id: 'lte-etm3.1' }).status,
    'nondegenerate-capture-and-scaling-validated',
  );
  assert.throws(
    () => validateLiveIqEvidence(liveIqSummary(text.replace('-2.50 dBFS', '-30.00 dBFS'))),
    /peak below RMS/u,
  );
  assert.throws(
    () => validateLiveIqEvidence(liveIqSummary(text.replace('-18.25 dBFS', '−∞ dBFS'))),
    /zero, non-finite/u,
  );
  assert.throws(
    () => validateLiveIqEvidence(liveIqSummary(
      text.replace('35 text 1×, Description: I/Q plot zoom', '35 text 1×'),
    )),
    /anchored plot-scaling/u,
  );
  const missingRmsValue = text.replace('43 text -18.25 dBFS\n', '');
  assert.equal(liveIqSummary(missingRmsValue).previewRmsDbfs, null);
  assert.equal(liveIqSummary(missingRmsValue).previewPeakDbfs, -2.5);
  assert.throws(
    () => validateLiveIqEvidence(liveIqSummary(missingRmsValue)),
    /preview is zero, non-finite/u,
  );
  const adjacentMisorderedValues = text.replace([
    '42 text Preview RMS',
    '43 text -18.25 dBFS',
    '44 text Preview peak',
    '45 text -2.50 dBFS',
  ].join('\n'), [
    '42 text Preview RMS',
    '44 text Preview peak',
    '45 text -2.50 dBFS',
    '46 text -18.25 dBFS',
  ].join('\n'));
  assert.equal(liveIqSummary(adjacentMisorderedValues).previewRmsDbfs, null);
  assert.equal(liveIqSummary(adjacentMisorderedValues).previewPeakDbfs, -2.5);
  assert.throws(
    () => validateLiveIqEvidence(liveIqSummary(adjacentMisorderedValues)),
    /preview is zero, non-finite/u,
  );
  const reversedMetricPairs = text.replace([
    '42 text Preview RMS',
    '43 text -18.25 dBFS',
    '44 text Preview peak',
    '45 text -2.50 dBFS',
  ].join('\n'), [
    '42 text Preview peak',
    '43 text -2.50 dBFS',
    '44 text Preview RMS',
    '45 text -18.25 dBFS',
  ].join('\n'));
  assert.equal(liveIqSummary(reversedMetricPairs).metricOrderValid, false);
  assert.throws(
    () => validateLiveIqEvidence(liveIqSummary(reversedMetricPairs)),
    /metrics are missing, duplicated, or misordered/u,
  );
  const exactCombinedMetrics = text.replace([
    '42 text Preview RMS',
    '43 text -18.25 dBFS',
    '44 text Preview peak',
    '45 text -2.50 dBFS',
  ].join('\n'), [
    '42 text Preview RMS -18.25 dBFS',
    '44 text Preview peak -2.50 dBFS',
  ].join('\n'));
  assert.equal(liveIqSummary(exactCombinedMetrics).previewRmsDbfs, -18.25);
  assert.equal(liveIqSummary(exactCombinedMetrics).previewPeakDbfs, -2.5);
  assert.doesNotThrow(() => validateLiveIqEvidence(liveIqSummary(exactCombinedMetrics)));
  const profile = { id: 'lte-etm3.1', centerHz: 98_000_000 };
  const previous = {
    captureId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    captureSequence: 41,
  };
  assert.equal(
    validateFreshIqCapture(previous, summary, profile).status,
    'fresh-current-profile-capture-validated',
  );
  assert.throws(
    () => validateFreshIqCapture(
      { ...previous, captureId: summary.captureId },
      summary,
      profile,
    ),
    /reused stale capture ID/u,
  );
  assert.throws(
    () => validateFreshIqCapture(
      { ...previous, captureSequence: summary.captureSequence },
      summary,
      profile,
    ),
    /did not advance its capture sequence/u,
  );
  assert.throws(
    () => validateFreshIqCapture(previous, { ...summary, captureCenterHz: 99_000_000 }, profile),
    /did not match 98000000 Hz/u,
  );
});

test('Detect acceptance binds Auto-most-prominent, its target, and no inner scroll', () => {
  const accepted = [
    '099 text BAYESIAN EVIDENCE CLASS · NOT PROTOCOL',
    '100 heading LTE, 2',
    '101 text Evidence',
    '102 text Detection',
    '103 toggle button Auto · most prominent (pressed)',
    '104 text Capture sweep-42 · Detect 2 active · 0 qualifying Classify LTE 98%',
    '105 text 01',
    '106 text 947.400 MHz',
    '107 text ACTIVE · -22.4 dBm · 10.0 MHz',
    '108 text integrated excess -22.4 dBm · 37 cells · AUTO TARGET · bayesian-signal-detector-v1 · 8 sweeps · 0 missed',
    '109 text LTE',
  ].join('\n');
  const summary = liveDetectAcceptanceSummary(accepted);
  assert.equal(summary.autoControl, 'toggle button Auto · most prominent (pressed)');
  assert.equal(summary.autoControlPressed, true);
  assert.equal(summary.autoTargetCount, 1);
  assert.equal(summary.autoTargetRank, 1);
  assert.equal(summary.autoTargetIntegratedExcessDbm, -22.4);
  assert.equal(summary.autoTargetSupportCellCount, 37);
  assert.equal(summary.autoTargetPersistenceSweeps, 8);
  assert.equal(summary.autoTargetEvidenceValid, true);
  assert.equal(summary.autoTargetIsMaximumIntegratedExcess, true);
  assert.equal(summary.candidateRanking.rankingEvidenceComplete, true);
  assert.equal(liveDetectCandidateRankingSummary(accepted).candidates.length, 1);
  assert.equal(summary.autoClassification, 'LTE 98%');
  assert.equal(summary.autoTargetClassificationLabel, 'LTE');
  assert.equal(summary.autoClassificationResultLabel, 'LTE');
  assert.equal(summary.autoClassificationResultQualification, 'BAYESIAN EVIDENCE CLASS · NOT PROTOCOL');
  assert.equal(summary.autoClassificationResultLinked, true);
  assert.equal(summary.autoClassificationResolved, true);
  assert.equal(summary.autoAcceptanceComplete, true);
  assert.match(summary.autoTargetSegment, /text 01.*AUTO TARGET.*text LTE/u);
  assert.deepEqual(summary.innerScrollElements, []);
  assert.equal(summary.hasInnerScroll, false);

  assert.equal(liveDetectAcceptanceSummary(accepted.replace('(pressed)', '')).autoAcceptanceComplete, false);
  assert.equal(liveDetectAcceptanceSummary(accepted.replace('text 01', 'text A01')).autoAcceptanceComplete, true);
  assert.equal(liveDetectAcceptanceSummary(accepted.replace('text 01', 'text 02')).autoAcceptanceComplete, false);
  assert.equal(liveDetectAcceptanceSummary(accepted.replace('integrated excess -22.4 dBm', 'integrated excess unavailable')).autoAcceptanceComplete, false);
  assert.equal(liveDetectAcceptanceSummary(accepted.replace('37 cells', '0 cells')).autoAcceptanceComplete, false);
  assert.equal(liveDetectAcceptanceSummary(accepted.replace('Classify LTE 98%', 'Classify No result')).autoAcceptanceComplete, false);
  assert.equal(liveDetectAcceptanceSummary(accepted.replace('109 text LTE', '109 text Bluetooth')).autoAcceptanceComplete, false);
  assert.equal(liveDetectAcceptanceSummary(accepted.replace('100 heading LTE, 2', '100 heading Bluetooth, 2')).autoAcceptanceComplete, false);
  assert.equal(liveDetectAcceptanceSummary(accepted.replace('099 text BAYESIAN EVIDENCE CLASS · NOT PROTOCOL', '')).autoAcceptanceComplete, false);
  assert.equal(liveDetectAcceptanceSummary(accepted.replace(
    'BAYESIAN EVIDENCE CLASS · NOT PROTOCOL',
    'MEASURED WAVEFORM HYPOTHESIS',
  )).autoAcceptanceComplete, false);
  assert.equal(liveDetectAcceptanceSummary(`${accepted}\n110 text integrated excess -30.0 dBm · 4 cells · AUTO TARGET`).autoAcceptanceComplete, false);
  const visiblyStrongerNonAuto = `${accepted}\n110 text 02\n111 text integrated excess -10.0 dBm · 9 cells`;
  assert.equal(
    liveDetectAcceptanceSummary(visiblyStrongerNonAuto).autoTargetIsMaximumIntegratedExcess,
    false,
  );
  assert.equal(liveDetectAcceptanceSummary(visiblyStrongerNonAuto).autoAcceptanceComplete, false);
  const hiddenAgileWinnerRegression = accepted.replace(
    'toggle button Auto · most prominent (pressed)',
    'toggle button Auto · most prominent (pressed), Description: DEV RANK POPULATION; winner=physical-1; candidate=physical-1,raw=physical-1,power=-22.4 dBm,cells=37; candidate=agile-1,raw=physical-2,power=-10.0 dBm,cells=9',
  );
  assert.equal(
    liveDetectCandidateRankingSummary(hiddenAgileWinnerRegression).evidenceSource,
    'development-complete-rank-population',
  );
  assert.equal(
    liveDetectAcceptanceSummary(hiddenAgileWinnerRegression).autoTargetIsMaximumIntegratedExcess,
    false,
  );
  const intentionalCandidateScroll = `${accepted}\n110 vertical scroll bar Evidence candidate rows`;
  assert.equal(liveDetectAcceptanceSummary(intentionalCandidateScroll).hasInnerScroll, false);
  assert.deepEqual(
    liveDetectAcceptanceSummary(intentionalCandidateScroll).scrollElements,
    ['vertical scroll bar Evidence candidate rows'],
  );
  const forbiddenWorkspaceScroll = `${accepted}\n110 vertical scroll bar Detected-power evidence status workspace`;
  assert.equal(liveDetectAcceptanceSummary(forbiddenWorkspaceScroll).hasInnerScroll, true);
  assert.deepEqual(
    liveDetectAcceptanceSummary(forbiddenWorkspaceScroll).forbiddenInnerScrollElements,
    ['vertical scroll bar Detected-power evidence status workspace'],
  );

  const collapsedRow = [
    '099 text BAYESIAN EVIDENCE CLASS · NOT PROTOCOL',
    '100 heading GSM / GERAN-like, 2',
    '101 text Evidence',
    '102 text Detection',
    '103 toggle button Auto · most prominent (pressed)',
    '104 text Capture sweep-42 · Detect 1 active · 0 qualifying Classify bayesian-observable-equivalence-v8',
    '105 button 01 947.400 MHz ACTIVE · -22.4 dBm · integrated excess -22.4 dBm · 37 cells · AUTO TARGET · bayesian-signal-detector-v1 · 8 sweeps · 0 missed GSM / GERAN-like',
  ].join('\n');
  const collapsed = liveDetectAcceptanceSummary(collapsedRow);
  assert.equal(collapsed.autoTargetRank, 1);
  assert.equal(collapsed.autoTargetClassificationLabel, 'GSM / GERAN-like');
  assert.equal(collapsed.autoClassificationResultLinked, true);
  assert.equal(collapsed.autoAcceptanceComplete, true);
});

test('marker acceptance parses finite peak, 3 dB, and component-OBW evidence', () => {
  assert.deepEqual(
    liveSignalLabMarkerExpectation({ id: 'cw' }).allowedWidthClassifications,
    ['resolution-limited-narrow'],
  );
  assert.deepEqual(
    liveSignalLabMarkerExpectation({ id: 'lte-etm1.1' }).allowedWidthClassifications,
    ['resolved-wideband'],
  );
  assert.deepEqual(
    liveSignalLabMarkerExpectation({ id: 'wifi6-he-mu' }).allowedWidthClassifications,
    ['unavailable'],
  );
  assert.deepEqual(
    liveSignalLabMarkerExpectation({ id: 'wifi6-he-mu' }).allowedUnavailableReasons,
    [
      'nonmonotone-half-power-response',
      'no-qualified-local-component',
      'insufficient-local-prominence',
    ],
  );
  assert.deepEqual(
    liveSignalLabMarkerExpectation({ id: 'bluetooth-classic-connected' })
      .allowedWidthClassifications,
    ['resolution-limited-narrow', 'resolved-wideband', 'unavailable'],
  );
  const narrowText = [
    '201 text M 1 · NORMAL',
    '202 text -31.4 dBm',
    '203 text 98.000 MHz',
    '204 section Marker M1 local characterization',
    '205 text Narrow · resolution limited',
    '206 text 3 dB response width',
    '207 text 686 Hz',
    '208 text 97.999657 MHz – 98.000343 MHz',
    '209 text 99% component occupied bandwidth',
    '210 text 1.95 kHz',
    '211 text 97.999025 MHz – 98.000975 MHz · robust-floor subtracted',
    '212 text Signal / noise context',
  ].join('\n');
  const marker = liveMarkerSummary(narrowText);
  const narrow = liveMarkerCharacterizationSummary(narrowText);
  assert.equal(marker.frequencyHz, 98_000_000);
  assert.equal(marker.powerDbm, -31.4);
  assert.deepEqual({
    widthClassification: narrow.widthClassification,
    threeDecibelStatus: narrow.threeDecibelStatus,
    threeDecibelBandwidthHz: narrow.threeDecibelBandwidthHz,
    componentOccupiedBandwidthStatus: narrow.componentOccupiedBandwidthStatus,
    componentOccupiedBandwidthHz: narrow.componentOccupiedBandwidthHz,
  }, {
    widthClassification: 'resolution-limited-narrow',
    threeDecibelStatus: 'resolution-limited',
    threeDecibelBandwidthHz: 686,
    componentOccupiedBandwidthStatus: 'measured',
    componentOccupiedBandwidthHz: 1_950,
  });
  assert.doesNotThrow(() => validateLiveMarkerEvidence(
    marker,
    narrow,
    { id: 'cw', centerHz: 98_000_000, recommendedSpanHz: 200_000 },
    'resolution-limited-narrow',
  ));
  assert.throws(
    () => validateLiveMarkerEvidence(
      { ...marker, powerDbm: null },
      narrow,
      { id: 'cw', centerHz: 98_000_000, recommendedSpanHz: 200_000 },
      'resolution-limited-narrow',
    ),
    /omitted a finite parsed marker power/u,
  );
  assert.throws(
    () => validateLiveMarkerEvidence(
      { ...marker, powerDbm: Number.NaN },
      narrow,
      { id: 'cw', centerHz: 98_000_000, recommendedSpanHz: 200_000 },
      'resolution-limited-narrow',
    ),
    /omitted a finite parsed marker power/u,
  );
  const collapsedMarkerText = [
    '201 text M 1 · NORMAL -31.4 dBm 98.000 MHz',
    '204 section Marker M1 local characterization',
    '205 text Narrow · resolution limited',
    '206 text 3 dB response width 686 Hz 97.999657 MHz – 98.000343 MHz',
    '209 text 99% component occupied bandwidth 1.95 kHz 97.999025 MHz – 98.000975 MHz · robust-floor subtracted',
    '212 text Signal / noise context',
  ].join('\n');
  assert.doesNotThrow(() => validateLiveMarkerEvidence(
    liveMarkerSummary(collapsedMarkerText),
    liveMarkerCharacterizationSummary(collapsedMarkerText),
    { id: 'cw', centerHz: 98_000_000, recommendedSpanHz: 200_000 },
    'resolution-limited-narrow',
  ));
  assert.throws(
    () => validateLiveMarkerEvidence(
      marker,
      {
        ...narrow,
        threeDecibelBandwidthHz: 200_000,
        threeDecibelStartHz: 97_900_000,
        threeDecibelStopHz: 98_100_000,
      },
      { id: 'cw', centerHz: 98_000_000, recommendedSpanHz: 200_000 },
      'resolution-limited-narrow',
    ),
    /not bounded below 90%|not a narrow grid-limited response/u,
  );
  assert.throws(
    () => validateLiveMarkerEvidence(
      marker,
      {
        ...narrow,
        threeDecibelBandwidthHz: 20_000,
        threeDecibelStartHz: 97_990_000,
        threeDecibelStopHz: 98_010_000,
      },
      { id: 'cw', centerHz: 98_000_000, recommendedSpanHz: 200_000 },
      'resolution-limited-narrow',
    ),
    /not a narrow grid-limited response/u,
  );
  assert.throws(
    () => validateLiveMarkerEvidence(
      marker,
      {
        ...narrow,
        componentOccupiedBandwidthHz: 200_000,
        componentOccupiedBandwidthStartHz: 97_900_000,
        componentOccupiedBandwidthStopHz: 98_100_000,
      },
      { id: 'cw', centerHz: 98_000_000, recommendedSpanHz: 200_000 },
      'resolution-limited-narrow',
    ),
    /not bounded below 90%/u,
  );

  const wideText = narrowText
    .replace('Narrow · resolution limited', 'Resolved local response · >2 resolution elements')
    .replace('686 Hz', '9.8 MHz')
    .replace('97.999657 MHz – 98.000343 MHz', '93.100 MHz – 102.900 MHz')
    .replace('1.95 kHz', '18.2 MHz')
    .replace('97.999025 MHz – 98.000975 MHz', '88.900 MHz – 107.100 MHz')
    .concat('\n213 text noise-subtracted linear-power center (98.000 MHz centroid)');
  const wideMarker = liveMarkerSummary(wideText);
  const wide = liveMarkerCharacterizationSummary(wideText);
  assert.equal(wide.widthClassification, 'resolved-wideband');
  assert.equal(wide.threeDecibelStatus, 'resolved');
  assert.equal(wide.threeDecibelBandwidthHz, 9_800_000);
  assert.equal(wide.threeDecibelStartHz, 93_100_000);
  assert.equal(wide.threeDecibelStopHz, 102_900_000);
  assert.equal(wide.componentOccupiedBandwidthHz, 18_200_000);
  assert.equal(wideMarker.powerCentroidHz, 98_000_000);
  assert.doesNotThrow(() => validateLiveMarkerEvidence(
    wideMarker,
    wide,
    { id: 'lte-etm3.1', centerHz: 98_000_000, recommendedSpanHz: 40_000_000 },
    'resolved-wideband',
  ));
  for (const [label, characterization] of [
    ['exact-full 3 dB', {
      ...wide,
      threeDecibelBandwidthHz: 40_000_000,
      threeDecibelStartHz: 78_000_000,
      threeDecibelStopHz: 118_000_000,
    }],
    ['near-full 3 dB', {
      ...wide,
      threeDecibelBandwidthHz: 36_100_000,
      threeDecibelStartHz: 79_950_000,
      threeDecibelStopHz: 116_050_000,
    }],
    ['near-full component OBW', {
      ...wide,
      componentOccupiedBandwidthHz: 36_100_000,
      componentOccupiedBandwidthStartHz: 79_950_000,
      componentOccupiedBandwidthStopHz: 116_050_000,
    }],
  ]) {
    assert.throws(
      () => validateLiveMarkerEvidence(
        wideMarker,
        characterization,
        { id: 'lte-etm3.1', centerHz: 98_000_000, recommendedSpanHz: 40_000_000 },
        'resolved-wideband',
      ),
      /not bounded below 90%|not a resolved response/u,
      label,
    );
  }
  assert.throws(
    () => validateLiveMarkerEvidence(
      wideMarker,
      {
        ...wide,
        threeDecibelBandwidthHz: 20_000_000,
        threeDecibelStartHz: 78_000_000,
        threeDecibelStopHz: 98_000_000,
      },
      { id: 'lte-etm3.1', centerHz: 98_000_000, recommendedSpanHz: 40_000_000 },
      'resolved-wideband',
    ),
    /not strictly inside the visible profile span/u,
  );
  assert.throws(
    () => validateLiveMarkerEvidence(
      wideMarker,
      {
        ...wide,
        componentOccupiedBandwidthHz: 5_000_000,
        componentOccupiedBandwidthStartHz: 95_500_000,
        componentOccupiedBandwidthStopHz: 100_500_000,
      },
      { id: 'lte-etm3.1', centerHz: 98_000_000, recommendedSpanHz: 40_000_000 },
      'resolved-wideband',
    ),
    /not coherent with and enclosing its 3 dB response/u,
  );
  assert.throws(
    () => validateLiveMarkerEvidence(
      { ...wideMarker, frequencyHz: 102_000_000, powerCentroidHz: 102_000_000 },
      wide,
      { id: 'lte-etm3.1', centerHz: 98_000_000, recommendedSpanHz: 40_000_000 },
      'resolved-wideband',
    ),
    /missed its independent catalog center/u,
  );
  const incoherentWideText = narrowText
    .replace('Narrow · resolution limited', 'Resolved local response · >2 resolution elements')
    .replace('686 Hz', '9.8 MHz')
    .replace('1.95 kHz', '18.2 MHz')
    .concat('\n213 text noise-subtracted linear-power center (98.000 MHz centroid)');
  assert.throws(
    () => validateLiveMarkerEvidence(
      liveMarkerSummary(incoherentWideText),
      liveMarkerCharacterizationSummary(incoherentWideText),
      { id: 'lte-etm3.1', centerHz: 98_000_000, recommendedSpanHz: 40_000_000 },
      'resolved-wideband',
    ),
    /conflicts with its displayed/u,
  );

  const explicitlyUnavailableText = [
    '201 text M 1 · NORMAL',
    '202 text -31.4 dBm',
    '203 text 98.000 MHz',
    '204 section Marker M1 local characterization',
    '205 text 3 dB unavailable',
    '206 text 3 dB response width',
    '207 text —',
    '208 text No local component clears the robust-floor gate',
    '209 text 99% component occupied bandwidth',
    '210 text 18.2 MHz',
    '211 text 89.000 MHz – 107.000 MHz · robust-floor subtracted',
    '212 text Signal / noise context',
  ].join('\n');
  const explicitlyUnavailable = liveMarkerCharacterizationSummary(explicitlyUnavailableText);
  assert.equal(explicitlyUnavailable.threeDecibelStatus, 'unavailable');
  assert.equal(explicitlyUnavailable.threeDecibelUnavailableReason, 'no-qualified-local-component');
  assert.doesNotThrow(() => validateLiveMarkerEvidence(
    liveMarkerSummary(explicitlyUnavailableText),
    explicitlyUnavailable,
    { id: 'gsm-normal-burst', centerHz: 98_000_000, recommendedSpanHz: 40_000_000 },
  ));
  assert.throws(
    () => validateLiveMarkerEvidence(
      liveMarkerSummary(explicitlyUnavailableText),
      explicitlyUnavailable,
      { id: 'cw', centerHz: 98_000_000, recommendedSpanHz: 40_000_000 },
      'resolution-limited-narrow',
    ),
    /did not match allowed resolution-limited-narrow/u,
  );
  const unavailableWithStaleCentroid = `${explicitlyUnavailableText}\n213 text noise-subtracted linear-power center (98.000 MHz centroid)`;
  assert.throws(
    () => validateLiveMarkerEvidence(
      liveMarkerSummary(unavailableWithStaleCentroid),
      liveMarkerCharacterizationSummary(unavailableWithStaleCentroid),
      { id: 'gsm-normal-burst', centerHz: 98_000_000, recommendedSpanHz: 40_000_000 },
    ),
    /unexpectedly exposed a power centroid/u,
  );

  const nonmonotoneText = explicitlyUnavailableText
    .replace(
      'No local component clears the robust-floor gate',
      'Resolved half-power islands do not identify one contiguous response',
    )
    .concat('\n213 text noise-subtracted linear-power center (98.000 MHz centroid)');
  assert.doesNotThrow(() => validateLiveMarkerEvidence(
    liveMarkerSummary(nonmonotoneText),
    liveMarkerCharacterizationSummary(nonmonotoneText),
    { id: 'wifi6-he-mu', centerHz: 98_000_000, recommendedSpanHz: 40_000_000 },
  ));
  assert.throws(
    () => validateLiveMarkerEvidence(
      liveMarkerSummary(nonmonotoneText.replace(/\n213[^\n]+/u, '')),
      liveMarkerCharacterizationSummary(nonmonotoneText.replace(/\n213[^\n]+/u, '')),
      { id: 'wifi6-he-mu', centerHz: 98_000_000, recommendedSpanHz: 40_000_000 },
    ),
    /omitted its required displayed power centroid/u,
  );

  const labelsOnly = [
    'section Marker M1 local characterization',
    'text Narrow · resolution limited',
    'text 3 dB response width',
    'text —',
    'text 99% component occupied bandwidth',
    'text Requires a prominence-qualified threshold component',
  ].join('\n');
  assert.equal(liveMarkerCharacterizationSummary(labelsOnly).threeDecibelBandwidthHz, null);
  assert.throws(
    () => validateLiveMarkerEvidence(
      marker,
      liveMarkerCharacterizationSummary(labelsOnly),
      { id: 'cw', centerHz: 98_000_000, recommendedSpanHz: 200_000 },
      'resolution-limited-narrow',
    ),
    /did not expose a positive finite value/u,
  );
  assert.throws(
    () => validateLiveMarkerEvidence(
      { ...marker, frequencyHz: 99_000_000 },
      narrow,
      { id: 'cw', centerHz: 98_000_000, recommendedSpanHz: 200_000 },
      'resolution-limited-narrow',
    ),
    /outside cw's recommended visible span/u,
  );
});

test('Computer Use screenshot size evidence reads PNG and JPEG headers exactly', () => {
  assert.equal(SIGNAL_LAB_MINIMUM_SCREENSHOT_WIDTH, 1_280);
  assert.equal(SIGNAL_LAB_MINIMUM_SCREENSHOT_HEIGHT, 720);
  assert.equal(liveScreenshotMeetsMinimum({ width: 1_434, height: 768 }), true);
  assert.equal(liveScreenshotMeetsMinimum({ width: 1_280, height: 720 }), true);
  assert.equal(liveScreenshotMeetsMinimum({ width: 1_279, height: 720 }), false);
  assert.equal(liveScreenshotMeetsMinimum({ width: 1_434, height: 719 }), false);
  const png = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png, 0);
  Buffer.from('IHDR', 'ascii').copy(png, 12);
  png.writeUInt32BE(1_920, 16);
  png.writeUInt32BE(1_100, 20);
  assert.deepEqual(liveScreenshotDimensions(png, '.png'), { width: 1_920, height: 1_100 });

  const jpeg = Buffer.alloc(21);
  jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x35, 0x05, 0xfc]);
  assert.deepEqual(liveScreenshotDimensions(jpeg, '.jpg'), { width: 1_532, height: 821 });
  assert.throws(() => liveScreenshotDimensions(Buffer.alloc(4), '.png'), /truncated or lacks IHDR/u);

  const pixels = livePngPixelEvidence(pngScreenshotFixture(17));
  assert.equal(pixels.width, 8);
  assert.equal(pixels.height, 2);
  assert.equal(pixels.sampledPixels, 16);
  assert.ok(pixels.distinctColors >= 8);
  assert.ok(pixels.luminanceRange >= 8);

  const opaqueRgba = livePngPixelEvidence(pngScreenshotFixture(
    17,
    8,
    2,
    { rgba: true, alpha: 255 },
  ));
  const transparentRgba = livePngPixelEvidence(pngScreenshotFixture(
    17,
    8,
    2,
    { rgba: true, alpha: 0 },
  ));
  assert.notEqual(opaqueRgba.pixelSha256, transparentRgba.pixelSha256);
  assert.equal(transparentRgba.distinctColors, 1);
  assert.equal(transparentRgba.luminanceRange, 0);
  assert.throws(
    () => livePngPixelEvidence(pngScreenshotFixture(1, 8_193, 1)),
    /dimensions exceed the bounded live-evidence decoder/u,
  );
});

test('Atom-open soak defaults to 30 minutes and keeps checkpoints bounded', () => {
  assert.deepEqual(liveSignalLabAtomOpenSoakConfiguration(), {
    durationMs: 30 * 60 * 1_000,
    checkpointIntervalMs: 30_000,
  });
  assert.deepEqual(liveSignalLabAtomOpenSoakConfiguration({
    durationMs: 2_000,
    checkpointIntervalMs: 250,
  }), {
    durationMs: 2_000,
    checkpointIntervalMs: 250,
  });
  assert.throws(
    () => liveSignalLabAtomOpenSoakConfiguration({
      durationMs: 1_000,
      checkpointIntervalMs: 1_000,
    }),
    /shorter than durationMs/u,
  );
  const mib = 1_024 * 1_024;
  const rendererMemorySamples = [400, 402, 401, 403, 404, 405, 404, 406]
    .map((value, index) => ({
      bytes: value * mib,
      source: 'electron-renderer-log',
      capturedAt: new Date(Date.UTC(2026, 6, 18, 8, 0, index + 1)).toISOString(),
      identity: 'pid:91500',
      checkpoint: index === 0
        ? 'soak-start'
        : index === 7
          ? 'soak-complete'
          : 'soak-profile-complete',
    }));
  const report = {
    startedAt: '2026-07-18T08:00:00.000Z',
    completedAt: '2026-07-18T08:00:10.000Z',
    configuration: { durationMs: 2_000, checkpointIntervalMs: 250 },
    initialSequence: 10,
    finalSequence: 18,
    monotonicTiming: {
      startedMilliseconds: 500,
      completedMilliseconds: 2_500.5,
      elapsedMilliseconds: 2_000.5,
    },
    checkpoints: Array.from({ length: 8 }, (_, index) => ({
      checkpoint: index + 1,
      route: ['Waterfall', 'Channel', 'I/Q', 'Detect', 'Spectrum'][index % 5],
      fromSequence: 10 + index,
      sequence: 11 + index,
      elapsedMilliseconds: (index + 1) * 250,
      layout: {
        ...COMPLETE_RUNNING_LAYOUT,
        globalSweepIdentity: {
          ...COMPLETE_RUNNING_LAYOUT.globalSweepIdentity,
          sweepId: `sweep-${11 + index}`,
          sequence: 11 + index,
        },
      },
      atomPanelOpen: true,
      ...(index === 7 ? { terminal: true } : {}),
    })),
    finalStopSucceeded: true,
    stress: { rendererMemorySamples },
  };
  assert.equal(
    validateSignalLabAtomOpenSoakCompletion(report).status,
    'atom-open-duration-memory-and-final-stop-validated',
  );
  assert.throws(
    () => validateSignalLabAtomOpenSoakCompletion({
      ...report,
      configuration: undefined,
    }),
    /did not meet configured monotonic duration 1800000 ms/u,
  );
  const brokenChain = structuredClone(report);
  brokenChain.checkpoints[3].fromSequence = 99;
  assert.throws(
    () => validateSignalLabAtomOpenSoakCompletion(brokenChain),
    /not a strictly chained advancing sweep/u,
  );
  const nonadvancing = structuredClone(report);
  nonadvancing.checkpoints[3].sequence = nonadvancing.checkpoints[3].fromSequence;
  assert.throws(
    () => validateSignalLabAtomOpenSoakCompletion(nonadvancing),
    /not a strictly chained advancing sweep/u,
  );
  const staleGlobalCheckpoint = structuredClone(report);
  staleGlobalCheckpoint.checkpoints[3].layout.globalSweepIdentity.sequence -= 1;
  assert.throws(
    () => validateSignalLabAtomOpenSoakCompletion(staleGlobalCheckpoint),
    /omitted its expected Detect running-layout or Atom-open evidence/u,
  );
  const wrongRoute = structuredClone(report);
  wrongRoute.checkpoints[2].route = 'Spectrum';
  assert.throws(
    () => validateSignalLabAtomOpenSoakCompletion(wrongRoute),
    /expected I\/Q running-layout or Atom-open evidence/u,
  );
  const missingTerminal = structuredClone(report);
  delete missingTerminal.checkpoints.at(-1).terminal;
  assert.throws(
    () => validateSignalLabAtomOpenSoakCompletion(missingTerminal),
    /exactly one final terminal checkpoint/u,
  );
  const earlyTerminal = structuredClone(report);
  earlyTerminal.checkpoints[2].terminal = true;
  assert.throws(
    () => validateSignalLabAtomOpenSoakCompletion(earlyTerminal),
    /exactly one final terminal checkpoint/u,
  );
  const hiddenAtom = structuredClone(report);
  hiddenAtom.checkpoints[4].atomPanelOpen = false;
  assert.throws(
    () => validateSignalLabAtomOpenSoakCompletion(hiddenAtom),
    /expected Spectrum running-layout or Atom-open evidence/u,
  );
  const stoppedLayout = structuredClone(report);
  stoppedLayout.checkpoints[1].layout = COMPLETE_STOPPED_LAYOUT;
  assert.throws(
    () => validateSignalLabAtomOpenSoakCompletion(stoppedLayout),
    /expected Channel running-layout or Atom-open evidence/u,
  );
  const shortTerminal = structuredClone(report);
  shortTerminal.checkpoints.at(-1).elapsedMilliseconds = 1_999;
  assert.throws(
    () => validateSignalLabAtomOpenSoakCompletion(shortTerminal),
    /terminal checkpoint does not prove the configured duration/u,
  );
  assert.throws(
    () => validateSignalLabAtomOpenSoakCompletion({
      ...report,
      finalStopSucceeded: false,
    }),
    /final global Stop did not complete/u,
  );
  assert.throws(
    () => validateSignalLabAtomOpenSoakCompletion({
      ...report,
      stress: { rendererMemorySamples: [] },
    }),
    /requires at least 8 measured renderer-memory samples/u,
  );
});

test('bounded stress evidence rejects slow controls and missing sweep progression', () => {
  const evidence = {
    actionLatencies: [{ label: 'global Run', latencyMs: 100, ok: true }],
    accessibilitySnapshotLatencies: [{ latencyMs: 50 }],
    sweepProgressions: [
      { kind: 'single', fromSequence: 1, toSequence: 2, completionLatencyMs: 100 },
      {
        kind: 'continuous',
        sequences: [3, 4],
        firstSweepLatencyMs: 100,
        elapsedMs: 500,
        classificationTimeoutMs: 15_000,
        classificationLatencyMs: 1_000,
        stopLatencyMs: 100,
        totalElapsedMs: 1_600,
        classificationEvidence: {
          requiredOpportunities: 32,
          observedSequenceOpportunities: 32,
        },
        sweepRateEvidence: {
          firstObservedSequence: 10,
          lastObservedSequence: 41,
          sequenceDelta: 31,
          observedSequenceOpportunities: 32,
          observationElapsedMs: 3_100,
          millisecondsPerSequenceOpportunity: 100,
        },
        responsivenessTour: {
          routes: [
            { label: 'Waterfall', fromSequence: 20, sequence: 21, enabledControls: ['Edit Color floor'] },
            { label: 'Channel', fromSequence: 21, sequence: 22, enabledControls: ['Edit Center frequency'] },
            { label: 'I/Q', fromSequence: 22, sequence: 23, enabledControls: ['Edit Center frequency'] },
            { label: 'Device', fromSequence: 23, sequence: 25, enabledControls: ['SignalLab profile'] },
            { label: 'Spectrum', fromSequence: 25, sequence: 26, enabledControls: [] },
          ].map((route) => ({
            ...route,
            stopPresent: true,
            controlInteraction: route.label === 'Device'
              ? {
                  status: 'profile-selector-opened-and-cancelled-under-run',
                  profileControlEvidenceBefore: 'pop up button Description: SignalLab profile, Value: cw',
                  profileControlEvidenceAfter: 'pop up button Description: SignalLab profile, Value: cw, focused',
                  profileValueBefore: 'cw',
                  profileValueAfter: 'cw',
                  popupEvidence: {
                    open: true,
                    source: 'native-signal-lab-profile-menu-items',
                    expandedControl: null,
                    nativeProfileOptions: ['cw · 98.000 MHz', 'fm · 98.000 MHz'],
                  },
                  sweepSequenceBeforeInteraction: 24,
                  sweepSequenceAfterInteraction: 25,
                }
              : null,
            acquisitionCounts: { run: 0, single: 0, stop: 1 },
            acquisitionLandmarkCount: 1,
            acquisitionLandmarkPrecedesControls: true,
            acquisitionLandmarkControlBinding: true,
            globalSweepIdentity: {
              evidenceCount: 1,
              valid: true,
              controls: 'Stop',
              sweepId: `sweep-${route.sequence}`,
              sequence: route.sequence,
              evidence: 'DEV ACQUISITION LANDMARK stress fixture',
            },
            routeCounts: COMPLETE_STOPPED_LAYOUT.routeCounts,
          })),
          controls: ['sweep-setup', 'traces-and-markers'],
          elapsedMs: 200,
        },
      },
    ],
  };
  assert.equal(validateLiveStressEvidence(evidence).status, 'control-latency-and-sweep-progression-validated');
  assert.throws(
    () => validateLiveStressEvidence({
      ...evidence,
      actionLatencies: [{ label: 'global Run', latencyMs: 7_001, ok: true }],
    }),
    /violates bound 7000/u,
  );
  assert.throws(
    () => validateLiveStressEvidence({
      ...evidence,
      sweepProgressions: [{ kind: 'continuous', sequences: [3, 3] }],
    }),
    /lacks the required unique sweep progression/u,
  );
  assert.throws(
    () => validateLiveStressEvidence({
      ...evidence,
      sweepProgressions: [{
        ...evidence.sweepProgressions[1],
        firstSweepLatencyMs: 3_001,
      }],
    }),
    /first-sweep latency 3001 ms violates bound 3000/u,
  );
  assert.throws(
    () => validateLiveStressEvidence({
      ...evidence,
      sweepProgressions: [{
        ...evidence.sweepProgressions[1],
        stopLatencyMs: 3_001,
      }],
    }),
    /Stop latency 3001 ms violates bound 3000/u,
  );
  assert.throws(
    () => validateLiveStressEvidence({
      ...evidence,
      sweepProgressions: [{
        ...evidence.sweepProgressions[1],
        responsivenessTour: {
          ...evidence.sweepProgressions[1].responsivenessTour,
          routes: [],
        },
      }],
    }),
    /omitted an advancing active-Run workspace\/control responsiveness tour/u,
  );
  const missingTourLandmark = structuredClone(evidence);
  missingTourLandmark.sweepProgressions[1]
    .responsivenessTour.routes[0].acquisitionLandmarkCount = 0;
  assert.throws(
    () => validateLiveStressEvidence(missingTourLandmark),
    /omitted an advancing active-Run workspace\/control responsiveness tour/u,
  );
  const missingRouteControl = structuredClone(evidence);
  missingRouteControl.sweepProgressions[1]
    .responsivenessTour.routes[0].enabledControls = [];
  assert.throws(
    () => validateLiveStressEvidence(missingRouteControl),
    /omitted an advancing active-Run workspace\/control responsiveness tour/u,
  );
  const mismatchedRouteControl = structuredClone(evidence);
  mismatchedRouteControl.sweepProgressions[1]
    .responsivenessTour.routes[1].enabledControls = ['Edit Color floor'];
  assert.throws(
    () => validateLiveStressEvidence(mismatchedRouteControl),
    /omitted an advancing active-Run workspace\/control responsiveness tour/u,
  );
  const disabledDeviceProfile = structuredClone(evidence);
  disabledDeviceProfile.sweepProgressions[1]
    .responsivenessTour.routes[3].controlInteraction.profileControlEvidenceBefore += ' (disabled)';
  disabledDeviceProfile.sweepProgressions[1]
    .responsivenessTour.routes[3].controlInteraction.profileControlEvidenceAfter += ' (disabled)';
  assert.throws(
    () => validateLiveStressEvidence(disabledDeviceProfile),
    /omitted an advancing active-Run workspace\/control responsiveness tour/u,
  );
  const missingDeviceInteraction = structuredClone(evidence);
  missingDeviceInteraction.sweepProgressions[1]
    .responsivenessTour.routes[3].controlInteraction = null;
  assert.throws(
    () => validateLiveStressEvidence(missingDeviceInteraction),
    /omitted an advancing active-Run workspace\/control responsiveness tour/u,
  );
  const changedDeviceProfile = structuredClone(evidence);
  changedDeviceProfile.sweepProgressions[1]
    .responsivenessTour.routes[3].controlInteraction.profileValueAfter = 'fm';
  assert.throws(
    () => validateLiveStressEvidence(changedDeviceProfile),
    /omitted an advancing active-Run workspace\/control responsiveness tour/u,
  );
  const inertDeviceClick = structuredClone(evidence);
  inertDeviceClick.sweepProgressions[1]
    .responsivenessTour.routes[3].controlInteraction.popupEvidence = {
      open: false,
      source: null,
      expandedControl: null,
      nativeProfileOptions: [],
    };
  assert.throws(
    () => validateLiveStressEvidence(inertDeviceClick),
    /omitted an advancing active-Run workspace\/control responsiveness tour/u,
  );
  const staleDeviceProgression = structuredClone(evidence);
  staleDeviceProgression.sweepProgressions[1]
    .responsivenessTour.routes[3].controlInteraction.sweepSequenceAfterInteraction = 24;
  assert.throws(
    () => validateLiveStressEvidence(staleDeviceProgression),
    /omitted an advancing active-Run workspace\/control responsiveness tour/u,
  );
  const staleGlobalRouteClock = structuredClone(evidence);
  staleGlobalRouteClock.sweepProgressions[1]
    .responsivenessTour.routes[2].globalSweepIdentity.sequence = 22;
  assert.throws(
    () => validateLiveStressEvidence(staleGlobalRouteClock),
    /omitted an advancing active-Run workspace\/control responsiveness tour/u,
  );
  const invalidGlobalRouteEvidence = structuredClone(evidence);
  invalidGlobalRouteEvidence.sweepProgressions[1]
    .responsivenessTour.routes[2].globalSweepIdentity.evidenceCount = 0;
  invalidGlobalRouteEvidence.sweepProgressions[1]
    .responsivenessTour.routes[2].globalSweepIdentity.valid = false;
  assert.throws(
    () => validateLiveStressEvidence(invalidGlobalRouteEvidence),
    /omitted an advancing active-Run workspace\/control responsiveness tour/u,
  );
  assert.throws(
    () => validateLiveStressEvidence({
      ...evidence,
      sweepProgressions: [{
        ...evidence.sweepProgressions[1],
        sweepRateEvidence: {
          ...evidence.sweepProgressions[1].sweepRateEvidence,
          sequenceDelta: 1_000,
        },
      }],
    }),
    /did not bind one elapsed interval to its matching sequence delta/u,
  );
});

test('Atomizer renderer-memory log parser and sampler reject stale replayed records', async () => {
  const record = (capturedAt, workingSetKb) => `${capturedAt} [RENDERER-MEMORY] {
  reason: 'periodic',
  webContentsId: 7,
  osProcessId: 35186,
  metric: {
    type: 'Tab',
    creationTime: 1784363356611.421,
    workingSetKb: ${workingSetKb}
  }
}`;
  const stale = record('2026-07-18T10:00:00.000Z', 168_000);
  const freshOne = record('2026-07-18T10:00:06.000Z', 168_032);
  const freshTwo = record('2026-07-18T10:00:07.000Z', 168_064);
  const truncated = '2026-07-18T10:00:06.500Z [RENDERER-MEMORY] {\n  webContentsId: 7';
  const parsed = parseAtomizerRendererMemoryLog(
    `${stale}\n2026-07-18T10:00:01.000Z [INFO] acquisition started\n${freshOne}\n${truncated}\n${freshTwo}`,
    '/tmp/Atomizer Dev.log',
  );
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[1], {
    bytes: 168_032 * 1_024,
    source: '/tmp/Atomizer Dev.log',
    capturedAt: '2026-07-18T10:00:06.000Z',
    identity: 'webContents:7:pid:35186:created:1784363356611.421',
  });
  assert.equal(parsed[2].capturedAt, '2026-07-18T10:00:07.000Z');

  let nowMs = Date.parse('2026-07-18T10:00:05.000Z');
  let readIndex = 0;
  const snapshots = [
    stale,
    `${stale}\n${freshOne}`,
    `${stale}\n${freshOne}`,
    `${stale}\n${freshOne}\n${freshTwo}`,
  ];
  const sampler = createAtomizerLogRendererMemorySampler({
    logPath: '/tmp/Atomizer Dev.log',
    timeoutMs: 2_000,
    pollIntervalMs: 250,
    now: () => nowMs,
    wait: async (milliseconds) => { nowMs += milliseconds; },
    readLog: async () => snapshots[Math.min(readIndex++, snapshots.length - 1)],
  });
  assert.equal((await sampler()).capturedAt, '2026-07-18T10:00:06.000Z');
  assert.equal((await sampler()).capturedAt, '2026-07-18T10:00:07.000Z');

  const readyRecord = (sessionId, hashCharacter = 'a') => JSON.stringify({
    type: 'ready',
    protocol: 'signal-lab-measurement-bridge',
    contractId: 'tinysa-signal-lab-atomizer-measurement',
    contractVersion: 1,
    service: 'tinysa-signal-lab',
    sessionId,
    identity: {
      driverId: 'signal-lab',
      sourceKind: 'signal-lab-simulation',
      execution: 'signal-lab-simulation',
      transport: 'signal-lab-measurement-bridge',
      contractSha256: hashCharacter.repeat(64),
      catalogSha256: 'b'.repeat(64),
      generatorSha256: 'c'.repeat(64),
      claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
    },
  });
  const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const readyA = readyRecord(sessionA);
  const readyParsed = parseAtomizerSignalLabReadyLog(
    `2026-07-18T10:00:00.000Z [INFO] startup\n${readyA}\n{"type":"ready"`,
    '/tmp/Atomizer Dev.log',
  );
  assert.equal(readyParsed.length, 1);
  assert.equal(readyParsed[0].sessionId, sessionA);
  assert.equal(readyParsed[0].lineNumber, 2);
  assert.equal(parseAtomizerSignalLabReadyLog(`${readyA}\n${JSON.stringify({
    type: 'response',
    requestId: 'atomizer-dev-launcher-validation',
    result: { kind: 'shutdown', closed: true },
  })}`).length, 0);

  const sessionRecord = (sessionId, hashCharacter = 'a', capturedAt = '2026-07-18T10:00:10.000Z') => (
    `${capturedAt} [ATOMIZER-SIGNAL-LAB-SESSION] ${JSON.stringify({
      sessionId,
      driverId: 'signal-lab',
      provenance: {
        sourceKind: 'signal-lab',
        execution: 'signal-lab-simulation',
        transport: 'signal-lab-measurement-bridge',
        contractId: 'tinysa-signal-lab-atomizer-measurement',
        contractVersion: 1,
        contractSha256: hashCharacter.repeat(64),
        catalogSha256: 'b'.repeat(64),
        generatorSha256: 'c'.repeat(64),
        claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
      },
    })}`
  );
  const admittedA = sessionRecord(sessionA);
  const admittedB = sessionRecord(sessionB, 'd', '2026-07-18T10:00:11.000Z');
  const admittedParsed = parseAtomizerSignalLabSessionLog(
    `2026-07-18T10:00:09.000Z [INFO] connecting\n${admittedA}\ntruncated [ATOMIZER-SIGNAL-LAB-SESSION] {`,
    '/tmp/Atomizer Dev.log',
  );
  assert.equal(admittedParsed.length, 1);
  assert.equal(admittedParsed[0].sessionId, sessionA);
  assert.equal(admittedParsed[0].recordKind, 'admitted-app-session');
  assert.equal(admittedParsed[0].lineNumber, 2);
  assert.equal(parseAtomizerSignalLabSessionLog(admittedA.replace(
    '"sourceKind":"signal-lab"',
    '"sourceKind":"serial-port"',
  )).length, 0);

  const stableInspector = createAtomizerLogSignalLabSessionInspector({
    logPath: '/tmp/Atomizer Dev.log',
    readLog: async () => admittedA,
  });
  assert.equal((await stableInspector()).sessionId, sessionA);
  assert.equal((await stableInspector()).sessionId, sessionA);

  let changedRead = 0;
  const changedInspector = createAtomizerLogSignalLabSessionInspector({
    logPath: '/tmp/Atomizer Dev.log',
    readLog: async () => changedRead++ === 0 ? admittedA : `${admittedA}\n${admittedB}`,
  });
  assert.equal((await changedInspector()).sessionId, sessionA);
  await assert.rejects(() => changedInspector(), /READY session changed/u);

  let readyNowMs = 0;
  let postBoundaryRead = 0;
  const postBoundaryInspector = createAtomizerLogSignalLabSessionInspector({
    logPath: '/tmp/Atomizer Dev.log',
    minimumSessionLine: 2,
    timeoutMs: 1_000,
    pollIntervalMs: 100,
    now: () => readyNowMs,
    wait: async (milliseconds) => { readyNowMs += milliseconds; },
    readLog: async () => postBoundaryRead++ === 0 ? admittedA : `${admittedA}\n${admittedB}`,
  });
  assert.equal((await postBoundaryInspector()).sessionId, sessionB);
  const rawReadyTestSeam = createAtomizerLogSignalLabSessionInspector({
    logPath: '/tmp/Atomizer Dev.log',
    allowRawReadyRecords: true,
    readLog: async () => readyA,
  });
  assert.equal((await rawReadyTestSeam()).recordKind, 'raw-ready-test-seam');
});

test('externally supplied renderer memory validates hard and plateau bounds', () => {
  assert.equal(validateRendererMemorySamples([]).status, 'not-supplied');
  const runWindow = {
    rendererMemoryRunStartedAt: '2026-07-18T08:00:00.000Z',
    rendererMemoryRunCompletedAt: '2026-07-18T08:02:00.000Z',
  };
  assert.throws(
    () => validateRendererMemorySamples([], {
      requireMeasuredRendererMemory: true,
      ...runWindow,
    }),
    /requires at least 8 measured renderer-memory samples; received 0/u,
  );
  const mib = 1_024 * 1_024;
  const plateau = [400, 404, 402, 403, 410, 411, 409, 412].map((value) => value * mib);
  const result = validateRendererMemorySamples(plateau);
  assert.equal(result.status, 'plateau-and-hard-bound-validated');
  assert.equal(result.plateauGrowthBytes, 8 * mib);
  assert.throws(
    () => validateRendererMemorySamples(plateau, {
      requireMeasuredRendererMemory: true,
      ...runWindow,
    }),
    /omitted its real capturedAt timestamp/u,
  );
  const measured = plateau.map((bytes, index) => ({
    bytes,
    source: 'electron-renderer-log',
    capturedAt: new Date(Date.UTC(2026, 6, 18, 8, 0, index * 15)).toISOString(),
    identity: 'pid:91500',
    checkpoint: index === 0 ? 'run-start' : index === 7 ? 'run-complete' : 'profile-complete',
  }));
  const measuredResult = validateRendererMemorySamples(
    measured,
    { requireMeasuredRendererMemory: true, ...runWindow },
  );
  assert.equal(measuredResult.samples, 8);
  assert.equal(measuredResult.identity, 'pid:91500');
  assert.equal(measuredResult.runWindowValidated, true);
  assert.equal(measuredResult.checkpointCoverageValidated, true);
  assert.throws(
    () => validateRendererMemorySamples(measured.slice(0, 7), {
      requireMeasuredRendererMemory: true,
      ...runWindow,
    }),
    /requires at least 8 distinct measured renderer-memory samples; received 7 distinct/u,
  );
  assert.throws(
    () => validateRendererMemorySamples(
      Array.from({ length: 8 }, () => measured[0]),
      { requireMeasuredRendererMemory: true, ...runWindow },
    ),
    /received 1 distinct from 8 supplied/u,
  );
  assert.throws(
    () => validateRendererMemorySamples(
      measured.map((sample, index) => index === 4
        ? { ...sample, identity: 'pid:91501' }
        : sample),
      { requireMeasuredRendererMemory: true, ...runWindow },
    ),
    /one stable non-empty renderer identity/u,
  );
  assert.throws(
    () => validateRendererMemorySamples(
      measured.map((sample, index) => index === 4
        ? { ...sample, identity: null }
        : sample),
      { requireMeasuredRendererMemory: true, ...runWindow },
    ),
    /one stable non-empty renderer identity/u,
  );
  assert.throws(
    () => validateRendererMemorySamples(
      measured.map((sample, index) => index === 0
        ? { ...sample, capturedAt: '2026-07-18T07:59:59.999Z' }
        : sample),
      { requireMeasuredRendererMemory: true, ...runWindow },
    ),
    /falls outside the live run window/u,
  );
  assert.throws(
    () => validateRendererMemorySamples(
      measured.map((sample, index) => index === 4
        ? { ...sample, capturedAt: '2026-07-18T08:00:01.000Z' }
        : sample),
      { requireMeasuredRendererMemory: true, ...runWindow },
    ),
    /must be strictly chronological/u,
  );
  assert.throws(
    () => validateRendererMemorySamples(
      measured.map((sample) => ({ ...sample, checkpoint: 'profile-complete' })),
      { requireMeasuredRendererMemory: true, ...runWindow },
    ),
    /start, distributed profile, and complete checkpoint coverage/u,
  );
  assert.throws(
    () => validateRendererMemorySamples([400, 401, 402, 403, 500, 501, 502, 503].map((value) => value * mib)),
    /grew .* limit/u,
  );
  assert.throws(
    () => validateRendererMemorySamples([2_048 * mib + 1]),
    /exceeded hard limit/u,
  );
});

test('channel summary anchors on the 3 dB result rather than the workspace name', () => {
  const text = [
    '121 container Channel power, 3 dB bandwidth, ACP, and occupied bandwidth',
    '122 container',
    '123 text unrelated',
    '133 text 3 dB BANDWIDTH',
    '134 text Resolution-limited',
    '135 text Response 686 Hz · RBW/grid 489 Hz',
  ].join('\n');

  assert.deepEqual(liveChannelSummary(text), {
    status: 'resolution-limited',
    bandwidthHz: 686,
    startHz: null,
    stopHz: null,
    resolutionScaleHz: 489,
    metricNode: null,
    detail: 'text 3 dB BANDWIDTH | text Resolution-limited | text Response 686 Hz · RBW/grid 489 Hz',
  });
  assert.equal(validateLiveChannelEvidence(
    liveChannelSummary(text),
    { id: 'cw', centerHz: 98_000_000, recommendedSpanHz: 200_000 },
  ).status, 'validated-resolution-limited-narrow');
  assert.throws(
    () => validateLiveChannelEvidence(
      { status: 'resolved', bandwidthHz: 190_000, detail: 'whole view' },
      { id: 'cw', centerHz: 98_000_000, recommendedSpanHz: 200_000 },
    ),
    /explicitly resolution-limited/u,
  );
  const resolved = liveChannelSummary(
    '133 group 3 dB bandwidth 17.5 MHz; 938.75 MHz to 956.25 MHz; interpolated',
  );
  assert.equal(resolved.metricNode?.startsWith('group 3 dB bandwidth'), true);
  assert.equal(validateLiveChannelEvidence(
    resolved,
    {
      id: 'lte-etm3.1',
      centerHz: 947_500_000,
      recommendedSpanHz: 30_000_000,
      occupiedBandwidthHz: 18_000_000,
    },
    { strictNarrow: false, strictWideband: true },
  ).status, 'validated-resolved-wideband');
  assert.throws(
    () => validateLiveChannelEvidence(
      { ...resolved, stopHz: 955_000_000 },
      {
        id: 'lte-etm3.1',
        centerHz: 947_500_000,
        recommendedSpanHz: 30_000_000,
        occupiedBandwidthHz: 18_000_000,
      },
      { strictNarrow: false, strictWideband: true },
    ),
    /conflicts with range span/u,
  );
  const occupiedBandwidthOnly = liveChannelSummary([
    '133 text 3 dB BANDWIDTH',
    '134 text —',
    '135 text OCCUPIED BANDWIDTH · 99%',
    '136 text 18 MHz',
  ].join('\n'));
  assert.equal(occupiedBandwidthOnly.status, 'unparseable');
  assert.equal(occupiedBandwidthOnly.bandwidthHz, null);
});

test('unavailable 3 dB result never borrows the following channel center', () => {
  const text = [
    '135 text 3 dB BANDWIDTH',
    '136 text Unavailable',
    '137 text Half-power response extends outside the main channel',
    '140 disclosure triangle Description: Edit Center frequency, Help: Center frequency 947.4 MHz',
  ].join('\n');

  assert.equal(liveChannelSummary(text).status, 'unavailable');
  assert.equal(liveChannelSummary(text).bandwidthHz, null);
});
