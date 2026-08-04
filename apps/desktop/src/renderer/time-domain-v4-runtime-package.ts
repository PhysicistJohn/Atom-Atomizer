import type {
  BoundTimeDomainOpenSetBundleV4,
  TimeDomainOpenSetDecisionV4,
} from '../../../../../Atom-Classifier/src/embedding/time-domain-profile-bank-openset-v4.js';
import type {
  TimeDomainPrototypeSourceV4,
  TimeDomainPublicClassV4,
} from '../../../../../Atom-Classifier/src/embedding/time-domain-profile-routing-v4.js';
import type {
  IqModulationClassifier,
  ModulationClassification,
} from './embedding-classifier-runtime.js';

export const TIME_DOMAIN_V4_PACKAGE_SCHEMA =
  'atomos.v4.time-domain-profile-bank.runtime-package' as const;
export const TIME_DOMAIN_V4_PACKAGE_SCHEMA_VERSION = 1 as const;
export const TIME_DOMAIN_V4_PACKAGE_DIRECTORY = 'classifier/v4/' as const;
export const TIME_DOMAIN_V4_MANIFEST_FILENAME =
  'runtime-package-manifest.json' as const;
export const TIME_DOMAIN_V4_CLASSIFIER_FILENAME =
  'time-domain-profile-bank-v4.json' as const;
export const TIME_DOMAIN_V4_OPENSET_FILENAME =
  'time-domain-profile-bank-openset-v4.json' as const;
export const TIME_DOMAIN_V4_DISPLAY_CALIBRATION_FILENAME =
  'time-domain-profile-bank-display-calibration-v4.json' as const;

const TIME_DOMAIN_V4_CLASSIFIER_SCHEMA =
  'atomos.v4.time-domain-current-source-profile-bank.browser-weights';
const TIME_DOMAIN_V4_OPENSET_SCHEMA =
  'atomos.v4.time-domain-current-source.external-openset-policy';
const TIME_DOMAIN_V4_OPENSET_SCHEMA_VERSION = 5 as const;
const TIME_DOMAIN_V4_DISPLAY_CALIBRATION_SCHEMA =
  'atomos.v4.time-domain-profile-bank.display-calibration';
const TIME_DOMAIN_V4_DISPLAY_CALIBRATION_KIND =
  'per-prototype-source-positive-distance-logit-scale-v1';
const TIME_DOMAIN_V4_RUNTIME_BUCKET_RULE =
  'largest_supported_prefix_not_exceeding_valid_sample_count' as const;
const TIME_DOMAIN_V4_STAGE_ZERO_KIND =
  'exact-zero-no-signal-validity-gate' as const;
const TIME_DOMAIN_V4_STAGE_ZERO_DECISION =
  'reject as no_signal iff max(abs(effective_route_scoped_inference_prefix_iq)) == 0' as const;
const TIME_DOMAIN_V4_STAGE_ZERO_EFFECTIVE_PREFIX_SCOPE =
  'current:first_4096_samples;historical:largest_supported_prefix_not_exceeding_valid_sample_count' as const;
const TIME_DOMAIN_V4_MAX_ASSET_BYTES = 25 * 1024 * 1024;
const TIME_DOMAIN_V4_MAX_MANIFEST_BYTES = 256 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const TIME_DOMAIN_V4_RUNTIME_LENGTH_POLICY_BY_PROTOTYPE_SOURCE =
  Object.freeze({
    historical: Object.freeze({
      kind: TIME_DOMAIN_V4_RUNTIME_BUCKET_RULE,
      observation_length_reporting_rule: TIME_DOMAIN_V4_RUNTIME_BUCKET_RULE,
    }),
    current: Object.freeze({
      kind: 'fixed_causal_prefix' as const,
      effective_runtime_input_length: 4_096 as const,
      observation_length_reporting_rule: TIME_DOMAIN_V4_RUNTIME_BUCKET_RULE,
    }),
  });

type TimeDomainV4ObservationLength = 4_096 | 8_192 | 16_384;

/**
 * Filled only by the deterministic release-promotion step.
 *
 * Keeping this unset is intentional: the application production loader fails
 * before its first fetch until one exact immutable package manifest is pinned.
 */
export const TIME_DOMAIN_V4_RELEASE_MANIFEST_SHA256:
  string | undefined = undefined;

export type TimeDomainV4Admission = 'staging' | 'production';
export type TimeDomainV4Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type TimeDomainV4AssetFilename =
  | typeof TIME_DOMAIN_V4_CLASSIFIER_FILENAME
  | typeof TIME_DOMAIN_V4_OPENSET_FILENAME
  | typeof TIME_DOMAIN_V4_DISPLAY_CALIBRATION_FILENAME;

interface TimeDomainV4AssetDescriptor {
  readonly path: TimeDomainV4AssetFilename;
  readonly bytes: number;
  readonly sha256: string;
  readonly schema: string;
  readonly schemaVersion: number;
  readonly runtimeRole:
    | 'accepted_known_classifier'
    | 'external_abstention_policy'
    | 'conditional_display_calibration';
  readonly requiredForDecision: boolean;
}

