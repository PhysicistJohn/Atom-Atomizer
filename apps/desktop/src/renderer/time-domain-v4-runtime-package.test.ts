/// <reference types="node" />

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const v4Mocks = vi.hoisted(() => ({
  loadBound: vi.fn(
    async (
      _classifierBytes: Uint8Array,
      _policyBytes: Uint8Array,
      _options: unknown,
    ) => ({
      classifier: {},
      policy: {},
      artifactHashes: {
        classifierSha256: 'a'.repeat(64),
        policySha256: 'b'.repeat(64),
      },
    }),
  ),
  classify: vi.fn(
    (
      _bundle: unknown,
      _inPhase: ArrayLike<number>,
      _quadrature: ArrayLike<number>,
      _options: unknown,
    ): unknown => undefined,
  ),
}));

vi.mock(
  '../../../../../Atom-Classifier/src/embedding/time-domain-profile-bank-openset-v4.js',
  () => ({
    loadBoundTimeDomainOpenSetBundleV4: v4Mocks.loadBound,
    classifyTimeDomainOpenSetV4: v4Mocks.classify,
  }),
);

import {
  conditionalDistanceDisplayDistributionV4,
  createTimeDomainV4ModulationAdapter,
  loadTimeDomainV4ModulationAdapter,
  resolveTimeDomainV4ManifestPin,
  TIME_DOMAIN_V4_CLASSIFIER_FILENAME,
  TIME_DOMAIN_V4_DISPLAY_CALIBRATION_FILENAME,
  TIME_DOMAIN_V4_MANIFEST_FILENAME,
  TIME_DOMAIN_V4_OPENSET_FILENAME,
  TIME_DOMAIN_V4_PACKAGE_SCHEMA,
  TIME_DOMAIN_V4_RUNTIME_LENGTH_POLICY_BY_PROTOTYPE_SOURCE,
} from './time-domain-v4-runtime-package.js';

const remoteManifestUrl = new URL(
  `https://fixture.invalid/classifier/v4/${TIME_DOMAIN_V4_MANIFEST_FILENAME}`,
);

function encode(value: unknown): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    new TextEncoder().encode(JSON.stringify(value)),
  );
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function descriptor(
  path: string,
  bytes: Uint8Array,
  schema: string,
  schemaVersion: number,
  runtimeRole: string,
  requiredForDecision: boolean,
) {
  return {
    path,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    schema,
    schema_version: schemaVersion,
    runtime_role: runtimeRole,
    required_for_decision: requiredForDecision,
  };
}

function opensetPolicyFixture(): Record<string, unknown> {
  return {
    schema: 'atomos.v4.time-domain-current-source.external-openset-policy',
    schema_version: 5,
    prototype_source_routes: ['historical', 'current'],
    runtime_input_lengths: [4_096, 8_192, 16_384],
    runtime_bucket_rule:
      'largest_supported_prefix_not_exceeding_valid_sample_count',
    runtime_length_policy_by_prototype_source: {
      historical: {
        ...TIME_DOMAIN_V4_RUNTIME_LENGTH_POLICY_BY_PROTOTYPE_SOURCE.historical,
      },
      current: {
        ...TIME_DOMAIN_V4_RUNTIME_LENGTH_POLICY_BY_PROTOTYPE_SOURCE.current,
      },
    },
    stage_zero: {
      kind: 'exact-zero-no-signal-validity-gate',
      decision:
        'reject as no_signal iff max(abs(effective_route_scoped_inference_prefix_iq)) == 0',
      effective_prefix_scope:
        'current:first_4096_samples;historical:largest_supported_prefix_not_exceeding_valid_sample_count',
      runs_before_pose_estimation: true,
      learned_parameters: 0,
      invariant_to_nonzero_global_scale: true,
      invariant_to_global_phase: true,
    },
    per_prototype_source: {
      historical: {
        per_length: {
          4096: {},
          8192: {},
          16384: {},
        },
      },
      current: {
        per_length: {
          4096: {},
        },
      },
    },
  };
}

