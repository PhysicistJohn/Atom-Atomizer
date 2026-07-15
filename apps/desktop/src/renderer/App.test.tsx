// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AnalyzerConfig,
  type AtomizerInstrumentEvent,
  type AtomizerInstrumentState,
  type DetectedSignal,
  type InstrumentCandidate,
  type InstrumentConfiguration,
  type InstrumentMeasurement,
  type InstrumentSessionSnapshot,
  type Sweep,
} from '@tinysa/contracts';
import { classificationRepresentatives } from '@tinysa/analysis';
import { App, coherentSweepCount, fitChannelConfigurationToSpan, parseStoredDetection } from './App.js';
import { agentControlBinding } from '@tinysa/agent';

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
const signalLabCandidate: InstrumentCandidate = { schemaVersion: 1, driverId: 'signal-lab', candidateId: 'signal-lab:local', displayName: 'SignalLab', sourceKind: 'signal-lab', signalLab: { sourceId: 'local' }, discoveryRevision: 'signal-discovery-1' };
const signalLabSession: InstrumentSessionSnapshot = {
  sessionId: 'signal-session', driverId: 'signal-lab', candidate: signalLabCandidate,
  provenance: { sourceKind: 'signal-lab', sourceId: 'local', execution: 'signal-lab-simulation', transport: 'signal-lab-measurement-bridge', qualification: 'synthetic-visual-projection', verifiedAt: '2026-07-10T00:00:00.000Z', producerConfigurationEpoch: 'producer-epoch:1', contractId: 'tinysa-signal-lab-atomizer-measurement', contractVersion: 1, contractSha256: HASH, catalogSha256: HASH, generatorSha256: HASH, claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false } },
  capabilities: { schemaVersion: 1, acquisitions: [{ kind: 'swept-spectrum', frequencyHz: { min: 0, max: 17_922_600_000 }, points: { min: 20, max: 450 }, sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } }, controls: syntheticScalarCapability(), powerUnit: 'dBm' }, { kind: 'detected-power-timeseries', centerFrequencyHz: { min: 1, max: 17_922_600_000, step: 1 }, sampleCount: { min: 20, max: 450 }, sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } }, controls: syntheticScalarCapability(), powerUnit: 'dBm', timing: 'uniform' }], features: [{ kind: 'signal-lab-profile-selection', profiles: [{ profileId: 'cw', centerFrequencyHz: 100_000_000, recommendedSpanHz: 2_000_000 }, { profileId: 'fm', centerFrequencyHz: 100_000_000, recommendedSpanHz: 500_000 }], selectedProfileId: 'cw' }] },
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

