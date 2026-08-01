import { accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter as pathDelimiter, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  deriveSpectrumFromComplexIq,
  fitChannelConfigurationToSweep,
  measureChannel,
  SignalDetector,
  SignalTracker,
} from '@tinysa/analysis';
import { sweepExportSweepSchema } from '@tinysa/contracts';
import { InstrumentDriverRegistry, InstrumentManager } from '@tinysa/instrument-runtime';
import { createNeptuneIioTransport, NeptuneP210InstrumentDriver } from '@tinysa/neptune-p210';

const DEFAULT_ENDPOINT = 'ip:10.0.0.250';
const CAPTURE_CONFIGURATION = Object.freeze({
  kind: 'complex-iq',
  centerHz: 99_000_000,
  sampleRateHz: 10_000_000,
  bandwidthHz: 8_000_000,
  sampleCount: 4_096,
  sampleFormat: 'ci16le',
});
const STAGE_TIMEOUT_MS = Object.freeze({
  manualEndpoint: 15_000,
  discovery: 20_000,
  connect: 35_000,
  configure: 25_000,
  acquire: 15_000,
  deriveSpectrum: 10_000,
  acquireSecond: 15_000,
  deriveSecondSpectrum: 10_000,
  disconnect: 15_000,
});

class EphemeralRecentDeviceStore {
  #records = new Map();

  async record(entry) {
    this.#records.set(`${entry.sourceKind}\0${entry.endpoint}`, {
      ...entry,
      connectedAt: new Date().toISOString(),
    });
  }

  async list(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    return [...this.#records.values()].filter((record) => Date.parse(record.connectedAt) >= cutoff);
  }
}

const endpoint = process.argv[2] ?? DEFAULT_ENDPOINT;
const startedAt = new Date();
const startedAtMs = performance.now();
const timings = {};
const report = {
  status: 'FAIL',
  endpoint,
  startedAt: startedAt.toISOString(),
  execution: 'physical-receive-only',
  endpointBootstrap: 'manual-driver-api-with-ephemeral-recent-device-store',
  environmentEndpointRequired: false,
  configuration: CAPTURE_CONFIGURATION,
  timingsMs: timings,
};

let manager;
let primaryError;
let disconnectError;

