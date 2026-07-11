import { describe, expect, it } from 'vitest';
import { TinySaDeviceService } from '@tinysa/device';
import { FakeTinySaTransport } from './index.js';

describe('device service against byte-level simulator', () => {
  it('identifies, configures, and acquires without enabling generator output', async () => {
    const transport = new FakeTinySaTransport({ chunkSize: 3 }); const device = new TinySaDeviceService(transport);
    const connected = await device.connect(transport.port);
    expect(connected.identity?.model).toContain('ZS407'); expect(connected.generatorOutput).toBe('off');
    await device.configureAnalyzer({ startHz: 100_000, stopHz: 1_000_000, points: 11, attenuationDb: 'auto' });
    const sweep = await device.acquireSweep(); expect(sweep.frequencyHz).toHaveLength(11); expect(sweep.powerDbm).toHaveLength(11);
    expect(transport.writes).not.toContain('output on'); await device.disconnect();
  });
  it('requires generator mode before output enable', async () => {
    const transport = new FakeTinySaTransport(); const device = new TinySaDeviceService(transport); await device.connect(transport.port);
    await expect(device.setGeneratorOutput(true)).rejects.toThrow(/Generator mode/); await device.disconnect();
  });
});
