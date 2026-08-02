/**
 * Renderer-side runtime for the browser-native metric-embedding classifier
 * (Atom-Classifier `src/embedding`). Integrity-bound static assets and a pinned
 * browser runtime keep desktop and web behavior identical, and fully replace
 * the Bayesian classifier.
 *
 * Two flavors share the surface but intentionally use different frozen models:
 *   - I/Q (complex baseband, SDR/SignalLab): the v3 dual-fusion runtime.
 *   - magnitude (scalar power spectrum, tinySA): the retained v2 runtime.
 * Large model assets are fetched from static runtime packages, hashed before
 * use, and never embedded in a JavaScript chunk.
 *
 * Also re-exports the blind symbol-recovery front-end (`recoverIqConstellation`)
 * — a zero-dependency DSP (CMA equalizer + carrier lock) that turns raw I/Q into
 * a recovered symbol constellation, so the I/Q view can show distinguishable
 * symbols instead of a pre-equalization smear.
 */

import { recoverConstellation } from '../../../../../Atom-Classifier/src/embedding/recover.js';
import {
  isDacsV7SampleRate,
  selectDacsV7Dwell,
  type DacsV7Dwell,
} from './dacs-v7-contract.js';

/** Recovered symbol constellation, bounded + normalised for direct plotting. */
export interface RecoveredConstellation {
  /** Symbol points, normalised to unit RMS; capped for the renderer. */
  readonly points: readonly { i: number; q: number }[];
  readonly sps: number;
  /** Recovery-quality gate (lower is cleaner); < ~0.22 = distinct symbols. */
  readonly residualIsi: number;
  readonly snrDb: number;
  /** True when the recovery resolves distinct symbols (single-carrier, in-SNR). */
  readonly clean: boolean;
}

/** Recovery quality gate: below this residual-ISI the symbols are distinct. */
const RECOVERY_ISI_GATE = 0.22;
const RECOVERY_SNR_GATE_DB = 3;

/**
 * Blind-recover the symbol constellation from raw complex I/Q. Equalizes the
 * channel + absorbs timing (CMA) and locks the carrier, yielding distinct symbol
 * points for single-carrier signals. Multicarrier (OFDM) and noise stay a cloud
 * and fail the quality gate (`clean === false`) — honestly, there is no single
 * time-domain symbol constellation to resolve there.
 */
export function recoverIqConstellation(re: Float64Array, im: Float64Array, spsHint?: number): RecoveredConstellation {
  const r = recoverConstellation(re, im, spsHint);
  const n = r.symbolsRe.length;
  let meanRe = 0, meanIm = 0;
  for (let k = 0; k < n; k++) { meanRe += r.symbolsRe[k]!; meanIm += r.symbolsIm[k]!; }
  meanRe /= Math.max(n, 1); meanIm /= Math.max(n, 1);
  let power = 0, varAboutMean = 0;
  for (let k = 0; k < n; k++) {
    const a = r.symbolsRe[k]!, b = r.symbolsIm[k]!;
    power += a * a + b * b;
    const dr = a - meanRe, di = b - meanIm;
    varAboutMean += dr * dr + di * di;
  }
  const totalPower = power / Math.max(n, 1);
  const rms = Math.sqrt(totalPower) + 1e-12;
  // Fraction of symbol energy that is modulation (variance about the mean) vs a
  // static carrier/DC term. A tone or CW collapses to a single point (~0); a
  // real constellation spreads (~1). Rejects the CW false-positive where
  // residual-ISI degenerates to 0.
  const modulatedFraction = (varAboutMean / Math.max(n, 1)) / (totalPower + 1e-12);
  const cap = 2048;
  const step = Math.max(1, Math.ceil(n / cap));
  const points: { i: number; q: number }[] = [];
  for (let k = 0; k < n; k += step) points.push({ i: r.symbolsRe[k]! / rms, q: r.symbolsIm[k]! / rms });
  return {
    points,
    sps: r.sps,
    residualIsi: r.residualIsi,
    snrDb: r.snrDb,
    clean: r.residualIsi < RECOVERY_ISI_GATE && r.snrDb > RECOVERY_SNR_GATE_DB && modulatedFraction > 0.35,
  };
}