interface TimeDomainV4PackageDescriptors {
  readonly classifier: TimeDomainV4AssetDescriptor;
  readonly openset: TimeDomainV4AssetDescriptor;
  readonly displayCalibration?: TimeDomainV4AssetDescriptor;
}

export interface TimeDomainV4DisplayCalibration {
  readonly schema: typeof TIME_DOMAIN_V4_DISPLAY_CALIBRATION_SCHEMA;
  readonly schemaVersion: 1;
  readonly classifierAssetSha256: string;
  readonly assetSha256: string;
  readonly distanceLogitScaleByPrototypeSource: Readonly<
    Record<TimeDomainPrototypeSourceV4, number>
  >;
}

export interface TimeDomainV4VerifiedRuntimeAssets {
  readonly classifierBytes: Uint8Array;
  readonly classifierSha256: string;
  readonly opensetBytes: Uint8Array;
  readonly opensetSha256: string;
  readonly displayCalibrationBytes?: Uint8Array;
  readonly displayCalibrationSha256?: string;
}

export interface TimeDomainV4RuntimePackageOptions {
  readonly manifestUrl?: string | URL;
  readonly admission?: TimeDomainV4Admission;
  readonly fetcher?: TimeDomainV4Fetch;
  /**
   * Explicit manifest pin for audited tests/staging promotion checks. Normal
   * production startup uses only `TIME_DOMAIN_V4_RELEASE_MANIFEST_SHA256`.
   */
  readonly expectedManifestSha256?: string;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as UnknownRecord;
}

function requireExact(
  value: unknown,
  expected: unknown,
  path: string,
): void {
  if (value !== expected) {
    throw new RangeError(`${path} must be ${JSON.stringify(expected)}`);
  }
}

function requireSha256(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${path} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function exactKeys(
  value: UnknownRecord,
  expectedKeys: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new RangeError(
      `${path} must contain exactly ${JSON.stringify(expected)}`,
    );
  }
}

function exactArray(
  value: unknown,
  expected: readonly unknown[],
  path: string,
): void {
  if (
    !Array.isArray(value)
    || value.length !== expected.length
    || value.some((entry, index) => entry !== expected[index])
  ) {
    throw new RangeError(`${path} must be exactly ${JSON.stringify(expected)}`);
  }
}

function validateRuntimeLengthPolicyByPrototypeSource(
  value: unknown,
  path: string,
): void {
  const routes = record(value, path);
  exactKeys(routes, ['historical', 'current'], path);

  const historical = record(routes.historical, `${path}.historical`);
  exactKeys(
    historical,
    ['kind', 'observation_length_reporting_rule'],
    `${path}.historical`,
  );
  requireExact(
    historical.kind,
    TIME_DOMAIN_V4_RUNTIME_LENGTH_POLICY_BY_PROTOTYPE_SOURCE.historical.kind,
    `${path}.historical.kind`,
  );
  requireExact(
    historical.observation_length_reporting_rule,
    TIME_DOMAIN_V4_RUNTIME_LENGTH_POLICY_BY_PROTOTYPE_SOURCE.historical
      .observation_length_reporting_rule,
    `${path}.historical.observation_length_reporting_rule`,
  );

  const current = record(routes.current, `${path}.current`);
  exactKeys(
    current,
    [
      'kind',
      'effective_runtime_input_length',
      'observation_length_reporting_rule',
    ],
    `${path}.current`,
  );
  requireExact(
    current.kind,
    TIME_DOMAIN_V4_RUNTIME_LENGTH_POLICY_BY_PROTOTYPE_SOURCE.current.kind,
    `${path}.current.kind`,
  );
  requireExact(
    current.effective_runtime_input_length,
    TIME_DOMAIN_V4_RUNTIME_LENGTH_POLICY_BY_PROTOTYPE_SOURCE.current
      .effective_runtime_input_length,
    `${path}.current.effective_runtime_input_length`,
  );
  requireExact(
    current.observation_length_reporting_rule,
    TIME_DOMAIN_V4_RUNTIME_LENGTH_POLICY_BY_PROTOTYPE_SOURCE.current
      .observation_length_reporting_rule,
    `${path}.current.observation_length_reporting_rule`,
  );
}

