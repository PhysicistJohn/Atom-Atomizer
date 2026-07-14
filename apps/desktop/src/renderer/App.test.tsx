// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_VERSION,
  FIRMWARE_SOURCE_COMMIT,
  OEM_ZS407_FIRMWARE_RELEASE,
  TINYSA_SHELL_PROMPT,
  TINYSA_USB_PRODUCT_ID,
  TINYSA_USB_VENDOR_ID,
  type AnalyzerConfig,
  type DeviceCapabilities,
  type DeviceEvent,
  type DeviceSnapshot,
  type DetectedSignal,
  type PortCandidate,
  type Sweep,
  type ZeroSpanCapture,
} from '@tinysa/contracts';
import { classificationRepresentatives } from '@tinysa/analysis';
import { App, coherentSweepCount, fitChannelConfigurationToSpan, parseStoredDetection } from './App.js';
import { agentControlBinding } from '@tinysa/agent';

const port: PortCandidate = { id: 'sim', path: 'fake://zs407', manufacturer: 'TinySA test fixture', product: 'Protocol-only ZS407 test double', serialNumber: 'SIM-407', usbMatch: 'protocol-test-double', transport: 'protocol-test-double', execution: 'protocol-test-double' };
const identity = { model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'sim-1', firmwareSourceCommit: FIRMWARE_SOURCE_COMMIT, firmwareQualification: 'protocol-test', port, simulated: true, usbIdentityVerified: false, execution: 'protocol-test-double' } as const;
const capabilities: DeviceCapabilities = {
  profile: 'tinySA4-zs407',
  protocol: { transport: 'protocol-test-double', prompt: TINYSA_SHELL_PROMPT, commandTerminator: '\r', echoesCommands: true, maximumCommandCharacters: 47, usbTransactionsModeled: false },
  analyzerFrequency: { min: 0, max: 17_922_600_000, unit: 'Hz' }, analyzerNormalMaximumHz: 900_000_000, analyzerUltraTransitionHz: 7_370_100_000,
  generatorFrequency: { min: 1, max: 17_922_600_000, unit: 'Hz' }, generatorFundamentalMaximumHz: 6_300_000_000,
  generatorLevel: { min: -115, max: -18.5, step: 0.5, unit: 'dBm' }, rbwKhz: { min: 0.2, max: 850, unit: 'kHz' }, attenuationDb: { min: 0, max: 31, unit: 'dB' },
  sweepPoints: { min: 20, max: 450, unit: 'points' }, sweepSeconds: { min: 0.003, max: 60, unit: 'seconds' }, maxSweepPoints: 450,
  screen: { width: 480, height: 320, format: 'rgb565le' }, screenCapture: true, remoteTouch: true, streaming: true, rawSweep: true, rawSweepOffsetReadback: true, markerCount: 8, traceCount: 4, firmwareMarkers: true, firmwareTraces: true, generatorReadback: false,
  modulation: ['off', 'am', 'fm'], commands: ['scan', 'scanraw', 'capture', 'touch', 'release'], evidence: 'protocol-test-double', firmwareSourceCommit: FIRMWARE_SOURCE_COMMIT, hostContractSourceCommit: FIRMWARE_SOURCE_COMMIT, qualification: 'protocol-test-only',
};
const ready: DeviceSnapshot = { connection: 'ready', mode: 'idle', generatorOutput: 'off', verification: 'commanded', identity, capabilities };
const disconnected: DeviceSnapshot = { connection: 'disconnected', mode: 'idle', generatorOutput: 'off', verification: 'stale' };
const requested: AnalyzerConfig = { startHz: 88e6, stopHz: 108e6, points: 450, acquisitionFormat: 'raw', rbwKhz: 'auto', attenuationDb: 'auto', sweepTimeSeconds: 'auto', detector: 'sample', spurRejection: 'auto', lna: 'off', avoidSpurs: 'auto', trigger: { mode: 'auto' } };
const powers = Array.from({ length: 450 }, (_, index) => index === 225 ? -50 : -90);
const frequencies = Array.from({ length: 450 }, (_, index) => 88e6 + index * (20e6 / 449));
const sweep: Sweep = { kind: 'spectrum', id: 's1', sequence: 1, capturedAt: '2026-07-10T00:00:00.000Z', elapsedMilliseconds: 42, frequencyHz: frequencies, powerDbm: powers, requested, actualStartHz: frequencies[0]!, actualStopHz: frequencies.at(-1)!, actualRbwHz: 10_000, actualAttenuationDb: 0, source: 'scan-text', complete: true, identity };
let configuredAnalyzer = requested;
let deviceEventListener: ((event: DeviceEvent) => void) | undefined;
function acquiredSweep(config: AnalyzerConfig, id = 'runtime-sweep'): Sweep {
  const frequencyHz = Array.from({ length: config.points }, (_, index) => config.startHz + index * ((config.stopHz - config.startHz) / Math.max(1, config.points - 1)));
  return {
    ...sweep,
    id,
    frequencyHz,
    powerDbm: Array.from({ length: config.points }, (_, index) => index === Math.floor(config.points / 2) ? -50 : -90),
    requested: structuredClone(config),
    actualStartHz: frequencyHz[0]!,
    actualStopHz: frequencyHz.at(-1)!,
    source: config.acquisitionFormat === 'raw' ? 'scanraw-binary' : 'scan-text',
  };
}
const zeroSpanCapture: ZeroSpanCapture = {
  kind: 'zero-span', id: 'z1', sequence: 2, capturedAt: '2026-07-10T00:00:01.000Z', elapsedMilliseconds: 50,
  frequencyHz: 433_920_000, samplePeriodSeconds: 0.05 / 450, timingQualification: 'wall-clock-derived', powerDbm: Array(450).fill(-90),
  requested: { frequencyHz: 433_920_000, points: 450, rbwKhz: 100, attenuationDb: 'auto', sweepTimeSeconds: 0.05, trigger: { mode: 'auto' } },
  actualRbwHz: 100_000, actualAttenuationDb: 0, source: 'scan-text', complete: true, identity,
};

