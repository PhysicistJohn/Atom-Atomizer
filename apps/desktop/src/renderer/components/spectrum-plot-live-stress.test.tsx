// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readMarkers } from '@tinysa/analysis';
import type { DeviceIdentity, MarkerReading, Sweep, TraceFrame } from '@tinysa/contracts';
import { ChannelAnalysisView } from './ChannelAnalysisView.js';
import { SpectrumPlot } from './SpectrumPlot.js';
import {
  allRecordedCoordinates,
  installRecordingCanvas,
  polylineStrokes,
  type RecordingContext2D,
} from './canvas-test-recorder.js';

const recorders: { restore(): void }[] = [];
function recordCanvas() {
  const recorder = installRecordingCanvas();
  recorders.push(recorder);
  return recorder;
}
afterEach(() => {
  cleanup();
  for (const recorder of recorders.splice(0)) recorder.restore();
  vi.unstubAllGlobals();
});

// Draws run synchronously when requestAnimationFrame is unavailable; the
// churn tests exercise that latest-wins fallback deterministically.
function useSynchronousDraws(): void {
  vi.stubGlobal('requestAnimationFrame', undefined);
}

const identity: DeviceIdentity = {
  model: 'Renderer geometry fixture',
  hardwareVersion: 'renderer-stress',
  firmwareVersion: 'renderer-stress',
  firmwareQualification: 'protocol-test',
  port: {
    id: 'spectrum-live-stress',
    path: 'test://spectrum-live-stress',
    usbMatch: 'protocol-test-double',
    transport: 'protocol-test-double',
    execution: 'protocol-test-double',
  },
  simulated: true,
  usbIdentityVerified: false,
  execution: 'protocol-test-double',
};

// These are deliberately non-physical renderer geometries, not waveform or
// standards models. Standards-bearing test signals live in SignalLab's
// canonical corpus and enter Atomizer through its versioned driver boundary.
type StressShape =
  | 'narrow-line'
  | 'symmetric-sidebands'
  | 'multitone-comb'
  | 'flat-plateau'
  | 'notched-plateau'
  | 'shouldered-plateau'
  | 'sparse-multipeak';

