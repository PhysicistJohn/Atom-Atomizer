import { describe, expect, it } from 'vitest';
import {
  ATOMIZER_INSTRUMENT_API_VERSION,
  atomizerInstrumentEventSchema,
  atomizerInstrumentPreferenceSelectionSchema,
  atomizerInstrumentStateSchema,
} from './atomizer-instrument-api.js';

describe('Atomizer instrument API v1 contract', () => {
  it('carries SignalLab session provenance without USB or firmware identity claims', () => {
    const state = atomizerInstrumentStateSchema.parse({
      schemaVersion: ATOMIZER_INSTRUMENT_API_VERSION,
      startup: { status: 'connected', connectedAt: '2026-07-14T20:00:00.000Z' },
      streaming: { status: 'stopped' },
      connectionCleanup: { status: 'not-required' },
      session: {
        sessionId: 'session:signal-lab', driverId: 'signal-lab',
        candidate: {
          schemaVersion: 1, driverId: 'signal-lab', candidateId: 'signal-lab:default',
          displayName: 'SignalLab', sourceKind: 'signal-lab', signalLab: { sourceId: 'default' },
          discoveryRevision: 'discovery:1',
        },
        provenance: {
          sourceKind: 'signal-lab', sourceId: 'default', execution: 'signal-lab-simulation',
          transport: 'signal-lab-measurement-bridge', qualification: 'synthetic-visual-projection',
          verifiedAt: '2026-07-14T20:00:00.000Z',
          producerConfigurationEpoch: 'producer-epoch:1',
          contractId: 'tinysa-signal-lab-atomizer-measurement', contractVersion: 1,
          contractSha256: 'a'.repeat(64), catalogSha256: 'b'.repeat(64), generatorSha256: 'c'.repeat(64),
          claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
        },
        capabilities: {
          schemaVersion: 1,
          acquisitions: [{
            kind: 'swept-spectrum', frequencyHz: { min: 1, max: 1_000_000 },
            points: { min: 2, max: 4_096 }, powerUnit: 'dBm',
          }],
          features: [],
        },
        rfOutput: 'not-supported',
        rfOutputQualification: 'not-applicable',
      },
    });
    const serialized = JSON.stringify(state);
    expect(serialized).not.toMatch(/vendorId|productId|firmwareVersion|usbIdentityVerified/);
  });

  it('requires truthful scalar measurement metadata at the event boundary', () => {
    expect(atomizerInstrumentEventSchema.safeParse({
      type: 'measurement',
      measurement: {
        schemaVersion: 1, kind: 'swept-spectrum', measurementId: 'measurement:1',
        sessionId: 'session:1', configurationRevision: 'configuration:1', sequence: 1,
        capturedAt: '2026-07-14T20:00:00.000Z', elapsedMilliseconds: 1,
        resolutionBandwidthHz: null, attenuationDb: null,
        qualification: 'synthetic-visual-projection', complete: true,
        frequencyHz: [100, 200], powerDbm: [-80, -70],
      },
    }).success).toBe(true);
    expect(atomizerInstrumentEventSchema.safeParse({
      type: 'measurement',
      measurement: {
        schemaVersion: 1, kind: 'swept-spectrum', measurementId: 'measurement:1',
        sessionId: 'session:1', configurationRevision: 'configuration:1', sequence: 1,
        capturedAt: '2026-07-14T20:00:00.000Z', complete: true,
        frequencyHz: [100, 200], powerDbm: [-80, -70],
      },
    }).success).toBe(false);
  });

  it('admits only static source-kind names and no executable composition data in preferences', () => {
    expect(atomizerInstrumentPreferenceSelectionSchema.parse({
      driverId: 'tinysa-zs407', candidateKind: 'serial-port',
    })).toEqual({ driverId: 'tinysa-zs407', candidateKind: 'serial-port' });
    expect(atomizerInstrumentPreferenceSelectionSchema.safeParse({
      driverId: 'signal-lab', candidateKind: 'external-command', executablePath: '/tmp/bridge',
    }).success).toBe(false);
  });
});