afterEach(() => { cleanup(); localStorage.clear(); });

beforeEach(() => {
  configuredAnalyzer = structuredClone(requested);
  deviceEventListener = undefined;
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fillStyle: '', strokeStyle: '', lineWidth: 1,
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  window.tinySA = {
    version: API_VERSION,
    listDevices: vi.fn().mockResolvedValue([port]),
    connect: vi.fn().mockResolvedValue(ready),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getSnapshot: vi.fn().mockResolvedValue(disconnected),
    configureAnalyzer: vi.fn().mockImplementation(async (configuration: AnalyzerConfig) => { configuredAnalyzer = structuredClone(configuration); return { ...ready, mode: 'analyzer', verification: 'verified' }; }),
    acquireSweep: vi.fn().mockImplementation(async () => acquiredSweep(configuredAnalyzer)),
    startStreaming: vi.fn().mockResolvedValue(undefined), stopStreaming: vi.fn().mockResolvedValue(undefined),
    acquireZeroSpan: vi.fn().mockResolvedValue(zeroSpanCapture),
    configureGenerator: vi.fn().mockResolvedValue({ ...ready, mode: 'generator' }),
    setGeneratorOutput: vi.fn().mockResolvedValue({ ...ready, mode: 'generator', generatorOutput: 'on' }),
    readDiagnostics: vi.fn(), captureScreen: vi.fn(), touch: vi.fn(), releaseTouch: vi.fn(), exportSweep: vi.fn(),
    getFirmwareUpdateState: vi.fn().mockResolvedValue({ phase: 'idle', target: OEM_ZS407_FIRMWARE_RELEASE, updateAvailable: false, dfuUtility: { available: false }, dfuDevice: { detected: false, count: 0 }, writeDisposition: 'not-started' }),
    downloadFirmwareUpdate: vi.fn(), prepareFirmwareUpdate: vi.fn(), detectDfuDevice: vi.fn(), flashFirmwareUpdate: vi.fn(),
    subscribe: vi.fn().mockImplementation((listener: (event: DeviceEvent) => void) => { deviceEventListener = listener; return vi.fn(); }),
  };
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

  it('renders every implemented atomic instrument workspace without dead affordances', async () => {
    const { container } = render(<App/>);
    await waitFor(() => expect(window.atomAgent.status).toHaveBeenCalledOnce());
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
    await waitFor(() => expect(window.tinySA.listDevices).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /Protocol-only ZS407 test double/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Connect$/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Single$/i }));
    await waitFor(() => expect(window.tinySA.acquireSweep).toHaveBeenCalledOnce());
    expect(await screen.findByLabelText('Measured power by frequency')).toBeTruthy();
    expect(window.tinySA.configureAnalyzer).toHaveBeenCalledBefore(vi.mocked(window.tinySA.acquireSweep));
  });

  it('pauses, verifies, and resumes continuous acquisition when analyzer settings change', async () => {
    render(<App/>);
    await waitFor(() => expect(window.tinySA.listDevices).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const dialog = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /Protocol-only ZS407 test double/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Connect$/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.tinySA.startStreaming).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /Sweep setup/i }));
    fireEvent.click(screen.getByRole('button', { name: /2\.4 GHz/i }));
    await waitFor(() => expect(window.tinySA.stopStreaming).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.tinySA.startStreaming).toHaveBeenCalledTimes(2));
    expect(window.tinySA.configureAnalyzer).toHaveBeenLastCalledWith(expect.objectContaining({ startHz: 2_400_000_000, stopHz: 2_500_000_000 }));
  });

  it('merges numeric frequency edits into the latest staged state before Run', async () => {
    render(<App/>);
    await waitFor(() => expect(window.tinySA.listDevices).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const connection = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /Protocol-only ZS407 test double/i }));
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
    await waitFor(() => expect(window.tinySA.startStreaming).toHaveBeenCalledOnce());
    expect(window.tinySA.configureAnalyzer).toHaveBeenLastCalledWith(expect.objectContaining({ startHz: 2_400_000_000, stopHz: 2_500_000_000 }));
  });

  it('quarantines an in-flight sweep after a staged span supersedes it', async () => {
    let releaseStop: (() => void) | undefined;
    vi.mocked(window.tinySA.stopStreaming).mockImplementationOnce(() => new Promise<void>((resolve) => { releaseStop = resolve; }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { container } = render(<App/>);
    await waitFor(() => expect(window.tinySA.listDevices).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const connection = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /Protocol-only ZS407 test double/i }));
    fireEvent.click(within(connection).getByRole('button', { name: /^Connect$/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    await waitFor(() => expect(window.tinySA.startStreaming).toHaveBeenCalledOnce());
    await act(async () => { deviceEventListener?.({ type: 'sweep', sweep: acquiredSweep(requested, 'current-fm') }); });
    expect(container.querySelector('[aria-label="Measured power by frequency"]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Sweep setup/i }));
    fireEvent.click(screen.getByRole('button', { name: /2\.4 GHz/i }));
    await waitFor(() => expect(window.tinySA.stopStreaming).toHaveBeenCalledOnce());
    await act(async () => { deviceEventListener?.({ type: 'sweep', sweep: acquiredSweep(requested, 'late-fm') }); });
    expect(container.querySelector('[aria-label="Measured power by frequency"]')).toBeNull();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('rejected stale sweep'), expect.objectContaining({ sweepId: 'late-fm' }));

    await act(async () => { releaseStop?.(); });
    await waitFor(() => expect(window.tinySA.configureAnalyzer).toHaveBeenLastCalledWith(expect.objectContaining({ startHz: 2_400_000_000, stopHz: 2_500_000_000 })));
    warning.mockRestore();
  });

  it('offers explicit host trace Off and opt-in firmware overlays', async () => {
    vi.mocked(window.tinySA.acquireSweep).mockImplementation(async () => {
      const current = acquiredSweep(configuredAnalyzer, 'trace-sweep');
      return {
        ...current,
        firmwareTraces: [
          { traceId: 1, role: 'measured', unit: 'dBm', frozen: false, frequencyHz: current.frequencyHz, powerDbm: current.powerDbm, sourceSweepId: current.id, capturedAt: current.capturedAt, evidence: 'firmware-readback' },
          { traceId: 2, role: 'stored', unit: 'dBm', frozen: true, frequencyHz: current.frequencyHz, powerDbm: current.powerDbm.map((value) => value - 5), sourceSweepId: current.id, capturedAt: current.capturedAt, evidence: 'firmware-readback' },
        ],
      };
    });
    const { container } = render(<App/>);
    await waitFor(() => expect(window.tinySA.listDevices).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /No instrument/i }));
    const connection = await screen.findByRole('dialog', { name: /^Connect$/i });
    fireEvent.click(screen.getByRole('button', { name: /Protocol-only ZS407 test double/i }));
    fireEvent.click(within(connection).getByRole('button', { name: /^Connect$/i }));
    await screen.findByText('tinySA Ultra+ ZS407');
    fireEvent.click(screen.getByRole('button', { name: /^Single$/i }));
    await waitFor(() => expect(window.tinySA.acquireSweep).toHaveBeenCalledOnce());
    expect(container.querySelector('.firmware-trace')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Traces & markers/i }));
    fireEvent.click(within(container.querySelector('.measurement-tabs') as HTMLElement).getByRole('button', { name: /Traces/i }));
    const traceToggle = screen.getByRole('button', { name: /Trace 1.*On/i });
    fireEvent.click(traceToggle);
    await waitFor(() => expect(screen.getByRole('button', { name: /Trace 1.*Off/i })).toBeTruthy());
    await waitFor(() => expect(container.querySelector('.trace-line.t1')).toBeNull());

    const firmwareToggle = screen.getByRole('button', { name: /D2 · Stored · frozen.*Off/i });
    fireEvent.click(firmwareToggle);
    await waitFor(() => expect(container.querySelector('.firmware-trace.f2')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /D2 · Stored · frozen.*On/i }));
    await waitFor(() => expect(container.querySelector('.firmware-trace.f2')).toBeNull());
  });

  it('lets Atom list, connect, verify, and acquire through typed tools', async () => {
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
    await waitFor(() => expect(window.tinySA.listDevices).toHaveBeenCalledOnce());
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Connect the simulator and acquire one sweep.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.tinySA.connect).toHaveBeenCalledWith(port));
    expect(window.tinySA.listDevices).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(window.tinySA.acquireSweep).toHaveBeenCalledOnce());
    expect(window.tinySA.configureAnalyzer).toHaveBeenLastCalledWith(expect.objectContaining({ startHz: 93_000_000, stopHz: 95_000_000, rbwKhz: 'auto' }));
    expect(await screen.findByText('Sweep complete.')).toBeTruthy();
    expect(await screen.findByText(/TPM 10K\/200K/)).toBeTruthy();
    const candidateOutput = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs?.[0]?.output ?? '';
    expect(candidateOutput).toContain('candidate-1');
    expect(candidateOutput).not.toContain('fake://');
    expect(candidateOutput).not.toContain('SIM-407');
  });

  it('restores swept-analyzer auto RBW after an Atom zero-span capture', async () => {
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'z0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'z-load', name: 'load_atom_tools', arguments: '{"toolNames":["list_connection_candidates","connect_device","acquire_zero_span"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'z1', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'z-list', name: 'list_connection_candidates', arguments: '{}' }] })
      .mockResolvedValueOnce({ conversationId: 'z2', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'z-connect', name: 'connect_device', arguments: '{"candidateId":"candidate-1"}' }] })
      .mockResolvedValueOnce({ conversationId: 'z3', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'z-capture', name: 'acquire_zero_span', arguments: '{}' }] })
      .mockResolvedValueOnce({ conversationId: 'z4', transport: 'realtime-websocket', text: 'Envelope captured and swept analyzer restored.', toolCalls: [] });

    render(<App/>);
    await waitFor(() => expect(window.tinySA.listDevices).toHaveBeenCalledOnce());
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Connect and capture the envelope.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.tinySA.acquireZeroSpan).toHaveBeenCalledOnce());
    await waitFor(() => expect(window.tinySA.configureAnalyzer).toHaveBeenCalledWith(expect.objectContaining({ rbwKhz: 'auto' })));
    expect(vi.mocked(window.tinySA.acquireZeroSpan).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(window.tinySA.configureAnalyzer).mock.invocationCallOrder.at(-1)!);
  });

  it('returns a blocked app-computer action to Atom as a failed tool result', async () => {
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.computerClick).mockResolvedValue({ ok: false, action: 'click', target: 'firmware.flash', reason: 'This control is a local human-only boundary' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'c0', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'load-click', name: 'load_atom_tools', arguments: '{"toolNames":["computer_click"]}' }] })
      .mockResolvedValueOnce({ conversationId: 'c1', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'blocked-click', name: 'computer_click', arguments: '{"screenshotId":"123e4567-e89b-42d3-a456-426614174000","x":100,"y":100}' }] })
      .mockResolvedValueOnce({ conversationId: 'c2', transport: 'realtime-websocket', text: 'That control is human-only.', toolCalls: [] });

    render(<App/>);
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Click the final flash control.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(3));
    const output = vi.mocked(window.atomAgent.agentTurn).mock.calls[2]?.[0].toolOutputs?.[0]?.output ?? '';
    expect(output).toContain('"ok":false');
    expect(output).toContain('human-only boundary');
  });
});