function packageFixture(
  admission: 'staging' | 'production' = 'staging',
  options: {
    includeDisplay?: boolean;
    boundClassifierSha?: string;
    currentDistanceLogitScale?: number;
    opensetDescriptorSchemaVersion?: number;
    mutateOpenset?: (policy: Record<string, unknown>) => void;
    mutateArchitecture?: (architecture: Record<string, unknown>) => void;
  } = {},
) {
  const includeDisplay = options.includeDisplay ?? true;
  const classifierBytes = encode({ classifier: 'fixture' });
  const openset = opensetPolicyFixture();
  options.mutateOpenset?.(openset);
  const opensetBytes = encode(openset);
  const classifierSha = sha256(classifierBytes);
  const displayBytes = encode({
    schema: 'atomos.v4.time-domain-profile-bank.display-calibration',
    schema_version: 1,
    status: admission === 'production' ? 'release' : 'staging_not_release',
    development_only: admission === 'staging',
    runtime_role: 'conditional_display_calibration',
    decision_authority: false,
    calibration_kind:
      'per-prototype-source-positive-distance-logit-scale-v1',
    classifier_asset_sha256:
      options.boundClassifierSha ?? classifierSha,
    distance_logit_scale_by_prototype_source: {
      current:
        options.currentDistanceLogitScale ?? 10.501238027734903,
      historical: 8.655378601595453,
    },
  });
  const assets: Record<string, unknown> = {
    [TIME_DOMAIN_V4_CLASSIFIER_FILENAME]: descriptor(
      TIME_DOMAIN_V4_CLASSIFIER_FILENAME,
      classifierBytes,
      'atomos.v4.time-domain-current-source-profile-bank.browser-weights',
      2,
      'accepted_known_classifier',
      true,
    ),
    [TIME_DOMAIN_V4_OPENSET_FILENAME]: descriptor(
      TIME_DOMAIN_V4_OPENSET_FILENAME,
      opensetBytes,
      'atomos.v4.time-domain-current-source.external-openset-policy',
      options.opensetDescriptorSchemaVersion ?? 5,
      'external_abstention_policy',
      true,
    ),
  };
  if (includeDisplay) {
    assets[TIME_DOMAIN_V4_DISPLAY_CALIBRATION_FILENAME] = descriptor(
      TIME_DOMAIN_V4_DISPLAY_CALIBRATION_FILENAME,
      displayBytes,
      'atomos.v4.time-domain-profile-bank.display-calibration',
      1,
      'conditional_display_calibration',
      false,
    );
  }
  const architecture: Record<string, unknown> = {
    classifier_and_policy_bytes_mutually_bound: true,
    trusted_prototype_source_required: true,
    classifier_precedes_route_conditioned_abstention: true,
    display_calibration_has_decision_authority: false,
    runtime_length_policy_by_prototype_source: {
      historical: {
        ...TIME_DOMAIN_V4_RUNTIME_LENGTH_POLICY_BY_PROTOTYPE_SOURCE.historical,
      },
      current: {
        ...TIME_DOMAIN_V4_RUNTIME_LENGTH_POLICY_BY_PROTOTYPE_SOURCE.current,
      },
    },
  };
  options.mutateArchitecture?.(architecture);
  const manifestBytes = encode({
    schema: TIME_DOMAIN_V4_PACKAGE_SCHEMA,
    schema_version: 1,
    status: admission === 'production' ? 'release' : 'staging_not_release',
    development_only: admission === 'staging',
    architecture,
    assets,
  });
  const files = new Map<string, Uint8Array>([
    [TIME_DOMAIN_V4_MANIFEST_FILENAME, manifestBytes],
    [TIME_DOMAIN_V4_CLASSIFIER_FILENAME, classifierBytes],
    [TIME_DOMAIN_V4_OPENSET_FILENAME, opensetBytes],
    [TIME_DOMAIN_V4_DISPLAY_CALIBRATION_FILENAME, displayBytes],
  ]);
  return {
    classifierBytes,
    opensetBytes,
    displayBytes,
    manifestBytes,
    files,
  };
}

function packageFetch(
  files: ReadonlyMap<string, Uint8Array>,
  requested: string[],
  transform?: (filename: string, bytes: Uint8Array) => Uint8Array,
): typeof fetch {
  return async (input) => {
    const url = input instanceof Request
      ? new URL(input.url)
      : new URL(input.toString());
    const filename = url.pathname.split('/').at(-1)!;
    requested.push(filename);
    const original = files.get(filename);
    if (original === undefined) {
      return new Response('not found', { status: 404 });
    }
    const bytes = transform?.(filename, original) ?? original;
    return new Response(Uint8Array.from(bytes).buffer, { status: 200 });
  };
}

