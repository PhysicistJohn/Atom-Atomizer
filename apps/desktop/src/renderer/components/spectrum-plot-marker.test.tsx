// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DeviceIdentity, FirmwareTraceFrame, MarkerReading, Sweep, TraceFrame } from '@tinysa/contracts';
import { readMarkers } from '@tinysa/analysis';
import { ClassificationWorkspace } from './ClassificationWorkspace.js';
import { SpectrumPlot, markerOverlayPlacement } from './SpectrumPlot.js';

afterEach(cleanup);

const identity: DeviceIdentity = {
  model: 'SignalLab',
  hardwareVersion: 'test',
  firmwareVersion: 'test',
  firmwareQualification: 'protocol-test',
  port: {
    id: 'spectrum-marker-layout',
    path: 'test://spectrum-marker-layout',
    usbMatch: 'protocol-test-double',
    transport: 'protocol-test-double',
    execution: 'protocol-test-double',
  },
  simulated: true,
  usbIdentityVerified: false,
  execution: 'protocol-test-double',
};

describe('SpectrumPlot signal-aware marker layout', () => {
  it('acknowledges an Atom pointer placement only after the exact marker frequency commits', () => {
    const fixture = markerFixture(50_001);
    const onMarkerPlace = vi.fn(() => true);
    render(<SpectrumPlot sweep={fixture.sweep} traces={[fixture.frame]} busy={false} onMarkerPlace={onMarkerPlace}/>);
    const svg = screen.getByLabelText('Measured power by frequency');
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 900,
      top: 50,
      bottom: 450,
      width: 800,
      height: 400,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    });
    const token = '123e4567-e89b-42d3-a456-426614174000';
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 });
    Object.defineProperty(event, '__tinysaAtomMarkerRequestV1', {
      value: { token },
      configurable: false,
      enumerable: false,
      writable: false,
    });

    fireEvent(svg, event);

    expect(onMarkerPlace).toHaveBeenCalledWith(25_001);
    expect((event as MouseEvent & { __tinysaAtomMarkerResultV1?: unknown }).__tinysaAtomMarkerResultV1)
      .toEqual({ token, accepted: true, frequencyHz: 25_001 });
  });

  it('returns a negative Atom acknowledgement when the marker state rejects the frequency', () => {
    const fixture = markerFixture(50_001);
    const onMarkerPlace = vi.fn(() => false);
    render(<SpectrumPlot sweep={fixture.sweep} traces={[fixture.frame]} busy={false} onMarkerPlace={onMarkerPlace}/>);
    const svg = screen.getByLabelText('Measured power by frequency');
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 1_000,
      top: 0,
      bottom: 430,
      width: 1_000,
      height: 430,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 500, clientY: 200 });
    Object.defineProperty(event, '__tinysaAtomMarkerRequestV1', {
      value: { token: '123e4567-e89b-42d3-a456-426614174000' },
    });

    fireEvent(svg, event);

    expect(onMarkerPlace).toHaveBeenCalledWith(50_001);
    expect((event as MouseEvent & { __tinysaAtomMarkerResultV1?: unknown }).__tinysaAtomMarkerResultV1)
      .toEqual({ token: '123e4567-e89b-42d3-a456-426614174000', accepted: false, frequencyHz: undefined });
  });

  it.each([
    { position: 'left', centerHz: 20_001 },
    { position: 'center', centerHz: 50_001 },
    { position: 'right', centerHz: 96_001 },
  ] as const)('keeps the active card in a reserved sibling gutter and raises the $position diamond/tag above the trace', ({ centerHz }) => {
    const fixture = markerFixture(centerHz);
    render(<SpectrumPlot sweep={fixture.sweep} traces={[fixture.frame]} markers={[fixture.reading]} activeMarkerId={1} busy={false}/>);

    const panel = screen.getByRole('region', { name: 'Spectrum plot' });
    const canvas = panel.querySelector('.plot-canvas');
    const svg = screen.getByLabelText('Measured power by frequency');
    const gutter = screen.getByTestId('marker-readout-gutter');
    expect(gutter.parentElement).toBe(panel);
    expect(gutter.nextElementSibling).toBe(canvas);
    expect(canvas?.contains(gutter)).toBe(false);
    expect(svg?.contains(gutter)).toBe(false);
    expect(gutter.textContent).toContain('LOCAL SHAPE');
    expect(gutter.textContent).toContain('peak-to-floor');
    expect(gutter.textContent).toContain('99% component OBW');
    expect([...gutter.querySelectorAll('strong')].every((element) => (element.textContent?.length ?? 0) > 0)).toBe(true);

    const overlay = screen.getByTestId('plot-marker-overlay');
    const markerLabel = overlay.querySelector('[aria-label^="M1 "]');
    if (!(markerLabel instanceof HTMLElement)) throw new Error('Expected the HTML marker overlay item');
    const diamond = screen.getByTestId('marker-m1-diamond');
    expect(svg?.contains(overlay)).toBe(false);
    expect(overlay.contains(markerLabel)).toBe(true);
    expect(svg?.contains(markerLabel)).toBe(false);
    expect(markerLabel.getAttribute('data-marker-label-placement')).toBe('above');
    expect(markerLabel.querySelector('span')?.textContent).toBe('M1');
    expect(markerLabel.lastElementChild).toBe(diamond);
    expect(markerLabel.getAttribute('data-marker-trace-y')).not.toBeNull();
    expect(markerLabel.getAttribute('style')).toContain('left:');
    expect(svg?.querySelector('.plot-marker')).toBeNull();
    const markerLine = svg?.querySelector('.plot-marker-line');
    expect(markerLine).not.toBeNull();
    expect(Number(markerLine?.getAttribute('x1')) / 1_200 * 100)
      .toBeCloseTo(Number.parseFloat(markerLabel.style.left), 10);
    expect(Number(markerLine?.getAttribute('y1')))
      .toBeCloseTo(Number(markerLabel.getAttribute('data-marker-trace-y')), 10);
    expect(screen.getByTestId('marker-three-db-bracket')).toBeTruthy();
    for (const line of screen.getByTestId('marker-three-db-bracket').querySelectorAll('line')) {
      expect(Number(line.getAttribute('x1'))).toBeGreaterThanOrEqual(0);
      expect(Number(line.getAttribute('x1'))).toBeLessThanOrEqual(1_200);
      expect(Number(line.getAttribute('x2'))).toBeGreaterThanOrEqual(0);
      expect(Number(line.getAttribute('x2'))).toBeLessThanOrEqual(1_200);
    }
  });

  it('keeps fixed-pixel HTML diamond/tag geometry above a top-reference trace on non-square plots', () => {
    const fixture = markerFixture(50_001);
    if (fixture.reading.localCharacterization.widthClassification === 'unavailable') {
      throw new Error('Expected a resolved marker layout fixture');
    }
    const reading: MarkerReading = {
      ...fixture.reading,
      powerDbm: -20,
      localCharacterization: {
        ...fixture.reading.localCharacterization,
        componentRelationship: 'contains-marker-bin',
        componentDistanceHz: 0,
        componentStartHz: fixture.sweep.actualStartHz,
        componentStopHz: fixture.sweep.actualStopHz,
      },
    };
    const wide = markerOverlayPlacement(reading, fixture.sweep, 1_200, 430, -120, -20);
    const narrow = markerOverlayPlacement(reading, fixture.sweep, 600, 430, -120, -20);

    expect(wide).toBeDefined();
    expect(narrow).toBeDefined();
    if (!wide || !narrow) throw new Error('Expected marker overlay placement');
    expect(wide.placement).toBe('above');
    expect(wide.leftPercent).toBe(narrow.leftPercent);
    expect(wide.traceTopPercent).toBe(narrow.traceTopPercent);
    expect(wide.leftPercent).toBeGreaterThanOrEqual(0);
    expect(wide.leftPercent).toBeLessThanOrEqual(100);
    expect(wide.traceY).toBe(0);
  });

  it.each([
    { edge: 'start', centerHz: 1, expectedLeft: '0%' },
    { edge: 'stop', centerHz: 100_001, expectedLeft: '100%' },
  ] as const)('shares the fixed edge-inset viewport for a marker at the exact $edge bin', ({ centerHz, expectedLeft }) => {
    const fixture = markerFixture(centerHz);
    render(<SpectrumPlot sweep={fixture.sweep} traces={[fixture.frame]} markers={[fixture.reading]} activeMarkerId={1} busy={false}/>);

    const graph = document.querySelector('.plot-graph');
    const dataViewport = document.querySelector('.plot-data-viewport');
    const overlay = screen.getByTestId('plot-marker-overlay');
    const item = overlay.querySelector('.plot-marker-overlay-item');
    expect(dataViewport?.parentElement).toBe(graph);
    expect(overlay.parentElement).toBe(graph);
    expect(item).toBeInstanceOf(HTMLElement);
    expect((item as HTMLElement).style.left).toBe(expectedLeft);
    expect(screen.getByTestId('marker-m1-diamond')).toBeTruthy();
  });

  it('reserves the same explicit gutter row in the combined detection/classification spectrum host', () => {
    const fixture = markerFixture(50_001);
    render(<ClassificationWorkspace
      sweep={fixture.sweep}
      traces={[fixture.frame]}
      markers={[fixture.reading]}
      activeMarkerId={1}
      detections={[]}
      classifications={[]}
      onSelectedId={() => undefined}
      zeroConfig={{
        frequencyHz: 50_001,
        points: 450,
        rbwKhz: 'auto',
        attenuationDb: 'auto',
        sweepTimeSeconds: 0.05,
        trigger: { mode: 'auto' },
      }}
      busy={false}
      onAcquireZero={() => undefined}
    />);

    const host = document.querySelector('.classification-spectrum');
    const panel = host?.querySelector('.plot-panel');
    const gutter = screen.getByTestId('marker-readout-gutter');
    expect(panel?.classList.contains('has-marker-readout-gutter')).toBe(true);
    expect(gutter.parentElement).toBe(panel);
    expect(gutter.nextElementSibling?.classList.contains('plot-canvas')).toBe(true);
  });

  it('shows dashes and no bracket when an edge crossing is unavailable', () => {
    const fixture = markerFixture(1);
    expect(fixture.reading.localCharacterization.widthClassification).toBe('unavailable');
    render(<SpectrumPlot sweep={fixture.sweep} traces={[fixture.frame]} markers={[fixture.reading]} activeMarkerId={1} busy={false}/>);

    const gutter = screen.getByTestId('marker-readout-gutter');
    expect(gutter.textContent).toContain('3 dB unavailable');
    expect(gutter.textContent).toContain('lower crossing not observed');
    expect(gutter.textContent).toContain('99% component OBW');
    expect(screen.queryByTestId('marker-three-db-bracket')).toBeNull();
  });

  it('projects host trace samples from their physical frequencies rather than array position', () => {
    const fixture = markerFixture(50_001);
    const subspanFrame: TraceFrame = {
      ...fixture.frame,
      frequencyHz: [20_001, 50_001, 80_001],
      powerDbm: [-60, -50, -70],
    };
    render(<SpectrumPlot sweep={fixture.sweep} traces={[subspanFrame]} busy={false}/>);

    const points = document.querySelector('.trace-line')?.getAttribute('points')
      ?.split(' ')
      .map((point) => point.split(',').map(Number));
    expect(points?.map(([x]) => x)).toEqual([240, 600, 960]);
    expectFiniteSvgGeometry(screen.getByLabelText('Measured power by frequency'));
  });

  it.each([
    {
      defect: 'empty',
      mutate: (frame: TraceFrame): TraceFrame => ({ ...frame, frequencyHz: [], powerDbm: [] }),
    },
    {
      defect: 'mismatched vectors',
      mutate: (frame: TraceFrame): TraceFrame => ({ ...frame, powerDbm: frame.powerDbm.slice(1) }),
    },
    {
      defect: 'nonfinite power',
      mutate: (frame: TraceFrame): TraceFrame => ({ ...frame, powerDbm: frame.powerDbm.map((value, index) => index === 50 ? Number.NaN : value) }),
    },
    {
      defect: 'nonincreasing frequency',
      mutate: (frame: TraceFrame): TraceFrame => ({ ...frame, frequencyHz: frame.frequencyHz.map((value, index) => index === 50 ? frame.frequencyHz[49]! : value) }),
    },
  ])('omits a $defect host trace without emitting invalid SVG geometry', ({ mutate }) => {
    const fixture = markerFixture(50_001);
    render(<SpectrumPlot sweep={fixture.sweep} traces={[mutate(fixture.frame)]} busy={false}/>);

    const svg = screen.getByLabelText('Measured power by frequency');
    expect(svg.querySelector('.trace-line')).toBeNull();
    expect(svg.querySelector('polygon')).toBeNull();
    expectFiniteSvgGeometry(svg);
  });

  it('omits malformed firmware and marker evidence without disturbing a valid host trace', () => {
    const fixture = markerFixture(50_001);
    const firmwareTrace: FirmwareTraceFrame = {
      traceId: 2,
      role: 'stored',
      unit: 'dBm',
      frozen: true,
      frequencyHz: [1, 2, 3],
      powerDbm: [-80, Number.POSITIVE_INFINITY],
      sourceSweepId: fixture.sweep.id,
      capturedAt: fixture.sweep.capturedAt,
      evidence: 'firmware-readback',
    };
    const invalidMarker = { ...fixture.reading, frequencyHz: Number.NaN };
    render(<SpectrumPlot
      sweep={fixture.sweep}
      traces={[fixture.frame]}
      firmwareTraces={[firmwareTrace]}
      visibleFirmwareTraceIds={[2]}
      markers={[invalidMarker]}
      activeMarkerId={1}
      busy={false}
    />);

    const svg = screen.getByLabelText('Measured power by frequency');
    expect(svg.querySelector('.trace-line.t1')).not.toBeNull();
    expect(svg.querySelector('.firmware-trace')).toBeNull();
    expect(svg.querySelector('.plot-marker-line')).toBeNull();
    expect(screen.queryByTestId('marker-readout-gutter')).toBeNull();
    expect(screen.getByTestId('plot-marker-overlay').children).toHaveLength(0);
    expectFiniteSvgGeometry(svg);
  });

  it('fails marker projection closed for degenerate or nonfinite plot domains', () => {
    const fixture = markerFixture(50_001);
    expect(markerOverlayPlacement(fixture.reading, fixture.sweep, 0, 430, -120, -20)).toBeUndefined();
    expect(markerOverlayPlacement(fixture.reading, fixture.sweep, 1_200, 0, -120, -20)).toBeUndefined();
    expect(markerOverlayPlacement(fixture.reading, fixture.sweep, 1_200, 430, -20, -20)).toBeUndefined();
    expect(markerOverlayPlacement(fixture.reading, {
      actualStartHz: 1,
      actualStopHz: Number.NaN,
    }, 1_200, 430, -120, -20)).toBeUndefined();
  });

  it('renders a recoverable empty plot plane for a degenerate sweep span', () => {
    const fixture = markerFixture(50_001);
    const degenerateSweep: Sweep = {
      ...fixture.sweep,
      actualStopHz: fixture.sweep.actualStartHz,
    };
    render(<SpectrumPlot
      sweep={degenerateSweep}
      traces={[fixture.frame]}
      markers={[fixture.reading]}
      activeMarkerId={1}
      busy={false}
    />);

    const svg = screen.getByLabelText('Measured power by frequency');
    expect(svg.querySelector('.trace-line')).toBeNull();
    expect(svg.querySelector('.plot-marker-line')).toBeNull();
    expect(screen.queryByTestId('marker-readout-gutter')).not.toBeNull();
    expectFiniteSvgGeometry(svg);
  });
});

