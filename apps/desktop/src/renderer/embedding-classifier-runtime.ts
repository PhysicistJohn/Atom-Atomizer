/**
 * Renderer-side runtime for the browser-native metric-embedding modulation
 * classifier (Atom-Classifier `src/embedding`). Unlike the Bayesian classifier —
 * which is gated behind a build-time Vite plugin and is unavailable on the web
 * target — this module is zero-runtime-dependency with committed JSON assets, so
 * it works identically on desktop and web. The ~0.8 MB weight blob is
 * dynamic-imported so it stays out of the initial bundle and loads only when the
 * I/Q workspace first has a capture to classify.
 */

import type { EmbeddingResult } from '../../../../../Atom-Classifier/src/embedding/index.js';

/** Compact, prop-safe result surfaced to the I/Q workspace. */
export interface ModulationClassification {
  /** Refined modulation (a resolved order when available, else family). */
  modulation: string;
  /** The embedding's modulation-family label (or 'unknown'). */
  family: string;
  confidence: number;
  isUnknown: boolean;
  /** Top posterior candidates (family distribution). */
  candidates: readonly { label: string; confidence: number }[];
  /** Measured occupied fractional bandwidth (cycles/sample) from detection. */
  bwFraction: number;
  /** Strongest fused protocol leaf, when the fusion concentrates. */
  topLeaf?: { label: string; probability: number };
}

interface EmbeddingClassifierLike {
  classifyIq(re: Float64Array, im: Float64Array, opts?: { bandwidthHz?: number }): EmbeddingResult;
}

let classifierPromise: Promise<EmbeddingClassifierLike> | undefined;

async function loadClassifier(): Promise<EmbeddingClassifierLike> {
  if (!classifierPromise) {
    classifierPromise = (async () => {
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
  return classifierPromise;
}

export async function classifyIqModulation(
  re: Float64Array,
  im: Float64Array,
  bandwidthHz?: number,
): Promise<ModulationClassification> {
  const classifier = await loadClassifier();
  const result = classifier.classifyIq(re, im, bandwidthHz ? { bandwidthHz } : {});
  const c = result.classification;
  const candidates = Object.entries(c.posterior)
    .map(([label, confidence]) => ({ label, confidence }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4);
  const leaves = Object.entries(result.leafLikelihood)
    .map(([label, probability]) => ({ label, probability }))
    .sort((a, b) => b.probability - a.probability);
  const top = leaves[0];
  return {
    modulation: result.modulation.modulation,
    family: c.label,
    confidence: c.confidence,
    isUnknown: c.isUnknown,
    candidates,
    bwFraction: result.bw,
    topLeaf: top && top.probability > 0.2 ? { label: top.label, probability: top.probability } : undefined,
  };
}
