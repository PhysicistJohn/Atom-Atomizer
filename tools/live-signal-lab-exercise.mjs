import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createAtomizerLogRendererMemorySampler,
  createAtomizerLogSignalLabSessionInspector,
  DEFAULT_ATOMIZER_RENDERER_MEMORY_LOG_PATH,
  parseAtomizerRendererMemoryLog,
  parseAtomizerSignalLabReadyLog,
  parseAtomizerSignalLabSessionLog,
} from './live-signal-lab-memory.mjs';
import {
  CANONICAL_SIGNAL_LAB_PROFILE_IDS,
  interleavedFullCatalogClassificationRecord,
  liveSignalLabClassificationExpectation,
  liveSignalLabMarkerExpectation,
  NARROW_MARKER,
  RESOLVED_MARKER,
  SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS,
  SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_SOURCE_PLAN,
  UNAVAILABLE_MARKER,
  validateSignalLabPolicyCatalog,
} from './live-signal-lab-policy.mjs';

export {
  CANONICAL_SIGNAL_LAB_PROFILE_IDS,
  createAtomizerLogRendererMemorySampler,
  createAtomizerLogSignalLabSessionInspector,
  DEFAULT_ATOMIZER_RENDERER_MEMORY_LOG_PATH,
  liveSignalLabClassificationExpectation,
  liveSignalLabMarkerExpectation,
  parseAtomizerRendererMemoryLog,
  parseAtomizerSignalLabReadyLog,
  parseAtomizerSignalLabSessionLog,
  SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS,
  SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_SOURCE_PLAN,
};

/**
 * Live Atomizer/SignalLab exercise runner.
 *
 * This is intentionally not a DOM/unit-test harness. Import it from the
 * Computer Use node_repl and pass the plugin-provided `sky` object. Every
 * action is sent to the running Electron application, every assertion is
 * derived from a fresh macOS accessibility snapshot, and every screenshot is
 * copied from the exact frame returned by that boundary.
 *
 * Example (inside node_repl after the Computer Use bootstrap):
 *
 *   var live = await import(
 *     'file:///Users/johnelliott/PersonalGitHub/Atom-Atomizer/tools/live-signal-lab-exercise.mjs'
 *       + '?run=' + Date.now()
 *   );
 *   var result = await live.runSignalLabLiveExercise({
 *     sky,
 *     app: 'org.tinysa.atomizer.dev',
 *   });
 *   nodeRepl.write(JSON.stringify(result.summary, null, 2));
 */

export const LIVE_SIGNAL_LAB_EXERCISE_SCHEMA_VERSION = 2;
export const EXPECTED_SIGNAL_LAB_PROFILE_COUNT = 34;
export const SIGNAL_LAB_DEFAULT_GEOMETRY_SMOKE_PROFILE_IDS = Object.freeze([
  'cw',
  'lte-etm3.1',
  'wifi-ofdm-20m',
  'bluetooth-classic-connected',
]);

const FULL_EXERCISE_REQUIRED_STEPS = Object.freeze([
  'select',
  'single',
  'continuous-detect',
  'marker',
  'waterfall',
  'channel',
  'iq',
]);

const FULL_EXERCISE_REQUIRED_OPTIONS = Object.freeze([
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
]);

const SUBSET_RUN_KINDS = Object.freeze({
  'full-profile-exercise': 'profile-subset-exercise',
  'continuous-profile-switch-soak': 'continuous-profile-switch-subset-soak',
});

export function liveSignalLabRunKind(fullKind, profileCount) {
  requireSafeInteger(profileCount, 'profileCount');
  if (profileCount < 1 || profileCount > EXPECTED_SIGNAL_LAB_PROFILE_COUNT) {
    throw new RangeError(`profileCount must be between 1 and ${EXPECTED_SIGNAL_LAB_PROFILE_COUNT}`);
  }
  if (!Object.hasOwn(SUBSET_RUN_KINDS, fullKind)) {
    throw new Error(`Unknown live SignalLab full-run kind ${String(fullKind)}`);
  }
  return profileCount === EXPECTED_SIGNAL_LAB_PROFILE_COUNT
    ? fullKind
    : SUBSET_RUN_KINDS[fullKind];
}

export function liveSignalLabClassificationTimeoutMs(profile, configuredTimeoutMs = 15_000) {
  requireSafeInteger(configuredTimeoutMs, 'classificationTimeoutMs');
  if (configuredTimeoutMs < 1) throw new RangeError('classificationTimeoutMs must be positive');
  if (!profile || typeof profile !== 'object') throw new TypeError('SignalLab profile is required');
  // Canonical Wi-Fi association can need 32 sweep opportunities; full-band
  // Bluetooth can need 96. Keep a bounded margin without weakening the result.
  if (profile.family === 'bluetooth') return Math.max(configuredTimeoutMs, 120_000);
  if (profile.family === 'wlan') return Math.max(configuredTimeoutMs, 60_000);
  return configuredTimeoutMs;
}

export function liveSignalLabRequiredClassificationOpportunities(profile) {
  if (!profile || typeof profile !== 'object') throw new TypeError('SignalLab profile is required');
  if (profile.family === 'bluetooth') return 96;
  if (profile.family === 'wlan'
    || SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS.includes(profile.id)) return 32;
  return 8;
}

export function liveSignalLabDefaultGeometrySmokeOpportunities(profile) {
  if (!profile || typeof profile !== 'object') throw new TypeError('SignalLab profile is required');
  if (profile.family === 'bluetooth') return 96;
  if (profile.family === 'wlan') return 32;
  return 1;
}

export function liveSignalLabClassificationEvidenceSatisfied(
  profile,
  acceptance,
  observedSequenceOpportunities,
) {
  const requiredOpportunities = liveSignalLabRequiredClassificationOpportunities(profile);
  if (!Number.isSafeInteger(observedSequenceOpportunities)
    || observedSequenceOpportunities < requiredOpportunities) return false;
  if (!Number.isSafeInteger(acceptance?.autoTargetPersistenceSweeps)
    && profile.family !== 'bluetooth') return false;
  if (profile.family === 'bluetooth') {
    return Number.isSafeInteger(acceptance?.autoTargetPositiveLooks)
      && acceptance.autoTargetPositiveLooks >= 8
      && Number.isSafeInteger(acceptance?.autoTargetOpportunityLooks)
      && acceptance.autoTargetOpportunityLooks >= requiredOpportunities;
  }
  return acceptance.autoTargetPersistenceSweeps >= 8;
}

