import { describe, expect, it } from 'vitest';
import { FIRMWARE_SOURCE_COMMIT, type Sweep } from '@tinysa/contracts';
import { defaultSweepFilename, serializeSweep } from './sweep-export.js';

const sweep: Sweep = {
  kind: 'spectrum', id: 'sweep-1', sequence: 1, capturedAt: '2026-07-10T12:34:56.000Z', elapsedMilliseconds: 10,
  frequencyHz: [100, 200], powerDbm: [-90, -40],
  requested: { startHz: 100, stopHz: 200, points: 20, acquisitionFormat: 'text', rbwKhz: 'auto', attenuationDb: 'auto', sweepTimeSeconds: 'auto', detector: 'sample', spurRejection: 'auto', lna: 'off', avoidSpurs: 'auto', trigger: { mode: 'auto' } },
  actualStartHz: 100, actualStopHz: 200, actualRbwHz: 10_000, actualAttenuationDb: 0, source: 'scan-text', complete: true,
  identity: { model: 'tinySA Ultra+ ZS407', hardwareVersion: 'V0.5.4 + ZS407', firmwareVersion: 'sim', firmwareSourceCommit: FIRMWARE_SOURCE_COMMIT, port: { id: 'sim', path: 'simulator://zs407', usbMatch: 'exact-zs407-cdc', transport: 'protocol-test-double', execution: 'protocol-test-double' }, simulated: true, usbIdentityVerified: false, execution: 'protocol-test-double' },
};

describe('sweep export', () => {
  it('serializes provenance-preserving CSV', () => {
    const value = serializeSweep(sweep, 'csv');
    expect(value).toContain('frequency_hz,power_dbm,sweep_id');
    expect(value).toContain('100,-90,sweep-1');
    expect(value).toContain('tinySA Ultra+ ZS407');
  });

  it('serializes the complete contract as JSON', () => {
    expect(JSON.parse(serializeSweep(sweep, 'json'))).toMatchObject({ kind: 'spectrum', id: 'sweep-1', identity: { simulated: true } });
  });

  it('creates a filesystem-safe default filename', () => {
    expect(defaultSweepFilename(sweep, 'csv')).toBe('tinysa-atomizer-2026-07-10T12-34-56-000Z.csv');
  });
});