try {
  if (process.argv.length > 3 || !/^ip:\S+$/.test(endpoint)) {
    throw new TypeError(`Usage: node tools/smoke-neptune-p210.mjs [ip:host] (received ${JSON.stringify(process.argv.slice(2))})`);
  }

  const toolPaths = {
    iioAttr: resolveExecutable('iio_attr'),
    iioReaddev: resolveExecutable('iio_readdev'),
  };
  report.libiioTools = toolPaths;

  const recentDevicesStore = new EphemeralRecentDeviceStore();
  const driver = new NeptuneP210InstrumentDriver({
    // The smoke deliberately does not consult NEPTUNE_P210_ENDPOINT. The
    // exact production manual-endpoint API below seeds discovery instead.
    env: {},
    recentDevicesStore,
    createTransport: () => createNeptuneIioTransport({
      iioAttrPath: toolPaths.iioAttr,
      iioReaddevPath: toolPaths.iioReaddev,
    }),
    // Directly re-probing the requested endpoint is the evidence under test.
    // Do not broaden a one-device smoke into an unrelated subnet scan.
    createScanTransport: () => ({
      scanNetwork: async () => [],
      dispose: async () => undefined,
    }),
  });
  manager = new InstrumentManager(new InstrumentDriverRegistry([driver]));

  const manualEndpoint = await timed(
    timings,
    'manualEndpoint',
    STAGE_TIMEOUT_MS.manualEndpoint,
    () => driver.addManualEndpoint('neptune-p210', endpoint),
  );
  if (!manualEndpoint.ok) throw new Error(`Manual endpoint admission failed: ${manualEndpoint.message}`);

  const discovery = await timed(
    timings,
    'discovery',
    STAGE_TIMEOUT_MS.discovery,
    () => manager.discover(),
  );
  const candidate = discovery.candidates.find((value) => (
    value.sourceKind === 'neptune-p210'
      && value.neptuneP210.endpoint === endpoint
  ));
  if (!candidate) {
    throw new Error(`Live discovery did not return ${endpoint}; failures: ${JSON.stringify(discovery.failures)}`);
  }
  report.discovery = {
    discoveredAt: discovery.discoveredAt,
    candidateId: candidate.candidateId,
    driverId: candidate.driverId,
    displayName: candidate.displayName,
    sourceKind: candidate.sourceKind,
    failures: discovery.failures,
  };

  const session = await timed(
    timings,
    'connect',
    STAGE_TIMEOUT_MS.connect,
    () => manager.connect(candidate),
  );
  const iqCapability = session.capabilities.acquisitions.find((value) => value.kind === 'complex-iq');
  if (!iqCapability || iqCapability.kind !== 'complex-iq') {
    throw new Error('Connected Neptune session did not advertise complex-I/Q acquisition');
  }
  if (session.provenance.sourceKind !== 'neptune-p210'
    || session.provenance.execution !== 'physical'
    || session.provenance.endpoint !== endpoint) {
    throw new Error(`Connected session provenance does not identify physical ${endpoint}`);
  }
  if (session.rfOutput !== 'not-supported') {
    throw new Error(`Receive-only Neptune unexpectedly reported RF output state ${session.rfOutput}`);
  }
  report.session = {
    sessionId: session.sessionId,
    driverId: session.driverId,
    candidateId: session.candidate.candidateId,
    provenance: session.provenance,
    rfOutput: session.rfOutput,
    rfOutputQualification: session.rfOutputQualification,
    complexIqCapability: iqCapability,
    optionalFeatures: session.capabilities.features,
  };

  const admittedConfiguration = await timed(
    timings,
    'configure',
    STAGE_TIMEOUT_MS.configure,
    () => manager.configure(CAPTURE_CONFIGURATION),
  );
  requireConfigurationMatch(admittedConfiguration.configuration, CAPTURE_CONFIGURATION, 'manager-admitted configuration');
  const configuredSnapshot = manager.snapshot();
  if (!configuredSnapshot?.configuration) throw new Error('Manager snapshot omitted the admitted configuration');
  requireConfigurationMatch(configuredSnapshot.configuration.configuration, CAPTURE_CONFIGURATION, 'session configuration snapshot');
  report.configurationEvidence = {
    revision: admittedConfiguration.configurationRevision,
    configuredAt: admittedConfiguration.configuredAt,
    admitted: admittedConfiguration.configuration,
    snapshot: configuredSnapshot.configuration.configuration,
  };

  const measurement = await timed(
    timings,
    'acquire',
    STAGE_TIMEOUT_MS.acquire,
    () => manager.acquire(),
  );
  if (measurement.kind !== 'complex-iq') {
    throw new Error(`Neptune returned ${measurement.kind} instead of complex-iq`);
  }
  const expectedBytes = CAPTURE_CONFIGURATION.sampleCount * 4;
  if (!measurement.complete
    || measurement.sampleCount !== CAPTURE_CONFIGURATION.sampleCount
    || measurement.samples.byteLength !== expectedBytes) {
    throw new Error(
      `Capture geometry mismatch: complete=${measurement.complete}, samples=${measurement.sampleCount}, bytes=${measurement.samples.byteLength}, expectedBytes=${expectedBytes}`,
    );
  }
  requireConfigurationMatch(measurement, CAPTURE_CONFIGURATION, 'measurement metadata');
  if (measurement.adcFullScaleCode !== 2_048
    || measurement.adcSignificantBits !== 12
    || measurement.powerReference !== 'uncalibrated-dbfs-relative') {
    throw new Error(
      `Capture scaling metadata mismatch: ${JSON.stringify({
        adcSignificantBits: measurement.adcSignificantBits,
        adcFullScaleCode: measurement.adcFullScaleCode,
        powerReference: measurement.powerReference,
      })}`,
    );
  }
  report.capture = {
    measurementId: measurement.measurementId,
    sequence: measurement.sequence,
    capturedAt: measurement.capturedAt,
    elapsedMilliseconds: measurement.elapsedMilliseconds,
    complete: measurement.complete,
    centerHz: measurement.centerHz,
    sampleRateHz: measurement.sampleRateHz,
    bandwidthHz: measurement.bandwidthHz,
    sampleFormat: measurement.sampleFormat,
    sampleCount: measurement.sampleCount,
    bytes: measurement.samples.byteLength,
    adcSignificantBits: measurement.adcSignificantBits,
    adcFullScaleCode: measurement.adcFullScaleCode,
    powerReference: measurement.powerReference,
  };

  const spectrum = await timed(
    timings,
    'deriveSpectrum',
    STAGE_TIMEOUT_MS.deriveSpectrum,
    () => Promise.resolve(deriveSpectrumFromComplexIq({
      samples: measurement.samples,
      sampleCount: measurement.sampleCount,
      sampleFormat: measurement.sampleFormat,
      centerHz: measurement.centerHz,
      sampleRateHz: measurement.sampleRateHz,
      adcFullScaleCode: measurement.adcFullScaleCode,
    })),
  );
  if (spectrum.frequencyHz.length !== spectrum.fftSize
    || spectrum.powerDbm.length !== spectrum.fftSize
    || spectrum.fftSize < 4
    || !Number.isFinite(spectrum.actualRbwHz)
    || spectrum.actualRbwHz <= 0) {
    throw new Error('Host spectrum projection returned invalid geometry');
  }
  let peakIndex = 0;
  for (let index = 0; index < spectrum.powerDbm.length; index += 1) {
    const frequencyHz = spectrum.frequencyHz[index];
    const power = spectrum.powerDbm[index];
    if (!Number.isFinite(frequencyHz) || !Number.isFinite(power)) {
      throw new Error(`Host spectrum projection contains a non-finite value at bin ${index}`);
    }
    if (power > spectrum.powerDbm[peakIndex]) peakIndex = index;
  }
  report.hostSpectrum = {
    evidence: '@tinysa/analysis deriveSpectrumFromComplexIq',
    fftSize: spectrum.fftSize,
    points: spectrum.frequencyHz.length,
    actualRbwHz: spectrum.actualRbwHz,
    peakFrequencyHz: spectrum.frequencyHz[peakIndex],
    peakRelativePowerDbfs: spectrum.powerDbm[peakIndex],
    powerReference: measurement.powerReference,
  };

  const detectionConfig = {
    threshold: { strategy: 'noise-relative', marginDb: 10 },
    minimumBandwidthHz: 0,
    minimumProminenceDb: 6,
    minimumConsecutiveSweeps: 2,
    releaseAfterMissedSweeps: 2,
  };
  const detector = new SignalDetector(detectionConfig);
  const tracker = new SignalTracker(detectionConfig);
  const firstSweep = projectHostSweep(measurement, spectrum, session);
  const firstCandidates = detector.analyze(firstSweep);
  const firstTracks = tracker.update(firstSweep, firstCandidates);

  const secondMeasurement = await timed(
    timings,
    'acquireSecond',
    STAGE_TIMEOUT_MS.acquireSecond,
    () => manager.acquire(),
  );
  requireComplexCaptureGeometry(secondMeasurement, CAPTURE_CONFIGURATION);
  const secondSpectrum = await timed(
    timings,
    'deriveSecondSpectrum',
    STAGE_TIMEOUT_MS.deriveSecondSpectrum,
    () => Promise.resolve(deriveSpectrumFromComplexIq({
      samples: secondMeasurement.samples,
      sampleCount: secondMeasurement.sampleCount,
      sampleFormat: secondMeasurement.sampleFormat,
      centerHz: secondMeasurement.centerHz,
      sampleRateHz: secondMeasurement.sampleRateHz,
      adcFullScaleCode: secondMeasurement.adcFullScaleCode,
    })),
  );
  const secondSweep = projectHostSweep(secondMeasurement, secondSpectrum, session);
  const secondCandidates = detector.analyze(secondSweep);
  const secondTracks = tracker.update(secondSweep, secondCandidates);
  if (firstCandidates.length === 0) {
    throw new Error('First physical Neptune spectrum produced no prominence-qualified detector candidates');
  }
  if (!secondTracks.some((track) => track.state === 'active' && track.missedSweeps === 0)) {
    throw new Error('Second physical Neptune spectrum did not promote any current detector track to active');
  }
  report.signalDetection = {
    evidence: '@tinysa/analysis SignalDetector + SignalTracker',
    persistenceGateSweeps: detectionConfig.minimumConsecutiveSweeps,
    firstLook: summarizeDetectionLook(firstCandidates, firstTracks),
    secondLook: summarizeDetectionLook(secondCandidates, secondTracks),
  };

  const channelSeed = {
    centerHz: CAPTURE_CONFIGURATION.centerHz,
    mainBandwidthHz: 200_000,
    adjacentBandwidthHz: 200_000,
    channelSpacingHz: 200_000,
    adjacentChannelCount: 2,
    occupiedPowerPercent: 99,
    obwNoiseCorrection: 'robust-floor',
  };
  const channelFit = fitChannelConfigurationToSweep(secondSweep, channelSeed);
  if (channelFit.status !== 'fitted') {
    throw new Error(`Physical Neptune spectrum could not fit a channel response: ${channelFit.reason}: ${channelFit.message}`);
  }
  const channelConfiguration = channelFit.configuration;
  const channelMeasurement = measureChannel(secondSweep, channelConfiguration);
  if (!Number.isFinite(channelMeasurement.carrier.powerDbm)) {
    throw new Error('Physical Neptune channel measurement did not produce finite carrier power');
  }
  if (channelMeasurement.threeDecibelBandwidth.status !== 'unavailable'
    && (!Number.isFinite(channelMeasurement.threeDecibelBandwidth.bandwidthHz)
      || channelMeasurement.threeDecibelBandwidth.bandwidthHz <= 0)) {
    throw new Error('Physical Neptune channel measurement produced invalid available 3 dB bandwidth evidence');
  }
  if (!Number.isFinite(channelMeasurement.occupiedBandwidth.bandwidthHz)
    || channelMeasurement.occupiedBandwidth.bandwidthHz <= 0
    || !Number.isFinite(channelMeasurement.occupiedBandwidth.occupiedPowerDbm)) {
    throw new Error('Physical Neptune channel measurement did not produce finite positive occupied-bandwidth evidence');
  }
  if (channelMeasurement.adjacent.length === 0
    || channelMeasurement.adjacent.some((entry) => !Number.isFinite(entry.relativeToCarrierDbc))) {
    throw new Error('Physical Neptune channel measurement did not produce finite adjacent-channel comparisons');
  }
  report.channelAnalysis = {
    evidence: '@tinysa/analysis fitChannelConfigurationToSweep + measureChannel',
    fit: channelFit,
    configuration: channelConfiguration,
    carrierRelativePowerDbfs: channelMeasurement.carrier.powerDbm,
    threeDecibelBandwidth: channelMeasurement.threeDecibelBandwidth,
    displayedSpanOccupiedBandwidth: channelMeasurement.occupiedBandwidth,
    adjacentComparisons: channelMeasurement.adjacent.map((entry) => ({
      side: entry.side,
      order: entry.order,
      relativeToCarrierDbc: entry.relativeToCarrierDbc,
    })),
  };

  report.status = 'PASS';
} catch (error) {
  primaryError = error;
  report.error = describeError(error);
} finally {
  if (manager) {
    try {
      await timed(
        timings,
        'disconnect',
        STAGE_TIMEOUT_MS.disconnect,
        () => manager.disconnect(),
      );
      report.disconnect = { status: 'PASS' };
    } catch (error) {
      disconnectError = error;
      report.disconnect = { status: 'FAIL', error: describeError(error) };
      report.status = 'FAIL';
    }
  } else {
    report.disconnect = { status: 'NOT-STARTED' };
  }
  timings.total = roundMilliseconds(performance.now() - startedAtMs);
  report.finishedAt = new Date().toISOString();
}

