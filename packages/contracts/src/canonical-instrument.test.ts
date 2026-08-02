import { describe, expect, it } from 'vitest';
import {
  canonicalInstrumentSurfaceSchema,
  canonicalOperationParameterIntentsFor,
  canonicalOperationRequestSchema,
  type CanonicalInstrumentSurface,
} from './canonical-instrument.js';

const surface: CanonicalInstrumentSurface = {
  schemaVersion: 1,
  revision: 'surface:1',
  presentation: {
    title: 'Receiver',
    subtitle: 'Connected instrument',
    qualification: 'DEVICE READBACK',
    facts: [{ label: 'Transport', value: 'network' }],
  },
  parameters: [
    {
      id: 'capture.tune',
      label: 'Tune',
      group: 'Capture',
      unit: 'Hz',
      manual: { kind: 'integer', range: { min: 70_000_000, max: 6_000_000_000, step: 1 } },
      auto: { resolver: 'driver', description: 'Use the driver-selected receive tune.' },
      requested: { mode: 'auto' },
      effectiveValue: 100_000_000,
      verification: 'device-readback',
    },
    {
      id: 'capture.gain-mode',
      label: 'Gain mode',
      group: 'Capture',
      manual: {
        kind: 'enum',
        options: [
          { value: 'low-noise', label: 'Low noise' },
          { value: 'high-linearity', label: 'High linearity' },
        ],
      },
      auto: { resolver: 'driver', description: 'Let the driver select gain.' },
      requested: { mode: 'manual', value: 'low-noise' },
      effectiveValue: 'low-noise',
      verification: 'driver-commanded',
    },
  ],
  operations: [{
    id: 'capture',
    label: 'Capture',
    scope: 'acquisition',
    acquisitionKind: 'complex-iq',
    parameterIds: ['capture.tune', 'capture.gain-mode'],
    outputs: ['Complex I/Q'],
    availability: 'available',
    primary: true,
    confirmation: 'none',
  }],
};

