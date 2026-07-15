import { describe, expect, it } from 'vitest';
import type { InstrumentMeasurement } from '@tinysa/contracts';
import { fingerprintInstrumentMeasurement } from './measurement-fingerprint.js';

const BASE = {
  schemaVersion: 1 as const,
  measurementId: 'measurement:iq:1',
  sessionId: 'session:neptune-fixture',
  configurationRevision: 'configuration:1',
  sequence: 1,
  capturedAt: '2026-07-14T20:00:00.000Z',
  elapsedMilliseconds: 1,
  resolutionBandwidthHz: null,
  attenuationDb: null,
  qualification: 'device-observed' as const,
  complete: true as const,
};

describe('instrument measurement fingerprint', () => {
  it('matches an independently cloned complete I/Q result', () => {
    const measurement = iq(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    const cloned = { ...measurement, samples: measurement.samples.slice() };

    expect(fingerprintInstrumentMeasurement(cloned)).toBe(fingerprintInstrumentMeasurement(measurement));
  });

  it('binds I/Q bytes and all measurement metadata', () => {
    const measurement = iq(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
    const changedBytes = { ...measurement, samples: measurement.samples.slice() };
    changedBytes.samples[7] = 8;

    expect(fingerprintInstrumentMeasurement(changedBytes)).not.toBe(fingerprintInstrumentMeasurement(measurement));
    expect(fingerprintInstrumentMeasurement({ ...measurement, measurementId: 'measurement:iq:2' }))
      .not.toBe(fingerprintInstrumentMeasurement(measurement));
  });

  it('binds every scalar spectrum value without retaining the source arrays', () => {
    const measurement: InstrumentMeasurement = {
      ...BASE,
      measurementId: 'measurement:spectrum:1',
      kind: 'swept-spectrum',
      resolutionBandwidthHz: 10_000,
      attenuationDb: 0,
      frequencyHz: [100, 200, 300],
      powerDbm: [-90, -70, -90],
    };
    const changed: InstrumentMeasurement = {
      ...measurement,
      powerDbm: [-90, -69.999, -90],
    };

    expect(fingerprintInstrumentMeasurement(structuredClone(measurement)))
      .toBe(fingerprintInstrumentMeasurement(measurement));
    expect(fingerprintInstrumentMeasurement(changed)).not.toBe(fingerprintInstrumentMeasurement(measurement));
  });
});

function iq(samples: Uint8Array<ArrayBuffer>): Extract<InstrumentMeasurement, { kind: 'complex-iq' }> {
  return {
    ...BASE,
    kind: 'complex-iq',
    centerHz: 2_450_000_000,
    sampleRateHz: 1_000_000,
    bandwidthHz: 800_000,
    sampleFormat: 'cf32le',
    sampleCount: 1,
    samples,
  };
}
