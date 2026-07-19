// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstrumentAcquisitionCapability, InstrumentMeasurement } from '@tinysa/contracts';
import { DEFAULT_COMPLEX_IQ_CONFIGURATION, previewComplexIq } from '../complex-iq.js';
import { IqWorkspace, type IqCaptureMeta } from './IqWorkspace.js';

const capability: Extract<InstrumentAcquisitionCapability, { kind: 'complex-iq' }> = {
  kind: 'complex-iq',
  centerFrequencyHz: { min: 1_000_000, max: 6_000_000_000, step: 1 },
  sampleRateHz: { min: 100_000, max: 20_000_000, step: 1 },
  bandwidthHz: { min: 10_000, max: 20_000_000, step: 1 },
  sampleCount: { min: 2, max: 1_048_576, step: 1 },
  sampleFormat: 'cf32le',
};

function capture(): Extract<InstrumentMeasurement, { kind: 'complex-iq' }> {
  const samples = new Uint8Array(16);
  const view = new DataView(samples.buffer);
  view.setFloat32(0, 1, true);
  view.setFloat32(4, 0, true);
  view.setFloat32(8, 0, true);
  view.setFloat32(12, 1, true);
  return {
    schemaVersion: 1,
    kind: 'complex-iq',
    measurementId: 'iq-capture-1',
    sessionId: 'iq-session-1',
    configurationRevision: 'iq-config-1',
    sequence: 1,
    capturedAt: '2026-07-17T00:00:00.000Z',
    elapsedMilliseconds: 1,
    resolutionBandwidthHz: null,
    attenuationDb: null,
    qualification: 'analytic-complex-baseband',
    complete: true,
    centerHz: 100_000_000,
    sampleRateHz: 2_000_000,
    bandwidthHz: 1_500_000,
    sampleFormat: 'cf32le',
    sampleCount: 2,
    samples,
  };
}

// The raw capture never becomes a prop (see IqContainer); components receive
// the bounded preview plus scalar metadata.
function captureProps(): { preview: ReturnType<typeof previewComplexIq>; captureMeta: IqCaptureMeta } {
  const measurement = capture();
  return {
    preview: previewComplexIq(measurement),
    captureMeta: {
      measurementId: measurement.measurementId,
      sequence: measurement.sequence,
      centerHz: measurement.centerHz,
      sampleCount: measurement.sampleCount,
      sampleRateHz: measurement.sampleRateHz,
      sampleFormat: measurement.sampleFormat,
      qualification: measurement.qualification,
    },
  };
}

afterEach(cleanup);

describe('complex I/Q workspace', () => {
  it('discloses an exact non-round GHz center to both the operator and accessibility tree', () => {
    render(<IqWorkspace
      configuration={{ ...DEFAULT_COMPLEX_IQ_CONFIGURATION, centerHz: 3_500_010_000 }}
      capability={capability}
      busy={false}
      onChange={vi.fn()}
    />);

    expect(screen.getByLabelText('Edit Center frequency').textContent).toContain('3.50001 GHz');
  });

  it('renders bounded time/constellation previews and delegates acquisition to the sidebar', () => {
    const view = render(<IqWorkspace
      configuration={DEFAULT_COMPLEX_IQ_CONFIGURATION}
      capability={capability}
      {...captureProps()}
      busy={false}
      onChange={vi.fn()}
    />);

    expect(screen.getByLabelText(/I and Q sample amplitude/i)).toBeTruthy();
    expect(screen.getByLabelText(/Complex I Q constellation/i)).toBeTruthy();
    expect(screen.getByText(/Capture iq-capture-1/i)).toBeTruthy();
    expect(screen.getByText(/analytic complex baseband/i)).toBeTruthy();
    expect(screen.getAllByText('0.00 dBFS')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Capture I\/Q/i })).toBeNull();
    expect(screen.getByText(/Use sidebar Single/i)).toBeTruthy();
    const workspace = screen.getByRole('region', { name: 'Complex I/Q workspace' });
    expect(workspace.getAttribute('aria-description'))
      .toBe('captureId=iq-capture-1; sequence=1; centerHz=100000000');
    expect(view.container.querySelector('[data-agent-exclusion="human-iq-capture-boundary"]')).toBe(workspace);
    expect(view.container.querySelector('[data-agent-control]')).toBeNull();
  });

  it('fits both plots by default and provides bounded keyboard-accessible zoom and reset controls', () => {
    const view = render(<IqWorkspace
      configuration={DEFAULT_COMPLEX_IQ_CONFIGURATION}
      capability={capability}
      {...captureProps()}
      busy={false}
      onChange={vi.fn()}
    />);
    // Plots render onto retained canvases (no per-buffer SVG DOM); jsdom has
    // no 2d context, so the zoom contract is asserted through its controls.
    expect(view.container.querySelectorAll('canvas.iq-canvas')).toHaveLength(2);
    const zoomIn = screen.getByRole('button', { name: 'Zoom I/Q plots in' });
    zoomIn.focus();
    expect(document.activeElement).toBe(zoomIn);
    fireEvent.click(zoomIn);
    expect(screen.getByLabelText('I/Q plot zoom').textContent).toBe('2×');

    fireEvent.click(screen.getByRole('button', { name: 'Fit I/Q plots to capture' }));
    expect(screen.getByLabelText('I/Q plot zoom').textContent).toBe('1×');

    fireEvent.click(zoomIn);
    fireEvent.click(zoomIn);
    fireEvent.click(zoomIn);
    expect(screen.getByLabelText('I/Q plot zoom').textContent).toBe('8×');
    expect(zoomIn.hasAttribute('disabled')).toBe(true);
  });

  it('fails closed when the active driver advertises no I/Q acquisition', () => {
    render(<IqWorkspace
      configuration={DEFAULT_COMPLEX_IQ_CONFIGURATION}
      busy={false}
      onChange={vi.fn()}
    />);
    expect(screen.queryByRole('button', { name: /Capture I\/Q/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Zoom I/Q plots in' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('UNAVAILABLE')).toBeTruthy();
  });

  it('explains and disables a profile-specific I/Q admission failure', () => {
    render(<IqWorkspace
      configuration={DEFAULT_COMPLEX_IQ_CONFIGURATION}
      capability={capability}
      busy={false}
      captureUnavailableReason="No truthful I/Q generator is admitted for this standards profile."
      onChange={vi.fn()}
    />);
    expect(screen.getByText(/No truthful I\/Q generator/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Capture I\/Q/i })).toBeNull();
  });
});