describe('SpectrumPlot sustained live rendering', () => {
  it('reconciles varied narrow, multipeak, and wideband frames without stale geometry or DOM growth', () => {
    useSynchronousDraws();
    const recorder = recordCanvas();
    const shapes: readonly StressShape[] = [
      'narrow-line',
      'symmetric-sidebands',
      'multitone-comb',
      'flat-plateau',
      'notched-plateau',
      'shouldered-plateau',
      'sparse-multipeak',
    ];
    const initial = stressFrame(shapes[0]!, 0);
    const view = render(<SpectrumPlot sweep={initial.sweep} traces={[initial.frame]} markers={[initial.marker]} activeMarkerId={1} busy={false}/>);
    const originalCanvas = view.container.querySelector('canvas[aria-label="Measured power by frequency"]');
    expect(originalCanvas).not.toBeNull();
    const context = recorder.contextFor(originalCanvas as HTMLCanvasElement);
    if (!context) throw new Error('Expected the live spectrum canvas context');
    let priorPoints = '';

    for (let update = 0; update < 210; update++) {
      const fixture = stressFrame(shapes[update % shapes.length]!, update);
      context.reset();
      view.rerender(<SpectrumPlot sweep={fixture.sweep} traces={[fixture.frame]} markers={[fixture.marker]} activeMarkerId={1} busy={update % 2 === 0}/>);

      const canvas = view.container.querySelector('canvas[aria-label="Measured power by frequency"]');
      expect(canvas).toBe(originalCanvas);
      expect(view.container.querySelectorAll('canvas')).toHaveLength(1);
      expect(view.container.querySelector('svg[aria-label="Measured power by frequency"]')).toBeNull();
      const traces = polylineStrokes(context);
      expect(traces).toHaveLength(1);
      expect(context.pathFills).toHaveLength(1);
      const points = traceChainCoordinates(traces[0]!).join(' ');
      expect(traces[0]!.segments).toHaveLength(fixture.frame.frequencyHz.length - 1);
      expect(points).not.toBe(priorPoints);
      expectFiniteCanvasGeometry(context);
      expect(view.container.querySelectorAll('.plot-panel')).toHaveLength(1);
      expect(view.container.querySelectorAll('.plot-marker-overlay')).toHaveLength(1);
      expect(view.container.querySelectorAll('.plot-marker-overlay-item')).toHaveLength(1);
      expect(view.container.querySelector('.plot-marker-overlay-item')?.getAttribute('data-marker-label-placement')).toBe('above');
      const gutter = view.container.querySelector('.marker-readout-gutter');
      expect(gutter).not.toBeNull();
      expect((canvas as HTMLCanvasElement).contains(gutter)).toBe(false);
      expect(gutter?.nextElementSibling?.classList.contains('plot-canvas')).toBe(true);
      priorPoints = points;
    }
  }, 20_000);

  it('quarantines malformed updates, removes stale geometry, and recovers on the next valid frame', () => {
    useSynchronousDraws();
    const recorder = recordCanvas();
    const valid = stressFrame('narrow-line', 0);
    const view = render(<SpectrumPlot sweep={valid.sweep} traces={[valid.frame]} busy={false}/>);
    const canvas = view.container.querySelector('canvas[aria-label="Measured power by frequency"]');
    const context = recorder.contextFor(canvas as HTMLCanvasElement);
    if (!context) throw new Error('Expected the live spectrum canvas context');
    const defects: readonly TraceFrame[] = [
      { ...valid.frame, powerDbm: valid.frame.powerDbm.map((value, index) => index === 20 ? Number.NaN : value) },
      { ...valid.frame, frequencyHz: valid.frame.frequencyHz.map((value, index) => index === 30 ? Number.POSITIVE_INFINITY : value) },
      { ...valid.frame, powerDbm: valid.frame.powerDbm.slice(1) },
      { ...valid.frame, frequencyHz: valid.frame.frequencyHz.map((value, index) => index === 40 ? valid.frame.frequencyHz[39]! : value) },
    ];

    for (const frame of defects) {
      context.reset();
      view.rerender(<SpectrumPlot sweep={valid.sweep} traces={[frame]} busy={false}/>);
      expect(polylineStrokes(context)).toHaveLength(0);
      expect(context.pathFills).toHaveLength(0);
      expectFiniteCanvasGeometry(context);

      const recovered = stressFrame('shouldered-plateau', frame.frequencyHz.length);
      context.reset();
      view.rerender(<SpectrumPlot sweep={recovered.sweep} traces={[recovered.frame]} busy={false}/>);
      expect(polylineStrokes(context)).toHaveLength(1);
      expect(context.pathFills).toHaveLength(1);
      expectFiniteCanvasGeometry(context);
    }
  });

  it('clips wider physical grids to the visible sweep instead of emitting off-viewport coordinates', () => {
    useSynchronousDraws();
    const recorder = recordCanvas();
    const fixture = stressFrame('flat-plateau', 0);
    const frame: TraceFrame = {
      ...fixture.frame,
      frequencyHz: [-50, 0, 25, 50, 75, 100, 150],
      powerDbm: [-100, -90, -60, -40, -60, -90, -100],
    };
    const view = render(<SpectrumPlot sweep={fixture.sweep} traces={[frame]} busy={false}/>);
    const canvas = view.container.querySelector('canvas[aria-label="Measured power by frequency"]');
    const context = recorder.contextFor(canvas as HTMLCanvasElement);
    if (!context) throw new Error('Expected the live spectrum canvas context');
    const traces = polylineStrokes(context);
    expect(traces).toHaveLength(1);
    const tracePoints = traceChainPoints(traces[0]!);
    expect(tracePoints).toHaveLength(5);
    const polygonPoints = context.pathFills[0]?.segments.flatMap((segment) => [segment.x1, segment.x2]) ?? [];
    for (const x of [...tracePoints, ...polygonPoints]) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1_200);
    }
  });

  it('uses instance-local canvas resources when more than one live plot is mounted', () => {
    useSynchronousDraws();
    const recorder = recordCanvas();
    const fixture = stressFrame('notched-plateau', 0);
    const view = render(<div>
      <SpectrumPlot sweep={fixture.sweep} traces={[fixture.frame]} busy={false}/>
      <SpectrumPlot sweep={{ ...fixture.sweep, id: 'second-sweep' }} traces={[{ ...fixture.frame, sourceSweepId: 'second-sweep' }]} busy={false}/>
    </div>);
    const plots = [...view.container.querySelectorAll('canvas[aria-label="Measured power by frequency"]')];
    expect(plots).toHaveLength(2);
    const contexts = plots.map((plot) => recorder.contextFor(plot as HTMLCanvasElement));
    expect(new Set(contexts).size).toBe(2);
    for (const context of contexts) {
      if (!context) throw new Error('Expected a per-instance canvas context');
      expect(polylineStrokes(context)).toHaveLength(1);
      expect(context.gradients).toHaveLength(1);
      expect(context.pathFills).toHaveLength(1);
      expect(context.pathFills[0]!.fillStyle).toBe(context.gradients[0]);
    }
  });

  it('replaces marker pointer callbacks during churn instead of retaining stale handlers', () => {
    useSynchronousDraws();
    recordCanvas();
    const fixture = stressFrame('sparse-multipeak', 0);
    const handlers = Array.from({ length: 80 }, () => vi.fn(() => true));
    const view = render(<SpectrumPlot sweep={fixture.sweep} traces={[fixture.frame]} busy={false} onMarkerPlace={handlers[0]}/>);
    for (let index = 1; index < handlers.length; index++) {
      const updated = stressFrame('sparse-multipeak', index);
      view.rerender(<SpectrumPlot sweep={updated.sweep} traces={[updated.frame]} busy={false} onMarkerPlace={handlers[index]}/>);
    }
    const canvas = view.container.querySelector('canvas[aria-label="Measured power by frequency"]');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Expected live spectrum canvas');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 1_200, top: 0, bottom: 430, width: 1_200, height: 430, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.pointerDown(canvas, { clientX: 600, clientY: 200 });

    expect(handlers.at(-1)).toHaveBeenCalledOnce();
    expect(handlers.slice(0, -1).every((handler) => handler.mock.calls.length === 0)).toBe(true);
  });

  it('projects Channel samples by physical frequency and recovers after an invalid live frame', () => {
    const fixture = stressFrame('narrow-line', 0);
    const sweep = {
      ...fixture.sweep,
      frequencyHz: [0, 10, 30, 100],
      powerDbm: [-100, -80, -40, -100],
    } satisfies Sweep;
    const props = {
      configuration: {
        centerHz: 50,
        mainBandwidthHz: 40,
        adjacentBandwidthHz: 20,
        channelSpacingHz: 30,
        adjacentChannelCount: 1 as const,
        occupiedPowerPercent: 99,
        obwNoiseCorrection: 'robust-floor' as const,
      },
      display: { referenceLevelDbm: -20, decibelsPerDivision: 10, divisions: 10 } as const,
      onConfiguration: vi.fn(),
    };
    const view = render(<ChannelAnalysisView sweep={sweep} {...props}/>);
    const points = view.container.querySelector('.channel-plot-shell .trace-line')?.getAttribute('points')?.split(' ')
      .map((point) => Number(point.split(',')[0]));
    expect(points).toEqual([0, 100, 300, 1_000]);

    view.rerender(<ChannelAnalysisView sweep={{ ...sweep, powerDbm: [-100, Number.NaN, -40, -100] }} {...props}/>);
    expect(view.container.querySelector('svg[aria-label="Channel measurement spectrum"]')).toBeNull();
    expect(view.container.textContent).toContain('Spectrum unavailable');

    view.rerender(<ChannelAnalysisView sweep={sweep} {...props}/>);
    expect(view.container.querySelectorAll('.channel-plot-shell .trace-line')).toHaveLength(1);
    expectFiniteSvgGeometry(view.container.querySelector('svg[aria-label="Channel measurement spectrum"]') as SVGElement);
  });
});

