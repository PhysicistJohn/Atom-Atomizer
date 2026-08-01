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
        requested: { mode: 'manual', value: 99_000_000 },
        effectiveValue: 99_000_000,
        verification: 'device-readback',
      },
      {
        id: 'samples',
        label: 'Samples',
        group: 'Capture',
        manual: { kind: 'integer', range: { min: 64, max: 4_096, step: 64 } },
        auto: { resolver: 'driver', description: 'Balances duration and transfer size.' },
        requested: { mode: 'manual', value: 1_024 },
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
        requested: { mode: 'manual', value: 'wide' },
        effectiveValue: 'wide',
        verification: 'driver-selected',
      },
      {
        id: 'enabled',
        label: 'Enabled',
        group: 'Operation',
        manual: { kind: 'boolean' },
        auto: { resolver: 'host', description: 'Uses the operation default.' },
        requested: { mode: 'manual', value: true },
        effectiveValue: true,
        verification: 'host-derived',
      },
      {
        id: 'label',
        label: 'Label',
        group: 'Operation',
        manual: { kind: 'text', minimumLength: 0, maximumLength: 20, pattern: '^[a-z-]*$' },
        auto: { resolver: 'driver', description: 'Uses a driver-generated label.' },
        requested: { mode: 'manual', value: 'initial' },
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

describe('canonical operation panel', () => {
  it('offers Automatic and Manual intent for every driver-emitted parameter domain', () => {
    render(<CanonicalOperationPanel surface={surface()} busy={false} onExecute={vi.fn()}/>);

    for (const label of ['Frequency', 'Samples', 'Window', 'Enabled', 'Label']) {
      const mode = screen.getByRole('combobox', { name: `${label} mode` });
      expect(within(mode).getByRole('option', { name: 'Automatic' })).toBeTruthy();
      expect(within(mode).getByRole('option', { name: 'Manual' })).toBeTruthy();
    }
    expect(screen.getByLabelText('Edit Frequency value')).toBeTruthy();
    expect(screen.getByLabelText('Edit Samples value')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Window value' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Enabled value/i })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Label value' })).toBeTruthy();
    expect(screen.getAllByText('Device readback')).toHaveLength(1);
  });

  it('returns complete generic intents, including edits from each manual domain', () => {
    const onExecute = vi.fn();
    render(<CanonicalOperationPanel surface={surface()} busy={false} onExecute={onExecute}/>);

    fireEvent.click(screen.getByLabelText('Edit Frequency value'));
    const frequencyEditor = screen.getByRole('dialog', { name: 'Frequency value numeric entry' });
    fireEvent.change(within(frequencyEditor).getByRole('textbox', { name: 'Frequency value' }), { target: { value: '100' } });
    fireEvent.click(within(frequencyEditor).getByRole('button', { name: 'Apply MHz' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Window value' }), { target: { value: 'narrow' } });
    fireEvent.click(screen.getByRole('button', { name: /Enabled value/i }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Label value' }), { target: { value: 'manual-label' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Samples mode' }), { target: { value: 'auto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply Capture' }));

    expect(onExecute).toHaveBeenCalledWith('capture', [
      { parameterId: 'frequency', intent: { mode: 'manual', value: 100_000_000 } },
      { parameterId: 'samples', intent: { mode: 'auto' } },
      { parameterId: 'window', intent: { mode: 'manual', value: 'narrow' } },
      { parameterId: 'enabled', intent: { mode: 'manual', value: false } },
      { parameterId: 'label', intent: { mode: 'manual', value: 'manual-label' } },
    ]);
  });

  it('uses the driver-selected primary operation and disables an unavailable one', () => {
    const onExecute = vi.fn();
    const unavailable = surface();
    unavailable.operations[0] = { ...unavailable.operations[0]!, availability: 'busy' };
    render(<CanonicalOperationPanel surface={unavailable} busy={false} onExecute={onExecute}/>);

    expect((screen.getByRole('button', { name: 'Apply Capture' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('busy')).toBeTruthy();
    expect(onExecute).not.toHaveBeenCalled();
  });

  it('lets the driver-declared surface select any canonical operation without a source-family branch', () => {
    const onExecute = vi.fn();
    const multiOperationSurface = surface();
    multiOperationSurface.operations.push({
      id: 'measure',
      label: 'Measure',
      parameterIds: ['samples'],
      outputs: ['Measurement'],
      availability: 'available',
      primary: false,
      confirmation: 'none',
    });
    render(<CanonicalOperationPanel surface={multiOperationSurface} busy={false} onExecute={onExecute}/>);

    fireEvent.change(screen.getByRole('combobox', { name: 'Operation' }), { target: { value: 'measure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply Measure' }));

    expect(onExecute).toHaveBeenCalledWith('measure', [
      { parameterId: 'samples', intent: { mode: 'manual', value: 1_024 } },
    ]);
  });

  it('retains a selected operation across a fresh surface only while it remains in this placement', () => {
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
    const view = render(<CanonicalOperationPanel surface={initial} placement="acquisition" busy={false} onExecute={vi.fn()}/>);
    const picker = screen.getByRole('combobox', { name: 'Operation' }) as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 'measure' } });
    expect(picker.value).toBe('measure');

    const refreshed = { ...initial, revision: 'canonical-surface-2' };
    view.rerender(<CanonicalOperationPanel surface={refreshed} placement="acquisition" busy={false} onExecute={vi.fn()}/>);
    expect((screen.getByRole('combobox', { name: 'Operation' }) as HTMLSelectElement).value).toBe('measure');

    const moved = {
      ...refreshed,
      revision: 'canonical-surface-3',
      operations: refreshed.operations.map((operation) => operation.id === 'measure'
        ? { ...operation, scope: 'source' as const }
        : operation),
    };
    view.rerender(<CanonicalOperationPanel surface={moved} placement="acquisition" busy={false} onExecute={vi.fn()}/>);
    expect(screen.getByRole('button', { name: 'Apply Capture' })).toBeTruthy();
  });

  it('uses the driver-declared high-impact confirmation without an operation-name branch', () => {
    const onExecute = vi.fn();
    const highImpact = surface();
    highImpact.operations[0] = { ...highImpact.operations[0]!, confirmation: 'high-impact' };
    render(<CanonicalOperationPanel surface={highImpact} busy={false} onExecute={onExecute}/>);

    fireEvent.click(screen.getByRole('button', { name: 'Apply Capture' }));
    expect(onExecute).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('driver-declared operation');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm and apply Capture' }));
    expect(onExecute).toHaveBeenCalledWith('capture', expect.any(Array));
  });
});
