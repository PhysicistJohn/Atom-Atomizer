import { describe, expect, it } from 'vitest';
import {
  FIRMWARE_SOURCE_COMMIT,
  ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  type AnalyzerConfig,
  type GeneratorConfig,
  type PortCandidate,
} from '@tinysa/contracts';
import { FakeTinySaTransport } from '@tinysa/test-device';
import { TinySaDeviceService } from './device.js';
import { InstrumentDriverRegistry } from './instrument-driver-registry.js';
import { InstrumentManager } from './instrument-manager.js';
import { TinySaZs407InstrumentDriver } from './tinysa-instrument-driver.js';
import type { ByteTransport, TransportDiscoveryResult, TransportEvent } from './transport.js';

const generator: GeneratorConfig = {
  frequencyHz: 100_000_000,
  levelDbm: -30,
  path: 'mixer',
  modulation: 'off',
  modulationFrequencyHz: 1_000,
  amDepthPercent: 80,
  fmDeviationHz: 3_000,
};

const analyzer: AnalyzerConfig = {
  startHz: 88_000_000,
  stopHz: 108_000_000,
  points: 20,
  acquisitionFormat: 'text',
  rbwKhz: 30,
  attenuationDb: 7,
  sweepTimeSeconds: 0.25,
  detector: 'quasi-peak',
  spurRejection: 'on',
  lna: 'on',
  avoidSpurs: 'off',
  trigger: { mode: 'normal', levelDbm: -63 },
};

