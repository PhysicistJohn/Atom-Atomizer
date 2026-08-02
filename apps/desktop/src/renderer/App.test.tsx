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
import { ClassificationController } from './controllers/classification.js';

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
let activeConfiguration: InstrumentConfiguration = receiverSpectrumConfiguration(requested);
let configurationRevision = 'configuration-0';
let measurementSequence = 0;
let instrumentEventListener: ((event: AtomizerInstrumentEvent) => void) | undefined;

/**
 * The renderer only acquires from a configuration that the driver has already
 * admitted.  Keep App-level tests on that public contract instead of making
 * the renderer fabricate a source-specific `configure()` request.
 */
function withAdmittedConfiguration(
  session: InstrumentSessionSnapshot,
  configuration: InstrumentConfiguration = activeConfiguration,
  revision = configurationRevision,
): InstrumentSessionSnapshot {
  return {
    ...session,
    configuration: {
      sessionId: session.sessionId,
      configurationRevision: revision,
      configuration: structuredClone(configuration),
      configuredAt: '2026-08-01T00:00:00.000Z',
    },
  };
}

function acquiredMeasurement(config: AnalyzerConfig, id = 'runtime-sweep', revision = configurationRevision): Extract<InstrumentMeasurement, { kind: 'swept-spectrum' }> {
  const frequencyHz = Array.from({ length: config.points }, (_, index) => config.startHz + index * ((config.stopHz - config.startHz) / Math.max(1, config.points - 1)));
  return { schemaVersion: 1, kind: 'swept-spectrum', measurementId: id, sessionId: ready.sessionId, configurationRevision: revision, sequence: ++measurementSequence, capturedAt: '2026-07-10T00:00:00.000Z', elapsedMilliseconds: 42, resolutionBandwidthHz: 10_000, attenuationDb: 0, qualification: 'firmware-executed-twin', complete: true, frequencyHz, powerDbm: Array.from({ length: config.points }, (_, index) => index === Math.floor(config.points / 2) ? -50 : -90) };
}

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

function mockConnectedInstrument(session: InstrumentSessionSnapshot = ready): void {
  vi.mocked(window.atomizerInstrument.getState).mockResolvedValue({
    schemaVersion: 1,
    startup: { status: 'connected', connectedAt: '2026-07-10T00:00:00.000Z' },
    streaming: { status: 'stopped' },
    connectionCleanup: { status: 'not-required' },
    preference: { source: 'persisted', preference: { schemaVersion: 1, driverId: session.driverId, candidateKind: session.candidate.sourceKind, candidateId: session.candidate.candidateId, updatedAt: '2026-07-10T00:00:00.000Z' } },
    session: withAdmittedConfiguration(session),
  });
  vi.mocked(window.atomizerInstrument.discover).mockResolvedValue({
    discoveryRevision: session.candidate.discoveryRevision,
    discoveredAt: '2026-07-10T00:00:00.000Z',
    candidates: [session.candidate],
    failures: [],
  });
}