export function screenshotArtifactExtension(screenshotUrl) {
  const source = fileURLToPath(screenshotUrl);
  const extension = extname(source).toLowerCase();
  if (!['.jpg', '.jpeg', '.png'].includes(extension)) {
    throw new Error(`Unsupported Computer Use screenshot extension: ${extension || '(none)'}`);
  }
  return extension;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultCatalogModule = pathToFileURL(resolve(
  repositoryRoot,
  '..',
  'Atom-SignalLab',
  'dist',
  'bridge',
  'catalog.js',
));

const FAMILY_BUTTON = Object.freeze({
  tone: 'LAB',
  analog: 'LAB',
  geran: 'GSM',
  'e-utra': 'LTE',
  nr: '5G NR',
  wlan: 'WI-FI',
  bluetooth: 'BLUETOOTH',
});

const FAMILY_SELECT_LABEL = Object.freeze({
  geran: 'GSM waveform configuration',
  'e-utra': 'LTE waveform configuration',
  nr: '5G NR waveform configuration',
  wlan: 'Wi-Fi waveform configuration',
  bluetooth: 'Bluetooth waveform configuration',
});

const FATAL_UI_PATTERNS = Object.freeze([
  /SignalLab profile selection failed:/i,
  /SignalLab channel configuration failed:/i,
  /Sweep analysis failed:/i,
  /Bayesian classification unavailable:/i,
  /Marker search failed:/i,
  /I\/Q (?:capture|configuration) failed:/i,
  /Continuous I\/Q acquisition failed:/i,
  /renderer process (?:failed|crashed|gone|became unresponsive)/i,
  /renderer.{0,80}(?:fatal|crashed|unresponsive)/i,
  /JavaScript heap out of memory/i,
  /Application error boundary/i,
  /Cannot read properties of (?:undefined|null)/i,
]);

const DEFAULT_OPTIONS = Object.freeze({
  closeAtomPanel: true,
  failFast: false,
  profileTimeoutMs: 8_000,
  acquisitionTimeoutMs: 12_000,
  classificationTimeoutMs: 15_000,
  pollIntervalMs: 125,
  exerciseSingle: true,
  exerciseContinuous: true,
  exerciseMarker: true,
  exerciseDetect: true,
  exerciseWaterfall: true,
  exerciseChannel: true,
  exerciseIq: true,
  requireClassification: true,
  requireDetectAutoTarget: true,
  requireDetectNoInnerScroll: true,
  requireLiveScreenshots: true,
  requireNoLocalIqCaptureButton: true,
  maximumControlResponseMs: 7_000,
  maximumAccessibilitySnapshotMs: 7_000,
  maximumFirstSweepLatencyMs: 3_000,
  maximumStopLatencyMs: 3_000,
  maximumMillisecondsPerSweepOpportunity: 500,
  maximumResponsivenessTourMs: 30_000,
  minimumContinuousSweepProgressions: 2,
  minimumScreenshotWidth: 1_532,
  minimumScreenshotHeight: 821,
  rendererMemoryPlateauWindow: 4,
  rendererMemoryMaximumPlateauGrowthBytes: 64 * 1_024 * 1_024,
  rendererMemoryHardLimitBytes: 2 * 1_024 * 1_024 * 1_024,
  screenshotPolicy: 'all',
  narrowMarkerProfileIds: Object.freeze(['cw']),
  wideMarkerProfileIds: Object.freeze(['lte-etm3.1']),
  iqZoomProfileIds: Object.freeze(['cw', 'lte-etm3.1', 'bluetooth-classic-connected']),
  iqContinuousProfileIds: Object.freeze(['cw', 'lte-etm3.1', 'bluetooth-classic-connected']),
});

export async function loadSignalLabLiveCatalog(catalogModuleUrl = defaultCatalogModule) {
  const url = catalogModuleUrl instanceof URL
    ? catalogModuleUrl
    : pathToFileURL(resolve(String(catalogModuleUrl)));
  const module = await import(`${url.href}?live-catalog=${Date.now()}`);
  if (!Array.isArray(module.waveformCatalog)) {
    throw new TypeError(`SignalLab catalog module ${url.href} did not export waveformCatalog`);
  }
  const catalog = module.waveformCatalog.map((descriptor) => Object.freeze({
    id: requireNonEmptyString(descriptor?.id, 'profile id'),
    label: requireNonEmptyString(descriptor?.label, 'profile label'),
    family: requireNonEmptyString(descriptor?.family, 'profile family'),
    centerHz: requireSafeInteger(descriptor?.centerHz, 'profile centerHz'),
    occupiedBandwidthHz: requireSafeInteger(
      descriptor?.occupiedBandwidthHz,
      'profile occupiedBandwidthHz',
    ),
    recommendedSpanHz: requireSafeInteger(
      descriptor?.recommendedSpanHz,
      'profile recommendedSpanHz',
    ),
    qualification: requireNonEmptyString(descriptor?.qualification, 'profile qualification'),
  }));
  if (catalog.length !== EXPECTED_SIGNAL_LAB_PROFILE_COUNT) {
    throw new Error(
      `Live exercise requires the closed ${EXPECTED_SIGNAL_LAB_PROFILE_COUNT}-profile catalog; received ${catalog.length}`,
    );
  }
  if (new Set(catalog.map(({ id }) => id)).size !== catalog.length) {
    throw new Error('SignalLab live catalog contains duplicate profile IDs');
  }
  const catalogIds = catalog.map(({ id }) => id);
  validateSignalLabPolicyCatalog(catalogIds);
  for (const descriptor of catalog) {
    if (!Object.hasOwn(FAMILY_BUTTON, descriptor.family)) {
      throw new Error(`SignalLab profile ${descriptor.id} has unsupported UI family ${descriptor.family}`);
    }
  }
  return Object.freeze(catalog);
}

/** Exact, catalog-derived coverage declaration written alongside review notes. */
export async function signalLabLiveCoverageMatrix(input = {}) {
  const options = Object.freeze({ ...DEFAULT_OPTIONS, ...(input.options ?? {}) });
  const catalog = await loadSignalLabLiveCatalog(input.catalogModuleUrl);
  return Object.freeze(catalog.map((profile) => Object.freeze({
    profileId: profile.id,
    label: profile.label,
    family: profile.family,
    profileSelection: 'live SignalLab Studio -> instrument feature -> bridge acknowledgement',
    scalarSingle: options.exerciseSingle,
    scalarContinuous: options.exerciseContinuous || options.exerciseDetect,
    detectVisualization: options.exerciseDetect,
    detectAutoMostProminent: options.exerciseDetect && options.requireDetectAutoTarget,
    detectNoInnerScroll: options.exerciseDetect && options.requireDetectNoInnerScroll,
    bayesianClassification: options.exerciseDetect && options.requireClassification,
    classificationTimeoutMs: liveSignalLabClassificationTimeoutMs(
      profile,
      options.classificationTimeoutMs,
    ),
    classificationMinimumObservedOpportunities:
      liveSignalLabRequiredClassificationOpportunities(profile),
    classificationClaim: 'linked-current-non-protocol-result-only',
    fittedClassifierReleaseGateEligible:
      SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS.includes(profile.id),
    peakMarkerAndLocalCharacterization: options.exerciseMarker,
    markerWidthExpectation: liveSignalLabMarkerExpectation(profile).allowedWidthClassifications,
    waterfall: options.exerciseWaterfall,
    channelAndThreeDecibelBandwidth: options.exerciseChannel,
    complexIqSingle: options.exerciseIq,
    noRedundantLocalIqCapture: options.exerciseIq && options.requireNoLocalIqCaptureButton,
    complexIqZoom: options.exerciseIq && options.iqZoomProfileIds.includes(profile.id),
    complexIqContinuous: options.exerciseIq && options.iqContinuousProfileIds.includes(profile.id),
    boundedControlLatencyAndSweepProgression: options.exerciseSingle
      && (options.exerciseContinuous || options.exerciseDetect),
    screenshotPolicy: options.screenshotPolicy,
    screenshotClaim: 'fresh-frame-and-dimensions-only-not-pixel-content-perfection',
    screenshotContentReview: 'manual-review-required',
  })));
}

/**
 * Scientific classifier gate. Run this in a newly connected SignalLab session,
 * independently of the 34-profile UI exercise. It consumes the fitted source
 * clock in its pinned 12-profile order and exact 32/96-spectrum horizons.
 * By default the gate binds the latest tagged admitted-session diagnostic in
 * the Atomizer dev log at both boundaries. `input.signalLabSessionLogOptions`
 * can set a post-reconnect `minimumSessionLine`; `input.inspectSignalLabSession`
 * may instead return a current bridge ready record or InstrumentSessionSnapshot.
 */
export async function runSignalLabClassifierReleaseGate(input) {
  const context = await createContext({
    ...input,
    profileIds: SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS,
  }, {
    screenshotPolicy: input?.options?.screenshotPolicy ?? 'all',
  });
  const run = createRunRecord(context, 'classifier-release-gate');
  run.sourceClock = {
    policyId: 'shared-monotonic-source-clock-v1',
    plan: SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_SOURCE_PLAN,
    initialSweepSequence: null,
    initialSourceSequence: null,
    finalSourceSequence: null,
    session: null,
    status: 'pending',
  };
  await persistRun(context, run);
  let state;
  try {
    state = await closeAtomPanelIfRequested(context, await freshState(context));
    assertSignalLabSession(state);
    state = await ensureStopped(context, state);
    const initialSweepSequence = spectrumSummary(state.text).sequence;
    const initialSession = await inspectActualSignalLabSession(
      context,
      state,
      'classifier-release-gate-start',
    );
    run.sourceClock.initialSweepSequence = initialSweepSequence;
    run.sourceClock.initialSourceSequence = initialSession.visibleSource.sourceSequence;
    run.sourceClock.session = { initial: initialSession, final: null };
    if (initialSweepSequence !== null
      || hasSpectrum(state.text)
      || initialSession.visibleSource.sourceState !== 'READY'
      || initialSession.visibleSource.sessionState !== 'READY'
      || initialSession.visibleSource.sourceSequence !== 0) {
      throw new Error(
        `Classifier release gate requires a newly connected zero-sequence SignalLab producer session; observed ${JSON.stringify({ initialSweepSequence, visibleSource: initialSession.visibleSource })}`,
      );
    }
    const geometry = await configurePinnedSweepGeometry(context, state);
    state = geometry.state;
    run.geometry = {
      policyId: 'signal-lab-recommended-span-450-point-grid-v1',
      requiredPoints: 450,
      requiredSweepTimeSeconds: 0.05,
      initial: geometry.before,
      configured: geometry.configured,
    };

    for (const sourcePlan of SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_SOURCE_PLAN) {
      const profile = context.catalog[sourcePlan.profileOrdinal];
      if (profile?.id !== sourcePlan.profileId) {
        throw new Error('Classifier release-gate catalog order diverged from its pinned source plan');
      }
      const record = {
        id: profile.id,
        label: profile.label,
        family: profile.family,
        startedAt: new Date().toISOString(),
        steps: {},
        failures: [],
      };
      run.profiles.push(record);
      try {
        state = await selectProfile(context, state, profile);
        const result = await exerciseClassifierReleaseGateProfile(
          context,
          state,
          profile,
          sourcePlan,
        );
        state = result.state;
        record.steps['classifier-release-gate'] = {
          ok: true,
          completedAt: new Date().toISOString(),
          ...withoutState(result),
        };
      } catch (error) {
        const failure = {
          profileId: profile.id,
          step: 'classifier-release-gate',
          ...serializeError(error),
        };
        record.failures.push(failure);
        run.failures.push(failure);
        throw error;
      } finally {
        record.completedAt = new Date().toISOString();
        await persistRun(context, run);
      }
    }
    const finalSession = await inspectActualSignalLabSession(
      context,
      state,
      'classifier-release-gate-complete',
    );
    const expectedFinalSourceSequence = SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_SOURCE_PLAN
      .reduce((total, entry) => total + entry.spectrumOpportunities, 0);
    run.sourceClock.finalSourceSequence = finalSession.visibleSource.sourceSequence;
    run.sourceClock.session.final = finalSession;
    if (finalSession.sessionId !== initialSession.sessionId
      || finalSession.identitySha256 !== initialSession.identitySha256
      || finalSession.visibleSource.sourceSequence !== expectedFinalSourceSequence) {
      throw new Error('Classifier release gate producer session identity/clock changed during the fitted run');
    }
    run.sourceClock.status = 'fresh-pinned-order-and-horizons-observed';
  } finally {
    try {
      if (state) state = await ensureStopped(context, state);
    } catch (error) {
      run.failures.push({ profileId: null, step: 'final-stop', ...serializeError(error) });
    }
    completeRun(run);
    await persistRun(context, run);
  }
  return Object.freeze({
    artifactDirectory: context.artifactDirectory,
    reportPath: context.reportPath,
    summary: summarizeSignalLabLiveRun(run),
    run,
  });
}

/** Separate clean-session smoke for the shipped 1024-point user default. */
export async function runSignalLabDefaultGeometrySmoke(input) {
  const context = await createContext({
    ...input,
    profileIds: SIGNAL_LAB_DEFAULT_GEOMETRY_SMOKE_PROFILE_IDS,
  }, {
    screenshotPolicy: input?.options?.screenshotPolicy ?? 'all',
  });
  const run = createRunRecord(context, 'default-1024-user-path-smoke');
  await persistRun(context, run);
  let state;
  try {
    state = await closeAtomPanelIfRequested(context, await freshState(context));
    assertSignalLabSession(state);
    state = await ensureStopped(context, state);
    state = await navigate(context, state, 'Spectrum');
    const initialSource = liveSignalLabSourceSessionSummary(state.text);
    if (initialSource.sourceState !== 'READY'
      || initialSource.sessionState !== 'READY'
      || initialSource.sourceSequence !== 0
      || spectrumSummary(state.text).sequence !== null
      || hasSpectrum(state.text)) {
      throw new Error(
        `Default 1024 user-path smoke requires a newly connected zero-sequence SignalLab session; observed ${JSON.stringify(initialSource)}`,
      );
    }
    if (!hasEditableDisclosure(state.text, 'Sweep points')) {
      state = await clickElement(context, state, enabledButton('Sweep setup'), 'Sweep setup');
    }
    state = await waitForState(
      context,
      (candidate) => hasEditableDisclosure(candidate.text, 'Sweep points'),
      'default user-path sweep geometry',
      context.options.profileTimeoutMs,
    );
    const configured = liveSweepGeometrySummary(state.text);
    if (configured.configuredPoints !== 1_024
      || configured.configuredSweepTimeSeconds !== 0.05) {
      throw new Error(
        `Default user-path smoke requires a clean 1024-point × 0.05 s session; observed ${JSON.stringify(configured)}`,
      );
    }
    state = await clickElement(context, state, enabledButton('Sweep setup'), 'close Sweep setup');
    run.geometry = {
      policyId: 'shipped-default-1024-user-path-v1',
      configured,
      profileIds: SIGNAL_LAB_DEFAULT_GEOMETRY_SMOKE_PROFILE_IDS,
      initialSource,
      markerOracleStatus: 'not-applicable-unfitted-1024-point-geometry',
    };

    for (const profile of context.catalog) {
      const record = {
        id: profile.id,
        label: profile.label,
        family: profile.family,
        startedAt: new Date().toISOString(),
        steps: {},
        failures: [],
      };
      run.profiles.push(record);
      try {
        state = await selectProfile(context, state, profile);
        const result = await exerciseDefaultGeometryProfile(context, state, profile);
        state = result.state;
        record.steps['default-geometry-smoke'] = {
          ok: true,
          completedAt: new Date().toISOString(),
          ...withoutState(result),
        };
      } catch (error) {
        const failure = {
          profileId: profile.id,
          step: 'default-geometry-smoke',
          ...serializeError(error),
        };
        record.failures.push(failure);
        run.failures.push(failure);
        if (context.options.failFast) throw error;
        state = await ensureStopped(context, await freshState(context));
      } finally {
        record.completedAt = new Date().toISOString();
        await persistRun(context, run);
      }
    }
  } finally {
    try {
      state = await ensureStopped(context, state ?? await freshState(context));
    } catch (error) {
      run.failures.push({ profileId: null, step: 'final-stop', ...serializeError(error) });
    }
    completeRun(run);
    await persistRun(context, run);
  }
  return Object.freeze({
    artifactDirectory: context.artifactDirectory,
    reportPath: context.reportPath,
    summary: summarizeSignalLabLiveRun(run),
    run,
  });
}

async function exerciseDefaultGeometryProfile(context, state, profile) {
  state = await ensureStopped(context, state);
  state = await navigate(context, state, 'Spectrum');
  const opportunities = liveSignalLabDefaultGeometrySmokeOpportunities(profile);
  const sourceBefore = liveSignalLabSourceSessionSummary(state.text).sourceSequence;
  const previousSweep = spectrumSummary(state.text).sequence;
  if (!Number.isSafeInteger(sourceBefore)
    || (previousSweep !== null && previousSweep !== sourceBefore)) {
    throw new Error(`${profile.id} default-geometry source/sweep sequence was not coherent`);
  }
  const sequences = [];
  const producerSourceSequences = [];
  let sweep = null;
  let sweepGeometry = null;
  for (let look = 0; look < opportunities; look++) {
    const expectedSequence = sourceBefore + look + 1;
    state = await clickElement(context, state, enabledButton('Single'), 'default-geometry Single');
    state = await waitForState(
      context,
      (candidate) => {
        const sequence = spectrumSummary(candidate.text).sequence;
        return hasSpectrum(candidate.text)
          && Number.isSafeInteger(sequence)
          && sequence >= expectedSequence
          && findElementIndex(candidate.text, enabledButton('Single')) !== undefined;
      },
      `${profile.id} default-geometry spectrum ${look + 1}/${opportunities}`,
      context.options.acquisitionTimeoutMs,
    );
    sweep = spectrumSummary(state.text);
    sweepGeometry = liveSweepGeometrySummary(state.text);
    const visibleSource = liveSignalLabSourceSessionSummary(state.text);
    if (sweep.sequence !== expectedSequence || visibleSource.sourceSequence !== expectedSequence) {
      throw new Error(
        `${profile.id} default-geometry source sequence did not advance exactly to ${expectedSequence}`,
      );
    }
    if (sweepGeometry.plotPoints !== 1_024) {
      throw new Error(`${profile.id} default user-path acquisition did not publish 1024 points`);
    }
    assertRecommendedVisibleRange(profile, sweep.visibleRangeHz, 'default 1024 user-path');
    sequences.push(sweep.sequence);
    producerSourceSequences.push(visibleSource.sourceSequence);
  }
  if (findElementIndex(state.text, enabledButton('Peak')) === undefined) {
    state = await clickElement(
      context,
      state,
      enabledButton('Traces & markers'),
      'default-geometry Traces & markers',
    );
  }
  state = await normalizeM1Normal(context, state);
  state = await clickElement(context, state, enabledButton('Peak'), 'default-geometry Peak');
  state = await waitForState(
    context,
    (candidate) => liveMarkerSummary(candidate.text).frequencyHz !== null
      && candidate.text.includes('Marker M1 local characterization'),
    `${profile.id} default-geometry marker characterization`,
    context.options.acquisitionTimeoutMs,
  );
  const marker = liveMarkerSummary(state.text);
  const characterization = liveMarkerCharacterizationSummary(state.text);
  const markerGeometry = liveSweepGeometrySummary(state.text);
  validateDefaultGeometryMarkerEvidence(marker, characterization, markerGeometry, profile);
  return {
    state,
    sweep,
    sweepGeometry,
    marker,
    characterization,
    markerGeometry,
    markerOracleStatus: 'not-applicable-unfitted-1024-point-geometry',
    spectrumOpportunities: opportunities,
    sourceClockEvidence: {
      firstSpectrumSequence: sequences[0],
      lastSpectrumSequence: sequences.at(-1),
      spectrumSequences: sequences,
      producerSourceSequences,
    },
    screenshot: await maybeCapture(context, state, profile.id, 'default-1024-marker'),
  };
}

function validateDefaultGeometryMarkerEvidence(marker, characterization, geometry, profile) {
  if (geometry.plotPoints !== 1_024) {
    throw new Error(`${profile.id} default marker did not remain on 1024-point geometry`);
  }
  if (!Number.isFinite(marker.frequencyHz)) {
    throw new Error(`${profile.id} default marker omitted a finite M1 frequency`);
  }
  const halfSpan = profile.recommendedSpanHz / 2;
  if (marker.frequencyHz < profile.centerHz - halfSpan
    || marker.frequencyHz > profile.centerHz + halfSpan) {
    throw new Error(`${profile.id} default marker fell outside its recommended span`);
  }
  if (!characterization.hasLocalCharacterization
    || !characterization.hasThreeDecibelWidth
    || !characterization.hasComponentOccupiedBandwidth) {
    throw new Error(`${profile.id} default marker omitted its local characterization readout`);
  }
}

async function exerciseClassifierReleaseGateProfile(context, state, profile, sourcePlan) {
  state = await ensureStopped(context, state);
  const geometryConfiguration = await configurePinnedSweepGeometry(context, state);
  state = geometryConfiguration.state;
  const sequences = [];
  const producerSourceSequences = [];
  const sweepLatenciesMs = [];
  let lastVisibleRangeHz = null;
  for (let look = 0; look < sourcePlan.spectrumOpportunities; look++) {
    const expectedSequence = sourcePlan.sourceLookIndexOffset + look + 1;
    const started = Date.now();
    state = await clickElement(context, state, enabledButton('Single'), 'classifier-gate Single');
    state = await waitForState(
      context,
      (candidate) => {
        const sequence = spectrumSummary(candidate.text).sequence;
        return hasSpectrum(candidate.text)
          && Number.isSafeInteger(sequence)
          && sequence >= expectedSequence
          && findElementIndex(candidate.text, enabledButton('Single')) !== undefined;
      },
      `${profile.id} fitted source look ${look + 1}/${sourcePlan.spectrumOpportunities}`,
      context.options.acquisitionTimeoutMs,
    );
    const sequence = spectrumSummary(state.text).sequence;
    const visibleSource = liveSignalLabSourceSessionSummary(state.text);
    if (sequence !== expectedSequence || visibleSource.sourceSequence !== expectedSequence) {
      throw new Error(
        `${profile.id} sweep/source sequence ${String(sequence)}/${String(visibleSource.sourceSequence)} did not match fitted plan ${expectedSequence}`,
      );
    }
    const geometry = liveSweepGeometrySummary(state.text);
    const sweep = spectrumSummary(state.text);
    const expectedStartHz = Math.round(profile.centerHz - profile.recommendedSpanHz / 2);
    const expectedStopHz = Math.round(profile.centerHz + profile.recommendedSpanHz / 2);
    const rangeToleranceHz = Math.max(1, Math.round(profile.recommendedSpanHz / 1_000_000));
    if (geometry.plotPoints !== 450
      || !sweep.visibleRangeHz
      || Math.abs(sweep.visibleRangeHz.startHz - expectedStartHz) > rangeToleranceHz
      || Math.abs(sweep.visibleRangeHz.stopHz - expectedStopHz) > rangeToleranceHz) {
      throw new Error(
        `${profile.id} source look ${look + 1} diverged from fitted 450-point recommended-span geometry`,
      );
    }
    lastVisibleRangeHz = sweep.visibleRangeHz;
    sequences.push(sequence);
    producerSourceSequences.push(visibleSource.sourceSequence);
    sweepLatenciesMs.push(Date.now() - started);
  }

  state = await navigate(context, state, 'Detect');
  state = await waitForState(
    context,
    (candidate) => {
      const summary = liveDetectAcceptanceSummary(candidate.text);
      return detectionSummary(candidate.text).active > 0
        && summary.autoClassificationResultLabel !== null
        && summary.autoClassificationResultQualification
          === 'BAYESIAN EVIDENCE CLASS · NOT PROTOCOL';
    },
    `${profile.id} fitted-horizon classifier result`,
    liveSignalLabClassificationTimeoutMs(profile, context.options.classificationTimeoutMs),
  );
  state = await clickElement(context, state, autoMostProminentButton, 'classifier-gate Auto target');
  state = await waitForState(
    context,
    (candidate) => detectAutoAcceptanceSatisfied(
      liveDetectAcceptanceSummary(candidate.text),
      true,
      profile,
      sourcePlan.spectrumOpportunities,
      true,
    ),
    `${profile.id} fitted-horizon linked Auto target`,
    liveSignalLabClassificationTimeoutMs(profile, context.options.classificationTimeoutMs),
  );
  const acceptance = liveDetectAcceptanceSummary(state.text);
  const expectation = liveSignalLabClassificationExpectation(
    profile,
    acceptance.autoClassificationResultLabel,
  );
  if (expectation.oracleStatus !== 'validated') {
    throw new Error(
      `${profile.id} classifier label ${String(expectation.resultLabel)} failed its fitted release oracle`,
    );
  }
  const resultGeometry = liveSweepGeometrySummary(state.text);
  if (!/\bCapture\s+450\s+points\b/iu.test(detectionSummary(state.text).line ?? '')
    || !resultGeometry.pinnedBayesianGeometryVisible) {
    throw new Error(`${profile.id} classifier result did not expose pinned 450 × 50 ms geometry`);
  }
  const classificationCaptureId = /\bCapture\s+([^\s·]+)/iu
    .exec(detectionSummary(state.text).line ?? '')?.[1] ?? null;
  if (classificationCaptureId === null) {
    throw new Error(`${profile.id} omitted its current classification capture ID`);
  }
  const screenshot = await maybeCapture(context, state, profile.id, 'classifier-release-gate');
  return {
    state,
    screenshot,
    sourcePlan,
    sourceClockEvidence: {
      firstSpectrumSequence: sequences[0],
      lastSpectrumSequence: sequences.at(-1),
      spectrumSequences: sequences,
      producerSourceSequences,
      sweepLatenciesMs,
      automaticDetectedPowerCaptures: 0,
      classificationCaptureId,
    },
    geometryEvidence: {
      configured: geometryConfiguration.configured,
      result: resultGeometry,
      expectedStartHz: Math.round(profile.centerHz - profile.recommendedSpanHz / 2),
      expectedStopHz: Math.round(profile.centerHz + profile.recommendedSpanHz / 2),
      observedRangeHz: lastVisibleRangeHz,
    },
    classificationEvidence: {
      resultLabel: acceptance.autoClassificationResultLabel,
      resultQualification: acceptance.autoClassificationResultQualification,
      resultLinkedToAutoTarget: acceptance.autoClassificationResultLinked,
      expectation,
    },
  };
}

export async function runSignalLabLiveExercise(input) {
  const context = await createContext(input);
  const run = createRunRecord(context, 'full-profile-exercise');
  await persistRun(context, run);

  try {
    let state = await freshState(context);
    assertSignalLabSession(state);
    state = await closeAtomPanelIfRequested(context, state);
    state = await ensureStopped(context, state);
    const markerGeometry = await configurePinnedSweepGeometry(context, state);
    state = markerGeometry.state;
    run.geometry = {
      policyId: 'signal-lab-marker-oracle-recommended-span-450-points-v1',
      requiredPoints: 450,
      requiredSweepTimeSeconds: 0.05,
      initial: markerGeometry.before,
      configured: markerGeometry.configured,
    };
    try {
      await sampleRendererMemory(context, 'run-start', null);
    } catch (error) {
      run.failures.push({ profileId: null, step: 'renderer-memory-sample', ...serializeError(error) });
    }

    for (const profile of context.catalog) {
      const record = {
        id: profile.id,
        label: profile.label,
        family: profile.family,
        startedAt: new Date().toISOString(),
        steps: {},
        failures: [],
      };
      run.profiles.push(record);
      await persistRun(context, run);

      try {
        state = await runStep(context, run, record, 'select', async () => {
          const selected = await selectProfile(context, state, profile);
          const screenshot = await maybeCapture(context, selected, profile.id, 'generate');
          return {
            state: selected,
            screenshot,
            evidence: selected.text.match(new RegExp(`SignalLab profile selected: ${escapeRegExp(profile.id)}`))?.[0]
              ?? `heading:${profile.label}`,
          };
        });

        if (context.options.exerciseSingle) {
          state = await runStep(context, run, record, 'single', async () => {
            const result = await exerciseSingleSpectrum(context, state, profile);
            const screenshot = await maybeCapture(context, result.state, profile.id, 'spectrum-single');
            return { ...result, screenshot };
          });
        }

        if (context.options.exerciseContinuous || context.options.exerciseDetect) {
          state = await runStep(context, run, record, 'continuous-detect', async () => {
            const result = await exerciseContinuousDetection(context, state, profile);
            const screenshot = await maybeCapture(context, result.detectState, profile.id, 'detect-running');
            return { ...result, screenshot };
          });
        }

        if (context.options.exerciseMarker) {
          state = await runStep(context, run, record, 'marker', async () => {
            const result = await exercisePeakMarker(context, state, profile);
            const screenshot = await maybeCapture(context, result.state, profile.id, 'spectrum-marker');
            return { ...result, screenshot };
          });
        }

        if (context.options.exerciseWaterfall) {
          state = await runStep(context, run, record, 'waterfall', async () => {
            const result = await exerciseWaterfall(context, state);
            const screenshot = await maybeCapture(context, result.state, profile.id, 'waterfall');
            return { ...result, screenshot };
          });
        }

        if (context.options.exerciseChannel) {
          state = await runStep(context, run, record, 'channel', async () => {
            const result = await exerciseChannel(context, state, profile);
            const screenshot = await maybeCapture(context, result.state, profile.id, 'channel');
            return { ...result, screenshot };
          });
        }

        if (context.options.exerciseIq) {
          state = await runStep(context, run, record, 'iq', async () => {
            const result = await exerciseIq(context, state, profile);
            const screenshot = await maybeCapture(context, result.state, profile.id, 'iq');
            return { ...result, screenshot };
          });
        }
      } catch (error) {
        record.failures.push(serializeError(error));
        run.failures.push({ profileId: profile.id, step: 'profile', ...serializeError(error) });
        if (context.options.failFast) throw error;
        try {
          state = await ensureStopped(context, await freshState(context));
        } catch (cleanupError) {
          run.failures.push({ profileId: profile.id, step: 'cleanup', ...serializeError(cleanupError) });
          throw cleanupError;
        }
      } finally {
        record.completedAt = new Date().toISOString();
        try {
          await sampleRendererMemory(context, 'profile-complete', profile.id);
        } catch (error) {
          const failure = { profileId: profile.id, step: 'renderer-memory-sample', ...serializeError(error) };
          record.failures.push(failure);
          run.failures.push(failure);
        }
        await persistRun(context, run);
      }
    }
  } finally {
    try {
      await ensureStopped(context, await freshState(context));
    } catch (error) {
      run.failures.push({ profileId: null, step: 'final-stop', ...serializeError(error) });
    }
    try {
      run.stress.bounds = validateLiveStressEvidence(run.stress, context.options);
    } catch (error) {
      run.failures.push({ profileId: null, step: 'stress-bounds', ...serializeError(error) });
    }
    try {
      await sampleRendererMemory(context, 'run-complete', null);
      const rendererMemoryRunCompletedAt = new Date().toISOString();
      run.stress.rendererMemory = validateRendererMemorySamples(
        run.stress.rendererMemorySamples,
        {
          ...context.options,
          requireMeasuredRendererMemory: isFullAcceptanceRunKind(run.kind),
          rendererMemoryRunStartedAt: run.startedAt,
          rendererMemoryRunCompletedAt,
        },
      );
    } catch (error) {
      run.failures.push({ profileId: null, step: 'renderer-memory', ...serializeError(error) });
    }
    completeRun(run);
    await persistRun(context, run);
  }

  return Object.freeze({
    artifactDirectory: context.artifactDirectory,
    reportPath: context.reportPath,
    summary: summarizeSignalLabLiveRun(run),
    run,
  });
}

/**
 * Dedicated race/retune soak. The stream remains requested while every live
 * SignalLab profile is selected. A passing step requires a fresh spectrum and
 * the global Stop control after each invalidating profile transaction.
 */
export async function runSignalLabContinuousProfileSwitchSoak(input) {
  const context = await createContext(input, { screenshotPolicy: 'failures' });
  const run = createRunRecord(context, 'continuous-profile-switch-soak');
  await persistRun(context, run);
  let state;

  try {
    state = await closeAtomPanelIfRequested(context, await freshState(context));
    assertSignalLabSession(state);
    state = await ensureStopped(context, state);
    state = await navigate(context, state, 'Spectrum');
    state = await clickElement(context, state, enabledButton('Run'), 'global Run');
    state = await waitForState(
      context,
      (candidate) => hasButton(candidate.text, 'Stop'),
      'continuous spectrum Stop control',
      context.options.acquisitionTimeoutMs,
    );
    try {
      await sampleRendererMemory(context, 'soak-start', null);
    } catch (error) {
      run.failures.push({ profileId: null, step: 'renderer-memory-sample', ...serializeError(error) });
    }

    for (const profile of context.catalog) {
      const record = {
        id: profile.id,
        label: profile.label,
        family: profile.family,
        startedAt: new Date().toISOString(),
        steps: {},
        failures: [],
      };
      run.profiles.push(record);
      try {
        const switchStarted = Date.now();
        const previousSequence = spectrumSummary(state.text).sequence;
        state = await navigate(context, state, 'Generate');
        state = await selectProfile(context, state, profile);
        state = await waitForState(
          context,
          (candidate) => hasButton(candidate.text, 'Stop'),
          `continuous acquisition resume after ${profile.id}`,
          context.options.profileTimeoutMs,
        );
        state = await navigate(context, state, 'Spectrum');
        state = await waitForState(
          context,
          (candidate) => {
            const sequence = spectrumSummary(candidate.text).sequence;
            return hasSpectrum(candidate.text)
              && hasButton(candidate.text, 'Stop')
              && sequence !== null
              && sequence !== previousSequence;
          },
          `fresh running spectrum for ${profile.id}`,
          context.options.acquisitionTimeoutMs,
        );
        assertNoFatalUi(state, `continuous profile switch ${profile.id}`);
        const nextSequence = spectrumSummary(state.text).sequence;
        context.stress.sweepProgressions.push({
          kind: 'continuous-profile-switch',
          profileId: profile.id,
          fromSequence: previousSequence,
          toSequence: nextSequence,
          completionLatencyMs: Date.now() - switchStarted,
        });
        record.steps.switch = {
          ok: true,
          completedAt: new Date().toISOString(),
          sweep: spectrumSummary(state.text),
        };
      } catch (error) {
        const failure = { profileId: profile.id, step: 'switch', ...serializeError(error) };
        record.failures.push(failure);
        run.failures.push(failure);
        await captureFailure(context, state, profile.id, 'switch-failure');
        if (context.options.failFast) throw error;
        state = await freshState(context);
      } finally {
        record.completedAt = new Date().toISOString();
        try {
          await sampleRendererMemory(context, 'soak-profile-complete', profile.id);
        } catch (error) {
          const failure = { profileId: profile.id, step: 'renderer-memory-sample', ...serializeError(error) };
          record.failures.push(failure);
          run.failures.push(failure);
        }
        await persistRun(context, run);
      }
    }
  } finally {
    try {
      state = await ensureStopped(context, state ?? await freshState(context));
    } catch (error) {
      run.failures.push({ profileId: null, step: 'final-stop', ...serializeError(error) });
    }
    try {
      run.stress.bounds = validateLiveStressEvidence(run.stress, context.options);
    } catch (error) {
      run.failures.push({ profileId: null, step: 'stress-bounds', ...serializeError(error) });
    }
    try {
      await sampleRendererMemory(context, 'soak-complete', null);
      const rendererMemoryRunCompletedAt = new Date().toISOString();
      run.stress.rendererMemory = validateRendererMemorySamples(
        run.stress.rendererMemorySamples,
        {
          ...context.options,
          requireMeasuredRendererMemory: isFullAcceptanceRunKind(run.kind),
          rendererMemoryRunStartedAt: run.startedAt,
          rendererMemoryRunCompletedAt,
        },
      );
    } catch (error) {
      run.failures.push({ profileId: null, step: 'renderer-memory', ...serializeError(error) });
    }
    completeRun(run);
    await persistRun(context, run);
  }

  return Object.freeze({
    artifactDirectory: context.artifactDirectory,
    reportPath: context.reportPath,
    summary: summarizeSignalLabLiveRun(run),
    run,
  });
}

async function createContext(input, optionOverrides = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('Live exercise input is required');
  const sky = input.sky;
  if (!sky || typeof sky.get_app_state !== 'function' || typeof sky.click !== 'function') {
    throw new TypeError('Live exercise requires the Computer Use sky object');
  }
  const inspectSignalLabSession = input.inspectSignalLabSession
    ?? createAtomizerLogSignalLabSessionInspector(input.signalLabSessionLogOptions);
  if (typeof inspectSignalLabSession !== 'function') {
    throw new TypeError('inspectSignalLabSession must be a function when supplied');
  }
  const app = requireNonEmptyString(input.app ?? 'org.tinysa.atomizer.dev', 'app');
  const options = Object.freeze({
    ...DEFAULT_OPTIONS,
    ...(input.options ?? {}),
    ...optionOverrides,
  });
  if (!['all', 'failures', 'none'].includes(options.screenshotPolicy)) {
    throw new RangeError('screenshotPolicy must be all, failures, or none');
  }
  for (const [label, value] of [
    ['maximumControlResponseMs', options.maximumControlResponseMs],
    ['maximumAccessibilitySnapshotMs', options.maximumAccessibilitySnapshotMs],
    ['maximumFirstSweepLatencyMs', options.maximumFirstSweepLatencyMs],
    ['maximumStopLatencyMs', options.maximumStopLatencyMs],
    ['maximumMillisecondsPerSweepOpportunity', options.maximumMillisecondsPerSweepOpportunity],
    ['maximumResponsivenessTourMs', options.maximumResponsivenessTourMs],
    ['profileTimeoutMs', options.profileTimeoutMs],
    ['acquisitionTimeoutMs', options.acquisitionTimeoutMs],
    ['minimumContinuousSweepProgressions', options.minimumContinuousSweepProgressions],
    ['minimumScreenshotWidth', options.minimumScreenshotWidth],
    ['minimumScreenshotHeight', options.minimumScreenshotHeight],
    ['classificationTimeoutMs', options.classificationTimeoutMs],
    ['rendererMemoryPlateauWindow', options.rendererMemoryPlateauWindow],
    ['rendererMemoryMaximumPlateauGrowthBytes', options.rendererMemoryMaximumPlateauGrowthBytes],
    ['rendererMemoryHardLimitBytes', options.rendererMemoryHardLimitBytes],
  ]) requireSafeInteger(value, label);
  for (const [label, value] of [
    ['narrowMarkerProfileIds', options.narrowMarkerProfileIds],
    ['wideMarkerProfileIds', options.wideMarkerProfileIds],
    ['iqZoomProfileIds', options.iqZoomProfileIds],
    ['iqContinuousProfileIds', options.iqContinuousProfileIds],
  ]) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
      throw new TypeError(`${label} must be an array of non-empty profile IDs`);
    }
  }
  const rendererMemorySampler = input.sampleRendererMemory
    ?? createAtomizerLogRendererMemorySampler(input.rendererMemoryLogOptions);
  if (rendererMemorySampler !== undefined && typeof rendererMemorySampler !== 'function') {
    throw new TypeError('sampleRendererMemory must be a function when supplied');
  }
  const suppliedRendererMemorySamples = normalizeRendererMemorySamples(
    input.rendererMemorySamples ?? [],
    'externally-supplied',
  );
  const fullCatalog = await loadSignalLabLiveCatalog(input.catalogModuleUrl);
  const fullCatalogIds = new Set(fullCatalog.map(({ id }) => id));
  for (const profileId of [
    ...options.narrowMarkerProfileIds,
    ...options.wideMarkerProfileIds,
    ...options.iqZoomProfileIds,
    ...options.iqContinuousProfileIds,
  ]) {
    if (!fullCatalogIds.has(profileId)) throw new Error(`Exercise option references unknown profile ID ${profileId}`);
  }
  if (options.narrowMarkerProfileIds.some((id) => options.wideMarkerProfileIds.includes(id))) {
    throw new Error('A marker profile cannot be both narrow and wide');
  }
  const requestedProfileIds = input.profileIds ?? fullCatalog.map(({ id }) => id);
  if (!Array.isArray(requestedProfileIds) || requestedProfileIds.length === 0) {
    throw new TypeError('profileIds must be a non-empty array when supplied');
  }
  const requested = new Set(requestedProfileIds);
  if (requested.size !== requestedProfileIds.length) throw new Error('profileIds contains duplicates');
  const catalog = fullCatalog.filter(({ id }) => requested.has(id));
  if (catalog.length !== requested.size) {
    const unknown = [...requested].filter((id) => !fullCatalog.some((profile) => profile.id === id));
    throw new Error(`Unknown SignalLab profile IDs: ${unknown.join(', ')}`);
  }

  const runId = requireSafeArtifactName(
    input.runId ?? new Date().toISOString().replaceAll(':', '').replaceAll('.', '-'),
  );
  const artifactRoot = resolve(input.artifactRoot ?? join(repositoryRoot, '.artifacts', 'live-signal-lab'));
  const artifactDirectory = join(artifactRoot, runId);
  await mkdir(artifactDirectory, { recursive: true });
  return {
    sky,
    app,
    options,
    catalog,
    inspectSignalLabSession,
    rendererMemorySampler,
    stress: {
      actionLatencies: [],
      accessibilitySnapshotLatencies: [],
      sweepProgressions: [],
      rendererMemorySamples: [...suppliedRendererMemorySamples],
    },
    artifactDirectory,
    reportPath: join(artifactDirectory, 'report.json'),
  };
}