describe('device fail-loud lifecycle', () => {
  it('admits the shipped ZS407 identity from its explicit info line and resolves exact source provenance', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-217-gc5dd31f\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-217-gc5dd31f\r\nPlatform: STM32F303',
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    const connected = await service.connect(transport.port);

    expect(connected.identity).toMatchObject({
      model: 'tinySA Ultra+ ZS407',
      hardwareVersion: 'V0.5.4 max2871',
      firmwareReportedRevision: 'c5dd31f',
      firmwareSourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
      firmwareQualification: 'supported-oem',
      usbIdentityVerified: true,
      execution: 'physical',
    });
    expect(connected.capabilities).toMatchObject({
      evidence: 'device-observed',
      firmwareSourceCommit: ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
      hostContractSourceCommit: FIRMWARE_SOURCE_COMMIT,
      qualification: 'device-observed-awaiting-rf-qualification',
    });
    expect(bytes.writes.slice(0, 4)).toEqual(['output off', 'version', 'info', 'help']);
    await service.disconnect();
  });

  it('normalizes physical ZS407 RGB565 panel bytes to the little-endian screen contract', async () => {
    const bytes = new FakeTinySaTransport({ screenCaptureByteOrder: 'big-endian' });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    await service.connect(transport.port);

    const frame = await service.captureScreen();

    expect(frame).toMatchObject({ width: 480, height: 320, format: 'rgb565le' });
    expect(frame.pixels).toHaveLength(307_200);
    // The fixture's first pixel is canonical RGB565 0x10a3.  The physical
    // command emits 10 a3; ScreenFrame must expose the LE bytes a3 10.
    expect(Array.from(frame.pixels.slice(0, 2))).toEqual([0xa3, 0x10]);
    await service.disconnect();
  });

  it('rejects a tinySA4 that has no strict ZS407 evidence', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-217-gc5dd31f\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA ZS405\r\nVersion: tinySA4_v1.4-217-gc5dd31f',
    });
    const transport = new PhysicalFixtureTransport(bytes);
    await expect(new TinySaDeviceService(transport).connect(transport.port)).rejects.toThrow(/not a ZS407/);
  });

  it('does not treat an operation-only unknown response as acknowledgement of mandatory output-off', async () => {
    const bytes = new FakeTinySaTransport({ commandResponses: { 'output off': 'output?' } });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);

    await expect(service.connect(transport.port)).rejects.toThrow(/rejected command output off/i);

    expect(service.snapshot()).toMatchObject({ connection: 'disconnected', generatorOutput: 'unknown' });
  });

  it('invalidates an older RF-off acknowledgement when a later output-off attempt is rejected', async () => {
    const bytes = new FakeTinySaTransport({
      commandResponseSequences: { 'output off': ['', '', 'output?', ''] },
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    await service.connect(transport.port);

    await expect(service.configureAnalyzer(analyzer)).rejects.toThrow(/rejected command output off/i);
    expect(service.snapshot()).toMatchObject({ connection: 'faulted', generatorOutput: 'unknown', verification: 'unknown' });
    await service.disconnect();

    expect(bytes.writes.filter((command) => command === 'output off')).toHaveLength(4);
    expect(service.snapshot()).toMatchObject({ connection: 'disconnected', generatorOutput: 'unknown' });
  });

  it('admits an otherwise valid ZS407 custom revision with explicit unqualified provenance', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-999-gdeadbee\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-999-gdeadbee',
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    const connected = await service.connect(transport.port);

    expect(connected.identity).toMatchObject({
      firmwareReportedRevision: 'deadbee',
      firmwareQualification: 'custom-unqualified',
      firmwareWarning: expect.stringMatching(/admitted without source qualification/i),
      usbIdentityVerified: true,
    });
    expect(connected.identity).not.toHaveProperty('firmwareSourceCommit');
    expect(connected.capabilities).toMatchObject({ qualification: 'custom-firmware-unqualified' });
    expect(connected.capabilities).not.toHaveProperty('firmwareSourceCommit');
    expect(bytes.writes.slice(0, 6)).toEqual(['output off', 'version', 'info', 'help', 'output off', 'mode input']);
    expect(connected.generatorOutput).toBe('off');
    await service.disconnect();
  });

  it('projects only the proven reduced custom-firmware receiver surface and exact advertised ranges', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-999-gdeadbee\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-999-gdeadbee',
      helpCommands: [
        'version', 'info', 'help', 'output', 'mode', 'sweep', 'rbw', 'attenuate', 'status', 'vbat', 'deviceid',
        'scan', 'trace', 'sweeptime', 'calc', 'spur', 'avoid', 'lna', 'trigger', 'touch', 'release',
      ],
      commandResponses: {
        'rbw ?': 'usage: rbw 5..25|auto',
        'attenuate ?': 'usage: attenuate 2..12|auto',
        'sweeptime ?': 'usage: sweeptime 0.01..2',
        'trace ?': 'usage: trace {dBm|RAW}',
      },
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    const manager = new InstrumentManager(new InstrumentDriverRegistry([
      new TinySaZs407InstrumentDriver(service),
    ]));
    const connected = await manager.connect((await manager.discover()).candidates[0]!);

    expect(connected).toMatchObject({
      rfOutput: 'not-supported',
      rfOutputQualification: 'not-applicable',
      provenance: { device: { firmwareQualification: 'custom-unqualified' } },
      capabilities: {
        acquisitions: expect.arrayContaining([
          expect.objectContaining({
            kind: 'swept-spectrum',
            frequencyHz: { min: 88_000_000, max: 108_000_000 },
            points: { min: 450, max: 450 },
            sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.01, max: 2 } },
            controls: expect.objectContaining({
              acquisitionFormats: ['text'],
              resolutionBandwidthKhz: { automatic: true, manual: { min: 5, max: 25 } },
              attenuationDb: { automatic: true, manual: { min: 2, max: 12 } },
              triggerModes: ['auto'],
            }),
          }),
          expect.objectContaining({
            kind: 'detected-power-timeseries',
            centerFrequencyHz: { min: 88_000_000, max: 108_000_000 },
            sampleCount: { min: 450, max: 450 },
            controls: expect.objectContaining({ triggerModes: ['auto'] }),
          }),
        ]),
        features: [{ kind: 'touch', width: 480, height: 320 }],
      },
    });
    const spectrum = connected.capabilities.acquisitions.find((capability) => capability.kind === 'swept-spectrum');
    expect(spectrum?.controls).not.toHaveProperty('triggerLevelDbm');

    await manager.executeFeature({ kind: 'touch', action: 'tap', x: 12, y: 34 });
    expect(bytes.writes.slice(-3)).toEqual(['touch 12 34', 'release 12 34', 'output off']);
    expect(manager.snapshot()?.rfOutput).toBe('not-supported');

    await expect(manager.configure({
      kind: 'swept-spectrum', startHz: 88_000_000, stopHz: 108_000_000, points: 450, sweepTimeSeconds: 0.5,
      controls: {
        schemaVersion: 1, model: 'receiver', acquisitionFormat: 'text', resolutionBandwidthKhz: 30,
        attenuationDb: 5, detector: 'quasi-peak', spurRejection: 'on', lowNoiseAmplifier: 'on',
        avoidSpurs: 'off', trigger: { mode: 'auto' },
      },
    })).rejects.toThrow(/resolution bandwidth/i);
    expect(bytes.writes).not.toContain('rbw 30');

    await manager.configure({
      kind: 'swept-spectrum', startHz: 88_000_000, stopHz: 108_000_000, points: 450, sweepTimeSeconds: 0.5,
      controls: {
        schemaVersion: 1, model: 'receiver', acquisitionFormat: 'text', resolutionBandwidthKhz: 20,
        attenuationDb: 5, detector: 'quasi-peak', spurRejection: 'on', lowNoiseAmplifier: 'on',
        avoidSpurs: 'off', trigger: { mode: 'auto' },
      },
    });
    const outputOffBeforeAcquire = bytes.writes.filter((command) => command === 'output off').length;
    const measurement = await manager.acquire();

    expect(measurement).toMatchObject({ kind: 'swept-spectrum', qualification: 'device-observed' });
    expect(bytes.writes.filter((command) => command === 'output off')).toHaveLength(outputOffBeforeAcquire + 1);
    const scan = bytes.writes.lastIndexOf('scan 88000000 108000000 450 3');
    expect(scan).toBeGreaterThan(-1);
    expect(bytes.writes.slice(scan + 1)).not.toContain('trace');
    await manager.disconnect();
  });

  it('fails closed and cleans up when custom firmware cannot describe any complete acquisition', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-999-gdeadbee\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-999-gdeadbee',
      helpCommands: [
        'version', 'info', 'help', 'output', 'mode', 'sweep', 'rbw', 'attenuate', 'status', 'vbat', 'deviceid',
        'sweeptime',
      ],
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    const manager = new InstrumentManager(new InstrumentDriverRegistry([
      new TinySaZs407InstrumentDriver(service),
    ]));
    const candidate = (await manager.discover()).candidates[0]!;

    await expect(manager.connect(candidate)).rejects.toThrow(/could not open the selected candidate/i);

    expect(service.snapshot()).toMatchObject({ connection: 'disconnected', generatorOutput: 'unknown' });
    expect(manager.snapshot()).toBeUndefined();
    expect(manager.pendingConnectionCleanup()).toBeUndefined();
  });

  it('rejects custom firmware whose scalar control ranges are not explicitly parseable', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_v1.4-999-gdeadbee\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_v1.4-999-gdeadbee',
      commandResponses: { 'rbw ?': 'usage: rbw implementation-defined' },
    });
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);

    await expect(service.connect(transport.port)).rejects.toThrow(/did not advertise parseable RBW/i);

    expect(service.snapshot()).toMatchObject({ connection: 'disconnected' });
  });

  it('resets every automatic analyzer control explicitly, including firmware sweeptime zero', async () => {
    const bytes = new FakeTinySaTransport();
    const transport = new PhysicalFixtureTransport(bytes);
    const service = new TinySaDeviceService(transport);
    await service.connect(transport.port);

    await service.configureAnalyzer(analyzer);
    const automatic = await service.configureAnalyzer({
      ...analyzer,
      rbwKhz: 'auto',
      attenuationDb: 'auto',
      sweepTimeSeconds: 'auto',
      spurRejection: 'auto',
      avoidSpurs: 'auto',
      trigger: { mode: 'auto' },
    });

    const manualSweepTime = bytes.writes.lastIndexOf('sweeptime 0.25');
    const automaticCommands = bytes.writes.slice(manualSweepTime + 1);
    expect(automaticCommands).toEqual(expect.arrayContaining([
      'rbw auto', 'attenuate auto', 'sweeptime 0', 'spur auto', 'avoid auto', 'trigger auto',
    ]));
    expect(automaticCommands.indexOf('sweeptime 0')).toBeGreaterThan(automaticCommands.indexOf('attenuate auto'));
    expect(automatic.analyzer).toMatchObject({
      requested: { rbwKhz: 'auto', attenuationDb: 'auto', sweepTimeSeconds: 'auto', spurRejection: 'auto', avoidSpurs: 'auto', trigger: { mode: 'auto' } },
      readback: { actualRbwHz: expect.any(Number), attenuationDb: expect.any(Number) },
      verification: 'commanded',
    });
    await service.disconnect();
  });

  it('turns RF off and prepares detected power completely during configuration, before acquisition', async () => {
    const bytes = new FakeTinySaTransport();
    const transport = new PhysicalFixtureTransport(bytes);
    const manager = new InstrumentManager(new InstrumentDriverRegistry([
      new TinySaZs407InstrumentDriver(new TinySaDeviceService(transport)),
    ]));
    await manager.connect((await manager.discover()).candidates[0]!);
    await manager.executeFeature({
      kind: 'rf-generator', action: 'configure', frequencyHz: generator.frequencyHz,
      levelDbm: generator.levelDbm, path: generator.path, modulation: { mode: 'off' },
    });
    await manager.executeFeature({ kind: 'rf-generator', action: 'set-output', enabled: true });
    expect(manager.snapshot()?.rfOutput).toBe('on');

    const outputOn = bytes.writes.lastIndexOf('output on');
    const configured = await manager.configure(detectedPowerConfiguration());
    const configurationCommands = bytes.writes.slice(outputOn + 1);

    expect(configured.configuration).toEqual(detectedPowerConfiguration());
    expect(manager.snapshot()).toMatchObject({ rfOutput: 'off', configuration: configured });
    expect(configurationCommands.slice(0, 9)).toEqual([
      'output off', 'mode input', 'trace dBm', 'sweep 100000000 100000000 20',
      'rbw 100', 'attenuate 9', 'sweeptime 0.02', 'trigger single', 'trigger -71',
    ]);
    expect(configurationCommands).not.toContain('scan 100000000 100000000 20 3');

    await manager.acquire();
    expect(bytes.writes).toContain('scan 100000000 100000000 20 3');
    await manager.disconnect();
  });

  it('never publishes a detected-power configuration when a physical preparation command fails', async () => {
    const bytes = new FakeTinySaTransport({ commandResponses: { 'rbw 100': 'usage: rbw 0.2..850|auto' } });
    const transport = new PhysicalFixtureTransport(bytes);
    const manager = new InstrumentManager(new InstrumentDriverRegistry([
      new TinySaZs407InstrumentDriver(new TinySaDeviceService(transport)),
    ]));
    const events: unknown[] = [];
    manager.subscribe((event) => events.push(event));
    await manager.connect((await manager.discover()).candidates[0]!);

    await expect(manager.configure(detectedPowerConfiguration())).rejects.toThrow(/configuration failed/i);

    expect(bytes.writes).toContain('output off');
    expect(bytes.writes).toContain('rbw 100');
    expect(events.some((event) => (event as { type?: unknown }).type === 'configured')).toBe(false);
    expect(manager.snapshot()?.configuration).toBeUndefined();
    expect(manager.snapshot()?.fault).toBeDefined();
    await manager.disconnect();
  });

  it('still rejects firmware that omits a parseable source revision', async () => {
    const bytes = new FakeTinySaTransport({
      versionResponse: 'tinySA4_custom\r\nHW Version:V0.5.4 max2871',
      infoResponse: 'tinySA ULTRA+ ZS407\r\nVersion: tinySA4_custom',
    });
    const transport = new PhysicalFixtureTransport(bytes);
    await expect(new TinySaDeviceService(transport).connect(transport.port)).rejects.toThrow(/did not report a source revision/);
  });

  it('reports RF-off failure during disconnect and enters faulted/unknown state', async () => {
    const transport = new FailDisconnectOutputOffTransport();
    const service = new TinySaDeviceService(transport);
    await service.connect(transport.port);
    await service.configureGenerator(generator);
    await service.setGeneratorOutput(true);

    await expect(service.disconnect()).rejects.toThrow(/forced output-off failure/);
    expect(service.snapshot()).toMatchObject({ connection: 'faulted', generatorOutput: 'unknown', verification: 'unknown' });
  });

  it('marks an unexpected cable loss as faulted with unknown RF state', async () => {
    const transport = new FakeTinySaTransport();
    const service = new TinySaDeviceService(transport);
    await service.connect(transport.port);
    await service.configureGenerator(generator);
    await service.setGeneratorOutput(true);
    transport.unplug();
    expect(service.snapshot()).toMatchObject({ connection: 'faulted', generatorOutput: 'unknown', verification: 'unknown' });
  });

  it('retains an RF-off session after close failure so manager shutdown can retry to completion', async () => {
    const transport = new RetryPhysicalCloseTransport();
    const service = new TinySaDeviceService(transport);
    const manager = new InstrumentManager(new InstrumentDriverRegistry([
      new TinySaZs407InstrumentDriver(service),
    ]));
    const candidate = (await manager.discover()).candidates[0]!;
    await manager.connect(candidate);

    await expect(manager.disconnect()).rejects.toThrow(/forced transient close failure/);
    expect(manager.snapshot()).toMatchObject({
      fault: { recoverable: false },
      rfOutput: 'unknown',
    });
    expect(service.snapshot()).toMatchObject({
      connection: 'faulted',
      generatorOutput: 'off',
      verification: 'commanded',
    });

    await expect(manager.disconnect()).resolves.toBeUndefined();
    expect(transport.closeCalls).toBe(2);
    expect(manager.snapshot()).toBeUndefined();
    expect(service.snapshot()).toMatchObject({ connection: 'disconnected' });
  });

  it('retains a failed-connect transport for explicit app-owned cleanup retries', async () => {
    const transport = new RetryRejectedConnectCloseTransport();
    const service = new TinySaDeviceService(transport);

    await expect(service.connect(transport.port)).rejects.toThrow(/transport cleanup also failed/);
    expect(transport.closeCalls).toBe(1);
    expect(service.snapshot()).toMatchObject({
      connection: 'faulted',
      generatorOutput: 'off',
      verification: 'commanded',
    });

    await expect(service.cleanupPendingInstrumentConnection()).rejects.toThrow(/forced retained-connect close failure/);
    expect(transport.closeCalls).toBe(2);
    expect(service.snapshot()).toMatchObject({ connection: 'faulted', generatorOutput: 'off' });

    await expect(service.cleanupPendingInstrumentConnection()).resolves.toBeUndefined();
    expect(transport.closeCalls).toBe(3);
    expect(service.snapshot()).toMatchObject({ connection: 'disconnected' });

    await expect(service.cleanupPendingInstrumentConnection()).resolves.toBeUndefined();
    expect(transport.closeCalls).toBe(3);
  });
});

