import type { InstrumentFeatureCapability, SignalLabChannelState } from '@tinysa/contracts';
import {
  replayChannelConfigurationSchema,
  synthesizedSignalProfileSchema,
  waveformDescriptorSchema,
} from '../../../../../Atom-SignalLab/src/contracts.js';
import type { SignalLabStudioStatus } from '../../../../../Atom-SignalLab/src/SignalLabStudio.js';

export {
  SignalLabStudio,
  type SignalLabSessionState,
  type SignalLabSourceState,
  type SignalLabStudioPendingOperation,
  type SignalLabStudioProps,
  type SignalLabStudioStatus,
} from '../../../../../Atom-SignalLab/src/SignalLabStudio.js';

export type SignalLabProfileCapability = Extract<
  InstrumentFeatureCapability,
  { kind: 'signal-lab-profile-selection' }
>;

export interface SignalLabStudioCapabilityProjection {
  readonly status?: SignalLabStudioStatus;
  readonly error?: string;
}

/**
 * Converts only admitted, complete Atomizer capability state into the shared
 * Studio view. Geometry-only legacy capabilities stay visible as unavailable;
 * they are never padded with invented labels, standards evidence, or channel
 * settings.
 */
export function projectSignalLabStudioStatus(
  capability: SignalLabProfileCapability,
  selectedProfileId?: string,
  channelOverride?: SignalLabChannelState,
): SignalLabStudioCapabilityProjection {
  try {
    if (!capability.profiles.every(isCompleteDescriptor)) {
      return Object.freeze({ error: 'The connected SignalLab driver did not expose its complete waveform catalog.' });
    }
    const catalog = capability.profiles.map((profile) => waveformDescriptorSchema.parse({
      id: profile.profileId,
      label: profile.label,
      family: profile.family,
      model: profile.model,
      qualification: profile.qualification,
      centerHz: profile.centerFrequencyHz,
      occupiedBandwidthHz: profile.occupiedBandwidthHz,
      recommendedSpanHz: profile.recommendedSpanHz,
      projection: profile.projection,
      source: profile.source,
      disclosure: profile.disclosure,
      ...(profile.assetSha256 === undefined ? {} : { assetSha256: profile.assetSha256 }),
    }));
    const admittedProfile = synthesizedSignalProfileSchema.parse(capability.selectedProfileId);
    const requestedProfile = selectedProfileId === undefined
      ? admittedProfile
      : synthesizedSignalProfileSchema.safeParse(selectedProfileId);
    const profile = typeof requestedProfile === 'string'
      ? requestedProfile
      : requestedProfile.success && catalog.some((candidate) => candidate.id === requestedProfile.data)
        ? requestedProfile.data
        : admittedProfile;
    const waveform = catalog.find((candidate) => candidate.id === profile);
    if (!waveform) return Object.freeze({ error: `Admitted SignalLab profile ${profile} is absent from its catalog.` });
    const channel = replayChannelConfigurationSchema.parse(channelOverride ?? capability.channel);
    const staleSelection = selectedProfileId !== undefined && profile !== selectedProfileId
      ? `Selected SignalLab profile ${selectedProfileId} is not admitted; showing ${profile}.`
      : undefined;
    return Object.freeze({
      status: Object.freeze({
        profile,
        waveform,
        catalog: Object.freeze(catalog),
        channel,
      }),
      ...(staleSelection === undefined ? {} : { error: staleSelection }),
    });
  } catch (value) {
    return Object.freeze({ error: boundedProjectionError(value) });
  }
}

function isCompleteDescriptor(
  profile: SignalLabProfileCapability['profiles'][number],
): profile is Extract<typeof profile, { label: string }> {
  return 'label' in profile;
}

function boundedProjectionError(value: unknown): string {
  const detail = value instanceof Error ? value.message : String(value);
  return `SignalLab Studio rejected capability state: ${detail.replace(/[\r\n]+/g, ' ').slice(0, 512)}`;
}