function expectFiniteSvgGeometry(svg: HTMLElement): void {
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of element.getAttributeNames()) {
      expect(element.getAttribute(attribute)).not.toMatch(/(?:NaN|Infinity)/);
    }
  }
}

function markerFixture(centerHz: number): { sweep: Sweep; frame: TraceFrame; reading: MarkerReading } {
  const frequencyHz = Array.from({ length: 101 }, (_, index) => 1 + index * 1_000);
  const powerDbm = frequencyHz.map((frequency) => Math.max(
    -120,
    -40 - 10 * Math.log10(2) * (2 * (frequency - centerHz) / 8_000) ** 2,
  ));
  const sweep = makeSweep(frequencyHz, powerDbm);
  const frame: TraceFrame = {
    traceId: 1,
    mode: 'clear-write',
    frequencyHz,
    powerDbm,
    actualRbwHz: sweep.actualRbwHz,
    resolutionBandwidthQualification: 'synthetic-grid-equivalent',
    sweepCount: 1,
    sourceSweepId: sweep.id,
    evidence: 'host-derived',
  };
  const reading = readMarkers([{
    id: 1,
    enabled: true,
    traceId: 1,
    mode: 'normal',
    frequencyHz: centerHz,
    tracking: 'fixed',
  }], [frame])[0];
  if (!reading) throw new Error('Marker layout fixture did not produce a reading');
  return { sweep, frame, reading };
}

function makeSweep(frequencyHz: readonly number[], powerDbm: readonly number[]): Sweep {
  return {
    kind: 'spectrum',
    id: 'spectrum-marker-layout-sweep',
    sequence: 1,
    capturedAt: '2026-07-16T00:00:00.000Z',
    elapsedMilliseconds: 20,
    frequencyHz,
    powerDbm,
    resolutionBandwidthQualification: 'synthetic-grid-equivalent',
    requested: {
      kind: 'swept-spectrum',
      startHz: frequencyHz[0]!,
      stopHz: frequencyHz.at(-1)!,
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
    actualStartHz: frequencyHz[0]!,
    actualStopHz: frequencyHz.at(-1)!,
    actualRbwHz: 1_000,
    actualAttenuationDb: 0,
    source: 'scan-text',
    complete: true,
    identity,
  };
}
