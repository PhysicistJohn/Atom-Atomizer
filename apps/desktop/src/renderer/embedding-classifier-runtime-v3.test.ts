/// <reference types="node" />

import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadTimeDomainV3ModulationAdapter,
  type IqModulationClassifier,
} from './embedding-classifier-runtime.js';

interface ParityRow {
  readonly name: string;
  readonly decision_label: string;
  readonly rejected_stage: 1 | 2 | null;
  readonly iq: {
    readonly in_phase: number[];
    readonly quadrature: number[];
  };
}

interface StagingPackageManifest {
  readonly external_evidence: {
    readonly parity: { readonly path: string };
  };
}

const packageRoot = new URL(
  '../../../../../Atom-Classifier/src/embedding/assets-v3-dual-staging/',
  import.meta.url,
);
const releasePackageRoot = new URL(
  '../../../../../Atom-Classifier/src/embedding/assets-v3-release/',
  import.meta.url,
);
const packageManifestUrl = new URL(
  'runtime-package-manifest.json',
  packageRoot,
);
const packageManifest = JSON.parse(
  await readFile(packageManifestUrl, 'utf8'),
) as StagingPackageManifest;
const parity = JSON.parse(
  await readFile(
    new URL(packageManifest.external_evidence.parity.path, packageRoot),
    'utf8',
  ),
) as { readonly rows: readonly ParityRow[] };

const remoteManifestUrl = new URL(
  'https://fixture.invalid/classifier/v3/runtime-package-manifest.json',
);

function row(predicate: (candidate: ParityRow) => boolean): ParityRow {
  const found = parity.rows.find(predicate);
  if (!found) throw new Error('missing matching dual-runtime parity row');
  return found;
}

const knownRow = row(
  (candidate) =>
    candidate.name.startsWith('known-')
    && candidate.rejected_stage === null,
);
const stageOneRow = row((candidate) => candidate.rejected_stage === 1);
const stageTwoRow = row((candidate) => candidate.rejected_stage === 2);

