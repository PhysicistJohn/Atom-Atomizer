import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    peakMarkerAndLocalCharacterization: options.exerciseMarker,
    markerWidthExpectation: options.narrowMarkerProfileIds.includes(profile.id)
      ? 'resolution-limited-narrow'
      : options.wideMarkerProfileIds.includes(profile.id)
        ? 'resolved-wideband'
        : 'characterized',
    waterfall: options.exerciseWaterfall,
    channelAndThreeDecibelBandwidth: options.exerciseChannel,
    complexIqSingle: options.exerciseIq,
    noRedundantLocalIqCapture: options.exerciseIq && options.requireNoLocalIqCaptureButton,
    complexIqZoom: options.exerciseIq && options.iqZoomProfileIds.includes(profile.id),
    complexIqContinuous: options.exerciseIq && options.iqContinuousProfileIds.includes(profile.id),
    boundedControlLatencyAndSweepProgression: options.exerciseSingle
      && (options.exerciseContinuous || options.exerciseDetect),
    screenshotPolicy: options.screenshotPolicy,
  })));
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
      run.stress.rendererMemory = validateRendererMemorySamples(
        run.stress.rendererMemorySamples,
        context.options,
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
    summary: summarizeRun(run),
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
      run.stress.rendererMemory = validateRendererMemorySamples(
        run.stress.rendererMemorySamples,
        context.options,
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
    summary: summarizeRun(run),
    run,
  });
}