function acceptedDsssDecision(
  prototypeSource: 'current' | 'historical' = 'current',
  observationInputLength: 4_096 | 8_192 | 16_384 = 8_192,
) {
  const runtimeInputLength = prototypeSource === 'current'
    ? 4_096
    : observationInputLength;
  return {
    disposition: 'accepted_known',
    reason: 'below_route_length_class_threshold',
    stageZero: false,
    prototypeSource,
    observationInputLength,
    runtimeInputLength,
    bucketKey: `${prototypeSource}/N${runtimeInputLength}/dsss`,
    occupiedBandwidthFraction: 0.42,
    closedDecision: {
      prototypeSource,
      runtimeInputLength,
      predictedPublicClassIndex: 3,
      predictedPublicClass: 'dsss',
      winningSquaredDistance: 0.9,
      winningPrototypeIndex: 10,
      squaredPublicClassDistances: Float64Array.from([
        Number.POSITIVE_INFINITY,
        1,
        Number.POSITIVE_INFINITY,
        0.9,
        Number.POSITIVE_INFINITY,
        1.2,
        1.1,
      ]),
      closestPrototypeIndices: Int32Array.from([-1, 2, -1, 10, -1, 15, 20]),
      supportedPublicClassMask: [false, true, false, true, false, true, true],
    },
    stageOneScore: 0.1,
    stageOneRank: {},
    stageTwoRank: {},
    compositeRank: 0.2,
    threshold: 0.95,
    artifactHashes: {
      classifierSha256: 'a'.repeat(64),
      policySha256: 'b'.repeat(64),
    },
  };
}

function acceptedCurrentDsssDecision() {
  return acceptedDsssDecision('current', 8_192);
}

