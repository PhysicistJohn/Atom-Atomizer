// @vitest-environment jsdom
import { cleanup, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DetectedSignal, Sweep } from '@tinysa/contracts';
import { ChannelAnalysisView } from './ChannelAnalysisView.js';
import { SpectrumPlot } from './SpectrumPlot.js';
import { WaterfallView } from './WaterfallView.js';
import { detectionCenterStrokes, flushPlotFrame, installRecordingCanvas } from './canvas-test-recorder.js';

const sweep = {
  kind: 'spectrum',
  id: 'sweep-1',
  sequence: 1,
  capturedAt: '2026-07-11T00:00:01.000Z',
  elapsedMilliseconds: 40,
  actualStartHz: 0,
  actualStopHz: 100,
  frequencyHz: [0, 25, 50, 75, 100],
  powerDbm: [-100, -90, -40, -90, -100],
  requested: {
    kind: 'swept-spectrum', startHz: 0, stopHz: 100, points: 5, sweepTimeSeconds: 'auto',
    controls: {
      schemaVersion: 1, model: 'receiver', acquisitionFormat: 'text', resolutionBandwidthKhz: 'auto', attenuationDb: 'auto',
      detector: 'sample', spurRejection: 'auto', lowNoiseAmplifier: 'off', avoidSpurs: 'auto', trigger: { mode: 'auto' },
    },
  },
  actualRbwHz: 10,
  actualAttenuationDb: 0,
  source: 'scan-text',
  complete: true,
  identity: {
    model: 'tinySA Ultra+ ZS407', hardwareVersion: 'test', firmwareVersion: 'test', firmwareQualification: 'protocol-test',
    port: { id: 'test', path: 'test://device', usbMatch: 'protocol-test-double', transport: 'protocol-test-double', execution: 'protocol-test-double' },
    simulated: true, usbIdentityVerified: false, execution: 'protocol-test-double',
  },
} satisfies Sweep;

const detectionSourceSweep = {
  ...sweep,
  frequencyHz: [0, 20, 30, 40, 100],
  powerDbm: [-100, -90, -40, -90, -100],
} satisfies Sweep;

const detectionBayesianEvidence = {
  modelId: 'fixture', posteriorScope: 'track-state', priorSignalProbability: 0.01, posteriorSignalProbability: 0.999,
  logBayesFactor: 40, effectiveIndependentBins: 3, effectiveReferenceCells: 12, noiseShape: 1,
  posteriorPredictiveNullProbability: 1e-9, targetPosteriorPredictiveNullProbability: 0.001,
  targetSweepFalseAlarmProbability: 0.001, multiplicityAdjustedTests: 1,
  testedRegionStartHz: 20, testedRegionStopHz: 40,
  qualification: 'ideal-exponential-not-physically-calibrated',
  noiseSigmaDb: 1.5, observedMeanShiftDb: 50, looks: 3,
} as const;

const detection = {
  id: 'signal-1',
  startHz: 20,
  stopHz: 40,
  peakHz: 30,
  peakDbm: -40,
  prominenceDb: 50,
  prominenceThresholdDb: 6,
  bandwidthHz: 20,
  thresholdDbm: -80,
  noiseFloorDbm: -100,
  firstSeenAt: '2026-07-11T00:00:00.000Z',
  lastSeenAt: '2026-07-11T00:00:01.000Z',
  sweepIds: ['sweep-1'],
  persistenceSweeps: 3,
  missedSweeps: 0,
  state: 'active',
  detectorId: 'robust-prominence-v1',
  detectorConfig: {
    threshold: { strategy: 'noise-relative', marginDb: 10 },
    minimumProminenceDb: 6,
    minimumBandwidthHz: 0,
    minimumConsecutiveSweeps: 2,
    releaseAfterMissedSweeps: 2,
  },
  bayesianEvidence: detectionBayesianEvidence,
  classificationRegionObservation: {
    sourceSweep: detectionSourceSweep,
    startHz: 20,
    stopHz: 40,
    peakHz: 30,
    detectorId: 'robust-prominence-v1',
    localBayesianEvidence: detectionBayesianEvidence,
  },
  localClassificationObservations: [{
    sourceSweep: detectionSourceSweep,
    startHz: 20,
    stopHz: 40,
    peakHz: 30,
    detectorId: 'robust-prominence-v1',
    localBayesianEvidence: detectionBayesianEvidence,
  }],
  qualityFlags: [],
} satisfies DetectedSignal;

afterEach(cleanup);

