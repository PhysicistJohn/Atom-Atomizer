// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  type DeviceSnapshot,
  type PortCandidate,
  type Sweep,
} from '@tinysa/contracts';
import { App } from './App.js';
import { agentControlBinding } from '@tinysa/agent';

const port: PortCandidate = { id: 'sim', path: 'fake://zs407', manufacturer: 'TinySA test fixture', product: 'Protocol-only ZS407 test double', serialNumber: 'SIM-407', usbMatch: 'protocol-test-double', transport: 'protocol-test-double', execution: 'protocol-test-double' };
const identity = { model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'sim-1', firmwareSourceCommit: FIRMWARE_SOURCE_COMMIT, port, simulated: true, usbIdentityVerified: false, execution: 'protocol-test-double' } as const;
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
const requested: AnalyzerConfig = { startHz: 88e6, stopHz: 108e6, points: 20, acquisitionFormat: 'text', rbwKhz: 'auto', attenuationDb: 'auto', sweepTimeSeconds: 'auto', detector: 'sample', spurRejection: 'auto', lna: 'off', avoidSpurs: 'auto', trigger: { mode: 'auto' } };
const powers = Array.from({ length: 20 }, (_, index) => index === 10 ? -50 : -90);
const frequencies = Array.from({ length: 20 }, (_, index) => 88e6 + index * (20e6 / 19));
const sweep: Sweep = { kind: 'spectrum', id: 's1', sequence: 1, capturedAt: '2026-07-10T00:00:00.000Z', elapsedMilliseconds: 42, frequencyHz: frequencies, powerDbm: powers, requested, actualStartHz: frequencies[0]!, actualStopHz: frequencies.at(-1)!, actualRbwHz: 10_000, actualAttenuationDb: 0, source: 'scan-text', complete: true, identity };

afterEach(() => { cleanup(); localStorage.clear(); });

beforeEach(() => {
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
    configureAnalyzer: vi.fn().mockResolvedValue({ ...ready, mode: 'analyzer', verification: 'verified' }),
    acquireSweep: vi.fn().mockResolvedValue(sweep),
    startStreaming: vi.fn().mockResolvedValue(undefined), stopStreaming: vi.fn().mockResolvedValue(undefined),
    acquireZeroSpan: vi.fn(),
    configureGenerator: vi.fn().mockResolvedValue({ ...ready, mode: 'generator' }),
    setGeneratorOutput: vi.fn().mockResolvedValue({ ...ready, mode: 'generator', generatorOutput: 'on' }),
    readDiagnostics: vi.fn(), captureScreen: vi.fn(), touch: vi.fn(), releaseTouch: vi.fn(), exportSweep: vi.fn(),
    getFirmwareUpdateState: vi.fn().mockResolvedValue({ phase: 'idle', target: OEM_ZS407_FIRMWARE_RELEASE, updateAvailable: false, dfuUtility: { available: false }, dfuDevice: { detected: false, count: 0 }, writeDisposition: 'not-started' }),
    downloadFirmwareUpdate: vi.fn(), prepareFirmwareUpdate: vi.fn(), detectDfuDevice: vi.fn(), flashFirmwareUpdate: vi.fn(),
    subscribe: vi.fn().mockReturnValue(vi.fn()),
  };
  window.atomAgent = {
    status: vi.fn().mockResolvedValue({ configured: false, model: 'gpt-realtime-2.1-mini', voice: 'ballad', reasoningEffort: 'high', textAgent: false, realtime: false, textTransport: 'realtime-websocket' }),
    createRealtimeCall: vi.fn(), agentTurn: vi.fn(), computerScreenshot: vi.fn(), computerClick: vi.fn(), computerType: vi.fn(), computerKey: vi.fn(), computerScroll: vi.fn(),
  };
});

describe('operator vertical slice', () => {
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
    const markerOne = screen.getByRole('button', { name: /Marker 1, visible, selected/i });
    fireEvent.click(markerOne);
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

  it('lets Atom list, connect, verify, and acquire through typed tools', async () => {
    vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1-mini', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce({ conversationId: 'r1', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'c1', name: 'list_connection_candidates', arguments: '{}' }] })
      .mockResolvedValueOnce({ conversationId: 'r2', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'c2', name: 'connect_device', arguments: '{"candidateId":"candidate-1"}' }] })
      .mockResolvedValueOnce({ conversationId: 'r3', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'c3', name: 'get_instrument_state', arguments: '{}' }] })
      .mockResolvedValueOnce({ conversationId: 'r4', transport: 'realtime-websocket', text: '', toolCalls: [{ callId: 'c4', name: 'acquire_sweep', arguments: '{}' }] })
      .mockResolvedValueOnce({ conversationId: 'r5', transport: 'realtime-websocket', text: 'Sweep complete.', toolCalls: [] });

    render(<App/>);
    await waitFor(() => expect(window.tinySA.listDevices).toHaveBeenCalledOnce());
    const composer = await screen.findByPlaceholderText(/Ask Atom/i);
    fireEvent.change(composer, { target: { value: 'Connect the simulator and acquire one sweep.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send to Atom/i }));

    await waitFor(() => expect(window.tinySA.connect).toHaveBeenCalledWith(port));
    await waitFor(() => expect(window.tinySA.acquireSweep).toHaveBeenCalledOnce());
    expect(await screen.findByText('Sweep complete.')).toBeTruthy();
    const candidateOutput = vi.mocked(window.atomAgent.agentTurn).mock.calls[1]?.[0].toolOutputs?.[0]?.output ?? '';
    expect(candidateOutput).toContain('candidate-1');
    expect(candidateOutput).not.toContain('fake://');
    expect(candidateOutput).not.toContain('SIM-407');
  });
});