async function inspectActualSignalLabSession(context, state, checkpoint) {
  if (typeof context.inspectSignalLabSession !== 'function') {
    throw new Error(
      'Classifier release gate requires inspectSignalLabSession to record the actual opaque producer session identity',
    );
  }
  const visibleSource = liveSignalLabSourceSessionSummary(state.text);
  const value = await context.inspectSignalLabSession({
    app: context.app,
    checkpoint,
    visibleSource,
  });
  return liveSignalLabProducerSessionEvidence(value, visibleSource);
}

export function liveSignalLabProducerSessionEvidence(
  value,
  visibleSource,
  inspectedAt = new Date().toISOString(),
) {
  if (!value || typeof value !== 'object') {
    throw new TypeError('inspectSignalLabSession must return a session snapshot object');
  }
  if (!visibleSource || typeof visibleSource !== 'object'
    || !Number.isSafeInteger(visibleSource.sourceSequence)
    || visibleSource.sourceSequence < 0) {
    throw new TypeError('SignalLab producer session evidence requires a visible source sequence');
  }
  if (typeof inspectedAt !== 'string' || !Number.isFinite(Date.parse(inspectedAt))) {
    throw new TypeError('SignalLab producer session inspectedAt must be a timestamp');
  }
  const sessionId = requireNonEmptyString(value.sessionId, 'SignalLab producer session ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(sessionId)) {
    throw new Error('SignalLab producer session ID must be its actual opaque UUID');
  }
  const identity = value.identity ?? value.provenance;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new TypeError('SignalLab producer session snapshot omitted its identity/provenance object');
  }
  const driverId = value.driverId ?? identity.driverId;
  if (driverId !== 'signal-lab'
    || !['signal-lab', 'signal-lab-simulation'].includes(identity.sourceKind)) {
    throw new Error('SignalLab producer session snapshot did not identify the admitted SignalLab source');
  }
  const producerConfigurationEpoch = typeof identity.producerConfigurationEpoch === 'string'
    ? identity.producerConfigurationEpoch
    : null;
  const stableIdentity = Object.fromEntries(Object.entries(identity).filter(([key]) => (
    !['producerConfigurationEpoch', 'configurationRevision', 'sequence'].includes(key)
  )));
  const canonicalIdentity = canonicalJson(stableIdentity);
  return {
    sessionId,
    driverId,
    identity: JSON.parse(canonicalIdentity),
    identitySha256: createHash('sha256').update(canonicalIdentity).digest('hex'),
    producerConfigurationEpoch,
    visibleSource,
    inspectedAt,
  };
}

function createRunRecord(context, kind) {
  const classifierReleaseGate = kind === 'classifier-release-gate';
  const defaultGeometrySmoke = kind === 'default-1024-user-path-smoke';
  const standaloneKind = classifierReleaseGate || defaultGeometrySmoke;
  return {
    schemaVersion: LIVE_SIGNAL_LAB_EXERCISE_SCHEMA_VERSION,
    kind: standaloneKind
      ? kind
      : liveSignalLabRunKind(kind, context.catalog.length),
    catalogCoverage: classifierReleaseGate
      ? 'fitted-classifier-release-catalog'
      : defaultGeometrySmoke
        ? 'default-user-path-smoke'
      : context.catalog.length === EXPECTED_SIGNAL_LAB_PROFILE_COUNT
        ? 'closed-catalog'
        : 'debug-subset',
    app: context.app,
    startedAt: new Date().toISOString(),
    completedAt: null,
    options: context.options,
    catalog: context.catalog,
    profiles: [],
    failures: [],
    stress: context.stress,
    visualContentReview: {
      automatedClaim: 'fresh-frame-and-dimensions-only-not-pixel-content-perfection',
      status: 'manual-review-required',
    },
    summary: null,
  };
}

async function runStep(context, run, profile, name, action) {
  const startedAt = new Date().toISOString();
  try {
    const result = await action();
    const state = result.state ?? result.detectState;
    if (state) assertNoFatalUi(state, `${profile.id} ${name}`);
    profile.steps[name] = {
      ok: true,
      startedAt,
      completedAt: new Date().toISOString(),
      ...withoutState(result),
    };
    await persistRun(context, run);
    return state;
  } catch (error) {
    const failure = { profileId: profile.id, step: name, ...serializeError(error) };
    profile.steps[name] = { ok: false, startedAt, completedAt: new Date().toISOString(), error: failure };
    profile.failures.push(failure);
    run.failures.push(failure);
    await captureFailure(context, await safeFreshState(context), profile.id, `${name}-failure`);
    await persistRun(context, run);
    if (context.options.failFast || name === 'select') throw error;
    return await freshState(context);
  }
}

async function selectProfile(context, state, profile) {
  state = await navigate(context, state, 'Generate');
  const familyLabel = FAMILY_BUTTON[profile.family];
  state = await clickElement(
    context,
    state,
    (body) => body.startsWith(`toggle button ${familyLabel} `),
    `${familyLabel} waveform family`,
  );
  state = await waitForState(
    context,
    (candidate) => candidate.text.includes('SignalLab Studio'),
    'SignalLab Studio after family selection',
    context.options.profileTimeoutMs,
  );

  if (profile.family === 'tone' || profile.family === 'analog') {
    const labLabel = profile.id === 'am' ? 'AM' : profile.id === 'fm' ? 'FM' : profile.label;
    if (!hasHeading(state.text, profile.label)) {
      state = await clickElement(
        context,
        state,
        (body) => body.startsWith(`button ${labLabel} `) || body === `button ${labLabel}`,
        `SignalLab profile ${profile.id}`,
      );
    }
  } else if (!hasHeading(state.text, profile.label)) {
    const selectLabel = FAMILY_SELECT_LABEL[profile.family];
    state = await clickElement(
      context,
      state,
      (body) => body.startsWith(`pop up button Description: ${selectLabel}, Value:`),
      `${selectLabel} selector`,
    );
    state = await clickElement(
      context,
      state,
      (body) => menuItemLabel(body) === profile.label,
      `${profile.label} native menu item`,
    );
  }

  state = await waitForState(
    context,
    (candidate) => hasHeading(candidate.text, profile.label)
      && candidate.text.includes('text SELECTED'),
    `SignalLab selected profile ${profile.id}`,
    context.options.profileTimeoutMs,
  );
  assertNoFatalUi(state, `profile selection ${profile.id}`);
  return state;
}

async function exerciseSingleSpectrum(context, state, profile) {
  state = await ensureStopped(context, state);
  state = await navigate(context, state, 'Spectrum');
  const previousSweep = spectrumSummary(state.text).sequence;
  state = await waitForState(
    context,
    (candidate) => findElementIndex(candidate.text, enabledButton('Single')) !== undefined,
    'enabled global Single control',
    context.options.acquisitionTimeoutMs,
  );
  const acquisitionStarted = Date.now();
  state = await clickElement(context, state, enabledButton('Single'), 'global Single');
  state = await waitForState(
    context,
    (candidate) => {
      const summary = spectrumSummary(candidate.text);
      return hasSpectrum(candidate.text)
        && findElementIndex(candidate.text, enabledButton('Single')) !== undefined
        && (previousSweep === null || summary.sequence !== previousSweep);
    },
    'fresh complete spectrum sweep',
    context.options.acquisitionTimeoutMs,
  );
  assertNoFatalUi(state, 'single spectrum acquisition');
  const sweep = spectrumSummary(state.text);
  const geometry = liveSweepGeometrySummary(state.text);
  if (geometry.plotPoints !== 450) {
    throw new Error(`${profile.id} full marker-oracle exercise did not retain 450 sweep points`);
  }
  const completionLatencyMs = Date.now() - acquisitionStarted;
  context.stress.sweepProgressions.push({
    kind: 'single',
    profileId: profile.id,
    fromSequence: previousSweep,
    toSequence: sweep.sequence,
    completionLatencyMs,
  });
  assertRecommendedVisibleRange(profile, sweep.visibleRangeHz, 'full marker-oracle exercise');
  return { state, sweep, geometry, completionLatencyMs };
}

function assertRecommendedVisibleRange(profile, visibleRangeHz, operation) {
  const expectedStartHz = Math.round(profile.centerHz - profile.recommendedSpanHz / 2);
  const expectedStopHz = Math.round(profile.centerHz + profile.recommendedSpanHz / 2);
  const toleranceHz = Math.max(1, Math.round(profile.recommendedSpanHz / 1_000_000));
  if (!visibleRangeHz
    || Math.abs(visibleRangeHz.startHz - expectedStartHz) > toleranceHz
    || Math.abs(visibleRangeHz.stopHz - expectedStopHz) > toleranceHz) {
    throw new Error(
      `${profile.id} ${operation} visible range did not match ${expectedStartHz}-${expectedStopHz} Hz`,
    );
  }
}

