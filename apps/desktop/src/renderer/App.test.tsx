// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SOURCE_QUALIFIED_ZS407_CUSTOM_RECEIVER_FIRMWARE_IDENTITIES,
  ZS407_CUSTOM_RECEIVER_SOURCE_COMMIT,
  type AnalyzerConfig,
  type AtomizerInstrumentEvent,
  type AtomizerInstrumentFeatureExecution,
  type AtomizerInstrumentState,
  type DetectedSignal,
  type InstrumentCandidate,
  type InstrumentConfiguration,
  type InstrumentMeasurement,
  type InstrumentSessionSnapshot,
  type Sweep,
} from '@tinysa/contracts';
import { classificationRepresentatives, SignalTracker } from '@tinysa/analysis';
import {
  App,
  agentSelectedClassificationId,
  coherentSweepCount,
  fitChannelConfigurationToSpan,
  parseStoredDetection,
  resolveClassificationTargetSelection,
  semanticControlRequiresCoordinates,
} from './AppShell.js';
import { agentControlBinding } from '@tinysa/agent';
import { ATOM_REALTIME_TOOL_CALL_LIMIT } from './atom-agent-retention.js';
import {
  DEFAULT_REPLAY_CHANNEL,
  suggestedAnalyzerRange,
  synthesizeSpectrum,
  waveformDescriptor,
} from '../../../../../Atom-SignalLab/src/waveforms.js';

const HASH = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const candidate: InstrumentCandidate = {
  schemaVersion: 1,
  driverId: 'tinysa',
  candidateId: 'twin:test',
  displayName: 'TinySA executable firmware twin',
  sourceKind: 'tinysa-firmware-twin',
  discoveryRevision: 'discovery-1',
  firmwareTwin: { bridge: 'renode-monitor-v1', repositoryCommit: COMMIT, firmwareBinarySha256: HASH, usbTransactionsModeled: false },
};
const ready: InstrumentSessionSnapshot = {
  sessionId: 'session-1',
  driverId: 'tinysa',
  candidate,
  provenance: {
    sourceKind: 'tinysa-firmware-twin', execution: 'firmware-executed-twin', transport: 'renode-monitor-bridge', qualification: 'firmware-executed-twin', verifiedAt: '2026-07-10T00:00:00.000Z',
    bridge: 'renode-monitor-v1', repositoryCommit: COMMIT, firmwareBinarySha256: HASH, usbTransactionsModeled: false,
    device: { model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'sim-1' },
  },
  capabilities: {
    schemaVersion: 1,
    acquisitions: [
      { kind: 'swept-spectrum', frequencyHz: { min: 0, max: 17_922_600_000 }, points: { min: 20, max: 450 }, sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.003, max: 60, step: 0.000_001 } }, controls: receiverSpectrumCapability(), powerUnit: 'dBm' },
      { kind: 'detected-power-timeseries', centerFrequencyHz: { min: 0, max: 17_922_600_000, step: 1 }, sampleCount: { min: 20, max: 450 }, sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.003, max: 60, step: 0.000_001 } }, controls: receiverDetectedPowerCapability(), powerUnit: 'dBm', timing: 'uniform' },
    ],
    features: [
      { kind: 'rf-generator', paths: [{ path: 'normal', frequencyHz: { min: 1, max: 6_300_000_000 } }, { path: 'mixer', frequencyHz: { min: 1, max: 17_922_600_000 } }], levelDbm: { min: -115, max: -18.5, step: 0.5 }, modulation: { off: true, am: { modulationFrequencyHz: { min: 1, max: 10_000 }, depthPercent: { min: 0, max: 100 } }, fm: { modulationFrequencyHz: { min: 1, max: 3_500 }, deviationHz: { min: 1_000, max: 300_000 } } } },
      { kind: 'screen', width: 480, height: 320, pixelFormat: 'rgb565le' },
      { kind: 'touch', width: 480, height: 320 },
      { kind: 'diagnostics', reports: ['identity', 'health', 'configuration'] },
    ],
  },
  rfOutput: 'off',
  rfOutputQualification: 'firmware-executed-twin',
};
const physicalCandidate: InstrumentCandidate = {
  schemaVersion: 1,
  driverId: 'tinysa',
  candidateId: 'serial:/dev/tty.usbmodem407',
  displayName: 'TinySA physical ZS407',
  sourceKind: 'serial-port',
  serialPort: { path: '/dev/tty.usbmodem407', vendorId: '0483', productId: '5740' },
  discoveryRevision: 'physical-discovery-1',
};
const physicalSession: InstrumentSessionSnapshot = {
  ...ready,
  sessionId: 'physical-session-1',
  candidate: physicalCandidate,
  provenance: {
    sourceKind: 'serial-port', execution: 'physical', transport: 'usb-cdc-acm', qualification: 'device-observed',
    verifiedAt: '2026-07-10T00:00:00.000Z',
    serialPort: physicalCandidate.serialPort,
    device: {
      model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'tinySA4_custom-test-gdeadbee',
      firmwareReportedRevision: 'deadbee', firmwareQualification: 'custom-unqualified',
      firmwareWarning: 'Custom firmware revision deadbee is admitted without source qualification.',
      usbIdentityVerified: true,
    },
  },
  rfOutput: 'off',
  rfOutputQualification: 'command-acknowledged',
};
const sourceQualifiedFirmwareVersion = 'tinySA4_hw-v0.3-fft1024-g43eb0f1' as const;
const sourceQualifiedFirmwareRecord = SOURCE_QUALIFIED_ZS407_CUSTOM_RECEIVER_FIRMWARE_IDENTITIES[
  sourceQualifiedFirmwareVersion
];
const sourceQualifiedPhysicalSession: InstrumentSessionSnapshot = {
  ...physicalSession,
  sessionId: 'physical-source-qualified-session-1',
  provenance: {
    sourceKind: 'serial-port', execution: 'physical', transport: 'usb-cdc-acm', qualification: 'device-observed',
    verifiedAt: '2026-07-10T00:00:00.000Z',
    serialPort: physicalCandidate.serialPort,
    device: {
      model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 max2871',
      firmwareVersion: sourceQualifiedFirmwareVersion,
      firmwareReportedRevision: sourceQualifiedFirmwareRecord.reportedRevision,
      firmwareSourceCommit: ZS407_CUSTOM_RECEIVER_SOURCE_COMMIT,
      firmwareQualification: 'custom-source-qualified-receive-only',
      firmwareWarning: sourceQualifiedFirmwareRecord.warning,
      usbIdentityVerified: true,
    },
  },
  capabilities: {
    schemaVersion: 1,
    acquisitions: physicalSession.capabilities.acquisitions.map((capability) => capability.kind === 'swept-spectrum'
      ? { ...capability, frequencyHz: { min: 0, max: 900_000_000, step: 1 }, points: { min: 20, max: 450, step: 1 } }
      : capability.kind === 'detected-power-timeseries'
        ? { ...capability, centerFrequencyHz: { min: 0, max: 900_000_000, step: 1 }, sampleCount: { min: 20, max: 450, step: 1 } }
        : capability),
    features: [],
  },
  rfOutput: 'not-supported',
  rfOutputQualification: 'not-applicable',
};
const signalLabCandidate: InstrumentCandidate = { schemaVersion: 1, driverId: 'signal-lab', candidateId: 'signal-lab:local', displayName: 'SignalLab', sourceKind: 'signal-lab', signalLab: { sourceId: 'local' }, discoveryRevision: 'signal-discovery-1' };
const signalLabProfiles = (['cw', 'fm'] as const).map((profileId) => {
  const descriptor = waveformDescriptor(profileId);
  return {
    profileId,
    label: descriptor.label,
    family: descriptor.family,
    model: descriptor.model,
    qualification: descriptor.qualification,
    centerFrequencyHz: descriptor.centerHz,
    occupiedBandwidthHz: descriptor.occupiedBandwidthHz,
    recommendedSpanHz: descriptor.recommendedSpanHz,
    projection: descriptor.projection,
    source: descriptor.source,
    disclosure: descriptor.disclosure,
    ...(descriptor.assetSha256 === undefined ? {} : { assetSha256: descriptor.assetSha256 }),
  };
});
const signalLabSession: InstrumentSessionSnapshot = {
  sessionId: 'signal-session', driverId: 'signal-lab', candidate: signalLabCandidate,
  provenance: { sourceKind: 'signal-lab', sourceId: 'local', execution: 'signal-lab-simulation', transport: 'signal-lab-measurement-bridge', qualification: 'synthetic-visual-projection', verifiedAt: '2026-07-10T00:00:00.000Z', producerConfigurationEpoch: 'producer-epoch:1', contractId: 'tinysa-signal-lab-atomizer-measurement', contractVersion: 1, contractSha256: HASH, catalogSha256: HASH, generatorSha256: HASH, claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false } },
  capabilities: { schemaVersion: 1, acquisitions: [{ kind: 'swept-spectrum', frequencyHz: { min: 0, max: 17_922_600_000 }, points: { min: 20, max: 450 }, sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } }, controls: syntheticScalarCapability(), powerUnit: 'dBm' }, { kind: 'detected-power-timeseries', centerFrequencyHz: { min: 1, max: 17_922_600_000, step: 1 }, sampleCount: { min: 20, max: 450 }, sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } }, controls: syntheticScalarCapability(), powerUnit: 'dBm', timing: 'uniform' }], features: [{ kind: 'signal-lab-profile-selection', profiles: signalLabProfiles, selectedProfileId: 'cw', channel: DEFAULT_REPLAY_CHANNEL }] },
  rfOutput: 'not-supported',
  rfOutputQualification: 'not-applicable',
};
const testComplexIqCapability = {
  kind: 'complex-iq' as const,
  centerFrequencyHz: { min: 1, max: 17_922_600_000, step: 1 },
  sampleRateHz: { min: 2_000_000, max: 2_000_000, step: 1 },
  bandwidthHz: { min: 1_000_000, max: 2_000_000, step: 1 },
  sampleCount: { min: 2, max: 2, step: 1 },
  sampleFormat: 'cf32le' as const,
};
const signalLabIqSession: InstrumentSessionSnapshot = {
  ...signalLabSession,
  capabilities: {
    ...signalLabSession.capabilities,
    acquisitions: [...signalLabSession.capabilities.acquisitions, testComplexIqCapability],
    features: signalLabSession.capabilities.features.map((feature) => feature.kind === 'signal-lab-profile-selection'
      ? { ...feature, iqProfileIds: signalLabProfiles.map(({ profileId }) => profileId) }
      : feature),
  },
};
const requested: AnalyzerConfig = { startHz: 88e6, stopHz: 108e6, points: 450, acquisitionFormat: 'raw', rbwKhz: 'auto', attenuationDb: 'auto', sweepTimeSeconds: 'auto', detector: 'sample', spurRejection: 'auto', lna: 'off', avoidSpurs: 'auto', trigger: { mode: 'auto' } };
function receiverSpectrumCapability() {
  return {
    schemaVersion: 1 as const, model: 'receiver' as const, acquisitionFormats: ['text', 'raw'] as const,
    resolutionBandwidthKhz: { automatic: true, manual: { min: 0.2, max: 850, step: 0.1 } },
    attenuationDb: { automatic: true, manual: { min: 0, max: 31, step: 1 } },
    detectors: ['sample', 'minimum-hold', 'maximum-hold', 'maximum-decay', 'average-4', 'average-16', 'average', 'quasi-peak'] as const,
    spurRejection: ['off', 'on', 'auto'] as const, lowNoiseAmplifier: ['off', 'on'] as const,
    avoidSpurs: ['off', 'on', 'auto'] as const, triggerModes: ['auto', 'normal', 'single'] as const,
    triggerLevelDbm: { min: -174, max: 30 },
  };
}
function receiverDetectedPowerCapability() {
  return {
    schemaVersion: 1 as const, model: 'receiver' as const,
    resolutionBandwidthKhz: { automatic: true, manual: { min: 0.2, max: 850, step: 0.1 } },
    attenuationDb: { automatic: true, manual: { min: 0, max: 31, step: 1 } },
    triggerModes: ['auto', 'normal', 'single'] as const, triggerLevelDbm: { min: -174, max: 30 },
  };
}
function syntheticScalarCapability() {
  return { schemaVersion: 1 as const, model: 'synthetic-scalar' as const, timingQualification: 'simulation-exact' as const };
}
function receiverSpectrumConfiguration(config: AnalyzerConfig): Extract<InstrumentConfiguration, { kind: 'swept-spectrum' }> {
  return {
    kind: 'swept-spectrum', startHz: config.startHz, stopHz: config.stopHz, points: config.points,
    sweepTimeSeconds: config.sweepTimeSeconds,
    controls: {
      schemaVersion: 1, model: 'receiver', acquisitionFormat: config.acquisitionFormat,
      resolutionBandwidthKhz: config.rbwKhz, attenuationDb: config.attenuationDb,
      detector: config.detector, spurRejection: config.spurRejection,
      lowNoiseAmplifier: config.lna, avoidSpurs: config.avoidSpurs, trigger: config.trigger,
    },
  };
}
const powers = Array.from({ length: 450 }, (_, index) => index === 225 ? -50 : -90);
const frequencies = Array.from({ length: 450 }, (_, index) => 88e6 + index * (20e6 / 449));
const legacyIdentity = { model: 'test', hardwareVersion: 'test', firmwareVersion: 'test', firmwareQualification: 'protocol-test', port: { id: 'test', path: 'test', usbMatch: 'protocol-test-double', transport: 'protocol-test-double', execution: 'protocol-test-double' }, simulated: true, usbIdentityVerified: false, execution: 'protocol-test-double' } as const;
const sweep: Sweep = { kind: 'spectrum', id: 's1', sequence: 1, capturedAt: '2026-07-10T00:00:00.000Z', elapsedMilliseconds: 42, frequencyHz: frequencies, powerDbm: powers, requested: receiverSpectrumConfiguration(requested), actualStartHz: frequencies[0]!, actualStopHz: frequencies.at(-1)!, actualRbwHz: 10_000, actualAttenuationDb: 0, source: 'scan-text', complete: true, identity: legacyIdentity };
let configuredAnalyzer = requested;
let activeConfiguration: InstrumentConfiguration = receiverSpectrumConfiguration(requested);
let configurationRevision = 'configuration-0';
let revisionSequence = 0;
let measurementSequence = 0;
let instrumentEventListener: ((event: AtomizerInstrumentEvent) => void) | undefined;
function acquiredMeasurement(config: AnalyzerConfig, id = 'runtime-sweep', revision = configurationRevision): Extract<InstrumentMeasurement, { kind: 'swept-spectrum' }> {
  const frequencyHz = Array.from({ length: config.points }, (_, index) => config.startHz + index * ((config.stopHz - config.startHz) / Math.max(1, config.points - 1)));
  return { schemaVersion: 1, kind: 'swept-spectrum', measurementId: id, sessionId: ready.sessionId, configurationRevision: revision, sequence: ++measurementSequence, capturedAt: '2026-07-10T00:00:00.000Z', elapsedMilliseconds: 42, resolutionBandwidthHz: 10_000, attenuationDb: 0, qualification: 'firmware-executed-twin', complete: true, frequencyHz, powerDbm: Array.from({ length: config.points }, (_, index) => index === Math.floor(config.points / 2) ? -50 : -90) };
}

function chronologicalAcquiredMeasurement(
  config: AnalyzerConfig,
  id: string,
  revision = configurationRevision,
): Extract<InstrumentMeasurement, { kind: 'swept-spectrum' }> {
  const measurement = acquiredMeasurement(config, id, revision);
  return {
    ...measurement,
    capturedAt: new Date(
      Date.parse('2026-07-10T00:00:00.000Z') + measurement.sequence * 1_000,
    ).toISOString(),
  };
}

function dualEmissionMeasurement(
  id: string,
  revision = configurationRevision,
): Extract<InstrumentMeasurement, { kind: 'swept-spectrum' }> {
  const measurement = acquiredMeasurement(configuredAnalyzer, id, revision);
  return {
    ...measurement,
    capturedAt: new Date(
      Date.parse('2026-07-10T00:00:00.000Z') + measurement.sequence * 1_000,
    ).toISOString(),
    powerDbm: measurement.powerDbm.map((_value, index) => {
      if (index === 100) return -24;
      if (index >= 300 && index <= 308) return -30;
      return -100;
    }),
  };
}

function detectedPowerMeasurement(config: Extract<InstrumentConfiguration, { kind: 'detected-power-timeseries' }>): Extract<InstrumentMeasurement, { kind: 'detected-power-timeseries' }> {
  return { schemaVersion: 1, kind: 'detected-power-timeseries', measurementId: 'zero-1', sessionId: ready.sessionId, configurationRevision, sequence: ++measurementSequence, capturedAt: '2026-07-10T00:00:01.000Z', elapsedMilliseconds: 50, resolutionBandwidthHz: 100_000, attenuationDb: 0, qualification: 'firmware-executed-twin', complete: true, centerHz: config.centerHz, sampleIntervalSeconds: config.sweepTimeSeconds / config.sampleCount, timingQualification: 'wall-clock-derived', powerDbm: Array(config.sampleCount).fill(-90) };
}

function complexIqMeasurement(
  config: Extract<InstrumentConfiguration, { kind: 'complex-iq' }>,
  revision: string,
  id: string,
  sessionId = signalLabIqSession.sessionId,
): Extract<InstrumentMeasurement, { kind: 'complex-iq' }> {
  return {
    schemaVersion: 1,
    kind: 'complex-iq',
    measurementId: id,
    sessionId,
    configurationRevision: revision,
    producerConfigurationEpoch: 'producer-epoch:1',
    sequence: ++measurementSequence,
    capturedAt: '2026-07-10T00:00:01.000Z',
    elapsedMilliseconds: 4,
    resolutionBandwidthHz: null,
    attenuationDb: null,
    qualification: 'analytic-complex-baseband',
    complete: true,
    centerHz: config.centerHz,
    sampleRateHz: config.sampleRateHz,
    bandwidthHz: config.bandwidthHz,
    sampleFormat: config.sampleFormat,
    sampleCount: config.sampleCount,
    samples: new Uint8Array(config.sampleCount * 8),
  };
}

function signalLabStreamingMeasurement(
  configuration: Extract<InstrumentConfiguration, { kind: 'swept-spectrum' }>,
  id: string,
  revision: string,
  producerConfigurationEpoch: string,
  peak: boolean,
): Extract<InstrumentMeasurement, { kind: 'swept-spectrum' }> {
  const sequence = ++measurementSequence;
  const frequencyHz = Array.from({ length: configuration.points }, (_value, index) =>
    configuration.startHz
      + (configuration.stopHz - configuration.startHz) * index / (configuration.points - 1));
  return {
    schemaVersion: 1,
    kind: 'swept-spectrum',
    measurementId: id,
    sessionId: signalLabSession.sessionId,
    configurationRevision: revision,
    producerConfigurationEpoch,
    sequence,
    capturedAt: new Date(Date.parse('2026-07-10T00:00:00.000Z') + sequence * 1_000).toISOString(),
    elapsedMilliseconds: 50,
    resolutionBandwidthHz: null,
    attenuationDb: null,
    qualification: 'synthetic-visual-projection',
    complete: true,
    frequencyHz,
    powerDbm: frequencyHz.map((_frequency, index) => peak && index === Math.floor(frequencyHz.length / 2) ? -45 : -110),
  };
}

