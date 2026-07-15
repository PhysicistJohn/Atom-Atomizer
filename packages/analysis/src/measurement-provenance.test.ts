import { describe, expect, it } from 'vitest';
import type { InstrumentMeasurementIdentity } from '@tinysa/contracts';
import { measurementIdentityKey, sameMeasurementIdentity } from './measurement-provenance.js';

const provenance = { sourceKind: 'signal-lab' as const, sourceId: 'local', execution: 'signal-lab-simulation' as const, transport: 'signal-lab-measurement-bridge' as const, qualification: 'synthetic-visual-projection' as const, verifiedAt: '2026-07-10T00:00:00.000Z', producerConfigurationEpoch: 'producer-epoch:1', contractId: 'tinysa-signal-lab-atomizer-measurement' as const, contractVersion: 1 as const, contractSha256: 'a'.repeat(64), catalogSha256: 'b'.repeat(64), generatorSha256: 'c'.repeat(64), claims: { usbEmulated: false as const, firmwareExecuted: false as const, rfEmitted: false as const } };
const identity: InstrumentMeasurementIdentity = { kind: 'instrument-session', driverId: 'signal-lab', candidateId: 'local', sessionId: 'session-1', provenance };

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
});
