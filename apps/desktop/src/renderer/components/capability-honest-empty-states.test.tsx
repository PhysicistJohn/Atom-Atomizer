// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import type { ChannelMeasurementConfiguration, SpectrumDisplayConfiguration, WaterfallConfiguration } from '@tinysa/contracts';
import { SpectrumPlot } from './SpectrumPlot.js';
import { WaterfallView } from './WaterfallView.js';
import { ChannelAnalysisView } from './ChannelAnalysisView.js';

afterEach(cleanup);

function requireEmptyState(container: HTMLElement, selector: string): HTMLElement {
  const empty = container.querySelector<HTMLElement>(selector);
  if (!empty) throw new Error(`Expected an empty-state panel matching ${selector}`);
  return empty;
}

/**
 * A source with neither swept-spectrum nor complex-I/Q acquisition (e.g.
 * detected-power-timeseries only) never populates a sweep -- not "not yet
 * acquired", but "structurally cannot exist" here. A complex-I/Q-only source
 * such as Neptune P210 does NOT fall into this case: every accepted complex-
 * I/Q measurement derives a scalar spectrum (see
 * `projectDerivedSpectrumFromComplexIq`), so its `spectrumCapabilityAvailable`
 * is `true`. Spectrum, Waterfall, and Channel must say the "no capability"
 * state plainly instead of telling the operator to "acquire" something that
 * will never arrive, which reads as a broken/dead screen even though nothing
 * crashed -- but must not say it for a source that will, in fact, populate
 * one.
 */
describe('Spectrum/Waterfall/Channel distinguish "no data yet" from "no spectrum capability at all"', () => {
  it('SpectrumPlot: shows the ordinary empty state when the source has spectrum capability', () => {
    const view = render(<SpectrumPlot busy={false} spectrumCapabilityAvailable/>);
    const empty = requireEmptyState(view.container, '.plot-empty');
    expect(within(empty).getByText('No sweep')).toBeTruthy();
    expect(within(empty).getByText('Connect and acquire.')).toBeTruthy();
  });

  it('SpectrumPlot: defaults to the ordinary empty state when the prop is omitted (existing callers keep prior behavior)', () => {
    const view = render(<SpectrumPlot busy={false}/>);
    const empty = requireEmptyState(view.container, '.plot-empty');
    expect(within(empty).getByText('No sweep')).toBeTruthy();
  });

  it('SpectrumPlot: shows the honest no-capability state for a source with neither swept-spectrum nor complex-I/Q, and never claims acquiring will help', () => {
    const view = render(<SpectrumPlot busy={false} spectrumCapabilityAvailable={false}/>);
    const empty = requireEmptyState(view.container, '.plot-empty');
    expect(within(empty).getByText('No scalar spectrum capability')).toBeTruthy();
    expect(within(empty).getByText(/no swept-spectrum or complex-I\/Q acquisition/)).toBeTruthy();
    expect(within(empty).queryByText('Connect and acquire.')).toBeNull();
    expect(within(empty).queryByText('No sweep')).toBeNull();
  });

  describe('WaterfallView', () => {
    let getContext: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      const context = {
        fillRect: vi.fn(),
        putImageData: vi.fn(),
        drawImage: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        clearRect: vi.fn(),
        strokeStyle: '',
        lineWidth: 1,
        imageSmoothingEnabled: true,
      };
      getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue(context as unknown as CanvasRenderingContext2D);
    });
    afterEach(() => getContext.mockRestore());

    it('shows the ordinary empty state when the source has spectrum capability', () => {
      const configuration: WaterfallConfiguration = { historyDepth: 20, floorDbm: -110, ceilingDbm: -10, palette: 'atomic' };
      const view = render(<WaterfallView history={[]} configuration={configuration} spectrumCapabilityAvailable onConfiguration={() => {}}/>);
      const empty = requireEmptyState(view.container, '.analysis-empty');
      expect(within(empty).getByText('No history')).toBeTruthy();
      expect(within(empty).getByText('Run to build sweep history.')).toBeTruthy();
    });

    it('shows the honest no-capability state for a source with neither swept-spectrum nor complex-I/Q', () => {
      const configuration: WaterfallConfiguration = { historyDepth: 20, floorDbm: -110, ceilingDbm: -10, palette: 'atomic' };
      const view = render(<WaterfallView history={[]} configuration={configuration} spectrumCapabilityAvailable={false} onConfiguration={() => {}}/>);
      const empty = requireEmptyState(view.container, '.analysis-empty');
      expect(within(empty).getByText('No scalar spectrum capability')).toBeTruthy();
      expect(within(empty).getByText(/no swept-spectrum or complex-I\/Q acquisition/)).toBeTruthy();
      expect(within(empty).queryByText('Run to build sweep history.')).toBeNull();
    });
  });

  describe('ChannelAnalysisView', () => {
    const configuration: ChannelMeasurementConfiguration = {
      centerHz: 100_000_000,
      mainBandwidthHz: 200_000,
      adjacentBandwidthHz: 200_000,
      channelSpacingHz: 200_000,
      adjacentChannelCount: 0,
      occupiedPowerPercent: 99,
      obwNoiseCorrection: 'none',
    };
    const display: SpectrumDisplayConfiguration = { referenceLevelDbm: -20, decibelsPerDivision: 10, divisions: 10 };

    it('shows the ordinary empty state when the source has spectrum capability', () => {
      const view = render(<ChannelAnalysisView configuration={configuration} display={display} spectrumCapabilityAvailable onConfiguration={() => {}}/>);
      const empty = requireEmptyState(view.container, '.analysis-empty');
      expect(within(empty).getByText('No sweep')).toBeTruthy();
      expect(within(empty).getByText('Capture a frame, then fit the strongest signal or set the analysis window.')).toBeTruthy();
      expect(within(empty).queryByRole('button', { name: 'Capture a fresh analysis frame' })).toBeNull();
    });

    it('offers the supplied generic capture action only when a scalar view is possible', () => {
      const onCapture = vi.fn();
      const view = render(<ChannelAnalysisView configuration={configuration} display={display} spectrumCapabilityAvailable onCapture={onCapture} onConfiguration={() => {}}/>);
      const empty = requireEmptyState(view.container, '.analysis-empty');
      const capture = within(empty).getByRole('button', { name: 'Capture a fresh analysis frame' });
      expect(capture.textContent).toContain('Capture');
      fireEvent.click(capture);
      expect(onCapture).toHaveBeenCalledOnce();

      view.rerender(<ChannelAnalysisView configuration={configuration} display={display} spectrumCapabilityAvailable={false} onCapture={onCapture} onConfiguration={() => {}}/>);
      expect(within(requireEmptyState(view.container, '.analysis-empty')).queryByRole('button', { name: 'Capture a fresh analysis frame' })).toBeNull();
    });

    it('shows the honest no-capability state for a source with neither swept-spectrum nor complex-I/Q', () => {
      const view = render(<ChannelAnalysisView configuration={configuration} display={display} spectrumCapabilityAvailable={false} onConfiguration={() => {}}/>);
      const empty = requireEmptyState(view.container, '.analysis-empty');
      expect(within(empty).getByText('No scalar spectrum capability')).toBeTruthy();
      expect(within(empty).getByText(/no swept-spectrum or complex-I\/Q acquisition/)).toBeTruthy();
      expect(within(empty).queryByText('Acquire the carrier and adjacent windows.')).toBeNull();
    });
  });
});
