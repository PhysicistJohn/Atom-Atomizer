// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstrumentAcquisitionCapability, InstrumentMeasurement } from '@tinysa/contracts';
import {
  DEFAULT_COMPLEX_IQ_CONFIGURATION,
  previewComplexIq,
  type ComplexIqPreview,
} from '../complex-iq.js';
import {
  allRecordedCoordinates,
  installRecordingCanvas,
} from './canvas-test-recorder.js';
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('complex I/Q workspace', () => {
  it('discloses an exact non-round GHz center to both the operator and accessibility tree', () => {
    render(<IqWorkspace
      configuration={{ ...DEFAULT_COMPLEX_IQ_CONFIGURATION, centerHz: 3_500_010_000 }}
      capability={capability}
      busy={false}
      onChange={vi.fn()}
    />);

    expect(screen.getByLabelText('Edit Receiver tune').textContent).toContain('3.50001 GHz');
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
    expect(screen.getByText(/Receiver tune applies on the next sidebar Single or Run/i)).toBeTruthy();
    const workspace = screen.getByRole('region', { name: 'Complex I/Q workspace' });
    expect(workspace.getAttribute('aria-description'))
      .toBe('captureId=iq-capture-1; sequence=1; centerHz=100000000');
    expect(view.container.querySelector('[data-agent-exclusion="human-iq-capture-boundary"]')).toBe(workspace);
    expect(view.container.querySelector('[data-agent-control]')).toBeNull();
  });

  it('offers byte-exact SigMF export only after a capture exists', () => {
    const onExport = vi.fn();
    const view = render(<IqWorkspace
      configuration={DEFAULT_COMPLEX_IQ_CONFIGURATION}
      capability={capability}
      busy={false}
      onChange={vi.fn()}
      onExport={onExport}
    />);
    expect((screen.getByRole('button', { name: 'Export SigMF' }) as HTMLButtonElement).disabled).toBe(true);

    view.rerender(<IqWorkspace
      configuration={DEFAULT_COMPLEX_IQ_CONFIGURATION}
      capability={capability}
      {...captureProps()}
      busy={false}
      onChange={vi.fn()}
      onExport={onExport}
    />);
    const exportButton = screen.getByRole('button', { name: 'Export SigMF' }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(false);
    fireEvent.click(exportButton);
    expect(onExport).toHaveBeenCalledOnce();
  });

  it('identifies only while classification is pending and explains an unavailable short capture', () => {
    const props = captureProps();
    const view = render(<IqWorkspace
      configuration={DEFAULT_COMPLEX_IQ_CONFIGURATION}
      capability={capability}
      {...props}
      classificationPending
      busy={false}
      onChange={vi.fn()}
    />);
    expect(screen.getByText('Identifying…')).toBeTruthy();

    view.rerender(<IqWorkspace
      configuration={DEFAULT_COMPLEX_IQ_CONFIGURATION}
      capability={capability}
      {...props}
      classificationPending={false}
      classificationIssue={{
        kind: 'unavailable',
        message: 'Modulation classification requires at least 4,096 complex samples. Increase Complex samples to 4,096 or more, then capture again.',
      }}
      busy={false}
      onChange={vi.fn()}
    />);
    expect(screen.queryByText('Identifying…')).toBeNull();
    expect(screen.getByText(/at least 4,096 complex samples.*Increase Complex samples/i)).toBeTruthy();
  });

  it('offers an explicit analysis-capable sample count without rewriting a deliberate short capture', () => {
    const onChange = vi.fn();
    render(<IqWorkspace
      configuration={{ ...DEFAULT_COMPLEX_IQ_CONFIGURATION, sampleCount: 2_048 }}
      capability={capability}
      busy={false}
      onChange={onChange}
    />);

    expect(screen.getByText(/Modulation detection needs at least 4,096 complex samples/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use 4,096 samples' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sampleCount: 4_096 }));
  });

  it('explains when a narrow physical passband cannot fill the plotted sample-rate span', () => {
    render(<IqWorkspace
      configuration={{ ...DEFAULT_COMPLEX_IQ_CONFIGURATION, sampleRateHz: 50_000_000, bandwidthHz: 200_000 }}
      capability={{ ...capability, bandwidthMode: 'independent', sampleRateHz: { min: 100_000, max: 56_000_000, step: 1 } }}
      busy={false}
      onChange={vi.fn()}
    />);

    expect(screen.getByText(/Capture bandwidth is .* while the plotted span follows the .* sample rate/i)).toBeTruthy();
    expect(screen.getByText(/Only the center passband is physically admitted.*FM broadcast/i)).toBeTruthy();
  });

  it('displays output placement separately from canonical profile lineage', () => {
    const props = captureProps();
    render(<IqWorkspace
      configuration={{ ...DEFAULT_COMPLEX_IQ_CONFIGURATION, centerHz: 3_450_000_000 }}
      capability={capability}
      preview={props.preview}
      captureMeta={{
        ...props.captureMeta,
        centerHz: 3_450_000_000,
        profileReferenceCenterHz: 3_500_010_000,
        rfReferenceCenterHz: 3_500_010_000,
        nativeCarrierOffsetHz: 0,
        rfPlacement: 'operator-translated',
        outputCarrierOffsetHz: 0,
        rfTuneCenterHz: 3_450_000_000,
        signalBandwidthHz: 100_000_000,
        nativeSampleRateHz: 122_880_000,
        payloadKind: 'derived-hardware-ready',
        qualification: 'derived-from-independently-verified-digital-baseband',
      }}
      busy={false}
      onChange={vi.fn()}
    />);
    expect(screen.getByText('derived hardware ready')).toBeTruthy();
    expect(screen.getByText(/3\.50001 GHz · operator translated/i)).toBeTruthy();
    expect(screen.getByText('Profile signal center')).toBeTruthy();
    expect(screen.getByText('Native RF reference')).toBeTruthy();
    expect(screen.getByText('Output RF tune center')).toBeTruthy();
  });

  it('surfaces Neptune P210 AD9361 ADC evidence and its dBFS-not-dBm power reference', () => {
    const props = captureProps();
    render(<IqWorkspace
      configuration={DEFAULT_COMPLEX_IQ_CONFIGURATION}
      capability={capability}
      preview={props.preview}
      captureMeta={{
        ...props.captureMeta,
        qualification: 'device-observed',
        adcSignificantBits: 12,
        adcFullScaleCode: 2048,
        powerReference: 'uncalibrated-dbfs-relative',
      }}
      busy={false}
      onChange={vi.fn()}
    />);
    expect(screen.getByText('AD9361 ADC evidence')).toBeTruthy();
    expect(screen.getByText(/12-bit · full scale 2048 · uncalibrated dbfs relative/i)).toBeTruthy();
  });

  it('distinguishes a staged receiver tune from the latest captured tune', () => {
    const props = captureProps();
    render(<IqWorkspace
      configuration={{ ...DEFAULT_COMPLEX_IQ_CONFIGURATION, centerHz: 101_000_000 }}
      capability={capability}
      {...props}
      busy={false}
      onChange={vi.fn()}
    />);

    expect(screen.getByText('Captured tune')).toBeTruthy();
    expect(screen.getByText(/Receiver tune is staged at 101 MHz/i).textContent).toMatch(/latest capture is still 100 MHz.*Single or Run/i);
  });

  it('omits Neptune ADC evidence for captures that never carried it (SignalLab, TinySA)', () => {
    render(<IqWorkspace
      configuration={DEFAULT_COMPLEX_IQ_CONFIGURATION}
      capability={capability}
      {...captureProps()}
      busy={false}
      onChange={vi.fn()}
    />);
    expect(screen.queryByText('AD9361 ADC evidence')).toBeNull();
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

  it('sustains bounded 4,096-point live updates without replacing canvases or growing the DOM', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    const recorder = installRecordingCanvas();
    try {
      const initial = stressPreview(0);
      const view = render(<IqWorkspace
        configuration={DEFAULT_COMPLEX_IQ_CONFIGURATION}
        capability={capability}
        preview={initial}
        captureMeta={stressCaptureMeta(0)}
        busy={false}
        onChange={vi.fn()}
      />);
      const originalCanvases = [
        ...view.container.querySelectorAll('canvas.iq-canvas'),
      ];
      expect(originalCanvases).toHaveLength(2);

      for (let phase = 1; phase <= 120; phase++) {
        for (const canvas of originalCanvases) {
          recorder.contextFor(canvas as HTMLCanvasElement)?.reset();
        }
        view.rerender(<IqWorkspace
          configuration={DEFAULT_COMPLEX_IQ_CONFIGURATION}
          capability={capability}
          preview={stressPreview(phase)}
          captureMeta={stressCaptureMeta(phase)}
          busy={false}
          onChange={vi.fn()}
        />);
        const canvases = [...view.container.querySelectorAll('canvas.iq-canvas')];
        expect(canvases).toEqual(originalCanvases);
        expect(view.container.querySelectorAll('.iq-workspace')).toHaveLength(1);
        expect(view.container.querySelectorAll('.iq-chart')).toHaveLength(2);
        for (const canvas of canvases) {
          const context = recorder.contextFor(canvas as HTMLCanvasElement);
          expect(context).toBeDefined();
          expect(allRecordedCoordinates(context!).every(Number.isFinite)).toBe(
            true,
          );
        }
      }
    } finally {
      recorder.restore();
    }
  }, 30_000);
});

function stressPreview(phase: number): ComplexIqPreview {
  const points = Array.from({ length: 4_096 }, (_, sampleIndex) => ({
    sampleIndex,
    i: Math.sin(sampleIndex * 0.013 + phase * 0.17),
    q: Math.cos(sampleIndex * 0.017 - phase * 0.11),
  }));
  return {
    points,
    inspectedSampleCount: points.length,
    rms: 1,
    peak: Math.SQRT2,
    dcI: 0,
    dcQ: 0,
  };
}

function stressCaptureMeta(phase: number): IqCaptureMeta {
  return {
    measurementId: `iq-live-${phase}`,
    sequence: phase + 1,
    centerHz: 100_000_000,
    sampleCount: 1_048_576,
    sampleRateHz: 56_000_000,
    sampleFormat: 'cf32le',
    qualification: 'analytic-complex-baseband',
  };
}