interface EmbeddingLikeResult {
  classification: { label: string; confidence: number; isUnknown: boolean; posterior: Record<string, number> };
  modulation: { modulation: string };
  bw: number;
  leafLikelihood: Record<string, number>;
}

/** Compact, prop-safe result surfaced to the Detect panel. */
export interface ModulationClassification {
  /** Which flavor produced this result. */
  flavor: 'iq' | 'magnitude';
  /** Refined modulation (a resolved order when available, else family). */
  modulation: string;
  /** The admitted modulation-family label (or 'unknown'). */
  family: string;
  confidence: number;
  isUnknown: boolean;
  /** Conditional family display distribution; absent on a v3 rejection. */
  readonly posterior?: Readonly<Record<string, number>>;
  /** Top posterior candidates (family distribution). */
  candidates: readonly { label: string; confidence: number }[];
  /** Measured occupied fractional bandwidth. */
  bwFraction: number;
  /** Strongest fused protocol leaf, when the fusion concentrates. */
  topLeaf?: { label: string; probability: number };
  /** Runtime provenance for the instantaneous result. */
  runtime?: {
    readonly model: 'magnitude-v2' | 'time-domain-v3' | 'dacs-v7';
    readonly openSetGate?: 'time-domain-v3';
    readonly dwell?: DacsV7Dwell;
    readonly dwellSamples?: number;
    readonly executionProvider?: 'wasm';
    /** Diagnostic only; it has no rejection or dwell-selection authority. */
    readonly confidenceLogit?: number;
  };
  /** Present for a live v3 I/Q abstention; omitted for magnitude v2. */
  rejection?: {
    /** Stage 1 gated noise; stage 2 abstained before the label classifier. */
    readonly stage: 1 | 2;
    readonly reason: 'noise' | 'open-set';
    readonly score: number;
    readonly threshold: number;
  };
}

interface MagnitudeClassifierLike {
  classifyPsd(psd: Float64Array, center: number, bw: number, opts?: { bandwidthHz?: number }): EmbeddingLikeResult;
}

let magPromise: Promise<MagnitudeClassifierLike> | undefined;

async function loadMagnitudeClassifier(): Promise<MagnitudeClassifierLike> {
  if (!magPromise) {
    magPromise = (async () => {
      const [mod, weights, protos] = await Promise.all([
        import('../../../../../Atom-Classifier/src/embedding/magnitude-classifier.js'),
        import('../../../../../Atom-Classifier/src/embedding/assets/magnitude-weights.json'),
        import('../../../../../Atom-Classifier/src/embedding/assets/magnitude-prototypes.json'),
      ]);
      const model = (weights as { default?: unknown }).default ?? weights;
      const prototypes = (protos as { default?: unknown }).default ?? protos;
      return new mod.MagnitudeWaveformClassifier(model as never, prototypes as never);
    })();
  }
  return magPromise;
}