if (primaryError && disconnectError) {
  report.error = {
    name: 'AggregateError',
    message: 'Neptune smoke and disconnect both failed',
    errors: [describeError(primaryError), describeError(disconnectError)],
  };
}

console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exitCode = 1;

function resolveExecutable(name) {
  const candidateDirectories = [
    join(homedir(), '.local', 'bin'),
    join(homedir(), 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    ...(process.env.PATH ?? '').split(pathDelimiter),
  ];
  const searched = [];
  for (const directory of new Set(candidateDirectories.filter(Boolean))) {
    const candidate = join(directory, name);
    searched.push(candidate);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through the bounded, explicit search list.
    }
  }
  throw new Error(`${name} is not executable; searched ${searched.join(', ')}`);
}

function requireConfigurationMatch(actual, expected, label) {
  for (const key of ['kind', 'centerHz', 'sampleRateHz', 'bandwidthHz', 'sampleCount', 'sampleFormat']) {
    if (!Object.is(actual[key], expected[key])) {
      throw new Error(`${label} changed ${key}: expected ${JSON.stringify(expected[key])}, received ${JSON.stringify(actual[key])}`);
    }
  }
}

function requireComplexCaptureGeometry(measurement, expected) {
  if (measurement.kind !== 'complex-iq') {
    throw new Error(`Expected complex-iq measurement, received ${measurement.kind}`);
  }
  requireConfigurationMatch(measurement, expected, 'subsequent measurement');
  const expectedBytes = expected.sampleCount * 4;
  if (!measurement.complete
    || measurement.sampleCount !== expected.sampleCount
    || measurement.samples.byteLength !== expectedBytes) {
    throw new Error(`Subsequent capture geometry mismatch: complete=${measurement.complete}, samples=${measurement.sampleCount}, bytes=${measurement.samples.byteLength}`);
  }
}