async function exerciseContinuousDetection(context, state, profile) {
  state = await ensureStopped(context, state);
  state = await navigate(context, state, 'Spectrum');
  const previousSequence = spectrumSummary(state.text).sequence;
  const runStarted = Date.now();
  const seenSequences = new Set();
  const observedSequenceTimes = new Map();
  const recordObservedSequence = (candidate) => {
    const sequence = spectrumSummary(candidate.text).sequence;
    if (Number.isSafeInteger(sequence)) {
      seenSequences.add(sequence);
      if (!observedSequenceTimes.has(sequence)) observedSequenceTimes.set(sequence, Date.now());
    }
    return sequence;
  };
  state = await clickElement(context, state, enabledButton('Run'), 'global Run');
  state = await waitForState(
    context,
    (candidate) => {
      const sequence = recordObservedSequence(candidate);
      return hasButton(candidate.text, 'Stop')
        && sequence !== null
        && sequence !== previousSequence;
    },
    'continuous acquisition Stop control and first fresh sweep',
    context.options.acquisitionTimeoutMs,
  );
  const firstSweepLatencyMs = Date.now() - runStarted;
  while (seenSequences.size < context.options.minimumContinuousSweepProgressions) {
    state = await waitForState(
      context,
      (candidate) => {
        const sequence = spectrumSummary(candidate.text).sequence;
        const isNewSequence = Number.isSafeInteger(sequence) && !seenSequences.has(sequence);
        recordObservedSequence(candidate);
        return hasButton(candidate.text, 'Stop')
          && isNewSequence;
      },
      `continuous sweep progression ${seenSequences.size + 1}`,
      context.options.acquisitionTimeoutMs,
    );
  }
  const responsivenessTour = await exerciseRunningResponsivenessTour(
    context,
    state,
    recordObservedSequence,
  );
  state = responsivenessTour.state;
  const sweepProgression = {
    kind: 'continuous',
    profileId: profile.id,
    fromSequence: previousSequence,
    sequences: [...seenSequences],
    firstSweepLatencyMs,
    elapsedMs: Date.now() - runStarted,
    responsivenessTour: withoutState(responsivenessTour),
  };
  context.stress.sweepProgressions.push(sweepProgression);
  state = await navigate(context, state, 'Detect');
  let detectState;
  let stopLatencyMs = null;
  const classificationTimeoutMs = liveSignalLabClassificationTimeoutMs(
    profile,
    context.options.classificationTimeoutMs,
  );
  const requiredClassificationOpportunities =
    liveSignalLabRequiredClassificationOpportunities(profile);
  const classificationStarted = Date.now();
  const classificationDeadline = classificationStarted + classificationTimeoutMs;
  let classificationLatencyMs = null;
  try {
    detectState = await waitForState(
      context,
      (candidate) => {
        recordObservedSequence(candidate);
        const summary = detectionSummary(candidate.text);
        return hasSpectrum(candidate.text)
          && hasButton(candidate.text, 'Stop')
          && summary.active > 0
          && observedSequenceOpportunityCount(seenSequences)
            >= requiredClassificationOpportunities
          && (!context.options.requireClassification || summary.classification !== null);
      },
      'active detection and Bayesian classification',
      remainingTimeoutMs(classificationDeadline, 'initial classification evidence'),
    );
    if (context.options.requireDetectAutoTarget) {
      detectState = await clickElement(
        context,
        detectState,
        autoMostProminentButton,
        'Detect Auto · most prominent',
      );
      detectState = await waitForState(
        context,
        (candidate) => {
          recordObservedSequence(candidate);
          const acceptance = liveDetectAcceptanceSummary(candidate.text);
          const summary = detectionSummary(candidate.text);
          return detectAutoAcceptanceSatisfied(
            acceptance,
            context.options.requireClassification,
            profile,
            observedSequenceOpportunityCount(seenSequences),
          )
            && summary.active > 0
            && (!context.options.requireClassification || summary.classification !== null);
        },
        'Detect Auto-most-prominent rank-0 target selection',
        remainingTimeoutMs(classificationDeadline, 'Auto-target classification evidence'),
      );
    }
    classificationLatencyMs = Date.now() - classificationStarted;
    assertNoFatalUi(detectState, 'continuous detection/classification');
    const detectAcceptance = liveDetectAcceptanceSummary(detectState.text);
    if (context.options.requireDetectAutoTarget
      && !detectAutoAcceptanceSatisfied(
        detectAcceptance,
        context.options.requireClassification,
        profile,
        observedSequenceOpportunityCount(seenSequences),
      )) {
      throw new Error(
        `Detect Auto acceptance was incomplete: ${JSON.stringify({
          pressed: detectAcceptance.autoControlPressed,
          targetCount: detectAcceptance.autoTargetCount,
          rank: detectAcceptance.autoTargetRank,
          integratedExcessDbm: detectAcceptance.autoTargetIntegratedExcessDbm,
          supportCellCount: detectAcceptance.autoTargetSupportCellCount,
          classificationResolved: detectAcceptance.autoClassificationResolved,
          resultLabel: detectAcceptance.autoClassificationResultLabel,
          resultLinked: detectAcceptance.autoClassificationResultLinked,
          observedSequenceOpportunities: observedSequenceOpportunityCount(seenSequences),
          requiredClassificationOpportunities,
          persistenceSweeps: detectAcceptance.autoTargetPersistenceSweeps,
          positiveLooks: detectAcceptance.autoTargetPositiveLooks,
          opportunityLooks: detectAcceptance.autoTargetOpportunityLooks,
        })}`,
      );
    }
    if (context.options.requireDetectNoInnerScroll && detectAcceptance.hasInnerScroll) {
      throw new Error(
        `Detect exposed inner scrolling in the live accessibility snapshot: ${detectAcceptance.innerScrollElements.join(' | ')}`,
      );
    }
    const visual = await liveScreenshotEvidence(context, detectState, 'Detect');
    detectState = { ...detectState, liveAcceptance: { detectAcceptance, visual } };
    sweepProgression.sequences = [...seenSequences];
    sweepProgression.classificationTimeoutMs = classificationTimeoutMs;
    sweepProgression.classificationLatencyMs = classificationLatencyMs;
    const observedSequenceEntries = [...observedSequenceTimes.entries()]
      .sort(([left], [right]) => left - right);
    const [firstObservedSequence, firstObservedAtMs] = observedSequenceEntries[0] ?? [null, null];
    const [lastObservedSequence, lastObservedAtMs] = observedSequenceEntries.at(-1) ?? [null, null];
    const sequenceDelta = Number.isSafeInteger(firstObservedSequence)
      && Number.isSafeInteger(lastObservedSequence)
      ? lastObservedSequence - firstObservedSequence
      : null;
    const observationElapsedMs = Number.isFinite(firstObservedAtMs)
      && Number.isFinite(lastObservedAtMs)
      ? lastObservedAtMs - firstObservedAtMs
      : null;
    sweepProgression.sweepRateEvidence = {
      firstObservedSequence,
      lastObservedSequence,
      sequenceDelta,
      observedSequenceOpportunities: Number.isSafeInteger(sequenceDelta)
        ? sequenceDelta + 1
        : null,
      observationElapsedMs,
      millisecondsPerSequenceOpportunity: Number.isSafeInteger(sequenceDelta)
        && sequenceDelta > 0
        && Number.isSafeInteger(observationElapsedMs)
        ? observationElapsedMs / sequenceDelta
        : null,
    };
    sweepProgression.totalElapsedMs = Date.now() - runStarted;
    sweepProgression.classificationEvidence = {
      requiredOpportunities: requiredClassificationOpportunities,
      observedSequenceOpportunities: observedSequenceOpportunityCount(seenSequences),
      persistenceSweeps: detectAcceptance.autoTargetPersistenceSweeps,
      positiveLooks: detectAcceptance.autoTargetPositiveLooks,
      opportunityLooks: detectAcceptance.autoTargetOpportunityLooks,
      resultLabel: detectAcceptance.autoClassificationResultLabel,
      resultQualification: detectAcceptance.autoClassificationResultQualification,
      resultLinkedToAutoTarget: detectAcceptance.autoClassificationResultLinked,
      expectation: interleavedFullCatalogClassificationRecord(
        profile,
        detectAcceptance.autoClassificationResultLabel,
      ),
    };
  } finally {
    const current = detectState ?? await safeFreshState(context);
    if (current) {
      const stopStarted = Date.now();
      state = await ensureStopped(context, current);
      stopLatencyMs = Date.now() - stopStarted;
    }
  }
  sweepProgression.stopLatencyMs = stopLatencyMs;
  sweepProgression.totalElapsedMs = Date.now() - runStarted;
  return {
    state,
    detectState: detectState ?? state,
    detection: detectionSummary((detectState ?? state).text),
    detectAcceptance: detectState?.liveAcceptance?.detectAcceptance ?? null,
    visual: detectState?.liveAcceptance?.visual ?? null,
    sweepProgression,
    classificationTimeoutMs,
    requiredClassificationOpportunities,
    classificationLatencyMs,
    stopLatencyMs,
  };
}

async function exerciseRunningResponsivenessTour(context, state, recordObservedSequence) {
  const started = Date.now();
  const routes = [];
  const visit = async (label) => {
    state = await navigate(context, state, label);
    state = await waitForState(
      context,
      (candidate) => {
        recordObservedSequence(candidate);
        return hasButton(candidate.text, 'Stop')
          && liveWorkspaceIsVisible(candidate.text, label);
      },
      `${label} workspace while global Run remains active`,
      context.options.profileTimeoutMs,
    );
    const sequence = recordObservedSequence(state);
    routes.push({ label, stopPresent: true, sequence });
  };
  for (const label of ['Waterfall', 'Channel', 'I/Q', 'Spectrum']) await visit(label);

  const controls = [];
  if (!hasEditableDisclosure(state.text, 'Center frequency')) {
    state = await clickElement(
      context,
      state,
      enabledButton('Sweep setup'),
      'Sweep setup during active Run responsiveness tour',
    );
  }
  state = await waitForState(
    context,
    (candidate) => {
      recordObservedSequence(candidate);
      return hasButton(candidate.text, 'Stop')
        && hasEditableDisclosure(candidate.text, 'Center frequency');
    },
    'editable Sweep setup while global Run remains active',
    context.options.profileTimeoutMs,
  );
  controls.push('sweep-setup');
  state = await clickElement(
    context,
    state,
    enabledButton('Sweep setup'),
    'close Sweep setup during active Run responsiveness tour',
  );

  if (findElementIndex(state.text, enabledButton('Peak')) === undefined) {
    state = await clickElement(
      context,
      state,
      enabledButton('Traces & markers'),
      'Traces & markers during active Run responsiveness tour',
    );
  }
  if (findElementIndex(state.text, enabledButton('Peak')) === undefined
    && findElementIndex(state.text, enabledButtonStarting('Markers')) !== undefined) {
    state = await clickElement(
      context,
      state,
      enabledButtonStarting('Markers'),
      'Markers panel during active Run',
    );
  }
  state = await waitForState(
    context,
    (candidate) => {
      recordObservedSequence(candidate);
      return hasButton(candidate.text, 'Stop')
        && findElementIndex(candidate.text, enabledButton('Peak')) !== undefined;
    },
    'marker controls while global Run remains active',
    context.options.profileTimeoutMs,
  );
  controls.push('traces-and-markers');
  const elapsedMs = Date.now() - started;
  if (elapsedMs > context.options.maximumResponsivenessTourMs) {
    throw new Error(
      `Active Run responsiveness tour took ${elapsedMs} ms; limit ${context.options.maximumResponsivenessTourMs} ms`,
    );
  }
  return { state, routes, controls, elapsedMs };
}

async function exercisePeakMarker(context, state, profile) {
  state = await ensureStopped(context, state);
  state = await navigate(context, state, 'Spectrum');
  if (findElementIndex(state.text, enabledButton('Peak')) === undefined) {
    state = await clickElement(
      context,
      state,
      enabledButton('Traces & markers'),
      'Traces & markers overlay',
    );
  }
  state = await normalizeM1Normal(context, state);
  state = await clickElement(context, state, enabledButton('Peak'), 'marker Peak search');
  state = await waitForState(
    context,
    (candidate) => liveMarkerSummary(candidate.text).frequencyHz !== null
      && candidate.text.includes('Marker M1 local characterization'),
    'visible M1 reading and local characterization',
    context.options.acquisitionTimeoutMs,
  );
  assertNoFatalUi(state, `peak marker ${profile.id}`);
  const marker = liveMarkerSummary(state.text);
  const characterization = liveMarkerCharacterizationSummary(state.text);
  const markerGeometry = liveSweepGeometrySummary(state.text);
  if (markerGeometry.plotPoints !== 450) {
    throw new Error(`${profile.id} marker oracle requires 450-point swept geometry`);
  }
  const markerExpectation = liveSignalLabMarkerExpectation(profile);
  validateLiveMarkerEvidence(marker, characterization, profile, markerExpectation);
  return {
    state,
    marker: { ...marker, ...characterization },
    markerExpectation,
    markerGeometry,
  };
}

export function liveMarkerM1ReadoutIsNormal(text) {
  const bodies = accessibilityBodies(text);
  const markerOneSelected = bodies.some((body) => (
    /^button Marker 1,.*\bselected\b/i.test(body)
  ));
  const normalReadout = bodies.some((body) => (
    /^pop up button Description: Readout, Value:\s*Normal(?:,|$)/i.test(body)
  ));
  return markerOneSelected && normalReadout;
}

async function normalizeM1Normal(context, state) {
  if (findElementIndex(state.text, (body) => /^button Marker 1,/i.test(body)) === undefined) {
    state = await clickElement(context, state, enabledButtonStarting('Markers'), 'Markers panel');
  }
  state = await waitForState(
    context,
    (candidate) => findElementIndex(
      candidate.text,
      (body) => /^button Marker 1,/i.test(body),
    ) !== undefined,
    'Marker 1 controls',
    context.options.profileTimeoutMs,
  );
  if (findElementIndex(
    state.text,
    (body) => /^button Marker 1,.*\bselected\b/i.test(body),
  ) === undefined) {
    state = await clickElement(
      context,
      state,
      (body) => /^button Marker 1,/i.test(body),
      'select Marker 1',
    );
  }
  if (!liveMarkerM1ReadoutIsNormal(state.text)) {
    state = await clickElement(
      context,
      state,
      (body) => /^pop up button Description: Readout, Value:/i.test(body)
        && !body.includes('(disabled)'),
      'Marker 1 Readout selector',
    );
    state = await clickElement(
      context,
      state,
      (body) => menuItemLabel(body) === 'Normal',
      'Marker 1 Normal readout menu item',
    );
  }
  return await waitForState(
    context,
    (candidate) => liveMarkerM1ReadoutIsNormal(candidate.text)
      && findElementIndex(candidate.text, enabledButton('Peak')) !== undefined,
    'Marker 1 Normal readout before Peak',
    context.options.profileTimeoutMs,
  );
}

async function exerciseWaterfall(context, state) {
  state = await navigate(context, state, 'Waterfall');
  state = await waitForState(
    context,
    (candidate) => candidate.text.includes('image Measured power by frequency and sweep time')
      && !candidate.text.includes('text No history'),
    'coherent waterfall history',
    context.options.acquisitionTimeoutMs,
  );
  return {
    state,
    history: matchText(state.text, /COHERENT HISTORY\s+(\d+)\s+\/\s+(\d+)/i),
  };
}

async function exerciseChannel(context, state, profile) {
  state = await navigate(context, state, 'Channel');
  state = await waitForState(
    context,
    (candidate) => /3\s+dB\s+BANDWIDTH/i.test(candidate.text)
      && !candidate.text.includes('Measurement unavailable'),
    'channel measurement result',
    context.options.acquisitionTimeoutMs,
  );
  const summary = liveChannelSummary(state.text);
  if (profile.id === 'cw') {
    if (summary.status === 'unavailable') {
      throw new Error(`CW 3 dB bandwidth is unavailable: ${summary.detail ?? 'no detail'}`);
    }
    if (summary.bandwidthHz !== null && summary.bandwidthHz >= profile.recommendedSpanHz * 0.9) {
      throw new Error(
        `CW 3 dB bandwidth ${summary.bandwidthHz} Hz spans nearly the entire ${profile.recommendedSpanHz} Hz view`,
      );
    }
  }
  return { state, channel: summary };
}

async function exerciseIq(context, state, profile) {
  state = await ensureStopped(context, state);
  state = await navigate(context, state, 'I/Q');
  if (context.options.requireNoLocalIqCaptureButton && liveButtonExists(state.text, 'Capture I/Q')) {
    throw new Error('I/Q workspace still exposes the redundant local Capture I/Q button');
  }
  state = await clickElement(context, state, enabledButton('Single'), 'global Single for I/Q');
  state = await waitForState(
    context,
    (candidate) => !candidate.text.includes('NO COMPLEX-SAMPLE CAPTURE YET')
      && /Capture\s+[0-9a-f-]{16,}\s+·/i.test(candidate.text)
      && findElementIndex(candidate.text, enabledButton('Single')) !== undefined,
    `complete complex-I/Q capture for ${profile.id}`,
    context.options.acquisitionTimeoutMs,
  );
  assertNoFatalUi(state, `complex I/Q ${profile.id}`);
  const configuredCenterHz = disclosureFrequency(state.text, 'Center frequency');
  if (configuredCenterHz === null || configuredCenterHz !== profile.centerHz) {
    throw new Error(
      `${profile.id} I/Q center ${String(configuredCenterHz)} did not match catalog center ${profile.centerHz} Hz`,
    );
  }

  let zoom = matchText(state.text, /I\/Q plot zoom[\s\S]{0,120}?text\s+([\d.]+×)/i);
  if (context.options.iqZoomProfileIds.includes(profile.id)) {
    state = await clickElement(
      context,
      state,
      (body) => body.startsWith('button Zoom I/Q plots in'),
      'I/Q zoom in',
    );
    if (!state.text.includes('text 2×')) throw new Error('I/Q zoom-in control did not reach 2×');
    state = await clickElement(
      context,
      state,
      (body) => body.startsWith('button Fit I/Q plots to capture'),
      'I/Q fit',
    );
    if (!state.text.includes('text 1×')) throw new Error('I/Q fit control did not restore 1×');
    zoom = '1×';
  }

  let continuousBuffers = null;
  if (context.options.iqContinuousProfileIds.includes(profile.id)) {
    const firstCapture = iqCaptureId(state.text);
    state = await clickElement(context, state, enabledButton('Run'), 'global Run for I/Q');
    state = await waitForState(
      context,
      (candidate) => hasButton(candidate.text, 'Stop')
        && iqCaptureId(candidate.text) !== null
        && iqCaptureId(candidate.text) !== firstCapture
        && hasEditableDisclosure(candidate.text, 'Center frequency')
        && hasEditableDisclosure(candidate.text, 'Sample rate')
        && hasEditableDisclosure(candidate.text, 'Capture bandwidth')
        && hasEditableDisclosure(candidate.text, 'Complex samples'),
      `second bounded I/Q buffer for ${profile.id}`,
      context.options.acquisitionTimeoutMs,
    );
    const secondCapture = iqCaptureId(state.text);
    state = await ensureStopped(context, state);
    const stoppedCapture = iqCaptureId(state.text);
    await delay(context.options.pollIntervalMs * 2);
    state = await freshState(context);
    if (iqCaptureId(state.text) !== stoppedCapture) {
      throw new Error('A new I/Q capture was published after the global Stop operation completed');
    }
    continuousBuffers = [firstCapture, secondCapture];
  }
  return { state, captureId: iqCaptureId(state.text), zoom, continuousBuffers };
}

async function navigate(context, state, label) {
  if (liveWorkspaceIsVisible(state.text, label)) return state;
  return await clickElement(context, state, enabledButton(label), `${label} workspace`);
}

export function liveSweepGeometrySummary(text) {
  const bodies = accessibilityBodies(text);
  const pointsBody = bodies.find((body) => (
    /Description: Edit Sweep points,/i.test(body)
  )) ?? null;
  const pointsMatch = pointsBody
    ? /Sweep points\s+([\d,]+)\s+points/i.exec(pointsBody)
    : null;
  const exactTiming = bodies
    .map((body) => /\bexact(?:ly)?(?:\s+at)?\s+([\d.]+)\s*(ms|s)\b/i.exec(body))
    .find(Boolean);
  const metrics = spectrumSummary(text).metrics;
  const plotPoints = metrics
    ? Number(/\b([\d,]+)\s+points\s+·\s+COMPLETE\b/i.exec(metrics)?.[1]?.replaceAll(',', ''))
    : Number.NaN;
  const sweepElapsedMs = metrics
    ? Number(/\bSweep\s+([\d.]+)\s*ms\b/i.exec(metrics)?.[1])
    : Number.NaN;
  return {
    configuredPoints: pointsMatch ? Number(pointsMatch[1].replaceAll(',', '')) : null,
    configuredSweepTimeSeconds: exactTiming
      ? Number(exactTiming[1]) * (exactTiming[2].toLowerCase() === 'ms' ? 1e-3 : 1)
      : null,
    plotPoints: Number.isSafeInteger(plotPoints) ? plotPoints : null,
    sweepElapsedMs: Number.isFinite(sweepElapsedMs) ? sweepElapsedMs : null,
    pinnedBayesianGeometryVisible: bodies.some((body) => (
      /450\s*×\s*50\s*ms\s*·\s*pinned Bayesian geometry/i.test(body)
    )),
  };
}

/** Visible producer clock and lifecycle state rendered by SignalLab Studio. */
export function liveSignalLabSourceSessionSummary(text) {
  const bodies = accessibilityBodies(text);
  const followingText = (label) => {
    const index = bodies.findIndex((body) => body.toUpperCase() === `TEXT ${label}`);
    if (index < 0) return null;
    const value = bodies.slice(index + 1).find((body) => /^text\s+\S/iu.test(body));
    return value?.replace(/^text\s+/iu, '').trim().toUpperCase() ?? null;
  };
  const footer = bodies.find((body) => /^text\s+SEQUENCE\s+\d+\s+·/iu.test(body)) ?? null;
  const sourceSequence = footer
    ? Number(/^text\s+SEQUENCE\s+(\d+)\s+·/iu.exec(footer)?.[1])
    : Number.NaN;
  return {
    sourceState: followingText('SOURCE'),
    sessionState: followingText('SESSION'),
    sourceSequence: Number.isSafeInteger(sourceSequence) ? sourceSequence : null,
    footer,
  };
}

async function configurePinnedSweepGeometry(context, state) {
  state = await ensureStopped(context, state);
  state = await navigate(context, state, 'Spectrum');
  if (!hasEditableDisclosure(state.text, 'Sweep points')) {
    state = await clickElement(context, state, enabledButton('Sweep setup'), 'Sweep setup');
  }
  state = await waitForState(
    context,
    (candidate) => hasEditableDisclosure(candidate.text, 'Sweep points'),
    'editable sweep geometry',
    context.options.profileTimeoutMs,
  );
  const before = liveSweepGeometrySummary(state.text);
  if (before.configuredSweepTimeSeconds !== 0.05) {
    throw new Error(
      `SignalLab fitted geometry requires exact 0.05 s timing; observed ${String(before.configuredSweepTimeSeconds)}`,
    );
  }
  if (before.configuredPoints !== 450) {
    if (typeof context.sky.set_value !== 'function' || typeof context.sky.press_key !== 'function') {
      throw new Error('Configuring fitted 450-point geometry requires sky.set_value and sky.press_key');
    }
    state = await clickElement(
      context,
      state,
      (body) => body.startsWith('disclosure triangle Description: Edit Sweep points,')
        && !body.includes('(disabled)'),
      'Edit Sweep points',
    );
    state = await waitForState(
      context,
      (candidate) => findElementIndex(candidate.text, sweepPointsTextField) !== undefined,
      'Sweep points numeric entry',
      context.options.profileTimeoutMs,
    );
    const fieldIndex = findElementIndex(state.text, sweepPointsTextField);
    const valueStarted = Date.now();
    await context.sky.set_value({ app: context.app, element_index: fieldIndex, value: '450' });
    context.stress.actionLatencies.push({
      label: 'set fitted Sweep points',
      latencyMs: Date.now() - valueStarted,
      ok: true,
    });
    state = await freshState(context);
    const commitStarted = Date.now();
    await context.sky.press_key({ app: context.app, key: 'Return' });
    context.stress.actionLatencies.push({
      label: 'commit fitted Sweep points',
      latencyMs: Date.now() - commitStarted,
      ok: true,
    });
    state = await waitForState(
      context,
      (candidate) => liveSweepGeometrySummary(candidate.text).configuredPoints === 450,
      'committed 450-point fitted sweep geometry',
      context.options.profileTimeoutMs,
    );
  }
  const configured = liveSweepGeometrySummary(state.text);
  if (configured.configuredPoints !== 450 || configured.configuredSweepTimeSeconds !== 0.05) {
    throw new Error('SignalLab fitted sweep geometry did not remain 450 points × 0.05 s');
  }
  state = await clickElement(context, state, enabledButton('Sweep setup'), 'close Sweep setup');
  return { state, before, configured };
}

