// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarkerConfiguration, TraceBankConfiguration } from '@tinysa/contracts';
import { DEFAULT_ANALYZER } from '../ui-contracts.js';
import { MeasurementWorkspace } from './MeasurementWorkspace.js';
import { Sidebar } from './Sidebar.js';

const traces = [
  { id: 1, mode: 'clear-write', averageCount: 8 },
  { id: 2, mode: 'blank', averageCount: 8 },
  { id: 3, mode: 'blank', averageCount: 8 },
  { id: 4, mode: 'blank', averageCount: 8 },
] satisfies TraceBankConfiguration;

const markers = Array.from({ length: 8 }, (_, index) => ({
  id: index + 1,
  enabled: false,
  traceId: 1,
  mode: 'normal',
  frequencyHz: 98_000_000,
  tracking: 'fixed',
})) as MarkerConfiguration[];

afterEach(cleanup);

describe('desktop navigation and compact measurement layout', () => {
  it('exposes the six requested sidebar destinations in exact order and no legacy view', () => {
    const onRun = vi.fn();
    const onSingle = vi.fn();
    const view = render(<Sidebar
      active="spectrum"
      measurementView="spectrum"
      output="off"
      generationAvailable
      connected
      acquisition="idle"
      continuous={false}
      acquisitionBusy={false}
      acquisitionDisabled={false}
      onSelect={vi.fn()}
      onMeasurementView={vi.fn()}
      onRun={onRun}
      onSingle={onSingle}
      onStop={vi.fn()}
    />);
    const navigation = within(view.container).getByRole('navigation', { name: 'Primary navigation' });
    expect(within(navigation).getAllByRole('button').map((button) => button.textContent?.trim()))
      .toEqual(['Spectrum', 'Waterfall', 'Channel', 'Detect', 'Generate', 'Device']);
    expect(within(navigation).getAllByRole('button', { name: 'Detect' })).toHaveLength(1);
    expect(navigation.textContent).not.toMatch(/Classify|Time\s*\/\s*STFT/i);
    expect(within(navigation).queryByRole('button', { name: 'Run' })).toBeNull();
    const acquisition = within(view.container).getByRole('region', { name: 'Acquisition controls' });
    const run = within(acquisition).getByRole('button', { name: 'Run' });
    const single = within(acquisition).getByRole('button', { name: 'Single' });
    run.focus();
    expect(document.activeElement).toBe(run);
    fireEvent.click(run);
    fireEvent.click(single);
    expect(onRun).toHaveBeenCalledOnce();
    expect(onSingle).toHaveBeenCalledOnce();
  });

  it('keeps one global Stop control in the sidebar while collection is running', () => {
    const onStop = vi.fn();
    const view = render(<Sidebar
      active="device"
      measurementView="channel"
      output="off"
      generationAvailable
      connected
      acquisition="streaming"
      continuous
      acquisitionBusy={false}
      acquisitionDisabled
      onSelect={vi.fn()}
      onMeasurementView={vi.fn()}
      onRun={vi.fn()}
      onSingle={vi.fn()}
      onStop={onStop}
    />);
    const acquisition = within(view.container).getByRole('region', { name: 'Acquisition controls' });
    expect(within(acquisition).getByText('Running spectrum')).toBeTruthy();
    expect(within(acquisition).queryByRole('button', { name: 'Run' })).toBeNull();
    expect(within(acquisition).queryByRole('button', { name: 'Single' })).toBeNull();
    fireEvent.click(within(acquisition).getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('keeps Spectrum, Waterfall, and Channel out of the Spectrum top utility bar', () => {
    const view = render(<MeasurementWorkspace
      measurementActions={<button type="button">Export CSV</button>}
      view="envelope-stft"
      analyzer={DEFAULT_ANALYZER}
      busy={false}
      streaming={false}
      onAnalyzer={vi.fn()}
      history={[]}
      detections={[]}
      acquisition="idle"
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
      markerSearch={{ minimumLevelDbm: -90, minimumExcursionDb: 6 }}
      display={{ referenceLevelDbm: -20, decibelsPerDivision: 10, divisions: 10 }}
      onTrace={vi.fn()}
      onTraceReset={vi.fn()}
      onMarker={vi.fn()}
      onActiveMarker={vi.fn()}
      onSearch={vi.fn()}
      onSearchConfiguration={vi.fn()}
      onDisplay={vi.fn()}
      onAutoScale={vi.fn()}
      onMarkerPlace={() => true}
      waterfall={{ historyDepth: 35, floorDbm: -120, ceilingDbm: -20, palette: 'atomic' }}
      onWaterfall={vi.fn()}
      channel={{ centerHz: 98_000_000, mainBandwidthHz: 200_000, adjacentBandwidthHz: 200_000, channelSpacingHz: 200_000, adjacentChannelCount: 2, occupiedPowerPercent: 99, obwNoiseCorrection: 'none' }}
      onChannel={vi.fn()}
    />);
    const topBar = within(view.container.querySelector('.measurement-viewbar') as HTMLElement);
    expect(topBar.getByRole('toolbar', { name: 'Measurement utilities' })).toBeTruthy();
    expect(topBar.queryByRole('tablist')).toBeNull();
    for (const removedTopTab of ['Spectrum', 'Waterfall', 'Channel', 'Time / STFT']) {
      expect(topBar.queryByRole('button', { name: removedTopTab })).toBeNull();
    }
    expect(topBar.getByRole('button', { name: 'Sweep setup' })).toBeTruthy();
    expect(topBar.getByRole('button', { name: 'Traces & markers' })).toBeTruthy();
    expect(topBar.getByRole('button', { name: 'Export CSV' })).toBeTruthy();
    expect(topBar.queryByRole('button', { name: 'Run' })).toBeNull();
    expect(topBar.queryByRole('button', { name: 'Single' })).toBeNull();
    expect(view.container.querySelector('.envelope-stft-view')).toBeNull();
    expect(within(view.container).getByLabelText('Spectrum plot')).toBeTruthy();
  });

});