async function flushMicrotasks(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
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

afterEach(() => { vi.useRealTimers(); cleanup(); localStorage.clear(); });

beforeEach(() => {
  activeConfiguration = receiverSpectrumConfiguration(requested);
  configurationRevision = 'configuration-0';
  measurementSequence = 0;
  instrumentEventListener = undefined;
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fillStyle: '', strokeStyle: '', lineWidth: 1,
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  let currentInstrumentState: AtomizerInstrumentState = {
    schemaVersion: 1,
    startup: { status: 'not-started' },
    streaming: { status: 'stopped' },
    connectionCleanup: { status: 'not-required' },
    preference: { source: 'persisted', preference: { schemaVersion: 1, driverId: candidate.driverId, candidateKind: candidate.sourceKind, updatedAt: '2026-07-10T00:00:00.000Z' } },
  };
  window.atomizerInstrument = {
    version: 1,
    getState: vi.fn().mockImplementation(async () => currentInstrumentState),
    discover: vi.fn().mockResolvedValue({ discoveryRevision: 'discovery-1', discoveredAt: '2026-07-10T00:00:00.000Z', candidates: [candidate], failures: [] }),
    connect: vi.fn().mockImplementation(async () => {
      const session = withAdmittedConfiguration(ready);
      currentInstrumentState = {
        ...currentInstrumentState,
        startup: { status: 'connected', connectedAt: '2026-07-10T00:00:00.000Z' },
        session,
      };
      return session;
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    configure: vi.fn().mockRejectedValue(new Error('Renderer configuration is not configured for this test')),
    acquire: vi.fn().mockImplementation(async () => {
      if (activeConfiguration.kind !== 'swept-spectrum') throw new Error('Spectrum acquisition requires an admitted spectrum configuration');
      return acquiredMeasurement(requested);
    }),
    startStreaming: vi.fn().mockResolvedValue({ status: 'running', startedAt: '2026-07-10T00:00:00.000Z' }),
    stopStreaming: vi.fn().mockResolvedValue({ status: 'stopped' }),
    executeFeature: vi.fn().mockRejectedValue(new Error('Feature execution is not configured for this test')),
    readPreference: vi.fn().mockResolvedValue({ source: 'persisted', preference: { schemaVersion: 1, driverId: candidate.driverId, candidateKind: candidate.sourceKind, updatedAt: '2026-07-10T00:00:00.000Z' } }),
    writePreference: vi.fn().mockImplementation(async (selection) => ({ source: 'persisted', preference: { schemaVersion: 1, ...selection, updatedAt: '2026-07-10T00:00:00.000Z' } })),
    addManualEndpoint: vi.fn().mockResolvedValue({ ok: true }),
    subscribe: vi.fn().mockImplementation((listener: (event: AtomizerInstrumentEvent) => void) => { instrumentEventListener = listener; return vi.fn(); }),
  };
  window.atomizerFiles = {
    version: 1,
    exportSweep: vi.fn().mockResolvedValue({ status: 'cancelled', format: 'csv' }),
    exportComplexIq: vi.fn().mockResolvedValue({ status: 'cancelled' }),
  };
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
    expect(await screen.findByText(candidate.displayName)).toBeTruthy();

    await act(async () => {
      first.resolve({
        schemaVersion: 1,
        startup: { status: 'not-started' },
        streaming: { status: 'stopped' },
        connectionCleanup: { status: 'not-required' },
      });
      await Promise.resolve();
    });

    expect(screen.getByText(candidate.displayName)).toBeTruthy();
    expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce();
  });

  it('keeps the application classifier alive across StrictMode effect replay and disposes it on real unmount', async () => {
    const dispose = vi.spyOn(ClassificationController.prototype, 'dispose');
    const mounted = render(<StrictMode><App/></StrictMode>);

    await waitFor(() => expect(window.atomizerInstrument.getState).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(dispose).not.toHaveBeenCalled();

    mounted.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(dispose).toHaveBeenCalledOnce();
    dispose.mockRestore();
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

  it('rejects typed I/Q navigation when the connected source has no complex-I/Q capability', async () => {
    mockConnectedInstrument(ready);
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'iq-capability-0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'iq-capability-load', name: 'load_atom_tools', arguments: '{"toolNames":["navigate_workspace"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'iq-capability-1', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'iq-capability-navigate', name: 'navigate_workspace', arguments: '{"workspace":"iq"}' }] })
      .mockResolvedValueOnce({ conversationId: 'iq-capability-2', transport: 'realtime-websocket', text: 'I/Q is unavailable on this source.', toolCalls: [] });

    render(<App/>);
    await screen.findByText(candidate.displayName);
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Open I/Q.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const result = JSON.parse(vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs?.[0]?.output ?? '{}') as { ok?: boolean; error?: string };
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/does not advertise complex-I\/Q acquisition/i) });
    expect(screen.queryByRole('region', { name: /Complex I\/Q workspace/i })).toBeNull();
  });

  it('presents a failed operator export without an unhandled rejection or renderer loss', async () => {
    mockConnectedInstrument();
    vi.mocked(window.atomizerFiles.exportSweep).mockRejectedValueOnce(new Error('export destination unavailable'));
    render(<App/>);
    expect(await screen.findByText(candidate.displayName)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Single$/i }));

    fireEvent.click(await screen.findByRole('button', { name: 'Export CSV' }));

    expect(await screen.findByText('export destination unavailable')).toBeTruthy();
    const navigation = screen.getByRole('navigation', { name: /Primary navigation/i });
    fireEvent.click(within(navigation).getByRole('button', { name: /^Detect$/i }));
    expect(within(navigation).getByRole('button', { name: /^Detect$/i }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByText(/Atomizer could not start/i)).toBeNull();
  });

  it('exposes retained failed-connect cleanup and blocks a new connection until the safe retry succeeds', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin|No instrument/i }));
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
    expect(await screen.findByText(candidate.displayName)).toBeTruthy();
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    expect(screen.queryByText('No instrument')).toBeNull();
  });

  it('ignores a delayed disconnect from an older session', async () => {
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    const newer: InstrumentSessionSnapshot = {
      ...ready,
      sessionId: 'session-newer',
      candidate: { ...ready.candidate, displayName: 'Newer connected instrument' },
    };
    await act(async () => { instrumentEventListener?.({ type: 'connected', session: newer }); });
    expect(await screen.findByText('Newer connected instrument')).toBeTruthy();

    await act(async () => {
      instrumentEventListener?.({ type: 'disconnected', sessionId: ready.sessionId, driverId: ready.driverId });
    });
    expect(screen.getByText('Newer connected instrument')).toBeTruthy();
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
    expect(screen.getByText('VIRTUAL CONTROL')).toBeTruthy();
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
    fireEvent.click(within(screen.getByRole('navigation', { name: /Primary navigation/i }))
      .getByRole('button', { name: /Device/i }));
    expect(await screen.findByRole('heading', { name: physicalCandidate.displayName })).toBeTruthy();
  });

  it('returns exact device-observed physical RBW and attenuation through both latest-sweep read tools without identity claims', async () => {
    mockConnectedInstrument(physicalSession);
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
    await screen.findByText(physicalCandidate.displayName);
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

    expect(screen.queryByText(/^RF (?:ON|OFF|UNKNOWN)$/)).toBeNull();
    expect(within(screen.getByRole('navigation', { name: /Primary navigation/i }))
      .getByRole('button', { name: /Generate/i }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(screen.getByRole('navigation', { name: /Primary navigation/i }))
      .getByRole('button', { name: /Device/i }));
    expect(await screen.findByRole('heading', { name: physicalCandidate.displayName })).toBeTruthy();
    const featuresLabel = screen.getByText('Features');
    expect(within(featuresLabel.parentElement!).getByText('None')).toBeTruthy();
  });

  it('invalidates displayed evidence and marks RF state unknown when the active session faults', async () => {
    const { container } = render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText(candidate.displayName);
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
    await screen.findByText(candidate.displayName);
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
    await screen.findByText(candidate.displayName);
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
    await screen.findByText(candidate.displayName);
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
    await screen.findByText(candidate.displayName);
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

  it('allows marker 1 and the entire marker bank to remain off', async () => {
    const { container } = render(<App/>);
    fireEvent.click(screen.getByRole('button', { name: /^Markers$/i }));
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

  it('compensates an unacknowledged stream start, releases ownership, and permits a clean retry', async () => {
    vi.mocked(window.atomizerInstrument.startStreaming).mockRejectedValueOnce(new Error('stream start was not acknowledged'));
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText(candidate.displayName);

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
    await screen.findByText(candidate.displayName);

    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    expect(await screen.findByText(/compensating stop also failed/i)).toBeTruthy();
    const stop = await screen.findByRole('button', { name: /^Stop$/i });

    await act(async () => {
      instrumentEventListener?.({
        type: 'measurement',
        measurement: acquiredMeasurement(requested, 'ambiguous-start-measurement', configurationRevision),
      });
    });
    expect(container.querySelector('[aria-label="Measured power by frequency"]')).toBeTruthy();

    fireEvent.click(stop);
    await waitFor(() => expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: /^Run$/i })).toBeTruthy();
  });

  it('gates tap bursts and resumes only from a driver-published replacement configuration', async () => {
    let releaseInitialStart: (() => void) | undefined;
    const replacementConfiguration = {
      sessionId: ready.sessionId,
      configurationRevision: 'configuration:after-remote-tap',
      configuration: receiverSpectrumConfiguration({
        ...requested,
        startHz: 90_000_000,
        stopHz: 100_000_000,
      }),
      configuredAt: '2026-08-01T00:00:01.000Z',
    };
    vi.mocked(window.atomizerInstrument.startStreaming)
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseInitialStart = () => resolve({ status: 'running', startedAt: '2026-07-10T00:00:00.000Z' });
      }))
      .mockResolvedValue({ status: 'running', startedAt: '2026-07-10T00:00:01.000Z' });
    vi.mocked(window.atomizerInstrument.executeFeature).mockImplementation(async (request) => {
      if (request.kind !== 'touch') throw new Error(`Unexpected feature ${request.kind}`);
      const session = { ...ready, configuration: undefined };
      const execution = { result: { ...request, sessionId: ready.sessionId, accepted: true as const }, session };
      emitInvalidatingFeatureExecution(execution, 'instrument-mode-changed');
      instrumentEventListener?.({ type: 'configured', configuration: replacementConfiguration });
      return execution;
    });

    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText(candidate.displayName);
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
    await waitFor(() => expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledOnce());
    expect(window.atomizerInstrument.executeFeature).toHaveBeenCalledTimes(1);
    expect(window.atomizerInstrument.configure).not.toHaveBeenCalled();
    const run = await screen.findByRole('button', { name: /^Run$/i });
    fireEvent.click(run);
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledTimes(2));
    expect(window.atomizerInstrument.configure).not.toHaveBeenCalled();
  });

  it('offers explicit host trace Off without inventing firmware overlays', async () => {
    const { container } = render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const connection = await screen.findByRole('dialog', { name: /Instrument source/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    await screen.findByText(candidate.displayName);
    fireEvent.click(screen.getByRole('button', { name: /^Single$/i }));
    await waitFor(() => expect(window.atomizerInstrument.acquire).toHaveBeenCalledOnce());
    expect(container.querySelector('.firmware-trace')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Traces$/i }));
    const traceMode = screen.getByRole('radio', { name: /^Off/i });
    fireEvent.click(traceMode);
    await waitFor(() => expect((traceMode as HTMLInputElement).checked).toBe(true));
    await waitFor(() => expect(container.querySelector('.trace-line.t1')).toBeNull());
    expect(screen.queryByRole('button', { name: /D2 · Stored/i })).toBeNull();
  });

  it('uses one synchronous controller snapshot across trace, acquire, search, and getter calls', async () => {
    mockConnectedInstrument();
    const expectedPeakHz = frequencies[Math.floor(frequencies.length / 2)]!;
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
    expect(await screen.findByText(candidate.displayName)).toBeTruthy();
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Configure and inspect in one response.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const outputs = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs ?? [];
    expect(outputs).toHaveLength(8);
    const results = outputs.map(({ output }) => JSON.parse(output) as { ok?: boolean; output?: Record<string, unknown>; error?: string });
    expect(results.every((result) => result.ok), JSON.stringify(results)).toBe(true);
    expect(results[5]?.output).toMatchObject({ markerId: 1, action: 'peak', frequencyHz: expectedPeakHz });
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
    expect(await screen.findByText(candidate.displayName)).toBeTruthy();
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