function validateTimeDomainV4OpenSetRouteContract(value: unknown): void {
  const policy = record(value, 'open-set policy');
  requireExact(
    policy.schema,
    TIME_DOMAIN_V4_OPENSET_SCHEMA,
    'open-set policy.schema',
  );
  requireExact(
    policy.schema_version,
    TIME_DOMAIN_V4_OPENSET_SCHEMA_VERSION,
    'open-set policy.schema_version',
  );
  exactArray(
    policy.prototype_source_routes,
    ['historical', 'current'],
    'open-set policy.prototype_source_routes',
  );
  exactArray(
    policy.runtime_input_lengths,
    [4_096, 8_192, 16_384],
    'open-set policy.runtime_input_lengths',
  );
  requireExact(
    policy.runtime_bucket_rule,
    TIME_DOMAIN_V4_RUNTIME_BUCKET_RULE,
    'open-set policy.runtime_bucket_rule',
  );
  validateRuntimeLengthPolicyByPrototypeSource(
    policy.runtime_length_policy_by_prototype_source,
    'open-set policy.runtime_length_policy_by_prototype_source',
  );

  const stageZero = record(policy.stage_zero, 'open-set policy.stage_zero');
  exactKeys(
    stageZero,
    [
      'kind',
      'decision',
      'effective_prefix_scope',
      'runs_before_pose_estimation',
      'learned_parameters',
      'invariant_to_nonzero_global_scale',
      'invariant_to_global_phase',
    ],
    'open-set policy.stage_zero',
  );
  requireExact(
    stageZero.kind,
    TIME_DOMAIN_V4_STAGE_ZERO_KIND,
    'open-set policy.stage_zero.kind',
  );
  requireExact(
    stageZero.decision,
    TIME_DOMAIN_V4_STAGE_ZERO_DECISION,
    'open-set policy.stage_zero.decision',
  );
  requireExact(
    stageZero.effective_prefix_scope,
    TIME_DOMAIN_V4_STAGE_ZERO_EFFECTIVE_PREFIX_SCOPE,
    'open-set policy.stage_zero.effective_prefix_scope',
  );
  requireExact(
    stageZero.runs_before_pose_estimation,
    true,
    'open-set policy.stage_zero.runs_before_pose_estimation',
  );
  requireExact(
    stageZero.learned_parameters,
    0,
    'open-set policy.stage_zero.learned_parameters',
  );
  requireExact(
    stageZero.invariant_to_nonzero_global_scale,
    true,
    'open-set policy.stage_zero.invariant_to_nonzero_global_scale',
  );
  requireExact(
    stageZero.invariant_to_global_phase,
    true,
    'open-set policy.stage_zero.invariant_to_global_phase',
  );

  const sourceRoutes = record(
    policy.per_prototype_source,
    'open-set policy.per_prototype_source',
  );
  exactKeys(
    sourceRoutes,
    ['historical', 'current'],
    'open-set policy.per_prototype_source',
  );
  for (const source of ['historical', 'current'] as const) {
    const sourcePath = `open-set policy.per_prototype_source.${source}`;
    const sourcePolicy = record(sourceRoutes[source], sourcePath);
    const perLength = record(
      sourcePolicy.per_length,
      `${sourcePath}.per_length`,
    );
    exactKeys(
      perLength,
      source === 'current'
        ? ['4096']
        : ['4096', '8192', '16384'],
      `${sourcePath}.per_length`,
    );
  }
}

function observationLengthForSampleCount(
  sampleCount: number,
): TimeDomainV4ObservationLength | undefined {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 4_096) {
    return undefined;
  }
  if (sampleCount < 8_192) return 4_096;
  if (sampleCount < 16_384) return 8_192;
  return 16_384;
}

function effectiveRuntimeLength(
  prototypeSource: TimeDomainPrototypeSourceV4,
  observationInputLength: TimeDomainV4ObservationLength,
): TimeDomainV4ObservationLength {
  return prototypeSource === 'current'
    ? TIME_DOMAIN_V4_RUNTIME_LENGTH_POLICY_BY_PROTOTYPE_SOURCE.current
        .effective_runtime_input_length
    : observationInputLength;
}

function validateRouteScopedDecision(
  decision: TimeDomainOpenSetDecisionV4,
  prototypeSource: TimeDomainPrototypeSourceV4,
  observationInputLength: TimeDomainV4ObservationLength,
): void {
  const runtimeInputLength = effectiveRuntimeLength(
    prototypeSource,
    observationInputLength,
  );
  requireExact(
    decision.prototypeSource,
    prototypeSource,
    'v4 decision.prototypeSource',
  );
  requireExact(
    decision.observationInputLength,
    observationInputLength,
    'v4 decision.observationInputLength',
  );
  requireExact(
    decision.runtimeInputLength,
    runtimeInputLength,
    'v4 decision.runtimeInputLength',
  );
  if (!decision.stageZero) {
    requireExact(
      decision.closedDecision.prototypeSource,
      prototypeSource,
      'v4 decision.closedDecision.prototypeSource',
    );
    requireExact(
      decision.closedDecision.runtimeInputLength,
      runtimeInputLength,
      'v4 decision.closedDecision.runtimeInputLength',
    );
  }
  if (
    typeof decision.bucketKey !== 'string'
    || !decision.bucketKey.startsWith(
      `${prototypeSource}/N${runtimeInputLength}/`,
    )
  ) {
    throw new RangeError(
      'v4 decision.bucketKey violates the route-scoped runtime-length policy',
    );
  }
}

