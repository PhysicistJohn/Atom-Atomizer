import { describe, expect, it } from 'vitest';
import {
  FIRMWARE_SOURCE_COMMIT,
  ZS407_SHIPPED_FIRMWARE_SOURCE_COMMIT,
  type GeneratorConfig,
  type PortCandidate,
} from '@tinysa/contracts';
import { FakeTinySaTransport } from '@tinysa/test-device';
import { TinySaDeviceService } from './device.js';
import type { ByteTransport, TransportEvent } from './transport.js';

const generator: GeneratorConfig = {
  frequencyHz: 100_000_000,
  levelDbm: -30,
  path: 'mixer',
  modulation: 'off',
  modulationFrequencyHz: 1_000,
  amDepthPercent: 80,
  fmDeviationHz: 3_000,
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
    expect(service.snapshot()).toMatchObject({ connection: 'faulted', generatorOutput: 'unknown', verification: 'stale' });
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
});

class PhysicalFixtureTransport implements ByteTransport {
  readonly kind = 'usb-cdc-acm' as const;
  readonly port: PortCandidate = {
    id: 'physical-zs407', path: '/dev/tty.fixture', vendorId: '0483', productId: '5740', usbMatch: 'exact-zs407-cdc', transport: 'usb-cdc-acm', execution: 'physical',
  };
  constructor(private readonly inner: FakeTinySaTransport) {}
  list(): Promise<PortCandidate[]> { return Promise.resolve([this.port]); }
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
  list(): Promise<PortCandidate[]> { return this.#inner.list(); }
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
