import { describe, expect, it, vi } from 'vitest';
import {
  DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT,
  instrumentCandidateSchema,
  type AnalyzerConfig,
  type DeviceDiagnostics,
  type DeviceEvent,
  type DeviceSnapshot,
  type GeneratorConfig,
  type PortCandidate,
  type ScreenFrame,
  type ScreenPoint,
  type Sweep,
  type ZeroSpanCapture,
  type ZeroSpanConfig,
} from '@tinysa/contracts';
import { TinySaZs407InstrumentDriver, type TinySaInstrumentDevicePort } from './tinysa-instrument-driver.js';
import type { TransportDiscoveryResult } from './transport.js';

const physical: PortCandidate = {
  id: 'physical:407',
  path: '/dev/tty.usbmodem407',
  product: 'tinySA Ultra+ ZS407',
  serialNumber: 'CDC407',
  vendorId: '0483',
  productId: '5740',
  usbMatch: 'exact-zs407-cdc',
  transport: 'usb-cdc-acm',
  execution: 'physical',
};
const twin: PortCandidate = {
  id: 'twin:407',
  path: 'renode://zs407',
  product: 'ZS407 executable twin',
  usbMatch: 'firmware-digital-twin',
  transport: 'renode-monitor-bridge',
  execution: 'firmware-digital-twin',
  digitalTwin: {
    contractVersion: 1,
    bridge: 'renode-monitor-v1',
    firmwareRelease: 'lab-v0.2.0-protocol',
    repositoryCommit: DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT,
    firmwareBinarySha256: 'a1dbaa03978a25b2a8b2a0e85f60029a6cc736481732eff68e93362724683dd7',
    usbTransactionsModeled: false,
  },
};