function traceChainPoints(stroke: { segments: readonly { x1: number; x2: number }[] }): number[] {
  return [stroke.segments[0]!.x1, ...stroke.segments.map((segment) => segment.x2)];
}

function traceChainCoordinates(stroke: { segments: readonly { x1: number; y1: number; x2: number; y2: number }[] }): string[] {
  return [
    `${stroke.segments[0]!.x1},${stroke.segments[0]!.y1}`,
    ...stroke.segments.map((segment) => `${segment.x2},${segment.y2}`),
  ];
}

function expectFiniteCanvasGeometry(context: RecordingContext2D): void {
  for (const value of allRecordedCoordinates(context)) {
    expect(Number.isFinite(value)).toBe(true);
  }
}

function stressFrame(shape: StressShape, phase: number): { sweep: Sweep; frame: TraceFrame; marker: MarkerReading } {
  const frequencyHz = Array.from({ length: 257 }, (_, index) => index / 256 * 100);
  const powerDbm = frequencyHz.map((frequency) => stressPower(shape, frequency, phase));
  const sweep: Sweep = {
    kind: 'spectrum',
    id: `stress-sweep-${phase}`,
    sequence: phase + 1,
    capturedAt: '2026-07-17T00:00:00.000Z',
    elapsedMilliseconds: 20,
    frequencyHz,
    powerDbm,
    requested: {
      kind: 'swept-spectrum',
      startHz: 0,
      stopHz: 100,
      points: frequencyHz.length,
      sweepTimeSeconds: 'auto',
      controls: {
        schemaVersion: 1,
        model: 'receiver',
        acquisitionFormat: 'text',
        resolutionBandwidthKhz: 1,
        attenuationDb: 'auto',
        detector: 'sample',
        spurRejection: 'auto',
        lowNoiseAmplifier: 'off',
        avoidSpurs: 'auto',
        trigger: { mode: 'auto' },
      },
    },
    actualStartHz: 0,
    actualStopHz: 100,
    actualRbwHz: 1,
    actualAttenuationDb: 0,
    source: 'scan-text',
    complete: true,
    identity,
  };
  const frame: TraceFrame = {
    traceId: 1,
    mode: 'clear-write',
    frequencyHz,
    powerDbm,
    actualRbwHz: 1,
    sweepCount: 1,
    sourceSweepId: sweep.id,
    evidence: 'host-derived',
  };
  const marker = readMarkers([{
    id: 1,
    enabled: true,
    traceId: 1,
    mode: 'normal',
    frequencyHz: 50 + phase % 11 * 0.07,
    tracking: 'fixed',
  }], [frame])[0];
  if (!marker) throw new Error('Renderer stress fixture did not produce a marker');
  return { sweep, frame, marker };
}

