// @vitest-environment jsdom
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarkerConfiguration, MarkerReading, Sweep, TraceBankConfiguration, TraceFrame } from '@tinysa/contracts';
import { ChannelAnalysisView } from './ChannelAnalysisView.js';
import { DetectWorkspace } from './DetectWorkspace.js';
import { MeasurementDock } from './MeasurementDock.js';
import { MetricStrip } from './MeasurementWorkspace.js';
import { SpectrumPlot } from './SpectrumPlot.js';
import { WaterfallView } from './WaterfallView.js';
import { installRecordingCanvas } from './canvas-test-recorder.js';

const sweep = {
  kind: 'spectrum', id: 'neptune-iq-1', sequence: 1, capturedAt: '2026-07-31T12:00:00.000Z', elapsedMilliseconds: 4,
  frequencyHz: [0, 25, 50, 75, 100], powerDbm: [-100, -90, -40, -90, -100],
  powerReference: 'uncalibrated-dbfs-relative',
  requested: {
    kind: 'swept-spectrum', startHz: 0, stopHz: 100, points: 5, sweepTimeSeconds: 0.004,
    controls: { schemaVersion: 1, model: 'host-derived-iq-projection', fftSize: 5, window: 'hann-periodic' },
  },
  actualStartHz: 0, actualStopHz: 100, actualRbwHz: 25, actualAttenuationDb: null,
  resolutionBandwidthQualification: 'host-derived-fft-bin', attenuationQualification: 'not-applicable',
  source: 'host-derived-from-complex-iq', complete: true,
  identity: {
    kind: 'instrument-session', sessionId: 'session-neptune', driverId: 'neptune-p210', candidateId: 'neptune-p210:ip:10.0.0.250',
    provenance: { sourceKind: 'neptune-p210', execution: 'physical', transport: 'libiio-network', qualification: 'device-observed', verifiedAt: '2026-07-31T12:00:00.000Z', endpoint: 'ip:10.0.0.250' },
  },
} satisfies Sweep;