async function createContext(input, optionOverrides = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('Live exercise input is required');
  const sky = input.sky;
  if (!sky || typeof sky.get_app_state !== 'function' || typeof sky.click !== 'function') {
    throw new TypeError('Live exercise requires the Computer Use sky object');
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
    ['minimumContinuousSweepProgressions', options.minimumContinuousSweepProgressions],
    ['minimumScreenshotWidth', options.minimumScreenshotWidth],
    ['minimumScreenshotHeight', options.minimumScreenshotHeight],
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
  const rendererMemorySampler = input.sampleRendererMemory;
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

function createRunRecord(context, kind) {
  return {
    schemaVersion: LIVE_SIGNAL_LAB_EXERCISE_SCHEMA_VERSION,
    kind,
    app: context.app,
    startedAt: new Date().toISOString(),
    completedAt: null,
    options: context.options,
    catalog: context.catalog,
    profiles: [],
    failures: [],
    stress: context.stress,
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
  const completionLatencyMs = Date.now() - acquisitionStarted;
  context.stress.sweepProgressions.push({
    kind: 'single',
    profileId: profile.id,
    fromSequence: previousSweep,
    toSequence: sweep.sequence,
    completionLatencyMs,
  });
  const expectedStartHz = Math.round(profile.centerHz - profile.recommendedSpanHz / 2);
  const expectedStopHz = Math.round(profile.centerHz + profile.recommendedSpanHz / 2);
  const toleranceHz = Math.max(1, Math.round(profile.recommendedSpanHz / 1_000_000));
  if (!sweep.visibleRangeHz
    || Math.abs(sweep.visibleRangeHz.startHz - expectedStartHz) > toleranceHz
    || Math.abs(sweep.visibleRangeHz.stopHz - expectedStopHz) > toleranceHz) {
    throw new Error(
      `${profile.id} visible sweep range did not match its catalog-recommended ${expectedStartHz}-${expectedStopHz} Hz geometry`,
    );
  }
  return { state, sweep, completionLatencyMs };
}

async function exerciseContinuousDetection(context, state, profile) {
  state = await ensureStopped(context, state);
  state = await navigate(context, state, 'Spectrum');
  const previousSequence = spectrumSummary(state.text).sequence;
  const runStarted = Date.now();
  state = await clickElement(context, state, enabledButton('Run'), 'global Run');
  state = await waitForState(
    context,
    (candidate) => {
      const sequence = spectrumSummary(candidate.text).sequence;
      return hasButton(candidate.text, 'Stop')
        && sequence !== null
        && sequence !== previousSequence;
    },
    'continuous acquisition Stop control and first fresh sweep',
    context.options.acquisitionTimeoutMs,
  );
  const seenSequences = new Set([spectrumSummary(state.text).sequence]);
  while (seenSequences.size < context.options.minimumContinuousSweepProgressions) {
    state = await waitForState(
      context,
      (candidate) => {
        const sequence = spectrumSummary(candidate.text).sequence;
        return hasButton(candidate.text, 'Stop')
          && sequence !== null
          && !seenSequences.has(sequence);
      },
      `continuous sweep progression ${seenSequences.size + 1}`,
      context.options.acquisitionTimeoutMs,
    );
    seenSequences.add(spectrumSummary(state.text).sequence);
  }
  const sweepProgression = {
    kind: 'continuous',
    profileId: profile.id,
    fromSequence: previousSequence,
    sequences: [...seenSequences],
    elapsedMs: Date.now() - runStarted,
  };
  context.stress.sweepProgressions.push(sweepProgression);
  state = await navigate(context, state, 'Detect');
  let detectState;
  let stopLatencyMs = null;
  try {
    detectState = await waitForState(
      context,
      (candidate) => {
        const summary = detectionSummary(candidate.text);
        return hasSpectrum(candidate.text)
          && hasButton(candidate.text, 'Stop')
          && summary.active > 0
          && (!context.options.requireClassification || summary.classification !== null);
      },
      'active detection and Bayesian classification',
      context.options.classificationTimeoutMs,
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
          const acceptance = liveDetectAcceptanceSummary(candidate.text);
          const summary = detectionSummary(candidate.text);
          return acceptance.autoControlPresent
            && acceptance.autoTargetPresent
            && summary.active > 0
            && (!context.options.requireClassification || summary.classification !== null);
        },
        'Detect Auto-most-prominent rank-0 target selection',
        context.options.classificationTimeoutMs,
      );
    }
    assertNoFatalUi(detectState, 'continuous detection/classification');
    const detectAcceptance = liveDetectAcceptanceSummary(detectState.text);
    if (context.options.requireDetectAutoTarget
      && (!detectAcceptance.autoControlPresent || !detectAcceptance.autoTargetPresent)) {
      throw new Error('Detect did not expose Auto · most prominent with one visible AUTO TARGET');
    }
    if (context.options.requireDetectNoInnerScroll && detectAcceptance.hasInnerScroll) {
      throw new Error(
        `Detect exposed inner scrolling in the live accessibility snapshot: ${detectAcceptance.innerScrollElements.join(' | ')}`,
      );
    }
    const visual = await liveScreenshotEvidence(context, detectState, 'Detect');
    detectState = { ...detectState, liveAcceptance: { detectAcceptance, visual } };
  } finally {
    const current = detectState ?? await safeFreshState(context);
    if (current) {
      const stopStarted = Date.now();
      state = await ensureStopped(context, current);
      stopLatencyMs = Date.now() - stopStarted;
    }
  }
  return {
    state,
    detectState: detectState ?? state,
    detection: detectionSummary((detectState ?? state).text),
    detectAcceptance: detectState?.liveAcceptance?.detectAcceptance ?? null,
    visual: detectState?.liveAcceptance?.visual ?? null,
    sweepProgression,
    stopLatencyMs,
  };
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
  state = await clickElement(context, state, enabledButton('Peak'), 'marker Peak search');
  state = await waitForState(
    context,
    (candidate) => /M 1\s+·\s+NORMAL\s+[-−]?\d/.test(candidate.text)
      && candidate.text.includes('Marker M1 local characterization'),
    'visible M1 reading and local characterization',
    context.options.acquisitionTimeoutMs,
  );
  assertNoFatalUi(state, `peak marker ${profile.id}`);
  const marker = markerSummary(state.text);
  const characterization = liveMarkerCharacterizationSummary(state.text);
  if (!characterization.hasLocalCharacterization
    || !characterization.hasThreeDecibelWidth
    || !characterization.hasComponentOccupiedBandwidth) {
    throw new Error(`${profile.id} M1 omitted required local 3 dB/component-OBW characterization`);
  }
  const expectedWidthClassification = context.options.narrowMarkerProfileIds.includes(profile.id)
    ? 'resolution-limited-narrow'
    : context.options.wideMarkerProfileIds.includes(profile.id)
      ? 'resolved-wideband'
      : null;
  if (expectedWidthClassification !== null
    && characterization.widthClassification !== expectedWidthClassification) {
    throw new Error(
      `${profile.id} M1 width classification ${characterization.widthClassification} did not match required ${expectedWidthClassification}`,
    );
  }
  if (marker.frequencyHz !== null) {
    const halfSpan = profile.recommendedSpanHz / 2;
    if (marker.frequencyHz < profile.centerHz - halfSpan || marker.frequencyHz > profile.centerHz + halfSpan) {
      throw new Error(
        `M1 ${marker.frequencyHz} Hz is outside ${profile.id}'s recommended visible span`,
      );
    }
  }
  return { state, marker: { ...marker, ...characterization }, expectedWidthClassification };
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
  const autoTarget = bodies.find((body) => /\bAUTO TARGET\b/i.test(body)) ?? null;
  const innerScrollElements = bodies.filter((body) => (
    /^(?:scroll area|scroll bar|vertical scroll bar|horizontal scroll bar)\b/i.test(body)
  ));
  return {
    autoControl,
    autoControlPresent: autoControl !== null,
    autoControlPressed: autoControl !== null
      && /(?:\(pressed\)|Value:\s*(?:1|true)|Selected:\s*true)/i.test(autoControl),
    autoTarget,
    autoTargetPresent: autoTarget !== null,
    innerScrollElements,
    hasInnerScroll: innerScrollElements.length > 0,
  };
}

export function liveMarkerCharacterizationSummary(text) {
  const widthClassification = /Narrow\s+·\s+resolution limited/i.test(text)
    ? 'resolution-limited-narrow'
    : /Resolved local response\s+·\s+>2 resolution elements/i.test(text)
      ? 'resolved-wideband'
      : 'unavailable';
  return {
    widthClassification,
    hasLocalCharacterization: /Marker M1 local characterization/i.test(text),
    hasThreeDecibelWidth: /3\s+dB response width/i.test(text),
    hasComponentOccupiedBandwidth: /99% component occupied bandwidth/i.test(text),
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

function markerSummary(text) {
  const line = text.split('\n').map((entry) => entry.trim()).find((entry) => /text M 1\s+·\s+NORMAL\s+/.test(entry)) ?? null;
  const frequencyText = line ? /([-−]?\d+(?:\.\d+)?)\s*(Hz|kHz|MHz|GHz)\s*$/i.exec(line) : null;
  return {
    line,
    frequencyHz: frequencyText ? frequencyToHz(frequencyText[1], frequencyText[2]) : null,
    characterization: text.split('\n').map((entry) => entry.trim()).filter((entry) => (
      entry.includes('3 DB RESPONSE WIDTH')
      || entry.includes('99% COMPONENT OCCUPIED BANDWIDTH')
      || entry.includes('Resolved local response')
      || entry.includes('Resolution-limited')
    )),
  };
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
  return { extension, ...dimensions };
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
  run.summary = summarizeRun(run);
  const temporary = `${context.reportPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  await rename(temporary, context.reportPath);
}

function completeRun(run) {
  run.completedAt = new Date().toISOString();
  run.summary = summarizeRun(run);
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
    return {
      bytes: sample.bytes,
      source: requireNonEmptyString(sample.source ?? defaultSource, `renderer memory sample ${index} source`),
      checkpoint: requireNonEmptyString(sample.checkpoint ?? `external-${index + 1}`, `renderer memory sample ${index} checkpoint`),
      profileId: sample.profileId ?? null,
      capturedAt: sample.capturedAt ?? null,
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
    capturedAt: sample.capturedAt ?? new Date().toISOString(),
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
  requireSafeInteger(plateauWindow, 'rendererMemoryPlateauWindow');
  requireSafeInteger(maximumPlateauGrowthBytes, 'rendererMemoryMaximumPlateauGrowthBytes');
  requireSafeInteger(hardLimitBytes, 'rendererMemoryHardLimitBytes');
  if (normalized.length === 0) {
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
  if (normalized.length < plateauWindow * 2) {
    return {
      status: 'hard-bound-only-insufficient-plateau-samples',
      samples: normalized.length,
      maximumBytes,
      hardLimitBytes,
      requiredPlateauSamples: plateauWindow * 2,
    };
  }
  const openingMedianBytes = medianNumber(normalized.slice(0, plateauWindow).map(({ bytes }) => bytes));
  const closingMedianBytes = medianNumber(normalized.slice(-plateauWindow).map(({ bytes }) => bytes));
  const plateauGrowthBytes = closingMedianBytes - openingMedianBytes;
  if (plateauGrowthBytes > maximumPlateauGrowthBytes) {
    throw new Error(
      `Externally sampled renderer memory grew ${plateauGrowthBytes} bytes from opening to closing plateau; limit ${maximumPlateauGrowthBytes} bytes`,
    );
  }
  return {
    status: 'plateau-and-hard-bound-validated',
    samples: normalized.length,
    maximumBytes,
    hardLimitBytes,
    plateauWindow,
    openingMedianBytes,
    closingMedianBytes,
    plateauGrowthBytes,
    maximumPlateauGrowthBytes,
  };
}

export function validateLiveStressEvidence(evidence, options = {}) {
  if (!evidence || typeof evidence !== 'object') throw new TypeError('live stress evidence is required');
  const maximumControlResponseMs = options.maximumControlResponseMs
    ?? DEFAULT_OPTIONS.maximumControlResponseMs;
  const maximumAccessibilitySnapshotMs = options.maximumAccessibilitySnapshotMs
    ?? DEFAULT_OPTIONS.maximumAccessibilitySnapshotMs;
  const minimumContinuousSweepProgressions = options.minimumContinuousSweepProgressions
    ?? DEFAULT_OPTIONS.minimumContinuousSweepProgressions;
  requireSafeInteger(maximumControlResponseMs, 'maximumControlResponseMs');
  requireSafeInteger(maximumAccessibilitySnapshotMs, 'maximumAccessibilitySnapshotMs');
  requireSafeInteger(minimumContinuousSweepProgressions, 'minimumContinuousSweepProgressions');
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
  for (const progression of progressions) {
    if (progression.kind === 'continuous') {
      if (!Array.isArray(progression.sequences)
        || new Set(progression.sequences).size < minimumContinuousSweepProgressions
        || progression.sequences.some((sequence) => !Number.isSafeInteger(sequence))) {
        throw new Error('Continuous stress evidence lacks the required unique sweep progression');
      }
    } else if (!Number.isSafeInteger(progression.toSequence)
      || progression.toSequence === progression.fromSequence) {
      throw new Error(`${String(progression.kind)} stress evidence did not advance its sweep sequence`);
    }
  }
  return {
    status: 'control-latency-and-sweep-progression-validated',
    actions: actions.length,
    maximumActionLatencyMs: Math.max(...actions.map(({ latencyMs }) => latencyMs)),
    accessibilitySnapshots: snapshots.length,
    maximumAccessibilitySnapshotLatencyMs: Math.max(...snapshots.map(({ latencyMs }) => latencyMs)),
    sweepProgressions: progressions.length,
  };
}

function medianNumber(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function summarizeRun(run) {
  const passedProfiles = run.profiles.filter((profile) => profile.failures.length === 0).length;
  const completedSteps = run.profiles.flatMap((profile) => Object.values(profile.steps));
  const actionLatencies = run.stress?.actionLatencies ?? [];
  const snapshotLatencies = run.stress?.accessibilitySnapshotLatencies ?? [];
  return {
    kind: run.kind,
    expectedProfiles: run.catalog.length,
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
      rendererMemory: run.stress?.rendererMemory ?? {
        status: 'pending',
        samples: run.stress?.rendererMemorySamples.length ?? 0,
      },
    },
    ok: run.profiles.length === run.catalog.length && run.failures.length === 0,
  };
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