function responseBody(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function packageFetch(
  root: URL,
  requested: string[],
  transform?: (filename: string, bytes: Uint8Array) => Uint8Array,
): typeof fetch {
  return async (input) => {
    const requestUrl = input instanceof Request
      ? new URL(input.url)
      : new URL(input.toString());
    const filename = requestUrl.pathname.split('/').at(-1)!;
    requested.push(filename);
    const allowed = new Set([
      'runtime-package-manifest.json',
      'time-domain-v3-dual-binding.json',
      'time-domain-v3-rejector-weights.json',
      'time-domain-v3-classifier-weights.json',
      'time-domain-v3-openset-policy.json',
    ]);
    if (!allowed.has(filename)) {
      return new Response('not found', { status: 404 });
    }
    const bytes = Uint8Array.from(await readFile(new URL(filename, root)));
    const body = transform?.(filename, bytes) ?? bytes;
    return new Response(responseBody(body), { status: 200 });
  };
}

function classify(
  classifier: IqModulationClassifier,
  fixture: ParityRow,
) {
  return classifier.classifyIq(
    Float64Array.from(fixture.iq.in_phase),
    Float64Array.from(fixture.iq.quadrature),
    undefined,
    'historical',
  );
}

describe('Atomizer v3 dual-fusion runtime package', () => {
  const requested: string[] = [];
  let classifier: IqModulationClassifier;

  beforeAll(async () => {
    classifier = await loadTimeDomainV3ModulationAdapter({
      admission: 'staging',
      manifestUrl: remoteManifestUrl,
      fetcher: packageFetch(packageRoot, requested),
    });
  });

  it('fetches only the manifest and its four deployable top-level assets', () => {
    expect([...requested].sort()).toEqual([
      'runtime-package-manifest.json',
      'time-domain-v3-classifier-weights.json',
      'time-domain-v3-dual-binding.json',
      'time-domain-v3-openset-policy.json',
      'time-domain-v3-rejector-weights.json',
    ].sort());
    expect(requested).not.toContain(
      packageManifest.external_evidence.parity.path.split('/').at(-1),
    );
  });

  it('uses the accepted-only classifier label and conditional display distribution', () => {
    const result = classify(classifier, knownRow);
    expect(result).toMatchObject({
      flavor: 'iq',
      family: knownRow.decision_label,
      modulation: knownRow.decision_label,
      isUnknown: false,
    });
    expect(result.rejection).toBeUndefined();
    expect(result.candidates[0]?.label).toBe(knownRow.decision_label);
    expect(result.bwFraction).toBeGreaterThan(0);
    expect(result.bwFraction).toBeLessThanOrEqual(1);
    const posteriorMass = Object.values(result.posterior ?? {})
      .reduce((sum, value) => sum + value, 0);
    expect(posteriorMass).toBeCloseTo(1, 12);
  });

  it('loads the exact promoted package through production admission', async () => {
    const productionRequests: string[] = [];
    const production = await loadTimeDomainV3ModulationAdapter({
      manifestUrl: remoteManifestUrl,
      fetcher: packageFetch(releasePackageRoot, productionRequests),
    });

    expect([...productionRequests].sort()).toEqual([
      'runtime-package-manifest.json',
      'time-domain-v3-classifier-weights.json',
      'time-domain-v3-dual-binding.json',
      'time-domain-v3-openset-policy.json',
      'time-domain-v3-rejector-weights.json',
    ].sort());
    expect(classify(production, knownRow)).toMatchObject({
      flavor: 'iq',
      family: knownRow.decision_label,
      modulation: knownRow.decision_label,
      isUnknown: false,
    });
  });

  it('maps the raw-IQ stage-1 noise gate without exposing classifier output', () => {
    const result = classify(classifier, stageOneRow);
    expect(result).toMatchObject({
      family: 'unknown',
      modulation: 'unknown',
      confidence: 0,
      isUnknown: true,
      candidates: [],
      bwFraction: 1,
      rejection: {
        stage: 1,
        reason: 'noise',
      },
    });
    expect(result.posterior).toBeUndefined();
    if (result.rejection?.stage !== 1) {
      throw new Error('fixture did not produce the expected stage-1 rejection');
    }
    expect(result.rejection.score).toBeGreaterThan(
      result.rejection.threshold,
    );
  });

  it('maps the 4k rejector abstention without running or exposing the 8k classifier', () => {
    const result = classify(classifier, stageTwoRow);
    expect(result).toMatchObject({
      family: 'unknown',
      modulation: 'unknown',
      confidence: 0,
      isUnknown: true,
      candidates: [],
      rejection: {
        stage: 2,
        reason: 'open-set',
      },
    });
    expect(result.posterior).toBeUndefined();
    if (result.rejection?.stage !== 2) {
      throw new Error('fixture did not produce the expected stage-2 rejection');
    }
    expect(result.rejection.score).toBeGreaterThan(
      result.rejection.threshold,
    );
  });

  it('keeps production admission fail-closed on the staging package', async () => {
    const productionRequests: string[] = [];
    await expect(loadTimeDomainV3ModulationAdapter({
      manifestUrl: remoteManifestUrl,
      fetcher: packageFetch(packageRoot, productionRequests),
    })).rejects.toThrow(/manifest SHA-256.*sealed release/);
    expect(productionRequests).toEqual(['runtime-package-manifest.json']);
  });

  it('rejects changed asset bytes before parsing them', async () => {
    const tamperRequests: string[] = [];
    const fetcher = packageFetch(
      packageRoot,
      tamperRequests,
      (filename, original) => {
        if (filename !== 'time-domain-v3-dual-binding.json') return original;
        const changed = Uint8Array.from(original);
        changed[0] = changed[0]! ^ 0xff;
        return changed;
      },
    );
    await expect(loadTimeDomainV3ModulationAdapter({
      admission: 'staging',
      manifestUrl: remoteManifestUrl,
      fetcher,
    })).rejects.toThrow(/SHA-256 does not match/);
  });

  it('rejects a manifest that weakens the dual execution contract', async () => {
    const architectureRequests: string[] = [];
    const fetcher = packageFetch(
      packageRoot,
      architectureRequests,
      (filename, original) => {
        if (filename !== 'runtime-package-manifest.json') return original;
        const manifest = JSON.parse(new TextDecoder().decode(original)) as {
          architecture: {
            classifier_runs_only_after_rejector_acceptance: boolean;
          };
        };
        manifest.architecture.classifier_runs_only_after_rejector_acceptance =
          false;
        return new TextEncoder().encode(JSON.stringify(manifest));
      },
    );
    await expect(loadTimeDomainV3ModulationAdapter({
      admission: 'staging',
      manifestUrl: remoteManifestUrl,
      fetcher,
    })).rejects.toThrow(/classifier_runs_only_after_rejector_acceptance/);
    expect(architectureRequests).toEqual(['runtime-package-manifest.json']);
  });

  it('can retry an explicit legacy-package audit after a transient fetch failure', async () => {
    const retryRequests: string[] = [];
    const releaseFetch = packageFetch(releasePackageRoot, retryRequests);
    let failFirstManifest = true;
    const retryFetch = (async (input, init) => {
      const requestedUrl = input instanceof Request
        ? new URL(input.url)
        : new URL(input.toString());
      if (
        failFirstManifest
        && requestedUrl.pathname.endsWith('/runtime-package-manifest.json')
      ) {
        failFirstManifest = false;
        retryRequests.push('runtime-package-manifest.json');
        return new Response('temporarily unavailable', { status: 503 });
      }
      return releaseFetch(input, init);
    }) satisfies typeof fetch;
    await expect(loadTimeDomainV3ModulationAdapter({
      manifestUrl: remoteManifestUrl,
      fetcher: retryFetch,
    })).rejects.toThrow(/fetch failed.*503/);

    const production = await loadTimeDomainV3ModulationAdapter({
      manifestUrl: remoteManifestUrl,
      fetcher: retryFetch,
    });
    expect(classify(production, knownRow)).toMatchObject({
      family: knownRow.decision_label,
      isUnknown: false,
    });
    expect(
      retryRequests.filter(
        (filename) => filename === 'runtime-package-manifest.json',
      ),
    ).toHaveLength(2);
  });
});