function sweepPointsTextField(body) {
  return /^(?:text field|text box|edit text)\b.*(?:Description:\s*)?Sweep points\b/i.test(body)
    && !body.includes('(disabled)');
}

export function liveWorkspaceIsVisible(text, label) {
  if (label === 'Generate') return text.includes('SignalLab Studio');
  // Detect deliberately embeds the same live SpectrumPlot as Spectrum. The
  // standalone workspace is the intersection of that plot and its measurement
  // toolbar; using the plot alone leaves us on Detect and makes later marker
  // controls look spuriously absent.
  if (label === 'Spectrum') return text.includes('container Spectrum plot')
    && text.includes('button Traces & markers');
  if (label === 'Waterfall') return text.includes('container Sweep-history waterfall');
  if (label === 'Channel') return text.includes('Channel power, 3 dB bandwidth, ACP, and occupied bandwidth');
  if (label === 'I/Q') return text.includes('text Complex baseband');
  if (label === 'Detect') return text.includes('text Evidence') && text.includes('text Detection');
  return false;
}

async function closeAtomPanelIfRequested(context, state) {
  if (!context.options.closeAtomPanel) return state;
  const close = findElementIndex(state.text, enabledButton('Close Atom'));
  return close === undefined ? state : await clickIndex(context, close, 'Close Atom');
}

async function ensureStopped(context, state) {
  const stop = findElementIndex(state.text, enabledButton('Stop'));
  if (stop !== undefined) {
    state = await clickIndex(context, stop, 'global Stop');
  }
  return await waitForState(
    context,
    (candidate) => findElementIndex(candidate.text, enabledButton('Run')) !== undefined
      && findElementIndex(candidate.text, enabledButton('Single')) !== undefined,
    'stopped global acquisition controls',
    context.options.acquisitionTimeoutMs,
  );
}

async function clickElement(context, state, predicate, label) {
  const index = findElementIndex(state.text, predicate);
  if (index === undefined) {
    throw new Error(`${label} is not present in the fresh Atomizer accessibility state`);
  }
  return await clickIndex(context, index, label);
}

async function clickIndex(context, elementIndex, label = `element ${elementIndex}`) {
  const started = Date.now();
  try {
    await context.sky.click({ app: context.app, element_index: elementIndex });
    const state = await freshState(context);
    const latencyMs = Date.now() - started;
    if (latencyMs > context.options.maximumControlResponseMs) {
      throw new Error(
        `${label} took ${latencyMs} ms to acknowledge through Computer Use; limit ${context.options.maximumControlResponseMs} ms`,
      );
    }
    context.stress.actionLatencies.push({ label, latencyMs, ok: true });
    return state;
  } catch (error) {
    context.stress.actionLatencies.push({
      label,
      latencyMs: Date.now() - started,
      ok: false,
      error: serializeError(error).message,
    });
    throw error;
  }
}

async function freshState(context) {
  const started = Date.now();
  const state = await context.sky.get_app_state({ app: context.app, disableDiff: true });
  const latencyMs = Date.now() - started;
  context.stress.accessibilitySnapshotLatencies.push({ latencyMs });
  if (latencyMs > context.options.maximumAccessibilitySnapshotMs) {
    throw new Error(
      `Computer Use accessibility/screenshot snapshot took ${latencyMs} ms; limit ${context.options.maximumAccessibilitySnapshotMs} ms`,
    );
  }
  if (!state || typeof state.text !== 'string' || !state.text.includes('App: Atomizer Dev')) {
    throw new Error('Computer Use did not return the live Atomizer Dev application state');
  }
  return state;
}

async function safeFreshState(context) {
  try { return await freshState(context); }
  catch { return null; }
}

async function waitForState(context, predicate, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state;
  let predicateError;
  while (Date.now() <= deadline) {
    state = await freshState(context);
    const fatal = fatalUiMessage(state.text);
    if (fatal) throw new Error(`${description} exposed a fatal UI error: ${fatal}`);
    try {
      if (predicate(state)) return state;
      predicateError = undefined;
    } catch (error) {
      predicateError = error;
    }
    await delay(context.options.pollIntervalMs);
  }
  const fatal = state ? fatalUiMessage(state.text) : null;
  const suffix = fatal
    ? `; visible failure: ${fatal}`
    : predicateError
      ? `; last predicate error: ${serializeError(predicateError).message}`
      : '';
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}${suffix}`);
}

function assertSignalLabSession(state) {
  if (!state.text.includes('SignalLab synthetic measurement source')
    || !state.text.includes('SIGNALLAB SIMULATION')) {
    throw new Error('Live exercise requires the connected SignalLab synthetic measurement source');
  }
}

function assertNoFatalUi(state, operation) {
  const failure = fatalUiMessage(state.text);
  if (failure) throw new Error(`${operation} exposed a fatal UI error: ${failure}`);
}

function fatalUiMessage(text) {
  for (const pattern of FATAL_UI_PATTERNS) {
    const match = text.match(pattern);
    if (match) return surroundingText(text, match.index ?? 0, 512);
  }
  return null;
}

function findElementIndex(text, predicate) {
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match && predicate(match[2])) return Number(match[1]);
  }
  return undefined;
}

function enabledButton(label) {
  return (body) => liveButtonIsEnabled(body, label);
}

function enabledButtonStarting(label) {
  return (body) => body.startsWith(`button ${label}`) && !body.includes('(disabled)');
}

export function liveButtonIsEnabled(body, label) {
  return (body === `button ${label}` || body.startsWith(`button ${label},`))
    && !body.includes('(disabled)');
}

export function liveButtonExists(text, label) {
  return accessibilityBodies(text).some((body) => (
    body === `button ${label}`
      || body.startsWith(`button ${label},`)
      || body.startsWith(`button ${label} (`)
      || body === `toggle button ${label}`
      || body.startsWith(`toggle button ${label} `)
      || body.startsWith(`toggle button ${label},`)
  ));
}

function autoMostProminentButton(body) {
  return (body === 'button Auto · most prominent'
      || body.startsWith('button Auto · most prominent,')
      || body === 'toggle button Auto · most prominent'
      || body.startsWith('toggle button Auto · most prominent ')
      || body.startsWith('toggle button Auto · most prominent,'))
    && !body.includes('(disabled)');
}

export function liveDetectAcceptanceSummary(text) {
  const bodies = accessibilityBodies(text);
  const autoControl = bodies.find((body) => autoMostProminentButton(body)) ?? null;
  const autoTargetIndexes = bodies
    .map((body, index) => (/\bAUTO TARGET\b/i.test(body) ? index : -1))
    .filter((index) => index >= 0);
  const autoTargetIndex = autoTargetIndexes[0] ?? -1;
  const autoTarget = autoTargetIndex >= 0 ? bodies[autoTargetIndex] : null;
  const autoTargetRankIndex = autoTargetIndex < 0
    ? -1
    : nearestCandidateRankIndex(bodies, autoTargetIndex);
  const autoTargetRank = autoTargetRankIndex < 0
    ? null
    : candidateRank(bodies[autoTargetRankIndex]);
  const autoTargetSegment = autoTargetIndex < 0
    ? null
    : bodies.slice(
      autoTargetRankIndex < 0 ? Math.max(0, autoTargetIndex - 6) : autoTargetRankIndex,
      Math.min(bodies.length, autoTargetIndex + 3),
    ).join(' | ');
  const integratedExcess = autoTarget === null
    ? null
    : /integrated excess\s+([-−]?\d+(?:\.\d+)?)\s*dBm\s+·\s+(\d+)\s+cells?\b/i.exec(autoTarget);
  const autoTargetIntegratedExcessDbm = integratedExcess
    ? Number(integratedExcess[1].replace('−', '-'))
    : null;
  const autoTargetSupportCellCount = integratedExcess ? Number(integratedExcess[2]) : null;
  const persistenceSweeps = autoTarget
    ? numberMatch(autoTarget, /·\s+(\d+)\s+sweeps?\s+·\s+\d+\s+missed/i)
    : null;
  const agileLooks = autoTargetSegment
    ? /([\d,]+)\/([\d,]+)\s+positive\/opportunity looks/i.exec(autoTargetSegment)
    : null;
  const classification = detectionSummary(text).classification;
  const classificationResult = classificationResultCardSummary(bodies);
  const autoTargetClassificationLabel = autoTargetIndex < 0
    ? null
    : candidateClassificationLabel(
      bodies,
      autoTargetIndex,
      autoTargetRankIndex,
      classificationResult.label,
    );
  const autoClassificationResultLinked = autoTargetClassificationLabel !== null
    && classificationResult.label !== null
    && normalizeClassificationLabel(autoTargetClassificationLabel)
      === normalizeClassificationLabel(classificationResult.label);
  const targetSegmentPending = autoTargetSegment !== null
    && /Classification pending|Not a current visible target|Activity summary\s+·\s+targetable/i.test(autoTargetSegment);
  const scrollElements = bodies.filter((body) => (
    /^(?:scroll area|scroll bar|vertical scroll bar|horizontal scroll bar)\b/i.test(body)
  ));
  // Candidate lists and settings panes intentionally own bounded scrollbars.
  // The acceptance prohibition is only the outer document/workspace and the
  // compact classification capture/status strip, which must remain fixed.
  const forbiddenInnerScrollElements = scrollElements.filter((body) => (
    /(?:Atomizer Dev|document|web area|classification workspace|detection workspace|Detected-power evidence status|classification capture|capture status|workspace)/i.test(body)
  ));
  const summary = {
    autoControl,
    autoControlPresent: autoControl !== null,
    autoControlPressed: autoControl !== null
      && /(?:\(pressed\)|Value:\s*(?:1|true)|Selected:\s*true)/i.test(autoControl),
    autoTarget,
    autoTargetPresent: autoTarget !== null,
    autoTargetCount: autoTargetIndexes.length,
    autoTargetRank,
    autoTargetSegment,
    autoTargetIntegratedExcessDbm,
    autoTargetSupportCellCount,
    autoTargetPersistenceSweeps: persistenceSweeps,
    autoTargetPositiveLooks: agileLooks ? Number(agileLooks[1].replaceAll(',', '')) : null,
    autoTargetOpportunityLooks: agileLooks ? Number(agileLooks[2].replaceAll(',', '')) : null,
    autoTargetClassificationLabel,
    autoTargetEvidenceValid: autoTargetIndexes.length === 1
      && autoTargetRank === 1
      && Number.isFinite(autoTargetIntegratedExcessDbm)
      && Number.isSafeInteger(autoTargetSupportCellCount)
      && autoTargetSupportCellCount > 0,
    autoClassification: classification,
    autoClassificationResultLabel: classificationResult.label,
    autoClassificationResultQualification: classificationResult.qualification,
    autoClassificationResultLinked,
    autoClassificationResolved: classification !== null
      && !targetSegmentPending
      && classificationResult.qualification !== null
      && autoClassificationResultLinked,
    scrollElements,
    forbiddenInnerScrollElements,
    // Backward-compatible field name now means prohibited, not every nested
    // scrollbar in the intentionally scrollable candidate/settings panes.
    innerScrollElements: forbiddenInnerScrollElements,
    hasInnerScroll: forbiddenInnerScrollElements.length > 0,
  };
  return {
    ...summary,
    autoAcceptanceComplete: summary.autoControlPressed
      && summary.autoTargetEvidenceValid
      && summary.autoClassificationResolved,
  };
}

export function liveMarkerCharacterizationSummary(text) {
  const widthClassification = /Narrow\s+·\s+resolution limited/i.test(text)
    ? 'resolution-limited-narrow'
    : /Resolved local response\s+·\s+>2 resolution elements/i.test(text)
      ? 'resolved-wideband'
      : 'unavailable';
  const threeDecibel = labeledFrequencyMeasurement(
    text,
    /3\s+dB response width/i,
    [/99% component occupied bandwidth/i, /Signal \/ noise context/i],
  );
  const componentOccupiedBandwidth = labeledFrequencyMeasurement(
    text,
    /99% component occupied bandwidth/i,
    [/Signal \/ noise context/i, /Local evidence/i],
  );
  return {
    widthClassification,
    hasLocalCharacterization: /Marker M1 local characterization/i.test(text),
    hasThreeDecibelWidth: threeDecibel.labelPresent,
    threeDecibelStatus: threeDecibel.bandwidthHz === null
      ? threeDecibel.status
      : widthClassification === 'resolution-limited-narrow'
        ? 'resolution-limited'
        : widthClassification === 'resolved-wideband'
          ? 'resolved'
          : 'measured',
    threeDecibelBandwidthHz: threeDecibel.bandwidthHz,
    threeDecibelStartHz: threeDecibel.startHz,
    threeDecibelStopHz: threeDecibel.stopHz,
    threeDecibelDetail: threeDecibel.detail,
    threeDecibelUnavailableReason: markerThreeDecibelUnavailableReason(threeDecibel.detail),
    hasComponentOccupiedBandwidth: componentOccupiedBandwidth.labelPresent,
    componentOccupiedBandwidthStatus: componentOccupiedBandwidth.status,
    componentOccupiedBandwidthHz: componentOccupiedBandwidth.bandwidthHz,
    componentOccupiedBandwidthStartHz: componentOccupiedBandwidth.startHz,
    componentOccupiedBandwidthStopHz: componentOccupiedBandwidth.stopHz,
    componentOccupiedBandwidthDetail: componentOccupiedBandwidth.detail,
  };
}

export function liveMarkerSummary(text) {
  const bodies = accessibilityBodies(text);
  const anchor = bodies.findIndex((body) => /\bM\s*1\s+·\s+NORMAL\b/i.test(body));
  const segment = anchor < 0 ? [] : bodies.slice(anchor, anchor + 4);
  const frequency = segment
    .map((body) => /([-−]?\d+(?:[\d,.]*\d)?)\s*(Hz|kHz|MHz|GHz)\b/i.exec(body))
    .find(Boolean);
  const centroid = bodies
    .map((body) => /noise-subtracted linear-power center\s*\(\s*([-\u2212]?\d+(?:[\d,.]*\d)?)\s*(Hz|kHz|MHz|GHz)\s+centroid\s*\)/i.exec(body))
    .find(Boolean);
  return {
    line: segment.length ? segment.join(' | ') : null,
    frequencyHz: frequency ? frequencyToHz(frequency[1], frequency[2]) : null,
    powerCentroidHz: centroid ? frequencyToHz(centroid[1], centroid[2]) : null,
    characterization: bodies.filter((body) => (
      /3 dB response width/i.test(body)
      || /99% component occupied bandwidth/i.test(body)
      || /Resolved local response/i.test(body)
      || /resolution limited/i.test(body)
    )),
  };
}

export function validateLiveMarkerEvidence(
  marker,
  characterization,
  profile,
  expectation = liveSignalLabMarkerExpectation(profile),
) {
  if (!Number.isFinite(marker?.frequencyHz)) {
    throw new Error(`${profile.id} M1 omitted a finite parsed marker frequency`);
  }
  const halfSpan = profile.recommendedSpanHz / 2;
  if (marker.frequencyHz < profile.centerHz - halfSpan
    || marker.frequencyHz > profile.centerHz + halfSpan) {
    throw new Error(`M1 ${marker.frequencyHz} Hz is outside ${profile.id}'s recommended visible span`);
  }
  if (!characterization?.hasLocalCharacterization
    || !characterization.hasThreeDecibelWidth
    || !characterization.hasComponentOccupiedBandwidth) {
    throw new Error(`${profile.id} M1 omitted required local 3 dB/component-OBW characterization`);
  }
  const normalizedExpectation = typeof expectation === 'string'
    ? {
        allowedWidthClassifications: [expectation],
        allowedUnavailableReasons: [],
        centroidRequiredClassifications: expectation === RESOLVED_MARKER
          ? [RESOLVED_MARKER]
          : [],
        centroidRequiredUnavailableReasons: [],
        centroidAbsentClassifications: expectation === NARROW_MARKER
          ? [NARROW_MARKER]
          : [],
        centroidAbsentUnavailableReasons: [],
      }
    : expectation;
  const allowedWidthClassifications = normalizedExpectation?.allowedWidthClassifications;
  if (!Array.isArray(allowedWidthClassifications)
    || !allowedWidthClassifications.includes(characterization.widthClassification)) {
    throw new Error(
      `${profile.id} M1 width classification ${characterization.widthClassification} did not match allowed ${allowedWidthClassifications?.join(', ') ?? '(missing oracle)'}`,
    );
  }
  const threeDecibelBandwidthHz = characterization.threeDecibelBandwidthHz;
  if (Number.isFinite(threeDecibelBandwidthHz)) {
    validateMarkerBandwidth(profile, '3 dB response width', threeDecibelBandwidthHz);
    validateMarkerMeasurementRange(
      profile,
      marker.frequencyHz,
      '3 dB response width',
      threeDecibelBandwidthHz,
      characterization.threeDecibelStartHz,
      characterization.threeDecibelStopHz,
    );
  } else if (characterization.widthClassification !== 'unavailable'
    || characterization.threeDecibelStatus !== 'unavailable'
    || characterization.threeDecibelUnavailableReason === null) {
    throw new Error(`${profile.id} M1 3 dB response did not expose a positive finite value or an explicit recognized unavailable reason`);
  }
  if (characterization.widthClassification === UNAVAILABLE_MARKER
    && !normalizedExpectation.allowedUnavailableReasons.includes(
      characterization.threeDecibelUnavailableReason,
    )) {
    throw new Error(
      `${profile.id} M1 unavailable reason ${characterization.threeDecibelUnavailableReason} did not match allowed ${normalizedExpectation.allowedUnavailableReasons.join(', ') || '(none)'}`,
    );
  }
  validateMarkerBandwidth(
    profile,
    '99% component occupied bandwidth',
    characterization.componentOccupiedBandwidthHz,
  );
  validateMarkerMeasurementRange(
    profile,
    marker.frequencyHz,
    '99% component occupied bandwidth',
    characterization.componentOccupiedBandwidthHz,
    characterization.componentOccupiedBandwidthStartHz,
    characterization.componentOccupiedBandwidthStopHz,
  );
  if (characterization.widthClassification === 'resolution-limited-narrow'
    && characterization.threeDecibelStatus !== 'resolution-limited') {
    throw new Error(`${profile.id} M1 narrow 3 dB result was not explicitly resolution-limited`);
  }
  if (characterization.widthClassification === 'resolved-wideband'
    && characterization.threeDecibelStatus !== 'resolved') {
    throw new Error(`${profile.id} M1 wide 3 dB result was not explicitly resolved`);
  }
  if (characterization.componentOccupiedBandwidthStatus !== 'measured') {
    throw new Error(`${profile.id} M1 component occupied bandwidth was not a measured result`);
  }
  const centroidRequired = normalizedExpectation.centroidRequiredClassifications
    .includes(characterization.widthClassification)
    || (characterization.widthClassification === UNAVAILABLE_MARKER
      && normalizedExpectation.centroidRequiredUnavailableReasons
        .includes(characterization.threeDecibelUnavailableReason));
  const centroidMustBeAbsent = normalizedExpectation.centroidAbsentClassifications
    .includes(characterization.widthClassification)
    || (characterization.widthClassification === UNAVAILABLE_MARKER
      && normalizedExpectation.centroidAbsentUnavailableReasons
        .includes(characterization.threeDecibelUnavailableReason));
  if (centroidRequired) {
    if (!Number.isFinite(marker.powerCentroidHz)) {
      throw new Error(`${profile.id} M1 outcome omitted its required displayed power centroid`);
    }
    const toleranceHz = displayedFrequencyToleranceHz(marker.powerCentroidHz);
    if (Math.abs(marker.powerCentroidHz - marker.frequencyHz) > toleranceHz
      || marker.powerCentroidHz < characterization.componentOccupiedBandwidthStartHz - toleranceHz
      || marker.powerCentroidHz > characterization.componentOccupiedBandwidthStopHz + toleranceHz) {
      throw new Error(`${profile.id} M1 centroid is not coherent with its marker/component range`);
    }
  }
  if (centroidMustBeAbsent && Number.isFinite(marker.powerCentroidHz)) {
    throw new Error(`${profile.id} M1 outcome unexpectedly exposed a power centroid`);
  }
}