function projectHostSweep(measurement, spectrum, session) {
  if (measurement.sessionId !== session.sessionId) {
    throw new Error(`Measurement session ${measurement.sessionId} does not match active session ${session.sessionId}`);
  }
  return sweepExportSweepSchema.parse({
    kind: 'spectrum',
    id: measurement.measurementId,
    sequence: measurement.sequence,
    capturedAt: measurement.capturedAt,
    elapsedMilliseconds: measurement.elapsedMilliseconds,
    frequencyHz: spectrum.frequencyHz,
    powerDbm: spectrum.powerDbm,
    powerReference: measurement.powerReference,
    requested: {
      kind: 'swept-spectrum',
      startHz: Math.round(spectrum.frequencyHz[0]),
      stopHz: Math.round(spectrum.frequencyHz.at(-1)),
      points: spectrum.fftSize,
      sweepTimeSeconds: measurement.sampleCount / measurement.sampleRateHz,
      controls: { schemaVersion: 1, model: 'host-derived-iq-projection', fftSize: spectrum.fftSize, window: 'hann-periodic' },
    },
    actualStartHz: spectrum.frequencyHz[0],
    actualStopHz: spectrum.frequencyHz.at(-1),
    actualRbwHz: spectrum.actualRbwHz,
    actualAttenuationDb: measurement.attenuationDb,
    resolutionBandwidthQualification: 'host-derived-fft-bin',
    attenuationQualification: measurement.attenuationDb === null ? 'not-applicable' : 'device-observed',
    source: 'host-derived-from-complex-iq',
    complete: true,
    identity: {
      kind: 'instrument-session',
      sessionId: session.sessionId,
      driverId: session.driverId,
      candidateId: session.candidate.candidateId,
      provenance: session.provenance,
    },
  });
}

