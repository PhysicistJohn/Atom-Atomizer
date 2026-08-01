// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Sweep } from '@tinysa/contracts';
import { AgentExecutor, assertAgentSweepPowerEvidence } from './agent-executor.js';

const sweep = {
  kind: 'spectrum', id: 'neptune-relative', sequence: 1, capturedAt: '2026-07-31T12:00:00.000Z', elapsedMilliseconds: 4,
  frequencyHz: [0, 25, 50, 75, 100], powerDbm: [-100, -90, -40, -90, -100],
  powerReference: 'uncalibrated-dbfs-relative',
  requested: {
    kind: 'swept-spectrum', startHz: 0, stopHz: 100, points: 5, sweepTimeSeconds: 0.004,
    controls: { schemaVersion: 1, model: 'host-derived-iq-projection', fftSize: 5, window: 'hann-periodic' },
  },
  actualStartHz: 0, actualStopHz: 100, actualRbwHz: 25, actualAttenuationDb: null,
  resolutionBandwidthQualification: 'host-derived-fft-bin', attenuationQualification: 'not-applicable',
  source: 'host-derived-from-complex-iq', complete: true,
  identity: {
    kind: 'instrument-session', sessionId: 'session-neptune', driverId: 'neptune-p210', candidateId: 'neptune-p210:ip:10.0.0.250',
    provenance: { sourceKind: 'neptune-p210', execution: 'physical', transport: 'libiio-network', qualification: 'device-observed', verifiedAt: '2026-07-31T12:00:00.000Z', endpoint: 'ip:10.0.0.250' },
  },
} satisfies Sweep;

describe('Agent uncalibrated sweep evidence', () => {
  it('does not apply native physical-receiver dBm assertions to a Neptune host FFT', () => {
    const executor = new AgentExecutor({} as never);
    const summary = executor.agentLatestSweepSummary(sweep, {
      peakDbm: -40, peakHz: 50, minimumDbm: -100, meanDbm: -46.9, medianDbm: -90,
      noiseFloorDbm: -100, summedPowerDbm: -39.9, occupiedBandwidth99Hz: 50, crestFactorDb: 6.9,
    });
    expect(summary).toMatchObject({
      source: 'host-derived-from-complex-iq',
      powerReference: 'uncalibrated-dbfs-relative',
      powerUnit: 'dBFS-relative',
      resolutionBandwidthQualification: 'host-derived-fft-bin',
      attenuationQualification: 'not-applicable',
    });
  });

  it('fails closed for missing or contradictory Neptune power evidence', () => {
    expect(() => assertAgentSweepPowerEvidence({ ...sweep, powerReference: undefined }))
      .toThrow(/omitted.*dBFS-relative power reference/i);
    expect(() => assertAgentSweepPowerEvidence({ ...sweep, resolutionBandwidthQualification: 'device-observed' }))
      .toThrow(/contradictory host-derived FFT provenance/i);
    expect(() => assertAgentSweepPowerEvidence({ ...sweep, attenuationQualification: 'device-observed' }))
      .toThrow(/contradictory attenuation evidence/i);
  });
});
