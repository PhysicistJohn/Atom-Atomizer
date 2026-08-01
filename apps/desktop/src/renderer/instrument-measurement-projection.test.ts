import { describe, expect, it } from 'vitest';
import { sweepExportSweepSchema, type DetectedPowerTimeseriesConfiguration, type InstrumentMeasurement, type InstrumentSessionSnapshot, type SweptSpectrumConfiguration } from '@tinysa/contracts';
import { projectDerivedSpectrumFromComplexIq, projectDetectedPowerMeasurement, projectSpectrumMeasurement } from './instrument-measurement-projection.js';
import type { ComplexIqMeasurement } from './complex-iq.js';

const HASH = 'a'.repeat(64);
const analyzer: SweptSpectrumConfiguration = { kind: 'swept-spectrum', startHz: 100, stopHz: 300, points: 3, sweepTimeSeconds: 0.05, controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' } };
const zero: DetectedPowerTimeseriesConfiguration = { kind: 'detected-power-timeseries', centerHz: 200, sampleCount: 4, sweepTimeSeconds: 0.05, controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' } };
const signalLabSession: InstrumentSessionSnapshot = {
  sessionId: 'session-signal-lab', driverId: 'signal-lab',
  candidate: { schemaVersion: 1, driverId: 'signal-lab', candidateId: 'signal-lab:local', displayName: 'SignalLab', sourceKind: 'signal-lab', signalLab: { sourceId: 'local' }, discoveryRevision: 'd1' },
  provenance: { sourceKind: 'signal-lab', sourceId: 'local', execution: 'signal-lab-simulation', transport: 'signal-lab-measurement-bridge', qualification: 'synthetic-visual-projection', verifiedAt: '2026-07-10T00:00:00.000Z', producerConfigurationEpoch: 'producer-epoch:1', contractId: 'tinysa-signal-lab-atomizer-measurement', contractVersion: 3, contractSha256: HASH, catalogSha256: HASH, generatorContractBindingSha256: HASH, claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false } },
  capabilities: {
    schemaVersion: 1,
    acquisitions: [
      {
        kind: 'swept-spectrum', frequencyHz: { min: 0, max: 1_000 }, points: { min: 2, max: 100 },
        sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
        controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' }, powerUnit: 'dBm',
      },
      {
        kind: 'detected-power-timeseries', centerFrequencyHz: { min: 0, max: 1_000 }, sampleCount: { min: 1, max: 100 },
        sweepTimeSeconds: { automatic: false, manualSeconds: { min: 0.05, max: 0.05 } },
        controls: { schemaVersion: 1, model: 'synthetic-scalar', timingQualification: 'simulation-exact' }, powerUnit: 'dBm', timing: 'uniform',
      },
    ],
    features: [],
  },
  rfOutput: 'not-supported',
  rfOutputQualification: 'not-applicable',
};

function spectrum(overrides: Partial<Extract<InstrumentMeasurement, { kind: 'swept-spectrum' }>> = {}): Extract<InstrumentMeasurement, { kind: 'swept-spectrum' }> {
  return { schemaVersion: 1, kind: 'swept-spectrum', measurementId: 'm1', sessionId: signalLabSession.sessionId, configurationRevision: 'c1', producerConfigurationEpoch: 'producer-epoch:1', sequence: 1, capturedAt: '2026-07-10T00:00:01.000Z', elapsedMilliseconds: 2, resolutionBandwidthHz: null, attenuationDb: null, qualification: 'synthetic-visual-projection', complete: true, frequencyHz: [100, 200, 300], powerDbm: [-90, -50, -90], ...overrides };
}

describe('generic measurement projection', () => {
  it('retains SignalLab session provenance without fabricating device, USB, firmware, or RF identity', () => {
    const projected = projectSpectrumMeasurement(spectrum({ resolutionBandwidthHz: 25, attenuationDb: 7 }), signalLabSession, analyzer);
    expect(projected.source).toBe('signal-lab-synthetic');
    expect(projected.actualRbwHz).toBe(100);
    expect(projected.resolutionBandwidthQualification).toBe('synthetic-grid-equivalent');
    expect(projected.actualAttenuationDb).toBeNull();
    expect(projected.attenuationQualification).toBe('not-applicable');
    expect(projected.identity).toMatchObject({ kind: 'instrument-session', driverId: 'signal-lab', candidateId: 'signal-lab:local', sessionId: 'session-signal-lab', provenance: { claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false } } });
    expect(projected.identity).not.toHaveProperty('model');
    expect(projected.identity).not.toHaveProperty('firmwareVersion');
  });

  it('uses the producer timing qualification without misreporting temporal spacing as RF RBW', () => {
    const measurement: Extract<InstrumentMeasurement, { kind: 'detected-power-timeseries' }> = { schemaVersion: 1, kind: 'detected-power-timeseries', measurementId: 'z1', sessionId: signalLabSession.sessionId, configurationRevision: 'z-config', producerConfigurationEpoch: 'producer-epoch:1', sequence: 2, capturedAt: '2026-07-10T00:00:02.000Z', elapsedMilliseconds: 40, resolutionBandwidthHz: null, attenuationDb: null, qualification: 'synthetic-visual-projection', complete: true, centerHz: 200, sampleIntervalSeconds: 0.0125, timingQualification: 'simulation-exact', powerDbm: [-90, -80, -90, -80] };
    const projected = projectDetectedPowerMeasurement(measurement, signalLabSession, zero, 'detection-1');
    expect(projected.actualRbwHz).toBeNull();
    expect(projected.resolutionBandwidthQualification).toBe('unavailable');
    expect(projected.actualAttenuationDb).toBeNull();
    expect(projected.attenuationQualification).toBe('not-applicable');
    expect(projected.timingQualification).toBe('simulation-exact');
    expect(projected.targetDetectionId).toBe('detection-1');
  });

  it('rejects a measurement whose producer epoch differs from the authoritative session snapshot', () => {
    expect(() => projectSpectrumMeasurement(
      spectrum({ producerConfigurationEpoch: 'producer-epoch:stale' }),
      signalLabSession,
      analyzer,
    )).toThrow(/producer epoch does not match/);
  });

  it('fails closed when physical/twin measurement metadata is absent or the session differs', () => {
    const twin: InstrumentSessionSnapshot = {
      ...signalLabSession,
      sessionId: 'twin-session', driverId: 'tinysa',
      candidate: { schemaVersion: 1, driverId: 'tinysa', candidateId: 'twin', displayName: 'Twin', sourceKind: 'tinysa-firmware-twin', firmwareTwin: { bridge: 'renode-monitor-v1', repositoryCommit: 'b'.repeat(40), firmwareBinarySha256: HASH, usbTransactionsModeled: false }, discoveryRevision: 'd2' },
      provenance: { sourceKind: 'tinysa-firmware-twin', execution: 'firmware-executed-twin', transport: 'renode-monitor-bridge', qualification: 'firmware-executed-twin', verifiedAt: '2026-07-10T00:00:00.000Z', bridge: 'renode-monitor-v1', repositoryCommit: 'b'.repeat(40), firmwareBinarySha256: HASH, usbTransactionsModeled: false, device: { model: 'tinySA', hardwareVersion: 'test', firmwareVersion: 'test' } },
      capabilities: receiverScalarCapabilities(),
      rfOutput: 'off',
      rfOutputQualification: 'firmware-executed-twin',
    };
    const twinMeasurement = {
      sessionId: twin.sessionId,
      producerConfigurationEpoch: undefined,
      qualification: 'firmware-executed-twin' as const,
    };
    expect(() => projectSpectrumMeasurement(spectrum(twinMeasurement), twin, analyzer)).toThrow(/omitted.*resolution bandwidth/i);
    expect(projectSpectrumMeasurement(spectrum({ ...twinMeasurement, resolutionBandwidthHz: 25, attenuationDb: 7 }), twin, analyzer))
      .toMatchObject({
        source: 'renode-executable-state',
        actualRbwHz: 25,
        actualAttenuationDb: 7,
        resolutionBandwidthQualification: 'firmware-executed-twin',
        attenuationQualification: 'firmware-executed-twin',
      });
    expect(() => projectSpectrumMeasurement(spectrum({
      ...twinMeasurement,
      producerConfigurationEpoch: 'unexpected-producer-epoch',
      resolutionBandwidthHz: 25,
      attenuationDb: 7,
    }), twin, analyzer)).toThrow(/cannot claim a producer epoch/i);
    expect(() => projectSpectrumMeasurement(spectrum({ sessionId: 'other' }), signalLabSession, analyzer)).toThrow(/does not match active session/i);
  });

  it('requires generic execution and advertised scalar controls to agree before projection', () => {
    const inconsistentSession: InstrumentSessionSnapshot = {
      ...signalLabSession,
      capabilities: receiverScalarCapabilities(),
    };
    expect(() => projectSpectrumMeasurement(spectrum(), inconsistentSession, analyzer))
      .toThrow(/controls model receiver does not match simulation scalar execution/i);
  });
});

