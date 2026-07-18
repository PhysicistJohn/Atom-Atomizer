import type { BayesianClassificationEngine } from './bayesian-classifier-runtime.js';

/**
 * Model-free source fallback. The renderer build replaces this module with an
 * admitted classifier provider only when both generated model assets exist.
 */
export function createBundledBayesianClassifier(): BayesianClassificationEngine {
  throw new Error('Bayesian classifier model assets are not bundled');
}

/** Vite replaces this only when the complete generated model pair exists. */
export function createBundledBayesianClassificationWorker(): Worker {
  throw new Error('Bayesian classifier worker assets are not bundled');
}
