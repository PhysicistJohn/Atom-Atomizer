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

function dock(traces: TraceBankConfiguration, onTrace = vi.fn()) {
  return <MeasurementDock
    panel="traces"
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
    onAutoScale={vi.fn()}
  />;
}

describe('measurement dock trace mode', () => {
  it('uses one direct trace mode control, including Off, without resetting the selected mode', () => {
    const onTrace = vi.fn();
    const initialTrace = initialTraces[0]!;
    const view = render(dock(initialTraces, onTrace));
    const mode = screen.getByRole('combobox', { name: 'Trace mode' }) as HTMLSelectElement;

    expect(mode.value).toBe('max-hold');
    expect([...mode.options].map((option) => [option.value, option.textContent])).toEqual([
      ['blank', 'Off'],
      ['clear-write', 'Clear / Write'],
      ['max-hold', 'Maximum Hold'],
      ['min-hold', 'Minimum Hold'],
      ['average', 'Average'],
      ['view', 'View / Freeze'],
    ]);
    expect(view.container.querySelector('[data-agent-control="trace.1.enabled"]')).toBeNull();

    fireEvent.change(mode, { target: { value: 'blank' } });
    expect(onTrace).toHaveBeenLastCalledWith({ ...initialTrace, mode: 'blank' });

    const offTraces = [{ ...initialTrace, mode: 'blank' }, ...initialTraces.slice(1)] satisfies TraceBankConfiguration;
    view.rerender(dock(offTraces, onTrace));
    const refreshedMode = screen.getByRole('combobox', { name: 'Trace mode' }) as HTMLSelectElement;
    expect(refreshedMode.value).toBe('blank');
    fireEvent.change(refreshedMode, { target: { value: 'view' } });
    expect(onTrace).toHaveBeenLastCalledWith({ ...offTraces[0], mode: 'view' });
  });
});