function stressPower(shape: StressShape, frequency: number, phase: number): number {
  const drift = phase % 11 * 0.07;
  const gaussian = (center: number, width: number, height: number) => height * Math.exp(-0.5 * ((frequency - center - drift) / width) ** 2);
  const ripple = 1.5 * Math.sin(frequency * 0.43 + phase * 0.31);
  const excess = (() => {
    switch (shape) {
      case 'narrow-line': return gaussian(50, 0.35, 68);
      case 'symmetric-sidebands': return gaussian(50, 0.45, 62) + gaussian(44, 0.7, 28) + gaussian(56, 0.7, 28);
      case 'multitone-comb': return [38, 44, 50, 56, 62].reduce((sum, center, index) => sum + gaussian(center, 0.8, 35 + (index === 2 ? 15 : 0)), 0);
      case 'flat-plateau': return Math.abs(frequency - 50 - drift) <= 22 ? 48 + ripple : 0;
      case 'notched-plateau': return Math.abs(frequency - 50 - drift) <= 28 ? 51 + ripple - gaussian(50, 1.2, 18) : 0;
      case 'shouldered-plateau': return Math.abs(frequency - 50 - drift) <= 18 ? 46 + ripple + gaussian(34, 1.8, 7) + gaussian(66, 1.8, 7) : 0;
      case 'sparse-multipeak': return [22, 37, 61, 79].reduce((sum, center, index) => sum + gaussian(center + phase % 3, 0.9, 34 + index * 3), 0);
    }
  })();
  return Math.min(-20, -105 + excess + 0.9 * Math.sin(frequency * 1.7 + phase));
}

function expectFiniteSvgGeometry(svg: SVGElement): void {
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of element.getAttributeNames()) {
      expect(element.getAttribute(attribute)).not.toMatch(/(?:NaN|Infinity)/);
    }
  }
}
