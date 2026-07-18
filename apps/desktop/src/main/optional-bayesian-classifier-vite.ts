import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROVIDER_PATH = fileURLToPath(new URL(
  '../renderer/bayesian-classifier-provider.ts',
  import.meta.url,
));
const CLASSIFIER_PATH = fileURLToPath(new URL(
  '../../../../../AtomOS_Classifier/src/signal-lab-classifier.ts',
  import.meta.url,
));
const MODEL_PATH = fileURLToPath(new URL(
  '../../../../../AtomOS_Classifier/src/models/bayesian-observable.generated.ts',
  import.meta.url,
));
const MANIFEST_PATH = fileURLToPath(new URL(
  '../../../../../AtomOS_Classifier/src/models/bayesian-observable.manifest.generated.ts',
  import.meta.url,
));

export interface OptionalBayesianClassifierViteOptions {
  readonly forceUnavailable?: boolean;
  readonly fileExists?: (path: string) => boolean;
}

/**
 * Keep the generated likelihood pair outside the renderer's mandatory module
 * graph. Vite receives a real classifier provider only when the complete pair
 * is present; otherwise the checked-in model-free provider remains in place.
 */
export function createOptionalBayesianClassifierVitePlugin(
  options: OptionalBayesianClassifierViteOptions = {},
) {
  const fileExists = options.fileExists ?? existsSync;
  const assetsAvailable = !options.forceUnavailable
    && fileExists(CLASSIFIER_PATH)
    && fileExists(MODEL_PATH)
    && fileExists(MANIFEST_PATH);
  return {
    name: 'atomizer-optional-bayesian-classifier',
    enforce: 'pre' as const,
    transform(_source: string, id: string) {
      if (stripViteQuery(id) !== PROVIDER_PATH) return null;
      return {
        code: optionalBayesianClassifierProviderSource(
          assetsAvailable,
          CLASSIFIER_PATH,
        ),
        map: null,
      };
    },
  };
}

export function optionalBayesianClassifierProviderSource(
  assetsAvailable: boolean,
  classifierPath = CLASSIFIER_PATH,
): string {
  if (!assetsAvailable) {
    return [
      'export function createBundledBayesianClassifier() {',
      "  throw new Error('Bayesian classifier model assets are not bundled');",
      '}',
    ].join('\n');
  }
  return [
    `import { SignalLabBayesianClassifier } from ${JSON.stringify(classifierPath)};`,
    'export function createBundledBayesianClassifier() {',
    '  return new SignalLabBayesianClassifier();',
    '}',
  ].join('\n');
}

function stripViteQuery(id: string): string {
  return id.split('?', 1)[0]!;
}
