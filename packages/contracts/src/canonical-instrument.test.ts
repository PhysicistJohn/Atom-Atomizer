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
});
