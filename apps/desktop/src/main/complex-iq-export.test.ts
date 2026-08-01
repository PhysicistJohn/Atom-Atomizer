import { describe, expect, it } from 'vitest';
import {
  INSTRUMENT_CONTRACT_VERSION,
  MAX_COMPLEX_IQ_BYTES_V1,
  MAX_COMPLEX_IQ_SAMPLES_V1,
  complexIqPayloadByteLength,
  type InstrumentMeasurementIdentity,
} from '@tinysa/contracts';
import {
  complexIqExportCaptureSchema,
  defaultComplexIqBasename,
  defaultComplexIqMetaFilename,
  deriveComplexIqDataPath,
  serializeComplexIqSigmf,
  type ComplexIqExportCapture,
  type ComplexIqMeasurement,
} from './complex-iq-export.js';

function samplesFor(sampleCount: number, sampleFormat: ComplexIqMeasurement['sampleFormat']): ComplexIqMeasurement['samples'] {
  const byteLength = complexIqPayloadByteLength(sampleCount, sampleFormat);
  // Deterministic but non-trivial pattern, including 0x00 and 0xff bytes, so
  // any accidental text transcoding (e.g. base64/UTF-8 round-tripping) would
  // be caught by an exact byte comparison.
  const bytes = new Uint8Array(new ArrayBuffer(byteLength));
  for (let index = 0; index < byteLength; index++) bytes[index] = (index * 37 + 11) % 256;
  return bytes;
}

function signalLabMeasurement(): ComplexIqMeasurement {
  const sampleFormat = 'cf32le' as const;
  const sampleCount = 8;
  return {
    schemaVersion: INSTRUMENT_CONTRACT_VERSION,
    measurementId: 'measurement:signal-lab:1',
    sessionId: 'session:signal-lab',
    configurationRevision: 'configuration:signal-lab:1',
    sequence: 1,
    capturedAt: '2026-07-10T12:34:56.000Z',
    elapsedMilliseconds: 50,
    resolutionBandwidthHz: null,
    attenuationDb: null,
    complete: true,
    kind: 'complex-iq',
    qualification: 'synthetic-visual-projection',
    centerHz: 100_000_000,
    sampleRateHz: 2_000_000,
    bandwidthHz: 1_500_000,
    sampleFormat,
    sampleCount,
    samples: samplesFor(sampleCount, sampleFormat),
  };
}

function signalLabIdentity(): InstrumentMeasurementIdentity {
  return {
    kind: 'instrument-session',
    sessionId: 'session:signal-lab',
    driverId: 'signal-lab',
    candidateId: 'signal-lab:default',
    provenance: {
      sourceKind: 'signal-lab',
      sourceId: 'default',
      execution: 'signal-lab-simulation',
      transport: 'signal-lab-measurement-bridge',
      qualification: 'synthetic-visual-projection',
      verifiedAt: '2026-07-10T12:34:56.000Z',
      producerConfigurationEpoch: 'producer-epoch:1',
      contractId: 'tinysa-signal-lab-atomizer-measurement',
      contractVersion: 3,
      contractSha256: 'a'.repeat(64),
      catalogSha256: 'b'.repeat(64),
      generatorContractBindingSha256: 'c'.repeat(64),
      claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false },
    },
  };
}

function neptuneP210Measurement(): ComplexIqMeasurement {
  const sampleFormat = 'ci16le' as const;
  const sampleCount = 16;
  return {
    schemaVersion: INSTRUMENT_CONTRACT_VERSION,
    measurementId: 'measurement:neptune:1',
    sessionId: 'session:neptune',
    configurationRevision: 'configuration:neptune:1',
    sequence: 3,
    capturedAt: '2026-07-11T08:00:00.000Z',
    elapsedMilliseconds: 12,
    resolutionBandwidthHz: null,
    attenuationDb: null,
    complete: true,
    kind: 'complex-iq',
    qualification: 'device-observed',
    centerHz: 915_000_000,
    sampleRateHz: 20_000_000,
    bandwidthHz: 18_000_000,
    sampleFormat,
    sampleCount,
    samples: samplesFor(sampleCount, sampleFormat),
    adcSignificantBits: 12,
    adcFullScaleCode: 2048,
    powerReference: 'uncalibrated-dbfs-relative',
  };
}

function neptuneP210Identity(): InstrumentMeasurementIdentity {
  return {
    kind: 'instrument-session',
    sessionId: 'session:neptune',
    driverId: 'neptune-p210',
    candidateId: 'neptune-p210:ip:10.0.0.250',
    provenance: {
      sourceKind: 'neptune-p210',
      execution: 'physical',
      transport: 'libiio-network',
      qualification: 'device-observed',
      verifiedAt: '2026-07-11T08:00:00.000Z',
      endpoint: 'ip:10.0.0.250',
      contextDescription: 'HAMGEEK P210 dev unit',
    },
  };
}