describe('Atomizer v4 runtime package admission', () => {
  beforeEach(() => {
    v4Mocks.loadBound.mockClear();
    v4Mocks.classify.mockReset();
    v4Mocks.classify.mockReturnValue(acceptedCurrentDsssDecision());
  });

  it('fetches and verifies exactly the manifest plus its three runtime assets', async () => {
    const fixture = packageFixture();
    const requested: string[] = [];
    const classifier = await loadTimeDomainV4ModulationAdapter({
      admission: 'staging',
      manifestUrl: remoteManifestUrl,
      expectedManifestSha256: sha256(fixture.manifestBytes),
      fetcher: packageFetch(fixture.files, requested),
    });

    expect([...requested].sort()).toEqual([
      TIME_DOMAIN_V4_MANIFEST_FILENAME,
      TIME_DOMAIN_V4_CLASSIFIER_FILENAME,
      TIME_DOMAIN_V4_OPENSET_FILENAME,
      TIME_DOMAIN_V4_DISPLAY_CALIBRATION_FILENAME,
    ].sort());
    expect(v4Mocks.loadBound).toHaveBeenCalledOnce();
    expect(classifier.displayCalibration).toMatchObject({
      classifierAssetSha256: sha256(fixture.classifierBytes),
      distanceLogitScaleByPrototypeSource: {
        current: 10.501238027734903,
        historical: 8.655378601595453,
      },
    });
  });

  it('requires the schema-5 open-set descriptor and exact manifest route policy', async () => {
    const oldSchema = packageFixture('staging', {
      opensetDescriptorSchemaVersion: 4,
    });
    await expect(loadTimeDomainV4ModulationAdapter({
      admission: 'staging',
      manifestUrl: remoteManifestUrl,
      fetcher: packageFetch(oldSchema.files, []),
    })).rejects.toThrow(/schema_version must be 5/);

    const extraRoute = packageFixture('staging', {
      mutateArchitecture: (architecture) => {
        const routes = architecture
          .runtime_length_policy_by_prototype_source as Record<
            string,
            unknown
          >;
        routes.untrusted = {};
      },
    });
    await expect(loadTimeDomainV4ModulationAdapter({
      admission: 'staging',
      manifestUrl: remoteManifestUrl,
      fetcher: packageFetch(extraRoute.files, []),
    })).rejects.toThrow(
      /runtime_length_policy_by_prototype_source must contain exactly/,
    );

    const widenedCurrent = packageFixture('staging', {
      mutateArchitecture: (architecture) => {
        const routes = architecture
          .runtime_length_policy_by_prototype_source as {
            current: { effective_runtime_input_length: number };
          };
        routes.current.effective_runtime_input_length = 8_192;
      },
    });
    await expect(loadTimeDomainV4ModulationAdapter({
      admission: 'staging',
      manifestUrl: remoteManifestUrl,
      fetcher: packageFetch(widenedCurrent.files, []),
    })).rejects.toThrow(/effective_runtime_input_length must be 4096/);
    expect(v4Mocks.loadBound).not.toHaveBeenCalled();
  });

  it('rejects malformed, widened, or extra schema-5 policy routing before composition', async () => {
    const invalidPolicies: Array<{
      readonly name: string;
      readonly expected: RegExp;
      readonly mutate: (policy: Record<string, unknown>) => void;
    }> = [
      {
        name: 'old schema',
        expected: /schema_version must be 5/,
        mutate: (policy) => {
          policy.schema_version = 4;
        },
      },
      {
        name: 'extra runtime route',
        expected: /runtime_length_policy_by_prototype_source must contain exactly/,
        mutate: (policy) => {
          const routes = policy
            .runtime_length_policy_by_prototype_source as Record<
              string,
              unknown
            >;
          routes.experimental = {};
        },
      },
      {
        name: 'current 8K calibration',
        expected: /current\.per_length must contain exactly/,
        mutate: (policy) => {
          const routes = policy.per_prototype_source as {
            current: { per_length: Record<string, unknown> };
          };
          routes.current.per_length['8192'] = {};
        },
      },
      {
        name: 'missing historical 16K calibration',
        expected: /historical\.per_length must contain exactly/,
        mutate: (policy) => {
          const routes = policy.per_prototype_source as {
            historical: { per_length: Record<string, unknown> };
          };
          delete routes.historical.per_length['16384'];
        },
      },
      {
        name: 'ambiguous stage-zero scope alias',
        expected: /stage_zero must contain exactly/,
        mutate: (policy) => {
          const stageZero = policy.stage_zero as Record<string, unknown>;
          stageZero.prefix_scope = stageZero.effective_prefix_scope;
          delete stageZero.effective_prefix_scope;
        },
      },
    ];

    for (const invalid of invalidPolicies) {
      const fixture = packageFixture('staging', {
        mutateOpenset: invalid.mutate,
      });
      await expect(loadTimeDomainV4ModulationAdapter({
        admission: 'staging',
        manifestUrl: remoteManifestUrl,
        fetcher: packageFetch(fixture.files, []),
      }), invalid.name).rejects.toThrow(invalid.expected);
    }
    expect(v4Mocks.loadBound).not.toHaveBeenCalled();
  });

  it('rejects tampered open-set bytes against the manifest before composition', async () => {
    const fixture = packageFixture();
    await expect(loadTimeDomainV4ModulationAdapter({
      admission: 'staging',
      manifestUrl: remoteManifestUrl,
      fetcher: packageFetch(
        fixture.files,
        [],
        (filename, bytes) => {
          if (filename !== TIME_DOMAIN_V4_OPENSET_FILENAME) return bytes;
          const tampered = Uint8Array.from(bytes);
          tampered[tampered.length - 1]! ^= 1;
          return tampered;
        },
      ),
    })).rejects.toThrow(/SHA-256 does not match/);
    expect(v4Mocks.loadBound).not.toHaveBeenCalled();
  });

  it('fails closed when the production pin resolver has no compiled or explicit digest', () => {
    expect(() => resolveTimeDomainV4ManifestPin(
      'production',
      undefined,
      undefined,
    )).toThrow(/manifest SHA-256 pin is not configured/);
    expect(resolveTimeDomainV4ManifestPin(
      'staging',
      undefined,
      undefined,
    )).toBeUndefined();
  });

  it('admits a complete production package only under its exact manifest pin', async () => {
    const fixture = packageFixture('production');
    const classifier = await loadTimeDomainV4ModulationAdapter({
      admission: 'production',
      manifestUrl: remoteManifestUrl,
      expectedManifestSha256: sha256(fixture.manifestBytes),
      fetcher: packageFetch(fixture.files, []),
    });

    expect(classifier.displayCalibration?.distanceLogitScaleByPrototypeSource)
      .toEqual({
        current: 10.501238027734903,
        historical: 8.655378601595453,
      });
    expect(v4Mocks.loadBound.mock.calls[0]?.[2]).toMatchObject({
      admission: 'production',
      expectedClassifierSha256: sha256(fixture.classifierBytes),
      expectedPolicySha256: sha256(fixture.opensetBytes),
    });
  });

  it('requires the display calibration in production but permits explicit staging without it', async () => {
    const production = packageFixture('production', { includeDisplay: false });
    await expect(loadTimeDomainV4ModulationAdapter({
      admission: 'production',
      manifestUrl: remoteManifestUrl,
      expectedManifestSha256: sha256(production.manifestBytes),
      fetcher: packageFetch(production.files, []),
    })).rejects.toThrow(/production also requires the display-only calibration/);

    const staging = packageFixture('staging', { includeDisplay: false });
    const classifier = await loadTimeDomainV4ModulationAdapter({
      admission: 'staging',
      manifestUrl: remoteManifestUrl,
      fetcher: packageFetch(staging.files, []),
    });
    expect(classifier.displayCalibration).toBeUndefined();
  });

  it('rejects changed classifier bytes and a display asset bound to another classifier', async () => {
    const changed = packageFixture();
    await expect(loadTimeDomainV4ModulationAdapter({
      admission: 'staging',
      manifestUrl: remoteManifestUrl,
      fetcher: packageFetch(
        changed.files,
        [],
        (filename, bytes) => filename === TIME_DOMAIN_V4_CLASSIFIER_FILENAME
          ? Uint8Array.from([...bytes, 0x20])
          : bytes,
      ),
    })).rejects.toThrow(
      /exceeds its byte limit|byte length does not match|SHA-256 does not match/,
    );
    expect(v4Mocks.loadBound).not.toHaveBeenCalled();

    const wrongBinding = packageFixture('staging', {
      boundClassifierSha: 'f'.repeat(64),
    });
    await expect(loadTimeDomainV4ModulationAdapter({
      admission: 'staging',
      manifestUrl: remoteManifestUrl,
      fetcher: packageFetch(wrongBinding.files, []),
    })).rejects.toThrow(/classifier_asset_sha256/);
    expect(v4Mocks.loadBound).not.toHaveBeenCalled();
  });

  it('rejects a nonpositive route display scale before classifier composition', async () => {
    const fixture = packageFixture('staging', {
      currentDistanceLogitScale: 0,
    });
    await expect(loadTimeDomainV4ModulationAdapter({
      admission: 'staging',
      manifestUrl: remoteManifestUrl,
      fetcher: packageFetch(fixture.files, []),
    })).rejects.toThrow(/route scales must be positive/);
    expect(v4Mocks.loadBound).not.toHaveBeenCalled();
  });
});

