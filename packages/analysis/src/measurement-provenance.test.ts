import { describe, expect, it } from 'vitest';
import {
  deviceIdentitySchema,
  instrumentOpaqueIdSchema,
  type DeviceIdentity,
  type InstrumentMeasurementIdentity,
} from '@tinysa/contracts';
import { measurementIdentityKey, sameMeasurementIdentity } from './measurement-provenance.js';

const provenance = { sourceKind: 'signal-lab' as const, sourceId: 'local', execution: 'signal-lab-simulation' as const, transport: 'signal-lab-measurement-bridge' as const, qualification: 'synthetic-visual-projection' as const, verifiedAt: '2026-07-10T00:00:00.000Z', producerConfigurationEpoch: 'producer-epoch:1', contractId: 'tinysa-signal-lab-atomizer-measurement' as const, contractVersion: 1 as const, contractSha256: 'a'.repeat(64), catalogSha256: 'b'.repeat(64), generatorSha256: 'c'.repeat(64), claims: { usbEmulated: false as const, firmwareExecuted: false as const, rfEmitted: false as const } };
const identity: InstrumentMeasurementIdentity = { kind: 'instrument-session', driverId: 'signal-lab', candidateId: 'local', sessionId: 'session-1', provenance };
const legacyIdentity: DeviceIdentity = {
  model: 'fixture',
  hardwareVersion: 'fixture',
  firmwareVersion: 'fixture-firmware',
  firmwareQualification: 'protocol-test',
  port: {
    id: 'fixture-port',
    path: 'fixture://port',
    usbMatch: 'protocol-test-double',
    transport: 'protocol-test-double',
    execution: 'protocol-test-double',
  },
  simulated: true,
  usbIdentityVerified: false,
  execution: 'protocol-test-double',
};

describe('measurement source identity', () => {
  it('binds generic evidence to driver, source, candidate, and admitted session', () => {
    expect(sameMeasurementIdentity(identity, { ...identity })).toBe(true);
    expect(sameMeasurementIdentity(identity, { ...identity, sessionId: 'session-2' })).toBe(false);
    expect(sameMeasurementIdentity(identity, { ...identity, candidateId: 'other' })).toBe(false);
    expect(sameMeasurementIdentity(identity, {
      ...identity,
      provenance: { ...provenance, producerConfigurationEpoch: 'producer-epoch:2' },
    })).toBe(false);
    expect(measurementIdentityKey(identity)).toContain('signal-lab');
    expect(measurementIdentityKey(identity)).toContain('producer-epoch:1');
    expect(measurementIdentityKey(identity)).not.toContain('cw');
  });

  it('cannot alias generic candidate and session boundaries with embedded NUL characters', () => {
    const left: InstrumentMeasurementIdentity = {
      ...identity,
      candidateId: instrumentOpaqueIdSchema.parse('candidate\u0000session'),
      sessionId: instrumentOpaqueIdSchema.parse('tail'),
    };
    const right: InstrumentMeasurementIdentity = {
      ...identity,
      candidateId: instrumentOpaqueIdSchema.parse('candidate'),
      sessionId: instrumentOpaqueIdSchema.parse('session\u0000tail'),
    };

    expect(measurementIdentityKey(left)).not.toBe(measurementIdentityKey(right));
    expect(sameMeasurementIdentity(left, right)).toBe(false);
  });

  it('cannot alias legacy port and firmware boundaries with embedded NUL characters', () => {
    const left = deviceIdentitySchema.parse({
      ...legacyIdentity,
      firmwareVersion: 'tail',
      port: { ...legacyIdentity.port, id: 'device\u0000firmware' },
    });
    const right = deviceIdentitySchema.parse({
      ...legacyIdentity,
      firmwareVersion: 'firmware\u0000tail',
      port: { ...legacyIdentity.port, id: 'device' },
    });

    expect(measurementIdentityKey(left)).not.toBe(measurementIdentityKey(right));
    expect(sameMeasurementIdentity(left, right)).toBe(false);
  });
});
