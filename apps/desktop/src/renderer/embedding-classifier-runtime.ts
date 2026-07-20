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
 */

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