function positiveBoundedBytes(value: unknown, path: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value <= 0
    || value >= TIME_DOMAIN_V4_MAX_ASSET_BYTES
  ) {
    throw new RangeError(
      `${path} must be a positive integer below 25 MiB`,
    );
  }
  return value;
}

function parseDescriptor(
  value: unknown,
  filename: TimeDomainV4AssetFilename,
  expected: {
    readonly schema: string;
    readonly schemaVersion: number;
    readonly runtimeRole: TimeDomainV4AssetDescriptor['runtimeRole'];
    readonly requiredForDecision: boolean;
  },
): TimeDomainV4AssetDescriptor {
  const path = `manifest.assets.${filename}`;
  const descriptor = record(value, path);
  exactKeys(
    descriptor,
    [
      'path',
      'bytes',
      'sha256',
      'schema',
      'schema_version',
      'runtime_role',
      'required_for_decision',
    ],
    path,
  );
  requireExact(descriptor.path, filename, `${path}.path`);
  requireExact(descriptor.schema, expected.schema, `${path}.schema`);
  requireExact(
    descriptor.schema_version,
    expected.schemaVersion,
    `${path}.schema_version`,
  );
  requireExact(
    descriptor.runtime_role,
    expected.runtimeRole,
    `${path}.runtime_role`,
  );
  requireExact(
    descriptor.required_for_decision,
    expected.requiredForDecision,
    `${path}.required_for_decision`,
  );
  return {
    path: filename,
    bytes: positiveBoundedBytes(descriptor.bytes, `${path}.bytes`),
    sha256: requireSha256(descriptor.sha256, `${path}.sha256`),
    schema: expected.schema,
    schemaVersion: expected.schemaVersion,
    runtimeRole: expected.runtimeRole,
    requiredForDecision: expected.requiredForDecision,
  };
}

function validateTimeDomainV4Manifest(
  value: unknown,
  admission: TimeDomainV4Admission,
): TimeDomainV4PackageDescriptors {
  const manifest = record(value, 'runtime package manifest');
  exactKeys(
    manifest,
    [
      'schema',
      'schema_version',
      'status',
      'development_only',
      'architecture',
      'assets',
    ],
    'runtime package manifest',
  );
  const status = admission === 'production' ? 'release' : 'staging_not_release';
  requireExact(
    manifest.schema,
    TIME_DOMAIN_V4_PACKAGE_SCHEMA,
    'manifest.schema',
  );
  requireExact(
    manifest.schema_version,
    TIME_DOMAIN_V4_PACKAGE_SCHEMA_VERSION,
    'manifest.schema_version',
  );
  requireExact(manifest.status, status, 'manifest.status');
  requireExact(
    manifest.development_only,
    admission === 'staging',
    'manifest.development_only',
  );

  const architecture = record(manifest.architecture, 'manifest.architecture');
  exactKeys(
    architecture,
    [
      'classifier_and_policy_bytes_mutually_bound',
      'trusted_prototype_source_required',
      'classifier_precedes_route_conditioned_abstention',
      'display_calibration_has_decision_authority',
      'runtime_length_policy_by_prototype_source',
    ],
    'manifest.architecture',
  );
  requireExact(
    architecture.classifier_and_policy_bytes_mutually_bound,
    true,
    'manifest.architecture.classifier_and_policy_bytes_mutually_bound',
  );
  requireExact(
    architecture.trusted_prototype_source_required,
    true,
    'manifest.architecture.trusted_prototype_source_required',
  );
  requireExact(
    architecture.classifier_precedes_route_conditioned_abstention,
    true,
    'manifest.architecture.classifier_precedes_route_conditioned_abstention',
  );
  requireExact(
    architecture.display_calibration_has_decision_authority,
    false,
    'manifest.architecture.display_calibration_has_decision_authority',
  );
  validateRuntimeLengthPolicyByPrototypeSource(
    architecture.runtime_length_policy_by_prototype_source,
    'manifest.architecture.runtime_length_policy_by_prototype_source',
  );

  const assets = record(manifest.assets, 'manifest.assets');
  const actualNames = Object.keys(assets).sort();
  const requiredNames = [
    TIME_DOMAIN_V4_CLASSIFIER_FILENAME,
    TIME_DOMAIN_V4_OPENSET_FILENAME,
  ];
  const admittedNames = new Set<string>([
    ...requiredNames,
    TIME_DOMAIN_V4_DISPLAY_CALIBRATION_FILENAME,
  ]);
  if (
    requiredNames.some((filename) => !actualNames.includes(filename))
    || actualNames.some((filename) => !admittedNames.has(filename))
    || actualNames.length < 2
    || actualNames.length > 3
    || (
      admission === 'production'
      && !actualNames.includes(TIME_DOMAIN_V4_DISPLAY_CALIBRATION_FILENAME)
    )
  ) {
    throw new RangeError(
      'manifest.assets must contain exactly the classifier and open-set '
      + 'policy; production also requires the display-only calibration asset',
    );
  }

  const classifier = parseDescriptor(
    assets[TIME_DOMAIN_V4_CLASSIFIER_FILENAME],
    TIME_DOMAIN_V4_CLASSIFIER_FILENAME,
    {
      schema: TIME_DOMAIN_V4_CLASSIFIER_SCHEMA,
      schemaVersion: 2,
      runtimeRole: 'accepted_known_classifier',
      requiredForDecision: true,
    },
  );
  const openset = parseDescriptor(
    assets[TIME_DOMAIN_V4_OPENSET_FILENAME],
    TIME_DOMAIN_V4_OPENSET_FILENAME,
    {
      schema: TIME_DOMAIN_V4_OPENSET_SCHEMA,
      schemaVersion: TIME_DOMAIN_V4_OPENSET_SCHEMA_VERSION,
      runtimeRole: 'external_abstention_policy',
      requiredForDecision: true,
    },
  );
  const displayValue = assets[TIME_DOMAIN_V4_DISPLAY_CALIBRATION_FILENAME];
  return {
    classifier,
    openset,
    ...(displayValue === undefined
      ? {}
      : {
          displayCalibration: parseDescriptor(
            displayValue,
            TIME_DOMAIN_V4_DISPLAY_CALIBRATION_FILENAME,
            {
              schema: TIME_DOMAIN_V4_DISPLAY_CALIBRATION_SCHEMA,
              schemaVersion: 1,
              runtimeRole: 'conditional_display_calibration',
              requiredForDecision: false,
            },
          ),
        }),
  };
}

