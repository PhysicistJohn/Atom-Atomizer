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
  /** Top posterior candidates (family distribution). */
  candidates: readonly { label: string; confidence: number }[];
  /** Measured occupied fractional bandwidth. */
  bwFraction: number;
  /** Strongest fused protocol leaf, when the fusion concentrates. */
  topLeaf?: { label: string; probability: number };
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