function validateMarkerMeasurementRange(
  profile,
  markerFrequencyHz,
  label,
  bandwidthHz,
  startHz,
  stopHz,
) {
  if (!Number.isFinite(startHz) || !Number.isFinite(stopHz) || stopHz < startHz) {
    throw new Error(`${profile.id} M1 ${label} omitted a finite ordered displayed range`);
  }
  const halfSpan = profile.recommendedSpanHz / 2;
  const visibleStartHz = profile.centerHz - halfSpan;
  const visibleStopHz = profile.centerHz + halfSpan;
  const endpointToleranceHz = Math.max(
    displayedFrequencyToleranceHz(startHz),
    displayedFrequencyToleranceHz(stopHz),
  );
  if (startHz < visibleStartHz - endpointToleranceHz
    || stopHz > visibleStopHz + endpointToleranceHz) {
    throw new Error(`${profile.id} M1 ${label} displayed range exceeds the visible profile span`);
  }
  if (markerFrequencyHz < startHz - endpointToleranceHz
    || markerFrequencyHz > stopHz + endpointToleranceHz) {
    throw new Error(`${profile.id} M1 ${label} displayed range does not contain the marker`);
  }
  const displayedSpanHz = stopHz - startHz;
  const consistencyToleranceHz = Math.max(endpointToleranceHz * 2, bandwidthHz * 0.02, 1);
  if (Math.abs(displayedSpanHz - bandwidthHz) > consistencyToleranceHz) {
    throw new Error(
      `${profile.id} M1 ${label} ${bandwidthHz} Hz conflicts with its displayed ${displayedSpanHz} Hz range`,
    );
  }
}

function displayedFrequencyToleranceHz(valueHz) {
  const absolute = Math.abs(valueHz);
  if (absolute >= 1_000_000_000) return 500_000;
  if (absolute >= 1_000_000) return 500;
  if (absolute >= 1_000) return 0.5;
  return 0.5;
}

function validateMarkerBandwidth(profile, label, bandwidthHz) {
  if (!Number.isFinite(bandwidthHz) || bandwidthHz <= 0) {
    throw new Error(`${profile.id} M1 ${label} did not expose a positive finite value`);
  }
  if (bandwidthHz > profile.recommendedSpanHz) {
    throw new Error(`${profile.id} M1 ${label} ${bandwidthHz} Hz exceeds visible span ${profile.recommendedSpanHz} Hz`);
  }
}

function markerThreeDecibelUnavailableReason(detail) {
  if (typeof detail !== 'string') return null;
  return [
    ['no-qualified-local-component', /No local component clears the robust-floor gate/i],
    ['insufficient-local-prominence', /Local peak prominence does not clear the evidence gate/i],
    ['lower-crossing-not-observed', /Lower half-power edge is truncated or buried/i],
    ['upper-crossing-not-observed', /Upper half-power edge is truncated or buried/i],
    ['crossing-outside-window', /Half-power response leaves the local component window/i],
    ['nonmonotone-half-power-response', /Resolved half-power islands do not identify one contiguous response/i],
    ['no-sampled-peak', /No sampled local peak is available/i],
    ['unspecified-unavailable', /Half-power response unavailable/i],
  ].find(([, pattern]) => pattern.test(detail))?.[0] ?? null;
}

function detectAutoAcceptanceSatisfied(
  summary,
  requireClassification,
  profile = null,
  observedSequenceOpportunities = null,
  requireFittedReleaseOracle = false,
) {
  if (!summary.autoControlPressed || !summary.autoTargetEvidenceValid) return false;
  if (!requireClassification) return true;
  if (!summary.autoClassificationResolved || profile === null) return false;
  const expectation = liveSignalLabClassificationExpectation(
    profile,
    summary.autoClassificationResultLabel,
  );
  return liveSignalLabClassificationEvidenceSatisfied(
    profile,
    summary,
    observedSequenceOpportunities,
  )
    && expectation.known
    && (!requireFittedReleaseOracle || expectation.compatible === true);
}

function observedSequenceOpportunityCount(sequences) {
  const finite = [...sequences].filter(Number.isSafeInteger);
  if (finite.length === 0) return 0;
  return Math.max(...finite) - Math.min(...finite) + 1;
}

function nearestCandidateRankIndex(bodies, targetIndex) {
  for (let index = targetIndex; index >= Math.max(0, targetIndex - 6); index--) {
    if (candidateRank(bodies[index]) !== null) return index;
  }
  return -1;
}

function candidateRank(body) {
  const match = /^(?:(?:text|static text)\s+)A?(0[1-9]|[1-9]\d)$/i.exec(body)
    ?? /^(?:button|group)\s+A?(0[1-9]|[1-9]\d)\b/i.exec(body);
  return match ? Number(match[1]) : null;
}

function candidateClassificationLabel(bodies, targetIndex, rankIndex, resultLabel) {
  const start = rankIndex < 0 ? targetIndex : rankIndex;
  let end = Math.min(bodies.length, targetIndex + 4);
  for (let index = targetIndex + 1; index < end; index++) {
    if (candidateRank(bodies[index]) !== null || /^(?:text\s+)?(?:ACTIVE PHYSICAL ROWS|QUALIFYING CANDIDATES|AGILE ACTIVITY SUMMARIES)\b/i.test(bodies[index])) {
      end = index;
      break;
    }
  }
  const rowBodies = bodies.slice(start, end);
  if (typeof resultLabel === 'string' && resultLabel.trim()) {
    const normalizedResult = normalizeClassificationLabel(resultLabel);
    if (rowBodies.some((body) => normalizeClassificationLabel(
      body.replace(/^(?:button|group|text|static text)\s+/i, ''),
    ).includes(normalizedResult))) return resultLabel.trim();
  }
  for (const body of bodies.slice(targetIndex + 1, end)) {
    const candidate = body
      .replace(/^(?:text|static text)\s+/i, '')
      .replace(/^(?:Group\s+·\s+)?Activity\s+·\s+/i, '')
      .replace(/^Group\s+·\s+/i, '')
      .trim();
    if (!candidate
      || candidateRank(body) !== null
      || /^(?:Classification pending|Not a current visible target|Activity summary|Signal \/ noise context)/i.test(candidate)
      || /\b(?:AUTO TARGET|integrated excess|positive\/opportunity looks)\b/i.test(candidate)) continue;
    return candidate;
  }
  return null;
}

function classificationResultCardSummary(bodies) {
  const qualificationIndex = bodies.findIndex((body) => (
    /\bBAYESIAN EVIDENCE CLASS · NOT PROTOCOL\b/i.test(body)
  ));
  if (qualificationIndex < 0) return { qualification: null, label: null };
  const qualification = bodies[qualificationIndex]
    .replace(/^(?:text|static text)\s+/i, '')
    .trim();
  const heading = bodies.slice(qualificationIndex + 1, qualificationIndex + 6)
    .find((body) => /^(?:heading|Heading)\b/.test(body));
  const label = heading
    ? heading
      .replace(/^heading(?:\s+level\s+\d+)?\s+/i, '')
      .replace(/,\s*(?:level\s*)?[1-6]$/i, '')
      .trim()
    : null;
  return { qualification, label: label || null };
}

function normalizeClassificationLabel(label) {
  return label
    .replace(/^(?:Group\s+·\s+)?Activity\s+·\s+/i, '')
    .replace(/^Group\s+·\s+/i, '')
    .trim()
    .toLocaleLowerCase('en-US');
}

function labeledFrequencyMeasurement(text, labelPattern, stopPatterns) {
  const bodies = accessibilityBodies(text);
  const anchor = bodies.findIndex((body) => labelPattern.test(body));
  if (anchor < 0) return {
    labelPresent: false,
    status: 'missing',
    bandwidthHz: null,
    startHz: null,
    stopHz: null,
    detail: null,
  };
  let end = Math.min(bodies.length, anchor + 5);
  for (let index = anchor + 1; index < end; index++) {
    if (stopPatterns.some((pattern) => pattern.test(bodies[index]))) {
      end = index;
      break;
    }
  }
  const segment = bodies.slice(anchor, end);
  const collapsedMeasurement = segment
    .map((body) => [...body.matchAll(/([-\u2212]?[\d,.]+)\s*(Hz|kHz|MHz|GHz)\b/gi)])
    .find((matches) => matches.length >= 3);
  const frequency = segment
    .map((body) => {
      const matches = [...body.matchAll(/([\d,.]+)\s*(Hz|kHz|MHz|GHz)\b/gi)];
      return matches.length === 1 ? matches[0] : null;
    })
    .find(Boolean);
  const bandwidthEvidence = collapsedMeasurement?.[0] ?? frequency;
  const bandwidthHz = bandwidthEvidence
    ? frequencyToHz(bandwidthEvidence[1], bandwidthEvidence[2])
    : null;
  const range = segment
    .map((body) => {
      const matches = [...body.matchAll(/([-\u2212]?[\d,.]+)\s*(Hz|kHz|MHz|GHz)\b/gi)];
      return matches.length === 2 ? matches : null;
    })
    .find(Boolean);
  const rangeEvidence = collapsedMeasurement
    ? collapsedMeasurement.slice(-2)
    : range;
  const startHz = rangeEvidence ? frequencyToHz(rangeEvidence[0][1], rangeEvidence[0][2]) : null;
  const stopHz = rangeEvidence ? frequencyToHz(rangeEvidence[1][1], rangeEvidence[1][2]) : null;
  const detail = segment.join(' | ');
  return {
    labelPresent: true,
    status: bandwidthHz !== null
      ? 'measured'
      : /(?:—|unavailable|requires)/i.test(detail)
        ? 'unavailable'
        : 'unparseable',
    bandwidthHz,
    startHz,
    stopHz,
    detail,
  };
}

function accessibilityBodies(text) {
  return text.split('\n').map((line) => {
    const match = /^\s*\d+\s+(.+)$/.exec(line);
    return match?.[1] ?? line.trim();
  }).filter(Boolean);
}

function hasButton(text, label) {
  return findElementIndex(text, enabledButton(label)) !== undefined;
}

function hasEditableDisclosure(text, label) {
  return findElementIndex(text, (body) => (
    body.startsWith(`disclosure triangle Description: Edit ${label},`)
      && !body.includes('(disabled)')
  )) !== undefined;
}

function hasHeading(text, label) {
  return text.split('\n').some((line) => line.includes(`heading ${label},`) || line.trim().endsWith(`heading ${label}`));
}

function menuItemLabel(body) {
  const normalized = body.replace(/^\(selected\)\s+/, '');
  const marker = normalized.indexOf(', ID:');
  return marker < 0 ? null : normalized.slice(0, marker);
}

function hasSpectrum(text) {
  return text.includes('Measured power by frequency') && !text.includes('text No sweep');
}

function spectrumSummary(text) {
  const sequence = numberMatch(text, /text Sweep\s+(\d+)/i);
  const metrics = text.split('\n').map((line) => line.trim()).find((line) => line.includes('text Peak ')) ?? null;
  const range = text.split('\n').map((line) => line.trim()).find((line) => /text .+(?:MHz|GHz) .+(?:MHz|GHz) .+(?:MHz|GHz)/.test(line)) ?? null;
  return { sequence, metrics, range, visibleRangeHz: range ? threeFrequencyRange(range) : null };
}

function detectionSummary(text) {
  const line = text.split('\n').map((entry) => entry.trim()).find((entry) => (
    entry.includes('text Capture ') && entry.includes(' Detect ') && entry.includes(' Classify ')
  ));
  const active = line ? Number(/Detect\s+(\d+)\s+active/i.exec(line)?.[1] ?? 0) : 0;
  const qualifying = line ? Number(/active\s+·\s+(\d+)\s+qualifying/i.exec(line)?.[1] ?? 0) : 0;
  const classificationText = line?.split(/\s+Classify\s+/i)[1]?.trim() ?? null;
  const classification = classificationText && classificationText !== 'No result'
    ? classificationText
    : null;
  return { line: line ?? null, active, qualifying, classification };
}

export function liveChannelSummary(text) {
  const lines = text.split('\n').map((line) => line.trim());
  // Prefer the result label itself. The enclosing workspace also mentions
  // "3 dB bandwidth" in its accessible name, several nodes before the value.
  const resultAnchor = lines.findIndex((line) => /\btext\s+3\s+dB\s+BANDWIDTH\b/i.test(line));
  const anchor = resultAnchor >= 0
    ? resultAnchor
    : lines.findIndex((line) => /3\s+dB\s+BANDWIDTH/i.test(line));
  const nearby = anchor < 0 ? [] : lines.slice(anchor, anchor + 8);
  const unavailable = nearby.some((line) => line.includes('Unavailable'));
  const limited = nearby.some((line) => line.includes('Resolution-limited'));
  const frequency = nearby.map((line) => /([\d,.]+)\s*(Hz|kHz|MHz|GHz)\b/i.exec(line)).find(Boolean);
  return {
    status: unavailable ? 'unavailable' : limited ? 'resolution-limited' : 'resolved',
    // An unavailable result has no measured width. Do not accidentally parse
    // the editable channel-center row that follows the result in AX order.
    bandwidthHz: unavailable ? null : frequency ? frequencyToHz(frequency[1], frequency[2]) : null,
    detail: nearby.join(' | '),
  };
}

function iqCaptureId(text) {
  return /Capture\s+([0-9a-f-]{16,})\s+·/i.exec(text)?.[1] ?? null;
}

function disclosureFrequency(text, label) {
  const line = text.split('\n').map((entry) => entry.trim()).find((entry) => (
    entry.includes(`Description: Edit ${label}, Help: ${label} `)
  ));
  const match = line ? new RegExp(`${escapeRegExp(label)}\\s+([\\d,.]+)\\s*(Hz|kHz|MHz|GHz)`, 'i').exec(line) : null;
  return match ? frequencyToHz(match[1], match[2]) : null;
}

function threeFrequencyRange(line) {
  const matches = [...line.matchAll(/([\d,.]+)\s*(Hz|kHz|MHz|GHz)\b/gi)];
  if (matches.length !== 3) return null;
  const values = matches.map((match) => frequencyToHz(match[1], match[2]));
  if (values.some((value) => value === null)) return null;
  return { startHz: values[0], centerHz: values[1], stopHz: values[2] };
}

function frequencyToHz(value, unit) {
  const numeric = Number(value.replaceAll(',', '').replace('−', '-'));
  const multiplier = ({ hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9 })[unit.toLowerCase()];
  return Number.isFinite(numeric) ? Math.round(numeric * multiplier) : null;
}

async function maybeCapture(context, state, profileId, stage) {
  if (context.options.screenshotPolicy !== 'all') return null;
  return await captureState(context, state, profileId, stage);
}

async function captureFailure(context, state, profileId, stage) {
  if (!state || context.options.screenshotPolicy === 'none') return null;
  return await captureState(context, state, profileId, stage);
}

export function liveScreenshotDimensions(bytes, extension) {
  const buffer = Buffer.from(bytes);
  const normalized = String(extension).toLowerCase();
  if (normalized === '.png') {
    if (buffer.length < 24
      || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
      throw new Error('Computer Use PNG screenshot is truncated or lacks IHDR');
    }
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if (normalized === '.jpg' || normalized === '.jpeg') {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      throw new Error('Computer Use JPEG screenshot lacks an SOI marker');
    }
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]
        .includes(marker)) {
        return {
          width: buffer.readUInt16BE(offset + 5),
          height: buffer.readUInt16BE(offset + 3),
        };
      }
      offset += length;
    }
    throw new Error('Computer Use JPEG screenshot lacks a supported SOF size marker');
  }
  throw new Error(`Unsupported Computer Use screenshot extension: ${normalized || '(none)'}`);
}

async function liveScreenshotEvidence(context, state, operation) {
  if (!state?.screenshot?.url) {
    if (!context.options.requireLiveScreenshots) return null;
    throw new Error(`${operation} requires the screenshot returned with its fresh Computer Use state`);
  }
  const extension = screenshotArtifactExtension(state.screenshot.url);
  const dimensions = liveScreenshotDimensions(
    await readFile(fileURLToPath(state.screenshot.url)),
    extension,
  );
  if (dimensions.width < context.options.minimumScreenshotWidth
    || dimensions.height < context.options.minimumScreenshotHeight) {
    throw new Error(
      `${operation} screenshot ${dimensions.width}×${dimensions.height} is below the required visible app size ${context.options.minimumScreenshotWidth}×${context.options.minimumScreenshotHeight}`,
    );
  }
  return {
    extension,
    ...dimensions,
    claim: 'fresh-frame-and-dimensions-only-not-pixel-content-perfection',
  };
}

async function captureState(context, state, profileId, stage) {
  let capture = state;
  if (!capture?.screenshot?.url) capture = await freshState(context);
  if (!capture.screenshot?.url) throw new Error('Atomizer Computer Use state omitted its screenshot');
  const extension = screenshotArtifactExtension(capture.screenshot.url);
  const filename = `${requireSafeArtifactName(profileId)}--${requireSafeArtifactName(stage)}${extension}`;
  const destination = join(context.artifactDirectory, filename);
  await copyFile(fileURLToPath(capture.screenshot.url), destination);
  return destination;
}

