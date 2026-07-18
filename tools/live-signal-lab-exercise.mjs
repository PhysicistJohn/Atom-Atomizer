import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
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
export const SIGNAL_LAB_MINIMUM_SCREENSHOT_WIDTH = 1_280;
export const SIGNAL_LAB_MINIMUM_SCREENSHOT_HEIGHT = 720;
export const SIGNAL_LAB_DEFAULT_GEOMETRY_SMOKE_PROFILE_IDS = Object.freeze([
  'cw',
  'lte-etm3.1',
  'wifi-ofdm-20m',
  'bluetooth-classic-connected',
]);

const execFileAsync = promisify(execFile);

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
  minimumScreenshotWidth: SIGNAL_LAB_MINIMUM_SCREENSHOT_WIDTH,
  minimumScreenshotHeight: SIGNAL_LAB_MINIMUM_SCREENSHOT_HEIGHT,
  rendererMemoryPlateauWindow: 4,
  rendererMemoryMaximumPlateauGrowthBytes: 64 * 1_024 * 1_024,
  rendererMemoryHardLimitBytes: 2 * 1_024 * 1_024 * 1_024,
  screenshotPolicy: 'all',
  narrowMarkerProfileIds: Object.freeze(['cw']),
  wideMarkerProfileIds: Object.freeze(['lte-etm3.1']),
  iqZoomProfileIds: CANONICAL_SIGNAL_LAB_PROFILE_IDS,
  iqContinuousProfileIds: Object.freeze(['cw', 'lte-etm3.1', 'bluetooth-classic-connected']),
});

const RELEASE_MAXIMUM_OPTION_KEYS = Object.freeze([
  'profileTimeoutMs',
  'acquisitionTimeoutMs',
  'classificationTimeoutMs',
  'maximumControlResponseMs',
  'maximumAccessibilitySnapshotMs',
  'maximumFirstSweepLatencyMs',
  'maximumStopLatencyMs',
  'maximumMillisecondsPerSweepOpportunity',
  'maximumResponsivenessTourMs',
  'rendererMemoryMaximumPlateauGrowthBytes',
  'rendererMemoryHardLimitBytes',
]);

function liveSignalLabReleasePolicySummary(options, kind) {
  const fullAcceptance = isFullAcceptanceRunKind(kind);
  if (!fullAcceptance) {
    return {
      status: 'not-applicable-debug-or-specialized-run',
      bound: true,
      violations: [],
    };
  }

  const violations = [];
  for (const key of RELEASE_MAXIMUM_OPTION_KEYS) {
    const value = options?.[key];
    if (!Number.isSafeInteger(value) || value > DEFAULT_OPTIONS[key]) {
      violations.push(`${key} must be no greater than ${DEFAULT_OPTIONS[key]}`);
    }
  }
  if (!Number.isSafeInteger(options?.minimumContinuousSweepProgressions)
    || options.minimumContinuousSweepProgressions
      < DEFAULT_OPTIONS.minimumContinuousSweepProgressions) {
    violations.push(
      `minimumContinuousSweepProgressions must be at least ${DEFAULT_OPTIONS.minimumContinuousSweepProgressions}`,
    );
  }
  // A larger plateau window can smooth away a late leak; a smaller one does
  // not prove the canonical sustained plateau. Release evidence therefore
  // binds this sampling window exactly rather than treating either direction
  // as stronger.
  if (options?.rendererMemoryPlateauWindow !== DEFAULT_OPTIONS.rendererMemoryPlateauWindow) {
    violations.push(
      `rendererMemoryPlateauWindow must equal ${DEFAULT_OPTIONS.rendererMemoryPlateauWindow}`,
    );
  }

  if (kind === 'full-profile-exercise') {
    for (const [key, expected] of [
      ['narrowMarkerProfileIds', DEFAULT_OPTIONS.narrowMarkerProfileIds],
      ['wideMarkerProfileIds', DEFAULT_OPTIONS.wideMarkerProfileIds],
      ['iqZoomProfileIds', DEFAULT_OPTIONS.iqZoomProfileIds],
      ['iqContinuousProfileIds', DEFAULT_OPTIONS.iqContinuousProfileIds],
    ]) {
      if (!Array.isArray(options?.[key]) || !sameOrderedValues(options[key], expected)) {
        violations.push(`${key} must match the canonical ordered release profile set`);
      }
    }
    for (const [key, minimum] of [
      ['minimumScreenshotWidth', SIGNAL_LAB_MINIMUM_SCREENSHOT_WIDTH],
      ['minimumScreenshotHeight', SIGNAL_LAB_MINIMUM_SCREENSHOT_HEIGHT],
    ]) {
      if (!Number.isSafeInteger(options?.[key]) || options[key] < minimum) {
        violations.push(`${key} must be at least ${minimum}`);
      }
    }
  }

  return {
    status: violations.length === 0
      ? 'canonical-release-policy-bound'
      : 'weakened-release-policy-rejected',
    bound: violations.length === 0,
    violations,
  };
}