const traces = [
  { id: 1, mode: 'clear-write', averageCount: 8 },
  { id: 2, mode: 'blank', averageCount: 8 },
  { id: 3, mode: 'blank', averageCount: 8 },
  { id: 4, mode: 'blank', averageCount: 8 },
] satisfies TraceBankConfiguration;
const frame = {
  traceId: 1, mode: 'clear-write', frequencyHz: sweep.frequencyHz, powerDbm: sweep.powerDbm,
  powerReference: sweep.powerReference, actualRbwHz: sweep.actualRbwHz,
  resolutionBandwidthQualification: sweep.resolutionBandwidthQualification,
  sweepCount: 1, sourceSweepId: sweep.id, evidence: 'host-derived',
} satisfies TraceFrame;
const markers = Array.from({ length: 8 }, (_, index) => ({
  id: index + 1, enabled: index === 0, traceId: 1, mode: 'normal', frequencyHz: 50, tracking: 'fixed',
})) as MarkerConfiguration[];
const reading = {
  markerId: 1, traceId: 1, mode: 'normal', binIndex: 2, frequencyHz: 50, powerDbm: -40,
  powerReference: 'uncalibrated-dbfs-relative',
  localCharacterization: {
    markerCenterMethod: 'fixed-frequency', markerFrequencyHz: 50, localPeakHz: 50, localPeakDbm: -40,
    componentThresholdDbm: -90, robustFloorDbm: -100, peakToRobustFloorDb: 60, prominenceDb: 50,
    requiredProminenceDb: 6, widthClassification: 'unavailable', componentRelationship: 'no-qualified-component',
    unavailableReason: 'no-qualified-local-component', evidence: 'host-derived-local-scalar-trace',
    qualification: 'observed-response-not-deconvolved-or-calibrated-snr',
  },
  sourceSweepId: sweep.id, evidence: 'host-derived',
} satisfies MarkerReading;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('uncalibrated derived-spectrum UI semantics', () => {
  it('keeps the compact peak and floor summaries on the same relative scale as the plot', () => {
    const metrics = render(<MetricStrip sweep={sweep} detections={0} acquisition="idle" historyCount={1}/>);
    expect(within(metrics.container).getAllByText(/dBFS \(relative\)$/)).toHaveLength(2);
    expect(metrics.container.textContent).not.toMatch(/dBm/);
  });

  it('labels Spectrum and Channel levels as dBFS-relative while keeping dB ratio analyses', () => {
    const recorder = installRecordingCanvas();
    try {
      const spectrum = render(<SpectrumPlot sweep={sweep} markers={[reading]} activeMarkerId={1} busy={false}/>);
      expect(within(spectrum.container).getByText('dBFS rel.')).toBeTruthy();
      expect(within(spectrum.container).getByText('UNCALIBRATED · dBFS RELATIVE')).toBeTruthy();
      expect(within(spectrum.container).getByText('-40.0 dBFS (relative)')).toBeTruthy();
      expect(within(spectrum.container).queryByText(/-40\.0 dBm/)).toBeNull();
      expect(within(spectrum.container).getByLabelText('Uncalibrated relative power by frequency')).toBeTruthy();
      spectrum.unmount();

      const channel = render(<ChannelAnalysisView
        sweep={sweep}
        configuration={{ centerHz: 50, mainBandwidthHz: 40, adjacentBandwidthHz: 20, channelSpacingHz: 30, adjacentChannelCount: 1, occupiedPowerPercent: 99, obwNoiseCorrection: 'robust-floor' }}
        display={{ referenceLevelDbm: -20, decibelsPerDivision: 10, divisions: 10 }}
        onConfiguration={vi.fn()}
      />);
      expect(within(channel.container).getByText('INTEGRATED RELATIVE LEVEL')).toBeTruthy();
      expect(within(channel.container).getAllByText(/dBFS.*relative/i).length).toBeGreaterThan(0);
      expect(within(channel.container).getAllByText(/dBc$/).length).toBeGreaterThan(0);
      expect(channel.container.textContent).not.toMatch(/dBm(?:\/Hz)?/);
    } finally { recorder.restore(); }
  });

  it('keeps relative waterfall history separate and labels its editable scale honestly', () => {
    const recorder = installRecordingCanvas();
    class TestImageData {
      readonly data: Uint8ClampedArray;
      constructor(readonly width: number, readonly height: number) { this.data = new Uint8ClampedArray(width * height * 4); }
    }
    vi.stubGlobal('ImageData', TestImageData);
    try {
      const calibrated = { ...sweep, id: 'calibrated', powerReference: undefined } satisfies Sweep;
      const view = render(<WaterfallView
        history={[sweep, calibrated]}
        configuration={{ historyDepth: 5, floorDbm: -120, ceilingDbm: -20, palette: 'atomic' }}
        onConfiguration={vi.fn()}
      />);
      expect(within(view.container).getAllByText('-120 dBFS rel.').length).toBeGreaterThan(0);
      expect(within(view.container).getAllByText('-20 dBFS rel.').length).toBeGreaterThan(0);
      expect(within(view.container).getByText(/1 \/ 5 COHERENT · 1 POWER REFERENCE CHANGE EXCLUDED/)).toBeTruthy();
      expect(within(view.container).getByLabelText('Uncalibrated relative power by frequency and sweep time')).toBeTruthy();
    } finally { recorder.restore(); }
  });

  it('disables calibrated-only detector and directional marker thresholds but leaves relative controls available', () => {
    const detector = render(<DetectWorkspace
      source="scalar" pending={false} sweep={sweep}
      detectionConfig={{ threshold: { strategy: 'absolute', levelDbm: -80 }, minimumBandwidthHz: 0, minimumProminenceDb: 6, minimumConsecutiveSweeps: 1, releaseAfterMissedSweeps: 1 }}
      detectorBusy={false} onDetectionConfig={vi.fn()} busy={false} onAcquireZero={vi.fn()}
    />);
    expect(within(detector.container).getByText(/Absolute dBm detection is unavailable/)).toBeTruthy();
    expect(within(detector.container).getByLabelText('Edit Absolute threshold').getAttribute('aria-disabled')).toBe('true');
    expect((within(detector.container).getByLabelText('Threshold mode') as HTMLSelectElement).disabled).toBe(false);
    expect(within(detector.container).getByText('-100.0 dBFS (relative)')).toBeTruthy();
    detector.unmount();

    const dock = render(<MeasurementDock
      traces={traces} frames={[frame]} firmwareFrames={[]} visibleFirmwareTraceIds={[]}
      onFirmwareTraceVisibility={vi.fn()} activeTraceId={1} onActiveTrace={vi.fn()}
      markers={markers} readings={[reading]} activeMarkerId={1}
      search={{ minimumLevelDbm: -90, minimumExcursionDb: 6 }}
      display={{ referenceLevelDbm: -20, decibelsPerDivision: 10, divisions: 10 }}
      onTrace={vi.fn()} onTraceReset={vi.fn()} onMarker={vi.fn()} onActiveMarker={vi.fn()}
      onSearch={vi.fn()} onSearchConfiguration={vi.fn()} onDisplay={vi.fn()} onAutoScale={vi.fn()}
    />);
    expect(within(dock.container).getByText('-40.0 dBFS (relative)')).toBeTruthy();
    expect((within(dock.container).getByRole('button', { name: /Previous/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dock.container).getByRole('button', { name: /Next/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dock.container).getByLabelText('Edit Minimum level').getAttribute('aria-disabled')).toBe('true');
    expect((within(dock.container).getByRole('button', { name: /^Peak$/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
