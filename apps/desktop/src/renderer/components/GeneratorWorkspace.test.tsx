// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalInstrumentSurface } from '@tinysa/contracts';
import { GeneratorWorkspace } from './GeneratorWorkspace.js';

afterEach(cleanup);

const sourceSurface: CanonicalInstrumentSurface = {
  schemaVersion: 1,
  revision: 'source-surface-1',
  presentation: { title: 'Connected source', qualification: 'driver declared', facts: [] },
  parameters: [{
    id: 'source.profile',
    label: 'Operating selection',
    group: 'Source',
    manual: { kind: 'enum', options: [{ value: 'fm', label: 'FM broadcast' }] },
    auto: { resolver: 'driver', description: 'The driver chooses the active source setting.' },
    requested: { mode: 'auto' },
    effectiveValue: 'fm',
    verification: 'driver-selected',
  }],
  operations: [{
    id: 'source.select-profile',
    label: 'Select source',
    scope: 'source',
    parameterIds: ['source.profile'],
    outputs: ['Source state'],
    availability: 'available',
    primary: false,
    confirmation: 'none',
  }],
};

describe('generator workspace canonical source surface', () => {
  it('forwards only generic operation IDs and recommended/custom intents', () => {
    const onCanonicalOperation = vi.fn();
    render(<GeneratorWorkspace
      canonicalSurface={sourceSurface}
      busy={false}
      onCanonicalOperation={onCanonicalOperation}
    />);

    expect(screen.queryByText(/SignalLab/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Apply settings' }));
    expect(onCanonicalOperation).toHaveBeenCalledWith('source.select-profile', [
      { parameterId: 'source.profile', intent: { mode: 'auto' } },
    ]);
  });
});
