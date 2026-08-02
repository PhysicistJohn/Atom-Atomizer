// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarkerConfiguration, TraceBankConfiguration } from '@tinysa/contracts';
import { MeasurementDock } from './MeasurementDock.js';

afterEach(cleanup);

const markers = Array.from({ length: 8 }, (_, index) => ({
  id: index + 1,
  enabled: false,
  traceId: 1,
  mode: 'normal',
  frequencyHz: 98_000_000,
  tracking: 'fixed',
})) as MarkerConfiguration[];

const initialTraces = [
  { id: 1, mode: 'max-hold', averageCount: 9 },
  { id: 2, mode: 'blank', averageCount: 8 },
  { id: 3, mode: 'blank', averageCount: 8 },
  { id: 4, mode: 'blank', averageCount: 8 },
] satisfies TraceBankConfiguration;

function dock(traces: TraceBankConfiguration, onTrace = vi.fn(), options: {
  panel?: 'traces' | 'display';
  onAutoScale?: () => void;
} = {}) {
  return <MeasurementDock
    panel={options.panel ?? 'traces'}
    showTabs={false}
    traces={traces}
    frames={[]}
    firmwareFrames={[]}
    visibleFirmwareTraceIds={[]}
    onFirmwareTraceVisibility={vi.fn()}
    activeTraceId={1}
    onActiveTrace={vi.fn()}
    markers={markers}
    readings={[]}
    activeMarkerId={1}
    search={{ minimumLevelDbm: -90, minimumExcursionDb: 6 }}
    display={{ referenceLevelDbm: -20, decibelsPerDivision: 10, divisions: 10 }}
    onTrace={onTrace}
    onTraceReset={vi.fn()}
    onMarker={vi.fn()}
    onActiveMarker={vi.fn()}
    onSearch={vi.fn()}
    onSearchConfiguration={vi.fn()}
    onDisplay={vi.fn()}
    onAutoScale={options.onAutoScale ?? vi.fn()}
  />;
}

describe('measurement dock trace mode', () => {
  it('uses direct trace outcomes, including Off, without resetting the selected trace', () => {
    const onTrace = vi.fn();
    const initialTrace = initialTraces[0]!;
    const view = render(dock(initialTraces, onTrace));
    const peakHold = screen.getByRole('radio', { name: /Peak hold/i });

    expect((peakHold as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radiogroup', { name: 'Trace 1 behavior' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /Trace mode/i })).toBeNull();
    expect(view.container.querySelector('[data-agent-control="trace.1.enabled"]')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /Off/i }));
    expect(onTrace).toHaveBeenLastCalledWith({ ...initialTrace, mode: 'blank' });

    const offTraces = [{ ...initialTrace, mode: 'blank' }, ...initialTraces.slice(1)] satisfies TraceBankConfiguration;
    view.rerender(dock(offTraces, onTrace));
    expect((screen.getByRole('radio', { name: /Off/i }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Freeze/i }));
    expect(onTrace).toHaveBeenLastCalledWith({ ...offTraces[0], mode: 'view' });
  });

  it('reveals the averaging amount only for the Average outcome', () => {
    const onTrace = vi.fn();
    const view = render(dock(initialTraces, onTrace));

    expect(screen.queryByLabelText('Edit Sweeps to average')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Average/i }));
    expect(onTrace).toHaveBeenLastCalledWith({ ...initialTraces[0], mode: 'average' });

    const averageTraces = [{ ...initialTraces[0]!, mode: 'average' }, ...initialTraces.slice(1)] satisfies TraceBankConfiguration;
    view.rerender(dock(averageTraces, onTrace));
    expect(screen.getByLabelText('Edit Sweeps to average')).toBeTruthy();
  });

  it('leads Display with fitting the latest trace and keeps manual scale in disclosure', () => {
    const onAutoScale = vi.fn();
    const view = render(dock(initialTraces, vi.fn(), { panel: 'display', onAutoScale }));
    const manualScale = view.container.querySelector('details.display-manual-scale') as HTMLDetailsElement;

    expect(screen.getByRole('button', { name: /Fit latest trace/i })).toBeTruthy();
    expect(manualScale.open).toBe(false);
    fireEvent.click(screen.getByText('Manual scale'));
    expect(manualScale.open).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Fit latest trace/i }));
    expect(onAutoScale).toHaveBeenCalledOnce();
  });
});
