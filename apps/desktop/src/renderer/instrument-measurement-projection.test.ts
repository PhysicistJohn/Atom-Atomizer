import { describe, expect, it } from 'vitest';
import type { AnalyzerConfig, InstrumentMeasurement, InstrumentSessionSnapshot, ZeroSpanConfig } from '@tinysa/contracts';
import { projectDetectedPowerMeasurement, projectSpectrumMeasurement } from './instrument-measurement-projection.js';

const HASH = 'a'.repeat(64);
const analyzer: AnalyzerConfig = { startHz: 100, stopHz: 300, points: 3, acquisitionFormat: 'raw', rbwKhz: 'auto', attenuationDb: 'auto', sweepTimeSeconds: 'auto', detector: 'sample', spurRejection: 'auto', lna: 'off', avoidSpurs: 'auto', trigger: { mode: 'auto' } };
const zero: ZeroSpanConfig = { frequencyHz: 200, points: 4, rbwKhz: 100, attenuationDb: 'auto', sweepTimeSeconds: 0.04, trigger: { mode: 'auto' } };
const signalLabSession: InstrumentSessionSnapshot = {
  sessionId: 'session-signal-lab', driverId: 'signal-lab',
  candidate: { schemaVersion: 1, driverId: 'signal-lab', candidateId: 'signal-lab:local', displayName: 'SignalLab', sourceKind: 'signal-lab', signalLab: { sourceId: 'local' }, discoveryRevision: 'd1' },
  provenance: { sourceKind: 'signal-lab', sourceId: 'local', execution: 'signal-lab-simulation', transport: 'signal-lab-measurement-bridge', qualification: 'synthetic-visual-projection', verifiedAt: '2026-07-10T00:00:00.000Z', producerConfigurationEpoch: 'producer-epoch:1', contractId: 'tinysa-signal-lab-atomizer-measurement', contractVersion: 1, contractSha256: HASH, catalogSha256: HASH, generatorSha256: HASH, claims: { usbEmulated: false, firmwareExecuted: false, rfEmitted: false } },
  capabilities: { schemaVersion: 1, acquisitions: [{ kind: 'swept-spectrum', frequencyHz: { min: 0, max: 1_000 }, points: { min: 2, max: 100 }, powerUnit: 'dBm' }], features: [] },
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
    const measurement: Extract<InstrumentMeasurement, { kind: 'detected-power-timeseries' }> = { schemaVersion: 1, kind: 'detected-power-timeseries', measurementId: 'z1', sessionId: signalLabSession.sessionId, configurationRevision: 'z-config', producerConfigurationEpoch: 'producer-epoch:1', sequence: 2, capturedAt: '2026-07-10T00:00:02.000Z', elapsedMilliseconds: 40, resolutionBandwidthHz: null, attenuationDb: null, qualification: 'synthetic-visual-projection', complete: true, centerHz: 200, sampleIntervalSeconds: 0.01, timingQualification: 'simulation-exact', powerDbm: [-90, -80, -90, -80] };
    const projected = projectDetectedPowerMeasurement(measurement, signalLabSession, zero, 'detection-1');
    expect(projected.actualRbwHz).toBeNull();
    expect(projected.resolutionBandwidthQualification).toBe('unavailable');
    expect(projected.actualAttenuationDb).toBeNull();
    expect(projected.attenuationQualification).toBe('not-applicable');
    expect(projected.timingQualification).toBe('simulation-exact');
    expect(projected.targetDetectionId).toBe('detection-1');
  });

  it('rejects a SignalLab measurement whose producer epoch differs from the authoritative session snapshot', () => {
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
      rfOutput: 'off',
      rfOutputQualification: 'firmware-executed-twin',
    };
    expect(() => projectSpectrumMeasurement(spectrum({ sessionId: twin.sessionId, producerConfigurationEpoch: undefined }), twin, analyzer)).toThrow(/omitted.*resolution bandwidth/i);
    expect(() => projectSpectrumMeasurement(spectrum({ sessionId: 'other' }), signalLabSession, analyzer)).toThrow(/does not match active session/i);
  });
});