/** Minimal but exact current-look authority for target-selection-only fixtures. */
function rankedSelectionDetection(
  id: string,
  peakDbm: number,
  overrides: Partial<DetectedSignal> = {},
): DetectedSignal {
  const peakHz = overrides.peakHz ?? 100;
  const startHz = overrides.startHz ?? peakHz;
  const stopHz = overrides.stopHz ?? peakHz;
  const capturedAt = overrides.lastSeenAt ?? '2026-07-10T00:00:00.000Z';
  const sourceSweepId = Array.isArray(overrides.sweepIds)
    ? overrides.sweepIds.at(-1) ?? `rank-source-${id}`
    : `rank-source-${id}`;
  const sourceSweep = {
    kind: 'spectrum',
    id: sourceSweepId,
    sequence: 1,
    capturedAt,
    frequencyHz: [peakHz - 1, peakHz, peakHz + 1],
    powerDbm: [-100, peakDbm, -100],
    actualStartHz: peakHz - 1.5,
    actualStopHz: peakHz + 1.5,
    actualRbwHz: 1,
    complete: true,
  } as unknown as Sweep;
  const observation = {
    sourceSweep,
    startHz,
    stopHz,
    peakHz,
    detectorId: 'selection-fixture-detector',
    localBayesianEvidence: {} as DetectedSignal['bayesianEvidence'],
  };
  return {
    id,
    startHz,
    stopHz,
    peakHz,
    peakDbm,
    noiseFloorDbm: -100,
    lastSeenAt: capturedAt,
    sweepIds: [sourceSweepId],
    detectorId: 'selection-fixture-detector',
    state: 'active',
    missedSweeps: 0,
    associationMode: 'frequency-local',
    classificationRegionObservation: observation,
    localClassificationObservations: [observation],
    ...overrides,
  } as DetectedSignal;
}