describe('v4 display calibration is post-decision only', () => {
  beforeEach(() => {
    v4Mocks.loadBound.mockClear();
    v4Mocks.classify.mockReset();
  });

  it('sharpens the routed posterior without changing the closed winner', async () => {
    const fixture = packageFixture();
    const decision = acceptedCurrentDsssDecision();
    v4Mocks.classify.mockReturnValue(decision);
    const classifier = await loadTimeDomainV4ModulationAdapter({
      admission: 'staging',
      manifestUrl: remoteManifestUrl,
      fetcher: packageFetch(fixture.files, []),
    });
    const result = classifier.classifyIq(
      new Float64Array(8_192),
      new Float64Array(8_192),
      11_000_000,
      'current',
    );
    const unitScale = conditionalDistanceDisplayDistributionV4(
      ['am', 'bluetooth', 'cw', 'dsss', 'fm', 'gsm', 'ofdm'],
      decision.closedDecision.squaredPublicClassDistances,
      decision.closedDecision.supportedPublicClassMask,
      1,
    );

    expect(result.family).toBe('dsss');
    expect(result.candidates[0]?.label).toBe('dsss');
    expect(result.confidence).toBeGreaterThan(unitScale.dsss!);
    expect(decision.closedDecision.predictedPublicClass).toBe('dsss');
    expect(v4Mocks.classify).toHaveBeenCalledOnce();
    expect(v4Mocks.classify.mock.calls[0]?.[3]).toEqual({
      prototypeSource: 'current',
      validSampleCount: 8_192,
    });
  });

  it('does not change an open-set rejection, rank, or threshold', async () => {
    const fixture = packageFixture();
    const rejected = {
      ...acceptedCurrentDsssDecision(),
      disposition: 'unknown',
      reason: 'at_or_above_route_length_class_threshold',
      compositeRank: 0.97,
      threshold: 0.95,
    };
    v4Mocks.classify.mockReturnValue(rejected);
    const classifier = await loadTimeDomainV4ModulationAdapter({
      admission: 'staging',
      manifestUrl: remoteManifestUrl,
      fetcher: packageFetch(fixture.files, []),
    });
    const result = classifier.classifyIq(
      new Float64Array(8_192),
      new Float64Array(8_192),
      11_000_000,
      'current',
    );

    expect(result).toMatchObject({
      family: 'unknown',
      confidence: 0,
      isUnknown: true,
      candidates: [],
      rejection: {
        stage: 2,
        reason: 'open-set',
        score: 0.97,
        threshold: 0.95,
      },
    });
    expect(rejected.compositeRank).toBe(0.97);
    expect(rejected.threshold).toBe(0.95);
    expect(v4Mocks.classify).toHaveBeenCalledOnce();
  });
});