const CENTERED_WIDEBAND_MARKER_ORACLE_EXCLUDED_PROFILE_IDS = new Set([
  'wifi6-he-mu',
  'wifi6-he-tb',
  'bluetooth-classic-connected',
  'bluetooth-le-advertising',
]);

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
    screenshotClaim: 'fresh-frame-dimensions-pixel-nondegeneracy-and-duplicate-content',
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
  if (!Number.isFinite(marker.powerDbm)) {
    throw new Error(`${profile.id} default marker omitted a finite M1 power`);
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
    validateLiveLayoutContract(state.text, { running: false });
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
            layout: validateLiveLayoutContract(selected.text, { running: false }),
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
            const result = await exerciseWaterfall(context, state, profile);
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

export function liveSignalLabAtomOpenSoakConfiguration(input = {}) {
  const durationMs = input.durationMs ?? 30 * 60 * 1_000;
  const checkpointIntervalMs = input.checkpointIntervalMs ?? 30_000;
  requireSafeInteger(durationMs, 'Atom-open soak durationMs');
  requireSafeInteger(checkpointIntervalMs, 'Atom-open soak checkpointIntervalMs');
  if (durationMs < 1_000) throw new RangeError('Atom-open soak durationMs must be at least 1000');
  if (checkpointIntervalMs < 250 || checkpointIntervalMs > 60_000) {
    throw new RangeError('Atom-open soak checkpointIntervalMs must be between 250 and 60000');
  }
  if (checkpointIntervalMs >= durationMs) {
    throw new RangeError('Atom-open soak checkpointIntervalMs must be shorter than durationMs');
  }
  return Object.freeze({ durationMs, checkpointIntervalMs });
}

const ATOM_OPEN_SOAK_ROUTES = Object.freeze([
  'Waterfall',
  'Channel',
  'I/Q',
  'Detect',
  'Spectrum',
]);

export function validateSignalLabAtomOpenSoakCompletion(report, options = {}) {
  if (!report || typeof report !== 'object') throw new TypeError('Atom-open soak report is required');
  const configuration = liveSignalLabAtomOpenSoakConfiguration(report.configuration);
  const checkpoints = report.checkpoints;
  if (!Array.isArray(checkpoints) || checkpoints.length < ATOM_OPEN_SOAK_ROUTES.length) {
    throw new Error('Atom-open soak completed without a full advancing route checkpoint chain');
  }
  const monotonic = report.monotonicTiming;
  if (!Number.isFinite(monotonic?.startedMilliseconds)
    || !Number.isFinite(monotonic?.completedMilliseconds)
    || !Number.isFinite(monotonic?.elapsedMilliseconds)
    || monotonic.completedMilliseconds < monotonic.startedMilliseconds
    || Math.abs(
      monotonic.completedMilliseconds
        - monotonic.startedMilliseconds
        - monotonic.elapsedMilliseconds,
    ) > 1
    || monotonic.elapsedMilliseconds < configuration.durationMs) {
    throw new Error(
      `Atom-open soak did not meet configured monotonic duration ${configuration.durationMs} ms`,
    );
  }
  if (!Number.isSafeInteger(report.initialSequence)
    || !Number.isSafeInteger(report.finalSequence)) {
    throw new Error('Atom-open soak omitted its initial or final sweep sequence');
  }
  for (const [index, checkpoint] of checkpoints.entries()) {
    const previous = checkpoints[index - 1];
    if (checkpoint?.checkpoint !== index + 1
      || !Number.isSafeInteger(checkpoint?.fromSequence)
      || !Number.isSafeInteger(checkpoint?.sequence)
      || checkpoint.sequence <= checkpoint.fromSequence
      || !Number.isFinite(checkpoint?.elapsedMilliseconds)
      || checkpoint.elapsedMilliseconds < 0
      || checkpoint.elapsedMilliseconds > monotonic.elapsedMilliseconds + 1
      || (index === 0
        ? checkpoint.fromSequence !== report.initialSequence
        : checkpoint.fromSequence !== previous.sequence)
      || (index > 0 && checkpoint.elapsedMilliseconds <= previous.elapsedMilliseconds)) {
      throw new Error(`Atom-open soak checkpoint ${index + 1} is not a strictly chained advancing sweep`);
    }
    const expectedRoute = ATOM_OPEN_SOAK_ROUTES[index % ATOM_OPEN_SOAK_ROUTES.length];
    if (checkpoint.route !== expectedRoute
      || checkpoint.atomPanelOpen !== true
      || !storedRunningLayoutEvidenceComplete(checkpoint.layout)
      || checkpoint.layout.globalSweepIdentity.sequence !== checkpoint.sequence) {
      throw new Error(
        `Atom-open soak checkpoint ${index + 1} omitted its expected ${expectedRoute} running-layout or Atom-open evidence`,
      );
    }
    const terminal = index === checkpoints.length - 1;
    if ((checkpoint.terminal === true) !== terminal) {
      throw new Error('Atom-open soak requires exactly one final terminal checkpoint');
    }
  }
  const terminalCheckpoint = checkpoints.at(-1);
  if (terminalCheckpoint.sequence !== report.finalSequence
    || !Number.isFinite(terminalCheckpoint.elapsedMilliseconds)
    || terminalCheckpoint.elapsedMilliseconds < configuration.durationMs
    || terminalCheckpoint.elapsedMilliseconds > monotonic.elapsedMilliseconds + 1) {
    throw new Error('Atom-open soak terminal checkpoint does not prove the configured duration and final sequence');
  }
  const rendererMemory = validateRendererMemorySamples(
    report.stress?.rendererMemorySamples ?? [],
    {
      ...options,
      requireMeasuredRendererMemory: true,
      rendererMemoryRunStartedAt: report.startedAt,
      rendererMemoryRunCompletedAt: report.completedAt,
    },
  );
  if (report.finalStopSucceeded !== true) {
    throw new Error('Atom-open soak final global Stop did not complete');
  }
  return {
    status: 'atom-open-duration-memory-and-final-stop-validated',
    rendererMemory,
    checkpoints: checkpoints.length,
    durationMs: monotonic.elapsedMilliseconds,
  };
}

/**
 * Configurable 30-minute-by-default live soak with Atom visibly open. This
 * intentionally never types into Atom or crosses its human-agent exclusion;
 * it proves the open panel does not stall global acquisition or route changes.
 */
export async function runSignalLabAtomOpenDurationSoak(input) {
  const soak = liveSignalLabAtomOpenSoakConfiguration(input?.soak);
  const context = await createContext({
    ...input,
    options: {
      ...(input?.options ?? {}),
      closeAtomPanel: false,
      screenshotPolicy: input?.options?.screenshotPolicy ?? 'failures',
    },
  });
  const report = {
    schemaVersion: LIVE_SIGNAL_LAB_EXERCISE_SCHEMA_VERSION,
    kind: 'atom-open-duration-soak',
    app: context.app,
    startedAt: new Date().toISOString(),
    completedAt: null,
    configuration: soak,
    checkpoints: [],
    failures: [],
    stress: context.stress,
    finalStopSucceeded: false,
    initialSequence: null,
    finalSequence: null,
    monotonicTiming: {
      startedMilliseconds: null,
      completedMilliseconds: null,
      elapsedMilliseconds: null,
    },
  };
  let state;
  let primaryError = null;
  let completionError = null;
  const persist = async () => {
    const temporary = `${context.reportPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await rename(temporary, context.reportPath);
  };
  await persist();
  try {
    state = await freshState(context);
    assertSignalLabSession(state);
    if (findElementIndex(state.text, enabledButton('Close Atom')) === undefined
      || !state.text.includes('Atom AI copilot')) {
      throw new Error('Atom-open duration soak requires the visible Atom AI copilot panel');
    }
    state = await ensureStopped(context, state);
    state = await navigate(context, state, 'Spectrum');
    await sampleRendererMemory(context, 'soak-start', null);
    const sequenceBefore = liveGlobalSweepIdentitySummary(state.text).sequence;
    state = await clickElement(context, state, enabledButton('Run'), 'Atom-open soak global Run');
    state = await waitForState(
      context,
      (candidate) => {
        const sequence = liveGlobalSweepIdentitySummary(candidate.text).sequence;
        return hasButton(candidate.text, 'Stop')
          && Number.isSafeInteger(sequence)
          && sequence !== sequenceBefore
          && findElementIndex(candidate.text, enabledButton('Close Atom')) !== undefined;
      },
      'Atom-open soak first advancing sweep',
      context.options.acquisitionTimeoutMs,
    );
    validateGlobalSweepMatchesSpectrum(state.text, 'Atom-open soak first sweep');
    let previousSequence = liveGlobalSweepIdentitySummary(state.text).sequence;
    report.initialSequence = previousSequence;
    const soakStartedMilliseconds = performance.now();
    report.monotonicTiming.startedMilliseconds = soakStartedMilliseconds;
    const deadline = soakStartedMilliseconds + soak.durationMs;
    const routes = ATOM_OPEN_SOAK_ROUTES;
    let currentRoute = 'Spectrum';
    let checkpoint = 0;
    while (performance.now() < deadline) {
      await delay(Math.min(
        soak.checkpointIntervalMs,
        Math.max(1, deadline - performance.now()),
      ));
      if (performance.now() >= deadline) break;
      const route = routes[checkpoint % routes.length];
      currentRoute = route;
      state = await navigate(context, await freshState(context), route);
      state = await waitForState(
        context,
        (candidate) => {
          const sequence = liveGlobalSweepIdentitySummary(candidate.text).sequence;
          return hasButton(candidate.text, 'Stop')
            && liveWorkspaceIsVisible(candidate.text, route)
            && Number.isSafeInteger(sequence)
            && sequence > previousSequence
            && findElementIndex(candidate.text, enabledButton('Close Atom')) !== undefined;
        },
        `Atom-open soak checkpoint ${checkpoint + 1}`,
        context.options.acquisitionTimeoutMs,
      );
      const sequence = liveGlobalSweepIdentitySummary(state.text).sequence;
      report.checkpoints.push({
        checkpoint: checkpoint + 1,
        capturedAt: new Date().toISOString(),
        route,
        fromSequence: previousSequence,
        sequence,
        layout: validateLiveLayoutContract(state.text, { running: true }),
        atomPanelOpen: true,
        elapsedMilliseconds: performance.now() - soakStartedMilliseconds,
      });
      previousSequence = sequence;
      checkpoint++;
      await sampleRendererMemory(context, 'soak-profile-complete', null);
      await persist();
    }
    const terminalRoute = routes[checkpoint % routes.length];
    currentRoute = terminalRoute;
    state = await navigate(context, await freshState(context), terminalRoute);
    state = await waitForState(
      context,
      (candidate) => {
        const sequence = liveGlobalSweepIdentitySummary(candidate.text).sequence;
        return hasButton(candidate.text, 'Stop')
          && liveWorkspaceIsVisible(candidate.text, currentRoute)
          && Number.isSafeInteger(sequence)
          && sequence > previousSequence
          && findElementIndex(candidate.text, enabledButton('Close Atom')) !== undefined;
      },
      'Atom-open soak terminal full-duration checkpoint',
      context.options.acquisitionTimeoutMs,
    );
    const terminalSequence = liveGlobalSweepIdentitySummary(state.text).sequence;
    report.checkpoints.push({
      checkpoint: checkpoint + 1,
      capturedAt: new Date().toISOString(),
      route: currentRoute,
      fromSequence: previousSequence,
      sequence: terminalSequence,
      layout: validateLiveLayoutContract(state.text, { running: true }),
      atomPanelOpen: true,
      terminal: true,
      elapsedMilliseconds: performance.now() - soakStartedMilliseconds,
    });
    report.finalSequence = terminalSequence;
    report.monotonicTiming.completedMilliseconds = performance.now();
    report.monotonicTiming.elapsedMilliseconds = report.monotonicTiming.completedMilliseconds
      - soakStartedMilliseconds;
    await persist();
  } catch (error) {
    primaryError = error;
    report.failures.push({ profileId: null, step: 'atom-open-duration-soak', ...serializeError(error) });
    try {
      await captureFailure(context, state, 'atom-open-soak', 'failure');
    } catch (captureError) {
      report.failures.push({
        profileId: null,
        step: 'atom-open-soak-failure-screenshot',
        ...serializeError(captureError),
      });
    }
  } finally {
    try {
      state = await ensureStopped(context, state ?? await freshState(context));
      report.finalStopSucceeded = true;
    } catch (error) {
      completionError = error;
      report.finalStopSucceeded = false;
      report.failures.push({ profileId: null, step: 'final-stop', ...serializeError(error) });
    }
    try {
      await sampleRendererMemory(context, 'soak-complete', null);
      report.completedAt = new Date().toISOString();
      const completion = validateSignalLabAtomOpenSoakCompletion(report, context.options);
      report.stress.rendererMemory = completion.rendererMemory;
      report.completionEvidence = completion;
    } catch (error) {
      report.completedAt ??= new Date().toISOString();
      completionError ??= error;
      report.failures.push({ profileId: null, step: 'soak-completion-evidence', ...serializeError(error) });
    }
    report.ok = report.failures.length === 0
      && report.completionEvidence?.status
        === 'atom-open-duration-memory-and-final-stop-validated';
    await persist();
  }
  if (primaryError !== null) throw primaryError;
  if (completionError !== null) throw completionError;
  return Object.freeze({
    artifactDirectory: context.artifactDirectory,
    reportPath: context.reportPath,
    report,
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
    screenshotEvidence: new Map(),
    screenshotHashes: new Map(),
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
      automatedClaim: 'fresh-frame-dimensions-pixel-nondegeneracy-and-duplicate-content',
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
  const initialGlobalIdentity = liveGlobalSweepIdentitySummary(state.text);
  if (!initialGlobalIdentity.valid || initialGlobalIdentity.evidenceCount !== 1) {
    throw new Error('Continuous acquisition omitted its unique global sweep identity diagnostic');
  }
  const previousSequence = initialGlobalIdentity.sequence;
  const runStarted = Date.now();
  const seenSequences = new Set();
  const observedSequenceTimes = new Map();
  const recordObservedSequence = (candidate) => {
    const identity = liveGlobalSweepIdentitySummary(candidate.text);
    const sequence = identity.valid && identity.evidenceCount === 1
      ? identity.sequence
      : null;
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
        && hasSpectrum(candidate.text)
        && sequence !== null
        && sequence !== previousSequence;
    },
    'continuous acquisition Stop control and first fresh sweep',
    context.options.acquisitionTimeoutMs,
  );
  validateGlobalSweepMatchesSpectrum(state.text, 'continuous first sweep');
  const firstSweepLatencyMs = Date.now() - runStarted;
  while (seenSequences.size < context.options.minimumContinuousSweepProgressions) {
    state = await waitForState(
      context,
      (candidate) => {
        const sequence = liveGlobalSweepIdentitySummary(candidate.text).sequence;
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
  let previousSequence = recordObservedSequence(state);
  if (!Number.isSafeInteger(previousSequence)) {
    throw new Error('Active Run responsiveness tour requires an initial finite sweep sequence');
  }
  const visit = async (label) => {
    const fromSequence = previousSequence;
    state = await navigate(context, state, label);
    state = await waitForState(
      context,
      (candidate) => {
        const sequence = recordObservedSequence(candidate);
        return hasButton(candidate.text, 'Stop')
          && liveWorkspaceIsVisible(candidate.text, label)
          && activeRunRouteControlsPresent(candidate.text, label)
          && Number.isSafeInteger(sequence)
          && sequence > previousSequence;
      },
      `${label} workspace with an advancing sweep while global Run remains active`,
      context.options.acquisitionTimeoutMs,
    );
    let sequence = recordObservedSequence(state);
    let controlInteraction = null;
    if (label === 'Device') {
      const profileControlBefore = signalLabProfileControlSummary(state.text);
      const sweepSequenceBeforeInteraction = sequence;
      if (profileControlBefore === null) {
        throw new Error('Device active-Run tour omitted its enabled SignalLab profile control');
      }
      state = await clickElement(
        context,
        state,
        (body) => body === profileControlBefore.body,
        'open SignalLab profile selector during active Run responsiveness tour',
      );
      const popupEvidence = signalLabProfilePopupEvidence(state.text);
      if (!popupEvidence.open) {
        throw new Error('Device SignalLab profile selector click did not expose an open native popup');
      }
      if (typeof context.sky.press_key !== 'function') {
        throw new Error('Device active-Run selector cancellation requires Computer Use press_key');
      }
      await context.sky.press_key({ app: context.app, key: 'Escape' });
      state = await freshState(context);
      state = await waitForState(
        context,
        (candidate) => {
          const nextSequence = recordObservedSequence(candidate);
          return hasButton(candidate.text, 'Stop')
            && liveWorkspaceIsVisible(candidate.text, 'Device')
            && activeRunRouteControlsPresent(candidate.text, 'Device')
            && signalLabProfileControlSummary(candidate.text)?.selectedValue
              === profileControlBefore.selectedValue
            && Number.isSafeInteger(nextSequence)
            && nextSequence > sweepSequenceBeforeInteraction;
        },
        'cancelled unchanged Device profile selector and resumed spectrum progression during active Run',
        context.options.acquisitionTimeoutMs,
      );
      sequence = recordObservedSequence(state);
      const profileControlAfter = signalLabProfileControlSummary(state.text);
      controlInteraction = {
        status: 'profile-selector-opened-and-cancelled-under-run',
        profileControlEvidenceBefore: profileControlBefore.body,
        profileControlEvidenceAfter: profileControlAfter?.body ?? null,
        profileValueBefore: profileControlBefore.selectedValue,
        profileValueAfter: profileControlAfter?.selectedValue ?? null,
        popupEvidence,
        sweepSequenceBeforeInteraction,
        sweepSequenceAfterInteraction: sequence,
      };
    }
    const layout = validateLiveLayoutContract(state.text, { running: true });
    routes.push({
      label,
      stopPresent: true,
      fromSequence,
      sequence,
      enabledControls: activeRunRouteControlLabels(label),
      controlInteraction,
      acquisitionCounts: layout.acquisitionCounts,
      acquisitionLandmarkCount: layout.acquisitionLandmarkCount,
      acquisitionLandmarkPrecedesControls: layout.acquisitionLandmarkPrecedesControls,
      acquisitionLandmarkControlBinding: layout.acquisitionLandmarkControlBinding,
      globalSweepIdentity: layout.globalSweepIdentity,
      routeCounts: layout.routeCounts,
    });
    previousSequence = sequence;
  };
  for (const label of ['Waterfall', 'Channel', 'I/Q', 'Device', 'Spectrum']) await visit(label);

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
  const previousSweep = liveSweepIdentitySummary(state.text);
  state = await clickElement(context, state, enabledButton('Single'), 'fresh global Single for marker Peak');
  state = await waitForState(
    context,
    (candidate) => {
      const sweep = liveSweepIdentitySummary(candidate.text);
      return typeof sweep.sweepId === 'string'
        && sweep.sweepId.length > 0
        && Number.isSafeInteger(sweep.sequence)
        && (previousSweep.sweepId === null || sweep.sweepId !== previousSweep.sweepId)
        && (previousSweep.sequence === null || sweep.sequence > previousSweep.sequence)
        && findElementIndex(candidate.text, enabledButton('Single')) !== undefined;
    },
    `fresh marker sweep for ${profile.id}`,
    context.options.acquisitionTimeoutMs,
  );
  const currentSweep = liveSweepIdentitySummary(state.text);
  if (findElementIndex(state.text, enabledButton('Peak')) === undefined) {
    state = await clickElement(
      context,
      state,
      enabledButton('Traces & markers'),
      'Traces & markers overlay',
    );
  }
  state = await normalizeM1Normal(context, state);
  if (!markerOneSelectedVisibility(state.text, 'visible')) {
    state = await clickElement(
      context,
      state,
      (body) => /^button Marker 1,\s*hidden,\s*selected\b/i.test(body),
      'show Marker 1 before freshness reset',
    );
    state = await waitForState(
      context,
      (candidate) => markerOneSelectedVisibility(candidate.text, 'visible')
        && liveMarkerM1ReadoutIsNormal(candidate.text),
      'visible Marker 1 before freshness reset',
      context.options.profileTimeoutMs,
    );
  }
  state = await clickElement(
    context,
    state,
    (body) => /^button Marker 1,\s*visible,\s*selected\b/i.test(body),
    'hide Marker 1 before fresh Peak search',
  );
  state = await waitForState(
    context,
    (candidate) => markerOneSelectedVisibility(candidate.text, 'hidden')
      && liveMarkerSummary(candidate.text).sourceSweepId === null,
    'hidden M1 with stale marker reading cleared',
    context.options.profileTimeoutMs,
  );
  state = await clickElement(context, state, enabledButton('Peak'), 'marker Peak search');
  state = await waitForState(
    context,
    (candidate) => {
      const marker = liveMarkerSummary(candidate.text);
      return markerOneSelectedVisibility(candidate.text, 'visible')
        && marker.frequencyHz !== null
        && marker.sourceSweepId === currentSweep.sweepId
        && candidate.text.includes('Marker M1 local characterization');
    },
    'visible M1 reading bound to the current sweep and local characterization',
    context.options.acquisitionTimeoutMs,
  );
  assertNoFatalUi(state, `peak marker ${profile.id}`);
  const marker = liveMarkerSummary(state.text);
  const markerFreshness = validateFreshMarkerEvidence(
    previousSweep,
    currentSweep,
    marker,
    { markerWasHidden: true, markerVisible: markerOneSelectedVisibility(state.text, 'visible') },
  );
  const characterization = liveMarkerCharacterizationSummary(state.text);
  const markerGeometry = liveSweepGeometrySummary(state.text);
  if (markerGeometry.plotPoints !== 450) {
    throw new Error(`${profile.id} marker oracle requires 450-point swept geometry`);
  }
  const markerExpectation = liveSignalLabMarkerExpectation(profile);
  const markerCenterOracle = validateLiveMarkerEvidence(
    marker,
    characterization,
    profile,
    markerExpectation,
  );
  return {
    state,
    marker: { ...marker, ...characterization },
    markerExpectation,
    markerCenterOracle,
    markerGeometry,
    markerFreshness,
  };
}

function activeRunRouteControlLabels(label) {
  return ({
    Waterfall: ['Edit Color floor'],
    Channel: ['Edit Center frequency'],
    'I/Q': ['Edit Center frequency'],
    Device: ['SignalLab profile'],
    Spectrum: [],
  })[label] ?? [];
}

function activeRunRouteControlsPresent(text, label) {
  if (label === 'Waterfall') return hasEditableDisclosure(text, 'Color floor');
  if (label === 'Channel' || label === 'I/Q') {
    return hasEditableDisclosure(text, 'Center frequency');
  }
  if (label === 'Device') {
    return signalLabProfileControlBody(text) !== null;
  }
  return label === 'Spectrum';
}

function signalLabProfileControlBody(text) {
  return signalLabProfileControlSummary(text)?.body ?? null;
}

function signalLabProfileControlSummary(text) {
  const body = accessibilityBodies(text).find((candidate) => (
    /^(?:pop up button|combo box)\b.*(?:Description:\s*)?SignalLab profile(?:$|,|\s)/i
      .test(candidate)
  )) ?? null;
  if (body === null || body.includes('(disabled)')) return null;
  const selectedValue = /\bValue:\s*([^,]+?)(?=\s+·|,|$)/i.exec(body)?.[1].trim() ?? null;
  return selectedValue === null || selectedValue.length === 0
    ? null
    : { body, selectedValue };
}

function signalLabProfilePopupEvidence(text) {
  const bodies = accessibilityBodies(text);
  const expandedControl = bodies.find((body) => (
    /^(?:pop up button|combo box)\b.*(?:Description:\s*)?SignalLab profile(?:$|,|\s)/i
      .test(body)
    && /(?:\(expanded\)|Expanded:\s*true|expanded\s*[:=]\s*1)/i.test(body)
  )) ?? null;
  const nativeProfileOptions = bodies.flatMap((body) => {
    const label = menuItemLabel(body);
    return label !== null && /\s·\s[\d,.]+\s*(?:Hz|kHz|MHz|GHz)\b/i.test(label)
      ? [label]
      : [];
  });
  return {
    open: expandedControl !== null || nativeProfileOptions.length > 0,
    source: nativeProfileOptions.length > 0
      ? 'native-signal-lab-profile-menu-items'
      : expandedControl !== null
        ? 'expanded-signal-lab-profile-control'
        : null,
    expandedControl,
    nativeProfileOptions,
  };
}

function markerOneSelectedVisibility(text, visibility) {
  const pattern = new RegExp(`^button Marker 1,\\s*${escapeRegExp(visibility)},\\s*selected\\b`, 'i');
  return accessibilityBodies(text).some((body) => pattern.test(body));
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

async function exerciseWaterfall(context, state, profile) {
  state = await navigate(context, state, 'Waterfall');
  state = await waitForState(
    context,
    (candidate) => {
      const summary = liveWaterfallSummary(candidate.text);
      return summary.imagePresent
        && !summary.noHistory
        && Number.isSafeInteger(summary.coherentRows)
        && summary.coherentRows >= 2
        && Number.isSafeInteger(summary.renderedColors)
        && summary.renderedColors >= 2;
    },
    'nondegenerate coherent waterfall history',
    context.options.acquisitionTimeoutMs,
  );
  const waterfall = liveWaterfallSummary(state.text);
  const waterfallOracle = validateLiveWaterfallEvidence(waterfall, profile);
  return {
    state,
    waterfall,
    waterfallOracle,
  };
}

async function exerciseChannel(context, state, profile) {
  state = await navigate(context, state, 'Channel');
  state = await waitForState(
    context,
    (candidate) => /3\s+dB\s+BANDWIDTH/i.test(candidate.text),
    'channel measurement result or explicit unavailable outcome',
    context.options.acquisitionTimeoutMs,
  );
  const summary = liveChannelSummary(state.text);
  const channelOracle = validateLiveChannelEvidence(summary, profile, {
    strictNarrow: context.options.narrowMarkerProfileIds.includes(profile.id),
    strictWideband: context.options.wideMarkerProfileIds.includes(profile.id),
  });
  return { state, channel: summary, channelOracle };
}

async function exerciseIq(context, state, profile) {
  state = await ensureStopped(context, state);
  state = await navigate(context, state, 'I/Q');
  validateLiveLayoutContract(state.text, { running: false });
  const previousIq = liveIqSummary(state.text);
  state = await clickElement(context, state, enabledButton('Single'), 'global Single for I/Q');
  state = await waitForState(
    context,
    (candidate) => {
      const summary = liveIqSummary(candidate.text);
      return summary.captureId !== null
        && summary.captureId !== previousIq.captureId
        && Number.isSafeInteger(summary.captureSequence)
        && (previousIq.captureSequence === null
          || summary.captureSequence > previousIq.captureSequence)
        && summary.captureCenterHz === profile.centerHz
        && summary.samples !== null
        && summary.samples >= 2
        && summary.previewPoints !== null
        && summary.previewPoints >= 2
        && findElementIndex(candidate.text, enabledButton('Single')) !== undefined;
    },
    `complete complex-I/Q capture for ${profile.id}`,
    context.options.acquisitionTimeoutMs,
  );
  assertNoFatalUi(state, `complex I/Q ${profile.id}`);
  let iq = liveIqSummary(state.text);
  const freshCapture = validateFreshIqCapture(previousIq, iq, profile);
  let iqOracle = validateLiveIqEvidence(iq, profile, {
    requireNoLocalCapture: context.options.requireNoLocalIqCaptureButton,
  });
  const configuredCenterHz = disclosureFrequency(state.text, 'Center frequency');
  if (configuredCenterHz === null || configuredCenterHz !== profile.centerHz) {
    throw new Error(
      `${profile.id} I/Q center ${String(configuredCenterHz)} did not match catalog center ${profile.centerHz} Hz`,
    );
  }

  let zoom = iq.zoom;
  if (context.options.iqZoomProfileIds.includes(profile.id)) {
    state = await clickElement(
      context,
      state,
      (body) => body.startsWith('button Zoom I/Q plots out'),
      'I/Q zoom out',
    );
    if (liveIqSummary(state.text).zoom !== '0.5×') {
      throw new Error('I/Q zoom-out control did not reach 0.5×');
    }
    state = await clickElement(
      context,
      state,
      (body) => body.startsWith('button Fit I/Q plots to capture'),
      'I/Q fit after zoom out',
    );
    if (liveIqSummary(state.text).zoom !== '1×') {
      throw new Error('I/Q fit control did not restore 1× after zoom out');
    }
    state = await clickElement(
      context,
      state,
      (body) => body.startsWith('button Zoom I/Q plots in'),
      'I/Q zoom in',
    );
    if (liveIqSummary(state.text).zoom !== '2×') {
      throw new Error('I/Q zoom-in control did not reach 2×');
    }
    state = await clickElement(
      context,
      state,
      (body) => body.startsWith('button Fit I/Q plots to capture'),
      'I/Q fit',
    );
    if (liveIqSummary(state.text).zoom !== '1×') {
      throw new Error('I/Q fit control did not restore 1×');
    }
    zoom = '1×';
  }

  let continuousBuffers = null;
  let continuousFreshness = null;
  if (context.options.iqContinuousProfileIds.includes(profile.id)) {
    const firstIq = liveIqSummary(state.text);
    const firstCapture = firstIq.captureId;
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
    const secondIq = liveIqSummary(state.text);
    const secondCapture = secondIq.captureId;
    continuousFreshness = validateFreshIqCapture(firstIq, secondIq, profile);
    state = await ensureStopped(context, state);
    const stoppedCapture = liveIqSummary(state.text).captureId;
    await delay(context.options.pollIntervalMs * 2);
    state = await freshState(context);
    if (liveIqSummary(state.text).captureId !== stoppedCapture) {
      throw new Error('A new I/Q capture was published after the global Stop operation completed');
    }
    continuousBuffers = [firstCapture, secondCapture];
  }
  iq = liveIqSummary(state.text);
  iqOracle = validateLiveIqEvidence(iq, profile, {
    requireNoLocalCapture: context.options.requireNoLocalIqCaptureButton,
  });
  return {
    state,
    captureId: iq.captureId,
    zoom,
    continuousBuffers,
    continuousFreshness,
    iq,
    iqOracle,
    freshCapture,
  };
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
  if (label === 'Device') return text.includes('text Instrument source');
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
  const stopped = await waitForState(
    context,
    (candidate) => findElementIndex(candidate.text, enabledButton('Run')) !== undefined
      && findElementIndex(candidate.text, enabledButton('Single')) !== undefined,
    'stopped global acquisition controls',
    context.options.acquisitionTimeoutMs,
  );
  validateLiveLayoutContract(stopped.text, { running: false });
  return stopped;
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

const SIGNAL_LAB_SIDEBAR_ROUTES = Object.freeze([
  'Spectrum',
  'Waterfall',
  'Channel',
  'I/Q',
  'Detect',
  'Generate',
  'Device',
]);

function interactiveLabelMatches(body, label) {
  const escaped = escapeRegExp(label);
  return new RegExp(`^(?:button|toggle button|tab)\\s+${escaped}(?:$|,| \\()`, 'i').test(body);
}

export function liveGlobalSweepIdentitySummary(text) {
  const diagnostics = accessibilityBodies(text).flatMap((body) => {
    if (!/^(?:container|region|group|section)\s+Acquisition controls(?:$|,)/i.test(body)) {
      return [];
    }
    const match = /\bDEV ACQUISITION LANDMARK; controls=(Run,Single|Stop); sweepId=([^;,\s]+); sequence=(none|\d+)\b/i
      .exec(body);
    if (!match) return [];
    const sweepId = match[2] === 'none' ? null : match[2];
    const sequence = match[3] === 'none' ? null : Number(match[3]);
    return [{ body, controls: match[1], sweepId, sequence }];
  });
  const diagnostic = diagnostics.length === 1 ? diagnostics[0] : null;
  const identityPairValid = diagnostic !== null
    && ((diagnostic.sweepId === null && diagnostic.sequence === null)
      || (typeof diagnostic.sweepId === 'string'
        && diagnostic.sweepId.length > 0
        && Number.isSafeInteger(diagnostic.sequence)));
  return {
    evidenceCount: diagnostics.length,
    valid: identityPairValid,
    controls: diagnostic?.controls ?? null,
    sweepId: identityPairValid ? diagnostic.sweepId : null,
    sequence: identityPairValid ? diagnostic.sequence : null,
    evidence: diagnostic?.body ?? null,
  };
}

export function liveLayoutContractSummary(text) {
  const bodies = accessibilityBodies(text);
  const globalSweepIdentity = liveGlobalSweepIdentitySummary(text);
  const routeCounts = Object.fromEntries(SIGNAL_LAB_SIDEBAR_ROUTES.map((label) => [
    label,
    bodies.filter((body) => interactiveLabelMatches(body, label)).length,
  ]));
  const acquisitionCounts = Object.fromEntries(['Run', 'Single', 'Stop'].map((label) => [
    label.toLowerCase(),
    bodies.filter((body) => interactiveLabelMatches(body, label)).length,
  ]));
  const forbiddenNavigation = bodies.filter((body) => (
    /^(?:button|toggle button|tab)\s+(?:Classify|Time\s*\/\s*STFT|Time\/STFT|Envelope\s*\/\s*STFT)(?:$|,| \()/i
      .test(body)
  ));
  const localIqCaptureControls = bodies.filter((body) => (
    /^(?:button|toggle button)\s+Capture\s+I\s*\/?\s*Q(?:$|,| \()/i.test(body)
  ));
  const acquisitionLandmarkIndexes = bodies.flatMap((body, index) => (
    /^(?:container|region|group|section)\s+Acquisition controls(?:$|,)/i.test(body)
      ? [index]
      : []
  ));
  const acquisitionControlIndexes = bodies.flatMap((body, index) => (
    ['Run', 'Single', 'Stop'].some((label) => interactiveLabelMatches(body, label))
      ? [index]
      : []
  ));
  const expectedAcquisitionDiagnostic = acquisitionCounts.stop === 1
    && acquisitionCounts.run === 0
    && acquisitionCounts.single === 0
    ? 'controls=Stop'
    : acquisitionCounts.run === 1
      && acquisitionCounts.single === 1
      && acquisitionCounts.stop === 0
      ? 'controls=Run,Single'
      : null;
  const acquisitionLandmarkControlBinding = acquisitionLandmarkIndexes.length === 1
    && expectedAcquisitionDiagnostic !== null
    && globalSweepIdentity.valid
    && globalSweepIdentity.controls === expectedAcquisitionDiagnostic.replace('controls=', '');
  const routeOrder = bodies.flatMap((body) => {
    const label = SIGNAL_LAB_SIDEBAR_ROUTES.find((candidate) => (
      interactiveLabelMatches(body, candidate)
    ));
    return label === undefined ? [] : [label];
  });
  return {
    routeCounts,
    routeOrder,
    acquisitionCounts,
    acquisitionLandmarkCount: acquisitionLandmarkIndexes.length,
    acquisitionLandmarkPrecedesControls: acquisitionLandmarkIndexes.length === 1
      && acquisitionControlIndexes.length > 0
      && acquisitionControlIndexes.every((index) => index > acquisitionLandmarkIndexes[0]),
    acquisitionLandmarkControlBinding,
    globalSweepIdentity,
    forbiddenNavigation,
    localIqCaptureControls,
  };
}

export function validateLiveLayoutContract(text, { running = false } = {}) {
  if (typeof running !== 'boolean') throw new TypeError('running layout state must be a boolean');
  const summary = liveLayoutContractSummary(text);
  const invalidRoutes = Object.entries(summary.routeCounts)
    .filter(([, count]) => count !== 1);
  if (invalidRoutes.length > 0) {
    throw new Error(
      `SignalLab sidebar routes must each occur exactly once: ${invalidRoutes.map(([label, count]) => `${label}=${count}`).join(', ')}`,
    );
  }
  if (!sameOrderedValues(summary.routeOrder, SIGNAL_LAB_SIDEBAR_ROUTES)) {
    throw new Error(
      `SignalLab sidebar route order changed: ${summary.routeOrder.join(' -> ')}`,
    );
  }
  if (summary.forbiddenNavigation.length > 0) {
    throw new Error(`Removed navigation resurfaced: ${summary.forbiddenNavigation.join(' | ')}`);
  }
  if (summary.localIqCaptureControls.length > 0) {
    throw new Error(`I/Q exposed a redundant local capture control: ${summary.localIqCaptureControls.join(' | ')}`);
  }
  if (summary.acquisitionLandmarkCount !== 1) {
    throw new Error(
      `Acquisition controls landmark must occur exactly once; observed ${summary.acquisitionLandmarkCount}`,
    );
  }
  const expected = running
    ? { run: 0, single: 0, stop: 1 }
    : { run: 1, single: 1, stop: 0 };
  if (Object.entries(expected).some(([label, count]) => summary.acquisitionCounts[label] !== count)) {
    throw new Error(
      `Global acquisition controls are not unique for ${running ? 'running' : 'stopped'} state: ${JSON.stringify(summary.acquisitionCounts)}`,
    );
  }
  if (!summary.acquisitionLandmarkPrecedesControls) {
    throw new Error('Global acquisition controls are not nested after the Acquisition controls landmark');
  }
  if (!summary.acquisitionLandmarkControlBinding) {
    throw new Error('Acquisition controls landmark omitted its development child-control binding');
  }
  return summary;
}

function autoMostProminentButton(body) {
  return (body === 'button Auto · most prominent'
      || body.startsWith('button Auto · most prominent,')
      || body === 'toggle button Auto · most prominent'
      || body.startsWith('toggle button Auto · most prominent ')
      || body.startsWith('toggle button Auto · most prominent,'))
    && !body.includes('(disabled)');
}

export function liveDetectCandidateRankingSummary(text) {
  const bodies = accessibilityBodies(text);
  const developerEvidence = bodies.find((body) => /\bDEV RANK POPULATION\b/i.test(body)) ?? null;
  const developerWinner = developerEvidence
    ? /\bwinner=([^;,|\s]+)/i.exec(developerEvidence)?.[1] ?? null
    : null;
  const developerDeclaredCandidateCount = developerEvidence
    ? [...developerEvidence.matchAll(/\bcandidate=/gi)].length
    : 0;
  const developerCandidates = developerEvidence
    ? [...developerEvidence.matchAll(
        /\bcandidate=([^;,|\s]+),raw=([^;,|\s]+),power=([-−]?\d+(?:\.\d+)?)\s*dBm,cells=(\d+)/gi,
      )].map((match, index) => ({
        rank: index + 1,
        representativeId: match[1],
        rawTargetId: match[2],
        integratedExcessDbm: Number(match[3].replace('−', '-')),
        supportCellCount: Number(match[4]),
        autoTarget: match[1] === developerWinner,
        evidence: match[0],
      }))
    : [];
  const visibleCandidates = [];
  for (const [index, body] of bodies.entries()) {
    const match = /integrated excess\s+([-−]?\d+(?:\.\d+)?)\s*dBm\s+·\s+(\d+)\s+cells?\b/i.exec(body);
    if (!match) continue;
    const rankIndex = nearestCandidateRankIndex(bodies, index);
    visibleCandidates.push({
      rank: rankIndex < 0 ? candidateRank(body) : candidateRank(bodies[rankIndex]),
      integratedExcessDbm: Number(match[1].replace('−', '-')),
      supportCellCount: Number(match[2]),
      autoTarget: /\bAUTO TARGET\b/i.test(body),
      evidence: body,
    });
  }
  const candidates = developerCandidates.length > 0 ? developerCandidates : visibleCandidates;
  const autoTargets = candidates.filter(({ autoTarget }) => autoTarget);
  const autoTarget = autoTargets[0] ?? null;
  const strongestIntegratedExcessDbm = candidates.length > 0
    ? Math.max(...candidates.map(({ integratedExcessDbm }) => integratedExcessDbm))
    : null;
  // The UI rounds this independent evidence to 0.1 dB. A displayed tie is
  // therefore accepted, but a visibly weaker automatic target is not.
  const autoTargetIsMaximumIntegratedExcess = autoTargets.length === 1
    && autoTarget !== null
    && Number.isFinite(strongestIntegratedExcessDbm)
    && autoTarget.integratedExcessDbm >= strongestIntegratedExcessDbm - 0.051;
  return {
    candidates,
    autoTargetCount: autoTargets.length,
    autoTarget,
    strongestIntegratedExcessDbm,
    autoTargetIsMaximumIntegratedExcess,
    rankingEvidenceComplete: candidates.length > 0
      && candidates.every(({ rank, integratedExcessDbm, supportCellCount }) => (
        Number.isSafeInteger(rank)
        && rank > 0
        && Number.isFinite(integratedExcessDbm)
        && Number.isSafeInteger(supportCellCount)
        && supportCellCount > 0
      ))
      && (developerEvidence === null
        || (developerWinner !== null
          && developerCandidates.length > 0
          && developerCandidates.length === developerDeclaredCandidateCount)),
    evidenceSource: developerCandidates.length > 0
      ? 'development-complete-rank-population'
      : 'visible-candidate-rows',
  };
}

export function liveDetectAcceptanceSummary(text) {
  const bodies = accessibilityBodies(text);
  const ranking = liveDetectCandidateRankingSummary(text);
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
      && autoTargetSupportCellCount > 0
      && ranking.rankingEvidenceComplete
      && ranking.autoTargetIsMaximumIntegratedExcess,
    candidateRanking: ranking,
    autoTargetIsMaximumIntegratedExcess: ranking.autoTargetIsMaximumIntegratedExcess,
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
  const power = segment
    .map((body) => /([-−]?\d+(?:[\d,.]*\d)?)\s*dBm(?!\s*\/\s*Hz)\b/i.exec(body))
    .find(Boolean);
  const frequency = segment
    .map((body) => /([-−]?\d+(?:[\d,.]*\d)?)\s*(Hz|kHz|MHz|GHz)\b/i.exec(body))
    .find(Boolean);
  const centroid = bodies
    .map((body) => /noise-subtracted linear-power center\s*\(\s*([-\u2212]?\d+(?:[\d,.]*\d)?)\s*(Hz|kHz|MHz|GHz)\s+centroid\s*\)/i.exec(body))
    .find(Boolean);
  const sourceSweepId = bodies
    .map((body) => /\bsourceSweepId=([^;,\s]+)/i.exec(body)?.[1] ?? null)
    .find((value) => value !== null) ?? null;
  return {
    line: segment.length ? segment.join(' | ') : null,
    powerDbm: power ? Number(power[1].replaceAll(',', '').replace('−', '-')) : null,
    frequencyHz: frequency ? frequencyToHz(frequency[1], frequency[2]) : null,
    powerCentroidHz: centroid ? frequencyToHz(centroid[1], centroid[2]) : null,
    sourceSweepId,
    characterization: bodies.filter((body) => (
      /3 dB response width/i.test(body)
      || /99% component occupied bandwidth/i.test(body)
      || /Resolved local response/i.test(body)
      || /resolution limited/i.test(body)
    )),
  };
}

export function liveSweepIdentitySummary(text) {
  const identity = accessibilityBodies(text)
    .filter((body) => /^(?:container|region|group)\s+Spectrum plot(?:$|,)/i.test(body))
    .map((body) => /\bsweepId=([^;,\s]+);\s*sequence=(\d+)/i.exec(body))
    .find(Boolean);
  return {
    sweepId: identity?.[1] ?? null,
    sequence: identity ? Number(identity[2]) : null,
  };
}

export function validateGlobalSweepMatchesSpectrum(text, operation) {
  const global = liveGlobalSweepIdentitySummary(text);
  const local = liveSweepIdentitySummary(text);
  if (!global.valid
    || global.evidenceCount !== 1
    || !Number.isSafeInteger(global.sequence)
    || typeof global.sweepId !== 'string'
    || local.sequence !== global.sequence
    || local.sweepId !== global.sweepId) {
    throw new Error(
      `${operation} global sweep identity did not match the mounted Spectrum plot identity`,
    );
  }
  return global;
}

export function validateFreshMarkerEvidence(
  previousSweep,
  currentSweep,
  marker,
  { markerWasHidden = false, markerVisible = false } = {},
) {
  if (typeof currentSweep?.sweepId !== 'string' || currentSweep.sweepId.length === 0
    || !Number.isSafeInteger(currentSweep.sequence)) {
    throw new Error('Peak marker freshness omitted the current sweep identity');
  }
  if (typeof previousSweep?.sweepId === 'string'
    && previousSweep.sweepId === currentSweep.sweepId) {
    throw new Error(`Peak marker reused stale sweep ${currentSweep.sweepId}`);
  }
  if (Number.isSafeInteger(previousSweep?.sequence)
    && currentSweep.sequence <= previousSweep.sequence) {
    throw new Error('Peak marker sweep sequence did not advance');
  }
  if (!markerWasHidden) throw new Error('Peak marker M1 was not cleared before search');
  if (!markerVisible) throw new Error('Peak marker M1 was not visibly re-enabled by search');
  if (!Number.isFinite(marker?.frequencyHz)) {
    throw new Error('Peak marker search omitted its fresh finite M1 reading');
  }
  if (!Number.isFinite(marker?.powerDbm)) {
    throw new Error('Peak marker search omitted its fresh finite M1 power');
  }
  if (marker.sourceSweepId !== currentSweep.sweepId) {
    throw new Error(
      `Peak marker reading source ${String(marker?.sourceSweepId)} did not match current sweep ${currentSweep.sweepId}`,
    );
  }
  return {
    status: 'fresh-current-sweep-marker-validated',
    previousSweepId: previousSweep?.sweepId ?? null,
    sweepId: currentSweep.sweepId,
    previousSequence: previousSweep?.sequence ?? null,
    sequence: currentSweep.sequence,
    sourceSweepId: marker.sourceSweepId,
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
  if (!Number.isFinite(marker?.powerDbm)) {
    throw new Error(`${profile.id} M1 omitted a finite parsed marker power`);
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
  const binWidthHz = profile.recommendedSpanHz / 449;
  if (characterization.widthClassification === 'resolution-limited-narrow'
    && (threeDecibelBandwidthHz > binWidthHz * 3
      || threeDecibelBandwidthHz >= profile.recommendedSpanHz * 0.1)) {
    throw new Error(
      `${profile.id} M1 3 dB width ${threeDecibelBandwidthHz} Hz is not a narrow grid-limited response inside the visible span`,
    );
  }
  if (characterization.widthClassification === 'resolved-wideband'
    && (threeDecibelBandwidthHz <= binWidthHz * 2
      || threeDecibelBandwidthHz >= profile.recommendedSpanHz * 0.9)) {
    throw new Error(
      `${profile.id} M1 3 dB width ${threeDecibelBandwidthHz} Hz is not a resolved response bounded inside the visible span`,
    );
  }
  if (characterization.componentOccupiedBandwidthStatus !== 'measured') {
    throw new Error(`${profile.id} M1 component occupied bandwidth was not a measured result`);
  }
  if (Number.isFinite(threeDecibelBandwidthHz)) {
    validateMarkerMeasurementRelationship(profile, characterization, binWidthHz);
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
  return liveMarkerKnownCenterOracle(marker, characterization, profile);
}

export function liveMarkerKnownCenterOracle(marker, characterization, profile) {
  const binWidthHz = profile.recommendedSpanHz / 449;
  if (profile.id === 'cw') {
    const toleranceHz = Math.max(binWidthHz * 2, displayedFrequencyToleranceHz(profile.centerHz));
    if (Math.abs(marker.frequencyHz - profile.centerHz) > toleranceHz) {
      throw new Error(
        `cw M1 ${marker.frequencyHz} Hz missed its independent catalog center ${profile.centerHz} Hz by more than ${toleranceHz} Hz`,
      );
    }
    return {
      status: 'validated-known-center',
      source: 'independent-catalog-center',
      observedHz: marker.frequencyHz,
      expectedHz: profile.centerHz,
      toleranceHz,
    };
  }
  const centeredWideband = !CENTERED_WIDEBAND_MARKER_ORACLE_EXCLUDED_PROFILE_IDS.has(profile.id)
    && (characterization.widthClassification === RESOLVED_MARKER
      || (characterization.widthClassification === UNAVAILABLE_MARKER
        && Number.isFinite(marker.powerCentroidHz)));
  if (!centeredWideband) {
    return {
      status: 'not-applicable',
      reason: Number.isFinite(marker.powerCentroidHz)
        ? 'profile-allows-frequency-agile-or-multicomponent-centroid'
        : 'no-centroid-for-current-outcome',
    };
  }
  const occupiedBandwidthHz = Number.isFinite(profile.occupiedBandwidthHz)
    ? profile.occupiedBandwidthHz
    : profile.recommendedSpanHz * 0.5;
  const toleranceHz = Math.max(
    binWidthHz * 2,
    occupiedBandwidthHz * 0.05,
    displayedFrequencyToleranceHz(profile.centerHz),
  );
  if (!Number.isFinite(marker.powerCentroidHz)
    || Math.abs(marker.powerCentroidHz - profile.centerHz) > toleranceHz) {
    throw new Error(
      `${profile.id} displayed power centroid ${String(marker.powerCentroidHz)} Hz missed its independent catalog center ${profile.centerHz} Hz by more than ${toleranceHz} Hz`,
    );
  }
  return {
    status: 'validated-known-center',
    source: 'independent-catalog-center',
    observedHz: marker.powerCentroidHz,
    expectedHz: profile.centerHz,
    toleranceHz,
  };
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
  if (startHz <= visibleStartHz || stopHz >= visibleStopHz) {
    throw new Error(`${profile.id} M1 ${label} displayed range is not strictly inside the visible profile span`);
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

function validateMarkerMeasurementRelationship(profile, characterization, binWidthHz) {
  const toleranceHz = Math.max(
    binWidthHz * 2,
    characterization.threeDecibelBandwidthHz * 0.02,
    characterization.componentOccupiedBandwidthHz * 0.02,
    displayedFrequencyToleranceHz(characterization.threeDecibelStartHz) * 2,
    displayedFrequencyToleranceHz(characterization.threeDecibelStopHz) * 2,
    displayedFrequencyToleranceHz(characterization.componentOccupiedBandwidthStartHz) * 2,
    displayedFrequencyToleranceHz(characterization.componentOccupiedBandwidthStopHz) * 2,
    1,
  );
  if (characterization.componentOccupiedBandwidthHz
      < characterization.threeDecibelBandwidthHz - toleranceHz
    || characterization.componentOccupiedBandwidthStartHz
      > characterization.threeDecibelStartHz + toleranceHz
    || characterization.componentOccupiedBandwidthStopHz
      < characterization.threeDecibelStopHz - toleranceHz) {
    throw new Error(
      `${profile.id} M1 99% component occupied bandwidth is not coherent with and enclosing its 3 dB response`,
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
  if (bandwidthHz >= profile.recommendedSpanHz * 0.9) {
    throw new Error(
      `${profile.id} M1 ${label} ${bandwidthHz} Hz is not bounded below 90% of visible span ${profile.recommendedSpanHz} Hz`,
    );
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
  const requiresCompatibleFittedLabel = requireFittedReleaseOracle
    || SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS.includes(profile.id);
  return liveSignalLabClassificationEvidenceSatisfied(
    profile,
    summary,
    observedSequenceOpportunities,
  )
    && (!requiresCompatibleFittedLabel || (
      expectation.known
      && expectation.compatible === true
    ));
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

export function liveWaterfallSummary(text) {
  const bodies = accessibilityBodies(text);
  const image = bodies.find((body) => (
    /^image Measured power by frequency and sweep time(?:$|,)/i.test(body)
  )) ?? null;
  const coherent = bodies
    .map((body) => /([\d,]+)\s*\/\s*([\d,]+)\s+COHERENT\b/i.exec(body))
    .find(Boolean)
    ?? (() => {
      const anchor = bodies.findIndex((body) => /\bCOHERENT HISTORY\b/i.test(body));
      return anchor < 0
        ? null
        : bodies.slice(anchor, anchor + 3)
          .map((body) => /([\d,]+)\s*\/\s*([\d,]+)/i.exec(body))
          .find(Boolean) ?? null;
    })();
  const rendered = bodies
    .map((body) => /rows=(\d+);\s*bins=(\d+);\s*colors=(\d+);\s*minDbm=([-−]?\d+(?:\.\d+)?);\s*maxDbm=([-−]?\d+(?:\.\d+)?)/i.exec(body))
    .find(Boolean);
  return {
    image,
    imagePresent: image !== null,
    noHistory: bodies.some((body) => /^(?:text\s+)?No history\b/i.test(body)),
    coherentRows: coherent ? Number(coherent[1].replaceAll(',', '')) : null,
    historyDepth: coherent ? Number(coherent[2].replaceAll(',', '')) : null,
    renderedRows: rendered ? Number(rendered[1]) : null,
    renderedBins: rendered ? Number(rendered[2]) : null,
    renderedColors: rendered ? Number(rendered[3]) : null,
    minimumDbm: rendered ? Number(rendered[4].replace('−', '-')) : null,
    maximumDbm: rendered ? Number(rendered[5].replace('−', '-')) : null,
  };
}

export function validateLiveWaterfallEvidence(summary, profile = null) {
  const label = profile?.id ?? 'SignalLab';
  if (!summary?.imagePresent || summary.noHistory) {
    throw new Error(`${label} waterfall omitted its measured history canvas`);
  }
  if (!Number.isSafeInteger(summary.coherentRows)
    || !Number.isSafeInteger(summary.historyDepth)
    || summary.coherentRows < 2
    || summary.historyDepth < summary.coherentRows) {
    throw new Error(`${label} waterfall requires at least two coherent rows within its history depth`);
  }
  if (summary.renderedRows !== summary.coherentRows
    || !Number.isSafeInteger(summary.renderedBins)
    || summary.renderedBins < 2
    || !Number.isSafeInteger(summary.renderedColors)
    || summary.renderedColors < 2
    || !Number.isFinite(summary.minimumDbm)
    || !Number.isFinite(summary.maximumDbm)
    || summary.maximumDbm <= summary.minimumDbm) {
    throw new Error(`${label} waterfall rendered diagnostic is blank or degenerate`);
  }
  return {
    status: 'coherent-nondegenerate-render-input-validated',
    coherentRows: summary.coherentRows,
    renderedBins: summary.renderedBins,
    renderedColors: summary.renderedColors,
    powerRangeDb: summary.maximumDbm - summary.minimumDbm,
  };
}

export function liveChannelSummary(text) {
  const bodies = accessibilityBodies(text);
  // The result card exposes one exact aria-label containing the complete 3 dB
  // metric. Prefer it so unrelated channel-power/OBW values are never in the
  // parse population.
  const exactMetric = bodies.find((body) => (
    /\b3\s+dB bandwidth\s+(?:unavailable|resolution-limited|[\d,.]+\s*(?:Hz|kHz|MHz|GHz))/i
      .test(body)
  )) ?? null;
  let metricBodies = exactMetric === null ? [] : [exactMetric];
  if (metricBodies.length === 0) {
    const anchor = bodies.findIndex((body) => /^(?:text\s+)?3\s+dB\s+BANDWIDTH\b/i.test(body));
    if (anchor >= 0) {
      let stop = Math.min(bodies.length, anchor + 7);
      for (let index = anchor + 1; index < stop; index++) {
        if (/^(?:text\s+)?(?:OCCUPIED BANDWIDTH|CHANNEL POWER|LOWER ACP|UPPER ACP)\b/i
          .test(bodies[index])) {
          stop = index;
          break;
        }
      }
      metricBodies = bodies.slice(anchor, stop);
    }
  }
  const detail = metricBodies.join(' | ');
  const unavailable = /\bunavailable\b/i.test(detail);
  const limited = /\bresolution-limited\b/i.test(detail);
  const frequencies = [...detail.matchAll(/([\d,.]+)\s*(Hz|kHz|MHz|GHz)\b/gi)]
    .map((match) => frequencyToHz(match[1], match[2]));
  const bandwidthHz = unavailable ? null : frequencies[0] ?? null;
  const resolved = !unavailable && !limited && Number.isFinite(bandwidthHz);
  return {
    status: unavailable
      ? 'unavailable'
      : limited && Number.isFinite(bandwidthHz)
        ? 'resolution-limited'
        : resolved
          ? 'resolved'
          : 'unparseable',
    bandwidthHz,
    startHz: resolved ? frequencies[1] ?? null : null,
    stopHz: resolved ? frequencies[2] ?? null : null,
    resolutionScaleHz: limited ? frequencies[1] ?? null : null,
    metricNode: exactMetric,
    detail,
  };
}

function validateResolvedChannelRange(summary, profile, binWidthHz) {
  if (!Number.isFinite(summary.startHz)
    || !Number.isFinite(summary.stopHz)
    || summary.stopHz <= summary.startHz) {
    throw new Error(`${profile.id} resolved 3 dB result omitted its exact ordered range`);
  }
  const measuredSpanHz = summary.stopHz - summary.startHz;
  const consistencyToleranceHz = Math.max(
    binWidthHz * 2,
    summary.bandwidthHz * 0.02,
    displayedFrequencyToleranceHz(summary.startHz) * 2,
    displayedFrequencyToleranceHz(summary.stopHz) * 2,
  );
  if (Math.abs(measuredSpanHz - summary.bandwidthHz) > consistencyToleranceHz) {
    throw new Error(
      `${profile.id} resolved 3 dB width ${summary.bandwidthHz} Hz conflicts with range span ${measuredSpanHz} Hz`,
    );
  }
  const visibleStartHz = profile.centerHz - profile.recommendedSpanHz / 2;
  const visibleStopHz = profile.centerHz + profile.recommendedSpanHz / 2;
  if (summary.startHz < visibleStartHz - consistencyToleranceHz
    || summary.stopHz > visibleStopHz + consistencyToleranceHz) {
    throw new Error(`${profile.id} resolved 3 dB range falls outside the visible spectrum`);
  }
}

export function validateLiveChannelEvidence(
  summary,
  profile,
  { strictNarrow = profile?.id === 'cw', strictWideband = false } = {},
) {
  if (!profile || typeof profile !== 'object') throw new TypeError('channel profile is required');
  const binWidthHz = profile.recommendedSpanHz / 449;
  if (strictNarrow) {
    if (summary?.status !== 'resolution-limited') {
      throw new Error(
        `${profile.id} 3 dB bandwidth must be explicitly resolution-limited; observed ${summary?.status ?? 'missing'}`,
      );
    }
    if (!Number.isFinite(summary.bandwidthHz)
      || summary.bandwidthHz <= 0
      || !Number.isFinite(summary.resolutionScaleHz)
      || summary.resolutionScaleHz <= 0
      || summary.bandwidthHz > binWidthHz * 3
      || summary.bandwidthHz >= profile.recommendedSpanHz * 0.1) {
      throw new Error(
        `${profile.id} 3 dB bandwidth ${String(summary?.bandwidthHz)} Hz is not a narrow, grid-limited response within a ${profile.recommendedSpanHz} Hz view`,
      );
    }
    return {
      status: 'validated-resolution-limited-narrow',
      binWidthHz,
      maximumBandwidthHz: Math.min(binWidthHz * 3, profile.recommendedSpanHz * 0.1),
    };
  }
  if (strictWideband) {
    const minimumBandwidthHz = Math.max(
      binWidthHz * 2,
      (Number.isFinite(profile.occupiedBandwidthHz) ? profile.occupiedBandwidthHz : 0) * 0.1,
    );
    if (summary?.status !== 'resolved'
      || !Number.isFinite(summary.bandwidthHz)
      || summary.bandwidthHz <= minimumBandwidthHz
      || summary.bandwidthHz >= profile.recommendedSpanHz * 0.9) {
      throw new Error(
        `${profile.id} 3 dB bandwidth ${String(summary?.bandwidthHz)} Hz is not a resolved wideband response inside the visible ${profile.recommendedSpanHz} Hz span`,
      );
    }
    validateResolvedChannelRange(summary, profile, binWidthHz);
    return {
      status: 'validated-resolved-wideband',
      binWidthHz,
      minimumBandwidthHz,
      maximumBandwidthHz: profile.recommendedSpanHz * 0.9,
    };
  }
  if (summary?.status === 'unavailable') {
    if (!/(?:No sampled peak inside the main channel|Lower half-power crossing was not observed|Upper half-power crossing was not observed|Half-power response extends outside the main channel|Resolved half-power islands are not one bounded response)/i
      .test(summary.detail ?? '')) {
      throw new Error(`${profile.id} channel unavailable result omitted its recognized physical reason`);
    }
    return { status: 'explicitly-unavailable-observation', detail: summary.detail ?? null };
  }
  if (summary?.status === 'unparseable') {
    throw new Error(`${profile.id} channel 3 dB metric was present but unparseable`);
  }
  if (!Number.isFinite(summary?.bandwidthHz) || summary.bandwidthHz <= 0) {
    throw new Error(`${profile.id} channel result was neither explicitly unavailable nor a positive width`);
  }
  if (summary.bandwidthHz >= profile.recommendedSpanHz) {
    throw new Error(`${profile.id} channel width ${summary.bandwidthHz} Hz spans the complete visible spectrum`);
  }
  if (summary.status === 'resolved') validateResolvedChannelRange(summary, profile, binWidthHz);
  return { status: 'measured-sanity-validated', binWidthHz };
}

const IQ_REQUIRED_METRIC_LABELS = Object.freeze([
  'Samples',
  'Duration',
  'Preview RMS',
  'Preview peak',
]);

function iqMetricAnchorMatch(body, label) {
  return new RegExp(
    `^(?:(?:text|static text|group|container)\\s+)?${escapeRegExp(label)}(?:\\s*[:·—–]\\s*|\\s+|$)`,
    'i',
  ).exec(body);
}

function iqMetricValue(bodies, label) {
  const anchors = bodies.flatMap((body, index) => (
    iqMetricAnchorMatch(body, label) ? [{ body, index }] : []
  ));
  if (anchors.length !== 1) return null;
  const [{ body, index }] = anchors;
  const match = iqMetricAnchorMatch(body, label);
  const inlineValue = match ? body.slice(match[0].length).trim() : '';
  if (inlineValue) return inlineValue;
  const adjacent = bodies[index + 1];
  if (adjacent === undefined
    || IQ_REQUIRED_METRIC_LABELS.some((candidate) => (
      iqMetricAnchorMatch(adjacent, candidate) !== null
    ))) return null;
  return adjacent.replace(/^(?:text|static text)\s+/i, '').trim() || null;
}

function iqMetricOrderValid(bodies) {
  const indexes = IQ_REQUIRED_METRIC_LABELS.map((label) => bodies.flatMap((body, index) => (
    iqMetricAnchorMatch(body, label) ? [index] : []
  )));
  return indexes.every((matches) => matches.length === 1)
    && indexes.every((matches, index) => index === 0 || matches[0] > indexes[index - 1][0]);
}

function iqDbfsMetric(bodies, label) {
  const value = iqMetricValue(bodies, label);
  if (value === null || /^[−-]∞\s*dBFS$/i.test(value)) return null;
  const match = /^([-−]?\d+(?:\.\d+)?)\s*dBFS$/i.exec(value);
  return match ? Number(match[1].replace('−', '-')) : null;
}

export function liveIqSummary(text) {
  const bodies = accessibilityBodies(text);
  const captureIdentity = bodies
    .map((body) => /\bcaptureId=([^;,\s]+);\s*sequence=(\d+);\s*centerHz=(\d+)/i.exec(body))
    .find(Boolean);
  const samplesMatch = /^([\d,]+)$/.exec(iqMetricValue(bodies, 'Samples') ?? '');
  const durationMatch = /^([\d.]+)\s*(µs|us|ms|s)$/i.exec(
    iqMetricValue(bodies, 'Duration') ?? '',
  );
  const durationSeconds = durationMatch
    ? Number(durationMatch[1]) * ({ 'µs': 1e-6, us: 1e-6, ms: 1e-3, s: 1 })[
      durationMatch[2].toLowerCase()
    ]
    : null;
  const zoomAnchor = bodies.findIndex((body) => /I\/Q plot zoom/i.test(body));
  const zoomSegment = zoomAnchor < 0
    ? ''
    : bodies.slice(Math.max(0, zoomAnchor - 1), zoomAnchor + 3).join(' | ');
  const zoom = /\b(0\.5|1|2|4|8)×(?=$|[,\s]|\|)/.exec(zoomSegment)?.[0] ?? null;
  const captureId = iqCaptureId(text) ?? captureIdentity?.[1] ?? null;
  const previewPointsMatch = /([\d,]+)\s+evenly sampled preview points/i.exec(text);
  const previewPoints = previewPointsMatch
    ? Number(previewPointsMatch[1].replaceAll(',', ''))
    : null;
  return {
    captureId,
    metricOrderValid: iqMetricOrderValid(bodies),
    captureSequence: captureIdentity ? Number(captureIdentity[2]) : null,
    captureCenterHz: captureIdentity ? Number(captureIdentity[3]) : null,
    timePlotPresent: bodies.some((body) => (
      /^image I and Q sample amplitude over capture time(?:$|,)/i.test(body)
    )),
    constellationPresent: bodies.some((body) => (
      /^image Complex I Q constellation preview(?:$|,)/i.test(body)
    )),
    scaleGroupPresent: bodies.some((body) => (
      /^(?:group|container|region) I\/Q plot scale(?:$|,)/i.test(body)
    )),
    zoomControlsPresent: [
      'Zoom I/Q plots out',
      'Fit I/Q plots to capture',
      'Zoom I/Q plots in',
    ].every((label) => bodies.some((body) => interactiveLabelMatches(body, label))),
    zoom,
    samples: samplesMatch ? Number(samplesMatch[1].replaceAll(',', '')) : null,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
    previewRmsDbfs: iqDbfsMetric(bodies, 'Preview RMS'),
    previewPeakDbfs: iqDbfsMetric(bodies, 'Preview peak'),
    previewPoints: Number.isSafeInteger(previewPoints) ? previewPoints : null,
    visualizationError: bodies.find((body) => /I\/Q payload could not be visualized:/i.test(body)) ?? null,
    placeholderVisible: bodies.some((body) => (
      /NO COMPLEX-SAMPLE CAPTURE YET|USE SIDEBAR SINGLE OR RUN|NO SAMPLES/i.test(body)
    )),
    localCapturePresent: bodies.some((body) => (
      /^(?:button|toggle button)\s+Capture\s+I\s*\/?\s*Q(?:$|,| \()/i.test(body)
    )),
  };
}

export function validateFreshIqCapture(previous, current, profile) {
  if (!profile || typeof profile !== 'object') throw new TypeError('I/Q profile is required');
  if (typeof current?.captureId !== 'string' || current.captureId.length === 0) {
    throw new Error(`${profile.id} I/Q Single omitted its capture ID`);
  }
  if (previous?.captureId !== null && previous?.captureId !== undefined
    && current.captureId === previous.captureId) {
    throw new Error(`${profile.id} I/Q Single reused stale capture ID ${current.captureId}`);
  }
  if (!Number.isSafeInteger(current.captureSequence)
    || current.captureSequence < 1
    || (Number.isSafeInteger(previous?.captureSequence)
      && current.captureSequence <= previous.captureSequence)) {
    throw new Error(`${profile.id} I/Q Single did not advance its capture sequence`);
  }
  if (current.captureCenterHz !== profile.centerHz) {
    throw new Error(
      `${profile.id} I/Q capture center ${String(current.captureCenterHz)} did not match ${profile.centerHz} Hz`,
    );
  }
  return {
    status: 'fresh-current-profile-capture-validated',
    previousCaptureId: previous?.captureId ?? null,
    captureId: current.captureId,
    previousSequence: previous?.captureSequence ?? null,
    sequence: current.captureSequence,
    centerHz: current.captureCenterHz,
  };
}

export function validateLiveIqEvidence(
  summary,
  profile = null,
  { requireNoLocalCapture = true } = {},
) {
  const label = profile?.id ?? 'SignalLab';
  if (!summary?.timePlotPresent || !summary.constellationPresent) {
    throw new Error(`${label} I/Q omitted a live time or constellation plot`);
  }
  if (!summary.scaleGroupPresent || !summary.zoomControlsPresent || summary.zoom === null) {
    throw new Error(`${label} I/Q omitted its anchored plot-scaling controls`);
  }
  if (summary.metricOrderValid !== true) {
    throw new Error(`${label} I/Q required metrics are missing, duplicated, or misordered`);
  }
  if (summary.captureId === null
    || !Number.isSafeInteger(summary.samples)
    || summary.samples < 2
    || !Number.isSafeInteger(summary.previewPoints)
    || summary.previewPoints < 2
    || summary.previewPoints > summary.samples
    || !Number.isFinite(summary.durationSeconds)
    || summary.durationSeconds <= 0) {
    throw new Error(`${label} I/Q capture geometry is missing or degenerate`);
  }
  if (!Number.isFinite(summary.previewRmsDbfs)
    || !Number.isFinite(summary.previewPeakDbfs)
    || summary.previewPeakDbfs < summary.previewRmsDbfs) {
    throw new Error(`${label} I/Q preview is zero, non-finite, or has peak below RMS`);
  }
  if (summary.visualizationError !== null || summary.placeholderVisible) {
    throw new Error(`${label} I/Q exposed an empty or failed visualization`);
  }
  if (requireNoLocalCapture && summary.localCapturePresent) {
    throw new Error(`${label} I/Q exposed the redundant local Capture I/Q control`);
  }
  return {
    status: 'nondegenerate-capture-and-scaling-validated',
    samples: summary.samples,
    previewPoints: summary.previewPoints,
    previewRmsDbfs: summary.previewRmsDbfs,
    previewPeakDbfs: summary.previewPeakDbfs,
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
  return await captureState(context, state, profileId, stage, { enforceUnique: true });
}

async function captureFailure(context, state, profileId, stage) {
  if (!state || context.options.screenshotPolicy === 'none') return null;
  return await captureState(context, state, profileId, stage, { enforceUnique: false });
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
    const dimensions = {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
    if (dimensions.width === 0 || dimensions.height === 0) {
      throw new Error('Computer Use PNG screenshot has zero dimensions');
    }
    return dimensions;
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
        if (length < 7) throw new Error('Computer Use JPEG screenshot has a truncated SOF marker');
        const dimensions = {
          width: buffer.readUInt16BE(offset + 5),
          height: buffer.readUInt16BE(offset + 3),
        };
        if (dimensions.width === 0 || dimensions.height === 0) {
          throw new Error('Computer Use JPEG screenshot has zero dimensions');
        }
        return dimensions;
      }
      offset += length;
    }
    throw new Error('Computer Use JPEG screenshot lacks a supported SOF size marker');
  }
  throw new Error(`Unsupported Computer Use screenshot extension: ${normalized || '(none)'}`);
}

export function liveScreenshotMeetsMinimum(
  dimensions,
  minimumWidth = SIGNAL_LAB_MINIMUM_SCREENSHOT_WIDTH,
  minimumHeight = SIGNAL_LAB_MINIMUM_SCREENSHOT_HEIGHT,
) {
  return Number.isSafeInteger(dimensions?.width)
    && Number.isSafeInteger(dimensions?.height)
    && Number.isSafeInteger(minimumWidth)
    && Number.isSafeInteger(minimumHeight)
    && dimensions.width >= minimumWidth
    && dimensions.height >= minimumHeight;
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

export function livePngPixelEvidence(bytes) {
  const buffer = Buffer.from(bytes);
  const dimensions = liveScreenshotDimensions(buffer, '.png');
  let offset = 8;
  let bitDepth = null;
  let colorType = null;
  let interlace = null;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataStop = dataStart + length;
    if (dataStop + 4 > buffer.length) throw new Error('PNG screenshot contains a truncated chunk');
    if (type === 'IHDR') {
      if (length !== 13) throw new Error('PNG screenshot has an invalid IHDR length');
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataStop));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStop + 4;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[colorType];
  if (bitDepth !== 8 || channels === undefined || interlace !== 0 || idat.length === 0) {
    throw new Error(
      `PNG screenshot pixel validation requires non-interlaced 8-bit grayscale/RGB/RGBA data; observed depth=${String(bitDepth)} color=${String(colorType)} interlace=${String(interlace)}`,
    );
  }
  if (dimensions.width > 8_192
    || dimensions.height > 8_192
    || dimensions.width * dimensions.height > 25_000_000) {
    throw new Error('PNG screenshot dimensions exceed the bounded live-evidence decoder');
  }
  const stride = dimensions.width * channels;
  const expectedInflatedLength = (stride + 1) * dimensions.height;
  const inflated = inflateSync(Buffer.concat(idat), {
    maxOutputLength: expectedInflatedLength,
  });
  if (inflated.length !== expectedInflatedLength) {
    throw new Error('PNG screenshot decompressed geometry does not match IHDR');
  }
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  const sampleStep = Math.max(1, Math.floor(
    dimensions.width * dimensions.height / 20_000,
  ));
  const rowRgba = Buffer.alloc(dimensions.width * 4);
  const pixelHash = createHash('sha256')
    .update(`${dimensions.width}x${dimensions.height}:`);
  const colors = new Set();
  let minimumLuminance = Number.POSITIVE_INFINITY;
  let maximumLuminance = Number.NEGATIVE_INFINITY;
  let sampledPixels = 0;
  for (let row = 0; row < dimensions.height; row++) {
    const sourceOffset = row * (stride + 1);
    const filter = inflated[sourceOffset];
    for (let column = 0; column < stride; column++) {
      const raw = inflated[sourceOffset + 1 + column];
      const left = column >= channels ? current[column - channels] : 0;
      const above = previous[column];
      const upperLeft = column >= channels ? previous[column - channels] : 0;
      const value = filter === 0
        ? raw
        : filter === 1
          ? raw + left
          : filter === 2
            ? raw + above
            : filter === 3
              ? raw + Math.floor((left + above) / 2)
              : filter === 4
                ? raw + paethPredictor(left, above, upperLeft)
                : Number.NaN;
      if (!Number.isFinite(value)) throw new Error(`PNG screenshot uses unsupported filter ${filter}`);
      current[column] = value & 0xff;
    }
    for (let column = 0; column < dimensions.width; column++) {
      const pixelIndex = row * dimensions.width + column;
      const base = column * channels;
      const red = current[base];
      const green = colorType === 0 || colorType === 4 ? current[base] : current[base + 1];
      const blue = colorType === 0 || colorType === 4 ? current[base] : current[base + 2];
      const alpha = colorType === 4
        ? current[base + 1]
        : colorType === 6
          ? current[base + 3]
          : 255;
      const rgbaOffset = column * 4;
      rowRgba[rgbaOffset] = red;
      rowRgba[rgbaOffset + 1] = green;
      rowRgba[rgbaOffset + 2] = blue;
      rowRgba[rgbaOffset + 3] = alpha;
      if (pixelIndex % sampleStep !== 0) continue;
      // Screenshot evidence is evaluated as composited over black so fully
      // transparent hidden RGB cannot make an empty image appear nonblank.
      const compositeRed = Math.round(red * alpha / 255);
      const compositeGreen = Math.round(green * alpha / 255);
      const compositeBlue = Math.round(blue * alpha / 255);
      colors.add((compositeRed << 16) | (compositeGreen << 8) | compositeBlue);
      const luminance = 0.2126 * compositeRed
        + 0.7152 * compositeGreen
        + 0.0722 * compositeBlue;
      minimumLuminance = Math.min(minimumLuminance, luminance);
      maximumLuminance = Math.max(maximumLuminance, luminance);
      sampledPixels++;
    }
    // Normalize every decoded format to RGBA and include alpha in content
    // identity even though ordinary OS screenshots are composited opaque.
    pixelHash.update(rowRgba);
    current.copy(previous);
  }
  return {
    ...dimensions,
    sampledPixels,
    distinctColors: colors.size,
    minimumLuminance,
    maximumLuminance,
    luminanceRange: maximumLuminance - minimumLuminance,
    pixelSha256: pixelHash.digest('hex'),
  };
}

async function liveScreenshotArtifactEvidence(
  path,
  extension,
  options,
  operation,
  scratchDirectory = dirname(path),
) {
  const bytes = await readFile(path);
  if (bytes.length === 0) throw new Error(`${operation} screenshot is empty: ${path}`);
  const dimensions = liveScreenshotDimensions(bytes, extension);
  if (!liveScreenshotMeetsMinimum(
    dimensions,
    options.minimumScreenshotWidth,
    options.minimumScreenshotHeight,
  )) {
    throw new Error(
      `${operation} screenshot ${dimensions.width}×${dimensions.height} is below the required visible app size ${options.minimumScreenshotWidth}×${options.minimumScreenshotHeight}`,
    );
  }
  let pngBytes = bytes;
  let temporaryPng = null;
  if (extension !== '.png') {
    const scratchName = createHash('sha256').update(path).digest('hex').slice(0, 16);
    temporaryPng = join(scratchDirectory, `.pixel-check-${process.pid}-${scratchName}.png`);
    try {
      await execFileAsync('sips', ['-s', 'format', 'png', path, '--out', temporaryPng]);
      pngBytes = await readFile(temporaryPng);
    } catch (error) {
      throw new Error(
        `${operation} JPEG screenshot could not be decoded through macOS sips: ${serializeError(error).message}`,
      );
    } finally {
      if (temporaryPng !== null) await unlink(temporaryPng).catch(() => undefined);
    }
  }
  const pixels = livePngPixelEvidence(pngBytes);
  if (pixels.width !== dimensions.width || pixels.height !== dimensions.height) {
    throw new Error(`${operation} screenshot dimensions changed during pixel decoding`);
  }
  if (pixels.sampledPixels < 2
    || pixels.distinctColors < 8
    || pixels.luminanceRange < 8) {
    throw new Error(
      `${operation} screenshot is blank or visually degenerate: ${JSON.stringify(pixels)}`,
    );
  }
  return {
    extension,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...pixels,
    claim: 'fresh-frame-dimensions-pixel-nondegeneracy-and-duplicate-content',
  };
}

async function liveScreenshotEvidence(context, state, operation) {
  if (!state?.screenshot?.url) {
    if (!context.options.requireLiveScreenshots) return null;
    throw new Error(`${operation} requires the screenshot returned with its fresh Computer Use state`);
  }
  const extension = screenshotArtifactExtension(state.screenshot.url);
  return await liveScreenshotArtifactEvidence(
    fileURLToPath(state.screenshot.url),
    extension,
    context.options,
    operation,
    context.artifactDirectory,
  );
}

async function captureState(
  context,
  state,
  profileId,
  stage,
  { enforceUnique = true } = {},
) {
  let capture = state;
  if (!capture?.screenshot?.url) capture = await freshState(context);
  if (!capture.screenshot?.url) throw new Error('Atomizer Computer Use state omitted its screenshot');
  const extension = screenshotArtifactExtension(capture.screenshot.url);
  const filename = `${requireSafeArtifactName(profileId)}--${requireSafeArtifactName(stage)}${extension}`;
  const destination = join(context.artifactDirectory, filename);
  await copyFile(fileURLToPath(capture.screenshot.url), destination);
  const evidence = await liveScreenshotArtifactEvidence(
    destination,
    extension,
    context.options,
    `${profileId} ${stage}`,
    context.artifactDirectory,
  );
  const duplicate = context.screenshotHashes.get(evidence.pixelSha256);
  if (enforceUnique && duplicate !== undefined && duplicate !== destination) {
    throw new Error(`Live exercise captured duplicate screenshot content: ${duplicate} and ${destination}`);
  }
  if (enforceUnique) {
    context.screenshotHashes.set(evidence.pixelSha256, destination);
    context.screenshotEvidence.set(destination, { path: destination, ...evidence });
  }
  return destination;
}

async function persistRun(context, run) {
  const screenshotPaths = fullExerciseScreenshotSet(run).paths;
  if (run.visualContentReview && context.screenshotEvidence instanceof Map) {
    run.visualContentReview.automatedScreenshotManifest = screenshotPaths
      .map((path) => context.screenshotEvidence.get(path))
      .filter(Boolean);
  }
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
  const captureTimeScreenshotManifest = run.visualContentReview?.automatedScreenshotManifest;
  if (!Array.isArray(captureTimeScreenshotManifest)
    || !sameOrderedValues(
      captureTimeScreenshotManifest.map((entry) => entry?.path),
      screenshotSet.paths,
    )
    || !screenshotManifestEntriesValid(captureTimeScreenshotManifest, run)) {
    throw new Error('Visual review requires the exact valid capture-time automated screenshot manifest');
  }
  const reviewScreenshotManifest = [];
  const screenshotHashes = new Map();
  const screenshotOptions = {
    minimumScreenshotWidth: run.options?.minimumScreenshotWidth
      ?? DEFAULT_OPTIONS.minimumScreenshotWidth,
    minimumScreenshotHeight: run.options?.minimumScreenshotHeight
      ?? DEFAULT_OPTIONS.minimumScreenshotHeight,
  };
  for (const [index, path] of screenshotSet.paths.entries()) {
    const extension = extname(path).toLowerCase();
    const evidence = await liveScreenshotArtifactEvidence(
      path,
      extension,
      screenshotOptions,
      'Visual review',
      dirname(reportPath),
    );
    const duplicate = screenshotHashes.get(evidence.pixelSha256);
    if (duplicate !== undefined) {
      throw new Error(`Visual review contains duplicate screenshot content: ${duplicate} and ${path}`);
    }
    screenshotHashes.set(evidence.pixelSha256, path);
    const reviewedEntry = { path, ...evidence };
    if (!sameScreenshotArtifactEvidence(captureTimeScreenshotManifest[index], reviewedEntry)) {
      throw new Error(`Visual review screenshot changed since capture: ${path}`);
    }
    reviewScreenshotManifest.push(reviewedEntry);
  }
  run.visualContentReview = {
    schemaVersion: 2,
    automatedClaim: 'fresh-frame-dimensions-pixel-nondegeneracy-and-duplicate-content',
    status: input.passed ? 'reviewed' : 'review-failed',
    passed: input.passed,
    reviewer,
    reviewedAt,
    findings: findings.map((finding) => finding.trim()),
    automatedScreenshotManifest: captureTimeScreenshotManifest,
    reviewScreenshotManifest,
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

function screenshotManifestEntriesValid(manifest, run) {
  return manifest.every((entry) => (
    Number.isSafeInteger(entry?.bytes)
      && entry.bytes > 0
      && Number.isSafeInteger(entry?.width)
      && entry.width >= (run.options?.minimumScreenshotWidth
        ?? DEFAULT_OPTIONS.minimumScreenshotWidth)
      && Number.isSafeInteger(entry?.height)
      && entry.height >= (run.options?.minimumScreenshotHeight
        ?? DEFAULT_OPTIONS.minimumScreenshotHeight)
      && Number.isSafeInteger(entry?.sampledPixels)
      && entry.sampledPixels >= 2
      && Number.isSafeInteger(entry?.distinctColors)
      && entry.distinctColors >= 8
      && Number.isFinite(entry?.luminanceRange)
      && entry.luminanceRange >= 8
      && typeof entry.sha256 === 'string'
      && /^[a-f0-9]{64}$/u.test(entry.sha256)
      && typeof entry.pixelSha256 === 'string'
      && /^[a-f0-9]{64}$/u.test(entry.pixelSha256)
  )) && new Set(manifest.map(({ pixelSha256 }) => pixelSha256)).size === manifest.length;
}

function sameScreenshotArtifactEvidence(captured, current) {
  return captured?.path === current?.path
    && captured?.extension === current?.extension
    && captured?.bytes === current?.bytes
    && captured?.width === current?.width
    && captured?.height === current?.height
    && captured?.sha256 === current?.sha256
    && captured?.pixelSha256 === current?.pixelSha256;
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
        || !sameOrderedValues(
          tour.routes.map(({ label }) => label),
          ['Waterfall', 'Channel', 'I/Q', 'Device', 'Spectrum'],
        )
        || tour.routes.some(({ stopPresent }) => stopPresent !== true)
        || tour.routes.some((route, index) => (
          !Number.isSafeInteger(route.fromSequence)
          || !Number.isSafeInteger(route.sequence)
          || route.sequence <= route.fromSequence
          || (index > 0 && route.fromSequence !== tour.routes[index - 1].sequence)
          || route.acquisitionCounts?.run !== 0
          || route.acquisitionCounts?.single !== 0
          || route.acquisitionCounts?.stop !== 1
          || route.acquisitionLandmarkCount !== 1
          || route.acquisitionLandmarkPrecedesControls !== true
          || route.acquisitionLandmarkControlBinding !== true
          || !sameOrderedValues(
            route.enabledControls ?? [],
            activeRunRouteControlLabels(route.label),
          )
          || route.globalSweepIdentity?.valid !== true
          || route.globalSweepIdentity?.evidenceCount !== 1
          || route.globalSweepIdentity?.controls !== 'Stop'
          || route.globalSweepIdentity?.sequence !== route.sequence
          || typeof route.globalSweepIdentity?.sweepId !== 'string'
          || (route.label === 'Device'
            ? route.controlInteraction?.status
                !== 'profile-selector-opened-and-cancelled-under-run'
              || typeof route.controlInteraction.profileControlEvidenceBefore !== 'string'
              || route.controlInteraction.profileControlEvidenceBefore.length === 0
              || signalLabProfileControlBody(
                route.controlInteraction.profileControlEvidenceBefore,
              ) !== route.controlInteraction.profileControlEvidenceBefore
              || typeof route.controlInteraction.profileControlEvidenceAfter !== 'string'
              || signalLabProfileControlBody(
                route.controlInteraction.profileControlEvidenceAfter,
              ) !== route.controlInteraction.profileControlEvidenceAfter
              || typeof route.controlInteraction.profileValueBefore !== 'string'
              || route.controlInteraction.profileValueBefore.length === 0
              || route.controlInteraction.profileValueAfter
                !== route.controlInteraction.profileValueBefore
              || route.controlInteraction.popupEvidence?.open !== true
              || !['native-signal-lab-profile-menu-items', 'expanded-signal-lab-profile-control']
                .includes(route.controlInteraction.popupEvidence?.source)
              || (route.controlInteraction.popupEvidence.source
                  === 'native-signal-lab-profile-menu-items'
                ? !Array.isArray(route.controlInteraction.popupEvidence.nativeProfileOptions)
                  || route.controlInteraction.popupEvidence.nativeProfileOptions.length === 0
                : typeof route.controlInteraction.popupEvidence.expandedControl !== 'string'
                  || route.controlInteraction.popupEvidence.expandedControl.length === 0)
              || !Number.isSafeInteger(
                route.controlInteraction.sweepSequenceBeforeInteraction,
              )
              || route.controlInteraction.sweepSequenceBeforeInteraction <= route.fromSequence
              || route.controlInteraction.sweepSequenceAfterInteraction !== route.sequence
              || route.sequence
                <= route.controlInteraction.sweepSequenceBeforeInteraction
            : route.controlInteraction !== null)
          || SIGNAL_LAB_SIDEBAR_ROUTES.some((label) => route.routeCounts?.[label] !== 1)
        ))
        || !Array.isArray(tour.controls)
        || !sameOrderedValues(tour.controls, ['sweep-setup', 'traces-and-markers'])) {
        throw new Error('Continuous stress evidence omitted an advancing active-Run workspace/control responsiveness tour');
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
    const labelExpectation = liveSignalLabClassificationExpectation(profile, resultLabel);
    const expectation = scientificReleaseGate
      ? labelExpectation
      : interleavedFullCatalogClassificationRecord(profile, resultLabel);
    const fittedProfile = SIGNAL_LAB_CLASSIFIER_RELEASE_GATE_PROFILE_IDS.includes(profile.id);
    const observationComplete = resultLabel !== null
      && (!fittedProfile || (
        labelExpectation.known
        && labelExpectation.compatible === true
      ))
      && evidence?.resultLinkedToAutoTarget === true
      && evidence?.resultQualification === 'BAYESIAN EVIDENCE CLASS · NOT PROTOCOL';
    return {
      profileId: profile.id,
      observationComplete,
      expectation,
      labelExpectation,
      fittedProfile,
      gateStep,
    };
  });
  const validatedProfileIds = rows.filter(({ observationComplete, expectation }) => (
    observationComplete && expectation.oracleStatus === 'validated'
  )).map(({ profileId }) => profileId);
  const failedProfileIds = rows.filter(({ labelExpectation, fittedProfile }) => (
    fittedProfile && labelExpectation.oracleStatus === 'failed'
  )).map(({ profileId }) => profileId);
  const fittedProfileCompatibilityFailedIds = rows.filter(({
    labelExpectation,
    fittedProfile,
  }) => fittedProfile && (
    !labelExpectation.known || labelExpectation.compatible !== true
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
    fittedProfileCompatibilityFailedIds,
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
  const releasePolicy = liveSignalLabReleasePolicySummary(run.options, run.kind);
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
  const fullScientificUiEvidenceComplete = run.kind === 'full-profile-exercise'
    && run.profiles.every((profile) => {
      const layout = profile.steps?.select?.layout;
      const detect = profile.steps?.['continuous-detect']?.detectAcceptance;
      const markerCenter = profile.steps?.marker?.markerCenterOracle;
      const markerFreshness = profile.steps?.marker?.markerFreshness;
      const waterfall = profile.steps?.waterfall?.waterfallOracle;
      const channel = profile.steps?.channel?.channelOracle;
      const iq = profile.steps?.iq?.iqOracle;
      const iqFreshness = profile.steps?.iq?.freshCapture;
      return storedStoppedLayoutEvidenceComplete(layout)
        && detect?.autoTargetIsMaximumIntegratedExcess === true
        && detect?.candidateRanking?.rankingEvidenceComplete === true
        && detect?.candidateRanking?.evidenceSource
          === 'development-complete-rank-population'
        && ['validated-known-center', 'not-applicable'].includes(markerCenter?.status)
        && markerFreshness?.status === 'fresh-current-sweep-marker-validated'
        && waterfall?.status === 'coherent-nondegenerate-render-input-validated'
        && typeof channel?.status === 'string'
        && [
          'validated-resolution-limited-narrow',
          'validated-resolved-wideband',
          'explicitly-unavailable-observation',
          'measured-sanity-validated',
        ].includes(channel.status)
        && iq?.status === 'nondegenerate-capture-and-scaling-validated'
        && iqFreshness?.status === 'fresh-current-profile-capture-validated';
    });
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
    automatedClaim: 'fresh-frame-dimensions-pixel-nondegeneracy-and-duplicate-content',
    status: 'manual-review-required',
  };
  const visualManifest = Array.isArray(visualContentReview.reviewScreenshotManifest)
    ? visualContentReview.reviewScreenshotManifest
    : [];
  const automatedScreenshotManifest = Array.isArray(
    visualContentReview.automatedScreenshotManifest,
  ) ? visualContentReview.automatedScreenshotManifest : [];
  const automatedScreenshotManifestValid = screenshotSet.complete
    && sameOrderedValues(
      automatedScreenshotManifest.map((entry) => entry?.path),
      screenshotSet.paths,
    )
    && screenshotManifestEntriesValid(automatedScreenshotManifest, run);
  const visualManifestValid = screenshotSet.complete
    && sameOrderedValues(
      visualManifest.map((entry) => entry?.path),
      screenshotSet.paths,
    )
    && screenshotManifestEntriesValid(visualManifest, run)
    && visualManifest.every((entry, index) => (
      sameScreenshotArtifactEvidence(automatedScreenshotManifest[index], entry)
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
          && releasePolicy.bound
          && completionWindowValid
          && (run.kind !== 'full-profile-exercise' || (
            classifierOracle.allProfileObservationsComplete
            && screenshotSet.complete
            && automatedScreenshotManifestValid
            && markerOracleGeometryComplete
            && fullScientificUiEvidenceComplete
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
    releasePolicy,
    geometry: {
      evidence: run.geometry ?? null,
      markerOracleGeometryComplete,
      defaultGeometryComplete,
    },
    fullScientificUiEvidenceComplete,
    visualContentReview,
    automatedScreenshotManifestValid,
    visualContentReviewComplete,
    automatedOk: automatedChecksOk,
    automatedChecksOk,
    ok: automatedChecksOk
      && (run.kind !== 'full-profile-exercise' || visualContentReviewComplete),
  };
}

function storedStoppedLayoutEvidenceComplete(layout) {
  return layout
    && layout.acquisitionLandmarkCount === 1
    && layout.acquisitionLandmarkPrecedesControls === true
    && layout.acquisitionLandmarkControlBinding === true
    && layout.globalSweepIdentity?.valid === true
    && layout.globalSweepIdentity?.evidenceCount === 1
    && layout.globalSweepIdentity?.controls === 'Run,Single'
    && layout.acquisitionCounts?.run === 1
    && layout.acquisitionCounts?.single === 1
    && layout.acquisitionCounts?.stop === 0
    && Array.isArray(layout.forbiddenNavigation)
    && layout.forbiddenNavigation.length === 0
    && Array.isArray(layout.localIqCaptureControls)
    && layout.localIqCaptureControls.length === 0
    && Array.isArray(layout.routeOrder)
    && sameOrderedValues(layout.routeOrder, SIGNAL_LAB_SIDEBAR_ROUTES)
    && SIGNAL_LAB_SIDEBAR_ROUTES.every((label) => layout.routeCounts?.[label] === 1);
}

function storedRunningLayoutEvidenceComplete(layout) {
  return layout
    && layout.acquisitionLandmarkCount === 1
    && layout.acquisitionLandmarkPrecedesControls === true
    && layout.acquisitionLandmarkControlBinding === true
    && layout.globalSweepIdentity?.valid === true
    && layout.globalSweepIdentity?.evidenceCount === 1
    && layout.globalSweepIdentity?.controls === 'Stop'
    && typeof layout.globalSweepIdentity?.sweepId === 'string'
    && Number.isSafeInteger(layout.globalSweepIdentity?.sequence)
    && layout.acquisitionCounts?.run === 0
    && layout.acquisitionCounts?.single === 0
    && layout.acquisitionCounts?.stop === 1
    && Array.isArray(layout.forbiddenNavigation)
    && layout.forbiddenNavigation.length === 0
    && Array.isArray(layout.localIqCaptureControls)
    && layout.localIqCaptureControls.length === 0
    && Array.isArray(layout.routeOrder)
    && sameOrderedValues(layout.routeOrder, SIGNAL_LAB_SIDEBAR_ROUTES)
    && SIGNAL_LAB_SIDEBAR_ROUTES.every((label) => layout.routeCounts?.[label] === 1);
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
