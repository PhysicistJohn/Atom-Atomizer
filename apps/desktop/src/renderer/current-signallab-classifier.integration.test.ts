/// <reference types="node" />
// @vitest-environment node

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  InstrumentDriverRegistry,
  InstrumentManager,
} from '@tinysa/instrument-runtime';
import type {
  InstrumentMeasurement,
  SignalLabIqProfileCapability,
} from '@tinysa/contracts';
import {
  FIXED_DIGITAL_PROFILE_BINDINGS,
  type FixedDigitalProfile,
} from '../../../../../Atom-SignalLab/src/fixed-digital-profile-binding.js';
import { InProcessSignalLabDriver } from '../shared/in-process-signal-lab-driver.js';
import {
  decodeComplexIqChannels,
  type ComplexIqMeasurement,
} from './complex-iq.js';
import {
  type IqModulationClassifier,
} from './embedding-classifier-runtime.js';
import { classificationIqPrefixLength } from './controllers/classification.js';
import { loadTimeDomainV4ModulationAdapter } from './time-domain-v4-runtime-package.js';

/*
 * This is the static package copied into both the desktop build and the web
 * deployment. Loading it here makes promotion of the classifier assets part of
 * this gate; reading Atom-Classifier's source release directory directly could
 * pass while Atomizer still shipped stale bytes.
 */
const livePackageRoot = new URL(
  '../../../web/public/classifier/v4/',
  import.meta.url,
);
const manifestUrl = new URL(
  'https://fixture.invalid/classifier/v4/runtime-package-manifest.json',
);
const fixedProfiles = Object.keys(
  FIXED_DIGITAL_PROFILE_BINDINGS,
) as FixedDigitalProfile[];

function packageFetch(root: URL): typeof fetch {
  return async (input) => {
    const requestUrl = input instanceof Request
      ? new URL(input.url)
      : new URL(input.toString());
    const filename = requestUrl.pathname.split('/').at(-1)!;
    const bytes = Uint8Array.from(await readFile(new URL(filename, root)));
    return new Response(bytes, { status: 200 });
  };
}

function expectedPublicClass(profile: FixedDigitalProfile):
  'bluetooth' | 'dsss' | 'gsm' | 'ofdm' {
  if (profile.startsWith('gsm-')) return 'gsm';
  if (profile.startsWith('bluetooth-')) return 'bluetooth';
  if (profile === 'wifi-hr-dsss-11m') return 'dsss';
  return 'ofdm';
}

function requireSignalLabIqProfile(
  measurementProfile: FixedDigitalProfile,
  profiles: readonly SignalLabIqProfileCapability[],
): SignalLabIqProfileCapability {
  const profile = profiles.find(
    (candidate) => candidate.profileId === measurementProfile,
  );
  if (!profile || profile.nativeSampleRateHz === null) {
    throw new Error(
      `SignalLab did not advertise fixed native I/Q for ${measurementProfile}`,
    );
  }
  return profile;
}

async function acquireCleanFixedProfile(
  profileId: FixedDigitalProfile,
): Promise<ComplexIqMeasurement> {
  let opaqueSequence = 0;
  const manager = new InstrumentManager(
    new InstrumentDriverRegistry([new InProcessSignalLabDriver()]),
    {
      now: () => new Date('2026-07-29T00:00:00.000Z'),
      opaqueId: (scope) => `${scope}:classifier-gate:${++opaqueSequence}`,
    },
  );
  try {
    const discovery = await manager.discover();
    const candidate = discovery.candidates.find(
      ({ sourceKind }) => sourceKind === 'signal-lab',
    );
    if (!candidate) throw new Error('SignalLab discovery returned no candidate');
    const connected = await manager.connect(candidate);
    const selected = await manager.executeFeature({
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId,
    });
    expect(selected).toMatchObject({
      kind: 'signal-lab-profile-selection',
      action: 'select-profile',
      profileId,
    });

    const session = manager.snapshot() ?? connected;
    const feature = session.capabilities.features.find(
      (capability) => capability.kind === 'signal-lab-profile-selection',
    );
    if (feature?.kind !== 'signal-lab-profile-selection') {
      throw new Error('SignalLab profile capability disappeared');
    }
    expect(feature.channel.receiverImpairment).toBe('clean');
    const profile = requireSignalLabIqProfile(profileId, feature.iqProfiles);
    const sampleCount = Math.min(16_384, profile.maxOneShotSamples ?? 16_384);
    const bandwidthHz = profile.nativeMinimumCaptureBandwidthHz
      ?? profile.signalBandwidthHz;
    await manager.configure({
      kind: 'complex-iq',
      centerHz: profile.profileReferenceCenterHz,
      sampleRateHz: profile.nativeSampleRateHz!,
      bandwidthHz,
      sampleCount,
      sampleFormat: 'cf32le',
    });
    const measurement: InstrumentMeasurement = await manager.acquire();
    if (measurement.kind !== 'complex-iq') {
      throw new Error(
        `SignalLab returned ${measurement.kind} for ${profileId} I/Q`,
      );
    }
    expect(measurement).toMatchObject({
      kind: 'complex-iq',
      sampleRateHz: profile.nativeSampleRateHz,
      bandwidthHz,
      sampleCount,
      sampleFormat: 'cf32le',
      qualification: 'independently-verified-digital-baseband',
      payloadKind: 'native-canonical',
      receiverImpairment: 'clean',
    });
    return measurement;
  } finally {
    await manager.disconnect();
  }
}

