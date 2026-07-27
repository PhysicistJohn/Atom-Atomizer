import { describe, expect, it } from 'vitest';
import type { InstrumentFeatureCapability } from '@tinysa/contracts';
import { waveformDescriptor } from '../../../../../Atom-SignalLab/src/waveforms.js';
import { projectSignalLabStudioStatus } from './signal-lab-studio.js';

type Capability = Extract<InstrumentFeatureCapability, { kind: 'signal-lab-profile-selection' }>;

describe('SignalLab Studio capability projection', () => {
  it('maps complete admitted catalog and channel state without fabricating lifecycle metadata', () => {
    const capability = completeCapability();
    const projection = projectSignalLabStudioStatus(capability);

    expect(projection.error).toBeUndefined();
    expect(projection.status).toMatchObject({
      profile: 'cw',
      waveform: { id: 'cw', centerHz: waveformDescriptor('cw').centerHz, qualification: 'visual' },
      channel: { model: 'awgn', noiseFloorDbm: -108, seed: 1234, fadingRateHz: 2 },
    });
    expect(projection.status).not.toHaveProperty('sequence');
    expect(projection.status).not.toHaveProperty('playback');
    expect(projection.status).not.toHaveProperty('updatedAt');
    expect(projection.status?.waveform.governance).toMatchObject({
      profileId: 'cw',
      signalKind: 'mathematical-lab-reference',
      claims: {
        standardsCompliance: 'not-claimed',
        digitalQualification: 'not-qualified',
        rfConformance: 'not-qualified',
      },
    });
  });

  it('reports unknown profile selections and invalid channel overrides', () => {
    expect(projectSignalLabStudioStatus(completeCapability(), 'not-a-profile').error)
      .toMatch(/not-a-profile is not admitted; showing cw/i);
    expect(projectSignalLabStudioStatus(completeCapability(), undefined, {
      model: 'awgn', noiseFloorDbm: 0, seed: 1, fadingRateHz: 1, receiverImpairment: 'clean',
    }).error).toMatch(/rejected capability state/i);
  });
});

function completeCapability(): Capability {
  const descriptor = waveformDescriptor('cw');
  return {
    kind: 'signal-lab-profile-selection',
    profiles: [{
      profileId: descriptor.id,
      label: descriptor.label,
      family: descriptor.family,
      model: descriptor.model,
      qualification: descriptor.qualification,
      centerFrequencyHz: descriptor.centerHz,
      occupiedBandwidthHz: descriptor.occupiedBandwidthHz,
      recommendedSpanHz: descriptor.recommendedSpanHz,
      projection: descriptor.projection,
      source: descriptor.source,
      governance: descriptor.governance,
      disclosure: descriptor.disclosure,
      ...(descriptor.assetSha256 === undefined ? {} : { assetSha256: descriptor.assetSha256 }),
    }],
    selectedProfileId: 'cw',
    channel: {
      model: 'awgn', noiseFloorDbm: -108, seed: 1234, fadingRateHz: 2,
      receiverImpairment: 'clean',
    },
    iqProfiles: [{
      profileId: 'cw',
      nativeSampleRateHz: null,
      signalBandwidthHz: descriptor.occupiedBandwidthHz,
      profileReferenceCenterHz: descriptor.centerHz,
      nativeCarrierOffsetHz: 0,
      nativeMinimumCaptureBandwidthHz: null,
      replay: 'continuous',
      derivedTransportSupported: false,
    }],
  };
}
