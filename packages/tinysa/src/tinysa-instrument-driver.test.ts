import { describe, expect, it, vi } from 'vitest';
import {
  DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT,
  FIRMWARE_SOURCE_COMMIT,
  ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  instrumentCandidateSchema,
  type AnalyzerConfig,
  type DeviceCapabilities,
  type DeviceDiagnostics,
  type DeviceEvent,
  type DeviceSnapshot,
  type GeneratorConfig,
  type InstrumentSessionEvent,
  type PortCandidate,
  type ScreenFrame,
  type ScreenPoint,
  type Sweep,
  type ZeroSpanCapture,
  type ZeroSpanConfig,
} from '@tinysa/contracts';
import { TinySaZs407InstrumentDriver, type TinySaInstrumentDevicePort } from './tinysa-instrument-driver.js';
import { admittedTinySaDetectedPowerConfiguration, admittedTinySaSpectrumConfiguration } from './scalar-configuration.js';
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

  it('rejects invented supported-OEM revision and commit pairs from the device boundary', async () => {
    const mutations = [
      { revision: 'deadbee', sourceCommit: `deadbee${'0'.repeat(33)}` },
      { revision: 'c5dd31f', sourceCommit: FIRMWARE_SOURCE_COMMIT },
    ];
    for (const mutation of mutations) {
      const device = new FakeTinySaDevice();
      const connect = device.connect.bind(device);
      vi.spyOn(device, 'connect').mockImplementation(async (candidate) => {
        const snapshot = await connect(candidate);
        return {
          ...snapshot,
          identity: {
            ...snapshot.identity!,
            firmwareVersion: `tinySA4_injected-g${mutation.revision}`,
            firmwareReportedRevision: mutation.revision,
            firmwareSourceCommit: mutation.sourceCommit,
            firmwareQualification: 'supported-oem',
            firmwareWarning: undefined,
          } as NonNullable<DeviceSnapshot['identity']>,
        };
      });
      const driver = new TinySaZs407InstrumentDriver(device);
      const descriptor = (await driver.discover()).candidates[0]!;
      const candidate = instrumentCandidateSchema.parse({ ...descriptor, discoveryRevision: 'discovery:injected' });
      await expect(driver.connect(candidate)).rejects.toThrow(/contradictory (?:device identity|firmware provenance)/);
    }
  });

  it('rejects a known supported-OEM pair when the version reports a different revision', async () => {
    const device = new FakeTinySaDevice();
    const connect = device.connect.bind(device);
    vi.spyOn(device, 'connect').mockImplementation(async (candidate) => {
      const snapshot = await connect(candidate);
      return {
        ...snapshot,
        identity: {
          ...snapshot.identity!,
          firmwareVersion: 'custom-lab-v99-gdeadbee',
          firmwareReportedRevision: 'c5dd31f',
          firmwareSourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
          firmwareQualification: 'supported-oem',
          firmwareWarning: undefined,
        } as NonNullable<DeviceSnapshot['identity']>,
      };
    });
    const driver = new TinySaZs407InstrumentDriver(device);
    const descriptor = (await driver.discover()).candidates[0]!;
    const candidate = instrumentCandidateSchema.parse({ ...descriptor, discoveryRevision: 'discovery:mismatched-version' });
    await expect(driver.connect(candidate)).rejects.toThrow(/contradictory (?:device identity|firmware version and reported revision)/);
  });

  it('rejects physical identity port evidence that contradicts the admitted candidate', async () => {
    const mutations: readonly Partial<PortCandidate>[] = [
      { path: '/dev/tty.other' },
      { vendorId: 'ffff' },
      { productId: 'ffff' },
      { serialNumber: 'OTHER407' },
    ];
    for (const mutation of mutations) {
      const device = new FakeTinySaDevice();
      const connect = device.connect.bind(device);
      vi.spyOn(device, 'connect').mockImplementation(async (candidate) => {
        const snapshot = await connect(candidate);
        return {
          ...snapshot,
          identity: {
            ...snapshot.identity!,
            port: { ...snapshot.identity!.port, ...mutation },
          },
        };
      });
      const driver = new TinySaZs407InstrumentDriver(device);
      const descriptor = (await driver.discover()).candidates.find((item) => item.sourceKind === 'serial-port')!;
      const candidate = instrumentCandidateSchema.parse({ ...descriptor, discoveryRevision: 'discovery:contradictory-port' });
      await expect(driver.connect(candidate)).rejects.toThrow(/contradictory device identity|invalid port provenance|does not match the admitted serial candidate/);
    }
  });

  it('rejects firmware-twin identity evidence that contradicts the admitted executable', async () => {
    const mutations = [
      { repositoryCommit: 'f'.repeat(40) },
      { firmwareBinarySha256: 'f'.repeat(64) },
    ];
    for (const mutation of mutations) {
      const device = new FakeTinySaDevice();
      const connect = device.connect.bind(device);
      vi.spyOn(device, 'connect').mockImplementation(async (candidate) => {
        const snapshot = await connect(candidate);
        const mutatedTwin = { ...snapshot.identity!.digitalTwin!, ...mutation };
        return {
          ...snapshot,
          identity: {
            ...snapshot.identity!,
            digitalTwin: mutatedTwin,
            port: { ...snapshot.identity!.port, digitalTwin: mutatedTwin },
          } as NonNullable<DeviceSnapshot['identity']>,
        };
      });
      const driver = new TinySaZs407InstrumentDriver(device);
      const descriptor = (await driver.discover()).candidates.find((item) => item.sourceKind === 'tinysa-firmware-twin')!;
      const candidate = instrumentCandidateSchema.parse({ ...descriptor, discoveryRevision: 'discovery:contradictory-twin' });
      await expect(driver.connect(candidate)).rejects.toThrow(/contradictory device identity|invalid port provenance|does not match the admitted firmware-twin candidate/);
    }
  });

  it('rejects top-level physical and twin identity labels that contradict execution provenance', async () => {
    {
      const device = new FakeTinySaDevice();
      const connect = device.connect.bind(device);
      vi.spyOn(device, 'connect').mockImplementation(async (candidate) => {
        const snapshot = await connect(candidate);
        return { ...snapshot, identity: { ...snapshot.identity!, simulated: true } };
      });
      const driver = new TinySaZs407InstrumentDriver(device);
      const descriptor = (await driver.discover()).candidates.find((item) => item.sourceKind === 'serial-port')!;
      await expect(driver.connect(instrumentCandidateSchema.parse({ ...descriptor, discoveryRevision: 'discovery:physical-label' })))
        .rejects.toThrow('contradictory device identity');
    }
    for (const mutation of [
      { simulated: false },
      { usbIdentityVerified: true },
      { firmwareQualification: 'protocol-test' as const },
    ]) {
      const device = new FakeTinySaDevice();
      const connect = device.connect.bind(device);
      vi.spyOn(device, 'connect').mockImplementation(async (candidate) => {
        const snapshot = await connect(candidate);
        return {
          ...snapshot,
          identity: { ...snapshot.identity!, ...mutation } as NonNullable<DeviceSnapshot['identity']>,
        };
      });
      const driver = new TinySaZs407InstrumentDriver(device);
      const descriptor = (await driver.discover()).candidates.find((item) => item.sourceKind === 'tinysa-firmware-twin')!;
      await expect(driver.connect(instrumentCandidateSchema.parse({ ...descriptor, discoveryRevision: 'discovery:twin-label' })))
        .rejects.toThrow('contradictory device identity');
    }
  });

  it('maps high-level spectrum and detected-power operations without leaking shell transport', async () => {
    const device = new FakeTinySaDevice();
    const driver = new TinySaZs407InstrumentDriver(device);
    const descriptor = (await driver.discover()).candidates[0]!;
    const candidate = instrumentCandidateSchema.parse({ ...descriptor, discoveryRevision: 'discovery:1' });
    const session = await driver.connect(candidate);
    expect(session.provenance).toMatchObject({
      sourceKind: 'serial-port', qualification: 'device-observed',
      device: {
        firmwareReportedRevision: 'fffffff',
        firmwareQualification: 'custom-unqualified',
        firmwareWarning: 'Custom firmware revision fffffff is admitted without source qualification.',
        usbIdentityVerified: true,
      },
    });
    expect(session.provenance).not.toHaveProperty('device.firmwareSourceCommit');
    expect(session.capabilities.acquisitions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'swept-spectrum', sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.003, max: 60, step: 0.000_001 } },
        controls: expect.objectContaining({
          model: 'receiver', acquisitionFormats: ['text', 'raw'],
          resolutionBandwidthKhz: {
            automatic: true, manual: { min: 0.2, max: 850, step: 0.1 },
          },
          detectors: expect.arrayContaining(['sample', 'quasi-peak']),
        }),
      }),
      expect.objectContaining({
        kind: 'detected-power-timeseries', sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.003, max: 60, step: 0.000_001 } },
        controls: expect.objectContaining({
          model: 'receiver', triggerModes: ['auto', 'normal', 'single'],
          triggerLevelDbm: { min: -174, max: 30 },
        }),
      }),
    ]));

    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:1',
      configuration: {
        kind: 'swept-spectrum', startHz: 88_000_000, stopHz: 108_000_000, points: 20, sweepTimeSeconds: 0.25,
        controls: {
          schemaVersion: 1, model: 'receiver', acquisitionFormat: 'text', resolutionBandwidthKhz: 30,
          attenuationDb: 7, detector: 'quasi-peak', spurRejection: 'on', lowNoiseAmplifier: 'on',
          avoidSpurs: 'off', trigger: { mode: 'normal', levelDbm: -63 },
        },
      },
    });
    expect(device.analyzer).toEqual({
      startHz: 88_000_000, stopHz: 108_000_000, points: 20, sweepTimeSeconds: 0.25,
      acquisitionFormat: 'text', rbwKhz: 30, attenuationDb: 7, detector: 'quasi-peak',
      spurRejection: 'on', lna: 'on', avoidSpurs: 'off', trigger: { mode: 'normal', levelDbm: -63 },
    });
    await expect(session.acquire()).resolves.toMatchObject({
      kind: 'swept-spectrum', sessionId: session.sessionId, configurationRevision: 'configuration:1',
      elapsedMilliseconds: 1, resolutionBandwidthHz: 30_000, attenuationDb: 7,
      qualification: 'device-observed',
    });

    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:2',
      configuration: {
        kind: 'detected-power-timeseries', centerHz: 98_000_000, sampleCount: 20, sweepTimeSeconds: 0.02,
        controls: { schemaVersion: 1, model: 'receiver', resolutionBandwidthKhz: 100, attenuationDb: 9, trigger: { mode: 'single', levelDbm: -71 } },
      },
    });
    expect(device.zero).toEqual({ frequencyHz: 98_000_000, points: 20, sweepTimeSeconds: 0.02, rbwKhz: 100, attenuationDb: 9, trigger: { mode: 'single', levelDbm: -71 } });
    const detected = await session.acquire();
    expect(detected).toMatchObject({ kind: 'detected-power-timeseries', centerHz: 98_000_000 });
    if (detected.kind !== 'detected-power-timeseries') throw new Error('Expected detected-power fixture');
    expect(detected.powerDbm).toHaveLength(20);
  });

  it('rejects incomplete device acquisitions instead of laundering them as complete', async () => {
    const device = new FakeTinySaDevice();
    const driver = new TinySaZs407InstrumentDriver(device);
    const descriptor = (await driver.discover()).candidates.find((item) => item.sourceKind === 'serial-port')!;
    const session = await driver.connect(instrumentCandidateSchema.parse({ ...descriptor, discoveryRevision: 'discovery:incomplete' }));
    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:spectrum',
      configuration: {
        kind: 'swept-spectrum', startHz: 88_000_000, stopHz: 108_000_000, points: 20, sweepTimeSeconds: 0.25,
        controls: {
          schemaVersion: 1, model: 'receiver', acquisitionFormat: 'text', resolutionBandwidthKhz: 30,
          attenuationDb: 7, detector: 'sample', spurRejection: 'auto', lowNoiseAmplifier: 'off',
          avoidSpurs: 'auto', trigger: { mode: 'auto' },
        },
      },
    });
    const acquireSweep = device.acquireSweep.bind(device);
    const sweepSpy = vi.spyOn(device, 'acquireSweep').mockImplementation(async () => ({
      ...await acquireSweep(), complete: false,
    }) as unknown as Sweep);
    await expect(session.acquire()).rejects.toThrow('incomplete swept-spectrum acquisition');
    sweepSpy.mockRestore();

    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:detected',
      configuration: {
        kind: 'detected-power-timeseries', centerHz: 98_000_000, sampleCount: 20, sweepTimeSeconds: 0.02,
        controls: { schemaVersion: 1, model: 'receiver', resolutionBandwidthKhz: 100, attenuationDb: 9, trigger: { mode: 'auto' } },
      },
    });
    const acquireZeroSpan = device.acquireZeroSpan.bind(device);
    vi.spyOn(device, 'acquireZeroSpan').mockImplementation(async () => ({
      ...await acquireZeroSpan(), complete: false,
    }) as unknown as ZeroSpanCapture);
    await expect(session.acquire()).rejects.toThrow('incomplete detected-power acquisition');
  });

  it('rejects measurements carrying an identity other than the connected device', async () => {
    const device = new FakeTinySaDevice();
    const driver = new TinySaZs407InstrumentDriver(device);
    const descriptor = (await driver.discover()).candidates.find((item) => item.sourceKind === 'serial-port')!;
    const session = await driver.connect(instrumentCandidateSchema.parse({ ...descriptor, discoveryRevision: 'discovery:wrong-device' }));
    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:spectrum',
      configuration: {
        kind: 'swept-spectrum', startHz: 88_000_000, stopHz: 108_000_000, points: 20, sweepTimeSeconds: 0.25,
        controls: {
          schemaVersion: 1, model: 'receiver', acquisitionFormat: 'text', resolutionBandwidthKhz: 30,
          attenuationDb: 7, detector: 'sample', spurRejection: 'auto', lowNoiseAmplifier: 'off',
          avoidSpurs: 'auto', trigger: { mode: 'auto' },
        },
      },
    });
    const acquireSweep = device.acquireSweep.bind(device);
    const sweepSpy = vi.spyOn(device, 'acquireSweep').mockImplementation(async () => {
      const sweep = await acquireSweep();
      return {
        ...sweep,
        identity: { ...sweep.identity, firmwareVersion: 'tinySA4_v1.4.6-gdeadbee' },
      } as Sweep;
    });
    await expect(session.acquire()).rejects.toThrow('identity does not match the admitted device session');
    sweepSpy.mockRestore();

    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:detected',
      configuration: {
        kind: 'detected-power-timeseries', centerHz: 98_000_000, sampleCount: 20, sweepTimeSeconds: 0.02,
        controls: { schemaVersion: 1, model: 'receiver', resolutionBandwidthKhz: 100, attenuationDb: 9, trigger: { mode: 'auto' } },
      },
    });
    const acquireZeroSpan = device.acquireZeroSpan.bind(device);
    vi.spyOn(device, 'acquireZeroSpan').mockImplementation(async () => {
      const capture = await acquireZeroSpan();
      return {
        ...capture,
        identity: {
          ...capture.identity,
          port: { ...('kind' in capture.identity ? physical : capture.identity.port), path: '/dev/tty.other' },
        },
      } as ZeroSpanCapture;
    });
    await expect(session.acquire()).rejects.toThrow('identity does not match the admitted device session');
  });

  it('rejects acquisition controls or geometry that differ from the admitted configuration', async () => {
    const device = new FakeTinySaDevice();
    const driver = new TinySaZs407InstrumentDriver(device);
    const descriptor = (await driver.discover()).candidates.find((item) => item.sourceKind === 'serial-port')!;
    const session = await driver.connect(instrumentCandidateSchema.parse({ ...descriptor, discoveryRevision: 'discovery:stale-controls' }));
    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:spectrum',
      configuration: {
        kind: 'swept-spectrum', startHz: 88_000_000, stopHz: 108_000_000, points: 20, sweepTimeSeconds: 0.25,
        controls: {
          schemaVersion: 1, model: 'receiver', acquisitionFormat: 'text', resolutionBandwidthKhz: 30,
          attenuationDb: 7, detector: 'sample', spurRejection: 'auto', lowNoiseAmplifier: 'off',
          avoidSpurs: 'auto', trigger: { mode: 'auto' },
        },
      },
    });
    const acquireSweep = device.acquireSweep.bind(device);
    const sweepSpy = vi.spyOn(device, 'acquireSweep').mockImplementation(async () => {
      const sweep = await acquireSweep();
      if (sweep.requested.controls.model !== 'receiver') throw new Error('Expected receiver fixture');
      return {
        ...sweep,
        requested: {
          ...sweep.requested,
          controls: { ...sweep.requested.controls, detector: 'average' },
        },
      };
    });
    await expect(session.acquire()).rejects.toThrow('requested controls do not match the admitted configuration');
    sweepSpy.mockRestore();

    await session.configure({
      sessionId: session.sessionId,
      configurationRevision: 'configuration:detected',
      configuration: {
        kind: 'detected-power-timeseries', centerHz: 98_000_000, sampleCount: 20, sweepTimeSeconds: 0.02,
        controls: { schemaVersion: 1, model: 'receiver', resolutionBandwidthKhz: 100, attenuationDb: 9, trigger: { mode: 'auto' } },
      },
    });
    const acquireZeroSpan = device.acquireZeroSpan.bind(device);
    vi.spyOn(device, 'acquireZeroSpan').mockImplementation(async () => {
      const capture = await acquireZeroSpan();
      if (capture.requested.controls.model !== 'receiver') throw new Error('Expected receiver fixture');
      return {
        ...capture,
        requested: {
          ...capture.requested,
          controls: { ...capture.requested.controls, attenuationDb: 8 },
        },
      };
    });
    await expect(session.acquire()).rejects.toThrow('requested controls do not match the admitted configuration');
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
    const events: InstrumentSessionEvent[] = [];

    session.subscribe((event) => events.push(event));

    expect(events).toEqual([{
      type: 'error', sessionId: session.sessionId,
      error: { code: 'session-fault', message: 'device vanished during session handoff', recoverable: false },
    }]);
    if (events[0]?.type !== 'error') throw new Error('Expected terminal error replay');
    events[0].error.message = 'MUTATED BY FIRST CONSUMER';
    const laterEvents: InstrumentSessionEvent[] = [];
    session.subscribe((event) => laterEvents.push(event));
    expect(laterEvents).toEqual([{
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
        firmwareSourceCommit: DIGITAL_TWIN_FIRMWARE_SOURCE_COMMIT,
        firmwareQualification: 'executable-twin', port: candidate, simulated: true,
        usbIdentityVerified: false, execution: 'firmware-digital-twin', digitalTwin: candidate.digitalTwin,
      }
      : {
        model: 'tinySA Ultra+ ZS407', hardwareVersion: 'ZS407', firmwareVersion: 'tinySA4_v1.4.6-gfffffff',
        firmwareReportedRevision: 'fffffff', firmwareQualification: 'custom-unqualified', port: candidate,
        firmwareWarning: 'Custom firmware revision fffffff is admitted without source qualification.',
        simulated: false, usbIdentityVerified: true, execution: 'physical',
      };
    this.#snapshot = {
      connection: 'ready', mode: 'idle', generatorOutput: 'off', verification: 'commanded',
      sessionId: 'session:tiny', capabilities: fullDeviceCapabilities(),
      identity,
      connectedAt: '2026-07-14T12:00:00.000Z',
      pendingPort: candidate,
    };
    return this.snapshot();
  }
  async configureAnalyzer(configuration: AnalyzerConfig): Promise<DeviceSnapshot> { this.analyzer = configuration; return this.snapshot(); }
  async configureZeroSpan(configuration: ZeroSpanConfig): Promise<DeviceSnapshot> { this.zero = configuration; return this.snapshot(); }
  async acquireSweep(): Promise<Sweep> {
    const configuration = this.analyzer!;
    return {
      kind: 'spectrum', id: 'sweep:1', sequence: 1, capturedAt: '2026-07-14T12:00:00.000Z', elapsedMilliseconds: 1,
      frequencyHz: Array.from({ length: configuration.points }, (_, index) => configuration.startHz + (configuration.stopHz - configuration.startHz) * index / (configuration.points - 1)),
      powerDbm: Array.from({ length: configuration.points }, () => -80), requested: admittedTinySaSpectrumConfiguration(configuration),
      actualStartHz: configuration.startHz, actualStopHz: configuration.stopHz,
      actualRbwHz: typeof configuration.rbwKhz === 'number' ? configuration.rbwKhz * 1_000 : 10_000,
      actualAttenuationDb: typeof configuration.attenuationDb === 'number' ? configuration.attenuationDb : 0,
      source: 'scanraw-binary', complete: true, identity: structuredClone(this.#snapshot.identity!),
    };
  }
  async acquireZeroSpan(): Promise<ZeroSpanCapture> {
    const configuration = this.zero!;
    return {
      kind: 'zero-span', id: 'zero:1', sequence: 2, capturedAt: '2026-07-14T12:00:01.000Z', elapsedMilliseconds: 1,
      frequencyHz: configuration.frequencyHz, samplePeriodSeconds: configuration.sweepTimeSeconds / configuration.points,
      powerDbm: Array.from({ length: configuration.points }, () => -70), requested: admittedTinySaDetectedPowerConfiguration(configuration),
      actualRbwHz: typeof configuration.rbwKhz === 'number' ? configuration.rbwKhz * 1_000 : 10_000,
      actualAttenuationDb: typeof configuration.attenuationDb === 'number' ? configuration.attenuationDb : 0,
      source: 'scan-text', complete: true,
      identity: structuredClone(this.#snapshot.identity!),
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

function fullDeviceCapabilities(): DeviceCapabilities {
  return {
    profile: 'tinySA4-zs407',
    protocol: {
      transport: 'usb-cdc-acm', vendorId: '0483', productId: '5740', prompt: 'ch> ',
      commandTerminator: '\r', echoesCommands: true, maximumCommandCharacters: 47,
      usbTransactionsModeled: true,
    },
    analyzerFrequency: { min: 0, max: 17_922_600_000, unit: 'Hz' },
    analyzerNormalMaximumHz: 6_000_000_000,
    analyzerUltraTransitionHz: 5_340_000_000,
    generatorFrequency: { min: 1, max: 17_922_600_000, unit: 'Hz' },
    generatorFundamentalMaximumHz: 6_300_000_000,
    generatorLevel: { min: -115, max: -18.5, step: 0.5, unit: 'dBm' },
    rbwKhz: { min: 0.2, max: 850, step: 0.1, unit: 'kHz' },
    attenuationDb: { min: 0, max: 31, step: 1, unit: 'dB' },
    sweepPoints: { min: 20, max: 450, step: 1, unit: 'points' },
    sweepSeconds: { min: 0.003, max: 60, step: 0.000_001, unit: 'seconds' },
    scalarReceiver: {
      sweptSpectrum: true, detectedPower: true, acquisitionFormats: ['text', 'raw'],
      resolutionBandwidthAutomatic: true, attenuationAutomatic: true, sweepTimeAutomatic: true,
      detectors: ['sample', 'minimum-hold', 'maximum-hold', 'maximum-decay', 'average-4', 'average-16', 'average', 'quasi-peak'],
      spurRejection: ['off', 'on', 'auto'], lowNoiseAmplifier: ['off', 'on'],
      avoidSpurs: ['off', 'on', 'auto'], triggerModes: ['auto', 'normal', 'single'],
      triggerLevelDbm: { min: -174, max: 30, unit: 'dBm' },
    },
    maxSweepPoints: 450,
    screen: { width: 480, height: 320, format: 'rgb565le' },
    screenCapture: true, remoteTouch: true, streaming: true, rawSweep: true,
    rawSweepOffsetReadback: true, markerCount: 8, traceCount: 4,
    firmwareMarkers: true, firmwareTraces: true, generatorReadback: false,
    modulation: ['off', 'am', 'fm'],
    commands: ['version', 'info', 'help', 'output', 'mode', 'sweep', 'scan', 'scanraw', 'zero', 'rbw', 'attenuate', 'sweeptime', 'trace', 'calc', 'spur', 'avoid', 'lna', 'trigger', 'freq', 'level', 'modulation', 'capture', 'touch', 'release'],
    evidence: 'device-observed', hostContractSourceCommit: FIRMWARE_SOURCE_COMMIT,
    qualification: 'custom-firmware-unqualified',
  };
}

function disconnectedSnapshot(): DeviceSnapshot {
  return { connection: 'disconnected', mode: 'idle', generatorOutput: 'off', verification: 'stale' };
}