/** Bind a fabricated tracker row to the exact visible source look it claims. */
function rankedTrackerRow(
  base: DetectedSignal,
  sourceSweep: Sweep,
  id: string,
  peakDbm: number,
): DetectedSignal {
  const spacingHz = Math.max(1, sourceSweep.actualRbwHz);
  const rankSourceSweep = {
    ...sourceSweep,
    frequencyHz: [base.peakHz - spacingHz, base.peakHz, base.peakHz + spacingHz],
    powerDbm: [-100, peakDbm, -100],
  };
  const observation = {
    sourceSweep: rankSourceSweep,
    startHz: base.startHz,
    stopHz: base.stopHz,
    peakHz: base.peakHz,
    detectorId: base.detectorId,
    localBayesianEvidence: base.classificationRegionObservation?.localBayesianEvidence
      ?? base.bayesianEvidence,
  };
  return {
    ...base,
    id,
    peakDbm,
    noiseFloorDbm: -100,
    state: 'active',
    missedSweeps: 0,
    firstSeenAt: sourceSweep.capturedAt,
    lastSeenAt: sourceSweep.capturedAt,
    sweepIds: [sourceSweep.id],
    associationMode: 'frequency-local',
    classificationRegionStartHz: base.startHz,
    classificationRegionStopHz: base.stopHz,
    classificationRegionSweepIds: [sourceSweep.id],
    classificationRegionObservation: observation,
    localClassificationObservations: [observation],
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function persistOneLookDetector(): void {
  localStorage.setItem('atomizer:v2:detector', JSON.stringify({
    threshold: { strategy: 'absolute', levelDbm: -80 },
    minimumBandwidthHz: 0,
    minimumProminenceDb: 6,
    minimumConsecutiveSweeps: 1,
    releaseAfterMissedSweeps: 2,
  }));
}

function mockSignalLabCwSource(peakIndices: readonly number[] = [225]) {
  if (!peakIndices.length) throw new Error('SignalLab CW test source requires at least one peak index');
  vi.mocked(window.atomizerInstrument.getState).mockResolvedValue({
    schemaVersion: 1,
    startup: { status: 'connected', connectedAt: '2026-07-10T00:00:00.000Z' },
    streaming: { status: 'stopped' },
    connectionCleanup: { status: 'not-required' },
    preference: { source: 'factory-default', preference: { schemaVersion: 1, driverId: 'signal-lab', candidateKind: 'signal-lab', updatedAt: '2026-07-10T00:00:00.000Z' } },
    session: signalLabSession,
  });
  vi.mocked(window.atomizerInstrument.discover).mockResolvedValue({ discoveryRevision: 'signal-discovery-1', discoveredAt: '2026-07-10T00:00:00.000Z', candidates: [signalLabCandidate], failures: [] });
  vi.mocked(window.atomizerInstrument.configure).mockImplementation(async (configuration) => {
    activeConfiguration = structuredClone(configuration);
    configurationRevision = `configuration-${++revisionSequence}`;
    return { sessionId: signalLabSession.sessionId, configurationRevision, configuration, configuredAt: '2026-07-10T00:00:00.000Z' };
  });
  const expectedPeakHz: number[] = [];
  let acquisitionCount = 0;
  vi.mocked(window.atomizerInstrument.acquire).mockImplementation(async () => {
    const configuration = activeConfiguration;
    if (configuration.kind !== 'swept-spectrum') throw new Error('Expected SignalLab spectrum configuration');
    const frequencyHz = Array.from({ length: configuration.points }, (_value, index) => configuration.startHz + (configuration.stopHz - configuration.startHz) * index / (configuration.points - 1));
    const peakIndex = peakIndices[acquisitionCount % peakIndices.length]!;
    if (!Number.isInteger(peakIndex) || peakIndex < 0 || peakIndex >= frequencyHz.length) throw new Error('SignalLab CW test peak index is outside the sweep');
    acquisitionCount++;
    expectedPeakHz.push(frequencyHz[peakIndex]!);
    return {
      schemaVersion: 1, kind: 'swept-spectrum', measurementId: `signal-cw-marker-${acquisitionCount}`, sessionId: signalLabSession.sessionId,
      configurationRevision, producerConfigurationEpoch: 'producer-epoch:1', sequence: acquisitionCount,
      capturedAt: `2026-07-10T00:00:${String(acquisitionCount).padStart(2, '0')}.000Z`, elapsedMilliseconds: 50,
      resolutionBandwidthHz: null, attenuationDb: null, qualification: 'synthetic-visual-projection', complete: true,
      frequencyHz, powerDbm: frequencyHz.map((_frequency, index) => index === peakIndex ? -35 : -105),
    };
  });
  return { expectedPeakHz, acquisitionCount: () => acquisitionCount };
}

function mockSignalLabWidebandSource(profile: 'lte-etm3.1') {
  const descriptor = waveformDescriptor(profile);
  const range = suggestedAnalyzerRange(descriptor);
  vi.mocked(window.atomizerInstrument.getState).mockResolvedValue({
    schemaVersion: 1,
    startup: { status: 'connected', connectedAt: '2026-07-10T00:00:00.000Z' },
    streaming: { status: 'stopped' },
    connectionCleanup: { status: 'not-required' },
    preference: { source: 'factory-default', preference: { schemaVersion: 1, driverId: 'signal-lab', candidateKind: 'signal-lab', updatedAt: '2026-07-10T00:00:00.000Z' } },
    session: signalLabSession,
  });
  vi.mocked(window.atomizerInstrument.discover).mockResolvedValue({ discoveryRevision: 'signal-discovery-1', discoveredAt: '2026-07-10T00:00:00.000Z', candidates: [signalLabCandidate], failures: [] });
  vi.mocked(window.atomizerInstrument.configure).mockImplementation(async (configuration) => {
    activeConfiguration = structuredClone(configuration);
    configurationRevision = `configuration-${++revisionSequence}`;
    return { sessionId: signalLabSession.sessionId, configurationRevision, configuration, configuredAt: '2026-07-10T00:00:00.000Z' };
  });
  const rawPeakHz: number[] = [];
  vi.mocked(window.atomizerInstrument.acquire).mockImplementation(async () => {
    const configuration = activeConfiguration;
    if (configuration.kind !== 'swept-spectrum') throw new Error('Expected SignalLab spectrum configuration');
    const frequencyHz = Array.from({ length: configuration.points }, (_value, index) =>
      configuration.startHz + (configuration.stopHz - configuration.startHz) * index / (configuration.points - 1));
    const powerDbm = synthesizeSpectrum({
      profile,
      startHz: configuration.startHz,
      stopHz: configuration.stopHz,
      points: configuration.points,
      sweepIndex: 0,
      channel: DEFAULT_REPLAY_CHANNEL,
    });
    const peakIndex = powerDbm.reduce((best, value, index) => value > powerDbm[best]! ? index : best, 0);
    rawPeakHz.push(frequencyHz[peakIndex]!);
    return {
      schemaVersion: 1, kind: 'swept-spectrum', measurementId: 'signal-lte-tm31-marker-1', sessionId: signalLabSession.sessionId,
      configurationRevision, producerConfigurationEpoch: 'producer-epoch:1', sequence: 1,
      capturedAt: '2026-07-10T00:00:01.000Z', elapsedMilliseconds: 50,
      resolutionBandwidthHz: (configuration.stopHz - configuration.startHz) / (configuration.points - 1),
      attenuationDb: null, qualification: 'synthetic-visual-projection', complete: true,
      frequencyHz, powerDbm,
    };
  });
  return { descriptor, range, rawPeakHz };
}

function mockConnectedInstrument(session: InstrumentSessionSnapshot = ready): void {
  vi.mocked(window.atomizerInstrument.getState).mockResolvedValue({
    schemaVersion: 1,
    startup: { status: 'connected', connectedAt: '2026-07-10T00:00:00.000Z' },
    streaming: { status: 'stopped' },
    connectionCleanup: { status: 'not-required' },
    preference: { source: 'persisted', preference: { schemaVersion: 1, driverId: session.driverId, candidateKind: session.candidate.sourceKind, candidateId: session.candidate.candidateId, updatedAt: '2026-07-10T00:00:00.000Z' } },
    session,
  });
  vi.mocked(window.atomizerInstrument.discover).mockResolvedValue({
    discoveryRevision: session.candidate.discoveryRevision,
    discoveredAt: '2026-07-10T00:00:00.000Z',
    candidates: [session.candidate],
    failures: [],
  });
}

interface PendingIqBuffer {
  readonly capture: ReturnType<typeof deferred<InstrumentMeasurement>>;
  readonly configuration: Extract<InstrumentConfiguration, { kind: 'complex-iq' }>;
  readonly revision: string;
  readonly id: string;
}

function mockDeferredSignalLabIqBuffers(): PendingIqBuffer[] {
  mockConnectedInstrument(signalLabIqSession);
  const pending: PendingIqBuffer[] = [];
  vi.mocked(window.atomizerInstrument.configure).mockImplementation(async (configuration) => {
    activeConfiguration = structuredClone(configuration);
    configurationRevision = `configuration-${++revisionSequence}`;
    return {
      sessionId: signalLabIqSession.sessionId,
      configurationRevision,
      configuration,
      configuredAt: '2026-07-10T00:00:00.000Z',
    };
  });
  vi.mocked(window.atomizerInstrument.acquire).mockImplementation(() => {
    if (activeConfiguration.kind !== 'complex-iq') {
      return Promise.reject(new Error(`Expected complex-I/Q configuration, received ${activeConfiguration.kind}`));
    }
    const capture = deferred<InstrumentMeasurement>();
    pending.push({
      capture,
      configuration: structuredClone(activeConfiguration),
      revision: configurationRevision,
      id: `iq-buffer-${pending.length + 1}`,
    });
    return capture.promise;
  });
  return pending;
}

function emitInvalidatingFeatureExecution(
  execution: AtomizerInstrumentFeatureExecution,
  reason: Extract<AtomizerInstrumentEvent, { type: 'configuration-invalidated' }>['reason'],
): void {
  instrumentEventListener?.({ type: 'feature-result', ...execution });
  instrumentEventListener?.({
    type: 'configuration-invalidated',
    sessionId: execution.session.sessionId,
    reason,
    session: execution.session,
  });
}

function signalLabFeatureExecution(
  request: Extract<Parameters<typeof window.atomizerInstrument.executeFeature>[0], { kind: 'signal-lab-profile-selection' }>,
  session: InstrumentSessionSnapshot = signalLabSession,
  producerConfigurationEpoch = 'producer-epoch:2',
): AtomizerInstrumentFeatureExecution {
  if (session.provenance.sourceKind !== 'signal-lab') throw new Error('SignalLab execution fixture requires SignalLab provenance');
  const result = { sessionId: session.sessionId, ...request, producerConfigurationEpoch };
  return {
    result,
    session: {
      ...session,
      provenance: { ...session.provenance, producerConfigurationEpoch },
      capabilities: {
        ...session.capabilities,
        features: session.capabilities.features.map((feature) => feature.kind === 'signal-lab-profile-selection'
          ? request.action === 'select-profile'
            ? { ...feature, selectedProfileId: request.profileId }
            : { ...feature, channel: request.channel }
          : feature),
      },
    },
  };
}

afterEach(() => { cleanup(); localStorage.clear(); });

beforeEach(() => {
  configuredAnalyzer = structuredClone(requested);
  activeConfiguration = receiverSpectrumConfiguration(requested);
  configurationRevision = 'configuration-0';
  revisionSequence = 0;
  measurementSequence = 0;
  instrumentEventListener = undefined;
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fillStyle: '', strokeStyle: '', lineWidth: 1,
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  window.atomizerInstrument = {
    version: 1,
    getState: vi.fn().mockResolvedValue({ schemaVersion: 1, startup: { status: 'not-started' }, streaming: { status: 'stopped' }, connectionCleanup: { status: 'not-required' }, preference: { source: 'persisted', preference: { schemaVersion: 1, driverId: candidate.driverId, candidateKind: candidate.sourceKind, updatedAt: '2026-07-10T00:00:00.000Z' } } }),
    discover: vi.fn().mockResolvedValue({ discoveryRevision: 'discovery-1', discoveredAt: '2026-07-10T00:00:00.000Z', candidates: [candidate], failures: [] }),
    connect: vi.fn().mockResolvedValue(ready),
    disconnect: vi.fn().mockResolvedValue(undefined),
    configure: vi.fn().mockImplementation(async (configuration: InstrumentConfiguration) => {
      activeConfiguration = structuredClone(configuration);
      configurationRevision = `configuration-${++revisionSequence}`;
      if (configuration.kind === 'swept-spectrum' && configuration.controls.model === 'receiver') configuredAnalyzer = {
        startHz: configuration.startHz, stopHz: configuration.stopHz, points: configuration.points,
        acquisitionFormat: configuration.controls.acquisitionFormat,
        rbwKhz: configuration.controls.resolutionBandwidthKhz,
        attenuationDb: configuration.controls.attenuationDb,
        sweepTimeSeconds: configuration.sweepTimeSeconds,
        detector: configuration.controls.detector,
        spurRejection: configuration.controls.spurRejection,
        lna: configuration.controls.lowNoiseAmplifier,
        avoidSpurs: configuration.controls.avoidSpurs,
        trigger: configuration.controls.trigger,
      };
      return { sessionId: ready.sessionId, configurationRevision, configuration, configuredAt: '2026-07-10T00:00:00.000Z' };
    }),
    acquire: vi.fn().mockImplementation(async () => activeConfiguration.kind === 'swept-spectrum' ? acquiredMeasurement(configuredAnalyzer) : activeConfiguration.kind === 'detected-power-timeseries' ? detectedPowerMeasurement(activeConfiguration) : Promise.reject(new Error('I/Q not mocked'))),
    startStreaming: vi.fn().mockResolvedValue({ status: 'running', startedAt: '2026-07-10T00:00:00.000Z' }),
    stopStreaming: vi.fn().mockResolvedValue({ status: 'stopped' }),
    executeFeature: vi.fn().mockImplementation(async (request) => {
      if (request.kind === 'rf-generator') {
        const result = { sessionId: ready.sessionId, ...request };
        const rfOutput = request.action === 'configure' ? 'off' as const : request.enabled ? 'on' as const : 'off' as const;
        const execution = { result, session: { ...ready, rfOutput, rfOutputQualification: 'firmware-executed-twin' as const } };
        if (request.action === 'configure') emitInvalidatingFeatureExecution(execution, 'instrument-mode-changed');
        return execution;
      }
      if (request.kind === 'diagnostics') {
        const result = { sessionId: ready.sessionId, ...request, lines: ['ok'] };
        return { result, session: ready };
      }
      if (request.kind === 'signal-lab-profile-selection') {
        if (signalLabSession.provenance.sourceKind !== 'signal-lab') throw new Error('invalid SignalLab fixture');
        const producerConfigurationEpoch = 'producer-epoch:2';
        const result = { sessionId: signalLabSession.sessionId, ...request, producerConfigurationEpoch };
        const profileSession: InstrumentSessionSnapshot = {
          ...signalLabSession,
          provenance: { ...signalLabSession.provenance, producerConfigurationEpoch },
          capabilities: {
            ...signalLabSession.capabilities,
            features: signalLabSession.capabilities.features.map((feature) => feature.kind === 'signal-lab-profile-selection'
              ? request.action === 'select-profile'
                ? { ...feature, selectedProfileId: request.profileId }
                : { ...feature, channel: request.channel }
              : feature),
          },
        };
        const execution = { result, session: profileSession };
        emitInvalidatingFeatureExecution(
          execution,
          request.action === 'select-profile' ? 'source-profile-changed' : 'source-channel-changed',
        );
        return execution;
      }
      return Promise.reject(new Error(`Feature ${request.kind} not mocked`));
    }),
    readPreference: vi.fn().mockResolvedValue({ source: 'persisted', preference: { schemaVersion: 1, driverId: candidate.driverId, candidateKind: candidate.sourceKind, updatedAt: '2026-07-10T00:00:00.000Z' } }),
    writePreference: vi.fn().mockImplementation(async (selection) => ({ source: 'persisted', preference: { schemaVersion: 1, ...selection, updatedAt: '2026-07-10T00:00:00.000Z' } })),
    subscribe: vi.fn().mockImplementation((listener: (event: AtomizerInstrumentEvent) => void) => { instrumentEventListener = listener; return vi.fn(); }),
  };
  window.atomizerFiles = { version: 1, exportSweep: vi.fn().mockResolvedValue({ status: 'cancelled', format: 'csv' }) };
  window.atomAgent = {
    status: vi.fn().mockResolvedValue({ configured: false, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: false, realtime: false, textTransport: 'realtime-websocket' }),
    createRealtimeCall: vi.fn(), agentTurn: vi.fn(), computerScreenshot: vi.fn(), computerClick: vi.fn(), computerType: vi.fn(), computerKey: vi.fn(), computerScroll: vi.fn(),
  };
});

describe('operator vertical slice', () => {
  it('requires a coordinate-bearing path for direct spectrum marker placement', () => {
    expect(semanticControlRequiresCoordinates('spectrum.marker-place')).toBe(true);
  });

  it('fits stale channel geometry inside the active analyzer span', () => {
    const fitted = fitChannelConfigurationToSpan({
      centerHz: 98_000_000,
      mainBandwidthHz: 200_000,
      adjacentBandwidthHz: 200_000,
      channelSpacingHz: 200_000,
      adjacentChannelCount: 2,
      occupiedPowerPercent: 99,
      obwNoiseCorrection: 'none',
    }, 93_000_000, 95_000_000);
    const extent = fitted.adjacentChannelCount * fitted.channelSpacingHz + fitted.adjacentBandwidthHz / 2;
    expect(fitted.centerHz).toBe(94_000_000);
    expect(fitted.centerHz - extent).toBeGreaterThanOrEqual(93_000_000);
    expect(fitted.centerHz + extent).toBeLessThanOrEqual(95_000_000);
  });
  it('counts only waterfall sweeps on the current exact frequency grid', () => {
    const sameGrid = { ...sweep, id: 's2', sequence: 2 };
    const changedGrid = { ...sweep, id: 's3', sequence: 3, frequencyHz: sweep.frequencyHz.map((frequency) => frequency + 1) };
    expect(coherentSweepCount([sweep, sameGrid, changedGrid], 50)).toBe(2);
    expect(coherentSweepCount([sweep, sameGrid], 1)).toBe(1);
    expect(coherentSweepCount([], 50)).toBe(0);
  });
  it('migrates the pre-prominence detector preference deterministically', () => {
    expect(parseStoredDetection({
      threshold: { strategy: 'noise-relative', marginDb: 10 },
      minimumBandwidthHz: 0,
      minimumConsecutiveSweeps: 2,
      releaseAfterMissedSweeps: 2,
    })).toMatchObject({ minimumProminenceDb: 6 });
    expect(() => parseStoredDetection({ threshold: 'corrupt' })).toThrow();
  });

  it('quarantines a corrupt persisted preference and keeps reload startup usable', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    localStorage.setItem('atomizer:v2:analyzer', '{not-json');

    render(<App/>);

    expect(await screen.findByRole('navigation', { name: /Primary navigation/i })).toBeTruthy();
    expect(screen.queryByText(/Atomizer could not start/i)).toBeNull();
    await waitFor(() => expect(() => JSON.parse(localStorage.getItem('atomizer:v2:analyzer') ?? '')).not.toThrow());
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('quarantined invalid analyzer state'),
      expect.anything(),
    );
    warning.mockRestore();
  });

  it('does not let a superseded StrictMode initialization overwrite the live session', async () => {
    const first = deferred<AtomizerInstrumentState>();
    const second = deferred<AtomizerInstrumentState>();
    vi.mocked(window.atomizerInstrument.getState)
      .mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const connectedState: AtomizerInstrumentState = {
      schemaVersion: 1,
      startup: { status: 'connected', connectedAt: '2026-07-10T00:00:00.000Z' },
      streaming: { status: 'stopped' },
      connectionCleanup: { status: 'not-required' },
      session: ready,
    };

    render(<StrictMode><App/></StrictMode>);
    await waitFor(() => expect(window.atomizerInstrument.getState).toHaveBeenCalledTimes(2));
    await act(async () => { second.resolve(connectedState); });
    expect(await screen.findByText('tinySA Ultra+ ZS407')).toBeTruthy();

    await act(async () => {
      first.resolve({
        schemaVersion: 1,
        startup: { status: 'not-started' },
        streaming: { status: 'stopped' },
        connectionCleanup: { status: 'not-required' },
      });
      await Promise.resolve();
    });

    expect(screen.getByText('tinySA Ultra+ ZS407')).toBeTruthy();
    expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce();
  });

  it('classifies one representative per regular component association and honors a zero-span target', () => {
    const associated = (id: string, startHz: number): DetectedSignal => ({
      id,
      startHz,
      stopHz: startHz,
      associationMode: 'regular-spectral-component-activity',
      associationId: 'regular-1',
      associationRegionStartHz: 100,
      associationRegionStopHz: 300,
    } as DetectedSignal);
    const local = { id: 'local', associationMode: 'frequency-local' } as DetectedSignal;
    const signals = [associated('left', 100), associated('center', 200), associated('right', 300), local];

    expect(classificationRepresentatives(signals).map((signal) => signal.id)).toEqual(['local', 'center']);
    expect(classificationRepresentatives(signals, 'right').map((signal) => signal.id)).toEqual(['local', 'right']);
  });

  it('re-evaluates an autonomous classification target when a stronger detection arrives', () => {
    const weak = rankedSelectionDetection('weak', -60);
    const strong = rankedSelectionDetection('strong', -40);

    expect(resolveClassificationTargetSelection([weak])).toEqual({
      detectionId: 'weak',
      origin: 'automatic',
    });
    expect(resolveClassificationTargetSelection([weak, strong])).toEqual({
      detectionId: 'strong',
      origin: 'automatic',
    });
  });

  it('reports the receipt-owned classifier representative ahead of its raw agile tune owner', () => {
    expect(agentSelectedClassificationId({
      receiptProjectedRepresentativeId: 'agile-2g4-activity-0001',
      captureRawTargetId: 'signal-0008',
      currentSelectionId: 'signal-0002',
    })).toBe('agile-2g4-activity-0001');
    expect(agentSelectedClassificationId({
      captureRawTargetId: 'signal-0008',
      currentSelectionId: 'signal-0002',
    })).toBe('signal-0008');
  });

  it('keeps an explicit classification target sticky while it remains selectable', () => {
    const weak = rankedSelectionDetection('weak', -60);
    const strong = rankedSelectionDetection('strong', -40);

    expect(resolveClassificationTargetSelection([weak, strong], weak.id)).toEqual({
      detectionId: 'weak',
      origin: 'explicit',
      explicitDetectionId: 'weak',
    });
  });

  it('falls back to the autonomous target when tracker retention keeps a departed explicit row visible', () => {
    const current = rankedSelectionDetection('current', -45, {
      associationMode: 'regular-spectral-component-activity',
      associationId: 'regular-1',
      associationMemberTrackIds: ['current'],
      associationMissedSweeps: 0,
    });
    const departed = {
      ...current,
      id: 'departed',
      peakDbm: -35,
      associationMemberTrackIds: ['current'],
      missedSweeps: 1,
      associationMissedSweeps: 1,
    } as DetectedSignal;

    expect(resolveClassificationTargetSelection([departed, current], departed.id)).toEqual({
      detectionId: 'current',
      origin: 'automatic',
    });
  });

  it('ignores stronger candidate, stale, released, and frequency-agile evidence rows for Auto', () => {
    const current = rankedSelectionDetection('current', -55);
    const nonCurrentRows = [
      { id: 'candidate', peakDbm: -10, state: 'candidate', missedSweeps: 0, associationMode: 'frequency-local' },
      { id: 'stale', peakDbm: -9, state: 'active', missedSweeps: 1, associationMode: 'frequency-local' },
      { id: 'released', peakDbm: -8, state: 'released', missedSweeps: 0, associationMode: 'frequency-local' },
      { id: 'agile', peakDbm: -7, state: 'active', missedSweeps: 0, associationMode: 'frequency-agile-2g4-activity' },
    ] as DetectedSignal[];

    for (const nonCurrent of nonCurrentRows) {
      expect(resolveClassificationTargetSelection([current, nonCurrent])).toEqual({
        detectionId: 'current',
        origin: 'automatic',
      });
      expect(resolveClassificationTargetSelection([current, nonCurrent], nonCurrent.id)).toEqual({
        detectionId: 'current',
        origin: 'automatic',
      });
    }
  });

  it('renders an already-started SignalLab default without fabricating hardware identity and can select its profile', async () => {
    const admissionLog = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
    vi.mocked(window.atomizerInstrument.getState).mockResolvedValue({ schemaVersion: 1, startup: { status: 'connected', connectedAt: '2026-07-10T00:00:00.000Z' }, streaming: { status: 'stopped' }, connectionCleanup: { status: 'not-required' }, preference: { source: 'factory-default', preference: { schemaVersion: 1, driverId: 'signal-lab', candidateKind: 'signal-lab', updatedAt: '2026-07-10T00:00:00.000Z' } }, session: signalLabSession });
    vi.mocked(window.atomizerInstrument.discover).mockResolvedValue({ discoveryRevision: 'signal-discovery-1', discoveredAt: '2026-07-10T00:00:00.000Z', candidates: [signalLabCandidate], failures: [] });
    vi.mocked(window.atomizerInstrument.configure).mockImplementation(async (configuration) => {
      activeConfiguration = structuredClone(configuration);
      configurationRevision = `configuration-${++revisionSequence}`;
      return { sessionId: signalLabSession.sessionId, configurationRevision, configuration, configuredAt: '2026-07-10T00:00:00.000Z' };
    });
    vi.mocked(window.atomizerInstrument.acquire).mockImplementation(async () => {
      const configuration = activeConfiguration;
      if (configuration.kind !== 'swept-spectrum') throw new Error('Expected SignalLab spectrum configuration');
      const frequencyHz = Array.from({ length: configuration.points }, (_value, index) => configuration.startHz + (configuration.stopHz - configuration.startHz) * index / (configuration.points - 1));
      return {
        schemaVersion: 1, kind: 'swept-spectrum', measurementId: 'signal-live-1', sessionId: signalLabSession.sessionId,
        configurationRevision, producerConfigurationEpoch: 'producer-epoch:2', sequence: 1,
        capturedAt: '2026-07-10T00:00:01.000Z', elapsedMilliseconds: 50,
        resolutionBandwidthHz: null, attenuationDb: null, qualification: 'synthetic-visual-projection', complete: true,
        frequencyHz, powerDbm: frequencyHz.map((_frequency, index) => index === 225 ? -50 : -100),
      };
    });
    render(<App/>);
    expect(await screen.findByText('SIGNALLAB SIMULATION')).toBeTruthy();
    const admissionMessage = admissionLog.mock.calls
      .map(([message]) => message)
      .find((message): message is string => typeof message === 'string'
        && message.startsWith('[ATOMIZER-SIGNAL-LAB-SESSION] '));
    expect(admissionMessage).toBeTruthy();
    const admission = JSON.parse(admissionMessage!.slice('[ATOMIZER-SIGNAL-LAB-SESSION] '.length));
    expect(admission).toEqual({
      schemaVersion: 1,
      event: 'admitted',
      sessionId: signalLabSession.sessionId,
      driverId: 'signal-lab',
      provenance: {
        sourceKind: 'signal-lab',
        sourceId: 'local',
        execution: 'signal-lab-simulation',
        transport: 'signal-lab-measurement-bridge',
        qualification: 'synthetic-visual-projection',
        contractId: 'tinysa-signal-lab-atomizer-measurement',
        contractVersion: 1,
        contractSha256: HASH,
        catalogSha256: HASH,
        generatorSha256: HASH,
        claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
      },
    });
    expect(admissionMessage).not.toMatch(/capabilities|candidate|device|serial/i);
    expect(screen.getByRole('button', { name: /SignalLab.*Synthetic measurement bridge/i })).toBeTruthy();
    const navigation = screen.getByRole('navigation', { name: /Primary navigation/i });
    expect(within(navigation).getByRole('button', { name: /Generate/i }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(within(navigation).getByRole('button', { name: /Generate/i }));
    expect(await screen.findByRole('navigation', { name: /Waveform families/i })).toBeTruthy();
    const profile = screen.getByRole('button', { name: /^FM/i });
    expect(profile.closest('[data-agent-exclusion="human-signal-profile-boundary"]')).toBeTruthy();
    expect(profile.closest('[data-agent-control]')).toBeNull();
    fireEvent.click(profile);
    await waitFor(() => expect(window.atomizerInstrument.executeFeature).toHaveBeenCalledWith({ kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: 'fm' }));
    fireEvent.click(screen.getByRole('button', { name: /^Rayleigh$/i }));
    await waitFor(() => expect(window.atomizerInstrument.executeFeature).toHaveBeenCalledWith({
      kind: 'signal-lab-profile-selection', action: 'configure-channel',
      channel: { ...DEFAULT_REPLAY_CHANNEL, model: 'rayleigh' },
    }));
    fireEvent.click(within(navigation).getByRole('button', { name: /Spectrum/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Single$/i }));
    const selectedFm = signalLabProfiles.find(({ profileId }) => profileId === 'fm')!;
    const admitted = {
      kind: 'swept-spectrum' as const,
      startHz: selectedFm.centerFrequencyHz - selectedFm.recommendedSpanHz / 2,
      stopHz: selectedFm.centerFrequencyHz + selectedFm.recommendedSpanHz / 2,
      points: 450, sweepTimeSeconds: 0.05,
      controls: { schemaVersion: 1 as const, model: 'synthetic-scalar' as const, timingQualification: 'simulation-exact' as const },
    };
    await waitFor(() => expect(window.atomizerInstrument.configure).toHaveBeenLastCalledWith(admitted));
    await waitFor(() => expect(window.atomizerInstrument.acquire).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    await waitFor(() => expect(window.atomizerFiles.exportSweep).toHaveBeenCalledWith({
      format: 'json', sweep: expect.objectContaining({ requested: admitted }),
    }));
    } finally {
      admissionLog.mockRestore();
    }
  });

  it('routes sidebar Single to one bounded I/Q capture without a redundant panel action', async () => {
    mockConnectedInstrument(signalLabIqSession);
    vi.mocked(window.atomizerInstrument.configure).mockImplementation(async (configuration) => {
      activeConfiguration = structuredClone(configuration);
      configurationRevision = `configuration-${++revisionSequence}`;
      return { sessionId: signalLabIqSession.sessionId, configurationRevision, configuration, configuredAt: '2026-07-10T00:00:00.000Z' };
    });
    vi.mocked(window.atomizerInstrument.acquire).mockImplementation(async () => {
      if (activeConfiguration.kind !== 'complex-iq') throw new Error(`Expected complex-I/Q configuration, received ${activeConfiguration.kind}`);
      return complexIqMeasurement(activeConfiguration, configurationRevision, 'iq-single-1');
    });

    render(<App/>);
    const navigation = await screen.findByRole('navigation', { name: /Primary navigation/i });
    await screen.findByText('SIGNALLAB SIMULATION');
    fireEvent.click(within(navigation).getByRole('button', { name: /^I\/Q$/i }));
    expect(screen.queryByRole('button', { name: /Capture I\/Q/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Single$/i }));

    await waitFor(() => expect(window.atomizerInstrument.configure).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'complex-iq' })));
    await waitFor(() => expect(window.atomizerInstrument.acquire).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Capture iq-single-1/i)).toBeTruthy();
    expect(window.atomizerInstrument.startStreaming).not.toHaveBeenCalled();
  });

  it('runs one backpressured I/Q buffer at a time, stages live edits, and stops after the in-flight buffer', async () => {
    mockConnectedInstrument(signalLabIqSession);
    const pending: Array<{
      readonly capture: ReturnType<typeof deferred<InstrumentMeasurement>>;
      readonly configuration: Extract<InstrumentConfiguration, { kind: 'complex-iq' }>;
      readonly revision: string;
      readonly id: string;
    }> = [];
    vi.mocked(window.atomizerInstrument.configure).mockImplementation(async (configuration) => {
      activeConfiguration = structuredClone(configuration);
      configurationRevision = `configuration-${++revisionSequence}`;
      return { sessionId: signalLabIqSession.sessionId, configurationRevision, configuration, configuredAt: '2026-07-10T00:00:00.000Z' };
    });
    vi.mocked(window.atomizerInstrument.acquire).mockImplementation(() => {
      if (activeConfiguration.kind !== 'complex-iq') return Promise.reject(new Error(`Expected complex-I/Q configuration, received ${activeConfiguration.kind}`));
      const capture = deferred<InstrumentMeasurement>();
      pending.push({
        capture,
        configuration: structuredClone(activeConfiguration),
        revision: configurationRevision,
        id: `iq-buffer-${pending.length + 1}`,
      });
      return capture.promise;
    });

    render(<App/>);
    const navigation = await screen.findByRole('navigation', { name: /Primary navigation/i });
    await screen.findByText('SIGNALLAB SIMULATION');
    fireEvent.click(within(navigation).getByRole('button', { name: /^I\/Q$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(window.atomizerInstrument.acquire).toHaveBeenCalledOnce();
    expect(window.atomizerInstrument.startStreaming).not.toHaveBeenCalled();
    expect(screen.getByText(/Running I\/Q/i)).toBeTruthy();

    const editCenter = screen.getByLabelText('Edit Center frequency');
    expect(editCenter.hasAttribute('disabled')).toBe(false);
    fireEvent.click(editCenter);
    const editor = screen.getByRole('dialog', { name: /Center frequency numeric entry/i });
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Center frequency' }), { target: { value: '101' } });
    fireEvent.click(within(editor).getByRole('button', { name: /^Apply MHz$/i }));

    await act(async () => {
      const first = pending[0]!;
      first.capture.resolve(complexIqMeasurement(first.configuration, first.revision, first.id));
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1]?.configuration.centerHz).toBe(101_000_000);
    expect(document.body.textContent).not.toContain('iq-buffer-1');
    expect(window.atomizerInstrument.acquire).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: /^Stop$/i }));
    expect(screen.getByRole('button', { name: /Stopping/i }).hasAttribute('disabled')).toBe(true);
    await act(async () => {
      const second = pending[1]!;
      second.capture.resolve(complexIqMeasurement(second.configuration, second.revision, second.id));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Run$/i })).toBeTruthy());
    await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 5)); });
    expect(window.atomizerInstrument.acquire).toHaveBeenCalledTimes(2);
    expect(window.atomizerInstrument.stopStreaming).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('iq-buffer-2');
  });

  it('retargets an I/Q Run to a live spectrum stream when the operator leaves the I/Q workspace', async () => {
    const pending = mockDeferredSignalLabIqBuffers();

    render(<App/>);
    const navigation = await screen.findByRole('navigation', { name: /Primary navigation/i });
    await screen.findByText('SIGNALLAB SIMULATION');
    fireEvent.click(within(navigation).getByRole('button', { name: /^I\/Q$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(screen.getByText(/Running I\/Q/i)).toBeTruthy();

    // Run follows the operator: leaving I/Q drains the in-flight bounded
    // buffer, then the same Run continues as a live spectrum stream.
    fireEvent.click(within(navigation).getByRole('button', { name: /^Spectrum$/i }));
    await act(async () => {
      const first = pending[0]!;
      first.capture.resolve(complexIqMeasurement(first.configuration, first.revision, first.id));
    });
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce());
    expect(screen.getByText(/Running spectrum/i)).toBeTruthy();
    expect(pending).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /^Stop$/i }));
    await waitFor(() => expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: /^Run$/i })).toBeTruthy());
  });

  it('retargets a spectrum Run to live bounded I/Q buffers when the operator enters the I/Q workspace', async () => {
    const pending = mockDeferredSignalLabIqBuffers();

    render(<App/>);
    const navigation = await screen.findByRole('navigation', { name: /Primary navigation/i });
    await screen.findByText('SIGNALLAB SIMULATION');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce());
    expect(screen.getByText(/Running spectrum/i)).toBeTruthy();

    // Run follows the operator: entering I/Q stops the spectrum stream and
    // continues the same Run as one-at-a-time bounded I/Q buffers.
    fireEvent.click(within(navigation).getByRole('button', { name: /^I\/Q$/i }));
    await waitFor(() => expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledOnce());
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(screen.getByText(/Running I\/Q/i)).toBeTruthy();

    await act(async () => {
      const first = pending[0]!;
      first.capture.resolve(complexIqMeasurement(first.configuration, first.revision, first.id));
    });
    await waitFor(() => expect(pending).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: /^Stop$/i }));
    await act(async () => {
      const second = pending[1]!;
      second.capture.resolve(complexIqMeasurement(second.configuration, second.revision, second.id));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Run$/i })).toBeTruthy());
  });

  it('retargets an active spectrum Run to live I/Q when Atom navigates to the I/Q workspace', async () => {
    const pending = mockDeferredSignalLabIqBuffers();
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'iq-route-run-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'iq-route-run-load', name: 'load_atom_tools', arguments: '{"toolNames":["navigate_workspace","inspect_interface"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'iq-route-run-1', transport: 'realtime-websocket', text: '', toolCalls: [
        { callId: 'iq-route-run-navigate', name: 'navigate_workspace', arguments: '{"workspace":"iq"}' },
        { callId: 'iq-route-run-inspect', name: 'inspect_interface', arguments: '{}' },
      ] })
      .mockResolvedValueOnce({ conversationId: 'iq-route-run-2', transport: 'realtime-websocket', text: 'I/Q is visible while spectrum acquisition continues.', toolCalls: [] });

    render(<App/>);
    await screen.findByText('SIGNALLAB SIMULATION');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce());

    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Open and inspect I/Q without stopping Run.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const outputs = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs ?? [];
    const results = outputs.map(({ output }) => JSON.parse(output) as { ok?: boolean; output?: Record<string, unknown> });
    expect(results[0]).toMatchObject({ ok: true, output: { workspace: 'iq' } });
    expect(results[1]).toMatchObject({
      ok: true,
      output: {
        activeWorkspace: 'iq',
        rendered: expect.arrayContaining([
          expect.objectContaining({ controlId: 'workspace.iq', enabled: true, preferredTool: 'navigate_workspace' }),
        ]),
      },
    });
    // Run follows the workspace regardless of who navigated: Atom entering
    // I/Q retargets the spectrum stream to live bounded I/Q buffers.
    await waitFor(() => expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledOnce());
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(screen.getByText(/Running I\/Q/i)).toBeTruthy();
    expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: /^Stop$/i }));
    await act(async () => {
      const first = pending[0]!;
      first.capture.resolve(complexIqMeasurement(first.configuration, first.revision, first.id));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Run$/i })).toBeTruthy());
  });

  it('rejects typed I/Q navigation when the connected source has no complex-I/Q capability', async () => {
    mockConnectedInstrument(signalLabSession);
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'iq-capability-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'iq-capability-load', name: 'load_atom_tools', arguments: '{"toolNames":["navigate_workspace"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'iq-capability-1', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'iq-capability-navigate', name: 'navigate_workspace', arguments: '{"workspace":"iq"}' }] })
      .mockResolvedValueOnce({ conversationId: 'iq-capability-2', transport: 'realtime-websocket', text: 'I/Q is unavailable on this source.', toolCalls: [] });

    render(<App/>);
    await screen.findByText('SIGNALLAB SIMULATION');
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Open I/Q.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const result = JSON.parse(vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs?.[0]?.output ?? '{}') as { ok?: boolean; error?: string };
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/does not advertise complex-I\/Q acquisition/i) });
    expect(screen.queryByRole('region', { name: /Complex I\/Q workspace/i })).toBeNull();
  });

  it('lets Atom navigate to I/Q and use contextual Single with exact capture readback', async () => {
    mockConnectedInstrument(signalLabIqSession);
    vi.mocked(window.atomizerInstrument.configure).mockImplementation(async (configuration) => {
      activeConfiguration = structuredClone(configuration);
      configurationRevision = `configuration-${++revisionSequence}`;
      return { sessionId: signalLabIqSession.sessionId, configurationRevision, configuration, configuredAt: '2026-07-10T00:00:00.000Z' };
    });
    vi.mocked(window.atomizerInstrument.acquire).mockImplementation(async () => {
      if (activeConfiguration.kind !== 'complex-iq') throw new Error(`Expected complex-I/Q configuration, received ${activeConfiguration.kind}`);
      return complexIqMeasurement(activeConfiguration, configurationRevision, 'agent-iq-single');
    });
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'iq-single-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'iq-single-load', name: 'load_atom_tools', arguments: '{"toolNames":["navigate_workspace","acquire_sweep","get_application_state","inspect_interface"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'iq-single-1', transport: 'realtime-websocket', text: '', toolCalls: [
        { callId: 'iq-single-navigate', name: 'navigate_workspace', arguments: '{"workspace":"iq"}' },
        { callId: 'iq-single-acquire', name: 'acquire_sweep', arguments: '{}' },
        { callId: 'iq-single-state', name: 'get_application_state', arguments: '{}' },
        { callId: 'iq-single-inspect', name: 'inspect_interface', arguments: '{}' },
      ] })
      .mockResolvedValueOnce({ conversationId: 'iq-single-2', transport: 'realtime-websocket', text: 'One bounded I/Q buffer acquired.', toolCalls: [] });

    render(<App/>);
    await screen.findByText('SIGNALLAB SIMULATION');
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Open I/Q, capture one buffer, and verify it.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const outputs = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs ?? [];
    const results = outputs.map(({ output }) => JSON.parse(output) as { ok?: boolean; output?: Record<string, unknown> });
    expect(results.every(({ ok }) => ok), JSON.stringify(results)).toBe(true);
    expect(results[1]?.output).toMatchObject({
      acquired: true,
      acquisitionMode: 'complex-iq',
      captureId: 'agent-iq-single',
      sampleCount: 2,
      sampleRateHz: 2_000_000,
      qualification: 'analytic-complex-baseband',
    });
    expect(results[2]?.output).toMatchObject({
      workspace: 'iq',
      continuous: false,
      continuousMode: 'spectrum',
      iq: {
        stagedConfiguration: expect.objectContaining({ kind: 'complex-iq', sampleCount: 2, sampleRateHz: 2_000_000 }),
        latestCapture: {
          id: 'agent-iq-single',
          sequence: expect.any(Number),
          centerHz: expect.any(Number),
          sampleCount: 2,
          sampleRateHz: 2_000_000,
          bandwidthHz: 2_000_000,
          sampleFormat: 'cf32le',
          timing: {
            capturedAt: '2026-07-10T00:00:01.000Z',
            elapsedMilliseconds: 4,
            durationSeconds: 0.000001,
          },
          provenance: {
            sessionId: signalLabIqSession.sessionId,
            configurationRevision: expect.any(String),
            producerConfigurationEpoch: 'producer-epoch:1',
            qualification: 'analytic-complex-baseband',
            sourceKind: 'signal-lab',
            execution: 'signal-lab-simulation',
          },
        },
      },
    });
    expect(results[3]?.output).toMatchObject({
      activeWorkspace: 'iq',
      rendered: expect.arrayContaining([
        expect.objectContaining({ controlId: 'acquisition.single', enabled: true, humanOnly: false }),
        expect.objectContaining({ controlId: 'acquisition.continuous.start', enabled: true, humanOnly: false }),
      ]),
    });
    expect(window.atomizerInstrument.startStreaming).not.toHaveBeenCalled();
  });

  it('lets Atom navigate to I/Q, Run, inspect/read back, and Stop one bounded buffer', async () => {
    const pending = mockDeferredSignalLabIqBuffers();
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'iq-run-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'iq-run-load', name: 'load_atom_tools', arguments: '{"toolNames":["navigate_workspace","start_continuous_sweeps","get_application_state","inspect_interface","stop_continuous_sweeps"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'iq-run-1', transport: 'realtime-websocket', text: '', toolCalls: [
        { callId: 'iq-run-navigate', name: 'navigate_workspace', arguments: '{"workspace":"iq"}' },
        { callId: 'iq-run-start', name: 'start_continuous_sweeps', arguments: '{}' },
        { callId: 'iq-run-state-active', name: 'get_application_state', arguments: '{}' },
        { callId: 'iq-run-inspect', name: 'inspect_interface', arguments: '{}' },
        { callId: 'iq-run-stop', name: 'stop_continuous_sweeps', arguments: '{}' },
        { callId: 'iq-run-state-stopped', name: 'get_application_state', arguments: '{}' },
      ] })
      .mockResolvedValueOnce({ conversationId: 'iq-run-2', transport: 'realtime-websocket', text: 'Bounded I/Q Run verified and stopped.', toolCalls: [] });

    render(<App/>);
    await screen.findByText('SIGNALLAB SIMULATION');
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Open I/Q, Run, verify the controls and state, then Stop.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(pending).toHaveLength(1));
    expect(await screen.findByRole('button', { name: /Stopping/i })).toBeTruthy();
    await act(async () => {
      const first = pending[0]!;
      first.capture.resolve(complexIqMeasurement(first.configuration, first.revision, first.id));
    });

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const outputs = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs ?? [];
    const results = outputs.map(({ output }) => JSON.parse(output) as { ok?: boolean; output?: Record<string, unknown> });
    expect(results.every(({ ok }) => ok), JSON.stringify(results)).toBe(true);
    expect(results[1]?.output).toEqual({ streaming: true, continuousMode: 'complex-iq', workspace: 'iq' });
    expect(results[2]?.output).toMatchObject({ workspace: 'iq', continuous: true, continuousMode: 'complex-iq', iq: { latestCapture: null } });
    expect(results[3]?.output).toMatchObject({
      activeWorkspace: 'iq',
      rendered: expect.arrayContaining([
        expect.objectContaining({ controlId: 'workspace.iq', enabled: true }),
        expect.objectContaining({ controlId: 'acquisition.continuous.stop', enabled: true, humanOnly: false }),
      ]),
    });
    expect(results[4]?.output).toMatchObject({ streaming: false, continuousMode: 'complex-iq' });
    expect(results[5]?.output).toMatchObject({
      workspace: 'iq',
      continuous: false,
      continuousMode: 'complex-iq',
      iq: { latestCapture: expect.objectContaining({ id: 'iq-buffer-1', sampleCount: 2, sampleRateHz: 2_000_000 }) },
    });
    expect(window.atomizerInstrument.configure).toHaveBeenCalledTimes(1);
    expect(window.atomizerInstrument.acquire).toHaveBeenCalledOnce();
    expect(window.atomizerInstrument.startStreaming).not.toHaveBeenCalled();
    expect(window.atomizerInstrument.stopStreaming).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /^Run$/i })).toBeTruthy();
  });

  it('publishes one advancing global sweep identity across every non-Spectrum Run route', async () => {
    mockConnectedInstrument(signalLabIqSession);
    vi.mocked(window.atomizerInstrument.configure).mockImplementation(async (configuration) => {
      activeConfiguration = structuredClone(configuration);
      configurationRevision = `configuration-${++revisionSequence}`;
      return {
        sessionId: signalLabIqSession.sessionId,
        configurationRevision,
        configuration,
        configuredAt: '2026-07-10T00:00:00.000Z',
      };
    });

    render(<App/>);
    const navigation = await screen.findByRole('navigation', { name: /Primary navigation/i });
    await screen.findByText('SIGNALLAB SIMULATION');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce());
    if (activeConfiguration.kind !== 'swept-spectrum') throw new Error('Expected spectrum Run configuration');
    const streamingConfiguration = structuredClone(activeConfiguration);
    const streamingRevision = configurationRevision;
    const acquisition = screen.getByRole('region', { name: 'Acquisition controls' });

    // I/Q is intentionally absent: entering it retargets a Run to bounded
    // I/Q buffers, so it is no longer a spectrum-stream route.
    for (const route of ['Waterfall', 'Channel', 'Device'] as const) {
      fireEvent.click(within(navigation).getByRole('button', { name: new RegExp(`^${route.replace('/', '\\/')}$`, 'i') }));
      if (route === 'Waterfall') {
        await screen.findByLabelText(/Measured power by frequency and sweep time/i);
        expect(screen.getByLabelText('Edit Color floor').getAttribute('aria-disabled')).toBe('false');
      } else if (route === 'Channel') {
        await screen.findByText(/Channel setup/i);
        expect(screen.getByLabelText('Edit Center frequency').getAttribute('aria-disabled')).toBe('false');
      } else {
        await screen.findByText(/Instrument source/i);
        expect((screen.getByRole('combobox', { name: 'SignalLab profile' }) as HTMLSelectElement).disabled)
          .toBe(false);
      }
      const measurement = signalLabStreamingMeasurement(
        streamingConfiguration,
        `route-${route}`,
        streamingRevision,
        'producer-epoch:1',
        true,
      );
      await act(async () => {
        instrumentEventListener?.({ type: 'measurement', measurement });
      });
      await waitFor(() => expect(acquisition.getAttribute('aria-description')).toBe(
        `DEV ACQUISITION LANDMARK; controls=Stop; sweepId=${measurement.measurementId}; sequence=${measurement.sequence}`,
      ));
      expect(within(acquisition).getByRole('button', { name: /^Stop$/i })).toBeTruthy();
    }
  });

  it('pauses bounded I/Q at buffer boundaries for SignalLab profile and channel changes, then resumes', async () => {
    const pending = mockDeferredSignalLabIqBuffers();
    let featureSession = signalLabIqSession;
    let producerEpoch = 1;
    vi.mocked(window.atomizerInstrument.executeFeature).mockImplementation(async (request) => {
      if (request.kind !== 'signal-lab-profile-selection') {
        throw new Error(`Feature ${request.kind} not mocked`);
      }
      const execution = signalLabFeatureExecution(
        request,
        featureSession,
        `producer-epoch:${++producerEpoch}`,
      );
      featureSession = execution.session;
      emitInvalidatingFeatureExecution(
        execution,
        request.action === 'select-profile' ? 'source-profile-changed' : 'source-channel-changed',
      );
      return execution;
    });

    render(<App/>);
    const navigation = await screen.findByRole('navigation', { name: /Primary navigation/i });
    await screen.findByText('SIGNALLAB SIMULATION');
    fireEvent.click(within(navigation).getByRole('button', { name: /^I\/Q$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(pending).toHaveLength(1));

    fireEvent.click(within(navigation).getByRole('button', { name: /^Generate$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^FM/i }));
    expect(window.atomizerInstrument.executeFeature).not.toHaveBeenCalled();
    await act(async () => {
      const first = pending[0]!;
      first.capture.resolve(complexIqMeasurement(first.configuration, first.revision, first.id));
    });
    await waitFor(() => expect(window.atomizerInstrument.executeFeature).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1]?.configuration.centerHz).toBe(waveformDescriptor('fm').centerHz);

    fireEvent.click(screen.getByRole('button', { name: /^Rayleigh$/i }));
    expect(window.atomizerInstrument.executeFeature).toHaveBeenCalledTimes(1);
    await act(async () => {
      const second = pending[1]!;
      second.capture.resolve(complexIqMeasurement(second.configuration, second.revision, second.id));
    });
    await waitFor(() => expect(window.atomizerInstrument.executeFeature).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(pending).toHaveLength(3));
    expect(window.atomizerInstrument.configure).toHaveBeenCalledTimes(3);
    expect(window.atomizerInstrument.startStreaming).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Stop$/i }));
    await act(async () => {
      const third = pending[2]!;
      third.capture.resolve(complexIqMeasurement(third.configuration, third.revision, third.id));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Run$/i })).toBeTruthy());
    expect(window.atomizerInstrument.acquire).toHaveBeenCalledTimes(3);
  });

  it('admits Stop while an I/Q profile change owns the foreground transaction and never resumes', async () => {
    const pending = mockDeferredSignalLabIqBuffers();
    const feature = deferred<AtomizerInstrumentFeatureExecution>();
    vi.mocked(window.atomizerInstrument.executeFeature).mockImplementation((request) => {
      if (request.kind !== 'signal-lab-profile-selection') {
        return Promise.reject(new Error(`Feature ${request.kind} not mocked`));
      }
      return feature.promise;
    });

    render(<App/>);
    const navigation = await screen.findByRole('navigation', { name: /Primary navigation/i });
    await screen.findByText('SIGNALLAB SIMULATION');
    fireEvent.click(within(navigation).getByRole('button', { name: /^I\/Q$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.click(within(navigation).getByRole('button', { name: /^Generate$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^FM/i }));

    await act(async () => {
      const first = pending[0]!;
      first.capture.resolve(complexIqMeasurement(first.configuration, first.revision, first.id));
    });
    await waitFor(() => expect(window.atomizerInstrument.executeFeature).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /^Stop$/i }));
    expect(screen.getByRole('button', { name: /Stopping/i })).toBeTruthy();

    const execution = signalLabFeatureExecution(
      { kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: 'fm' },
      signalLabIqSession,
      'producer-epoch:2',
    );
    await act(async () => {
      emitInvalidatingFeatureExecution(execution, 'source-profile-changed');
      feature.resolve(execution);
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Run$/i })).toBeTruthy());
    await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 5)); });
    expect(window.atomizerInstrument.acquire).toHaveBeenCalledOnce();
    expect(window.atomizerInstrument.startStreaming).not.toHaveBeenCalled();
  });

  it('drops a late I/Q buffer after disconnect and does not retry acquisition', async () => {
    const pending = mockDeferredSignalLabIqBuffers();

    render(<App/>);
    const navigation = await screen.findByRole('navigation', { name: /Primary navigation/i });
    await screen.findByText('SIGNALLAB SIMULATION');
    fireEvent.click(within(navigation).getByRole('button', { name: /^I\/Q$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(pending).toHaveLength(1));

    await act(async () => {
      instrumentEventListener?.({
        type: 'disconnected',
        sessionId: signalLabIqSession.sessionId,
        driverId: signalLabIqSession.driverId,
      });
    });
    expect(await screen.findByText('No instrument')).toBeTruthy();
    await act(async () => {
      const first = pending[0]!;
      first.capture.resolve(complexIqMeasurement(first.configuration, first.revision, 'late-iq-buffer'));
    });
    await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 5)); });
    expect(window.atomizerInstrument.acquire).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('late-iq-buffer');
  });

  it('stops the bounded I/Q pump after one acquisition failure without retrying', async () => {
    mockConnectedInstrument(signalLabIqSession);
    vi.mocked(window.atomizerInstrument.configure).mockImplementation(async (configuration) => {
      activeConfiguration = structuredClone(configuration);
      configurationRevision = `configuration-${++revisionSequence}`;
      return {
        sessionId: signalLabIqSession.sessionId,
        configurationRevision,
        configuration,
        configuredAt: '2026-07-10T00:00:00.000Z',
      };
    });
    vi.mocked(window.atomizerInstrument.acquire).mockRejectedValue(new Error('I/Q transport failed'));

    render(<App/>);
    const navigation = await screen.findByRole('navigation', { name: /Primary navigation/i });
    await screen.findByText('SIGNALLAB SIMULATION');
    fireEvent.click(within(navigation).getByRole('button', { name: /^I\/Q$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));

    expect(await screen.findByText(/Continuous I\/Q acquisition failed: I\/Q transport failed/i)).toBeTruthy();
    await act(async () => { await new Promise<void>((resolve) => window.setTimeout(resolve, 5)); });
    expect(window.atomizerInstrument.configure).toHaveBeenCalledOnce();
    expect(window.atomizerInstrument.acquire).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /^Run$/i })).toBeTruthy();
  });

  it('presents a failed operator export without an unhandled rejection or renderer loss', async () => {
    mockConnectedInstrument();
    vi.mocked(window.atomizerFiles.exportSweep).mockRejectedValueOnce(new Error('export destination unavailable'));
    render(<App/>);
    expect(await screen.findByText('tinySA Ultra+ ZS407')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Single$/i }));

    fireEvent.click(await screen.findByRole('button', { name: 'Export CSV' }));

    expect(await screen.findByText('export destination unavailable')).toBeTruthy();
    const navigation = screen.getByRole('navigation', { name: /Primary navigation/i });
    fireEvent.click(within(navigation).getByRole('button', { name: /^Detect$/i }));
    expect(within(navigation).getByRole('button', { name: /^Detect$/i }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByText(/Atomizer could not start/i)).toBeNull();
  });

  it.each([
    { navigationName: /Generate/i, activeWorkspace: 'generator' },
    { navigationName: /Device/i, activeWorkspace: 'device' },
  ])('lets Atom inspect the SignalLab $activeWorkspace surface without exposing profile mutation', async ({ navigationName, activeWorkspace }) => {
    vi.mocked(window.atomizerInstrument.getState).mockResolvedValue({
      schemaVersion: 1,
      startup: { status: 'connected', connectedAt: '2026-07-10T00:00:00.000Z' },
      streaming: { status: 'stopped' },
      connectionCleanup: { status: 'not-required' },
      preference: { source: 'factory-default', preference: { schemaVersion: 1, driverId: 'signal-lab', candidateKind: 'signal-lab', updatedAt: '2026-07-10T00:00:00.000Z' } },
      session: signalLabSession,
    });
    vi.mocked(window.atomizerInstrument.discover).mockResolvedValue({ discoveryRevision: 'signal-discovery-1', discoveredAt: '2026-07-10T00:00:00.000Z', candidates: [signalLabCandidate], failures: [] });
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'inspect-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'inspect-load', name: 'load_atom_tools', arguments: '{"toolNames":["inspect_interface"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'inspect-1', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'inspect-ui', name: 'inspect_interface', arguments: '{}' }] })
      .mockResolvedValueOnce({ conversationId: 'inspect-2', transport: 'realtime-websocket', text: 'Interface inspected.', toolCalls: [] });

    render(<App/>);
    expect(await screen.findByText('SIGNALLAB SIMULATION')).toBeTruthy();
    const navigation = screen.getByRole('navigation', { name: /Primary navigation/i });
    fireEvent.click(within(navigation).getByRole('button', { name: navigationName }));
    const profile = activeWorkspace === 'generator'
      ? await screen.findByRole('button', { name: /^CW carrier/i })
      : await screen.findByRole('combobox', { name: /SignalLab profile/i });
    expect(profile.closest('[data-agent-exclusion="human-signal-profile-boundary"]')).toBeTruthy();
    expect(profile.closest('[data-agent-control]')).toBeNull();

    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Inspect this interface.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const inspected = JSON.parse(vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs?.[0]?.output ?? '{}') as {
      ok?: boolean;
      output?: { activeWorkspace?: string; rendered?: readonly { controlId?: string }[] };
    };
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true);
    expect(inspected.output?.activeWorkspace).toBe(activeWorkspace);
    expect(inspected.output?.rendered?.some(({ controlId }) => controlId === 'signal-lab.profile')).toBe(false);
    expect(window.atomizerInstrument.executeFeature).not.toHaveBeenCalled();
  });

  it('shows Atom only qualified synthetic staging and rejects receiver-only SignalLab edits', async () => {
    vi.mocked(window.atomizerInstrument.getState).mockResolvedValue({
      schemaVersion: 1,
      startup: { status: 'connected', connectedAt: '2026-07-10T00:00:00.000Z' },
      streaming: { status: 'stopped' },
      connectionCleanup: { status: 'not-required' },
      preference: { source: 'factory-default', preference: { schemaVersion: 1, driverId: 'signal-lab', candidateKind: 'signal-lab', updatedAt: '2026-07-10T00:00:00.000Z' } },
      session: signalLabSession,
    });
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'truth-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'truth-load', name: 'load_atom_tools', arguments: '{"toolNames":["get_application_state","configure_analyzer"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'truth-1', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'truth-state', name: 'get_application_state', arguments: '{}' }] })
      .mockResolvedValueOnce({ conversationId: 'truth-2', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'truth-config', name: 'configure_analyzer', arguments: '{"rbwKhz":30}' }] })
      .mockResolvedValueOnce({ conversationId: 'truth-3', transport: 'realtime-websocket', text: 'Receiver controls are not applicable to SignalLab.', toolCalls: [] });

    render(<App/>);
    expect(await screen.findByText('SIGNALLAB SIMULATION')).toBeTruthy();
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Inspect and then change the RBW.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(4));
    const stateOutput = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs?.[0]?.output ?? '';
    expect(stateOutput).toContain('"controlModel":"synthetic-scalar"');
    expect(stateOutput).toContain('"receiverControls":{"applicability":"not-applicable"}');
    expect(stateOutput).not.toContain('"rbwKhz"');
    expect(stateOutput).not.toContain('"attenuationDb"');
    expect(stateOutput).not.toContain('"trigger"');
    const rejectedOutput = vi.mocked(window.atomAgent.agentTurn).mock.calls[3]?.[0].toolOutputs?.[0]?.output ?? '';
    expect(rejectedOutput).toContain('not applicable to synthetic scalar acquisition');
    expect(window.atomizerInstrument.configure).not.toHaveBeenCalled();
  });

  it('exposes retained failed-connect cleanup and blocks a new connection until the safe retry succeeds', async () => {
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'cleanup-inspect-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'cleanup-inspect-load', name: 'load_atom_tools', arguments: '{"toolNames":["inspect_interface"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'cleanup-inspect-1', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'cleanup-inspect', name: 'inspect_interface', arguments: '{}' }] })
      .mockResolvedValueOnce({ conversationId: 'cleanup-inspect-2', transport: 'realtime-websocket', text: 'Safe cleanup is available.', toolCalls: [] });
    render(<App/>);
    const connectionButton = await screen.findByRole('button', { name: /No instrument.*Choose an instrument source/i });
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(connectionButton);

    await act(async () => {
      instrumentEventListener?.({
        type: 'connection-cleanup',
        connectionCleanup: { status: 'required', driverId: 'tinysa', phase: 'driver-pending' },
      });
    });

    const dialog = screen.getByRole('dialog', { name: 'Instrument source' });
    expect(within(dialog).getByRole('alert').textContent).toMatch(/Connection cleanup required/i);
    // While cleanup is required every source row is blocked from connecting.
    expect(within(dialog).getAllByRole('button').filter((b) => b.getAttribute('data-agent-control')?.startsWith('connection.candidate'))
      .every((b) => b.hasAttribute('disabled'))).toBe(true);

    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Inspect the cleanup control.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));
    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const inspected = JSON.parse(vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs?.[0]?.output ?? '{}') as {
      ok?: boolean;
      output?: { rendered?: readonly { controlId?: string; enabled?: boolean; preferredTool?: string }[] };
    };
    expect(inspected).toMatchObject({
      ok: true,
      output: {
        rendered: expect.arrayContaining([
          expect.objectContaining({ controlId: 'connection.retry-cleanup', enabled: true, preferredTool: 'disconnect_device' }),
        ]),
      },
    });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry safe cleanup' }));
    await waitFor(() => expect(window.atomizerInstrument.disconnect).toHaveBeenCalledOnce());
    await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull());
  });

  it('persists the exact selected candidate when two physical TinySAs share one driver and source kind', async () => {
    const discoveryRevision = 'physical-preference-discovery';
    const first = {
      ...physicalCandidate,
      candidateId: 'serial:/dev/tty.usbmodem407',
      displayName: 'TinySA physical A',
      discoveryRevision,
      serialPort: { ...physicalCandidate.serialPort, path: '/dev/tty.usbmodem407', serialNumber: 'A' },
    } satisfies InstrumentCandidate;
    const second = {
      ...physicalCandidate,
      candidateId: 'serial:/dev/tty.usbmodem408',
      displayName: 'TinySA physical B',
      discoveryRevision,
      serialPort: { ...physicalCandidate.serialPort, path: '/dev/tty.usbmodem408', serialNumber: 'B' },
    } satisfies InstrumentCandidate;
    vi.mocked(window.atomizerInstrument.getState).mockResolvedValueOnce({
      schemaVersion: 1,
      startup: { status: 'not-started' },
      streaming: { status: 'stopped' },
      connectionCleanup: { status: 'not-required' },
      preference: {
        source: 'persisted',
        preference: {
          schemaVersion: 1,
          driverId: first.driverId,
          candidateKind: first.sourceKind,
          candidateId: first.candidateId,
          updatedAt: '2026-07-10T00:00:00.000Z',
        },
      },
    });
    vi.mocked(window.atomizerInstrument.discover).mockResolvedValueOnce({
      discoveryRevision,
      discoveredAt: '2026-07-10T00:00:00.000Z',
      candidates: [first, second],
      failures: [],
    });

    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /Instrument source/i });
    expect(within(dialog).getByRole('button', { name: /TinySA physical A.*STARTUP DEFAULT/i })).toBeTruthy();
    // Selecting B connects to it and closes the chooser; reopen to pin the
    // now-connected source as the startup default.
    fireEvent.click(within(dialog).getByRole('button', { name: /TinySA physical B/i }));
    await waitFor(() => expect(window.atomizerInstrument.connect).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /tinySA Ultra\+ ZS407|No instrument/i }));
    const reopened = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(within(reopened).getByRole('button', { name: 'Use at startup' }));

    await waitFor(() => expect(window.atomizerInstrument.writePreference).toHaveBeenCalledWith({
      driverId: second.driverId,
      candidateKind: second.sourceKind,
      candidateId: second.candidateId,
    }));
  });

  it('does not let an in-flight startup snapshot overwrite a newer subscribed connection event', async () => {
    let releaseState: ((state: AtomizerInstrumentState) => void) | undefined;
    vi.mocked(window.atomizerInstrument.getState).mockImplementationOnce(() => new Promise((resolve) => { releaseState = resolve; }));
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.getState).toHaveBeenCalledOnce());
    await act(async () => { instrumentEventListener?.({ type: 'connected', session: ready }); });
    await act(async () => {
      releaseState?.({ schemaVersion: 1, startup: { status: 'not-started' }, streaming: { status: 'stopped' }, connectionCleanup: { status: 'not-required' } });
    });
    expect(await screen.findByText('tinySA Ultra+ ZS407')).toBeTruthy();
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    expect(screen.queryByText('No instrument')).toBeNull();
  });

  it('ignores a delayed disconnect from an older session', async () => {
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    const newer: InstrumentSessionSnapshot = {
      ...ready,
      sessionId: 'session-newer',
      provenance: ready.provenance.sourceKind === 'tinysa-firmware-twin'
        ? { ...ready.provenance, device: { ...ready.provenance.device, model: 'Newer session device' } }
        : ready.provenance,
    };
    await act(async () => { instrumentEventListener?.({ type: 'connected', session: newer }); });
    expect(await screen.findByText('Newer session device')).toBeTruthy();

    await act(async () => {
      instrumentEventListener?.({ type: 'disconnected', sessionId: ready.sessionId, driverId: ready.driverId });
    });
    expect(screen.getByText('Newer session device')).toBeTruthy();
  });

  it('restores RF on from the authoritative startup snapshot instead of defaulting to off', async () => {
    vi.mocked(window.atomizerInstrument.getState).mockResolvedValueOnce({
      schemaVersion: 1,
      startup: { status: 'connected', connectedAt: '2026-07-10T00:00:00.000Z' },
      streaming: { status: 'stopped' },
      connectionCleanup: { status: 'not-required' },
      session: { ...ready, rfOutput: 'on', rfOutputQualification: 'firmware-executed-twin' },
    });
    render(<App/>);
    expect(await screen.findByText('RF ON')).toBeTruthy();
    expect(screen.getByText('FIRMWARE-EXECUTED TWIN')).toBeTruthy();
  });

  it('shows physical RF-off as a command acknowledgement rather than a power measurement', async () => {
    vi.mocked(window.atomizerInstrument.getState).mockResolvedValueOnce({
      schemaVersion: 1,
      startup: { status: 'connected', connectedAt: '2026-07-10T00:00:00.000Z' },
      streaming: { status: 'stopped' },
      connectionCleanup: { status: 'not-required' },
      session: physicalSession,
    });
    vi.mocked(window.atomizerInstrument.discover).mockResolvedValueOnce({
      discoveryRevision: physicalCandidate.discoveryRevision,
      discoveredAt: '2026-07-10T00:00:00.000Z',
      candidates: [physicalCandidate],
      failures: [],
    });

    render(<App/>);

    expect(await screen.findByText('RF OFF')).toBeTruthy();
    expect(screen.getByText('COMMAND ACKNOWLEDGED')).toBeTruthy();
    expect(screen.getByLabelText('RF output off, command acknowledged').title).toMatch(/not independently measured/);
    expect(screen.getByText('CUSTOM FW · UNQUALIFIED').title)
      .toBe('Custom firmware revision deadbee is admitted without source qualification.');
    fireEvent.click(within(screen.getByRole('navigation', { name: /Primary navigation/i }))
      .getByRole('button', { name: /Device/i }));
    expect(await screen.findByText('Custom firmware revision deadbee is admitted without source qualification.'))
      .toBeTruthy();
  });

  it('returns exact device-observed physical RBW and attenuation through both latest-sweep read tools without identity claims', async () => {
    mockConnectedInstrument(physicalSession);
    vi.mocked(window.atomizerInstrument.configure).mockImplementation(async (configuration) => {
      activeConfiguration = structuredClone(configuration);
      configurationRevision = `physical-configuration-${++revisionSequence}`;
      return {
        sessionId: physicalSession.sessionId,
        configurationRevision,
        configuration,
        configuredAt: '2026-07-10T00:00:00.000Z',
      };
    });
    vi.mocked(window.atomizerInstrument.acquire).mockImplementation(async () => {
      const configuration = activeConfiguration;
      if (configuration.kind !== 'swept-spectrum') {
        throw new Error(`Expected physical swept-spectrum configuration, received ${configuration.kind}`);
      }
      const frequencyHz = Array.from({ length: configuration.points }, (_value, index) =>
        configuration.startHz
          + index * ((configuration.stopHz - configuration.startHz)
            / Math.max(1, configuration.points - 1)));
      return {
        schemaVersion: 1,
        kind: 'swept-spectrum',
        measurementId: 'physical-readback-sweep-1',
        sessionId: physicalSession.sessionId,
        configurationRevision,
        sequence: ++measurementSequence,
        capturedAt: '2026-07-10T00:00:01.000Z',
        elapsedMilliseconds: 37,
        resolutionBandwidthHz: 123_000,
        attenuationDb: 7,
        qualification: 'device-observed',
        complete: true,
        frequencyHz,
        powerDbm: frequencyHz.map((_frequency, index) =>
          index === Math.floor(frequencyHz.length / 2) ? -47 : -102),
      };
    });
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'physical-readback-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'physical-readback-load', name: 'load_atom_tools', arguments: '{"toolNames":["acquire_sweep","get_application_state","get_latest_sweep_summary"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'physical-readback-1', transport: 'realtime-websocket', text: '', toolCalls: [
        { callId: 'physical-readback-acquire', name: 'acquire_sweep', arguments: '{}' },
        { callId: 'physical-readback-application', name: 'get_application_state', arguments: '{}' },
        { callId: 'physical-readback-summary', name: 'get_latest_sweep_summary', arguments: '{}' },
      ] })
      .mockResolvedValueOnce({ conversationId: 'physical-readback-2', transport: 'realtime-websocket', text: 'Exact receiver readbacks reported.', toolCalls: [] });

    render(<App/>);
    await screen.findByText('tinySA Ultra+ ZS407');
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Acquire once and report the exact RBW and attenuation readbacks.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const outputs = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs ?? [];
    expect(outputs).toHaveLength(3);
    const results = outputs.map(({ output }) => JSON.parse(output) as {
      ok?: boolean;
      output?: Record<string, unknown>;
    });
    expect(results.every(({ ok }) => ok), JSON.stringify(results)).toBe(true);
    const applicationLatest = results[1]?.output?.latestSweep as Record<string, unknown> | undefined;
    const summary = results[2]?.output;
    const exactReadback = {
      id: 'physical-readback-sweep-1',
      source: 'instrument-driver-scalar',
      actualRbwHz: 123_000,
      resolutionBandwidthQualification: 'device-observed',
      actualAttenuationDb: 7,
      attenuationQualification: 'device-observed',
    };
    expect(applicationLatest).toEqual(expect.objectContaining(exactReadback));
    expect(summary).toEqual(expect.objectContaining(exactReadback));
    for (const readback of [applicationLatest, summary]) {
      const serialized = JSON.stringify(readback).toLowerCase();
      for (const forbidden of ['identity', 'protocol', 'emitter', 'operator', 'service']) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

  it('shows frozen-source-qualified custom firmware as receive-only with no RF-output authority', async () => {
    vi.mocked(window.atomizerInstrument.getState).mockResolvedValueOnce({
      schemaVersion: 1,
      startup: { status: 'connected', connectedAt: '2026-07-10T00:00:00.000Z' },
      streaming: { status: 'stopped' },
      connectionCleanup: { status: 'not-required' },
      session: sourceQualifiedPhysicalSession,
    });
    vi.mocked(window.atomizerInstrument.discover).mockResolvedValueOnce({
      discoveryRevision: physicalCandidate.discoveryRevision,
      discoveredAt: '2026-07-10T00:00:00.000Z',
      candidates: [physicalCandidate],
      failures: [],
    });

    render(<App/>);

    const badge = await screen.findByText('CUSTOM FW · RECEIVE ONLY');
    expect(badge.title).toBe(sourceQualifiedFirmwareRecord.warning);
    expect(screen.queryByText(/^RF (?:ON|OFF|UNKNOWN)$/)).toBeNull();
    expect(within(screen.getByRole('navigation', { name: /Primary navigation/i }))
      .getByRole('button', { name: /Generate/i }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(screen.getByRole('navigation', { name: /Primary navigation/i }))
      .getByRole('button', { name: /Device/i }));
    expect(await screen.findByText('Custom firmware · source-qualified receive only')).toBeTruthy();
    expect(screen.getByText(sourceQualifiedFirmwareRecord.warning)).toBeTruthy();
    expect(screen.getByText(ZS407_CUSTOM_RECEIVER_SOURCE_COMMIT.slice(0, 12))).toBeTruthy();
    const featuresLabel = screen.getByText('Features');
    expect(within(featuresLabel.parentElement!).getByText('None')).toBeTruthy();
  });

  it('returns frozen source mapping, unattested-binary warning, and absent RF authority to Atom state', async () => {
    vi.mocked(window.atomizerInstrument.getState).mockResolvedValueOnce({
      schemaVersion: 1,
      startup: { status: 'connected', connectedAt: '2026-07-10T00:00:00.000Z' },
      streaming: { status: 'stopped' },
      connectionCleanup: { status: 'not-required' },
      session: sourceQualifiedPhysicalSession,
    });
    vi.mocked(window.atomizerInstrument.discover).mockResolvedValueOnce({
      discoveryRevision: physicalCandidate.discoveryRevision,
      discoveredAt: '2026-07-10T00:00:00.000Z',
      candidates: [physicalCandidate],
      failures: [],
    });
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'source-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'source-load', name: 'load_atom_tools', arguments: '{"toolNames":["get_instrument_state"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'source-1', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'source-state', name: 'get_instrument_state', arguments: '{}' }] })
      .mockResolvedValueOnce({ conversationId: 'source-2', transport: 'realtime-websocket', text: 'Receive-only source evidence reported.', toolCalls: [] });

    render(<App/>);
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Report the custom firmware evidence and RF authority.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));
    expect(await screen.findByText('Receive-only source evidence reported.')).toBeTruthy();

    const stateOutput = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs?.[0]?.output ?? '';
    expect(stateOutput).toContain('custom-source-qualified-receive-only');
    expect(stateOutput).toContain(ZS407_CUSTOM_RECEIVER_SOURCE_COMMIT);
    expect(stateOutput).toContain(sourceQualifiedFirmwareRecord.warning);
    expect(stateOutput).toContain('"rfOutput":"not-supported"');
    expect(stateOutput).toContain('"features":[]');
  });

  it('invalidates displayed evidence and marks RF state unknown when the active session faults', async () => {
    const { container } = render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Single$/i }));
    await waitFor(() => expect(container.querySelector('[aria-label="Measured power by frequency"]')).toBeTruthy());
    await act(async () => {
      instrumentEventListener?.({ type: 'status', sessionId: ready.sessionId, status: 'faulted', message: 'Transport ownership lost' });
      instrumentEventListener?.({
        type: 'session-state',
        reason: 'session-faulted',
        session: {
          ...ready,
          rfOutput: 'unknown',
          rfOutputQualification: 'unverified',
          fault: { code: 'session-fault', message: 'Transport ownership lost', recoverable: false },
        },
      });
    });
    expect(container.querySelector('[aria-label="Measured power by frequency"]')).toBeNull();
    expect(await screen.findByText('RF UNKNOWN')).toBeTruthy();
    expect(screen.getByText('UNVERIFIED')).toBeTruthy();
    expect(await screen.findByText('Transport ownership lost')).toBeTruthy();
  });

  it('stops the main-owned stream when renderer projection fails synchronously', async () => {
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const connection = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce());
    vi.mocked(window.atomizerInstrument.stopStreaming).mockClear();
    const invalid = {
      ...acquiredMeasurement(requested, 'invalid-projection', configurationRevision),
      frequencyHz: [100, 200],
      powerDbm: [-90, -80],
    };

    await act(async () => { instrumentEventListener?.({ type: 'measurement', measurement: invalid }); });
    await waitFor(() => expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Sweep analysis failed/)).toBeTruthy();
  });

  it('contains a malformed subscribed event and fail-safely stops the active stream', async () => {
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const connection = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce());
    vi.mocked(window.atomizerInstrument.stopStreaming).mockClear();

    await act(async () => {
      expect(() => instrumentEventListener?.({
        type: 'measurement',
        measurement: { kind: 'swept-spectrum' },
      } as never)).not.toThrow();
    });

    await waitFor(() => expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Instrument event rejected at the renderer boundary/i)).toBeTruthy();
    expect(screen.queryByText(/Atomizer could not start/i)).toBeNull();
  });

  it('coalesces an invalid measurement flood into one fail-safe stream stop', async () => {
    let releaseStop: (() => void) | undefined;
    vi.mocked(window.atomizerInstrument.stopStreaming).mockImplementationOnce(() => new Promise((resolve) => {
      releaseStop = () => resolve({ status: 'stopped' });
    }));
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const connection = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce());
    await act(async () => {
      for (let index = 0; index < 64; index++) {
        instrumentEventListener?.({
          type: 'measurement',
          measurement: acquiredMeasurement(requested, `unknown-configuration-${index}`, 'configuration-never-admitted'),
        });
      }
    });

    await waitFor(() => expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledOnce());
    expect(await screen.findByText(/referenced unknown configuration/)).toBeTruthy();
    await act(async () => { releaseStop?.(); });
    await screen.findByRole('button', { name: /^Run$/i });

    await act(async () => {
      instrumentEventListener?.({
        type: 'measurement',
        measurement: acquiredMeasurement(requested, 'stale-after-stop', 'configuration-never-admitted'),
      });
    });
    expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledOnce();
  });

  it('invalidates displayed evidence when the active driver invalidates its configuration', async () => {
    const { container } = render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const connection = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Single$/i }));
    await waitFor(() => expect(container.querySelector('[aria-label="Measured power by frequency"]')).toBeTruthy());

    await act(async () => {
      instrumentEventListener?.({
        type: 'configuration-invalidated',
        sessionId: ready.sessionId,
        reason: 'instrument-mode-changed',
        session: {
          ...ready,
          rfOutput: 'unknown',
          rfOutputQualification: 'unverified',
          configuration: undefined,
        },
      });
    });

    expect(container.querySelector('[aria-label="Measured power by frequency"]')).toBeNull();
    expect(await screen.findByText('RF UNKNOWN')).toBeTruthy();
  });

  it('invalidates an in-flight configuration reservation when its session disconnects', async () => {
    let releaseConfigure: ((value: {
      sessionId: string;
      configurationRevision: string;
      configuration: InstrumentConfiguration;
      configuredAt: string;
    }) => void) | undefined;
    vi.mocked(window.atomizerInstrument.configure).mockImplementationOnce((configuration) => new Promise((resolve) => {
      releaseConfigure = resolve;
      activeConfiguration = structuredClone(configuration);
    }));
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const connection = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Single$/i }));
    await waitFor(() => expect(window.atomizerInstrument.configure).toHaveBeenCalledOnce());

    await act(async () => {
      instrumentEventListener?.({ type: 'disconnected', sessionId: ready.sessionId, driverId: ready.driverId });
      releaseConfigure?.({
        sessionId: ready.sessionId,
        configurationRevision: 'late-old-session-revision',
        configuration: activeConfiguration,
        configuredAt: '2026-07-10T00:00:00.000Z',
      });
    });

    await waitFor(() => expect(window.atomizerInstrument.acquire).not.toHaveBeenCalled());
    expect(await screen.findByText(/configuration response was invalidated with instrument session/i)).toBeTruthy();
  });

  it('renders every implemented atomic instrument workspace without dead affordances', async () => {
    localStorage.setItem('atomizer:v2:measurement-view', JSON.stringify('envelope-stft'));
    const { container } = render(<App/>);
    await waitFor(() => expect(window.atomAgent.status).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const connection = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    const navigation = screen.getByRole('navigation', { name: /Primary navigation/i });
    expect(within(navigation).getAllByRole('button').map((button) => button.textContent?.trim()))
      .toEqual(['Spectrum', 'Waterfall', 'Channel', 'Detect', 'Generate', 'Device']);
    expect(within(navigation).getAllByRole('button', { name: /^Detect$/i })).toHaveLength(1);
    expect(within(navigation).queryByRole('button', { name: /^Classify$/i })).toBeNull();
    expect(navigation.textContent).not.toContain('Sessions');
    expect(navigation.textContent).not.toContain('Settings');
    expect(container.querySelector('.atomic-mark')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(navigation.textContent).not.toContain('Time / STFT');
    const acquisitionRail = screen.getByRole('region', { name: 'Acquisition controls' });
    expect(within(acquisitionRail).getByRole('button', { name: 'Run' })).toBeTruthy();
    expect(within(acquisitionRail).getByRole('button', { name: 'Single' })).toBeTruthy();
    expect(within(navigation).getByRole('button', { name: /^Spectrum$/i }).getAttribute('aria-current')).toBe('page');
    const topViewBar = within(container.querySelector('.measurement-viewbar') as HTMLElement);
    for (const view of ['Spectrum', 'Waterfall', 'Channel']) {
      expect(topViewBar.queryByRole('button', { name: new RegExp(`^${view}$`, 'i') })).toBeNull();
    }
    expect(topViewBar.queryByRole('button', { name: /^(?:Run|Single)$/i })).toBeNull();
    fireEvent.click(within(navigation).getByRole('button', { name: /^Waterfall$/i }));
    expect(await screen.findByLabelText(/Measured power by frequency and sweep time/i)).toBeTruthy();
    fireEvent.click(within(navigation).getByRole('button', { name: /^Channel$/i }));
    expect(await screen.findByText(/Channel setup/i)).toBeTruthy();
    fireEvent.click(within(navigation).getByRole('button', { name: /^Spectrum$/i }));
    fireEvent.click(screen.getByRole('button', { name: /Sweep setup/i }));
    expect(container.querySelector('.acquisition-dock')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Traces & markers/i }));
    const measurementTabs = within(container.querySelector('.measurement-tabs') as HTMLElement);
    for (const control of ['Markers', 'Traces', 'Display']) expect(measurementTabs.getByRole('button', { name: new RegExp(control, 'i') })).toBeTruthy();
    fireEvent.click(measurementTabs.getByRole('button', { name: /Markers/i }));
    expect(await screen.findByRole('button', { name: /^Peak$/i })).toBeTruthy();
    fireEvent.click(measurementTabs.getByRole('button', { name: /Traces/i }));
    expect(await screen.findByText('TRACE 4')).toBeTruthy();
    fireEvent.click(within(navigation).getByRole('button', { name: /^Detect$/i }));
    expect(container.querySelector('.classification-workspace')).not.toBeNull();
    expect(container.querySelector('.detection-workspace')).toBeNull();
    expect(container.querySelector('.envelope-stft-view')).toBeNull();
    await waitFor(() => expect(container.querySelector('.atom-foot')?.textContent).toContain('HIGH'));
    expect(container.querySelector('.atom-foot')?.textContent).toContain('BALLAD');
    for (const workspace of ['Generate', 'Device']) {
      fireEvent.click(within(navigation).getByRole('button', { name: new RegExp(`^${workspace}$`, 'i') }));
      expect(screen.getByRole('region', { name: 'Acquisition controls' })).toBe(acquisitionRail);
      expect(within(acquisitionRail).getByRole('button', { name: 'Run' })).toBeTruthy();
      expect(within(acquisitionRail).getByRole('button', { name: 'Single' })).toBeTruthy();
    }
  });

  it('allows marker 1 and the entire marker bank to remain off', async () => {
    const { container } = render(<App/>);
    fireEvent.click(screen.getByRole('button', { name: /Traces & markers/i }));
    const markerOne = screen.getByRole('button', { name: /Marker 1, hidden, selected/i });
    expect(markerOne.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelectorAll('.marker-selector button.enabled')).toHaveLength(0);
    fireEvent.click(markerOne);
    expect(screen.getByRole('button', { name: /Marker 1, visible, selected/i }).getAttribute('aria-pressed')).toBe('true');
    const visibleMarkerOne = screen.getByRole('button', { name: /Marker 1, visible, selected/i });
    fireEvent.click(visibleMarkerOne);
    expect(screen.getByRole('button', { name: /Marker 1, hidden, selected/i }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /Marker M1 visibility/i }).textContent).toContain('Off');
    expect(container.querySelectorAll('.marker-selector button.enabled')).toHaveLength(0);
  });

  it('has no orphaned agent hooks across every first-class workspace and analysis view', async () => {
    const { container } = render(<App/>);
    const assertRenderedContracts = () => {
      const controls = [...container.querySelectorAll<HTMLElement>('[data-agent-control]')];
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) expect(() => agentControlBinding(control.dataset.agentControl ?? '')).not.toThrow();
      const interactives = [...container.querySelectorAll<HTMLElement>('button,input,select,textarea,details,a[href]')];
      for (const interactive of interactives) expect(interactive.closest('[data-agent-control],[data-agent-exclusion]'), interactive.outerHTML.slice(0, 160)).toBeTruthy();
    };
    assertRenderedContracts();
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    await screen.findByRole('dialog', { name: /Instrument source/i });
    assertRenderedContracts();
    fireEvent.click(screen.getByRole('button', { name: /^Close$/i }));
    const navigation = screen.getByRole('navigation', { name: /Primary navigation/i });
    for (const view of ['Waterfall', 'Channel', 'Spectrum']) {
      fireEvent.click(within(navigation).getByRole('button', { name: new RegExp(`^${view}$`, 'i') }));
      assertRenderedContracts();
    }
    fireEvent.click(screen.getByRole('button', { name: /Sweep setup/i }));
    assertRenderedContracts();
    fireEvent.click(screen.getByRole('button', { name: /Sweep setup/i }));
    fireEvent.click(screen.getByRole('button', { name: /Traces & markers/i }));
    assertRenderedContracts();
    const tabs = within(container.querySelector('.measurement-tabs') as HTMLElement);
    for (const panel of ['Traces', 'Display', 'Markers']) {
      fireEvent.click(tabs.getByRole('button', { name: new RegExp(panel, 'i') }));
      assertRenderedContracts();
    }
    for (const workspace of ['Detect', 'Generate', 'Device', 'Spectrum']) {
      fireEvent.click(within(navigation).getByRole('button', { name: new RegExp(`^${workspace}$`, 'i') }));
      assertRenderedContracts();
    }
  });

  it('connects, configures, and acquires through the complete typed bridge', async () => {
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Single$/i }));
    await waitFor(() => expect(window.atomizerInstrument.acquire).toHaveBeenCalledOnce());
    expect(await screen.findByLabelText('Measured power by frequency')).toBeTruthy();
    expect(window.atomizerInstrument.configure).toHaveBeenCalledBefore(vi.mocked(window.atomizerInstrument.acquire));
  });

  it('pauses, verifies, and resumes continuous acquisition when analyzer settings change', async () => {
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /Sweep setup/i }));
    fireEvent.click(screen.getByRole('button', { name: /2\.4 GHz/i }));
    await waitFor(() => expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledTimes(2));
    expect(window.atomizerInstrument.configure).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'swept-spectrum', startHz: 2_400_000_000, stopHz: 2_500_000_000 }));
  });

  it('keeps navigation and controls live during Run and pause-configure-resumes a true conflict', async () => {
    mockConnectedInstrument();
    render(<App/>);
    const navigation = await screen.findByRole('navigation', { name: /Primary navigation/i });
    await screen.findByText('tinySA Ultra+ ZS407');

    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce());
    expect(await screen.findByRole('button', { name: /^Stop$/i })).toBeTruthy();
    for (const name of ['Spectrum', 'Waterfall', 'Channel', 'Detect', 'Generate', 'Device']) {
      expect(within(navigation).getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).hasAttribute('disabled')).toBe(false);
    }

    fireEvent.click(within(navigation).getByRole('button', { name: /^Generate$/i }));
    const apply = await screen.findByRole('button', { name: /Apply with output off/i });
    expect(apply.hasAttribute('disabled')).toBe(false);
    fireEvent.click(apply);

    await waitFor(() => expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledOnce());
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledTimes(2));
    expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledBefore(vi.mocked(window.atomizerInstrument.executeFeature));
    expect(vi.mocked(window.atomizerInstrument.executeFeature)).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'rf-generator', action: 'configure',
    }));
    expect(await screen.findByRole('button', { name: /^Stop$/i })).toBeTruthy();
  });

  it('waits for late invalidation events before reserving and resuming a SignalLab profile change', async () => {
    mockConnectedInstrument(signalLabSession);
    vi.mocked(window.atomizerInstrument.configure).mockImplementation(async (configuration) => {
      activeConfiguration = structuredClone(configuration);
      configurationRevision = `configuration-${++revisionSequence}`;
      return { sessionId: signalLabSession.sessionId, configurationRevision, configuration, configuredAt: '2026-07-10T00:00:00.000Z' };
    });
    let deliverLifecycle: (() => void) | undefined;
    vi.mocked(window.atomizerInstrument.executeFeature).mockImplementation(async (request) => {
      if (request.kind !== 'signal-lab-profile-selection') throw new Error(`Unexpected feature ${request.kind}`);
      const execution = signalLabFeatureExecution(request);
      deliverLifecycle = () => emitInvalidatingFeatureExecution(
        execution,
        request.action === 'select-profile' ? 'source-profile-changed' : 'source-channel-changed',
      );
      return execution;
    });

    render(<App/>);
    const navigation = await screen.findByRole('navigation', { name: /Primary navigation/i });
    await screen.findByText('SIGNALLAB SIMULATION');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce());
    fireEvent.click(within(navigation).getByRole('button', { name: /^Generate$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^FM/i }));
    await waitFor(() => expect(window.atomizerInstrument.executeFeature).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); });

    expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce();
    expect(screen.getByText(/Pausing continuous acquisition/i)).toBeTruthy();
    await act(async () => { deliverLifecycle?.(); });

    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledTimes(2));
    expect(document.body.textContent).not.toContain('Revision-cache reservation was invalidated');
    expect(screen.queryByText(/SignalLab profile selection failed/i)).toBeNull();
    expect(screen.getByRole('button', { name: /^Stop$/i })).toBeTruthy();
  });

  it('fails closed on a mismatched invalidation receipt and clears the stale pause notice', async () => {
    mockConnectedInstrument(signalLabSession);
    vi.mocked(window.atomizerInstrument.configure).mockImplementation(async (configuration) => {
      activeConfiguration = structuredClone(configuration);
      configurationRevision = `configuration-${++revisionSequence}`;
      return { sessionId: signalLabSession.sessionId, configurationRevision, configuration, configuredAt: '2026-07-10T00:00:00.000Z' };
    });
    let deliverMismatch: (() => void) | undefined;
    vi.mocked(window.atomizerInstrument.executeFeature).mockImplementation(async (request) => {
      if (request.kind !== 'signal-lab-profile-selection') throw new Error(`Unexpected feature ${request.kind}`);
      const execution = signalLabFeatureExecution(request);
      deliverMismatch = () => {
        instrumentEventListener?.({ type: 'feature-result', ...execution });
        instrumentEventListener?.({
          type: 'configuration-invalidated',
          sessionId: execution.session.sessionId,
          reason: 'source-channel-changed',
          session: execution.session,
        });
      };
      return execution;
    });

    render(<App/>);
    const navigation = await screen.findByRole('navigation', { name: /Primary navigation/i });
    await screen.findByText('SIGNALLAB SIMULATION');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce());
    fireEvent.click(within(navigation).getByRole('button', { name: /^Generate$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^FM/i }));
    await waitFor(() => expect(window.atomizerInstrument.executeFeature).toHaveBeenCalledOnce());
    await act(async () => { deliverMismatch?.(); });

    expect(await screen.findByText(/expected source-profile-changed/i)).toBeTruthy();
    expect(screen.queryByText(/Pausing continuous acquisition/i)).toBeNull();
    expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /^Run$/i })).toBeTruthy();
  });

  it('admits Stop during a paused profile transaction and never resumes after the stop intent', async () => {
    mockConnectedInstrument(signalLabSession);
    vi.mocked(window.atomizerInstrument.configure).mockImplementation(async (configuration) => {
      activeConfiguration = structuredClone(configuration);
      configurationRevision = `configuration-${++revisionSequence}`;
      return { sessionId: signalLabSession.sessionId, configurationRevision, configuration, configuredAt: '2026-07-10T00:00:00.000Z' };
    });
    const feature = deferred<AtomizerInstrumentFeatureExecution>();
    vi.mocked(window.atomizerInstrument.executeFeature).mockImplementation((request) => {
      if (request.kind !== 'signal-lab-profile-selection') return Promise.reject(new Error(`Unexpected feature ${request.kind}`));
      return feature.promise;
    });

    render(<App/>);
    const navigation = await screen.findByRole('navigation', { name: /Primary navigation/i });
    await screen.findByText('SIGNALLAB SIMULATION');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce());
    fireEvent.click(within(navigation).getByRole('button', { name: /^Generate$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^FM/i }));
    await waitFor(() => expect(window.atomizerInstrument.executeFeature).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: /^Stop$/i }));
    expect(screen.getByRole('button', { name: /Stopping/i }).hasAttribute('disabled')).toBe(true);
    const execution = signalLabFeatureExecution({ kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: 'fm' });
    await act(async () => {
      feature.resolve(execution);
      await Promise.resolve();
      emitInvalidatingFeatureExecution(execution, 'source-profile-changed');
    });

    await waitFor(() => expect(screen.getByRole('button', { name: /^Run$/i })).toBeTruthy());
    expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('Revision-cache reservation was invalidated');
  });

  it('does not let an old-generation analysis failure stop the replacement retuned stream', async () => {
    let releaseRetuneStop: (() => void) | undefined;
    vi.mocked(window.atomizerInstrument.stopStreaming)
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseRetuneStop = () => resolve({ status: 'stopped' });
      }))
      .mockResolvedValue({ status: 'stopped' });
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: /Sweep setup/i }));
    fireEvent.click(screen.getByRole('button', { name: /2\.4 GHz/i }));
    await waitFor(() => expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledOnce());
    await act(async () => {
      instrumentEventListener?.({
        type: 'measurement',
        measurement: acquiredMeasurement(requested, 'invalid-old-generation', 'configuration-never-admitted'),
      });
    });
    expect(await screen.findByText(/referenced unknown configuration/)).toBeTruthy();
    expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledOnce();

    await act(async () => { releaseRetuneStop?.(); });
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: /^Stop$/i })).toBeTruthy();
  });

  it('compensates an unacknowledged stream start, releases ownership, and permits a clean retry', async () => {
    vi.mocked(window.atomizerInstrument.startStreaming).mockRejectedValueOnce(new Error('stream start was not acknowledged'));
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');

    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledOnce());
    expect(await screen.findByText(/stream start was not acknowledged/i)).toBeTruthy();
    const retry = await screen.findByRole('button', { name: /^Run$/i });
    expect(retry.hasAttribute('disabled')).toBe(false);

    fireEvent.click(retry);
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: /^Stop$/i })).toBeTruthy();
  });

  it('retains ambiguous stream ownership and its revision when start and compensating stop both fail', async () => {
    vi.mocked(window.atomizerInstrument.startStreaming).mockRejectedValueOnce(new Error('stream start acknowledgement lost'));
    vi.mocked(window.atomizerInstrument.stopStreaming)
      .mockRejectedValueOnce(new Error('compensating stop acknowledgement lost'))
      .mockResolvedValue({ status: 'stopped' });
    const { container } = render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');

    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    expect(await screen.findByText(/compensating stop also failed/i)).toBeTruthy();
    const stop = await screen.findByRole('button', { name: /^Stop$/i });

    await act(async () => {
      instrumentEventListener?.({
        type: 'measurement',
        measurement: acquiredMeasurement(configuredAnalyzer, 'ambiguous-start-measurement', configurationRevision),
      });
    });
    expect(container.querySelector('[aria-label="Measured power by frequency"]')).toBeTruthy();

    fireEvent.click(stop);
    await waitFor(() => expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: /^Run$/i })).toBeTruthy();
  });

  it('keeps generator configuration and RF enable in one exclusive ordered transaction', async () => {
    let releaseConfiguration: (() => void) | undefined;
    vi.mocked(window.atomizerInstrument.executeFeature).mockImplementation((request) => {
      if (request.kind !== 'rf-generator') return Promise.reject(new Error(`Unexpected feature ${request.kind}`));
      if (request.action === 'configure') {
        return new Promise((resolve) => {
          releaseConfiguration = () => {
            const execution = {
            result: { ...request, sessionId: ready.sessionId },
            session: { ...ready, rfOutput: 'off', rfOutputQualification: 'firmware-executed-twin' },
            } satisfies AtomizerInstrumentFeatureExecution;
            emitInvalidatingFeatureExecution(execution, 'instrument-mode-changed');
            resolve(execution);
          };
        });
      }
      return Promise.resolve({
        result: { ...request, sessionId: ready.sessionId },
        session: { ...ready, rfOutput: request.enabled ? 'on' : 'off', rfOutputQualification: 'firmware-executed-twin' },
      });
    });
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(within(screen.getByRole('navigation', { name: /Primary navigation/i })).getByRole('button', { name: /Generate/i }));

    fireEvent.click(screen.getByRole('button', { name: /Enable RF output/i }));
    await waitFor(() => expect(window.atomizerInstrument.executeFeature).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'rf-generator', action: 'configure',
    })));
    expect(vi.mocked(window.atomizerInstrument.executeFeature).mock.calls.some(([request]) => request.kind === 'rf-generator' && request.action === 'set-output')).toBe(false);
    expect(screen.getByRole('button', { name: /Apply with output off/i }).hasAttribute('disabled')).toBe(true);

    await act(async () => { releaseConfiguration?.(); });
    await waitFor(() => expect(window.atomizerInstrument.executeFeature).toHaveBeenCalledWith({
      kind: 'rf-generator', action: 'set-output', enabled: true,
    }));
    const calls = vi.mocked(window.atomizerInstrument.executeFeature).mock.invocationCallOrder;
    expect(calls[0]).toBeLessThan(calls[1]!);
    expect(await screen.findByRole('button', { name: /Disable RF output/i })).toBeTruthy();
  });

  it('rejects tap bursts while startup owns the transaction, then admits one bounded tap', async () => {
    let releaseInitialStart: (() => void) | undefined;
    vi.mocked(window.atomizerInstrument.startStreaming)
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseInitialStart = () => resolve({ status: 'running', startedAt: '2026-07-10T00:00:00.000Z' });
      }))
      .mockResolvedValue({ status: 'running', startedAt: '2026-07-10T00:00:01.000Z' });
    vi.mocked(window.atomizerInstrument.executeFeature).mockImplementation(async (request) => {
      if (request.kind !== 'touch') throw new Error(`Unexpected feature ${request.kind}`);
      const execution = { result: { ...request, sessionId: ready.sessionId, accepted: true as const }, session: ready };
      emitInvalidatingFeatureExecution(execution, 'instrument-mode-changed');
      return execution;
    });

    const { container } = render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce());

    fireEvent.click(within(screen.getByRole('navigation', { name: /Primary navigation/i })).getByRole('button', { name: /Device/i }));
    const remoteScreen = await screen.findByLabelText('Connected instrument screen mirror');
    vi.spyOn(remoteScreen, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 480, height: 320 } as DOMRect);
    expect(remoteScreen.getAttribute('aria-disabled')).toBe('true');
    fireEvent.pointerUp(remoteScreen, { clientX: 240, clientY: 160 });
    act(() => {
      for (let index = 0; index < 32; index++) fireEvent.pointerUp(remoteScreen, { clientX: index, clientY: index });
    });

    expect(window.atomizerInstrument.stopStreaming).not.toHaveBeenCalled();
    expect(window.atomizerInstrument.executeFeature).not.toHaveBeenCalled();
    await act(async () => { releaseInitialStart?.(); });
    await waitFor(() => expect(remoteScreen.getAttribute('aria-disabled')).toBe('false'));

    fireEvent.pointerUp(remoteScreen, { clientX: 240, clientY: 160 });
    // The ref-backed one-slot gate closes synchronously, before React can
    // render the busy state, so an event burst cannot accumulate stale taps.
    act(() => {
      for (let index = 0; index < 32; index++) fireEvent.pointerUp(remoteScreen, { clientX: index, clientY: index });
    });
    await waitFor(() => expect(remoteScreen.getAttribute('aria-disabled')).toBe('true'));

    await waitFor(() => expect(window.atomizerInstrument.executeFeature).toHaveBeenCalledWith({ kind: 'touch', action: 'tap', x: 240, y: 160 }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledTimes(2));
    expect(window.atomizerInstrument.executeFeature).toHaveBeenCalledTimes(1);
    expect(window.atomizerInstrument.configure).toHaveBeenCalledTimes(2);
    const firstStart = vi.mocked(window.atomizerInstrument.startStreaming).mock.invocationCallOrder[0]!;
    const stop = vi.mocked(window.atomizerInstrument.stopStreaming).mock.invocationCallOrder[0]!;
    const touch = vi.mocked(window.atomizerInstrument.executeFeature).mock.invocationCallOrder[0]!;
    const resumedConfiguration = vi.mocked(window.atomizerInstrument.configure).mock.invocationCallOrder[1]!;
    const resumedStart = vi.mocked(window.atomizerInstrument.startStreaming).mock.invocationCallOrder[1]!;
    expect(firstStart).toBeLessThan(stop);
    expect(stop).toBeLessThan(touch);
    expect(touch).toBeLessThan(resumedConfiguration);
    expect(resumedConfiguration).toBeLessThan(resumedStart);

    await act(async () => {
      instrumentEventListener?.({ type: 'measurement', measurement: acquiredMeasurement(configuredAnalyzer, 'after-remote-tap', configurationRevision) });
    });
    fireEvent.click(within(screen.getByRole('navigation', { name: /Primary navigation/i })).getByRole('button', { name: /Spectrum/i }));
    expect(container.querySelector('[aria-label="Measured power by frequency"]')).toBeTruthy();
  });

  it('merges numeric frequency edits into the latest staged state before Run', async () => {
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const connection = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /Sweep setup/i }));

    fireEvent.click(screen.getByLabelText('Edit Stop frequency'));
    let editor = screen.getByRole('dialog', { name: /Stop frequency numeric entry/i });
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Stop frequency' }), { target: { value: '2500' } });
    fireEvent.click(within(editor).getByRole('button', { name: /^Apply MHz$/i }));

    fireEvent.click(screen.getByLabelText('Edit Start frequency'));
    editor = screen.getByRole('dialog', { name: /Start frequency numeric entry/i });
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Start frequency' }), { target: { value: '2400' } });
    fireEvent.click(within(editor).getByRole('button', { name: /^Apply MHz$/i }));

    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce());
    expect(window.atomizerInstrument.configure).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'swept-spectrum', startHz: 2_400_000_000, stopHz: 2_500_000_000 }));
  });

  it('quarantines an in-flight sweep after a staged span supersedes it', async () => {
    let releaseStop: (() => void) | undefined;
    vi.mocked(window.atomizerInstrument.stopStreaming).mockImplementationOnce(() => new Promise((resolve) => { releaseStop = () => resolve({ status: 'stopped' }); }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { container } = render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const connection = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledOnce());
    const streamingRevision = configurationRevision;
    await act(async () => { instrumentEventListener?.({ type: 'measurement', measurement: acquiredMeasurement(requested, 'current-fm', streamingRevision) }); });
    expect(container.querySelector('[aria-label="Measured power by frequency"]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Sweep setup/i }));
    fireEvent.click(screen.getByRole('button', { name: /2\.4 GHz/i }));
    await waitFor(() => expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledOnce());
    await act(async () => { instrumentEventListener?.({ type: 'measurement', measurement: acquiredMeasurement(requested, 'late-fm', streamingRevision) }); });
    expect(container.querySelector('[aria-label="Measured power by frequency"]')).toBeNull();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('rejected stale sweep'), expect.objectContaining({ sweepId: 'late-fm' }));

    await act(async () => { releaseStop?.(); });
    await waitFor(() => expect(window.atomizerInstrument.configure).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'swept-spectrum', startHz: 2_400_000_000, stopHz: 2_500_000_000 })));
    warning.mockRestore();
  });

  it('offers explicit host trace Off without inventing firmware overlays', async () => {
    const { container } = render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const connection = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Single$/i }));
    await waitFor(() => expect(window.atomizerInstrument.acquire).toHaveBeenCalledOnce());
    expect(container.querySelector('.firmware-trace')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Traces & markers/i }));
    fireEvent.click(within(container.querySelector('.measurement-tabs') as HTMLElement).getByRole('button', { name: /Traces/i }));
    const traceToggle = screen.getByRole('button', { name: /Trace 1.*On/i });
    fireEvent.click(traceToggle);
    await waitFor(() => expect(screen.getByRole('button', { name: /Trace 1.*Off/i })).toBeTruthy());
    await waitFor(() => expect(container.querySelector('.trace-line.t1')).toBeNull());
    expect(screen.queryByRole('button', { name: /D2 · Stored/i })).toBeNull();
  });

  it('lets Atom list, connect, verify, and acquire through typed tools', async () => {
    let discoveryCount = 0;
    vi.mocked(window.atomizerInstrument.discover).mockImplementation(async () => {
      discoveryCount++;
      return {
        discoveryRevision: `dynamic-${discoveryCount}`,
        discoveredAt: '2026-07-10T00:00:00.000Z',
        candidates: [{ ...candidate, discoveryRevision: `dynamic-${discoveryCount}` }],
        failures: [],
      };
    });
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'r0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'load-1', name: 'load_atom_tools', arguments: '{"toolNames":["list_connection_candidates","connect_device","get_instrument_state","configure_analyzer","acquire_sweep"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'r1', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'c1', name: 'list_connection_candidates', arguments: '{}' }] })
      .mockResolvedValueOnce({ conversationId: 'r2', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'c2', name: 'connect_device', arguments: '{"candidateId":"candidate-1"}' }] })
      .mockResolvedValueOnce({ conversationId: 'r3', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'c3', name: 'get_instrument_state', arguments: '{}' }] })
      .mockResolvedValueOnce({ conversationId: 'r4', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'c4', name: 'configure_analyzer', arguments: '{"startHz":93000000,"stopHz":95000000}' }] })
      .mockResolvedValueOnce({ conversationId: 'r5', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'c5', name: 'acquire_sweep', arguments: '{}' }] })
      .mockResolvedValueOnce({ conversationId: 'r6', transport: 'realtime-websocket', text: 'Sweep complete.', toolCalls: [], usage: { totalTokens: 1_200, inputTokens: 1_000, outputTokens: 200, cachedTokens: 640 }, rateLimits: [{ name: 'tokens', limit: 200_000, remaining: 190_000, resetSeconds: 60 }] });

    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Connect the simulator and acquire one sweep.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomizerInstrument.connect).toHaveBeenCalledWith({ ...candidate, discoveryRevision: 'dynamic-3' }));
    expect(window.atomizerInstrument.discover).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(window.atomizerInstrument.acquire).toHaveBeenCalledOnce());
    expect(window.atomizerInstrument.configure).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'swept-spectrum', startHz: 93_000_000, stopHz: 95_000_000, points: 450,
      controls: expect.objectContaining({ model: 'receiver' }),
    }));
    expect(await screen.findByText('Sweep complete.')).toBeTruthy();
    expect(await screen.findByText(/TPM 10K\/200K/)).toBeTruthy();
    const candidateOutput = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs?.[0]?.output ?? '';
    expect(candidateOutput).toContain('candidate-1');
    expect(candidateOutput).toContain('"simulated":true');
    expect(candidateOutput).not.toContain('repositoryCommit');
    expect(candidateOutput).not.toContain(COMMIT);
  });

  it('lets Atom recover from an empty trace and place a peak marker on SignalLab CW through typed tools', async () => {
    const source = mockSignalLabCwSource();
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'marker-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'marker-load', name: 'load_atom_tools', arguments: '{"toolNames":["acquire_sweep","search_marker"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'marker-1', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'marker-empty', name: 'search_marker', arguments: '{"markerId":1,"action":"peak"}' }] })
      .mockResolvedValueOnce({ conversationId: 'marker-2', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'marker-acquire', name: 'acquire_sweep', arguments: '{}' }] })
      .mockResolvedValueOnce({ conversationId: 'marker-3', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'marker-peak', name: 'search_marker', arguments: '{"markerId":1,"action":"peak"}' }] })
      .mockResolvedValueOnce({ conversationId: 'marker-4', transport: 'realtime-websocket', text: 'CW peak marker placed.', toolCalls: [] });

    render(<App/>);
    expect(await screen.findByText('SIGNALLAB SIMULATION')).toBeTruthy();
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Place marker 1 on the CW peak.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(5));
    const emptyTraceResult = JSON.parse(vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs?.[0]?.output ?? '{}') as { ok?: boolean; error?: string };
    expect(emptyTraceResult.ok).toBe(false);
    expect(emptyTraceResult.error).toMatch(/Trace 1 has no data/);
    const peakResult = JSON.parse(vi.mocked(window.atomAgent.agentTurn).mock.calls[4]?.[0].toolOutputs?.[0]?.output ?? '{}') as { ok?: boolean; output?: { markerId?: number; action?: string; frequencyHz?: number; reading?: { localCharacterization?: { widthClassification?: string; peakToRobustFloorDb?: number; physicalDetection?: { detectionState?: string; relationship?: string }; threeDecibelBandwidth?: { status?: string; bandwidthHz?: number }; componentOccupiedBandwidth?: { percent?: number; bandwidthHz?: number; noiseCorrection?: string } } } } };
    expect(peakResult.ok, JSON.stringify(peakResult)).toBe(true);
    expect(peakResult.output).toMatchObject({ markerId: 1, action: 'peak' });
    expect(peakResult.output?.frequencyHz).toBe(source.expectedPeakHz[0]);
    expect(peakResult.output?.reading?.localCharacterization).toMatchObject({
      widthClassification: 'resolution-limited-narrow',
      physicalDetection: { detectionState: 'candidate', relationship: 'contains-local-peak' },
      threeDecibelBandwidth: { status: 'resolution-limited' },
      componentOccupiedBandwidth: { percent: 99, noiseCorrection: 'robust-floor' },
    });
    expect(peakResult.output?.reading?.localCharacterization?.peakToRobustFloorDb).toBeGreaterThan(10);
    expect(await screen.findByText('CW peak marker placed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Traces & markers/i }));
    expect(screen.getByRole('button', { name: /Marker 1, visible, selected/i })).toBeTruthy();
    expect(screen.getAllByText(/Narrow · resolution limited/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/peak-to-floor/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/99% component occupied bandwidth/i)).toBeTruthy();
  });

  it('keeps Atom, stored marker state, readout, and diamond on the same fractional SignalLab TM3.1 center bin', async () => {
    const source = mockSignalLabWidebandSource('lte-etm3.1');
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    const toolCalls = [
      { callId: 'tm31-configure', name: 'configure_analyzer', arguments: JSON.stringify({ startHz: source.range.startHz, stopHz: source.range.stopHz, points: 450 }) },
      { callId: 'tm31-acquire', name: 'acquire_sweep', arguments: '{}' },
      { callId: 'tm31-search', name: 'search_marker', arguments: '{"markerId":1,"action":"peak"}' },
      { callId: 'tm31-state', name: 'get_measurement_state', arguments: '{}' },
    ];
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'tm31-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'tm31-load', name: 'load_atom_tools', arguments: '{"toolNames":["configure_analyzer","acquire_sweep","search_marker","get_measurement_state"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'tm31-1', transport: 'realtime-websocket', text: '', toolCalls })
      .mockResolvedValueOnce({ conversationId: 'tm31-2', transport: 'realtime-websocket', text: 'TM3.1 center marker placed.', toolCalls: [] });

    render(<App/>);
    expect(await screen.findByText('SIGNALLAB SIMULATION')).toBeTruthy();
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Acquire LTE TM3.1 and place M1 on its channel center.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const outputs = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs ?? [];
    expect(outputs).toHaveLength(4);
    const results = outputs.map(({ output }) => JSON.parse(output) as {
      ok?: boolean;
      output?: {
        frequencyHz?: number;
        reading?: { frequencyHz?: number; localCharacterization?: { markerCenterMethod?: string } };
        markers?: {
          configurations?: Array<{ id?: number; frequencyHz?: number }>;
          readings?: Array<{ markerId?: number; frequencyHz?: number }>;
        };
      };
    });
    expect(results.every((result) => result.ok), JSON.stringify(results)).toBe(true);
    const search = results[2]!.output!;
    const frequencyHz = search.frequencyHz!;
    expect(Number.isInteger(frequencyHz)).toBe(false);
    expect(search.reading?.frequencyHz).toBe(frequencyHz);
    expect(search.reading?.localCharacterization?.markerCenterMethod)
      .toBe('resolved-component-linear-power-centroid');
    const binWidthHz = (source.range.stopHz - source.range.startHz) / 449;
    expect(Math.abs(frequencyHz - source.descriptor.centerHz)).toBeLessThanOrEqual(binWidthHz / 2 + 1e-6);
    expect(frequencyHz).not.toBe(source.rawPeakHz[0]);
    const state = results[3]!.output!;
    expect(state.markers?.configurations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 1, frequencyHz }),
    ]));
    expect(state.markers?.readings).toEqual(expect.arrayContaining([
      expect.objectContaining({ markerId: 1, frequencyHz }),
    ]));

    const diamond = await screen.findByTestId('marker-m1-diamond');
    const overlayItem = diamond.closest('.plot-marker-overlay-item');
    expect(overlayItem?.getAttribute('aria-label')).toMatch(/noise-subtracted linear-power center.*centroid/i);
    const leftPercent = (frequencyHz - source.range.startHz) / (source.range.stopHz - source.range.startHz) * 100;
    expect(Number.parseFloat((overlayItem as HTMLElement).style.left)).toBeCloseTo(leftPercent, 10);
    expect(screen.getByTestId('marker-readout-gutter').textContent).toMatch(/noise-subtracted linear-power center.*centroid/i);
  });

  it('keeps the app live while Atom repeats acquire then peak-marker search through the maximum bounded tool chain', async () => {
    expect(ATOM_REALTIME_TOOL_CALL_LIMIT % 2).toBe(0);
    const cycleCount = ATOM_REALTIME_TOOL_CALL_LIMIT / 2;
    const source = mockSignalLabCwSource(Array.from({ length: cycleCount }, (_value, index) => 220 + index));
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    let turnIndex = 0;
    vi.mocked(window.atomAgent.agentTurn).mockImplementation(async () => {
      const current = turnIndex++;
      if (current === 0) {
        return { conversationId: 'marker-soak-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'marker-soak-load', name: 'load_atom_tools', arguments: '{"toolNames":["acquire_sweep","search_marker"]}' }] };
      }
      if (current <= ATOM_REALTIME_TOOL_CALL_LIMIT) {
        const toolIndex = current - 1;
        const cycle = Math.floor(toolIndex / 2);
        const acquire = toolIndex % 2 === 0;
        return {
          conversationId: `marker-soak-${current}`,
          transport: 'realtime-websocket', text: '',
          toolCalls: [acquire
            ? { callId: `marker-soak-acquire-${cycle}`, name: 'acquire_sweep', arguments: '{}' }
            : { callId: `marker-soak-peak-${cycle}`, name: 'search_marker', arguments: '{"markerId":1,"action":"peak"}' }],
        };
      }
      return { conversationId: `marker-soak-${current}`, transport: 'realtime-websocket', text: 'Repeated CW peak placement complete.', toolCalls: [] };
    });

    render(<App/>);
    expect(await screen.findByText('SIGNALLAB SIMULATION')).toBeTruthy();
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Repeatedly acquire and place M1 on each CW peak.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(ATOM_REALTIME_TOOL_CALL_LIMIT + 2));
    expect(source.acquisitionCount()).toBe(cycleCount);
    expect(window.atomizerInstrument.acquire).toHaveBeenCalledTimes(cycleCount);
    const peakFrequencies = vi.mocked(window.atomAgent.agentTurn).mock.calls
      .flatMap(([request]) => request.toolOutputs ?? [])
      .map(({ output }) => JSON.parse(output) as { ok?: boolean; output?: { action?: string; frequencyHz?: number } })
      .filter((result) => result.ok && result.output?.action === 'peak')
      .map((result) => result.output!.frequencyHz);
    expect(peakFrequencies).toEqual(source.expectedPeakHz);
    expect(await screen.findByText('Repeated CW peak placement complete.')).toBeTruthy();
    const send = screen.getByRole('button', { name: /Send to Atom/i });
    fireEvent.change(composer, { target: { value: 'Confirm the app is still responsive.' } });
    await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Traces & markers/i }));
    expect(screen.getByRole('button', { name: /Marker 1, visible, selected/i })).toBeTruthy();
  });

  it('uses one synchronous controller snapshot across an eight-call configure, acquire, search, and getter response', async () => {
    const source = mockSignalLabCwSource();
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    const toolCalls = [
      { callId: 'sync-trace', name: 'configure_trace', arguments: '{"id":2,"mode":"clear-write","averageCount":8}' },
      { callId: 'sync-marker', name: 'configure_marker', arguments: '{"id":1,"enabled":true,"traceId":2,"mode":"normal","frequencyHz":90000000,"tracking":"fixed"}' },
      { callId: 'sync-search-config', name: 'configure_marker_search', arguments: '{"minimumLevelDbm":-60,"minimumExcursionDb":5}' },
      { callId: 'sync-detector', name: 'configure_signal_detector', arguments: '{"threshold":{"strategy":"absolute","levelDbm":-60},"minimumBandwidthHz":0,"minimumProminenceDb":6,"minimumConsecutiveSweeps":1,"releaseAfterMissedSweeps":2}' },
      { callId: 'sync-acquire', name: 'acquire_sweep', arguments: '{}' },
      { callId: 'sync-search', name: 'search_marker', arguments: '{"markerId":1,"action":"peak"}' },
      { callId: 'sync-detections', name: 'get_detection_results', arguments: '{}' },
      { callId: 'sync-measurement', name: 'get_measurement_state', arguments: '{}' },
    ];
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'sync-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'sync-load', name: 'load_atom_tools', arguments: '{"toolNames":["configure_trace","configure_marker","configure_marker_search","configure_signal_detector","acquire_sweep","search_marker","get_detection_results","get_measurement_state"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'sync-1', transport: 'realtime-websocket', text: '', toolCalls })
      .mockResolvedValueOnce({ conversationId: 'sync-2', transport: 'realtime-websocket', text: 'Synchronous chain complete.', toolCalls: [] });

    render(<App/>);
    expect(await screen.findByText('SIGNALLAB SIMULATION')).toBeTruthy();
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Configure and inspect in one response.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const outputs = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs ?? [];
    expect(outputs).toHaveLength(8);
    const results = outputs.map(({ output }) => JSON.parse(output) as { ok?: boolean; output?: Record<string, unknown>; error?: string });
    expect(results.every((result) => result.ok), JSON.stringify(results)).toBe(true);
    expect(results[5]?.output).toMatchObject({ markerId: 1, action: 'peak', frequencyHz: source.expectedPeakHz[0] });
    expect(results[6]?.output).toMatchObject({ localDetections: expect.arrayContaining([expect.objectContaining({ state: 'active' })]) });
    expect(results[7]?.output).toMatchObject({
      traces: expect.arrayContaining([expect.objectContaining({ id: 2, mode: 'clear-write', sweepCount: 1 })]),
      markers: { configurations: expect.arrayContaining([expect.objectContaining({ id: 1, traceId: 2 })]) },
      markerSearch: { minimumLevelDbm: -60, minimumExcursionDb: 5 },
    });
  });

  it('canonicalizes Agent detector configuration to the merged classification workspace', async () => {
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'detector-route-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'detector-route-load', name: 'load_atom_tools', arguments: '{"toolNames":["configure_signal_detector","get_application_state"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'detector-route-1', transport: 'realtime-websocket', text: '', toolCalls: [
        { callId: 'detector-route-configure', name: 'configure_signal_detector', arguments: '{"threshold":{"strategy":"absolute","levelDbm":-60},"minimumBandwidthHz":0,"minimumProminenceDb":6,"minimumConsecutiveSweeps":1,"releaseAfterMissedSweeps":2}' },
        { callId: 'detector-route-state', name: 'get_application_state', arguments: '{}' },
      ] })
      .mockResolvedValueOnce({ conversationId: 'detector-route-2', transport: 'realtime-websocket', text: 'Detector workspace ready.', toolCalls: [] });

    render(<App/>);
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Open the detector controls.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const state = JSON.parse(vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs?.[1]?.output ?? '{}') as { ok?: boolean; output?: { workspace?: string } };
    expect(state).toMatchObject({ ok: true, output: { workspace: 'classification' } });
  });

  it('canonicalizes the legacy detection route in both mutation and same-response state', async () => {
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'legacy-route-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'legacy-route-load', name: 'load_atom_tools', arguments: '{"toolNames":["navigate_workspace","get_application_state"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'legacy-route-1', transport: 'realtime-websocket', text: '', toolCalls: [
        { callId: 'legacy-route-navigate', name: 'navigate_workspace', arguments: '{"workspace":"detection"}' },
        { callId: 'legacy-route-state', name: 'get_application_state', arguments: '{}' },
      ] })
      .mockResolvedValueOnce({ conversationId: 'legacy-route-2', transport: 'realtime-websocket', text: 'Merged workspace ready.', toolCalls: [] });

    render(<App/>);
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Open the legacy detector route.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const outputs = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs ?? [];
    const results = outputs.map(({ output }) => JSON.parse(output) as { ok?: boolean; output?: { workspace?: string } });
    expect(results).toEqual([
      expect.objectContaining({ ok: true, output: { workspace: 'classification' } }),
      expect.objectContaining({ ok: true, output: expect.objectContaining({ workspace: 'classification' }) }),
    ]);
  });

  it('does not leave a phantom render revision when navigation is already current', async () => {
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.computerScreenshot).mockResolvedValue({ kind: 'atomizer-screenshot', screenshotId: '123e4567-e89b-42d3-a456-426614174000', imageDataUrl: 'data:image/jpeg;base64,aW1hZ2U=', width: 1200, height: 800, capturedAt: '2026-07-10T00:00:00.000Z', focusedTarget: 'APPLICATION' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'noop-route-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'noop-route-load', name: 'load_atom_tools', arguments: '{"toolNames":["navigate_workspace","computer_screenshot"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'noop-route-1', transport: 'realtime-websocket', text: '', toolCalls: [
        { callId: 'noop-route-navigate', name: 'navigate_workspace', arguments: '{"workspace":"spectrum"}' },
        { callId: 'noop-route-screenshot', name: 'computer_screenshot', arguments: '{}' },
      ] })
      .mockResolvedValueOnce({ conversationId: 'noop-route-2', transport: 'realtime-websocket', text: 'Spectrum confirmed.', toolCalls: [] });

    render(<App/>);
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Stay on spectrum and inspect it.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const outputs = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs ?? [];
    const results = outputs.map(({ output }) => JSON.parse(output) as { ok?: boolean });
    expect(results.every((result) => result.ok)).toBe(true);
    expect(window.atomAgent.computerScreenshot).toHaveBeenCalledOnce();
  });

  it('never reapplies stale RF settings when configure and output commands share one response', async () => {
    mockConnectedInstrument();
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'rf-sync-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'rf-sync-load', name: 'load_atom_tools', arguments: '{"toolNames":["configure_generator","set_rf_output","get_application_state"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'rf-sync-1', transport: 'realtime-websocket', text: '', toolCalls: [
        { callId: 'rf-sync-configure', name: 'configure_generator', arguments: '{"frequencyHz":123000000,"levelDbm":-40,"path":"normal","modulation":"off","modulationFrequencyHz":1000,"amDepthPercent":50,"fmDeviationHz":25000}' },
        { callId: 'rf-sync-output', name: 'set_rf_output', arguments: '{"enabled":false}' },
        { callId: 'rf-sync-state', name: 'get_application_state', arguments: '{}' },
      ] })
      .mockResolvedValueOnce({ conversationId: 'rf-sync-2', transport: 'realtime-websocket', text: 'RF chain complete.', toolCalls: [] });

    render(<App/>);
    expect(await screen.findByText('tinySA Ultra+ ZS407')).toBeTruthy();
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Configure RF then keep output off.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const configureRequests = vi.mocked(window.atomizerInstrument.executeFeature).mock.calls
      .map(([request]) => request)
      .filter((request) => request.kind === 'rf-generator' && request.action === 'configure');
    expect(configureRequests).toHaveLength(2);
    expect(configureRequests).toEqual(configureRequests.map(() => expect.objectContaining({ frequencyHz: 123_000_000, levelDbm: -40, path: 'normal', modulation: { mode: 'off' } })));
    expect(window.atomizerInstrument.executeFeature).toHaveBeenLastCalledWith({ kind: 'rf-generator', action: 'set-output', enabled: false });
    const state = JSON.parse(vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs?.[2]?.output ?? '{}') as { ok?: boolean; output?: { generator?: { frequencyHz?: number } } };
    expect(state).toMatchObject({ ok: true, output: { generator: { frequencyHz: 123_000_000 } } });
  });

  it('uses a just-acquired sweep for channel, autoscale, export, then commits navigation before screenshot and inspect', async () => {
    mockConnectedInstrument();
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.computerScreenshot).mockImplementation(async () => {
      expect(document.querySelector('.classification-workspace')).toBeTruthy();
      return { kind: 'atomizer-screenshot', screenshotId: '123e4567-e89b-42d3-a456-426614174000', imageDataUrl: 'data:image/jpeg;base64,aW1hZ2U=', width: 1200, height: 800, capturedAt: '2026-07-10T00:00:00.000Z', focusedTarget: 'APPLICATION' };
    });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'view-sync-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'view-sync-load', name: 'load_atom_tools', arguments: '{"toolNames":["acquire_sweep","configure_channel_measurement","get_channel_measurement_results","auto_scale_spectrum_display","export_latest_sweep","navigate_workspace","computer_screenshot","inspect_interface"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'view-sync-1', transport: 'realtime-websocket', text: '', toolCalls: [
        { callId: 'view-sync-acquire', name: 'acquire_sweep', arguments: '{}' },
        { callId: 'view-sync-channel-config', name: 'configure_channel_measurement', arguments: '{"centerHz":98000000,"mainBandwidthHz":1000000,"adjacentBandwidthHz":1000000,"channelSpacingHz":2000000,"adjacentChannelCount":1,"occupiedPowerPercent":99,"obwNoiseCorrection":"none"}' },
        { callId: 'view-sync-channel-read', name: 'get_channel_measurement_results', arguments: '{}' },
        { callId: 'view-sync-scale', name: 'auto_scale_spectrum_display', arguments: '{}' },
        { callId: 'view-sync-export', name: 'export_latest_sweep', arguments: '{"format":"json"}' },
        { callId: 'view-sync-navigate', name: 'navigate_workspace', arguments: '{"workspace":"classification"}' },
        { callId: 'view-sync-screenshot', name: 'computer_screenshot', arguments: '{}' },
        { callId: 'view-sync-inspect', name: 'inspect_interface', arguments: '{}' },
      ] })
      .mockResolvedValueOnce({ conversationId: 'view-sync-2', transport: 'realtime-websocket', text: 'View chain complete.', toolCalls: [] });

    render(<App/>);
    expect(await screen.findByText('tinySA Ultra+ ZS407')).toBeTruthy();
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Acquire, inspect, export, and show classification.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const outputs = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs ?? [];
    const results = outputs.map(({ output }) => JSON.parse(output) as { ok?: boolean; output?: Record<string, unknown>; error?: string });
    expect(results.every((result) => result.ok), JSON.stringify(results)).toBe(true);
    expect(results[2]?.output).toMatchObject({
      carrier: { startHz: 97_500_000, stopHz: 98_500_000, bandwidthHz: 1_000_000 },
      adjacent: expect.arrayContaining([expect.objectContaining({ bandwidthHz: 1_000_000 })]),
    });
    expect(window.atomizerFiles.exportSweep).toHaveBeenCalledWith({ sweep: expect.objectContaining({ id: 'runtime-sweep' }), format: 'json' });
    expect(window.atomAgent.computerScreenshot).toHaveBeenCalledOnce();
    expect(results[7]?.output).toMatchObject({ activeWorkspace: 'classification' });
  });

  it('restores the swept-spectrum configuration after an Atom detected-power capture', async () => {
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'z0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'z-load', name: 'load_atom_tools', arguments: '{"toolNames":["list_connection_candidates","connect_device","acquire_zero_span"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'z1', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'z-list', name: 'list_connection_candidates', arguments: '{}' }] })
      .mockResolvedValueOnce({ conversationId: 'z2', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'z-connect', name: 'connect_device', arguments: '{"candidateId":"candidate-1"}' }] })
      .mockResolvedValueOnce({ conversationId: 'z3', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'z-capture', name: 'acquire_zero_span', arguments: '{}' }] })
      .mockResolvedValueOnce({ conversationId: 'z4', transport: 'realtime-websocket', text: 'Envelope captured and swept analyzer restored.', toolCalls: [] });

    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Connect and capture the envelope.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomizerInstrument.acquire).toHaveBeenCalledOnce());
    await waitFor(() => expect(window.atomizerInstrument.configure).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'swept-spectrum', startHz: 88_000_000, stopHz: 108_000_000, points: 450,
      controls: expect.objectContaining({ model: 'receiver' }),
    })));
    expect(vi.mocked(window.atomizerInstrument.acquire).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(window.atomizerInstrument.configure).mock.invocationCallOrder.at(-1)!);
  });

  it('returns a blocked app-computer action to Atom as a failed tool result', async () => {
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.computerClick).mockResolvedValue({ ok: false, action: 'click', target: 'atom.microphone-mute', reason: 'This control is a local human-only boundary' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'c0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'load-click', name: 'load_atom_tools', arguments: '{"toolNames":["computer_click"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'c1', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'blocked-click', name: 'computer_click', arguments: '{"screenshotId":"123e4567-e89b-42d3-a456-426614174000","x":100,"y":100}' }] })
      .mockResolvedValueOnce({ conversationId: 'c2', transport: 'realtime-websocket', text: 'That control is human-only.', toolCalls: [] });

    render(<App/>);
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Click the microphone mute control.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const output = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs?.[0]?.output ?? '';
    expect(output).toContain('"ok":false');
    expect(output).toContain('human-only boundary');
  });
});