describe('canonical instrument surface', () => {
  it('requires a real auto policy and concrete effective value for every mutable parameter', () => {
    expect(canonicalInstrumentSurfaceSchema.parse(surface)).toEqual(surface);

    expect(canonicalInstrumentSurfaceSchema.safeParse({
      ...surface,
      parameters: [{ ...surface.parameters[0], auto: undefined }],
    }).success).toBe(false);
    expect(canonicalInstrumentSurfaceSchema.safeParse({
      ...surface,
      parameters: [{ ...surface.parameters[0], requested: { mode: 'auto' }, effectiveValue: '100 MHz' }],
    }).success).toBe(false);
  });

  it('accepts only complete, current operation intents', () => {
    const request = {
      sessionId: 'session:1',
      surfaceRevision: 'surface:1',
      operationId: 'capture',
      parameters: [
        { parameterId: 'capture.tune', intent: { mode: 'manual', value: 99_900_000 } },
        { parameterId: 'capture.gain-mode', intent: { mode: 'auto' } },
      ],
    };
    expect(canonicalOperationRequestSchema.parse(request)).toEqual(request);
    const intents = canonicalOperationParameterIntentsFor(surface, 'capture', request);
    expect(intents.get('capture.tune')).toEqual({ mode: 'manual', value: 99_900_000 });
    expect(intents.get('capture.gain-mode')).toEqual({ mode: 'auto' });

    expect(() => canonicalOperationParameterIntentsFor(surface, 'capture', {
      ...request,
      surfaceRevision: 'surface:stale',
    })).toThrow(/stale/i);
    expect(() => canonicalOperationParameterIntentsFor(surface, 'capture', {
      ...request,
      parameters: request.parameters.slice(0, 1),
    })).toThrow(/missing parameter/i);
  });

  it('rejects hidden or duplicate operation parameter references', () => {
    expect(canonicalInstrumentSurfaceSchema.safeParse({
      ...surface,
      operations: [{ ...surface.operations[0], parameterIds: ['capture.tune', 'not-advertised'] }],
    }).success).toBe(false);
    expect(canonicalInstrumentSurfaceSchema.safeParse({
      ...surface,
      operations: [{ ...surface.operations[0], parameterIds: ['capture.tune', 'capture.tune'] }],
    }).success).toBe(false);
  });

  it('declares an acquisition result shape only on acquisition operations', () => {
    for (const acquisitionKind of ['swept-spectrum', 'complex-iq', 'detected-power-timeseries'] as const) {
      expect(canonicalInstrumentSurfaceSchema.parse({
        ...surface,
        operations: [{ ...surface.operations[0], acquisitionKind }],
      }).operations[0]?.acquisitionKind).toBe(acquisitionKind);
    }

    expect(canonicalInstrumentSurfaceSchema.safeParse({
      ...surface,
      operations: [{ ...surface.operations[0], scope: 'source', acquisitionKind: 'complex-iq' }],
    }).success).toBe(false);
  });

  it('accepts only numeric, operation-local parameter relations', () => {
    const numericSurface: CanonicalInstrumentSurface = {
      ...surface,
      parameters: [
        surface.parameters[0]!,
        surface.parameters[1]!,
        {
          id: 'capture.rate', label: 'Rate', group: 'Capture', unit: 'Hz',
          manual: { kind: 'integer', range: { min: 1, max: 1_000, step: 1 } },
          auto: { resolver: 'driver', description: 'Choose a valid rate.' },
          requested: { mode: 'auto' }, effectiveValue: 100, verification: 'driver-selected',
        },
      ],
      operations: [{
        ...surface.operations[0]!,
        parameterIds: ['capture.tune', 'capture.gain-mode', 'capture.rate'],
        constraints: [{
          kind: 'numeric-relation',
          leftParameterId: 'capture.tune',
          relation: 'less-than-or-equal',
          rightParameterId: 'capture.rate',
          message: 'Tune must not exceed rate.',
        }],
      }],
    };
    expect(canonicalInstrumentSurfaceSchema.parse(numericSurface)).toEqual(numericSurface);

    expect(canonicalInstrumentSurfaceSchema.safeParse({
      ...numericSurface,
      operations: [{
        ...numericSurface.operations[0],
        constraints: [{
          ...numericSurface.operations[0]!.constraints![0]!,
          rightParameterId: 'capture.gain-mode',
        }],
      }],
    }).success).toBe(false);
    expect(canonicalInstrumentSurfaceSchema.safeParse({
      ...numericSurface,
      operations: [{
        ...numericSurface.operations[0],
        constraints: [{
          ...numericSurface.operations[0]!.constraints![0]!,
          rightParameterId: 'missing',
        }],
      }],
    }).success).toBe(false);
  });

  it('rejects only explicitly-custom constraint violations before a driver resolves recommendations', () => {
    const constrained: CanonicalInstrumentSurface = {
      ...surface,
      parameters: [
        {
          ...surface.parameters[0]!,
          id: 'capture.bandwidth',
          label: 'Bandwidth',
          requested: { mode: 'auto' },
          effectiveValue: 8_000_000,
          manual: { kind: 'integer', range: { min: 1_000_000, max: 20_000_000, step: 1_000_000 } },
        },
        {
          ...surface.parameters[0]!,
          id: 'capture.rate',
          label: 'Sample rate',
          requested: { mode: 'auto' },
          effectiveValue: 10_000_000,
          manual: { kind: 'integer', range: { min: 1_000_000, max: 30_000_000, step: 1_000_000 } },
        },
      ],
      operations: [{
        ...surface.operations[0]!,
        parameterIds: ['capture.bandwidth', 'capture.rate'],
        constraints: [{
          kind: 'numeric-relation',
          leftParameterId: 'capture.bandwidth',
          relation: 'less-than-or-equal',
          rightParameterId: 'capture.rate',
          message: 'Bandwidth must not exceed sample rate.',
        }],
      }],
    };
    const request = {
      sessionId: 'session:1',
      surfaceRevision: constrained.revision,
      operationId: 'capture',
      parameters: [
        { parameterId: 'capture.bandwidth', intent: { mode: 'manual' as const, value: 20_000_000 } },
        { parameterId: 'capture.rate', intent: { mode: 'manual' as const, value: 10_000_000 } },
      ],
    };
    expect(() => canonicalOperationParameterIntentsFor(constrained, 'capture', request))
      .toThrow('Bandwidth must not exceed sample rate.');
    expect(canonicalOperationParameterIntentsFor(constrained, 'capture', {
      ...request,
      parameters: [{ parameterId: 'capture.bandwidth', intent: { mode: 'manual', value: 20_000_000 } }, { parameterId: 'capture.rate', intent: { mode: 'auto' } }],
    }).get('capture.rate')).toEqual({ mode: 'auto' });
  });
});
