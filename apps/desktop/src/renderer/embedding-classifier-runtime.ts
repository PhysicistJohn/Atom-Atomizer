/**
 * Renderer-side runtime for the browser-native metric-embedding classifier
 * (Atom-Classifier `src/embedding`). Zero runtime dependencies, committed JSON
 * assets, so it works identically on desktop and web — and it fully replaces the
 * Bayesian classifier.
 *
 * Two flavors, one corpus, same 7 classes:
 *   - I/Q (complex baseband, SDR/SignalLab): `classifyIqModulation`.
 *   - magnitude (scalar power spectrum, tinySA): `classifyScalarSweep`.
 * The ~0.8 MB weight blobs are dynamic-imported so they stay out of the initial
 * bundle and load only when the Detect panel first needs them.
 *
 * Also re-exports the blind symbol-recovery front-end (`recoverIqConstellation`)
 * — a zero-dependency DSP (CMA equalizer + carrier lock) that turns raw I/Q into
 * a recovered symbol constellation, so the I/Q view can show distinguishable
 * symbols instead of a pre-equalization smear.
 */

import { recoverConstellation } from '../../../../../Atom-Classifier/src/embedding/recover.js';

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
  /** The embedding's modulation-family label (or 'unknown'). */
  family: string;
  confidence: number;
  isUnknown: boolean;
  /** Complete family posterior retained for temporal integration. */
  readonly posterior?: Readonly<Record<string, number>>;
  /** Top posterior candidates (family distribution). */
  candidates: readonly { label: string; confidence: number }[];
  /** Measured occupied fractional bandwidth. */
  bwFraction: number;
  /** Strongest fused protocol leaf, when the fusion concentrates. */
  topLeaf?: { label: string; probability: number };
  /** Present for v3 staged abstention; omitted for the live v2 classifier. */
  rejection?: {
    /** Stage 1 short-circuited as noise; stage 2 rejected a classified row. */
    readonly stage: 1 | 2;
    readonly reason: 'noise' | 'open-set';
    readonly score: number;
    readonly threshold: number;
  };
}

interface IqClassifierLike {
  classifyIq(re: Float64Array, im: Float64Array, opts?: { bandwidthHz?: number }): EmbeddingLikeResult;
}
interface MagnitudeClassifierLike {
  classifyPsd(psd: Float64Array, center: number, bw: number, opts?: { bandwidthHz?: number }): EmbeddingLikeResult;
}

let iqPromise: Promise<IqClassifierLike> | undefined;
let magPromise: Promise<MagnitudeClassifierLike> | undefined;

async function loadIqClassifier(): Promise<IqClassifierLike> {
  if (!iqPromise) {
    iqPromise = (async () => {
      const [mod, weights, protos] = await Promise.all([
        import('../../../../../Atom-Classifier/src/embedding/index.js'),
        import('../../../../../Atom-Classifier/src/embedding/assets/embedding-weights.json'),
        import('../../../../../Atom-Classifier/src/embedding/assets/prototypes.json'),
      ]);
      const model = (weights as { default?: unknown }).default ?? weights;
      const prototypes = (protos as { default?: unknown }).default ?? protos;
      return new mod.EmbeddingWaveformClassifier(model as never, prototypes as never);
    })();
  }
  return iqPromise;
}

