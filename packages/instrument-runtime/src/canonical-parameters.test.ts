import { describe, expect, it } from 'vitest';
import {
  CANONICAL_DRIVER_AUTO_DESCRIPTION,
  canonicalEnumParameter,
  canonicalNumericParameter,
  canonicalRangeValue,
  maximumReachableRangeValue,
  rangeAdmits,
  resolveCanonicalEnumIntent,
  resolveCanonicalRangedNumberIntent,
} from './canonical-parameters.js';

describe('canonical parameter helpers', () => {
  it('builds complete Auto/manual numeric and enum controls', () => {
    expect(canonicalNumericParameter(
      'integer', 'capture.rate', 'Rate', 'Capture', 'Hz', { min: 1, max: 10, step: 1 },
      { value: 4, verification: 'driver-selected' },
    )).toMatchObject({
      manual: { kind: 'integer', range: { min: 1, max: 10, step: 1 } },
      auto: { resolver: 'driver', description: CANONICAL_DRIVER_AUTO_DESCRIPTION },
      requested: { mode: 'auto' }, effectiveValue: 4, verification: 'driver-selected',
    });
    expect(canonicalEnumParameter('receiver.detector', 'Detector', 'Receiver', ['sample', 'peak'] as const,
      { value: 'sample', verification: 'driver-commanded' }, { mode: 'manual', value: 'sample' },
    ).manual).toEqual({
      kind: 'enum', options: [{ value: 'sample', label: 'Sample' }, { value: 'peak', label: 'Peak' }],
    });
  });

  it('resolves Auto/manual values only inside advertised numeric and enum domains', () => {
    const intents = new Map([
      ['rate', { mode: 'auto' as const }],
      ['points', { mode: 'manual' as const, value: 8 }],
      ['detector', { mode: 'manual' as const, value: 'peak' }],
    ]);
    expect(resolveCanonicalRangedNumberIntent(intents, 'rate', 4, { min: 1, max: 10, step: 1 }, 'rate out of range', true)).toBe(4);
    expect(resolveCanonicalRangedNumberIntent(intents, 'points', 4, { min: 1, max: 10, step: 1 }, 'points out of range', true)).toBe(8);
    expect(resolveCanonicalEnumIntent(intents, 'detector', ['sample', 'peak'] as const, 'sample')).toBe('peak');
    expect(() => resolveCanonicalRangedNumberIntent(new Map([['points', { mode: 'manual' as const, value: 8.5 }]]), 'points', 4, { min: 1, max: 10, step: 1 }, 'points out of range', true)).toThrow(/integer/);
    expect(() => resolveCanonicalRangedNumberIntent(new Map(), 'missing', 4, { min: 1, max: 10 }, 'missing', false, 'Canonical receiver sweep')).toThrow('Canonical receiver sweep is missing missing');
  });

  it('keeps automatic selections on the advertised step grid', () => {
    const range = { min: 1, max: 10, step: 3 };
    expect(maximumReachableRangeValue(range)).toBe(10);
    expect(canonicalRangeValue(range, 9)).toBe(10);
    expect(rangeAdmits(10, range)).toBe(true);
    expect(rangeAdmits(9, range)).toBe(false);
    expect(() => canonicalRangeValue({ min: Number.MAX_SAFE_INTEGER + 1, max: Number.MAX_SAFE_INTEGER + 1 }, 0, 'Canonical capture selection is not a safe integer')).toThrow('Canonical capture selection is not a safe integer');
  });
});
