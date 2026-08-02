// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalInstrumentSurface } from '@tinysa/contracts';
import { CanonicalOperationPanel } from './CanonicalOperationPanel.js';

afterEach(cleanup);

function surface(): CanonicalInstrumentSurface {
  return {
    schemaVersion: 1,
    revision: 'canonical-surface-1',
    presentation: {
      title: 'Connected instrument',
      qualification: 'driver declared',
      facts: [],
    },
    parameters: [
      {
        id: 'frequency',
        label: 'Frequency',
        group: 'Receiver',
        unit: 'Hz',
        manual: { kind: 'number', range: { min: 1_000_000, max: 6_000_000_000, step: 1 } },
        auto: { resolver: 'driver', description: 'Selects the current receive target.' },
        requested: { mode: 'auto' },
        effectiveValue: 99_000_000,
        verification: 'device-readback',
      },
      {
        id: 'samples',
        label: 'Samples',
        group: 'Capture',
        manual: { kind: 'integer', range: { min: 64, max: 4_096, step: 64 } },
        auto: { resolver: 'driver', description: 'Balances duration and transfer size.' },
        requested: { mode: 'auto' },
        effectiveValue: 1_024,
        verification: 'driver-commanded',
      },
      {
        id: 'window',
        label: 'Window',
        group: 'Analysis',
        manual: {
          kind: 'enum',
          options: [
            { value: 'wide', label: 'Wide' },
            { value: 'narrow', label: 'Narrow' },
          ],
        },
        auto: { resolver: 'driver', description: 'Matches the selected processing path.' },
        requested: { mode: 'auto' },
        effectiveValue: 'wide',
        verification: 'driver-selected',
      },
      {
        id: 'enabled',
        label: 'Enabled',
        group: 'Operation',
        manual: { kind: 'boolean' },
        auto: { resolver: 'host', description: 'Uses the operation default.' },
        requested: { mode: 'auto' },
        effectiveValue: true,
        verification: 'host-derived',
      },
      {
        id: 'label',
        label: 'Label',
        group: 'Operation',
        manual: { kind: 'text', minimumLength: 0, maximumLength: 20, pattern: '^[a-z-]*$' },
        auto: { resolver: 'driver', description: 'Uses a driver-generated label.' },
        requested: { mode: 'auto' },
        effectiveValue: 'initial',
        verification: 'driver-selected',
      },
    ],
    operations: [{
      id: 'capture',
      label: 'Capture',
      description: 'Prepare a generic acquisition.',
      parameterIds: ['frequency', 'samples', 'window', 'enabled', 'label'],
      outputs: ['Samples'],
      availability: 'available',
      primary: true,
      confirmation: 'none',
    }],
  };
}

function expandSetting(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }));
}

function chooseCustom(label: string): void {
  expandSetting(label);
  fireEvent.click(screen.getByRole('radio', { name: /^Custom/ }));
}

function applyNumeric(label: string, value: string, unit: string): void {
  fireEvent.click(screen.getByLabelText(`Edit ${label} value`));
  const editor = screen.getByRole('dialog', { name: `${label} value numeric entry` });
  fireEvent.change(within(editor).getByRole('textbox', { name: `${label} value` }), { target: { value } });
  fireEvent.click(within(editor).getByRole('button', { name: `Apply ${unit}` }));
}