function detectedPowerMeasurement(config: Extract<InstrumentConfiguration, { kind: 'detected-power-timeseries' }>): Extract<InstrumentMeasurement, { kind: 'detected-power-timeseries' }> {
  return { schemaVersion: 1, kind: 'detected-power-timeseries', measurementId: 'zero-1', sessionId: ready.sessionId, configurationRevision, sequence: ++measurementSequence, capturedAt: '2026-07-10T00:00:01.000Z', elapsedMilliseconds: 50, resolutionBandwidthHz: 100_000, attenuationDb: 0, qualification: 'firmware-executed-twin', complete: true, centerHz: config.centerHz, sampleIntervalSeconds: config.sweepTimeSeconds / config.sampleCount, timingQualification: 'wall-clock-derived', powerDbm: Array(config.sampleCount).fill(-90) };
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
        return { result, session: { ...ready, rfOutput, rfOutputQualification: 'firmware-executed-twin' as const } };
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
              ? { ...feature, selectedProfileId: request.profileId }
              : feature),
          },
        };
        return { result, session: profileSession };
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

  it('opens Classify with the persisted pre-model 100 ms capture geometry intact and explicitly out of model', async () => {
    localStorage.setItem('tinysa-atomizer:v2:zero-span', JSON.stringify({
      frequencyHz: 433_920_000,
      points: 290,
      rbwKhz: 100,
      attenuationDb: 'auto',
      sweepTimeSeconds: 0.1,
      trigger: { mode: 'auto' },
    }));
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());

    const navigation = screen.getByRole('navigation', { name: /Primary navigation/i });
    fireEvent.click(within(navigation).getByRole('button', { name: /^Classify$/i }));

    const captureGeometry = screen.getByRole('combobox', { name: 'Capture geometry' }) as HTMLSelectElement;
    expect(captureGeometry.value).toBe('current');
    expect(captureGeometry.selectedOptions[0]?.textContent).toBe('290 × 100 ms · current · outside pinned Bayesian geometry');
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

    expect(classificationRepresentatives(signals).map((signal) => signal.id)).toEqual(['center', 'local']);
    expect(classificationRepresentatives(signals, 'right').map((signal) => signal.id)).toEqual(['right', 'local']);
  });

  it('stages the selected detection on the admitted tuning lattice and captures at that exact center', async () => {
    vi.mocked(window.atomizerInstrument.getState).mockResolvedValue({
      schemaVersion: 1,
      startup: { status: 'connected', connectedAt: '2026-07-10T00:00:00.000Z' },
      streaming: { status: 'stopped' },
      connectionCleanup: { status: 'not-required' },
      preference: { source: 'persisted', preference: { schemaVersion: 1, driverId: ready.driverId, candidateKind: ready.candidate.sourceKind, updatedAt: '2026-07-10T00:00:00.000Z' } },
      session: ready,
    });

    render(<App/>);
    expect(await screen.findByText('tinySA Ultra+ ZS407')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Single$/i }));
    await waitFor(() => expect(window.atomizerInstrument.acquire).toHaveBeenCalledOnce());

    const expectedCenterHz = Math.round(88_000_000 + Math.floor(requested.points / 2)
      * ((108_000_000 - 88_000_000) / (requested.points - 1)));
    const navigation = screen.getByRole('navigation', { name: /Primary navigation/i });
    fireEvent.click(within(navigation).getByRole('button', { name: /^Classify$/i }));
    fireEvent.click(screen.getByRole('button', { name: /Capture envelope/i }));

    await waitFor(() => {
      const detectedPowerConfigurations = vi.mocked(window.atomizerInstrument.configure).mock.calls
        .map(([configuration]) => configuration)
        .filter((configuration): configuration is Extract<InstrumentConfiguration, { kind: 'detected-power-timeseries' }> =>
          configuration.kind === 'detected-power-timeseries');
      expect(detectedPowerConfigurations).toContainEqual(expect.objectContaining({
        kind: 'detected-power-timeseries',
        centerHz: expectedCenterHz,
      }));
    });
    expect(expectedCenterHz).not.toBe(frequencies[Math.floor(requested.points / 2)]);
  });

  it('renders an already-started SignalLab default without fabricating hardware identity and can select its profile', async () => {
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
    expect(screen.getByRole('button', { name: /SignalLab.*Synthetic measurement bridge/i })).toBeTruthy();
    const navigation = screen.getByRole('navigation', { name: /Primary navigation/i });
    expect(within(navigation).getByRole('button', { name: /Generate/i }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(navigation).getByRole('button', { name: /Device/i }));
    expect(await screen.findByText(/no device identity is asserted/i)).toBeTruthy();
    expect(screen.getAllByText('Not claimed').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole('combobox', { name: /SignalLab profile/i }), { target: { value: 'fm' } });
    await waitFor(() => expect(window.atomizerInstrument.executeFeature).toHaveBeenCalledWith({ kind: 'signal-lab-profile-selection', action: 'select-profile', profileId: 'fm' }));
    fireEvent.click(within(navigation).getByRole('button', { name: /Spectrum/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Single$/i }));
    const admitted = {
      kind: 'swept-spectrum' as const, startHz: 99_750_000, stopHz: 100_250_000, points: 450, sweepTimeSeconds: 0.05,
      controls: { schemaVersion: 1 as const, model: 'synthetic-scalar' as const, timingQualification: 'simulation-exact' as const },
    };
    await waitFor(() => expect(window.atomizerInstrument.configure).toHaveBeenLastCalledWith(admitted));
    await waitFor(() => expect(window.atomizerInstrument.acquire).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    await waitFor(() => expect(window.atomizerFiles.exportSweep).toHaveBeenCalledWith({
      format: 'json', sweep: expect.objectContaining({ requested: admitted }),
    }));
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

    const dialog = screen.getByRole('dialog', { name: 'Connect' });
    expect(within(dialog).getByRole('alert').textContent).toMatch(/Connection cleanup required/i);
    expect(within(dialog).getByRole('button', { name: 'Connect' }).hasAttribute('disabled')).toBe(true);

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
    const dialog = await screen.findByRole('dialog', { name: /^Connect$/i });
    expect(within(dialog).getByRole('button', { name: /TinySA physical A.*STARTUP DEFAULT/i })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /TinySA physical B/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use at startup' }));

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

  it('invalidates displayed evidence and marks RF state unknown when the active session faults', async () => {
    const { container } = render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Connect$/i }));
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
    const connection = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(connection).getByRole('button', { name: /^Connect$/i }));
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

  it('coalesces an invalid measurement flood into one fail-safe stream stop', async () => {
    let releaseStop: (() => void) | undefined;
    vi.mocked(window.atomizerInstrument.stopStreaming).mockImplementationOnce(() => new Promise((resolve) => {
      releaseStop = () => resolve({ status: 'stopped' });
    }));
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const connection = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(connection).getByRole('button', { name: /^Connect$/i }));
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
    const connection = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(connection).getByRole('button', { name: /^Connect$/i }));
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
    const connection = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(connection).getByRole('button', { name: /^Connect$/i }));
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
    const { container } = render(<App/>);
    await waitFor(() => expect(window.atomAgent.status).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const connection = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(connection).getByRole('button', { name: /^Connect$/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    const navigation = screen.getByRole('navigation', { name: /Primary navigation/i });
    for (const label of ['Spectrum', 'Detect', 'Classify', 'Generate', 'Device']) expect(navigation.textContent).toContain(label);
    expect(navigation.textContent).not.toContain('Sessions');
    expect(navigation.textContent).not.toContain('Settings');
    expect(container.querySelector('.atomic-mark')).toBeTruthy();
    for (const view of ['Spectrum', 'Waterfall', 'Channel', 'Time / STFT']) expect(screen.getByRole('tab', { name: new RegExp(view, 'i') })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Waterfall/i }));
    expect(await screen.findByLabelText(/Measured power by frequency and sweep time/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Channel/i }));
    expect(await screen.findByText(/Channel setup/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Time \/ STFT/i }));
    expect(await screen.findByText(/^Capture$/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^Spectrum/i }));
    fireEvent.click(screen.getByRole('button', { name: /Sweep setup/i }));
    expect(container.querySelector('.acquisition-dock')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Traces & markers/i }));
    const measurementTabs = within(container.querySelector('.measurement-tabs') as HTMLElement);
    for (const control of ['Markers', 'Traces', 'Display']) expect(measurementTabs.getByRole('button', { name: new RegExp(control, 'i') })).toBeTruthy();
    fireEvent.click(measurementTabs.getByRole('button', { name: /Markers/i }));
    expect(await screen.findByRole('button', { name: /^Peak$/i })).toBeTruthy();
    fireEvent.click(measurementTabs.getByRole('button', { name: /Traces/i }));
    expect(await screen.findByText('TRACE 4')).toBeTruthy();
    await waitFor(() => expect(container.querySelector('.atom-foot')?.textContent).toContain('HIGH'));
    expect(container.querySelector('.atom-foot')?.textContent).toContain('BALLAD');
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
    await screen.findByRole('dialog', { name: /^Connect$/i });
    assertRenderedContracts();
    fireEvent.click(screen.getByRole('button', { name: /^Close$/i }));
    for (const view of ['Waterfall', 'Channel', 'Time / STFT', 'Spectrum']) {
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(view.replace('/', '\\/'), 'i') }));
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
    const navigation = screen.getByRole('navigation', { name: /Primary navigation/i });
    for (const workspace of ['Detect', 'Classify', 'Generate', 'Device', 'Spectrum']) {
      fireEvent.click(within(navigation).getByRole('button', { name: new RegExp(workspace, 'i') }));
      assertRenderedContracts();
    }
  });

  it('connects, configures, and acquires through the complete typed bridge', async () => {
    render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Connect$/i }));
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
    const dialog = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Connect$/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /Sweep setup/i }));
    fireEvent.click(screen.getByRole('button', { name: /2\.4 GHz/i }));
    await waitFor(() => expect(window.atomizerInstrument.stopStreaming).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.atomizerInstrument.startStreaming).toHaveBeenCalledTimes(2));
    expect(window.atomizerInstrument.configure).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'swept-spectrum', startHz: 2_400_000_000, stopHz: 2_500_000_000 }));
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
    const dialog = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Connect$/i }));
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
    const dialog = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Connect$/i }));
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
    const dialog = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Connect$/i }));
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
          releaseConfiguration = () => resolve({
            result: { ...request, sessionId: ready.sessionId },
            session: { ...ready, rfOutput: 'off', rfOutputQualification: 'firmware-executed-twin' },
          });
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
    const dialog = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Connect$/i }));
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
      return { result: { ...request, sessionId: ready.sessionId, accepted: true }, session: ready };
    });

    const { container } = render(<App/>);
    await waitFor(() => expect(window.atomizerInstrument.discover).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Connect$/i }));
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
    const connection = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(connection).getByRole('button', { name: /^Connect$/i }));
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
    const connection = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(connection).getByRole('button', { name: /^Connect$/i }));
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
    const connection = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /TinySA executable firmware twin/i }));
    fireEvent.click(within(connection).getByRole('button', { name: /^Connect$/i }));
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