function detectedPowerConfiguration() {
  return {
    kind: 'detected-power-timeseries' as const,
    centerHz: 100_000_000,
    sampleCount: 20,
    sweepTimeSeconds: 0.02,
    controls: {
      schemaVersion: 1 as const,
      model: 'receiver' as const,
      resolutionBandwidthKhz: 100,
      attenuationDb: 9,
      trigger: { mode: 'single' as const, levelDbm: -71 },
    },
  };
}

class PhysicalFixtureTransport implements ByteTransport {
  readonly kind = 'usb-cdc-acm' as const;
  readonly port: PortCandidate = {
    id: 'physical-zs407', path: '/dev/tty.fixture', vendorId: '0483', productId: '5740', usbMatch: 'exact-zs407-cdc', transport: 'usb-cdc-acm', execution: 'physical',
  };
  constructor(private readonly inner: FakeTinySaTransport) {}
  list(): Promise<TransportDiscoveryResult> { return Promise.resolve({ candidates: [this.port], failures: [] }); }
  open(): Promise<void> { return this.inner.open(this.inner.port); }
  close(): Promise<void> { return this.inner.close(); }
  write(bytes: Uint8Array): Promise<void> { return this.inner.write(bytes); }
  onBytes(listener: (bytes: Uint8Array) => void): () => void { return this.inner.onBytes(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { return this.inner.onEvent(listener); }
  consumeAcquisitionMetadata() { return undefined; }
}

class FailDisconnectOutputOffTransport implements ByteTransport {
  readonly kind = 'protocol-test-double' as const;
  readonly #inner = new FakeTinySaTransport();
  #outputOffCount = 0;
  get port(): PortCandidate { return this.#inner.port; }
  list(): Promise<TransportDiscoveryResult> { return this.#inner.list(); }
  open(candidate: PortCandidate): Promise<void> { return this.#inner.open(candidate); }
  close(): Promise<void> { return this.#inner.close(); }
  async write(bytes: Uint8Array): Promise<void> {
    const command = new TextDecoder().decode(bytes).trim();
    if (command === 'output off' && ++this.#outputOffCount === 5) throw new Error('forced output-off failure');
    await this.#inner.write(bytes);
  }
  onBytes(listener: (bytes: Uint8Array) => void): () => void { return this.#inner.onBytes(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { return this.#inner.onEvent(listener); }
  consumeAcquisitionMetadata() { return this.#inner.consumeAcquisitionMetadata(); }
}

class RetryPhysicalCloseTransport implements ByteTransport {
  readonly kind = 'usb-cdc-acm' as const;
  readonly port: PortCandidate = {
    id: 'physical-retry-close', path: '/dev/tty.retry-close', vendorId: '0483', productId: '5740',
    usbMatch: 'exact-zs407-cdc', transport: 'usb-cdc-acm', execution: 'physical',
  };
  readonly #inner = new FakeTinySaTransport();
  closeCalls = 0;
  list(): Promise<TransportDiscoveryResult> { return Promise.resolve({ candidates: [this.port], failures: [] }); }
  open(): Promise<void> { return this.#inner.open(this.#inner.port); }
  close(): Promise<void> {
    this.closeCalls += 1;
    return this.closeCalls === 1
      ? Promise.reject(new Error('forced transient close failure'))
      : this.#inner.close();
  }
  write(bytes: Uint8Array): Promise<void> { return this.#inner.write(bytes); }
  onBytes(listener: (bytes: Uint8Array) => void): () => void { return this.#inner.onBytes(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { return this.#inner.onEvent(listener); }
  consumeAcquisitionMetadata() { return this.#inner.consumeAcquisitionMetadata(); }
}

class RetryRejectedConnectCloseTransport implements ByteTransport {
  readonly kind = 'usb-cdc-acm' as const;
  readonly port: PortCandidate = {
    id: 'physical-rejected-connect', path: '/dev/tty.rejected-connect', vendorId: '0483', productId: '5740',
    usbMatch: 'exact-zs407-cdc', transport: 'usb-cdc-acm', execution: 'physical',
  };
  readonly #inner = new FakeTinySaTransport({
    versionResponse: 'tinySA4_v1.4-217-gc5dd31f\r\nHW Version:V0.5.4 max2871',
    infoResponse: 'tinySA ULTRA ZS405\r\nVersion: tinySA4_v1.4-217-gc5dd31f',
  });
  closeCalls = 0;
  list(): Promise<TransportDiscoveryResult> { return Promise.resolve({ candidates: [this.port], failures: [] }); }
  open(): Promise<void> { return this.#inner.open(this.#inner.port); }
  close(): Promise<void> {
    this.closeCalls += 1;
    return this.closeCalls <= 2
      ? Promise.reject(new Error('forced retained-connect close failure'))
      : this.#inner.close();
  }
  write(bytes: Uint8Array): Promise<void> { return this.#inner.write(bytes); }
  onBytes(listener: (bytes: Uint8Array) => void): () => void { return this.#inner.onBytes(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { return this.#inner.onEvent(listener); }
  consumeAcquisitionMetadata() { return this.#inner.consumeAcquisitionMetadata(); }
}
