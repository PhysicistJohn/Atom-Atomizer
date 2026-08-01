import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter as pathDelimiter, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  deriveSpectrumFromComplexIq,
  fitChannelConfigurationToSweep,
  measureChannel,
  SignalDetector,
  SignalTracker,
} from '@tinysa/analysis';
import { sweepExportSweepSchema } from '@tinysa/contracts';
import { InstrumentDriverRegistry, InstrumentManager } from '@tinysa/instrument-runtime';
import {
  createNeptuneIioTransport,
  NEPTUNE_IIO_NAMES,
  NEPTUNE_P210_RX_LO_READBACK_TOLERANCE_HZ,
  NeptuneP210InstrumentDriver,
} from '@tinysa/neptune-p210';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const trioContract = JSON.parse(readFileSync(
  join(root, 'contracts', 'trio-composition-v7.json'),
  'utf8',
));
const neptuneEdge = trioContract.edges?.find(
  (edge) => edge.producer === 'neptune-p210' && edge.consumer === 'atomizer',
);
if (trioContract.contractVersion !== 7
  || trioContract.parties?.atomizer?.agentSurfaceVersion !== 11
  || neptuneEdge?.status !== 'active'
  || neptuneEdge.transport !== 'libiio-network-through-neptune-p210-driver') {
  throw new Error('Neptune smoke requires the active truthful trio composition v7 edge');
}