describe('TinySaZs407InstrumentDriver', () => {
  it('keeps physical USB evidence and executable-twin provenance in distinct candidate variants', async () => {
    const driver = new TinySaZs407InstrumentDriver(new FakeTinySaDevice());
    const { candidates, failures } = await driver.discover();
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      driverId: 'tinysa-zs407', sourceKind: 'serial-port', serialPort: { path: physical.path, vendorId: '0483', productId: '5740' },
    });
    expect(candidates[1]).toMatchObject({
      driverId: 'tinysa-zs407', sourceKind: 'tinysa-firmware-twin', firmwareTwin: { usbTransactionsModeled: false },
    });
    expect(candidates[1]).not.toHaveProperty('serialPort');
    expect(failures).toEqual([]);
  });

  it('retains the executable twin when physical enumeration reports a typed failure', async () => {
    const driver = new TinySaZs407InstrumentDriver(new FakeTinySaDevice({
      candidates: [twin],
      failures: [{
        sourceKind: 'serial-port', transport: 'usb-cdc-acm', code: 'enumeration-failed',
        message: 'USB subsystem unavailable', recoverable: true,
      }],
    }));
    await expect(driver.discover()).resolves.toEqual({
      candidates: [expect.objectContaining({ sourceKind: 'tinysa-firmware-twin' })],
      failures: [{ sourceKind: 'serial-port', code: 'source-unavailable', message: 'USB subsystem unavailable', recoverable: true }],
    });
  });

  it('exposes the device service failed-connect lease through required driver cleanup', async () => {
    const device = new FakeTinySaDevice();
    const driver = new TinySaZs407InstrumentDriver(device);

    await expect(driver.cleanupPendingConnection()).resolves.toBeUndefined();

    expect(device.cleanupPendingInstrumentConnection).toHaveBeenCalledOnce();
  });

  it('maps high-level spectrum and detected-power operations without leaking shell transport', async () => {
    const device = new FakeTinySaDevice();
    const driver = new TinySaZs407InstrumentDriver(device);
    const descriptor = (await driver.discover()).candidates[0]!;
    const candidate = instrumentCandidateSchema.parse({ ...descriptor, discoveryRevision: 'discovery:1' });
    const session = await driver.connect(candidate);
    expect(session.provenance).toMatchObject({
      sourceKind: 'serial-port', qualification: 'device-observed',
      device: { usbIdentityVerified: true },
    });

    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:1',
      configuration: { kind: 'swept-spectrum', startHz: 88_000_000, stopHz: 108_000_000, points: 20 },
    });
    expect(device.analyzer).toMatchObject({ startHz: 88_000_000, stopHz: 108_000_000, points: 20, acquisitionFormat: 'raw' });
    await expect(session.acquire()).resolves.toMatchObject({
      kind: 'swept-spectrum', sessionId: session.sessionId, configurationRevision: 'configuration:1',
      elapsedMilliseconds: 1, resolutionBandwidthHz: 10_000, attenuationDb: 0,
      qualification: 'device-observed',
    });

    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:2',
      configuration: { kind: 'detected-power-timeseries', centerHz: 98_000_000, sampleCount: 20, sampleIntervalSeconds: 0.001 },
    });
    const detected = await session.acquire();
    expect(detected).toMatchObject({ kind: 'detected-power-timeseries', centerHz: 98_000_000 });
    if (detected.kind !== 'detected-power-timeseries') throw new Error('Expected detected-power fixture');
    expect(detected.powerDbm).toHaveLength(20);
    expect(device.zero).toMatchObject({ frequencyHz: 98_000_000, points: 20, sweepTimeSeconds: 0.02 });
  });

  it('routes generator, screen, touch, diagnostics, and safe disconnect through the driver', async () => {
    const device = new FakeTinySaDevice();
    const driver = new TinySaZs407InstrumentDriver(device);
    const descriptor = (await driver.discover()).candidates[0]!;
    const session = await driver.connect(instrumentCandidateSchema.parse({ ...descriptor, discoveryRevision: 'discovery:1' }));
    await session.executeFeature({
      sessionId: session.sessionId, kind: 'rf-generator', action: 'configure',
      frequencyHz: 100_000_000, levelDbm: -40, path: 'normal',
      modulation: { mode: 'am', modulationFrequencyHz: 1_234, depthPercent: 61 },
    });
    expect(device.generator).toMatchObject({
      frequencyHz: 100_000_000, levelDbm: -40, path: 'normal', modulation: 'am',
      modulationFrequencyHz: 1_234, amDepthPercent: 61,
    });
    await session.executeFeature({ sessionId: session.sessionId, kind: 'rf-generator', action: 'set-output', enabled: true });
    await expect(session.executeFeature({ sessionId: session.sessionId, kind: 'screen', action: 'capture' }))
      .resolves.toMatchObject({ frame: { pixelFormat: 'rgb565le' } });
    await session.executeFeature({ sessionId: session.sessionId, kind: 'touch', action: 'tap', x: 3, y: 4 });
    await expect(session.executeFeature({ sessionId: session.sessionId, kind: 'diagnostics', action: 'read', report: 'identity' }))
      .resolves.toMatchObject({ lines: expect.arrayContaining(['model=tinySA Ultra+ ZS407']) });
    await session.disconnect();
    expect(device.generatorOutput).toHaveBeenCalledWith(true);
    expect(device.touchCalls).toEqual([{ x: 3, y: 4 }]);
    expect(device.releaseCalls).toEqual([{ x: 3, y: 4 }]);
    expect(device.disconnect).toHaveBeenCalledOnce();
  });

  it('replays a terminal device event observed before the first session subscriber', async () => {
    const device = new FakeTinySaDevice();
    device.eventOnSubscribe = {
      type: 'error',
      error: { code: 'transport', message: 'device vanished during session handoff', recoverable: false },
    };
    const driver = new TinySaZs407InstrumentDriver(device);
    const descriptor = (await driver.discover()).candidates[0]!;
    const session = await driver.connect(instrumentCandidateSchema.parse({ ...descriptor, discoveryRevision: 'discovery:1' }));
    const events: unknown[] = [];

    session.subscribe((event) => events.push(event));

    expect(events).toEqual([{
      type: 'error', sessionId: session.sessionId,
      error: { code: 'session-fault', message: 'device vanished during session handoff', recoverable: false },
    }]);
    await session.disconnect();
  });
});

class FakeTinySaDevice implements TinySaInstrumentDevicePort {
  analyzer?: AnalyzerConfig;
  zero?: ZeroSpanConfig;
  generator?: GeneratorConfig;
  readonly generatorOutput = vi.fn(async (_enabled: boolean) => this.snapshot());
  readonly touchCalls: ScreenPoint[] = [];
  readonly releaseCalls: (ScreenPoint | undefined)[] = [];
  readonly disconnect = vi.fn(async () => undefined);
  readonly cleanupPendingInstrumentConnection = vi.fn(async () => undefined);
  eventOnSubscribe: DeviceEvent | undefined;
  #snapshot: DeviceSnapshot = disconnectedSnapshot();
  #listeners = new Set<(event: DeviceEvent) => void>();

  constructor(private readonly discovery: TransportDiscoveryResult = { candidates: [physical, twin], failures: [] }) {}