function toModulation(result: EmbeddingLikeResult, flavor: 'iq' | 'magnitude'): ModulationClassification {
  const c = result.classification;
  const candidates = Object.entries(c.posterior)
    .map(([label, confidence]) => ({ label, confidence }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);
  const top = Object.entries(result.leafLikelihood)
    .map(([label, probability]) => ({ label, probability }))
    .sort((a, b) => b.probability - a.probability)[0];
  return {
    flavor,
    modulation: result.modulation.modulation,
    family: c.label,
    confidence: c.confidence,
    isUnknown: c.isUnknown,
    posterior: c.posterior,
    candidates,
    bwFraction: result.bw,
    topLeaf: top && top.probability > 0.2 ? { label: top.label, probability: top.probability } : undefined,
    runtime: { model: 'magnitude-v2' },
  };
}

// ---------------------------------------------------------------------------
// Live v3 dual-fusion I/Q runtime
// ---------------------------------------------------------------------------

const TIME_DOMAIN_V3_PACKAGE_SCHEMA =
  'atomos.v3.time-domain-classifier.dual-runtime-package';
const TIME_DOMAIN_V3_CANDIDATE =
  'v3.4-q97-decoupled-8k-classifier-4k-rejector';
const TIME_DOMAIN_V3_RELEASE_MANIFEST_SHA256 =
  '6e6ff5d3015028b35d264bbc1addccbfcb1d1158d8056e36c354c5b2d74a30ce';
const TIME_DOMAIN_V3_PACKAGE_DIRECTORY = 'classifier/v3/';
const TIME_DOMAIN_V3_MANIFEST = 'runtime-package-manifest.json';
const TIME_DOMAIN_V3_MAX_ASSET_BYTES = 25 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const TIME_DOMAIN_V3_ASSETS = {
  binding: {
    filename: 'time-domain-v3-dual-binding.json',
    schema: 'atomos.v3.time-domain-dual-fusion.binding',
  },
  rejector: {
    filename: 'time-domain-v3-rejector-weights.json',
    schema: 'atomos.v3.time-domain-invariant-fusion.browser-weights',
    runtimeRole: 'known_unknown_rejector',
  },
  classifier: {
    filename: 'time-domain-v3-classifier-weights.json',
    schema: 'atomos.v3.time-domain-invariant-fusion.browser-weights',
    runtimeRole: 'accepted_known_classifier',
  },
  openset: {
    filename: 'time-domain-v3-openset-policy.json',
    schema: 'atomos.v3.time-domain-openset.staged',
  },
} as const;

type TimeDomainV3Admission = 'staging' | 'production';
type TimeDomainV3AssetKey = keyof typeof TIME_DOMAIN_V3_ASSETS;
type TimeDomainV3Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface TimeDomainV3AssetDescriptor {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface TimeDomainV3VerifiedRuntimeAssets {
  readonly bindingAsset: unknown;
  readonly rejectorAsset: unknown;
  readonly rejectorAssetSha256: string;
  readonly classifierAsset: unknown;
  readonly classifierAssetSha256: string;
  readonly opensetAsset: unknown;
  readonly opensetAssetSha256: string;
}

export interface IqModulationClassifier {
  classifyIq(
    re: Float64Array,
    im: Float64Array,
    bandwidthHz?: number,
  ): ModulationClassification;
}

interface TimeDomainDualDecisionLike {
  readonly outcome: 'noise' | 'unknown' | 'known';
  readonly knownLabel: string | null;
  readonly squaredPrototypeDistances: ArrayLike<number> | null;
  readonly forward: {
    readonly preprocess: { readonly context: { readonly bw: number } };
  } | null;
  readonly openSet: {
    readonly stagedScore: number;
    readonly threshold: number;
  };
}

interface TimeDomainDualClassifierLike {
  readonly classifierFusion: {
    readonly classification: { readonly classes: string[] };
  };
  classify(
    inPhase: ArrayLike<number>,
    quadrature: ArrayLike<number>,
  ): TimeDomainDualDecisionLike;
}

function conditionalPosterior(
  classes: readonly string[],
  squaredDistances: ArrayLike<number>,
): Record<string, number> {
  if (classes.length === 0) {
    throw new RangeError('the v3 classifier must expose at least one class');
  }
  if (squaredDistances.length !== classes.length) {
    throw new RangeError('v3 prototype distances do not match the class list');
  }
  // The model has no calibrated probability head. This conditional display
  // distribution is the monotone softmax of its actual decision metric
  // (-squared Euclidean distance, unit temperature); open-set admission remains
  // exclusively the fitted staged policy below.
  let maximum = Number.NEGATIVE_INFINITY;
  const logits = classes.map((_, index) => {
    const value = -squaredDistances[index]!;
    if (!Number.isFinite(value)) {
      throw new RangeError('v3 prototype distances must be finite');
    }
    maximum = Math.max(maximum, value);
    return value;
  });
  const exponentials = logits.map((value) => Math.exp(value - maximum));
  const normalizer = exponentials.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(
    classes.map((name, index) => [name, exponentials[index]! / normalizer]),
  );
}

function toTimeDomainV3Modulation(
  classifier: TimeDomainDualClassifierLike,
  decision: TimeDomainDualDecisionLike,
): ModulationClassification {
  if (decision.outcome !== 'known') {
    const stage = decision.outcome === 'noise' ? 1 : 2;
    return {
      flavor: 'iq',
      modulation: 'unknown',
      family: 'unknown',
      confidence: 0,
      isUnknown: true,
      candidates: [],
      // Stage 1 intentionally runs before the bandwidth-estimating frontend.
      // Use the conservative full-band value without doing downstream work.
      bwFraction: decision.forward?.preprocess.context.bw ?? 1,
      rejection: {
        stage,
        reason: stage === 1 ? 'noise' : 'open-set',
        score: decision.openSet.stagedScore,
        threshold: decision.openSet.threshold,
      },
      runtime: { model: 'time-domain-v3' },
    };
  }
  if (
    decision.knownLabel === null
    || decision.squaredPrototypeDistances === null
  ) {
    throw new Error('accepted v3 decision has no classifier result');
  }
  const posterior = conditionalPosterior(
    classifier.classifierFusion.classification.classes,
    decision.squaredPrototypeDistances,
  );
  const candidates = Object.entries(posterior)
    .map(([label, confidence]) => ({ label, confidence }))
    .sort((left, right) =>
      right.confidence - left.confidence || left.label.localeCompare(right.label))
    .slice(0, 4);
  const closedConfidence = posterior[decision.knownLabel];
  if (closedConfidence === undefined) {
    throw new Error('accepted v3 label is not in the classifier class list');
  }
  return {
    flavor: 'iq',
    modulation: decision.knownLabel,
    family: decision.knownLabel,
    confidence: closedConfidence,
    isUnknown: false,
    posterior,
    candidates,
    bwFraction: decision.forward!.preprocess.context.bw,
    runtime: { model: 'time-domain-v3' },
  };
}

/**
 * Build the dual runtime from JSON values whose exact source bytes were already
 * verified. Production is fail-closed; staging must be named explicitly.
 */
export async function createTimeDomainV3ModulationAdapter(
  assets: TimeDomainV3VerifiedRuntimeAssets,
  admission: TimeDomainV3Admission = 'production',
): Promise<IqModulationClassifier> {
  const module = await import(
    '../../../../../Atom-Classifier/src/embedding/time-domain-dual-fusion-classifier-v3.js'
  );
  const classifier = module.createTimeDomainDualFusionClassifierV3({
    bindingAsset: assets.bindingAsset,
    rejectorFusion: {
      asset: assets.rejectorAsset,
      preverifiedAssetSha256: assets.rejectorAssetSha256,
    },
    classifierFusion: {
      asset: assets.classifierAsset,
      preverifiedAssetSha256: assets.classifierAssetSha256,
    },
    opensetPolicy: {
      asset: assets.opensetAsset,
      preverifiedAssetSha256: assets.opensetAssetSha256,
    },
    admission,
  }) as unknown as TimeDomainDualClassifierLike;
  return {
    classifyIq: (re, im) =>
      toTimeDomainV3Modulation(classifier, classifier.classify(re, im)),
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExact(value: unknown, expected: unknown, path: string): void {
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

function validateTimeDomainV3Manifest(
  value: unknown,
  admission: TimeDomainV3Admission,
): Record<TimeDomainV3AssetKey, TimeDomainV3AssetDescriptor> {
  const manifest = record(value, 'runtime package manifest');
  const status = admission === 'production' ? 'release' : 'staging_not_release';
  requireExact(manifest.schema, TIME_DOMAIN_V3_PACKAGE_SCHEMA, 'manifest.schema');
  requireExact(manifest.schema_version, 1, 'manifest.schema_version');
  requireExact(manifest.status, status, 'manifest.status');
  requireExact(manifest.candidate_id, TIME_DOMAIN_V3_CANDIDATE, 'manifest.candidate_id');

  const architecture = record(manifest.architecture, 'manifest.architecture');
  requireExact(
    architecture.classifier_runs_only_after_rejector_acceptance,
    true,
    'manifest.architecture.classifier_runs_only_after_rejector_acceptance',
  );
  requireExact(
    architecture.public_known_label_from_classifier_only,
    true,
    'manifest.architecture.public_known_label_from_classifier_only',
  );
  const executionOrder = architecture.execution_order;
  const expectedOrder = [
    'stage_one_noise_gate',
    'rejector_known_unknown',
    'classifier_known_label',
  ];
  if (
    !Array.isArray(executionOrder)
    || executionOrder.length !== expectedOrder.length
    || executionOrder.some((entry, index) => entry !== expectedOrder[index])
  ) {
    throw new RangeError('manifest architecture has the wrong execution order');
  }

  const assets = record(manifest.assets, 'manifest.assets');
  const expectedFilenames = Object.values(TIME_DOMAIN_V3_ASSETS)
    .map(({ filename }) => filename)
    .sort();
  const actualFilenames = Object.keys(assets).sort();
  if (
    actualFilenames.length !== expectedFilenames.length
    || actualFilenames.some(
      (filename, index) => filename !== expectedFilenames[index],
    )
  ) {
    throw new RangeError(
      'manifest.assets must contain exactly the four deployable runtime assets',
    );
  }

  const descriptors = {} as Record<
    TimeDomainV3AssetKey,
    TimeDomainV3AssetDescriptor
  >;
  for (const [key, expected] of Object.entries(TIME_DOMAIN_V3_ASSETS) as [
    TimeDomainV3AssetKey,
    (typeof TIME_DOMAIN_V3_ASSETS)[TimeDomainV3AssetKey],
  ][]) {
    const descriptor = record(
      assets[expected.filename],
      `manifest.assets.${expected.filename}`,
    );
    requireExact(descriptor.path, expected.filename, `${expected.filename}.path`);
    requireExact(descriptor.schema, expected.schema, `${expected.filename}.schema`);
    requireExact(descriptor.schema_version, key === 'openset' ? 4 : 1, `${expected.filename}.schema_version`);
    requireExact(descriptor.status, status, `${expected.filename}.status`);
    if ('runtimeRole' in expected) {
      requireExact(
        descriptor.runtime_role,
        expected.runtimeRole,
        `${expected.filename}.runtime_role`,
      );
    }
    if (
      typeof descriptor.bytes !== 'number'
      || !Number.isSafeInteger(descriptor.bytes)
      || descriptor.bytes <= 0
      || descriptor.bytes >= TIME_DOMAIN_V3_MAX_ASSET_BYTES
    ) {
      throw new RangeError(
        `${expected.filename}.bytes must be a positive integer below 25 MiB`,
      );
    }
    descriptors[key] = {
      path: expected.filename,
      bytes: descriptor.bytes,
      sha256: requireSha256(
        descriptor.sha256,
        `${expected.filename}.sha256`,
      ),
    };
  }
  return descriptors;
}

async function responseBytes(
  fetcher: TimeDomainV3Fetch,
  url: URL,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetcher(url, {
    cache: 'no-cache',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`v3 runtime asset fetch failed (${response.status} ${url})`);
  }
  const statedLength = response.headers.get('content-length');
  if (statedLength !== null) {
    if (
      !/^(0|[1-9][0-9]*)$/.test(statedLength)
      || !Number.isSafeInteger(Number(statedLength))
    ) {
      throw new RangeError(`v3 runtime asset has an invalid byte length (${url})`);
    }
    if (Number(statedLength) > maximumBytes) {
      throw new RangeError(`v3 runtime asset exceeds its byte limit (${url})`);
    }
  }
  if (response.body === null) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maximumBytes) {
      throw new RangeError(`v3 runtime asset exceeds its byte limit (${url})`);
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
        throw new RangeError(`v3 runtime asset exceeds its byte limit (${url})`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(bytes: Uint8Array<ArrayBuffer>, path: string): unknown {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(`${path} is not valid UTF-8`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new TypeError(`${path} is not valid JSON`);
  }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto SHA-256 is unavailable');
  }
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function loadVerifiedJson(
  fetcher: TimeDomainV3Fetch,
  manifestUrl: URL,
  descriptor: TimeDomainV3AssetDescriptor,
): Promise<unknown> {
  const url = new URL(descriptor.path, manifestUrl);
  const bytes = await responseBytes(fetcher, url, descriptor.bytes);
  if (bytes.byteLength !== descriptor.bytes) {
    throw new RangeError(`${descriptor.path} byte length does not match its manifest`);
  }
  if (await sha256Hex(bytes) !== descriptor.sha256) {
    throw new RangeError(`${descriptor.path} SHA-256 does not match its manifest`);
  }
  // Hash and parse the same immutable response bytes: no second read is allowed.
  return parseJson(bytes, descriptor.path);
}

function defaultTimeDomainV3ManifestUrl(): URL {
  if (typeof globalThis.location?.href !== 'string') {
    throw new Error('the v3 runtime package URL is unavailable outside a browser');
  }
  const locationUrl = new URL(globalThis.location.href);
  if (locationUrl.protocol === 'file:') {
    return new URL(
      `atomizer-classifier://runtime/${TIME_DOMAIN_V3_MANIFEST}`,
    );
  }
  const publicRoot = new URL('/', locationUrl.origin);
  return new URL(
    `${TIME_DOMAIN_V3_PACKAGE_DIRECTORY}${TIME_DOMAIN_V3_MANIFEST}`,
    publicRoot,
  );
}

export interface TimeDomainV3RuntimePackageOptions {
  readonly manifestUrl?: string | URL;
  readonly admission?: TimeDomainV3Admission;
  readonly fetcher?: TimeDomainV3Fetch;
}

/**
 * Fetch, byte-verify, parse, and compose exactly the four deployable runtime
 * assets. Evidence paths in the manifest are intentionally neither resolved nor
 * fetched: they are release provenance, not browser dependencies.
 */
export async function loadTimeDomainV3ModulationAdapter(
  options: TimeDomainV3RuntimePackageOptions = {},
): Promise<IqModulationClassifier> {
  const admission = options.admission ?? 'production';
  let manifestUrl: URL;
  if (options.manifestUrl === undefined) {
    manifestUrl = defaultTimeDomainV3ManifestUrl();
  } else {
    try {
      manifestUrl = new URL(options.manifestUrl);
    } catch {
      manifestUrl = new URL(
        options.manifestUrl,
        defaultTimeDomainV3ManifestUrl(),
      );
    }
  }
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const manifestBytes = await responseBytes(fetcher, manifestUrl, 256 * 1024);
  if (
    admission === 'production'
    && await sha256Hex(manifestBytes)
      !== TIME_DOMAIN_V3_RELEASE_MANIFEST_SHA256
  ) {
    throw new RangeError(
      'production v3 runtime manifest SHA-256 does not match the sealed release',
    );
  }
  const descriptors = validateTimeDomainV3Manifest(
    parseJson(manifestBytes, TIME_DOMAIN_V3_MANIFEST),
    admission,
  );
  const [bindingAsset, rejectorAsset, classifierAsset, opensetAsset] =
    await Promise.all([
      loadVerifiedJson(fetcher, manifestUrl, descriptors.binding),
      loadVerifiedJson(fetcher, manifestUrl, descriptors.rejector),
      loadVerifiedJson(fetcher, manifestUrl, descriptors.classifier),
      loadVerifiedJson(fetcher, manifestUrl, descriptors.openset),
    ]);
  return createTimeDomainV3ModulationAdapter({
    bindingAsset,
    rejectorAsset,
    rejectorAssetSha256: descriptors.rejector.sha256,
    classifierAsset,
    classifierAssetSha256: descriptors.classifier.sha256,
    opensetAsset,
    opensetAssetSha256: descriptors.openset.sha256,
  }, admission);
}

let iqV3ProductionPromise: Promise<IqModulationClassifier> | undefined;

function timeDomainV3PrefixLength(sampleCount: number): number {
  if (sampleCount < 8_192) return 4_096;
  if (sampleCount < 16_384) return 8_192;
  if (sampleCount < 32_768) return 16_384;
  return 32_768;
}

async function loadTimeDomainV3ProductionAdapter(): Promise<IqModulationClassifier> {
  if (!iqV3ProductionPromise) {
    const attempt = loadTimeDomainV3ModulationAdapter();
    iqV3ProductionPromise = attempt;
    void attempt.catch(() => {
      if (iqV3ProductionPromise === attempt) {
        iqV3ProductionPromise = undefined;
      }
    });
  }
  return iqV3ProductionPromise;
}

/** I/Q flavor: dual-fusion v3 over raw complex baseband. */
export async function classifyIqModulation(
  re: Float64Array,
  im: Float64Array,
  bandwidthHz?: number,
  sampleRateHz?: number,
): Promise<ModulationClassification> {
  if (re.length !== im.length) {
    throw new RangeError('I/Q classification requires parallel sample arrays');
  }
  const classifier = await loadTimeDomainV3ProductionAdapter();
  const v3Length = timeDomainV3PrefixLength(re.length);
  const admitted = classifier.classifyIq(
    re.length === v3Length ? re : re.subarray(0, v3Length),
    im.length === v3Length ? im : im.subarray(0, v3Length),
    bandwidthHz,
  );
  const dwell = selectDacsV7Dwell(re.length);
  if (
    admitted.isUnknown
    || dwell === undefined
    || sampleRateHz === undefined
    || !isDacsV7SampleRate(sampleRateHz)
  ) {
    return admitted;
  }
  const { classifyDacsV7 } = await import('./dacs-v7-runtime.js');
  const refined = await classifyDacsV7(re, im, dwell);
  return {
    ...admitted,
    modulation: refined.family,
    family: refined.family,
    confidence: refined.confidence,
    posterior: refined.posterior,
    candidates: refined.candidates,
    topLeaf: undefined,
    runtime: {
      model: 'dacs-v7',
      openSetGate: 'time-domain-v3',
      dwell: refined.dwell,
      dwellSamples: refined.dwellSamples,
      executionProvider: refined.executionProvider,
      confidenceLogit: refined.confidenceLogit,
    },
  };
}

/**
 * Magnitude flavor: a swept power spectrum from a scalar analyzer (tinySA).
 * `powerDbm`/`frequencyHz` are the parallel sweep arrays; `centerHz`/`bandwidthHz`
 * are the occupied band of the signal to classify (e.g. a detected signal).
 */
export async function classifyScalarSweep(
  powerDbm: readonly number[],
  frequencyHz: readonly number[],
  centerHz: number,
  bandwidthHz: number,
): Promise<ModulationClassification | undefined> {
  const n = powerDbm.length;
  if (n < 8 || frequencyHz.length !== n) return undefined;
  const startHz = frequencyHz[0]!;
  const span = frequencyHz[n - 1]! - startHz;
  if (span <= 0) return undefined;
  const psd = new Float64Array(n);
  for (let k = 0; k < n; k++) psd[k] = 10 ** (powerDbm[k]! / 10); // dBm -> linear
  const center = (centerHz - startHz) / span - 0.5; // fftshift-convention fraction
  const bw = Math.max(bandwidthHz / span, 1 / n);
  const classifier = await loadMagnitudeClassifier();
  return toModulation(classifier.classifyPsd(psd, center, bw, { bandwidthHz }), 'magnitude');
}
