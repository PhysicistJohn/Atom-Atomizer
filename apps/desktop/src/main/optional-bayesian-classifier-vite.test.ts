import { describe, expect, it } from 'vitest';
import {
  createOptionalBayesianClassifierVitePlugin,
  optionalBayesianClassifierProviderSource,
} from './optional-bayesian-classifier-vite.js';

describe('optional Bayesian classifier Vite boundary', () => {
  it('emits a model-free unavailable provider when either generated asset is absent', () => {
    const source = optionalBayesianClassifierProviderSource(false, '/classifier.ts');

    expect(source).toContain('Bayesian classifier model assets are not bundled');
    expect(source).not.toContain('/classifier.ts');
    expect(source).not.toContain('SignalLabBayesianClassifier');
  });

  it('imports the classifier only when the complete generated pair is present', () => {
    const source = optionalBayesianClassifierProviderSource(true, '/classifier.ts');

    expect(source).toContain("from \"/classifier.ts\"");
    expect(source).toContain('new SignalLabBayesianClassifier()');
  });

  it('keeps the provider model-free when one member of the generated pair is missing', () => {
    let existenceChecks = 0;
    const plugin = createOptionalBayesianClassifierVitePlugin({
      fileExists: () => ++existenceChecks < 3,
    });
    const transform = plugin.transform as (
      source: string,
      id: string,
    ) => { code: string; map: null } | null;
    const providerPath = new URL(
      '../renderer/bayesian-classifier-provider.ts',
      import.meta.url,
    ).pathname;

    expect(transform('', providerPath)?.code).toContain('model assets are not bundled');
    expect(existenceChecks).toBe(3);
  });

  it('can force the unavailable build path without reading or mutating model files', () => {
    const fileExists = () => true;
    const plugin = createOptionalBayesianClassifierVitePlugin({
      forceUnavailable: true,
      fileExists,
    });
    const transform = plugin.transform as (
      source: string,
      id: string,
    ) => { code: string; map: null } | null;

    expect(transform('', '/unrelated.ts')).toBeNull();
    const provider = transform('', new URL(
      '../renderer/bayesian-classifier-provider.ts?import',
      import.meta.url,
    ).pathname);
    expect(provider?.code).toContain('model assets are not bundled');
    expect(provider?.code).not.toContain('SignalLabBayesianClassifier');
  });
});