function summarizeDetectionLook(candidates, tracks) {
  const current = tracks.filter((track) => track.state !== 'released' && track.missedSweeps === 0);
  return {
    candidates: candidates.length,
    candidateTracks: current.filter((track) => track.state === 'candidate').length,
    activeTracks: current.filter((track) => track.state === 'active').length,
    strongest: current[0] ? {
      state: current[0].state,
      peakHz: current[0].peakHz,
      peakRelativePowerDbfs: current[0].peakDbm,
      bandwidthHz: current[0].bandwidthHz,
      prominenceDb: current[0].prominenceDb,
      persistenceSweeps: current[0].persistenceSweeps,
    } : undefined,
  };
}

async function timed(target, label, timeoutMs, operation) {
  const stageStartedAt = performance.now();
  try {
    return await bounded(Promise.resolve().then(operation), timeoutMs, label);
  } finally {
    target[label] = roundMilliseconds(performance.now() - stageStartedAt);
  }
}

function bounded(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function roundMilliseconds(value) {
  return Math.round(value * 100) / 100;
}

function describeError(value, seen = new Set()) {
  if (!(value instanceof Error)) return { name: typeof value, message: String(value) };
  if (seen.has(value)) return { name: value.name, message: value.message, circular: true };
  seen.add(value);
  const description = {
    name: value.name,
    message: value.message,
    stack: value.stack,
  };
  for (const key of ['code', 'kind', 'details']) {
    if (key in value) description[key] = value[key];
  }
  if (value instanceof AggregateError) {
    description.errors = [...value.errors].map((error) => describeError(error, seen));
  }
  if (value.cause !== undefined) description.cause = describeError(value.cause, seen);
  return description;
}