describe('analysis visual contracts', () => {
  it('shows narrow CW width as resolution-limited while retaining separately labeled percent-power OBW', () => {
    const view = render(<ChannelAnalysisView
      sweep={sweep}
      configuration={{
        centerHz: 50,
        mainBandwidthHz: 40,
        adjacentBandwidthHz: 20,
        channelSpacingHz: 30,
        adjacentChannelCount: 1,
        occupiedPowerPercent: 99,
        obwNoiseCorrection: 'robust-floor',
      }}
      display={{ referenceLevelDbm: -20, decibelsPerDivision: 10, divisions: 10 }}
      onConfiguration={vi.fn()}
    />);

    expect(within(view.container).getByText('3 dB BANDWIDTH')).toBeTruthy();
    expect(within(view.container).getByText('Resolution-limited')).toBeTruthy();
    expect(within(view.container).getByText(/RBW\/grid 25 Hz/i)).toBeTruthy();
    expect(within(view.container).getByLabelText(/3 dB bandwidth resolution-limited; response [\d.]+ Hz; RBW\/grid 25 Hz/i)).toBeTruthy();
    expect(within(view.container).getByText('OCCUPIED BANDWIDTH · 99%')).toBeTruthy();
    expect(view.container.querySelector('.three-db-window')).not.toBeNull();
  });

  it('renders detection geometry only when the owning workspace enables it', async () => {
    const recorder = installRecordingCanvas();
    try {
      const view = render(<SpectrumPlot sweep={sweep} detections={[detection]} busy={false}/>);
      await flushPlotFrame();
      expect(within(view.container).getByLabelText('Spectrum plot').getAttribute('aria-description'))
        .toBe('sweepId=sweep-1; sequence=1');
      const canvas = within(view.container).getByLabelText('Measured power by frequency') as HTMLCanvasElement;
      const context = recorder.contextFor(canvas);
      if (!context) throw new Error('Expected the spectrum canvas draw recording');
      expect(context.fillRects).toHaveLength(0);
      expect(detectionCenterStrokes(context, 430)).toHaveLength(0);

      context.reset();
      view.rerender(<SpectrumPlot sweep={sweep} detections={[detection]} detectionOverlay selectedDetectionId={detection.id} busy={false}/>);
      await flushPlotFrame();
      const band = context.fillRects.find((rect) => rect.height === 430);
      expect(band?.x).toBe(240);
      expect(band?.width).toBe(240);
      const centers = detectionCenterStrokes(context, 430);
      expect(centers).toHaveLength(1);
      expect(centers[0]!.segments[0]!.x1).toBe(360);
      expect(centers[0]!.segments[0]!.x2).toBe(360);
      // The selected target paints the highlighted band fill and a solid
      // full-weight center line rather than the passive dashed style.
      expect(band?.fillStyle).toBe('rgba(10,132,255,.17)');
      expect(centers[0]!.lineDash).toHaveLength(0);
      expect(centers[0]!.lineWidth).toBeCloseTo(2.2, 10);
    } finally { recorder.restore(); }
  });

  it('publishes DEV waterfall render evidence during the existing canvas paint', async () => {
    const context = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      putImageData: vi.fn(),
      imageSmoothingEnabled: true,
    };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const previousImageData = (globalThis as { ImageData?: unknown }).ImageData;
    class TestImageData {
      readonly data: Uint8ClampedArray;
      constructor(readonly width: number, readonly height: number) {
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    }
    vi.stubGlobal('ImageData', TestImageData);
    try {
      const older = {
        ...sweep,
        id: 'sweep-0',
        sequence: 0,
        powerDbm: [-110, -95, -65, -85, -105],
      } satisfies Sweep;
      const view = render(<WaterfallView
        history={[sweep, older]}
        configuration={{ historyDepth: 35, floorDbm: -120, ceilingDbm: -20, palette: 'atomic' }}
        onConfiguration={vi.fn()}
      />);
      const canvas = within(view.container).getByLabelText('Measured power by frequency and sweep time');
      await waitFor(() => expect(canvas.getAttribute('aria-description'))
        .toMatch(/rows=2; bins=5; colors=2; minDbm=-110; maxDbm=-40/u));
      // One background fill plus one 1px LUT row per coherent sweep into the
      // ring, composited once as a scaled drawImage instead of per-cell rects.
      expect(context.fillRect).toHaveBeenCalledTimes(1);
      expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1_200, 560);
      expect(context.putImageData).toHaveBeenCalledTimes(2);
      expect(context.drawImage).toHaveBeenCalledTimes(1);
      expect(context.stroke).toHaveBeenCalledTimes(11);
    } finally {
      getContext.mockRestore();
      vi.stubGlobal('ImageData', previousImageData);
      vi.unstubAllGlobals();
    }
  });
});