describe('v4 route-scoped observation and effective runtime lengths', () => {
  beforeEach(() => {
    v4Mocks.loadBound.mockClear();
    v4Mocks.classify.mockReset();
  });

  it('passes the full largest observation bucket and validates each route effective length', async () => {
    const fixture = packageFixture('staging', { includeDisplay: false });
    const classifier = await createTimeDomainV4ModulationAdapter({
      classifierBytes: fixture.classifierBytes,
      classifierSha256: sha256(fixture.classifierBytes),
      opensetBytes: fixture.opensetBytes,
      opensetSha256: sha256(fixture.opensetBytes),
    }, 'staging');
    const real = Float64Array.from(
      { length: 20_000 },
      (_, index) => index + 1,
    );
    const imaginary = Float64Array.from(
      { length: 20_000 },
      (_, index) => -(index + 1),
    );

    v4Mocks.classify.mockReturnValue(
      acceptedDsssDecision('current', 16_384),
    );
    classifier.classifyIq(real, imaginary, 11_000_000, 'current');
    expect(v4Mocks.classify.mock.calls[0]?.[1]).toHaveLength(16_384);
    expect(v4Mocks.classify.mock.calls[0]?.[2]).toHaveLength(16_384);
    expect(v4Mocks.classify.mock.calls[0]?.[3]).toEqual({
      prototypeSource: 'current',
      validSampleCount: 16_384,
    });

    v4Mocks.classify.mockReturnValue(
      acceptedDsssDecision('historical', 16_384),
    );
    classifier.classifyIq(real, imaginary, 11_000_000, 'historical');
    expect(v4Mocks.classify.mock.calls[1]?.[1]).toHaveLength(16_384);
    expect(v4Mocks.classify.mock.calls[1]?.[2]).toHaveLength(16_384);
    expect(v4Mocks.classify.mock.calls[1]?.[3]).toEqual({
      prototypeSource: 'historical',
      validSampleCount: 16_384,
    });
  });

  it('fails closed when classifier telemetry disagrees with route policy', async () => {
    const fixture = packageFixture('staging', { includeDisplay: false });
    const classifier = await createTimeDomainV4ModulationAdapter({
      classifierBytes: fixture.classifierBytes,
      classifierSha256: sha256(fixture.classifierBytes),
      opensetBytes: fixture.opensetBytes,
      opensetSha256: sha256(fixture.opensetBytes),
    }, 'staging');
    const invalid = acceptedDsssDecision('current', 8_192);
    v4Mocks.classify.mockReturnValue({
      ...invalid,
      runtimeInputLength: 8_192,
      bucketKey: 'current/N8192/dsss',
      closedDecision: {
        ...invalid.closedDecision,
        runtimeInputLength: 8_192,
      },
    });

    expect(() => classifier.classifyIq(
      new Float64Array(8_192),
      new Float64Array(8_192),
      11_000_000,
      'current',
    )).toThrow(/runtimeInputLength must be 4096/);
  });
});