function receiverScalarCapabilities(): InstrumentSessionSnapshot['capabilities'] {
  return {
    schemaVersion: 1,
    acquisitions: [{
      kind: 'swept-spectrum',
      frequencyHz: { min: 0, max: 1_000 },
      points: { min: 2, max: 100 },
      sweepTimeSeconds: { automatic: true, manualSeconds: { min: 0.05, max: 1 } },
      controls: {
        schemaVersion: 1,
        model: 'receiver',
        acquisitionFormats: ['text'],
        resolutionBandwidthKhz: { automatic: true, manual: { min: 0.2, max: 850 } },
        attenuationDb: { automatic: true, manual: { min: 0, max: 31 } },
        detectors: ['sample'],
        spurRejection: ['auto'],
        lowNoiseAmplifier: ['off'],
        avoidSpurs: ['auto'],
        triggerModes: ['auto'],
      },
      powerUnit: 'dBm',
    }],
    features: [],
  };
}

describe('projectDerivedSpectrumFromComplexIq', () => {
  const neptuneSession: InstrumentSessionSnapshot = {
    sessionId: 'session-neptune', driverId: 'neptune-p210',
    candidate: {
      schemaVersion: 1, driverId: 'neptune-p210', candidateId: 'neptune-p210:ip:10.0.0.250', displayName: 'NeptuneSDR P210',
      sourceKind: 'neptune-p210', neptuneP210: { endpoint: 'ip:10.0.0.250' }, discoveryRevision: 'd1',
    },
    provenance: {
      sourceKind: 'neptune-p210', execution: 'physical', transport: 'libiio-network', qualification: 'device-observed',
      verifiedAt: '2026-07-10T00:00:00.000Z', endpoint: 'ip:10.0.0.250',
    },
    capabilities: {
      schemaVersion: 1,
      acquisitions: [{
        kind: 'complex-iq',
        centerFrequencyHz: { min: 70_000_000, max: 6_000_000_000 },
        sampleRateHz: { min: 520_833, max: 61_440_000 },
        bandwidthHz: { min: 200_000, max: 56_000_000 },
        sampleCount: { min: 1_024, max: 65_536 },
        sampleFormat: 'ci16le',
      }],
      features: [],
    },
    rfOutput: 'not-supported',
    rfOutputQualification: 'not-applicable',
  };

  function encodeCi16leTone(sampleCount: number, offsetHz: number, sampleRateHz: number, amplitude = 0.5) {
    const bytes = new Uint8Array(sampleCount * 4);
    const view = new DataView(bytes.buffer);
    for (let n = 0; n < sampleCount; n++) {
      const phase = 2 * Math.PI * offsetHz * n / sampleRateHz;
      view.setInt16(n * 4, Math.round(amplitude * Math.cos(phase) * 2_048), true);
      view.setInt16(n * 4 + 2, Math.round(amplitude * Math.sin(phase) * 2_048), true);
    }
    return bytes;
  }

  function neptuneIqMeasurement(overrides: Partial<ComplexIqMeasurement> = {}): ComplexIqMeasurement {
    const sampleCount = 2_048;
    const sampleRateHz = 1_000_000;
    return {
      schemaVersion: 1, kind: 'complex-iq', measurementId: 'iq-1', sessionId: neptuneSession.sessionId,
      configurationRevision: 'c1', sequence: 1, capturedAt: '2026-07-10T00:00:01.000Z', elapsedMilliseconds: 4,
      resolutionBandwidthHz: null, attenuationDb: null, qualification: 'device-observed',
      complete: true, centerHz: 100_000_000, sampleRateHz, bandwidthHz: sampleRateHz,
      sampleFormat: 'ci16le', sampleCount, samples: encodeCi16leTone(sampleCount, 100_000, sampleRateHz),
      adcSignificantBits: 12, adcFullScaleCode: 2_048, powerReference: 'uncalibrated-dbfs-relative',
      ...overrides,
    };
  }

  it('derives an honestly-labeled Sweep that places the tone at its true frequency', () => {
    const projected = projectDerivedSpectrumFromComplexIq(neptuneIqMeasurement(), neptuneSession);
    expect(projected.source).toBe('host-derived-from-complex-iq');
    expect(projected.powerReference).toBe('uncalibrated-dbfs-relative');
    expect(projected.resolutionBandwidthQualification).toBe('host-derived-fft-bin');
    expect(projected.actualAttenuationDb).toBeNull();
    expect(projected.attenuationQualification).toBe('not-applicable');
    expect(projected.requested.controls).toMatchObject({ model: 'host-derived-iq-projection', fftSize: 2_048, window: 'hann-periodic' });
    expect(projected.frequencyHz).toHaveLength(2_048);
    expect(projected.powerDbm).toHaveLength(2_048);
    expect(projected.identity).toMatchObject({ kind: 'instrument-session', driverId: 'neptune-p210', sessionId: 'session-neptune' });
    expect(() => sweepExportSweepSchema.parse(projected)).not.toThrow();

    let peakIndex = 0;
    for (let index = 1; index < projected.powerDbm.length; index++) {
      if (projected.powerDbm[index]! > projected.powerDbm[peakIndex]!) peakIndex = index;
    }
    const binWidthHz = 1_000_000 / 2_048;
    expect(Math.abs(projected.frequencyHz[peakIndex]! - 100_100_000)).toBeLessThanOrEqual(binWidthHz);
  });

  it('surfaces a real device-observed attenuation when the driver reports one', () => {
    const projected = projectDerivedSpectrumFromComplexIq(neptuneIqMeasurement({ attenuationDb: 6 }), neptuneSession);
    expect(projected.actualAttenuationDb).toBe(6);
    expect(projected.attenuationQualification).toBe('device-observed');
  });

  it('rejects a measurement whose session does not match the active session', () => {
    expect(() => projectDerivedSpectrumFromComplexIq(neptuneIqMeasurement({ sessionId: 'other' }), neptuneSession))
      .toThrow(/does not match active session/i);
  });
});