describe('canonical operation panel', () => {
  it('presents direct recommended setting rows instead of protocol-mode selectors', () => {
    render(<CanonicalOperationPanel surface={surface()} busy={false} onExecute={vi.fn()}/>);

    expect(screen.getByText('Recommended settings')).toBeTruthy();
    expect(screen.getByText(/Let the connected instrument choose a compatible configuration/i)).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /mode$/i })).toBeNull();
    expect(screen.queryByText('Automatic')).toBeNull();
    expect(screen.queryByText('Manual')).toBeNull();
    for (const label of ['Frequency', 'Samples', 'Window', 'Enabled', 'Label']) {
      const setting = screen.getByRole('button', { name: new RegExp(`^${label}`) });
      expect(setting.getAttribute('aria-expanded')).toBe('false');
      expect(setting.textContent).toContain('Recommended');
    }
    expect(screen.queryByText('Device readback')).toBeNull();

    expandSetting('Frequency');
    expect(screen.getByRole('radiogroup', { name: 'Frequency setting mode' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^Recommended/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Current value: Device readback')).toBeTruthy();
    expect(screen.queryByLabelText('Edit Frequency value')).toBeNull();
  });

  it('uses a focused Custom editor, emits generic manual intents, and restores recommendations', () => {
    const onExecute = vi.fn();
    render(<CanonicalOperationPanel surface={surface()} busy={false} onExecute={onExecute}/>);

    chooseCustom('Frequency');
    expect(screen.getByRole('radio', { name: /^Custom/ }).getAttribute('aria-checked')).toBe('true');
    applyNumeric('Frequency', '100', 'MHz');
    fireEvent.click(screen.getByRole('button', { name: 'Apply settings' }));

    expect(onExecute).toHaveBeenCalledWith('capture', [
      { parameterId: 'frequency', intent: { mode: 'manual', value: 100_000_000 } },
      { parameterId: 'samples', intent: { mode: 'auto' } },
      { parameterId: 'window', intent: { mode: 'auto' } },
      { parameterId: 'enabled', intent: { mode: 'auto' } },
      { parameterId: 'label', intent: { mode: 'auto' } },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Use recommended' }));
    expect(screen.getByRole('button', { name: /^Frequency/ }).textContent).toContain('Recommended');
    fireEvent.click(screen.getByRole('button', { name: 'Apply settings' }));
    expect(onExecute).toHaveBeenLastCalledWith('capture', [
      { parameterId: 'frequency', intent: { mode: 'auto' } },
      { parameterId: 'samples', intent: { mode: 'auto' } },
      { parameterId: 'window', intent: { mode: 'auto' } },
      { parameterId: 'enabled', intent: { mode: 'auto' } },
      { parameterId: 'label', intent: { mode: 'auto' } },
    ]);
  });

  it('uses a direct operation chooser, retains a peer selection across a fresh surface, and respects placement', () => {
    const onExecute = vi.fn();
    const initial = surface();
    initial.operations[0] = { ...initial.operations[0]!, scope: 'acquisition' };
    initial.operations.push(
      {
        id: 'measure',
        label: 'Measure',
        scope: 'acquisition',
        parameterIds: ['samples'],
        outputs: ['Measurement'],
        availability: 'available',
        primary: false,
        confirmation: 'none',
      },
      {
        id: 'source',
        label: 'Source',
        scope: 'source',
        parameterIds: ['samples'],
        outputs: ['Signal'],
        availability: 'available',
        primary: false,
        confirmation: 'none',
      },
    );
    const view = render(<CanonicalOperationPanel surface={initial} placement="acquisition" busy={false} onExecute={onExecute}/>);

    expect(screen.getByRole('group', { name: 'Instrument operation' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Capture' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Source' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Measure' }));
    expect(screen.getByRole('button', { name: 'Measure' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Apply settings' }));
    expect(onExecute).toHaveBeenCalledWith('measure', [
      { parameterId: 'samples', intent: { mode: 'auto' } },
    ]);

    const refreshed = { ...initial, revision: 'canonical-surface-2' };
    view.rerender(<CanonicalOperationPanel surface={refreshed} placement="acquisition" busy={false} onExecute={onExecute}/>);
    expect(screen.getByRole('button', { name: 'Measure' }).getAttribute('aria-pressed')).toBe('true');

    const moved = {
      ...refreshed,
      revision: 'canonical-surface-3',
      operations: refreshed.operations.map((operation) => operation.id === 'measure'
        ? { ...operation, scope: 'source' as const }
        : operation),
    };
    view.rerender(<CanonicalOperationPanel surface={moved} placement="acquisition" busy={false} onExecute={onExecute}/>);
    expect(screen.getByRole('heading', { name: 'Capture', level: 2 })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Instrument operation' })).toBeNull();
  });

  it('filters acquisition controls by a driver-declared result shape, never an operation label', () => {
    const typed = surface();
    typed.operations = [
      {
        ...typed.operations[0]!,
        id: 'iq-capture',
        label: 'Receive samples',
        scope: 'acquisition',
        acquisitionKind: 'complex-iq',
      },
      {
        id: 'spectrum-capture',
        label: 'Scan',
        scope: 'acquisition',
        acquisitionKind: 'swept-spectrum',
        parameterIds: ['samples'],
        outputs: ['Spectrum'],
        availability: 'available',
        primary: false,
        confirmation: 'none',
      },
    ];
    render(<CanonicalOperationPanel
      surface={typed}
      placement="acquisition"
      acquisitionKind="complex-iq"
      busy={false}
      onExecute={vi.fn()}
    />);

    expect(screen.getByRole('heading', { name: 'Receive samples' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Instrument operation' })).toBeNull();
    expect(screen.queryByText('Scan')).toBeNull();
  });

  it('preflights driver-declared numeric constraints only when both values are custom', () => {
    const onExecute = vi.fn();
    const constrained: CanonicalInstrumentSurface = {
      schemaVersion: 1,
      revision: 'constrained-surface-1',
      presentation: { title: 'Connected instrument', qualification: 'driver declared', facts: [] },
      parameters: [
        {
          id: 'sample-rate',
          label: 'Sample rate',
          group: 'Capture',
          unit: 'Hz',
          manual: { kind: 'integer', range: { min: 1_000_000, max: 56_000_000, step: 1_000_000 } },
          auto: { resolver: 'driver', description: 'Chooses a compatible sample rate.' },
          requested: { mode: 'auto' },
          effectiveValue: 8_000_000,
          verification: 'driver-selected',
        },
        {
          id: 'bandwidth',
          label: 'Bandwidth',
          group: 'Capture',
          unit: 'Hz',
          manual: { kind: 'integer', range: { min: 1_000_000, max: 56_000_000, step: 1_000_000 } },
          auto: { resolver: 'driver', description: 'Chooses a compatible bandwidth.' },
          requested: { mode: 'auto' },
          effectiveValue: 4_000_000,
          verification: 'driver-selected',
        },
      ],
      operations: [{
        id: 'capture',
        label: 'Capture',
        scope: 'acquisition',
        parameterIds: ['sample-rate', 'bandwidth'],
        constraints: [{
          kind: 'numeric-relation',
          leftParameterId: 'bandwidth',
          relation: 'less-than-or-equal',
          rightParameterId: 'sample-rate',
          message: 'Bandwidth must not exceed sample rate.',
        }],
        outputs: ['Complex samples'],
        availability: 'available',
        primary: true,
        confirmation: 'none',
      }],
    };
    render(<CanonicalOperationPanel surface={constrained} busy={false} onExecute={onExecute}/>);

    chooseCustom('Sample rate');
    applyNumeric('Sample rate', '2', 'MHz');
    chooseCustom('Bandwidth');
    applyNumeric('Bandwidth', '4', 'MHz');

    expect(screen.getAllByText('Bandwidth must not exceed sample rate.')).toHaveLength(2);
    const apply = screen.getByRole('button', { name: 'Apply settings' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    expect(onExecute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Use recommended' }));
    expect(screen.queryByText('Bandwidth must not exceed sample rate.')).toBeNull();
    expect((screen.getByRole('button', { name: 'Apply settings' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('uses the driver-declared high-impact confirmation without an operation-name branch', () => {
    const onExecute = vi.fn();
    const highImpact = surface();
    highImpact.operations[0] = { ...highImpact.operations[0]!, confirmation: 'high-impact' };
    render(<CanonicalOperationPanel surface={highImpact} busy={false} onExecute={onExecute}/>);

    fireEvent.click(screen.getByRole('button', { name: 'Apply settings' }));
    expect(onExecute).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('driver-declared operation');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm and apply Capture' }));
    expect(onExecute).toHaveBeenCalledWith('capture', expect.any(Array));
  });
});
