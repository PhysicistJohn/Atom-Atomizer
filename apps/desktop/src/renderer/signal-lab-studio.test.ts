import { describe, expect, it } from 'vitest';
import type { InstrumentFeatureCapability } from '@tinysa/contracts';
import { projectSignalLabStudioStatus } from './signal-lab-studio.js';

type Capability = Extract<InstrumentFeatureCapability, { kind: 'signal-lab-profile-selection' }>;

describe('SignalLab Studio capability projection', () => {
  it('maps complete admitted catalog and channel state without fabricating lifecycle metadata', () => {
    const capability = completeCapability();
    const projection = projectSignalLabStudioStatus(capability);

    expect(projection.error).toBeUndefined();
    expect(projection.status).toMatchObject({
      profile: 'cw',
      waveform: { id: 'cw', centerHz: 100_000_000, qualification: 'visual' },
      channel: { model: 'awgn', noiseFloorDbm: -108, seed: 1234, fadingRateHz: 2 },
    });
    expect(projection.status).not.toHaveProperty('sequence');
    expect(projection.status).not.toHaveProperty('playback');
    expect(projection.status).not.toHaveProperty('updatedAt');
  });

  it('rejects geometry-only, unknown-profile, and invalid channel projections', () => {
    const geometryOnly: Capability = {
      kind: 'signal-lab-profile-selection',
      profiles: [{ profileId: 'cw', centerFrequencyHz: 100_000_000, recommendedSpanHz: 2_000_000 }],
      selectedProfileId: 'cw',
    };
    expect(projectSignalLabStudioStatus(geometryOnly)).toEqual({
      error: 'The connected SignalLab driver did not expose its complete waveform catalog.',
    });
    expect(projectSignalLabStudioStatus(completeCapability(), 'not-a-profile').error)
      .toMatch(/not-a-profile is not admitted; showing cw/i);
    expect(projectSignalLabStudioStatus(completeCapability(), undefined, {
      model: 'awgn', noiseFloorDbm: 0, seed: 1, fadingRateHz: 1,
    }).error).toMatch(/rejected capability state/i);
  });
});

function completeCapability(): Capability {
  return {
    kind: 'signal-lab-profile-selection',
    profiles: [{
      profileId: 'cw',
      label: 'Continuous wave replay',
      family: 'tone',
      model: 'Analytic carrier',
      qualification: 'visual',
      centerFrequencyHz: 100_000_000,
      occupiedBandwidthHz: 1,
      recommendedSpanHz: 2_000_000,
      projection: { allocation: 'carrier', modulation: 'unmodulated', timing: 'continuous' },
      source: {
        organization: 'TinySA SignalLab',
        references: [{
          specification: 'SignalLab analytic scalar model',
          clause: 'CW projection',
          revision: '1',
          url: 'https://github.com/physicistjohn/Atom-SignalLab/blob/main/src/waveforms.ts',
        }],
      },
      disclosure: 'Analytic visualization only.',
    }],
    selectedProfileId: 'cw',
    channel: { model: 'awgn', noiseFloorDbm: -108, seed: 1234, fadingRateHz: 2 },
  };
}