async function persistRun(context, run) {
  run.summary = summarizeSignalLabLiveRun(run);
  const temporary = `${context.reportPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  await rename(temporary, context.reportPath);
}

export async function finalizeSignalLabLiveVisualReview(input) {
  if (!input || typeof input !== 'object') throw new TypeError('visual review input is required');
  const reportPath = resolve(requireNonEmptyString(input.reportPath, 'visual review reportPath'));
  const reviewer = requireNonEmptyString(input.reviewer, 'visual review reviewer').trim();
  if (typeof input.passed !== 'boolean') throw new TypeError('visual review passed must be a boolean');
  const findings = input.findings ?? [];
  if (!Array.isArray(findings)
    || findings.some((finding) => typeof finding !== 'string' || !finding.trim())) {
    throw new TypeError('visual review findings must be an array of non-empty strings');
  }
  const reviewedAt = input.reviewedAt ?? new Date().toISOString();
  if (typeof reviewedAt !== 'string' || !Number.isFinite(Date.parse(reviewedAt))) {
    throw new TypeError('visual review reviewedAt must be a parseable timestamp');
  }
  const run = JSON.parse(await readFile(reportPath, 'utf8'));
  if (run.schemaVersion !== LIVE_SIGNAL_LAB_EXERCISE_SCHEMA_VERSION
    || run.kind !== 'full-profile-exercise'
    || !Number.isFinite(Date.parse(run.completedAt))) {
    throw new Error('Visual review finalization requires a completed schema-v2 full-profile exercise report');
  }
  const screenshotSet = fullExerciseScreenshotSet(run);
  if (!screenshotSet.complete) {
    throw new Error(
      `Visual review requires the exact ${EXPECTED_SIGNAL_LAB_PROFILE_COUNT * FULL_EXERCISE_REQUIRED_STEPS.length}-screenshot full-exercise manifest`,
    );
  }
  const screenshotManifest = [];
  for (const path of screenshotSet.paths) {
    const bytes = await readFile(path);
    if (bytes.length === 0) throw new Error(`Visual review screenshot is empty: ${path}`);
    screenshotManifest.push({
      path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  run.visualContentReview = {
    schemaVersion: 1,
    automatedClaim: 'fresh-frame-and-dimensions-only-not-pixel-content-perfection',
    status: input.passed ? 'reviewed' : 'review-failed',
    passed: input.passed,
    reviewer,
    reviewedAt,
    findings: findings.map((finding) => finding.trim()),
    screenshotManifest,
  };
  run.summary = summarizeSignalLabLiveRun(run);
  const temporary = `${reportPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  await rename(temporary, reportPath);
  return Object.freeze({
    reportPath,
    visualContentReview: run.visualContentReview,
    summary: run.summary,
    run,
  });
}

function fullExerciseScreenshotSet(run) {
  if (run.kind !== 'full-profile-exercise' || !Array.isArray(run.profiles)) {
    return { complete: false, paths: [] };
  }
  const paths = [];
  let complete = run.profiles.length === EXPECTED_SIGNAL_LAB_PROFILE_COUNT;
  for (const profile of run.profiles) {
    for (const step of FULL_EXERCISE_REQUIRED_STEPS) {
      const path = profile.steps?.[step]?.screenshot;
      if (typeof path !== 'string' || !path.trim()) complete = false;
      else paths.push(path);
    }
  }
  if (new Set(paths).size !== paths.length) complete = false;
  return {
    complete: complete
      && paths.length === EXPECTED_SIGNAL_LAB_PROFILE_COUNT * FULL_EXERCISE_REQUIRED_STEPS.length,
    paths,
  };
}

function completeRun(run) {
  run.completedAt ??= new Date().toISOString();
  run.summary = summarizeSignalLabLiveRun(run);
}

function normalizeRendererMemorySamples(values, defaultSource) {
  if (!Array.isArray(values)) throw new TypeError('rendererMemorySamples must be an array');
  return values.map((value, index) => {
    const sample = typeof value === 'number' ? { bytes: value } : value;
    if (!sample || typeof sample !== 'object') {
      throw new TypeError(`renderer memory sample ${index} must be a byte count or object`);
    }
    if (!Number.isSafeInteger(sample.bytes) || sample.bytes < 0) {
      throw new TypeError(`renderer memory sample ${index} bytes must be a non-negative safe integer`);
    }
    const capturedAt = sample.capturedAt ?? null;
    if (capturedAt !== null
      && (typeof capturedAt !== 'string' || !capturedAt.trim() || !Number.isFinite(Date.parse(capturedAt)))) {
      throw new TypeError(`renderer memory sample ${index} capturedAt must be a parseable timestamp`);
    }
    const identity = sample.identity ?? null;
    if (identity !== null
      && (typeof identity !== 'string' || !identity.trim() || identity.length > 256)) {
      throw new TypeError(`renderer memory sample ${index} identity must be a non-empty string of at most 256 characters`);
    }
    return {
      bytes: sample.bytes,
      source: requireNonEmptyString(sample.source ?? defaultSource, `renderer memory sample ${index} source`),
      checkpoint: requireNonEmptyString(sample.checkpoint ?? `external-${index + 1}`, `renderer memory sample ${index} checkpoint`),
      profileId: sample.profileId ?? null,
      capturedAt,
      identity,
    };
  });
}

async function sampleRendererMemory(context, checkpoint, profileId) {
  if (!context.rendererMemorySampler) return;
  const value = await context.rendererMemorySampler({ checkpoint, profileId });
  if (value === undefined || value === null) return;
  const [sample] = normalizeRendererMemorySamples([value], 'external-renderer-memory-sampler');
  context.stress.rendererMemorySamples.push({
    ...sample,
    checkpoint,
    profileId,
  });
}

export function validateRendererMemorySamples(samples, options = {}) {
  const normalized = normalizeRendererMemorySamples(samples, 'externally-supplied');
  const plateauWindow = options.rendererMemoryPlateauWindow
    ?? DEFAULT_OPTIONS.rendererMemoryPlateauWindow;
  const maximumPlateauGrowthBytes = options.rendererMemoryMaximumPlateauGrowthBytes
    ?? DEFAULT_OPTIONS.rendererMemoryMaximumPlateauGrowthBytes;
  const hardLimitBytes = options.rendererMemoryHardLimitBytes
    ?? DEFAULT_OPTIONS.rendererMemoryHardLimitBytes;
  const requireMeasuredRendererMemory = options.requireMeasuredRendererMemory ?? false;
  const rendererMemoryRunStartedAt = options.rendererMemoryRunStartedAt ?? null;
  const rendererMemoryRunCompletedAt = options.rendererMemoryRunCompletedAt ?? null;
  const requiredMeasuredSamples = Math.max(8, plateauWindow * 2);
  requireSafeInteger(plateauWindow, 'rendererMemoryPlateauWindow');
  requireSafeInteger(maximumPlateauGrowthBytes, 'rendererMemoryMaximumPlateauGrowthBytes');
  requireSafeInteger(hardLimitBytes, 'rendererMemoryHardLimitBytes');
  if (typeof requireMeasuredRendererMemory !== 'boolean') {
    throw new TypeError('requireMeasuredRendererMemory must be a boolean');
  }
  let runWindow = null;
  if (requireMeasuredRendererMemory) {
    const startedMs = Date.parse(rendererMemoryRunStartedAt);
    const completedMs = Date.parse(rendererMemoryRunCompletedAt);
    if (typeof rendererMemoryRunStartedAt !== 'string'
      || typeof rendererMemoryRunCompletedAt !== 'string'
      || !Number.isFinite(startedMs)
      || !Number.isFinite(completedMs)
      || completedMs < startedMs) {
      throw new Error('Full live acceptance renderer-memory validation requires a valid run start/completion window');
    }
    runWindow = { startedAt: rendererMemoryRunStartedAt, completedAt: rendererMemoryRunCompletedAt, startedMs, completedMs };
  }
  if (normalized.length === 0) {
    if (requireMeasuredRendererMemory) {
      throw new Error(`Full live acceptance requires at least ${requiredMeasuredSamples} measured renderer-memory samples; received 0`);
    }
    return {
      status: 'not-supplied',
      reason: 'Computer Use sky exposes accessibility and screenshots, not renderer-process memory; supply rendererMemorySamples or sampleRendererMemory for a measured bound',
      samples: 0,
    };
  }
  const maximumBytes = Math.max(...normalized.map(({ bytes }) => bytes));
  if (maximumBytes > hardLimitBytes) {
    throw new Error(
      `Externally sampled renderer memory ${maximumBytes} bytes exceeded hard limit ${hardLimitBytes} bytes`,
    );
  }
  const evaluated = requireMeasuredRendererMemory
    ? distinctMeasuredRendererMemorySamples(normalized, runWindow)
    : normalized;
  if (evaluated.length < requiredMeasuredSamples) {
    if (requireMeasuredRendererMemory) {
      throw new Error(
        `Full live acceptance requires at least ${requiredMeasuredSamples} distinct measured renderer-memory samples; received ${evaluated.length} distinct from ${normalized.length} supplied`,
      );
    }
    return {
      status: 'hard-bound-only-insufficient-plateau-samples',
      samples: evaluated.length,
      maximumBytes,
      hardLimitBytes,
      requiredPlateauSamples: requiredMeasuredSamples,
    };
  }
  if (requireMeasuredRendererMemory) validateRendererMemoryCheckpointCoverage(evaluated);
  const openingMedianBytes = medianNumber(evaluated.slice(0, plateauWindow).map(({ bytes }) => bytes));
  const closingMedianBytes = medianNumber(evaluated.slice(-plateauWindow).map(({ bytes }) => bytes));
  const plateauGrowthBytes = closingMedianBytes - openingMedianBytes;
  if (plateauGrowthBytes > maximumPlateauGrowthBytes) {
    throw new Error(
      `Externally sampled renderer memory grew ${plateauGrowthBytes} bytes from opening to closing plateau; limit ${maximumPlateauGrowthBytes} bytes`,
    );
  }
  return {
    status: 'plateau-and-hard-bound-validated',
    samples: evaluated.length,
    suppliedSamples: normalized.length,
    duplicateSamples: normalized.length - evaluated.length,
    identity: requireMeasuredRendererMemory ? evaluated[0].identity : null,
    runWindowValidated: requireMeasuredRendererMemory,
    checkpointCoverageValidated: requireMeasuredRendererMemory,
    firstCapturedAt: requireMeasuredRendererMemory ? evaluated[0].capturedAt : null,
    lastCapturedAt: requireMeasuredRendererMemory ? evaluated.at(-1).capturedAt : null,
    maximumBytes,
    hardLimitBytes,
    plateauWindow,
    openingMedianBytes,
    closingMedianBytes,
    plateauGrowthBytes,
    maximumPlateauGrowthBytes,
  };
}

function distinctMeasuredRendererMemorySamples(samples, runWindow) {
  const distinct = [];
  const byMeasurement = new Map();
  for (const [index, sample] of samples.entries()) {
    if (sample.capturedAt === null) {
      throw new Error(`Full live acceptance renderer-memory sample ${index} omitted its real capturedAt timestamp`);
    }
    const key = `${sample.source}\u0000${sample.capturedAt}`;
    const previous = byMeasurement.get(key);
    if (previous) {
      if (previous.bytes !== sample.bytes || previous.identity !== sample.identity) {
        throw new Error(`Renderer-memory measurement ${sample.source} at ${sample.capturedAt} was replayed with conflicting evidence`);
      }
      continue;
    }
    byMeasurement.set(key, sample);
    distinct.push(sample);
  }
  const identities = new Set(distinct.map(({ identity }) => identity));
  if (identities.has(null) || identities.size !== 1) {
    throw new Error('Full live acceptance renderer-memory samples require one stable non-empty renderer identity');
  }
  for (const [index, sample] of distinct.entries()) {
    const capturedMs = Date.parse(sample.capturedAt);
    if (capturedMs < runWindow.startedMs || capturedMs > runWindow.completedMs) {
      throw new Error(
        `Renderer-memory sample ${index} at ${sample.capturedAt} falls outside the live run window ${runWindow.startedAt}..${runWindow.completedAt}`,
      );
    }
    if (index > 0 && capturedMs <= Date.parse(distinct[index - 1].capturedAt)) {
      throw new Error('Full live acceptance renderer-memory samples must be strictly chronological');
    }
  }
  return distinct;
}

function validateRendererMemoryCheckpointCoverage(samples) {
  const checkpoints = new Set(samples.map(({ checkpoint }) => checkpoint));
  const runCoverage = checkpoints.has('run-start')
    && checkpoints.has('profile-complete')
    && checkpoints.has('run-complete');
  const soakCoverage = checkpoints.has('soak-start')
    && checkpoints.has('soak-profile-complete')
    && checkpoints.has('soak-complete');
  if (!runCoverage && !soakCoverage) {
    throw new Error(
      'Full live acceptance renderer-memory samples require start, distributed profile, and complete checkpoint coverage',
    );
  }
}

export function validateLiveStressEvidence(evidence, options = {}) {
  if (!evidence || typeof evidence !== 'object') throw new TypeError('live stress evidence is required');
  const maximumControlResponseMs = options.maximumControlResponseMs
    ?? DEFAULT_OPTIONS.maximumControlResponseMs;
  const maximumAccessibilitySnapshotMs = options.maximumAccessibilitySnapshotMs
    ?? DEFAULT_OPTIONS.maximumAccessibilitySnapshotMs;
  const minimumContinuousSweepProgressions = options.minimumContinuousSweepProgressions
    ?? DEFAULT_OPTIONS.minimumContinuousSweepProgressions;
  const maximumFirstSweepLatencyMs = options.maximumFirstSweepLatencyMs
    ?? DEFAULT_OPTIONS.maximumFirstSweepLatencyMs;
  const maximumStopLatencyMs = options.maximumStopLatencyMs
    ?? DEFAULT_OPTIONS.maximumStopLatencyMs;
  const maximumMillisecondsPerSweepOpportunity = options.maximumMillisecondsPerSweepOpportunity
    ?? DEFAULT_OPTIONS.maximumMillisecondsPerSweepOpportunity;
  const maximumResponsivenessTourMs = options.maximumResponsivenessTourMs
    ?? DEFAULT_OPTIONS.maximumResponsivenessTourMs;
  const acquisitionTimeoutMs = options.acquisitionTimeoutMs ?? DEFAULT_OPTIONS.acquisitionTimeoutMs;
  const profileTimeoutMs = options.profileTimeoutMs ?? DEFAULT_OPTIONS.profileTimeoutMs;
  requireSafeInteger(maximumControlResponseMs, 'maximumControlResponseMs');
  requireSafeInteger(maximumAccessibilitySnapshotMs, 'maximumAccessibilitySnapshotMs');
  requireSafeInteger(minimumContinuousSweepProgressions, 'minimumContinuousSweepProgressions');
  requireSafeInteger(maximumFirstSweepLatencyMs, 'maximumFirstSweepLatencyMs');
  requireSafeInteger(maximumStopLatencyMs, 'maximumStopLatencyMs');
  requireSafeInteger(maximumMillisecondsPerSweepOpportunity, 'maximumMillisecondsPerSweepOpportunity');
  requireSafeInteger(maximumResponsivenessTourMs, 'maximumResponsivenessTourMs');
  requireSafeInteger(acquisitionTimeoutMs, 'acquisitionTimeoutMs');
  requireSafeInteger(profileTimeoutMs, 'profileTimeoutMs');
  const actions = Array.isArray(evidence.actionLatencies) ? evidence.actionLatencies : [];
  const snapshots = Array.isArray(evidence.accessibilitySnapshotLatencies)
    ? evidence.accessibilitySnapshotLatencies
    : [];
  const progressions = Array.isArray(evidence.sweepProgressions) ? evidence.sweepProgressions : [];
  if (actions.length === 0 || snapshots.length === 0 || progressions.length === 0) {
    throw new Error('Live stress evidence requires actions, accessibility snapshots, and sweep progression');
  }
  for (const [label, values, maximum] of [
    ['action', actions, maximumControlResponseMs],
    ['accessibility snapshot', snapshots, maximumAccessibilitySnapshotMs],
  ]) {
    for (const value of values) {
      if (!Number.isSafeInteger(value.latencyMs) || value.latencyMs < 0 || value.latencyMs > maximum) {
        throw new Error(`${label} latency ${String(value.latencyMs)} ms violates bound ${maximum} ms`);
      }
      if (label === 'action' && value.ok !== true) {
        throw new Error(`Live stress action ${value.label ?? '(unlabeled)'} did not acknowledge successfully`);
      }
    }
  }
  let maximumFirstSweepObservedMs = 0;
  let maximumClassificationObservedMs = 0;
  let maximumCompletionObservedMs = 0;
  let maximumStopObservedMs = 0;
  for (const progression of progressions) {
    if (progression.kind === 'continuous') {
      if (!Array.isArray(progression.sequences)
        || new Set(progression.sequences).size < minimumContinuousSweepProgressions
        || progression.sequences.some((sequence) => !Number.isSafeInteger(sequence))) {
        throw new Error('Continuous stress evidence lacks the required unique sweep progression');
      }
      const firstSweepLatencyMs = requireNonNegativeLatency(
        progression.firstSweepLatencyMs,
        'continuous first-sweep',
      );
      if (firstSweepLatencyMs > maximumFirstSweepLatencyMs) {
        throw new Error(
          `Continuous first-sweep latency ${firstSweepLatencyMs} ms violates bound ${maximumFirstSweepLatencyMs} ms`,
        );
      }
      const classificationLatencyMs = requireNonNegativeLatency(
        progression.classificationLatencyMs,
        'continuous classification',
      );
      const classificationTimeoutMs = progression.classificationTimeoutMs;
      requireSafeInteger(classificationTimeoutMs, 'continuous classificationTimeoutMs');
      if (classificationLatencyMs > classificationTimeoutMs) {
        throw new Error(
          `Continuous classification latency ${classificationLatencyMs} ms violates profile bound ${classificationTimeoutMs} ms`,
        );
      }
      const observedOpportunities = progression.classificationEvidence?.observedSequenceOpportunities;
      const requiredOpportunities = progression.classificationEvidence?.requiredOpportunities;
      if (!Number.isSafeInteger(observedOpportunities)
        || !Number.isSafeInteger(requiredOpportunities)
        || observedOpportunities < requiredOpportunities
        || requiredOpportunities < 1) {
        throw new Error('Continuous classification evidence lacks its required sweep opportunities');
      }
      const rate = progression.sweepRateEvidence;
      if (!rate
        || !Number.isSafeInteger(rate.firstObservedSequence)
        || !Number.isSafeInteger(rate.lastObservedSequence)
        || !Number.isSafeInteger(rate.sequenceDelta)
        || rate.sequenceDelta < 1
        || rate.lastObservedSequence - rate.firstObservedSequence !== rate.sequenceDelta
        || rate.observedSequenceOpportunities !== rate.sequenceDelta + 1
        || !Number.isSafeInteger(rate.observationElapsedMs)
        || rate.observationElapsedMs < 0
        || !Number.isFinite(rate.millisecondsPerSequenceOpportunity)
        || rate.millisecondsPerSequenceOpportunity
          !== rate.observationElapsedMs / rate.sequenceDelta) {
        throw new Error('Continuous sweep-rate evidence did not bind one elapsed interval to its matching sequence delta');
      }
      const averageOpportunityLatencyMs = rate.millisecondsPerSequenceOpportunity;
      if (averageOpportunityLatencyMs > maximumMillisecondsPerSweepOpportunity) {
        throw new Error(
          `Continuous classification averaged ${averageOpportunityLatencyMs} ms per required sweep opportunity; limit ${maximumMillisecondsPerSweepOpportunity} ms`,
        );
      }
      const tour = progression.responsivenessTour;
      if (!tour || !Array.isArray(tour.routes)
        || !sameOrderedValues(tour.routes.map(({ label }) => label), ['Waterfall', 'Channel', 'I/Q', 'Spectrum'])
        || tour.routes.some(({ stopPresent }) => stopPresent !== true)
        || !Array.isArray(tour.controls)
        || !sameOrderedValues(tour.controls, ['sweep-setup', 'traces-and-markers'])) {
        throw new Error('Continuous stress evidence omitted the active-Run workspace/control responsiveness tour');
      }
      const tourElapsedMs = requireNonNegativeLatency(tour.elapsedMs, 'active-Run responsiveness tour');
      if (tourElapsedMs > maximumResponsivenessTourMs) {
        throw new Error(
          `Active-Run responsiveness tour latency ${tourElapsedMs} ms violates bound ${maximumResponsivenessTourMs} ms`,
        );
      }
      const stopLatencyMs = requireNonNegativeLatency(
        progression.stopLatencyMs,
        'continuous Stop',
      );
      if (stopLatencyMs > maximumStopLatencyMs) {
        throw new Error(
          `Continuous Stop latency ${stopLatencyMs} ms violates bound ${maximumStopLatencyMs} ms`,
        );
      }
      const elapsedMs = requireNonNegativeLatency(progression.elapsedMs, 'continuous pre-classification');
      const preClassificationBoundMs = maximumFirstSweepLatencyMs
        + acquisitionTimeoutMs * Math.max(0, minimumContinuousSweepProgressions - 1)
        + maximumResponsivenessTourMs;
      if (elapsedMs > preClassificationBoundMs) {
        throw new Error(
          `Continuous pre-classification latency ${elapsedMs} ms violates bound ${preClassificationBoundMs} ms`,
        );
      }
      const totalElapsedMs = requireNonNegativeLatency(
        progression.totalElapsedMs,
        'continuous total completion',
      );
      const totalBoundMs = preClassificationBoundMs
        + profileTimeoutMs
        + classificationTimeoutMs
        + maximumStopLatencyMs;
      if (totalElapsedMs > totalBoundMs) {
        throw new Error(
          `Continuous total completion latency ${totalElapsedMs} ms violates bound ${totalBoundMs} ms`,
        );
      }
      maximumFirstSweepObservedMs = Math.max(maximumFirstSweepObservedMs, firstSweepLatencyMs);
      maximumClassificationObservedMs = Math.max(
        maximumClassificationObservedMs,
        classificationLatencyMs,
      );
      maximumCompletionObservedMs = Math.max(maximumCompletionObservedMs, totalElapsedMs);
      maximumStopObservedMs = Math.max(maximumStopObservedMs, stopLatencyMs);
    } else if (!Number.isSafeInteger(progression.toSequence)
      || progression.toSequence === progression.fromSequence) {
      throw new Error(`${String(progression.kind)} stress evidence did not advance its sweep sequence`);
    } else {
      const completionLatencyMs = requireNonNegativeLatency(
        progression.completionLatencyMs,
        `${String(progression.kind)} completion`,
      );
      const completionBoundMs = progression.kind === 'single'
        ? acquisitionTimeoutMs
        : profileTimeoutMs + acquisitionTimeoutMs;
      if (completionLatencyMs > completionBoundMs) {
        throw new Error(
          `${String(progression.kind)} completion latency ${completionLatencyMs} ms violates bound ${completionBoundMs} ms`,
        );
      }
      maximumCompletionObservedMs = Math.max(maximumCompletionObservedMs, completionLatencyMs);
    }
  }
  return {
    status: 'control-latency-and-sweep-progression-validated',
    actions: actions.length,
    maximumActionLatencyMs: Math.max(...actions.map(({ latencyMs }) => latencyMs)),
    accessibilitySnapshots: snapshots.length,
    maximumAccessibilitySnapshotLatencyMs: Math.max(...snapshots.map(({ latencyMs }) => latencyMs)),
    sweepProgressions: progressions.length,
    maximumFirstSweepLatencyMs: maximumFirstSweepObservedMs,
    maximumClassificationLatencyMs: maximumClassificationObservedMs,
    maximumCompletionLatencyMs: maximumCompletionObservedMs,
    maximumStopLatencyMs: maximumStopObservedMs,
  };
}

function requireNonNegativeLatency(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} latency must be a non-negative safe integer`);
  }
  return value;
}

function medianNumber(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function classifierReleaseGateSummary(run) {
  const scientificReleaseGate = run.kind === 'classifier-release-gate';
  const rows = (run.profiles ?? []).map((profile) => {
    const gateStep = profile.steps?.['classifier-release-gate'];
    const evidence = scientificReleaseGate
      ? gateStep?.classificationEvidence
      : profile.steps?.['continuous-detect']?.sweepProgression?.classificationEvidence;
    const resultLabel = typeof evidence?.resultLabel === 'string' && evidence.resultLabel.trim()
      ? evidence.resultLabel.trim()
      : null;
    const expectation = scientificReleaseGate
      ? liveSignalLabClassificationExpectation(profile, resultLabel)
      : interleavedFullCatalogClassificationRecord(profile, resultLabel);
    const observationComplete = resultLabel !== null
      && expectation.known
      && evidence?.resultLinkedToAutoTarget === true
      && evidence?.resultQualification === 'BAYESIAN EVIDENCE CLASS · NOT PROTOCOL';
    return {
      profileId: profile.id,
      observationComplete,
      expectation,
      gateStep,
    };
  });
  const validatedProfileIds = rows.filter(({ observationComplete, expectation }) => (
    observationComplete && expectation.oracleStatus === 'validated'
  )).map(({ profileId }) => profileId);
  const failedProfileIds = rows.filter(({ observationComplete, expectation }) => (
    observationComplete && expectation.oracleStatus === 'failed'
  )).map(({ profileId }) => profileId);
  const unvalidatedProfileIds = rows.filter(({ observationComplete, expectation }) => (
    observationComplete && expectation.oracleStatus === 'classification-oracle-unvalidated'
  )).map(({ profileId }) => profileId);
  const missingObservationProfileIds = rows.filter(({ observationComplete }) => (
    !observationComplete
  )).map(({ profileId }) => profileId);
  const expectedFinalSourceSequence = SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_SOURCE_PLAN
    .reduce((total, entry) => total + entry.spectrumOpportunities, 0);
  const initialSession = run.sourceClock?.session?.initial;
  const finalSession = run.sourceClock?.session?.final;
  const producerSessionComplete = typeof initialSession?.sessionId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
      .test(initialSession.sessionId)
    && finalSession?.sessionId === initialSession.sessionId
    && initialSession?.driverId === 'signal-lab'
    && finalSession?.driverId === 'signal-lab'
    && typeof initialSession?.identitySha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(initialSession.identitySha256)
    && finalSession?.identitySha256 === initialSession.identitySha256
    && initialSession?.visibleSource?.sourceState === 'READY'
    && initialSession?.visibleSource?.sessionState === 'READY'
    && initialSession?.visibleSource?.sourceSequence === 0
    && finalSession?.visibleSource?.sourceSequence === expectedFinalSourceSequence
    && run.sourceClock?.initialSourceSequence === 0
    && run.sourceClock?.finalSourceSequence === expectedFinalSourceSequence;
  const sourceClockPlanComplete = scientificReleaseGate
    && run.sourceClock?.status === 'fresh-pinned-order-and-horizons-observed'
    && run.sourceClock?.initialSweepSequence === null
    && producerSessionComplete
    && run.geometry?.policyId === 'signal-lab-recommended-span-450-point-grid-v1'
    && run.geometry?.requiredPoints === 450
    && run.geometry?.requiredSweepTimeSeconds === 0.05
    && run.geometry?.configured?.configuredPoints === 450
    && run.geometry?.configured?.configuredSweepTimeSeconds === 0.05
    && sameOrderedValues(
      run.catalog.map(({ id }) => id),
      SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS,
    )
    && sameOrderedValues(
      run.profiles.map(({ id }) => id),
      SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS,
    )
    && rows.every(({ profileId, gateStep }, index) => {
      const expected = SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_SOURCE_PLAN[index];
      const source = gateStep?.sourceClockEvidence;
      const sequences = source?.spectrumSequences;
      const producerSourceSequences = source?.producerSourceSequences;
      const geometry = gateStep?.geometryEvidence;
      const catalogProfile = run.catalog[index];
      const expectedStartHz = Math.round(
        catalogProfile.centerHz - catalogProfile.recommendedSpanHz / 2,
      );
      const expectedStopHz = Math.round(
        catalogProfile.centerHz + catalogProfile.recommendedSpanHz / 2,
      );
      const rangeToleranceHz = Math.max(
        1,
        Math.round(catalogProfile.recommendedSpanHz / 1_000_000),
      );
      return expected?.profileId === profileId
        && gateStep?.sourcePlan?.profileId === expected.profileId
        && gateStep?.sourcePlan?.profileOrdinal === expected.profileOrdinal
        && gateStep?.sourcePlan?.sourceLookIndexOffset === expected.sourceLookIndexOffset
        && gateStep?.sourcePlan?.spectrumOpportunities === expected.spectrumOpportunities
        && gateStep?.sourcePlan?.automaticDetectedPowerCaptures === 0
        && source?.automaticDetectedPowerCaptures === 0
        && typeof source?.classificationCaptureId === 'string'
        && source.classificationCaptureId.length > 0
        && Array.isArray(sequences)
        && sequences.length === expected.spectrumOpportunities
        && sequences.every((sequence, look) => (
          sequence === expected.sourceLookIndexOffset + look + 1
        ))
        && Array.isArray(producerSourceSequences)
        && sameOrderedValues(producerSourceSequences, sequences)
        && source.firstSpectrumSequence === sequences[0]
        && source.lastSpectrumSequence === sequences.at(-1)
        && geometry?.configured?.configuredPoints === 450
        && geometry?.configured?.configuredSweepTimeSeconds === 0.05
        && geometry?.result?.plotPoints === 450
        && geometry?.result?.pinnedBayesianGeometryVisible === true
        && geometry?.expectedStartHz === expectedStartHz
        && geometry?.expectedStopHz === expectedStopHz
        && Math.abs(geometry?.observedRangeHz?.startHz - expectedStartHz) <= rangeToleranceHz
        && Math.abs(geometry?.observedRangeHz?.stopHz - expectedStopHz) <= rangeToleranceHz;
    });
  const releaseGateComplete = scientificReleaseGate
    && sourceClockPlanComplete
    && validatedProfileIds.length === SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS.length
    && failedProfileIds.length === 0
    && SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS.every(
      (id) => validatedProfileIds.includes(id),
    );
  const expectedObservationCount = scientificReleaseGate
    ? SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS.length
    : EXPECTED_SIGNAL_LAB_PROFILE_COUNT;
  const allProfileObservationsComplete = rows.length === expectedObservationCount
    && missingObservationProfileIds.length === 0;
  return {
    status: scientificReleaseGate
      ? releaseGateComplete
        ? 'exact-12-of-12-classifier-oracle-validated'
        : 'classifier-release-gate-incomplete'
      : allProfileObservationsComplete
        ? 'linked-results-recorded-no-scientific-oracle'
        : 'linked-result-observation-incomplete',
    scope: scientificReleaseGate
      ? 'fresh-pinned-12-profile-spectrum-source-clock'
      : 'interleaved-34-profile-record-only',
    expectedValidatedProfiles: scientificReleaseGate
      ? SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS.length
      : 0,
    validatedProfiles: validatedProfileIds.length,
    validatedProfileIds,
    failedProfileIds,
    unvalidatedProfiles: unvalidatedProfileIds.length,
    unvalidatedProfileIds,
    unvalidatedClaim: 'classification-oracle-unvalidated-not-a-scientific-label-pass',
    observedProfiles: rows.length - missingObservationProfileIds.length,
    missingObservationProfileIds,
    producerSessionComplete,
    sourceClockPlanComplete,
    releaseGateComplete,
    allProfileObservationsComplete,
  };
}

export function summarizeSignalLabLiveRun(run) {
  const passedProfiles = run.profiles.filter((profile) => profile.failures.length === 0).length;
  const completedSteps = run.profiles.flatMap((profile) => (
    Object.values(profile.steps ?? {}).filter((step) => step && typeof step === 'object')
  ));
  const actionLatencies = run.stress?.actionLatencies ?? [];
  const snapshotLatencies = run.stress?.accessibilitySnapshotLatencies ?? [];
  const fullAcceptance = isFullAcceptanceRunKind(run.kind);
  const classifierReleaseGate = run.kind === 'classifier-release-gate';
  const defaultGeometrySmoke = run.kind === 'default-1024-user-path-smoke';
  const expectedProfiles = classifierReleaseGate || defaultGeometrySmoke
    ? classifierReleaseGate
      ? SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS.length
      : SIGNAL_LAB_DEFAULT_GEOMETRY_SMOKE_PROFILE_IDS.length
    : fullAcceptance
      ? EXPECTED_SIGNAL_LAB_PROFILE_COUNT
      : run.catalog.length;
  const catalogIds = run.catalog.map((profile) => profile.id);
  const profileIds = run.profiles.map((profile) => profile.id);
  const uniqueCatalog = new Set(catalogIds).size === catalogIds.length;
  const canonicalCatalog = sameOrderedValues(catalogIds, CANONICAL_SIGNAL_LAB_PROFILE_IDS);
  const subsetCatalog = catalogIds.length > 0
    && catalogIds.length < EXPECTED_SIGNAL_LAB_PROFILE_COUNT
    && uniqueCatalog
    && catalogIds.every((id) => CANONICAL_SIGNAL_LAB_PROFILE_IDS.includes(id));
  const catalogBoundProfiles = sameOrderedValues(profileIds, catalogIds);
  const runKindMatchesCatalog = classifierReleaseGate
    ? sameOrderedValues(catalogIds, SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS)
    : defaultGeometrySmoke
      ? sameOrderedValues(catalogIds, SIGNAL_LAB_DEFAULT_GEOMETRY_SMOKE_PROFILE_IDS)
    : fullAcceptance
      ? canonicalCatalog
      : (run.kind === 'profile-subset-exercise'
        || run.kind === 'continuous-profile-switch-subset-soak')
      && subsetCatalog;
  const requiredSteps = run.kind === 'full-profile-exercise'
    ? FULL_EXERCISE_REQUIRED_STEPS
    : run.kind === 'continuous-profile-switch-soak'
      ? ['switch']
      : classifierReleaseGate
        ? ['classifier-release-gate']
        : defaultGeometrySmoke
          ? ['default-geometry-smoke']
        : [];
  const requiredStepsComplete = (!fullAcceptance && !classifierReleaseGate && !defaultGeometrySmoke)
    || run.profiles.every((profile) => (
    requiredSteps.every((step) => profile.steps?.[step]?.ok === true)
  ));
  const requiredOptionsEnabled = run.kind !== 'full-profile-exercise'
    || (FULL_EXERCISE_REQUIRED_OPTIONS.every((option) => run.options?.[option] === true)
      && run.options?.screenshotPolicy === 'all');
  const rendererMemory = run.stress?.rendererMemory ?? {
    status: 'pending',
    samples: run.stress?.rendererMemorySamples?.length ?? 0,
  };
  const measuredRendererMemory = rendererMemory.status === 'plateau-and-hard-bound-validated'
    && rendererMemory.samples >= 8
    && typeof rendererMemory.identity === 'string'
    && rendererMemory.identity.length > 0
    && rendererMemory.runWindowValidated === true
    && rendererMemory.checkpointCoverageValidated === true;
  const boundedStress = run.stress?.bounds?.status
    === 'control-latency-and-sweep-progression-validated';
  const startedMs = Date.parse(run.startedAt);
  const completedMs = Date.parse(run.completedAt);
  const completionWindowValid = Number.isFinite(startedMs)
    && Number.isFinite(completedMs)
    && completedMs >= startedMs;
  const classifierOracle = classifierReleaseGateSummary(run);
  const screenshotSet = fullExerciseScreenshotSet(run);
  const markerOracleGeometryComplete = run.kind === 'full-profile-exercise'
    && run.geometry?.policyId === 'signal-lab-marker-oracle-recommended-span-450-points-v1'
    && run.geometry?.requiredPoints === 450
    && run.geometry?.requiredSweepTimeSeconds === 0.05
    && run.geometry?.configured?.configuredPoints === 450
    && run.geometry?.configured?.configuredSweepTimeSeconds === 0.05
    && run.profiles.every((profile) => (
      profile.steps?.single?.geometry?.plotPoints === 450
      && profile.steps?.marker?.markerGeometry?.plotPoints === 450
    ));
  let expectedDefaultSourceSequence = 1;
  const defaultGeometryComplete = defaultGeometrySmoke
    && run.geometry?.policyId === 'shipped-default-1024-user-path-v1'
    && run.geometry?.configured?.configuredPoints === 1_024
    && run.geometry?.configured?.configuredSweepTimeSeconds === 0.05
    && run.geometry?.markerOracleStatus === 'not-applicable-unfitted-1024-point-geometry'
    && run.geometry?.initialSource?.sourceState === 'READY'
    && run.geometry?.initialSource?.sessionState === 'READY'
    && run.geometry?.initialSource?.sourceSequence === 0
    && sameOrderedValues(
      run.geometry?.profileIds ?? [],
      SIGNAL_LAB_DEFAULT_GEOMETRY_SMOKE_PROFILE_IDS,
    )
    && run.profiles.every((profile) => {
      const step = profile.steps?.['default-geometry-smoke'];
      const opportunities = liveSignalLabDefaultGeometrySmokeOpportunities(profile);
      const sequences = step?.sourceClockEvidence?.spectrumSequences;
      const producerSourceSequences = step?.sourceClockEvidence?.producerSourceSequences;
      if (step?.markerOracleStatus !== 'not-applicable-unfitted-1024-point-geometry'
        || step?.spectrumOpportunities !== opportunities
        || step?.sweepGeometry?.plotPoints !== 1_024
        || step?.markerGeometry?.plotPoints !== 1_024
        || !Array.isArray(sequences)
        || sequences.length !== opportunities
        || !Array.isArray(producerSourceSequences)
        || !sameOrderedValues(producerSourceSequences, sequences)) return false;
      const exact = sequences.every((sequence) => sequence === expectedDefaultSourceSequence++);
      return exact
        && step.sourceClockEvidence.firstSpectrumSequence === sequences[0]
        && step.sourceClockEvidence.lastSpectrumSequence === sequences.at(-1);
    });
  const visualContentReview = run.visualContentReview ?? {
    automatedClaim: 'fresh-frame-and-dimensions-only-not-pixel-content-perfection',
    status: 'manual-review-required',
  };
  const visualManifest = Array.isArray(visualContentReview.screenshotManifest)
    ? visualContentReview.screenshotManifest
    : [];
  const visualManifestValid = screenshotSet.complete
    && sameOrderedValues(
      visualManifest.map((entry) => entry?.path),
      screenshotSet.paths,
    )
    && visualManifest.every((entry) => (
      Number.isSafeInteger(entry?.bytes)
        && entry.bytes > 0
        && typeof entry.sha256 === 'string'
        && /^[a-f0-9]{64}$/u.test(entry.sha256)
    ));
  const visualContentReviewComplete = visualContentReview.status === 'reviewed'
    && visualContentReview.passed === true
    && typeof visualContentReview.reviewer === 'string'
    && visualContentReview.reviewer.trim().length > 0
    && Number.isFinite(Date.parse(visualContentReview.reviewedAt))
    && Date.parse(visualContentReview.reviewedAt) >= completedMs
    && visualManifestValid;
  const automatedChecksOk = run.profiles.length === expectedProfiles
    && run.schemaVersion === LIVE_SIGNAL_LAB_EXERCISE_SCHEMA_VERSION
    && passedProfiles === expectedProfiles
    && run.failures.length === 0
    && runKindMatchesCatalog
    && catalogBoundProfiles
    && (defaultGeometrySmoke
      ? requiredStepsComplete
        && completionWindowValid
        && defaultGeometryComplete
      : classifierReleaseGate
      ? requiredStepsComplete
        && completionWindowValid
        && classifierOracle.releaseGateComplete
        && classifierOracle.allProfileObservationsComplete
      : (!fullAcceptance || (
          measuredRendererMemory
          && boundedStress
          && requiredStepsComplete
          && requiredOptionsEnabled
          && completionWindowValid
          && (run.kind !== 'full-profile-exercise' || (
            classifierOracle.allProfileObservationsComplete
            && screenshotSet.complete
            && markerOracleGeometryComplete
          ))
        )));
  return {
    kind: run.kind,
    catalogCoverage: classifierReleaseGate
      ? runKindMatchesCatalog ? 'fitted-classifier-release-catalog' : 'invalid-catalog'
      : defaultGeometrySmoke
        ? runKindMatchesCatalog ? 'default-user-path-smoke' : 'invalid-catalog'
      : fullAcceptance
        ? canonicalCatalog ? 'closed-catalog' : 'invalid-catalog'
        : runKindMatchesCatalog ? 'debug-subset' : 'invalid-catalog',
    expectedProfiles,
    exercisedProfiles: run.profiles.length,
    passedProfiles,
    failedProfiles: run.profiles.length - passedProfiles,
    passedSteps: completedSteps.filter((step) => step.ok).length,
    failedSteps: completedSteps.filter((step) => !step.ok).length,
    failures: run.failures.length,
    stress: {
      actions: actionLatencies.length,
      maximumActionLatencyMs: actionLatencies.length
        ? Math.max(...actionLatencies.map(({ latencyMs }) => latencyMs))
        : null,
      accessibilitySnapshots: snapshotLatencies.length,
      maximumAccessibilitySnapshotLatencyMs: snapshotLatencies.length
        ? Math.max(...snapshotLatencies.map(({ latencyMs }) => latencyMs))
        : null,
      sweepProgressions: run.stress?.sweepProgressions.length ?? 0,
      rendererMemory,
    },
    classifierOracle,
    geometry: {
      evidence: run.geometry ?? null,
      markerOracleGeometryComplete,
      defaultGeometryComplete,
    },
    visualContentReview,
    visualContentReviewComplete,
    automatedOk: automatedChecksOk,
    automatedChecksOk,
    ok: automatedChecksOk
      && (run.kind !== 'full-profile-exercise' || visualContentReviewComplete),
  };
}

function sameOrderedValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isFullAcceptanceRunKind(kind) {
  return kind === 'full-profile-exercise' || kind === 'continuous-profile-switch-soak';
}

function withoutState(result) {
  return Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'state' && key !== 'detectState'));
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack.slice(0, 8_192) } : {}),
  };
}

function canonicalJson(value) {
  const seen = new WeakSet();
  const normalize = (entry) => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('SignalLab session identity must be finite JSON data');
    }
    if (seen.has(entry)) throw new TypeError('SignalLab session identity must not be circular');
    seen.add(entry);
    const normalized = Object.fromEntries(
      Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]),
    );
    seen.delete(entry);
    return normalized;
  };
  return JSON.stringify(normalize(value));
}

function surroundingText(text, index, length) {
  return text.slice(Math.max(0, index - 80), Math.min(text.length, index + length)).replace(/\s+/g, ' ').trim();
}

function matchText(text, pattern) {
  return text.match(pattern)?.[1] ?? null;
}

function numberMatch(text, pattern) {
  const value = matchText(text, pattern);
  return value === null ? null : Number(value);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function requireSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function requireSafeArtifactName(value) {
  const name = requireNonEmptyString(value, 'artifact name');
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new TypeError(`Unsafe artifact name: ${name}`);
  return name;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function remainingTimeoutMs(deadline, operation) {
  const remaining = deadline - Date.now();
  if (remaining < 1) throw new Error(`${operation} exhausted its shared timeout window`);
  return remaining;
}
