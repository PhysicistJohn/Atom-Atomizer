// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalInstrumentSurface, InstrumentMeasurement } from '@tinysa/contracts';
import {
  previewComplexIq,
  type ComplexIqPreview,
} from '../complex-iq.js';
import {
  allRecordedCoordinates,
  installRecordingCanvas,
} from './canvas-test-recorder.js';
import { IqWorkspace, type IqCaptureMeta } from './IqWorkspace.js';

const canonicalCaptureSurface = {
  schemaVersion: 1,
  revision: 'iq-canonical-surface-1',
  presentation: {
    title: 'Connected instrument',
    qualification: 'DRIVER DECLARED',
    facts: [],
  },
  parameters: [{
    id: 'capture.tune',
    label: 'Receiver center',
    group: 'Capture',
    unit: 'Hz',
    manual: { kind: 'integer', range: { min: 1_000_000, max: 6_000_000_000, step: 1 } },
    auto: { resolver: 'driver', description: 'Chooses the active receive target.' },
    requested: { mode: 'auto' },
    effectiveValue: 100_000_000,
    verification: 'device-readback',
  }],
  operations: [{
    id: 'capture',
    label: 'Capture',
    scope: 'acquisition',
    acquisitionKind: 'complex-iq',
    parameterIds: ['capture.tune'],
    outputs: ['Complex samples'],
    availability: 'available',
    primary: true,
    confirmation: 'none',
  }],
} satisfies CanonicalInstrumentSurface;

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
  it('renders and immediately applies only the driver-declared canonical capture operation', () => {
    const onCanonicalOperation = vi.fn();
    render(<IqWorkspace
      busy={false}
      canonicalSurface={canonicalCaptureSurface}
      onCanonicalOperation={onCanonicalOperation}
    />);

    expect(screen.queryByRole('combobox', { name: /mode$/i })).toBeNull();
    const setting = screen.getByLabelText('Edit Receiver center');
    fireEvent.click(setting);
    const editor = screen.getByRole('dialog', { name: 'Receiver center numeric entry' });
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(editor.isConnected).toBe(false);
    expect(screen.queryByRole('radiogroup', { name: /setting mode/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply settings' })).toBeNull();
    expect(onCanonicalOperation).toHaveBeenCalledWith('capture', [
      { parameterId: 'capture.tune', intent: { mode: 'auto' } },
    ]);
  });

  it('shows only complex-I/Q controls when a driver declares multiple result shapes', () => {
    const mixedSurface: CanonicalInstrumentSurface = {
      ...canonicalCaptureSurface,
      revision: 'iq-canonical-surface-2',
      operations: [
        canonicalCaptureSurface.operations[0]!,
        {
          id: 'spectrum',
          label: 'Sweep',
          scope: 'acquisition',
          acquisitionKind: 'swept-spectrum',
          parameterIds: ['capture.tune'],
          outputs: ['Spectrum'],
          availability: 'available',
          primary: false,
          confirmation: 'none',
        },
      ],
    };
    render(<IqWorkspace
      busy={false}
      canonicalSurface={mixedSurface}
      onCanonicalOperation={vi.fn()}
    />);

    expect(screen.getByRole('heading', { name: 'Capture', level: 2 })).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: 'Instrument operation' })).toBeNull();
    expect(screen.queryByText('Sweep')).toBeNull();
  });

  it('fails closed to a generic driver-required state instead of rendering legacy mutable setup', () => {
    render(<IqWorkspace busy={false}/>);

    expect(screen.getByRole('status', { name: 'I/Q capture controls unavailable' })).toBeTruthy();
    expect(screen.getByText('DRIVER REQUIRED')).toBeTruthy();
    expect(screen.queryByLabelText('Edit Receiver tune')).toBeNull();
    expect(screen.queryByLabelText('Edit Sample rate')).toBeNull();
    expect(screen.queryByLabelText('Edit Capture bandwidth')).toBeNull();
    expect(screen.queryByLabelText('Edit Complex samples')).toBeNull();
  });

  it('renders bounded time/constellation previews and delegates acquisition to the canonical surface', () => {
    const view = render(<IqWorkspace
      {...captureProps()}
      busy={false}
    />);

    expect(screen.getByLabelText(/I and Q sample amplitude/i)).toBeTruthy();
    expect(screen.getByLabelText(/Complex I Q constellation/i)).toBeTruthy();
    expect(screen.getByText(/Capture iq-capture-1/i)).toBeTruthy();
    expect(screen.getByText(/analytic complex baseband/i)).toBeTruthy();
    expect(screen.getAllByText('0.00 dBFS')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Capture I\/Q/i })).toBeNull();
    const workspace = screen.getByRole('region', { name: 'Complex I/Q workspace' });
    expect(workspace.getAttribute('aria-description'))
      .toBe('captureId=iq-capture-1; sequence=1; centerHz=100000000');
    expect(view.container.querySelector('[data-agent-exclusion="human-iq-capture-boundary"]')).toBe(workspace);
    expect(view.container.querySelector('[data-agent-control]')).toBeNull();
  });

  it('offers byte-exact SigMF export only after a capture exists', () => {
    const onExport = vi.fn();
    const view = render(<IqWorkspace
      busy={false}
      onExport={onExport}
    />);
    expect((screen.getByRole('button', { name: 'Export SigMF' }) as HTMLButtonElement).disabled).toBe(true);

    view.rerender(<IqWorkspace
      {...captureProps()}
      busy={false}
      onExport={onExport}
    />);
    const exportButton = screen.getByRole('button', { name: 'Export SigMF' }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(false);
    fireEvent.click(exportButton);
    expect(onExport).toHaveBeenCalledOnce();
  });

  it('identifies only while classification is pending and explains a short capture result', () => {
    const props = captureProps();
    const view = render(<IqWorkspace
      {...props}
      classificationPending
      busy={false}
    />);
    expect(screen.getByText('Identifying…')).toBeTruthy();

    view.rerender(<IqWorkspace
      {...props}
      classificationPending={false}
      classificationIssue={{
        kind: 'unavailable',
        message: 'Modulation classification requires at least 4,096 complex samples. Acquire a longer capture.',
      }}
      busy={false}
    />);
    expect(screen.queryByText('Identifying…')).toBeNull();
    expect(screen.getByText(/at least 4,096 complex samples.*Acquire a longer capture/i)).toBeTruthy();
  });

  it('fits both plots by default and provides bounded keyboard-accessible zoom and reset controls', () => {
    const view = render(<IqWorkspace
      {...captureProps()}
      busy={false}
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

  it('sustains bounded 4,096-point live updates without replacing canvases or growing the DOM', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    const recorder = installRecordingCanvas();
    try {
      const initial = stressPreview(0);
      const view = render(<IqWorkspace
        preview={initial}
        captureMeta={stressCaptureMeta(0)}
        busy={false}
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
          preview={stressPreview(phase)}
          captureMeta={stressCaptureMeta(phase)}
          busy={false}
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
    sampleFormat: 'ci16le',
    qualification: 'analytic-complex-baseband',
  };
}