/*
 * Runs against the staging-admission v4 package assembled by
 * `tools/package-v4-runtime-assets.mjs`.
 *
 * Atom-Classifier has no designated v4 release directory -- only experiment
 * dumps under `.artifacts/v4-*` from several training runs. The three
 * packaged assets are nonetheless a mutually bound set, and cryptographically
 * so rather than by directory naming: the open-set policy's
 * `classifier_binding.browser_classifier_asset_sha256` and the display
 * calibration's `classifier_asset_sha256` both equal the exact SHA-256 of the
 * packaged classifier bank, which artifacts from unreconciled runs would not
 * agree on. The packaging step re-checks that binding and fails loudly.
 *
 * What is still absent is a release promotion: no v4 release gates have been
 * run, so every asset keeps its development status and
 * `TIME_DOMAIN_V4_RELEASE_MANIFEST_SHA256` stays `undefined`. Loading through
 * the staging channel keeps that claim honest while exercising the real
 * decision path -- admission changes provenance labels only. Switch this to
 * production admission when a genuine promotion fills the pin.
 */
const v4ManifestShipped = existsSync(
  fileURLToPath(new URL('runtime-package-manifest.json', livePackageRoot)),
);

describe.skipIf(!v4ManifestShipped)('current SignalLab fixed profiles against Atomizer live classifier assets', () => {
  let classifier: IqModulationClassifier;

  beforeAll(async () => {
    classifier = await loadTimeDomainV4ModulationAdapter({
      manifestUrl,
      fetcher: packageFetch(livePackageRoot),
      admission: 'staging',
    });
  });

  it('admits the complete BLE one-shot capture as the tested 8,192-sample prefix', async () => {
    const capture = await acquireCleanFixedProfile(
      'bluetooth-le-advertising',
    );
    expect(capture.sampleCount).toBe(12_160);
    const prefixLength = classificationIqPrefixLength(capture.sampleCount);
    expect(prefixLength).toBe(8_192);
    const channels = decodeComplexIqChannels(capture, prefixLength);
    expect(channels.re).toHaveLength(8_192);
    expect(channels.im).toHaveLength(8_192);
  });

  it.each(fixedProfiles)(
    '%s retains its governed public modulation class through the app measurement path',
    async (profile) => {
      const capture = await acquireCleanFixedProfile(profile);
      const prefixLength = classificationIqPrefixLength(capture.sampleCount);
      expect(prefixLength, `${profile} runtime prefix admission`).toBeDefined();
      const channels = decodeComplexIqChannels(capture, prefixLength!);
      const result = classifier.classifyIq(
        channels.re,
        channels.im,
        capture.bandwidthHz,
        'current',
      );
      const expected = expectedPublicClass(profile);
      expect(result.family, JSON.stringify({
        profile,
        expected,
        actual: result.family,
        confidence: result.confidence,
        candidates: result.candidates,
        rejection: result.rejection,
        sampleCount: capture.sampleCount,
        classifiedPrefix: prefixLength,
      })).toBe(expected);
      expect(result.candidates[0]?.label).toBe(expected);
    },
    30_000,
  );
});