function neptuneP210TwinIdentity(): InstrumentMeasurementIdentity {
  return {
    kind: 'instrument-session',
    sessionId: 'session:neptune',
    driverId: 'neptune-p210',
    candidateId: 'neptune-p210-twin:qemu',
    provenance: {
      sourceKind: 'neptune-p210-twin',
      execution: 'firmware-executed-twin',
      transport: 'libiio-network',
      qualification: 'firmware-executed-twin',
      verifiedAt: '2026-07-11T08:00:00.000Z',
      endpoint: 'ip:127.0.0.1:30431',
      profile: 'qemu-development',
      physicalRfModeled: false,
    },
  };
}

describe('complex-I/Q SigMF export', () => {
  it('pairs a self-describing .sigmf-meta sidecar with a matching .sigmf-data basename', () => {
    const capture: ComplexIqExportCapture = { measurement: signalLabMeasurement(), identity: signalLabIdentity() };
    const exported = serializeComplexIqSigmf(capture);

    expect(exported.metaFilename).toBe('atomizer-iq-2026-07-10T12-34-56-000Z.sigmf-meta');
    expect(exported.dataFilename).toBe('atomizer-iq-2026-07-10T12-34-56-000Z.sigmf-data');
    expect(exported.metaFilename.replace('.sigmf-meta', '')).toBe(exported.dataFilename.replace('.sigmf-data', ''));

    const meta = JSON.parse(exported.meta);
    expect(meta).toHaveProperty('global');
    expect(meta).toHaveProperty('captures');
    expect(meta).toHaveProperty('annotations');
    expect(meta.global['core:datatype']).toBe('cf32_le');
    expect(meta.global['core:sample_rate']).toBe(2_000_000);
    expect(meta.global['core:version']).toEqual(expect.any(String));
    expect(meta.captures).toEqual([{ 'core:sample_start': 0, 'core:frequency': 100_000_000, 'core:datetime': '2026-07-10T12:34:56.000Z' }]);
    expect(meta.annotations[0]['core:sample_count']).toBe(8);
  });

  it('preserves the raw sample bytes exactly, never transcoding them', () => {
    const measurement = neptuneP210Measurement();
    const capture: ComplexIqExportCapture = { measurement, identity: neptuneP210Identity() };
    const exported = serializeComplexIqSigmf(capture);

    expect(exported.data).toHaveLength(measurement.samples.byteLength);
    expect(Buffer.from(exported.data)).toEqual(Buffer.from(measurement.samples));
    // The exported buffer must be an independent copy, not an aliasing view:
    // mutating the source after export must never retroactively change it.
    measurement.samples[0] = (measurement.samples[0]! + 1) % 256;
    expect(exported.data[0]).not.toBe(measurement.samples[0]);
  });

  it('maps every contract sample format to its SigMF core datatype string', () => {
    const cases: readonly [ComplexIqMeasurement['sampleFormat'], string][] = [
      ['cf32le', 'cf32_le'],
      ['ci16le', 'ci16_le'],
      ['ci8', 'ci8'],
      ['cu8', 'cu8'],
    ];
    for (const [sampleFormat, datatype] of cases) {
      const measurement = { ...neptuneP210Measurement(), sampleFormat, samples: samplesFor(16, sampleFormat) };
      const meta = JSON.parse(serializeComplexIqSigmf({ measurement, identity: neptuneP210Identity() }).meta);
      expect(meta.global['core:datatype'], sampleFormat).toBe(datatype);
    }
  });

  it('rejects a capture whose samples exceed the contract byte ceiling', () => {
    const oversized = new Uint8Array(MAX_COMPLEX_IQ_BYTES_V1 + 8);
    const measurement = { ...signalLabMeasurement(), sampleCount: 1, sampleFormat: 'ci8' as const, samples: oversized };
    expect(() => serializeComplexIqSigmf({ measurement, identity: signalLabIdentity() }))
      .toThrow(new RegExp(`limited to ${MAX_COMPLEX_IQ_BYTES_V1} bytes`));
  });

  it('rejects a capture whose declared sample count exceeds MAX_COMPLEX_IQ_SAMPLES_V1', () => {
    const sampleFormat = 'cf32le' as const;
    const sampleCount = MAX_COMPLEX_IQ_SAMPLES_V1 + 1;
    const measurement = {
      ...signalLabMeasurement(),
      sampleFormat,
      sampleCount,
      // The byte buffer need not even be well-formed here: the sampleCount
      // field's own ceiling (derived from MAX_COMPLEX_IQ_BYTES_V1) rejects
      // this before any byte-length cross-check runs.
      samples: new Uint8Array(8),
    };
    expect(() => complexIqExportCaptureSchema.parse({ measurement, identity: signalLabIdentity() })).toThrow();
  });

  it('rejects a mismatched byte-length payload before writing anything', () => {
    const measurement = { ...neptuneP210Measurement(), samples: samplesFor(16, 'ci16le').slice(0, -1) };
    expect(() => serializeComplexIqSigmf({ measurement, identity: neptuneP210Identity() })).toThrow(/exactly \d+ bytes/);
  });

  it('rejects undeclared fields, cross-source field smuggling, and identity/session mismatches', () => {
    const measurement = signalLabMeasurement();
    const identity = signalLabIdentity();
    expect(complexIqExportCaptureSchema.safeParse({ measurement: { ...measurement, forged: true }, identity }).success).toBe(false);
    expect(complexIqExportCaptureSchema.safeParse({ measurement, identity: { ...identity, forged: true } }).success).toBe(false);
    expect(complexIqExportCaptureSchema.safeParse({
      measurement, identity: { ...identity, sessionId: 'session:other' },
    }).success).toBe(false);
    // A serial-port `device` object smuggled onto a Neptune provenance must
    // still be rejected by the underlying, already-strict contract schema.
    expect(complexIqExportCaptureSchema.safeParse({
      measurement: neptuneP210Measurement(),
      identity: {
        ...neptuneP210Identity(),
        provenance: { ...neptuneP210Identity().provenance, device: { model: 'not allowed' } },
      },
    }).success).toBe(false);
  });

  it('preserves complete, self-describing provenance for both SignalLab and Neptune P210 sources', () => {
    const signalLab = JSON.parse(serializeComplexIqSigmf({
      measurement: signalLabMeasurement(), identity: signalLabIdentity(),
    }).meta);
    expect(signalLab.global['atomizer:driver_id']).toBe('signal-lab');
    expect(signalLab.global['atomizer:source_kind']).toBe('signal-lab');
    expect(signalLab.global).not.toHaveProperty('atomizer:power_reference');
    expect(JSON.parse(signalLab.global['atomizer:identity_json'])).toEqual(signalLabIdentity());
    const signalLabConfiguration = JSON.parse(signalLab.global['atomizer:requested_configuration_json']);
    expect(signalLabConfiguration).toEqual({
      centerHz: 100_000_000, sampleRateHz: 2_000_000, bandwidthHz: 1_500_000, sampleFormat: 'cf32le', sampleCount: 8,
    });

    const neptune = JSON.parse(serializeComplexIqSigmf({
      measurement: neptuneP210Measurement(), identity: neptuneP210Identity(),
    }).meta);
    expect(neptune.global['atomizer:driver_id']).toBe('neptune-p210');
    expect(neptune.global['atomizer:source_kind']).toBe('neptune-p210');
    expect(neptune.global['atomizer:power_reference']).toBe('uncalibrated-dbfs-relative');
    expect(neptune.global['core:hw']).toContain('ip:10.0.0.250');
    const neptuneMeasurementJson = JSON.parse(neptune.global['atomizer:measurement_json']);
    expect(neptuneMeasurementJson.adcSignificantBits).toBe(12);
    expect(neptuneMeasurementJson.adcFullScaleCode).toBe(2048);
    expect(neptuneMeasurementJson).not.toHaveProperty('samples');
    const neptuneIdentityJson = JSON.parse(neptune.global['atomizer:identity_json']);
    expect(neptuneIdentityJson.provenance.endpoint).toBe('ip:10.0.0.250');
    expect(neptuneIdentityJson.provenance.contextDescription).toBe('HAMGEEK P210 dev unit');

    const twin = JSON.parse(serializeComplexIqSigmf({
      measurement: neptuneP210Measurement(), identity: neptuneP210TwinIdentity(),
    }).meta);
    expect(twin.global['atomizer:source_kind']).toBe('neptune-p210-twin');
    expect(twin.global['core:hw']).toContain('qemu-development');
  });

  it('derives a filesystem-safe default basename and sibling data path', () => {
    const capture: ComplexIqExportCapture = { measurement: signalLabMeasurement(), identity: signalLabIdentity() };
    expect(defaultComplexIqBasename(capture.measurement.capturedAt)).toBe('atomizer-iq-2026-07-10T12-34-56-000Z');
    expect(defaultComplexIqMetaFilename(capture)).toBe('atomizer-iq-2026-07-10T12-34-56-000Z.sigmf-meta');
    expect(deriveComplexIqDataPath('/exports/capture.sigmf-meta')).toBe('/exports/capture.sigmf-data');
    expect(deriveComplexIqDataPath('/exports/CAPTURE.SIGMF-META')).toBe('/exports/CAPTURE.sigmf-data');
    expect(deriveComplexIqDataPath('/exports/capture-without-suffix')).toBe('/exports/capture-without-suffix.sigmf-data');
  });
});