async function loadMagnitudeClassifier(): Promise<MagnitudeClassifierLike> {
  if (!magPromise) {
    magPromise = (async () => {
      const [mod, weights, protos] = await Promise.all([
        import('../../../../../Atom-Classifier/src/embedding/index.js'),
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
  };
}

/** I/Q flavor: complex baseband from an SDR / SignalLab. */
export async function classifyIqModulation(
  re: Float64Array,
  im: Float64Array,
  bandwidthHz?: number,
): Promise<ModulationClassification> {
  const classifier = await loadIqClassifier();
  return toModulation(classifier.classifyIq(re, im, bandwidthHz ? { bandwidthHz } : {}), 'iq');
}

// ---------------------------------------------------------------------------
// Opt-in v3 time-domain adapter
// ---------------------------------------------------------------------------

export interface TimeDomainV3RuntimeAssets {
  readonly classifierAsset: unknown;
  readonly opensetAsset: unknown;
  readonly encoderAsset: unknown;
}

export interface IqModulationClassifier {
  classifyIq(
    re: Float64Array,
    im: Float64Array,
    bandwidthHz?: number,
  ): ModulationClassification;
}

interface TimeDomainDecisionLike {
  readonly closedLabel: string | null;
  readonly squaredPrototypeDistances: ArrayLike<number> | null;
  readonly rejectedStage: 1 | 2 | null;
  readonly forward: {
    readonly preprocess: { readonly context: { readonly bw: number } };
  } | null;
  readonly openSet: {
    readonly stagedScore: number;
    readonly threshold: number;
  };
}

interface TimeDomainClassifierLike {
  readonly asset: { readonly classification: { readonly classes: string[] } };
  classify(
    inPhase: ArrayLike<number>,
    quadrature: ArrayLike<number>,
  ): TimeDomainDecisionLike;
}

function conditionalPosterior(
  classes: readonly string[],
  squaredDistances: ArrayLike<number> | null,
): Record<string, number> {
  if (classes.length === 0) {
    throw new RangeError('the v3 classifier must expose at least one class');
  }
  if (squaredDistances === null) {
    const uniform = 1 / classes.length;
    return Object.fromEntries(classes.map((name) => [name, uniform]));
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
  classifier: TimeDomainClassifierLike,
  decision: TimeDomainDecisionLike,
): ModulationClassification {
  const posterior = conditionalPosterior(
    classifier.asset.classification.classes,
    decision.squaredPrototypeDistances,
  );
  const candidates = Object.entries(posterior)
    .map(([label, confidence]) => ({ label, confidence }))
    .sort((left, right) =>
      right.confidence - left.confidence || left.label.localeCompare(right.label))
    .slice(0, 4);
  const isUnknown = decision.rejectedStage !== null;
  const closedConfidence = decision.closedLabel === null
    ? candidates[0]!.confidence
    : posterior[decision.closedLabel]!;
  return {
    flavor: 'iq',
    modulation: isUnknown ? 'unknown' : decision.closedLabel!,
    family: isUnknown ? 'unknown' : decision.closedLabel!,
    confidence: closedConfidence,
    isUnknown,
    posterior,
    candidates,
    // Stage 1 intentionally runs before the bandwidth-estimating frontend.
    // Use the conservative full-band value instead of doing forbidden
    // downstream work for a gated capture.
    bwFraction: decision.forward?.preprocess.context.bw ?? 1,
    rejection: decision.rejectedStage === null ? undefined : {
      stage: decision.rejectedStage,
      reason: decision.rejectedStage === 1 ? 'noise' : 'open-set',
      score: decision.openSet.stagedScore,
      threshold: decision.openSet.threshold,
    },
  };
}

/**
 * Build the v3 adapter from an explicit, coherent asset set. Production is the
 * fail-closed default: staging JSON is accepted only when the caller names the
 * staging channel. This factory does not change Atomizer's live v2 selection.
 */
export async function createTimeDomainV3ModulationAdapter(
  assets: TimeDomainV3RuntimeAssets,
  admission: 'staging' | 'production' = 'production',
): Promise<IqModulationClassifier> {
  const module = await import(
    '../../../../../Atom-Classifier/src/embedding/index.js'
  );
  const classifier = await module.createTimeDomainClassifierV3({
    ...assets,
    admission,
  }) as unknown as TimeDomainClassifierLike;
  return {
    classifyIq: (re, im) =>
      toTimeDomainV3Modulation(classifier, classifier.classify(re, im)),
  };
}

let iqV3StagingPromise: Promise<IqModulationClassifier> | undefined;

async function loadTimeDomainV3StagingAdapter(): Promise<IqModulationClassifier> {
  if (!iqV3StagingPromise) {
    iqV3StagingPromise = (async () => {
      const [classifier, openset, encoder] = await Promise.all([
        import(
          '../../../../../Atom-Classifier/src/embedding/assets-v3-staging/time-domain-classifier-weights-v1.json'
        ),
        import(
          '../../../../../Atom-Classifier/src/embedding/assets-v3-staging/time-domain-openset-weights-v1.json'
        ),
        import(
          '../../../../../Atom-Classifier/src/embedding/assets-v3-staging/time-domain-fusion-weights-v3.json'
        ),
      ]);
      return createTimeDomainV3ModulationAdapter({
        classifierAsset: (classifier as { default?: unknown }).default ?? classifier,
        opensetAsset: (openset as { default?: unknown }).default ?? openset,
        encoderAsset: (encoder as { default?: unknown }).default ?? encoder,
      }, 'staging');
    })();
  }
  return iqV3StagingPromise;
}

/**
 * Explicit development entry point for the tracked candidate. Kept separate
 * from `classifyIqModulation`, so landing the adapter cannot promote v3 or
 * change the live worker path.
 */
export async function classifyIqModulationV3Staging(
  re: Float64Array,
  im: Float64Array,
  bandwidthHz?: number,
): Promise<ModulationClassification> {
  const classifier = await loadTimeDomainV3StagingAdapter();
  return classifier.classifyIq(re, im, bandwidthHz);
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
