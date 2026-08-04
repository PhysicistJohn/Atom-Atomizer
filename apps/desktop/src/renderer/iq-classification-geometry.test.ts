import { describe, expect, it } from 'vitest';
import { classifyIqModulation } from './embedding-classifier-runtime.js';
import {
  admitIqGeometryForPrototypeSource,
  admitTrustedIqGeometryContext,
  TRUSTED_IQ_GEOMETRY_CONTEXT_KIND,
} from './iq-classification-geometry.js';

describe('trusted I/Q classifier geometry', () => {
  it.each([
    {
      name: 'native-rate',
      sampleRateHz: 122_880_000,
      nativeSampleRateHz: 122_880_000,
    },
    {
      name: 'scaled output-rate',
      sampleRateHz: 61_440_000,
      nativeSampleRateHz: 122_880_000,
    },
  ])('admits $name geometry without a profile or class feature', ({
    sampleRateHz,
    nativeSampleRateHz,
  }) => {
    const admitted = admitTrustedIqGeometryContext({
      kind: TRUSTED_IQ_GEOMETRY_CONTEXT_KIND,
      sampleRateHz,
      nativeSampleRateHz,
    });

    expect(admitted).toEqual({
      kind: TRUSTED_IQ_GEOMETRY_CONTEXT_KIND,
      sampleRateHz,
      nativeSampleRateHz,
    });
    expect(Object.keys(admitted).sort()).toEqual([
      'kind',
      'nativeSampleRateHz',
      'sampleRateHz',
    ]);
  });

  it('fails closed when the current route has no native geometry', () => {
    expect(() =>
      admitIqGeometryForPrototypeSource('current', undefined)
    ).toThrow(/current.*requires trusted native sample-rate geometry/i);
    expect(
      admitIqGeometryForPrototypeSource('historical', undefined),
    ).toBeUndefined();
  });

  it('fails at the classifier adapter before loading a current classifier without geometry', async () => {
    await expect(
      classifyIqModulation(
        new Float64Array(4_096),
        new Float64Array(4_096),
        20_000_000,
        20_000_000,
        'current',
      ),
    ).rejects.toThrow(
      /current.*requires trusted native sample-rate geometry/i,
    );
  });

  it.each([
    { profileId: 'wifi-hr-dsss-11m' },
    { className: 'dsss' },
  ])('rejects classifier label hints in the geometry context', (extra) => {
    expect(() =>
      admitTrustedIqGeometryContext({
        kind: TRUSTED_IQ_GEOMETRY_CONTEXT_KIND,
        sampleRateHz: 61_440_000,
        nativeSampleRateHz: 122_880_000,
        ...extra,
      })
    ).toThrow(/may contain only/i);
  });
});