  async listDevices(): Promise<TransportDiscoveryResult> { return this.discovery; }
  snapshot(): DeviceSnapshot { return structuredClone(this.#snapshot); }
  async connect(candidate: PortCandidate): Promise<DeviceSnapshot> {
    const identity: NonNullable<DeviceSnapshot['identity']> = candidate.execution === 'firmware-digital-twin'
      ? {
        model: 'tinySA Ultra+ ZS407', hardwareVersion: 'ZS407', firmwareVersion: 'fixture-twin',
        firmwareQualification: 'executable-twin', port: candidate, simulated: true,
        usbIdentityVerified: false, execution: 'firmware-digital-twin', digitalTwin: candidate.digitalTwin,
      }
      : {
        model: 'tinySA Ultra+ ZS407', hardwareVersion: 'ZS407', firmwareVersion: 'v1.4.6-gfffffff',
        firmwareReportedRevision: 'fffffff', firmwareQualification: 'custom-unqualified', port: candidate,
        simulated: false, usbIdentityVerified: true, execution: 'physical',
      };
    this.#snapshot = {
      connection: 'ready', mode: 'idle', generatorOutput: 'off', verification: 'commanded',
      sessionId: 'session:tiny', capabilities: {} as DeviceSnapshot['capabilities'],
      identity,
      connectedAt: '2026-07-14T12:00:00.000Z',
      pendingPort: candidate,
    };
    return this.snapshot();
  }
  async configureAnalyzer(configuration: AnalyzerConfig): Promise<DeviceSnapshot> { this.analyzer = configuration; return this.snapshot(); }
  async acquireSweep(): Promise<Sweep> {
    const configuration = this.analyzer!;
    return {
      kind: 'spectrum', id: 'sweep:1', sequence: 1, capturedAt: '2026-07-14T12:00:00.000Z', elapsedMilliseconds: 1,
      frequencyHz: Array.from({ length: configuration.points }, (_, index) => configuration.startHz + (configuration.stopHz - configuration.startHz) * index / (configuration.points - 1)),
      powerDbm: Array.from({ length: configuration.points }, () => -80), requested: configuration,
      actualStartHz: configuration.startHz, actualStopHz: configuration.stopHz, actualRbwHz: 10_000, actualAttenuationDb: 0,
      source: 'scanraw-binary', complete: true, identity: {} as Sweep['identity'],
    };
  }
  async acquireZeroSpan(configuration: ZeroSpanConfig): Promise<ZeroSpanCapture> {
    this.zero = configuration;
    return {
      kind: 'zero-span', id: 'zero:1', sequence: 2, capturedAt: '2026-07-14T12:00:01.000Z', elapsedMilliseconds: 1,
      frequencyHz: configuration.frequencyHz, samplePeriodSeconds: configuration.sweepTimeSeconds / configuration.points,
      powerDbm: Array.from({ length: configuration.points }, () => -70), requested: configuration,
      actualRbwHz: 10_000, actualAttenuationDb: 0, source: 'scan-text', complete: true, identity: {} as ZeroSpanCapture['identity'],
    };
  }
  async configureGenerator(configuration: GeneratorConfig): Promise<DeviceSnapshot> {
    this.generator = configuration;
    this.#snapshot = { ...this.#snapshot, mode: 'generator', generatorOutput: 'off' };
    return this.snapshot();
  }
  setGeneratorOutput(enabled: boolean): Promise<DeviceSnapshot> {
    this.#snapshot = { ...this.#snapshot, generatorOutput: enabled ? 'on' : 'off' };
    return this.generatorOutput(enabled);
  }
  async readDiagnostics(): Promise<DeviceDiagnostics> {
    return {
      identity: { model: 'tinySA Ultra+ ZS407', hardwareVersion: 'ZS407', firmwareVersion: 'fixture' } as DeviceDiagnostics['identity'],
      firmwareVersionResponse: 'fixture', infoLines: ['fixture'], commands: ['version'], rawSweepOffsetDb: 0,
      analyzerReadback: { startHz: 88_000_000, stopHz: 108_000_000, points: 20 } as DeviceDiagnostics['analyzerReadback'],
      telemetry: { batteryMillivolts: 4_200, deviceId: 407, sweepStatus: 'paused', capturedAt: '2026-07-14T12:00:00.000Z' },
      capturedAt: '2026-07-14T12:00:00.000Z',
    };
  }
  async captureScreen(): Promise<ScreenFrame> {
    return { width: 480, height: 320, format: 'rgb565le', pixels: new Uint8Array(480 * 320 * 2), capturedAt: '2026-07-14T12:00:00.000Z' };
  }
  async touch(point: ScreenPoint): Promise<void> { this.touchCalls.push(point); }
  async releaseTouch(point?: ScreenPoint): Promise<void> { this.releaseCalls.push(point); }
  subscribe(listener: (event: DeviceEvent) => void): () => void {
    this.#listeners.add(listener);
    const event = this.eventOnSubscribe;
    this.eventOnSubscribe = undefined;
    if (event) listener(event);
    return () => this.#listeners.delete(listener);
  }
}

function disconnectedSnapshot(): DeviceSnapshot {
  return { connection: 'disconnected', mode: 'idle', generatorOutput: 'off', verification: 'stale' };
}
