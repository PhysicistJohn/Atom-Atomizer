import { describe, expect, it } from 'vitest';
import {
  classifyIqModulationV3Staging,
  createTimeDomainV3ModulationAdapter,
} from './embedding-classifier-runtime.js';

interface SmokeRow {
  name: string;
  decision_label: string;
  rejected_stage: 1 | 2 | null;
  iq: { in_phase: number[]; quadrature: number[] };
}

function unwrapJson(value: unknown): unknown {
  const module = value as { default?: unknown };
  return module.default ?? value;
}

const [smokeModule, classifierModule, opensetModule, encoderModule] =
  await Promise.all([
    import(
      '../../../../../Atom-Classifier/src/embedding/assets-v3-staging/time-domain-openset-smoke-v1.json'
    ),
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
const smoke = unwrapJson(smokeModule) as { rows: SmokeRow[] };

function row(name: string): SmokeRow {
  const found = smoke.rows.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing v3 smoke row ${name}`);
  return found;
}

async function classify(name: string) {
  const fixture = row(name);
  return classifyIqModulationV3Staging(
    Float64Array.from(fixture.iq.in_phase),
    Float64Array.from(fixture.iq.quadrature),
  );
}

describe('Atomizer v3 time-domain adapter', () => {
  it('runs a real accepted raw-IQ capture through all v3 stages', async () => {
    const result = await classify('known-am-N4096');
    expect(result).toMatchObject({
      flavor: 'iq',
      family: 'am',
      modulation: 'am',
      isUnknown: false,
    });
    expect(result.rejection).toBeUndefined();
    expect(result.candidates[0]?.label).toBe('am');
    expect(result.bwFraction).toBeGreaterThan(0);
    expect(result.bwFraction).toBeLessThanOrEqual(1);
    const posteriorMass = Object.values(result.posterior ?? {})
      .reduce((sum, value) => sum + value, 0);
    expect(posteriorMass).toBeCloseTo(1, 12);
  });

  it('maps the pre-classification noise gate to candid unknown', async () => {
    const result = await classify('noise-4-N4096');
    expect(result).toMatchObject({
      family: 'unknown',
      modulation: 'unknown',
      isUnknown: true,
      bwFraction: 1,
      rejection: {
        stage: 1,
        reason: 'noise',
      },
    });
    expect(result.rejection!.score).toBeGreaterThan(
      result.rejection!.threshold,
    );
  });

  it('preserves a stage-2 abstention and its conditional family candidates', async () => {
    const result = await classify('noise-1-N4096');
    expect(result).toMatchObject({
      family: 'unknown',
      modulation: 'unknown',
      isUnknown: true,
      rejection: {
        stage: 2,
        reason: 'open-set',
      },
    });
    expect(result.rejection!.score).toBeGreaterThan(
      result.rejection!.threshold,
    );
    expect(result.candidates).toHaveLength(4);
    expect(result.posterior).toBeDefined();
  });

  it('keeps production admission fail-closed on the tracked staging package', async () => {
    await expect(createTimeDomainV3ModulationAdapter({
      classifierAsset: unwrapJson(classifierModule),
      opensetAsset: unwrapJson(opensetModule),
      encoderAsset: unwrapJson(encoderModule),
    })).rejects.toThrow(/must be release for production admission/);
  });
});
