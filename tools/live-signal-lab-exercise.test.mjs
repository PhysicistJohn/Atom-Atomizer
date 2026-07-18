import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXPECTED_SIGNAL_LAB_PROFILE_COUNT,
  liveButtonIsEnabled,
  liveButtonExists,
  liveChannelSummary,
  liveDetectAcceptanceSummary,
  liveMarkerCharacterizationSummary,
  liveScreenshotDimensions,
  liveWorkspaceIsVisible,
  loadSignalLabLiveCatalog,
  screenshotArtifactExtension,
  signalLabLiveCoverageMatrix,
  validateLiveStressEvidence,
  validateRendererMemorySamples,
} from './live-signal-lab-exercise.mjs';

test('live SignalLab harness is closed over the complete built profile catalog', async () => {
  const catalog = await loadSignalLabLiveCatalog();
  const matrix = await signalLabLiveCoverageMatrix();

  assert.equal(catalog.length, EXPECTED_SIGNAL_LAB_PROFILE_COUNT);
  assert.equal(new Set(catalog.map(({ id }) => id)).size, EXPECTED_SIGNAL_LAB_PROFILE_COUNT);
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
  assert.equal(matrix.find(({ profileId }) => profileId === 'cw')?.markerWidthExpectation, 'resolution-limited-narrow');
  assert.equal(matrix.find(({ profileId }) => profileId === 'lte-etm3.1')?.markerWidthExpectation, 'resolved-wideband');
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
});

test('exact button matching does not confuse Peak with Peak tracking', () => {
  assert.equal(liveButtonIsEnabled('button Peak', 'Peak'), true);
  assert.equal(liveButtonIsEnabled('button Peak, Help: Move M1', 'Peak'), true);
  assert.equal(liveButtonIsEnabled('button Peak tracking Off', 'Peak'), false);
  assert.equal(liveButtonIsEnabled('button Peak (disabled)', 'Peak'), false);
});

test('I/Q local capture absence checks disabled and enabled controls', () => {
  assert.equal(liveButtonExists('12 button Capture I/Q', 'Capture I/Q'), true);
  assert.equal(liveButtonExists('12 button Capture I/Q (disabled)', 'Capture I/Q'), true);
  assert.equal(liveButtonExists('12 button Capture envelope', 'Capture I/Q'), false);
});

test('Detect acceptance binds Auto-most-prominent, its target, and no inner scroll', () => {
  const accepted = [
    '101 text Evidence',
    '102 text Detection',
    '103 toggle button Auto · most prominent (pressed)',
    '104 text integrated excess -22.4 dBm · 37 cells · AUTO TARGET',
  ].join('\n');
  assert.deepEqual(liveDetectAcceptanceSummary(accepted), {
    autoControl: 'toggle button Auto · most prominent (pressed)',
    autoControlPresent: true,
    autoControlPressed: true,
    autoTarget: 'text integrated excess -22.4 dBm · 37 cells · AUTO TARGET',
    autoTargetPresent: true,
    innerScrollElements: [],
    hasInnerScroll: false,
  });
  const scrolling = `${accepted}\n105 vertical scroll bar Evidence rows`;
  assert.equal(liveDetectAcceptanceSummary(scrolling).hasInnerScroll, true);
});

test('marker acceptance distinguishes narrow and resolved wideband evidence', () => {
  const common = [
    'section Marker M1 local characterization',
    'text 3 dB response width',
    'text 99% component occupied bandwidth',
  ];
  assert.deepEqual(liveMarkerCharacterizationSummary([
    ...common,
    'text Narrow · resolution limited',
  ].join('\n')), {
    widthClassification: 'resolution-limited-narrow',
    hasLocalCharacterization: true,
    hasThreeDecibelWidth: true,
    hasComponentOccupiedBandwidth: true,
  });
  assert.equal(liveMarkerCharacterizationSummary([
    ...common,
    'text Resolved local response · >2 resolution elements',
  ].join('\n')).widthClassification, 'resolved-wideband');
});

test('Computer Use screenshot size evidence reads PNG and JPEG headers exactly', () => {
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
});

test('bounded stress evidence rejects slow controls and missing sweep progression', () => {
  const evidence = {
    actionLatencies: [{ label: 'global Run', latencyMs: 100, ok: true }],
    accessibilitySnapshotLatencies: [{ latencyMs: 50 }],
    sweepProgressions: [
      { kind: 'single', fromSequence: 1, toSequence: 2 },
      { kind: 'continuous', sequences: [3, 4] },
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
});

test('externally supplied renderer memory validates hard and plateau bounds', () => {
  assert.equal(validateRendererMemorySamples([]).status, 'not-supplied');
  const mib = 1_024 * 1_024;
  const plateau = [400, 404, 402, 403, 410, 411, 409, 412].map((value) => value * mib);
  const result = validateRendererMemorySamples(plateau);
  assert.equal(result.status, 'plateau-and-hard-bound-validated');
  assert.equal(result.plateauGrowthBytes, 8 * mib);
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
    detail: '133 text 3 dB BANDWIDTH | 134 text Resolution-limited | 135 text Response 686 Hz · RBW/grid 489 Hz',
  });
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
