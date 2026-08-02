import { describe, expect, it } from 'vitest';
import {
  CANONICAL_DRIVER_AUTO_DESCRIPTION,
  canonicalEnumParameter,
  canonicalNumericParameter,
  canonicalOperationDefinition,
  canonicalRangeValue,
  canonicalRangeValueAtLeast,
  canonicalRangeValueAtMost,
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

  it('selects canonical grid values that honor dependent lower and upper bounds', () => {
    const range = { min: 1, max: 10, step: 3 };
    expect(canonicalRangeValueAtLeast(range, 1, 5)).toBe(7);
    expect(canonicalRangeValueAtLeast(range, 10, 11)).toBeUndefined();
    expect(canonicalRangeValueAtMost(range, 10, 6)).toBe(4);
    expect(canonicalRangeValueAtMost(range, 1, 0)).toBeUndefined();
  });

  it('preserves driver-declared constraints on their canonical operation', () => {
    const sampleRate = canonicalNumericParameter(
      'integer', 'capture.sample-rate', 'Sample rate', 'Capture', 'Hz', { min: 1, max: 10, step: 1 },
      { value: 8, verification: 'driver-selected' },
    );
    const bandwidth = canonicalNumericParameter(
      'integer', 'capture.bandwidth', 'Bandwidth', 'Capture', 'Hz', { min: 1, max: 10, step: 1 },
      { value: 4, verification: 'driver-selected' },
    );
    const constraints = [{
      kind: 'numeric-relation' as const,
      leftParameterId: bandwidth.id,
      relation: 'less-than-or-equal' as const,
      rightParameterId: sampleRate.id,
      message: 'Bandwidth must not exceed sample rate.',
    }];

    const operation = canonicalOperationDefinition({
      id: 'capture',
      label: 'Capture',
      description: 'Configure a bounded complex sample capture.',
      scope: 'acquisition',
      parameters: [sampleRate, bandwidth],
      outputs: ['Complex I/Q'],
      unavailable: false,
      constraints,
    });

    expect(operation.constraints).toEqual(constraints);
    expect(operation.constraints).not.toBe(constraints);
  });
});