const DEFAULT_ENDPOINT = 'ip:10.0.0.250';
const CAPTURE_CONFIGURATION = Object.freeze({
  kind: 'complex-iq',
  centerHz: 80_000_000,
  sampleRateHz: 10_000_000,
  bandwidthHz: 8_000_000,
  sampleCount: 4_096,
  sampleFormat: 'ci16le',
});
const RETUNE_CONFIGURATION = Object.freeze({
  ...CAPTURE_CONFIGURATION,
  centerHz: 100_000_000,
});
const CANONICAL_CAPTURE_OPERATION_ID = 'capture';
const CANONICAL_CAPTURE_PARAMETERS = Object.freeze([
  ['capture.tune', 'centerHz'],
  ['capture.sample-rate', 'sampleRateHz'],
  ['capture.bandwidth', 'bandwidthHz'],
  ['capture.samples', 'sampleCount'],
]);
const STAGE_TIMEOUT_MS = Object.freeze({
  manualEndpoint: 15_000,
  discovery: 20_000,
  connect: 35_000,
  configure: 25_000,
  acquire: 15_000,
  deriveSpectrum: 10_000,
  acquireSecond: 15_000,
  configureRetune: 25_000,
  readbackRxLo: 10_000,
  acquireRetune: 15_000,
  deriveRetuneSpectrum: 10_000,
  acquireRetuneConfirmation: 15_000,
  deriveRetuneConfirmationSpectrum: 10_000,
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
  trioComposition: {
    contractVersion: trioContract.contractVersion,
    neptuneEdge: neptuneEdge.status,
  },
  configuration: CAPTURE_CONFIGURATION,
  timingsMs: timings,
};

let manager;
let directReadbackTransport;
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
  // This is intentionally a separate concrete `NeptuneIioTransport` from
  // the manager's private session transport. Its direct `iio_attr` RX-LO
  // readbacks are independent device evidence, not driver metadata.
  directReadbackTransport = createNeptuneIioTransport({
    iioAttrPath: toolPaths.iioAttr,
    iioReaddevPath: toolPaths.iioReaddev,
  });

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
    () => manager.addManualEndpoint(endpoint),
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
    () => configureCanonicalCapture(manager, session.sessionId, CAPTURE_CONFIGURATION),
  );
  requireConfigurationMatch(admittedConfiguration.configuration.configuration, CAPTURE_CONFIGURATION, 'manager-admitted configuration');
  const configuredSnapshot = manager.snapshot();
  if (!configuredSnapshot?.configuration) throw new Error('Manager snapshot omitted the admitted configuration');
  requireConfigurationMatch(configuredSnapshot.configuration.configuration, CAPTURE_CONFIGURATION, 'session configuration snapshot');
  report.configurationEvidence = {
    canonicalOperation: summarizeCanonicalCaptureOperation(admittedConfiguration.operation),
    revision: admittedConfiguration.configuration.configurationRevision,
    configuredAt: admittedConfiguration.configuration.configuredAt,
    admitted: admittedConfiguration.configuration.configuration,
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

  // Take a second 80 MHz capture so the later retune must advance past a
  // genuinely fresh pre-retune acquisition.  Do not require a broadcast
  // candidate here: 80 MHz is deliberately outside the expected FM region.
  const secondMeasurement = await timed(
    timings,
    'acquireSecond',
    STAGE_TIMEOUT_MS.acquireSecond,
    () => manager.acquire(),
  );
  requireComplexCaptureGeometry(secondMeasurement, CAPTURE_CONFIGURATION);
  // Prove a distinct manager reconfiguration reaches the physical RX LO and
  // yields a separately-derived I/Q spectrum at 100 MHz.
  const rxLoBeforeRetuneHz = await timed(
    timings,
    'readback80MHzBeforeRetune',
    STAGE_TIMEOUT_MS.readbackRxLo,
    () => readRxLo(directReadbackTransport, endpoint),
  );
  requireRxLoReadback(rxLoBeforeRetuneHz.numeric, CAPTURE_CONFIGURATION.centerHz, 'direct RX LO before 100 MHz retune');

  const admittedRetune = await timed(
    timings,
    'configureRetune',
    STAGE_TIMEOUT_MS.configureRetune,
    () => configureCanonicalCapture(manager, session.sessionId, RETUNE_CONFIGURATION),
  );
  requireConfigurationMatch(admittedRetune.configuration.configuration, RETUNE_CONFIGURATION, 'manager-admitted 100 MHz configuration');
  const retunedSnapshot = manager.snapshot();
  if (!retunedSnapshot?.configuration) throw new Error('Manager snapshot omitted the admitted 100 MHz configuration');
  requireConfigurationMatch(retunedSnapshot.configuration.configuration, RETUNE_CONFIGURATION, '100 MHz session configuration snapshot');

  const rxLoBeforeRetuneCaptureHz = await timed(
    timings,
    'readback100MHzBeforeCapture',
    STAGE_TIMEOUT_MS.readbackRxLo,
    () => readRxLo(directReadbackTransport, endpoint),
  );
  requireRxLoReadback(rxLoBeforeRetuneCaptureHz.numeric, RETUNE_CONFIGURATION.centerHz, 'direct RX LO before 100 MHz capture');

  const retunedMeasurement = await timed(
    timings,
    'acquireRetune',
    STAGE_TIMEOUT_MS.acquireRetune,
    () => manager.acquire(),
  );
  requireComplexCaptureGeometry(retunedMeasurement, RETUNE_CONFIGURATION);
  if (retunedMeasurement.sessionId !== session.sessionId) {
    throw new Error(`100 MHz measurement session ${retunedMeasurement.sessionId} does not match active session ${session.sessionId}`);
  }
  if (retunedMeasurement.configurationRevision !== admittedRetune.configuration.configurationRevision) {
    throw new Error(
      `100 MHz measurement configuration revision ${retunedMeasurement.configurationRevision} does not match admitted ${admittedRetune.configuration.configurationRevision}`,
    );
  }
  if (retunedMeasurement.sequence <= secondMeasurement.sequence) {
    throw new Error(`100 MHz measurement sequence ${retunedMeasurement.sequence} did not advance after 80 MHz sequence ${secondMeasurement.sequence}`);
  }

  const rxLoAfterRetuneCaptureHz = await timed(
    timings,
    'readback100MHzAfterCapture',
    STAGE_TIMEOUT_MS.readbackRxLo,
    () => readRxLo(directReadbackTransport, endpoint),
  );
  requireRxLoReadback(rxLoAfterRetuneCaptureHz.numeric, RETUNE_CONFIGURATION.centerHz, 'direct RX LO after 100 MHz capture');
  if (rxLoBeforeRetuneHz.numeric === rxLoAfterRetuneCaptureHz.numeric) {
    throw new Error(`Direct RX LO did not change across the requested 80 MHz -> 100 MHz retune (${rxLoAfterRetuneCaptureHz.numeric} Hz)`);
  }

  const retunedSpectrum = await timed(
    timings,
    'deriveRetuneSpectrum',
    STAGE_TIMEOUT_MS.deriveRetuneSpectrum,
    () => Promise.resolve(deriveSpectrumFromComplexIq({
      samples: retunedMeasurement.samples,
      sampleCount: retunedMeasurement.sampleCount,
      sampleFormat: retunedMeasurement.sampleFormat,
      centerHz: retunedMeasurement.centerHz,
      sampleRateHz: retunedMeasurement.sampleRateHz,
      adcFullScaleCode: retunedMeasurement.adcFullScaleCode,
    })),
  );

  // 100 MHz sits in the requested broadcast-FM region.  Take two independent
  // post-retune captures there so detection and channel analysis establish
  // actual on-air content instead of treating the 80 MHz transition band as a
  // failed broadcast scan.
  const detectionConfig = {
    threshold: { strategy: 'noise-relative', marginDb: 10 },
    minimumBandwidthHz: 0,
    minimumProminenceDb: 6,
    minimumConsecutiveSweeps: 2,
    releaseAfterMissedSweeps: 2,
  };
  const detector = new SignalDetector(detectionConfig);
  const tracker = new SignalTracker(detectionConfig);
  const firstRetunedSweep = projectHostSweep(retunedMeasurement, retunedSpectrum, session);
  const firstRetunedCandidates = detector.analyze(firstRetunedSweep);
  const firstRetunedTracks = tracker.update(firstRetunedSweep, firstRetunedCandidates);
  const retunedConfirmationMeasurement = await timed(
    timings,
    'acquireRetuneConfirmation',
    STAGE_TIMEOUT_MS.acquireRetuneConfirmation,
    () => manager.acquire(),
  );
  requireComplexCaptureGeometry(retunedConfirmationMeasurement, RETUNE_CONFIGURATION);
  if (retunedConfirmationMeasurement.sessionId !== session.sessionId) {
    throw new Error(`100 MHz confirmation measurement session ${retunedConfirmationMeasurement.sessionId} does not match active session ${session.sessionId}`);
  }
  if (retunedConfirmationMeasurement.configurationRevision !== admittedRetune.configuration.configurationRevision) {
    throw new Error(
      `100 MHz confirmation configuration revision ${retunedConfirmationMeasurement.configurationRevision} does not match admitted ${admittedRetune.configuration.configurationRevision}`,
    );
  }
  if (retunedConfirmationMeasurement.sequence <= retunedMeasurement.sequence) {
    throw new Error(`100 MHz confirmation sequence ${retunedConfirmationMeasurement.sequence} did not advance after retuned sequence ${retunedMeasurement.sequence}`);
  }
  const retunedConfirmationSpectrum = await timed(
    timings,
    'deriveRetuneConfirmationSpectrum',
    STAGE_TIMEOUT_MS.deriveRetuneConfirmationSpectrum,
    () => Promise.resolve(deriveSpectrumFromComplexIq({
      samples: retunedConfirmationMeasurement.samples,
      sampleCount: retunedConfirmationMeasurement.sampleCount,
      sampleFormat: retunedConfirmationMeasurement.sampleFormat,
      centerHz: retunedConfirmationMeasurement.centerHz,
      sampleRateHz: retunedConfirmationMeasurement.sampleRateHz,
      adcFullScaleCode: retunedConfirmationMeasurement.adcFullScaleCode,
    })),
  );
  const secondRetunedSweep = projectHostSweep(
    retunedConfirmationMeasurement,
    retunedConfirmationSpectrum,
    session,
  );
  const secondRetunedCandidates = detector.analyze(secondRetunedSweep);
  const secondRetunedTracks = tracker.update(secondRetunedSweep, secondRetunedCandidates);
  if (firstRetunedCandidates.length === 0) {
    throw new Error('First physical 100 MHz Neptune spectrum produced no prominence-qualified detector candidates');
  }
  if (!secondRetunedTracks.some((track) => track.state === 'active' && track.missedSweeps === 0)) {
    throw new Error('Second physical 100 MHz Neptune spectrum did not promote any current detector track to active');
  }
  report.signalDetection = {
    evidence: '@tinysa/analysis SignalDetector + SignalTracker at 100 MHz',
    persistenceGateSweeps: detectionConfig.minimumConsecutiveSweeps,
    firstLook: summarizeDetectionLook(firstRetunedCandidates, firstRetunedTracks),
    secondLook: summarizeDetectionLook(secondRetunedCandidates, secondRetunedTracks),
  };

  const channelSeed = {
    centerHz: RETUNE_CONFIGURATION.centerHz,
    mainBandwidthHz: 200_000,
    adjacentBandwidthHz: 200_000,
    channelSpacingHz: 200_000,
    adjacentChannelCount: 2,
    occupiedPowerPercent: 99,
    obwNoiseCorrection: 'robust-floor',
  };
  const channelFit = fitChannelConfigurationToSweep(secondRetunedSweep, channelSeed);
  if (channelFit.status !== 'fitted') {
    throw new Error(`Physical 100 MHz Neptune spectrum could not fit a channel response: ${channelFit.reason}: ${channelFit.message}`);
  }
  const channelConfiguration = channelFit.configuration;
  const channelMeasurement = measureChannel(secondRetunedSweep, channelConfiguration);
  if (!Number.isFinite(channelMeasurement.carrier.powerDbm)) {
    throw new Error('Physical 100 MHz Neptune channel measurement did not produce finite carrier power');
  }
  if (channelMeasurement.threeDecibelBandwidth.status !== 'unavailable'
    && (!Number.isFinite(channelMeasurement.threeDecibelBandwidth.bandwidthHz)
      || channelMeasurement.threeDecibelBandwidth.bandwidthHz <= 0)) {
    throw new Error('Physical 100 MHz Neptune channel measurement produced invalid available 3 dB bandwidth evidence');
  }
  if (!Number.isFinite(channelMeasurement.occupiedBandwidth.bandwidthHz)
    || channelMeasurement.occupiedBandwidth.bandwidthHz <= 0
    || !Number.isFinite(channelMeasurement.occupiedBandwidth.occupiedPowerDbm)) {
    throw new Error('Physical 100 MHz Neptune channel measurement did not produce finite positive occupied-bandwidth evidence');
  }
  if (channelMeasurement.adjacent.length === 0
    || channelMeasurement.adjacent.some((entry) => !Number.isFinite(entry.relativeToCarrierDbc))) {
    throw new Error('Physical 100 MHz Neptune channel measurement did not produce finite adjacent-channel comparisons');
  }
  report.channelAnalysis = {
    evidence: '@tinysa/analysis fitChannelConfigurationToSweep + measureChannel at 100 MHz',
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

  const initialIqSha256 = sha256Hex(measurement.samples);
  const retunedIqSha256 = sha256Hex(retunedMeasurement.samples);
  const initialSpectrumPowerSha256 = spectrumPowerSha256(spectrum);
  const retunedSpectrumPowerSha256 = spectrumPowerSha256(retunedSpectrum);
  const rawIqIdentical = initialIqSha256 === retunedIqSha256;
  const spectrumPowerIdentical = initialSpectrumPowerSha256 === retunedSpectrumPowerSha256;
  const exactCaptureIdentity = rawIqIdentical && spectrumPowerIdentical;
  report.retune100MHz = {
    configurationEvidence: {
      canonicalOperation: summarizeCanonicalCaptureOperation(admittedRetune.operation),
      revision: admittedRetune.configuration.configurationRevision,
      configuredAt: admittedRetune.configuration.configuredAt,
      admitted: admittedRetune.configuration.configuration,
      snapshot: retunedSnapshot.configuration.configuration,
    },
    directRxLoReadback: {
      transport: `NeptuneIioTransport.getDeviceAttribute(${NEPTUNE_IIO_NAMES.phyDevice}/${NEPTUNE_IIO_NAMES.loChannel}/${NEPTUNE_IIO_NAMES.attributes.centerFrequencyHz})`,
      toleranceHz: NEPTUNE_P210_RX_LO_READBACK_TOLERANCE_HZ,
      beforeRetune: rxLoBeforeRetuneHz,
      beforeCapture: rxLoBeforeRetuneCaptureHz,
      afterCapture: rxLoAfterRetuneCaptureHz,
    },
    capture: summarizeCapture(retunedMeasurement),
    spectrum: summarizeSpectrum(
      retunedSpectrum,
      retunedMeasurement.powerReference,
      retunedMeasurement.centerHz,
    ),
    comparison: {
      requestedDeltaHz: RETUNE_CONFIGURATION.centerHz - CAPTURE_CONFIGURATION.centerHz,
      observedDeltaHz: rxLoAfterRetuneCaptureHz.numeric - rxLoBeforeRetuneHz.numeric,
      initialIqSha256,
      retunedIqSha256,
      initialSpectrumPowerSha256,
      retunedSpectrumPowerSha256,
      rawIqIdentical,
      spectrumPowerIdentical,
      exactCaptureIdentity,
    },
  };
  // A verified RX-LO change is the hardware-tuning proof. This additional
  // conservative guard catches the separate regression where Atomizer
  // republishes the exact same capture at a new center: require BOTH the raw
  // I/Q and derived power spectrum to differ, rather than treating a changed
  // digest by itself as RF-content proof.
  if (exactCaptureIdentity) {
    throw new Error(
      '80 MHz and 100 MHz captures have identical raw-I/Q and spectrum-power SHA-256 digests despite verified RX LO readback change',
    );
  }

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

/**
 * Configure a bounded I/Q capture through the renderer-safe operation
 * contract. The smoke deliberately submits every value as Manual so it
 * cannot accidentally turn a harmless 4,096-sample validation capture into
 * a driver-selected long capture. Auto policy is exercised in unit tests;
 * this live path verifies generic-operation dispatch, driver admission, and
 * physical acquisition together.
 */
async function configureCanonicalCapture(manager, sessionId, configuration) {
  const surface = manager.canonicalSurface();
  if (!surface) throw new Error('Connected Neptune session did not publish a canonical operation surface');
  const operation = surface.operations.find((candidate) => candidate.id === CANONICAL_CAPTURE_OPERATION_ID);
  if (!operation || operation.availability !== 'available') {
    throw new Error('Connected Neptune session did not publish an available canonical capture operation');
  }
  if (operation.parameterIds.length !== CANONICAL_CAPTURE_PARAMETERS.length
    || operation.parameterIds.some((parameterId) => !CANONICAL_CAPTURE_PARAMETERS.some(([id]) => id === parameterId))) {
    throw new Error(`Canonical capture operation parameter shape changed: ${JSON.stringify(operation.parameterIds)}`);
  }
  const parameterValues = new Map(CANONICAL_CAPTURE_PARAMETERS.map(([parameterId, configurationKey]) => [
    parameterId,
    configuration[configurationKey],
  ]));
  const result = await manager.executeCanonicalOperation({
    sessionId,
    surfaceRevision: surface.revision,
    operationId: operation.id,
    parameters: operation.parameterIds.map((parameterId) => ({
      parameterId,
      intent: { mode: 'manual', value: parameterValues.get(parameterId) },
    })),
  });
  requireCanonicalCaptureOperation(result, sessionId, configuration);
  const snapshot = manager.snapshot();
  if (!snapshot?.configuration) throw new Error('Canonical capture operation did not admit a manager configuration');
  return { operation: result, configuration: snapshot.configuration };
}

function requireCanonicalCaptureOperation(result, sessionId, configuration) {
  if (result.sessionId !== sessionId || result.operationId !== CANONICAL_CAPTURE_OPERATION_ID) {
    throw new Error('Canonical capture result does not identify the active session and capture operation');
  }
  for (const [parameterId, configurationKey] of CANONICAL_CAPTURE_PARAMETERS) {
    const parameter = result.surface.parameters.find((candidate) => candidate.id === parameterId);
    const expected = configuration[configurationKey];
    if (!parameter
      || parameter.requested.mode !== 'manual'
      || parameter.requested.value !== expected
      || parameter.effectiveValue !== expected) {
      throw new Error(`Canonical capture result did not retain manual ${parameterId}=${expected}`);
    }
  }
}

function summarizeCanonicalCaptureOperation(result) {
  return {
    operationId: result.operationId,
    surfaceRevision: result.surface.revision,
    parameters: CANONICAL_CAPTURE_PARAMETERS.map(([parameterId]) => {
      const parameter = result.surface.parameters.find((candidate) => candidate.id === parameterId);
      return {
        parameterId,
        requested: parameter?.requested,
        effectiveValue: parameter?.effectiveValue,
        verification: parameter?.verification,
      };
    }),
  };
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

function requireRxLoReadback(observedHz, expectedHz, label) {
  const requestedHz = Math.round(expectedHz);
  if (!Number.isFinite(observedHz)
    || Math.abs(observedHz - requestedHz) > NEPTUNE_P210_RX_LO_READBACK_TOLERANCE_HZ) {
    throw new Error(
      `${label} was ${observedHz} Hz; expected ${requestedHz} Hz within ${NEPTUNE_P210_RX_LO_READBACK_TOLERANCE_HZ} Hz`,
    );
  }
}

async function readRxLo(transport, endpoint) {
  return transport.getDeviceAttribute(
    endpoint,
    NEPTUNE_IIO_NAMES.phyDevice,
    NEPTUNE_IIO_NAMES.loChannel,
    NEPTUNE_IIO_NAMES.attributes.centerFrequencyHz,
  );
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function summarizeCapture(measurement) {
  return {
    measurementId: measurement.measurementId,
    sequence: measurement.sequence,
    capturedAt: measurement.capturedAt,
    elapsedMilliseconds: measurement.elapsedMilliseconds,
    centerHz: measurement.centerHz,
    sampleRateHz: measurement.sampleRateHz,
    bandwidthHz: measurement.bandwidthHz,
    sampleFormat: measurement.sampleFormat,
    sampleCount: measurement.sampleCount,
    bytes: measurement.samples.byteLength,
    iqSha256: sha256Hex(measurement.samples),
  };
}

function summarizeSpectrum(spectrum, powerReference, centerHz) {
  if (spectrum.frequencyHz.length !== spectrum.fftSize
    || spectrum.powerDbm.length !== spectrum.fftSize
    || spectrum.fftSize < 4
    || !Number.isFinite(spectrum.actualRbwHz)
    || spectrum.actualRbwHz <= 0) {
    throw new Error('100 MHz host spectrum projection returned invalid geometry');
  }
  let peakIndex = 0;
  for (let index = 0; index < spectrum.powerDbm.length; index += 1) {
    const frequencyHz = spectrum.frequencyHz[index];
    const power = spectrum.powerDbm[index];
    if (!Number.isFinite(frequencyHz) || !Number.isFinite(power)) {
      throw new Error(`100 MHz host spectrum projection contains a non-finite value at bin ${index}`);
    }
    if (power > spectrum.powerDbm[peakIndex]) peakIndex = index;
  }
  return {
    evidence: '@tinysa/analysis deriveSpectrumFromComplexIq',
    fftSize: spectrum.fftSize,
    points: spectrum.frequencyHz.length,
    startFrequencyHz: spectrum.frequencyHz[0],
    stopFrequencyHz: spectrum.frequencyHz.at(-1),
    actualRbwHz: spectrum.actualRbwHz,
    peakFrequencyHz: spectrum.frequencyHz[peakIndex],
    peakOffsetHz: spectrum.frequencyHz[peakIndex] - centerHz,
    peakRelativePowerDbfs: spectrum.powerDbm[peakIndex],
    powerReference,
    powerDbfsSha256: spectrumPowerSha256(spectrum),
  };
}

function spectrumPowerSha256(spectrum) {
  const packedPowers = new Float64Array(spectrum.powerDbm);
  return createHash('sha256')
    .update(new Uint8Array(packedPowers.buffer, packedPowers.byteOffset, packedPowers.byteLength))
    .digest('hex');
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