async function responseBytes(
  fetcher: TimeDomainV4Fetch,
  url: URL,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetcher(url, {
    cache: 'no-cache',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(
      `v4 runtime asset fetch failed (${response.status} ${url})`,
    );
  }
  const statedLength = response.headers.get('content-length');
  if (statedLength !== null) {
    if (
      !/^(0|[1-9][0-9]*)$/.test(statedLength)
      || !Number.isSafeInteger(Number(statedLength))
    ) {
      throw new RangeError(
        `v4 runtime asset has an invalid byte length (${url})`,
      );
    }
    if (Number(statedLength) > maximumBytes) {
      throw new RangeError(`v4 runtime asset exceeds its byte limit (${url})`);
    }
  }
  if (response.body === null) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maximumBytes) {
      throw new RangeError(`v4 runtime asset exceeds its byte limit (${url})`);
    }
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Uint8Array.from(value);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new RangeError(
          `v4 runtime asset exceeds its byte limit (${url})`,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseJson(bytes: Uint8Array<ArrayBuffer>, path: string): unknown {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TypeError(`${path} is not valid UTF-8`, { cause: error });
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new TypeError(`${path} is not valid JSON`, { cause: error });
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('WebCrypto SHA-256 is unavailable');
  }
  const immutableBytes = Uint8Array.from(bytes);
  const digest = new Uint8Array(
    await subtle.digest('SHA-256', immutableBytes),
  );
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function loadVerifiedBytes(
  fetcher: TimeDomainV4Fetch,
  manifestUrl: URL,
  descriptor: TimeDomainV4AssetDescriptor,
): Promise<Uint8Array<ArrayBuffer>> {
  const url = new URL(descriptor.path, manifestUrl);
  const bytes = await responseBytes(fetcher, url, descriptor.bytes);
  if (bytes.byteLength !== descriptor.bytes) {
    throw new RangeError(
      `${descriptor.path} byte length does not match its manifest`,
    );
  }
  if (await sha256Hex(bytes) !== descriptor.sha256) {
    throw new RangeError(
      `${descriptor.path} SHA-256 does not match its manifest`,
    );
  }
  return bytes;
}

function defaultTimeDomainV4ManifestUrl(): URL {
  if (typeof globalThis.location?.href !== 'string') {
    throw new Error(
      'the v4 runtime package URL is unavailable outside a browser',
    );
  }
  const locationUrl = new URL(globalThis.location.href);
  if (locationUrl.protocol === 'file:') {
    // The packaged protocol namespaces the staging v4 package exactly like
    // the HTTP public directory does; the bare runtime root belongs to the
    // released v3 package.
    return new URL(
      `atomizer-classifier://runtime/v4/${TIME_DOMAIN_V4_MANIFEST_FILENAME}`,
    );
  }
  const publicRoot = new URL('/', locationUrl.origin);
  return new URL(
    `${TIME_DOMAIN_V4_PACKAGE_DIRECTORY}${TIME_DOMAIN_V4_MANIFEST_FILENAME}`,
    publicRoot,
  );
}

function resolvedManifestUrl(value: string | URL | undefined): URL {
  if (value === undefined) return defaultTimeDomainV4ManifestUrl();
  try {
    return new URL(value);
  } catch {
    return new URL(value, defaultTimeDomainV4ManifestUrl());
  }
}

export function resolveTimeDomainV4ManifestPin(
  admission: TimeDomainV4Admission,
  explicitManifestSha256: string | undefined,
  compiledReleaseManifestSha256: string | undefined,
): string | undefined {
  const expectedManifestSha256 = explicitManifestSha256
    ?? compiledReleaseManifestSha256;
  if (admission === 'production' && expectedManifestSha256 === undefined) {
    throw new Error(
      'the production v4 runtime manifest SHA-256 pin is not configured',
    );
  }
  if (
    expectedManifestSha256 !== undefined
    && !SHA256_PATTERN.test(expectedManifestSha256)
  ) {
    throw new TypeError(
      'expectedManifestSha256 must be a lowercase SHA-256 digest',
    );
  }
  return expectedManifestSha256;
}

function occupiedBandwidthFraction(
  decision: TimeDomainOpenSetDecisionV4,
): number {
  const value = (
    decision as TimeDomainOpenSetDecisionV4 & {
      readonly occupiedBandwidthFraction?: unknown;
    }
  ).occupiedBandwidthFraction;
  if (decision.stageZero) {
    if (value !== null && value !== undefined) {
      throw new RangeError(
        'exact-zero v4 decision must not claim a bandwidth estimate',
      );
    }
    // This is a conservative UI sentinel, not an estimate. The rejection
    // record tells the UI that the estimator did not run.
    return 1;
  }
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) {
    throw new RangeError(
      'nonzero v4 decision must expose its occupied bandwidth fraction',
    );
  }
  return value;
}

export function conditionalDistanceDisplayDistributionV4(
  classes: readonly TimeDomainPublicClassV4[],
  squaredDistances: ArrayLike<number>,
  supportedMask: readonly boolean[],
  distanceLogitScale: number,
): Record<string, number> {
  if (
    classes.length === 0
    || squaredDistances.length !== classes.length
    || supportedMask.length !== classes.length
  ) {
    throw new RangeError('v4 routed class-distance geometry is invalid');
  }
  if (!Number.isFinite(distanceLogitScale) || distanceLogitScale <= 0) {
    throw new RangeError('v4 distance-logit display scale must be positive');
  }
  let maximum = Number.NEGATIVE_INFINITY;
  const logits = classes.map((_, index) => {
    if (!supportedMask[index]) return Number.NEGATIVE_INFINITY;
    const distance = squaredDistances[index]!;
    if (!Number.isFinite(distance) || distance < 0) {
      throw new RangeError('supported v4 class distance must be finite');
    }
    const logit = -distanceLogitScale * distance;
    maximum = Math.max(maximum, logit);
    return logit;
  });
  if (!Number.isFinite(maximum)) {
    throw new RangeError('v4 selected route supports no public class');
  }
  const exponentials = logits.map((logit) =>
    Number.isFinite(logit) ? Math.exp(logit - maximum) : 0);
  const normalizer = exponentials.reduce((sum, value) => sum + value, 0);
  if (!(normalizer > 0) || !Number.isFinite(normalizer)) {
    throw new RangeError('v4 conditional display distribution is invalid');
  }
  return Object.fromEntries(
    classes.flatMap((name, index) =>
      supportedMask[index]
        ? [[name, exponentials[index]! / normalizer] as const]
        : []),
  );
}

function toTimeDomainV4Modulation(
  decision: TimeDomainOpenSetDecisionV4,
  displayCalibration: TimeDomainV4DisplayCalibration | undefined,
): ModulationClassification {
  const bwFraction = occupiedBandwidthFraction(decision);
  if (decision.disposition !== 'accepted_known') {
    return {
      flavor: 'iq',
      modulation: 'unknown',
      family: 'unknown',
      confidence: 0,
      isUnknown: true,
      candidates: [],
      bwFraction,
      rejection: decision.stageZero
        ? {
            stage: 0,
            reason: 'no-signal',
          }
        : {
            stage: 2,
            reason: 'open-set',
            score: decision.compositeRank,
            threshold: decision.threshold,
          },
    };
  }

  const closed = decision.closedDecision;
  const classes = closed.squaredPublicClassDistances.length === 7
    ? ([
        'am',
        'bluetooth',
        'cw',
        'dsss',
        'fm',
        'gsm',
        'ofdm',
      ] as const)
    : [];
  const posterior = conditionalDistanceDisplayDistributionV4(
    classes,
    closed.squaredPublicClassDistances,
    closed.supportedPublicClassMask,
    displayCalibration?.distanceLogitScaleByPrototypeSource[
      decision.prototypeSource
    ] ?? 1,
  );
  const candidates = Object.entries(posterior)
    .map(([label, confidence]) => ({ label, confidence }))
    .sort((left, right) =>
      right.confidence - left.confidence || left.label.localeCompare(right.label))
    .slice(0, 4);
  const confidence = posterior[closed.predictedPublicClass];
  if (confidence === undefined) {
    throw new Error('accepted v4 label is absent from its routed distribution');
  }
  return {
    flavor: 'iq',
    modulation: closed.predictedPublicClass,
    family: closed.predictedPublicClass,
    confidence,
    isUnknown: false,
    posterior,
    candidates,
    bwFraction,
  };
}

function validateDisplayCalibrationAsset(
  value: unknown,
  classifierSha256: string,
  assetSha256: string,
  admission: TimeDomainV4Admission,
): TimeDomainV4DisplayCalibration {
  const asset = record(value, 'display calibration asset');
  exactKeys(
    asset,
    [
      'schema',
      'schema_version',
      'status',
      'development_only',
      'runtime_role',
      'decision_authority',
      'calibration_kind',
      'classifier_asset_sha256',
      'distance_logit_scale_by_prototype_source',
    ],
    'display calibration asset',
  );
  requireExact(
    asset.schema,
    TIME_DOMAIN_V4_DISPLAY_CALIBRATION_SCHEMA,
    'display calibration asset.schema',
  );
  requireExact(
    asset.schema_version,
    1,
    'display calibration asset.schema_version',
  );
  requireExact(
    asset.status,
    admission === 'production' ? 'release' : 'staging_not_release',
    'display calibration asset.status',
  );
  requireExact(
    asset.development_only,
    admission === 'staging',
    'display calibration asset.development_only',
  );
  requireExact(
    asset.runtime_role,
    'conditional_display_calibration',
    'display calibration asset.runtime_role',
  );
  requireExact(
    asset.decision_authority,
    false,
    'display calibration asset.decision_authority',
  );
  requireExact(
    asset.calibration_kind,
    TIME_DOMAIN_V4_DISPLAY_CALIBRATION_KIND,
    'display calibration asset.calibration_kind',
  );
  requireExact(
    asset.classifier_asset_sha256,
    classifierSha256,
    'display calibration asset.classifier_asset_sha256',
  );
  const scales = record(
    asset.distance_logit_scale_by_prototype_source,
    'display calibration asset.distance_logit_scale_by_prototype_source',
  );
  exactKeys(
    scales,
    ['current', 'historical'],
    'display calibration asset.distance_logit_scale_by_prototype_source',
  );
  const current = scales.current;
  const historical = scales.historical;
  if (
    typeof current !== 'number'
    || !Number.isFinite(current)
    || current <= 0
    || typeof historical !== 'number'
    || !Number.isFinite(historical)
    || historical <= 0
  ) {
    throw new RangeError(
      'display calibration route scales must be positive finite numbers',
    );
  }
  return Object.freeze({
    schema: TIME_DOMAIN_V4_DISPLAY_CALIBRATION_SCHEMA,
    schemaVersion: 1,
    classifierAssetSha256: classifierSha256,
    assetSha256,
    distanceLogitScaleByPrototypeSource: Object.freeze({
      current,
      historical,
    }),
  });
}

export async function createTimeDomainV4ModulationAdapter(
  assets: TimeDomainV4VerifiedRuntimeAssets,
  admission: TimeDomainV4Admission = 'production',
): Promise<IqModulationClassifier> {
  const classifierSha256 = requireSha256(
    assets.classifierSha256,
    'classifier asset SHA-256',
  );
  const opensetSha256 = requireSha256(
    assets.opensetSha256,
    'open-set policy SHA-256',
  );
  const classifierBytes = Uint8Array.from(assets.classifierBytes);
  const opensetBytes = Uint8Array.from(assets.opensetBytes);
  const [actualClassifierSha256, actualOpensetSha256] = await Promise.all([
    sha256Hex(classifierBytes),
    sha256Hex(opensetBytes),
  ]);
  if (actualClassifierSha256 !== classifierSha256) {
    throw new RangeError('classifier raw-byte SHA-256 mismatch');
  }
  if (actualOpensetSha256 !== opensetSha256) {
    throw new RangeError('open-set policy raw-byte SHA-256 mismatch');
  }
  validateTimeDomainV4OpenSetRouteContract(
    parseJson(opensetBytes, TIME_DOMAIN_V4_OPENSET_FILENAME),
  );

  const hasDisplayBytes = assets.displayCalibrationBytes !== undefined;
  const hasDisplaySha = assets.displayCalibrationSha256 !== undefined;
  if (hasDisplayBytes !== hasDisplaySha) {
    throw new RangeError(
      'display calibration bytes and SHA-256 must be supplied together',
    );
  }
  if (admission === 'production' && !hasDisplayBytes) {
    throw new RangeError(
      'production v4 requires the bound display calibration asset',
    );
  }
  let displayCalibration: TimeDomainV4DisplayCalibration | undefined;
  if (
    assets.displayCalibrationBytes !== undefined
    && assets.displayCalibrationSha256 !== undefined
  ) {
    const displaySha256 = requireSha256(
      assets.displayCalibrationSha256,
      'display calibration asset SHA-256',
    );
    const displayBytes = Uint8Array.from(assets.displayCalibrationBytes);
    if (await sha256Hex(displayBytes) !== displaySha256) {
      throw new RangeError('display calibration raw-byte SHA-256 mismatch');
    }
    displayCalibration = validateDisplayCalibrationAsset(
      parseJson(displayBytes, TIME_DOMAIN_V4_DISPLAY_CALIBRATION_FILENAME),
      classifierSha256,
      displaySha256,
      admission,
    );
  }
  const module = await import(
    '../../../../../Atom-Classifier/src/embedding/time-domain-profile-bank-openset-v4.js'
  );
  const bundle: BoundTimeDomainOpenSetBundleV4 =
    await module.loadBoundTimeDomainOpenSetBundleV4(
      classifierBytes,
      opensetBytes,
      {
        expectedClassifierSha256: classifierSha256,
        expectedPolicySha256: opensetSha256,
        admission,
      },
    );
  return {
    ...(displayCalibration === undefined
      ? {}
      : { displayCalibration }),
    classifyIq: (re, im, _bandwidthHz, prototypeSource) => {
      if (re.length !== im.length) {
        throw new RangeError(
          'v4 I/Q real and imaginary observation lengths must match',
        );
      }
      if (prototypeSource !== 'current' && prototypeSource !== 'historical') {
        throw new RangeError('v4 classifier requires a trusted prototype source');
      }
      const observationInputLength = observationLengthForSampleCount(re.length);
      if (observationInputLength === undefined) {
        throw new RangeError(
          'v4 classifier requires at least 4,096 complex observation samples',
        );
      }
      // Preserve the route-independent observation bucket at this boundary.
      // The schema-5 classifier alone applies current:first-4096; historical
      // consumes this whole largest supported 4/8/16K causal prefix.
      const observationReal = re.length === observationInputLength
        ? re
        : re.subarray(0, observationInputLength);
      const observationImaginary = im.length === observationInputLength
        ? im
        : im.subarray(0, observationInputLength);
      const decision = module.classifyTimeDomainOpenSetV4(
        bundle,
        observationReal,
        observationImaginary,
        {
          prototypeSource,
          validSampleCount: observationInputLength,
        },
      );
      validateRouteScopedDecision(
        decision,
        prototypeSource,
        observationInputLength,
      );
      return toTimeDomainV4Modulation(
        decision,
        displayCalibration,
      );
    },
  };
}

/**
 * Fetch, byte-verify, mutually bind, and compose the two decision-authority
 * assets in the v4 package. The separate classifier-bound display calibration
 * is required in production and may scale only the conditional distance
 * display distribution; it cannot alter the winner or abstention policy.
 */
export async function loadTimeDomainV4ModulationAdapter(
  options: TimeDomainV4RuntimePackageOptions = {},
): Promise<IqModulationClassifier> {
  const admission = options.admission ?? 'production';
  const manifestUrl = resolvedManifestUrl(options.manifestUrl);
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const expectedManifestSha256 = resolveTimeDomainV4ManifestPin(
    admission,
    options.expectedManifestSha256,
    TIME_DOMAIN_V4_RELEASE_MANIFEST_SHA256,
  );

  const manifestBytes = await responseBytes(
    fetcher,
    manifestUrl,
    TIME_DOMAIN_V4_MAX_MANIFEST_BYTES,
  );
  if (
    expectedManifestSha256 !== undefined
    && await sha256Hex(manifestBytes) !== expectedManifestSha256
  ) {
    throw new RangeError(
      'v4 runtime manifest SHA-256 does not match the sealed release',
    );
  }
  const descriptors = validateTimeDomainV4Manifest(
    parseJson(manifestBytes, TIME_DOMAIN_V4_MANIFEST_FILENAME),
    admission,
  );
  const displayDescriptor = descriptors.displayCalibration;
  const displayCalibrationPromise = displayDescriptor === undefined
    ? Promise.resolve(undefined)
    : loadVerifiedBytes(
        fetcher,
        manifestUrl,
        displayDescriptor,
      ).then((bytes) => ({
        bytes,
        sha256: displayDescriptor.sha256,
      }));
  const [classifierBytes, opensetBytes, displayCalibration] =
    await Promise.all([
      loadVerifiedBytes(fetcher, manifestUrl, descriptors.classifier),
      loadVerifiedBytes(fetcher, manifestUrl, descriptors.openset),
      displayCalibrationPromise,
    ]);

  return createTimeDomainV4ModulationAdapter(
    {
      classifierBytes,
      classifierSha256: descriptors.classifier.sha256,
      opensetBytes,
      opensetSha256: descriptors.openset.sha256,
      ...(displayCalibration === undefined
        ? {}
        : {
            displayCalibrationBytes: displayCalibration.bytes,
            displayCalibrationSha256: displayCalibration.sha256,
          }),
    },
    admission,
  );
}
