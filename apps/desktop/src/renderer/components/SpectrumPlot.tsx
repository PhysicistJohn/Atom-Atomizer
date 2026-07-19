import { Activity, Orbit } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { DetectedSignal, FirmwareTraceFrame, FirmwareTraceId, MarkerId, MarkerReading, SpectrumDisplayConfiguration, Sweep, TraceFrame, TraceId } from '@tinysa/contracts';
import { formatFrequency, formatLevel } from '../format.js';
import { DEVELOPMENT_RENDERER } from '../development.js';
import { powerY, validSpectrumDisplay } from '../plot-geometry.js';
import {
  BRACKET_OPACITY,
  BRACKET_RESOLUTION_LIMITED_DASH,
  BRACKET_RESOLUTION_LIMITED_OPACITY,
  BRACKET_WIDTH,
  MARKER_LINE_DASH,
  MARKER_LINE_OPACITY,
  resolvePlotTheme,
  type PlotTheme,
} from '../plot-theme.js';
import { AtomicMark } from './AtomicMark.js';

export interface SpectrumPlotProps {
  sweep?: Sweep;
  traces?: readonly TraceFrame[];
  firmwareTraces?: readonly FirmwareTraceFrame[];
  visibleFirmwareTraceIds?: readonly FirmwareTraceId[];
  activeTraceId?: TraceId;
  markers?: readonly MarkerReading[];
  activeMarkerId?: MarkerId;
  detections?: readonly DetectedSignal[];
  detectionOverlay?: boolean;
  selectedDetectionId?: string;
  display?: SpectrumDisplayConfiguration;
  busy: boolean;
  onMarkerPlace?(frequencyHz: number): boolean;
}

const DEFAULT_DISPLAY: SpectrumDisplayConfiguration = { referenceLevelDbm: -20, decibelsPerDivision: 10, divisions: 10 };
const PLOT_WIDTH = 1200;
const PLOT_HEIGHT = 430;
const ATOM_MARKER_REQUEST_PROPERTY = '__tinysaAtomMarkerRequestV1';
const ATOM_MARKER_RESULT_PROPERTY = '__tinysaAtomMarkerResultV1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AtomMarkerPointerEvent = PointerEvent & {
  readonly __tinysaAtomMarkerRequestV1?: { readonly token?: unknown };
  __tinysaAtomMarkerResultV1?: {
    readonly token: string;
    accepted: boolean;
    frequencyHz?: number;
  };
};

interface DrawState {
  readonly sweep: Sweep;
  readonly paintOrder: readonly TraceFrame[];
  readonly fillTrace: TraceFrame | undefined;
  readonly firmwareOverlays: readonly FirmwareTraceFrame[];
  readonly renderableMarkers: readonly MarkerReading[];
  readonly renderableDetections: readonly DetectedSignal[];
  readonly detectionOverlay: boolean;
  readonly selectedDetectionId: string | undefined;
  readonly activeTraceId: TraceId;
  readonly activeMarker: MarkerReading | undefined;
  readonly minimumDbm: number;
  readonly maximumDbm: number;
}

// One module-lifetime scratch pair reused by every draw pass; grown on demand
// so per-sweep drawing never allocates per-point geometry.
let scratchX = new Float64Array(2_048);
let scratchY = new Float64Array(2_048);
function ensureScratch(points: number): void {
  if (scratchX.length >= points) return;
  const next = 1 << Math.ceil(Math.log2(points));
  scratchX = new Float64Array(next);
  scratchY = new Float64Array(next);
}

/**
 * Project one trace onto device-space coordinates in the shared scratch
 * buffers, mirroring `plot-geometry.traceGeometry` (same validation: matched
 * finite vectors, >= 2 points, strictly increasing frequency; samples outside
 * the domain clipped). Returns the number of projected points or undefined
 * when the trace is not renderable at all.
 */
function projectTraceIntoScratch(
  trace: { readonly frequencyHz: readonly number[]; readonly powerDbm: readonly number[] },
  domain: { readonly actualStartHz: number; readonly actualStopHz: number },
  width: number,
  height: number,
  minimum: number,
  maximum: number,
): number | undefined {
  if (trace.frequencyHz.length !== trace.powerDbm.length || trace.frequencyHz.length < 2) return undefined;
  for (let index = 0; index < trace.frequencyHz.length; index++) {
    if (!Number.isFinite(trace.frequencyHz[index]!) || !Number.isFinite(trace.powerDbm[index]!)) return undefined;
    if (index > 0 && trace.frequencyHz[index]! <= trace.frequencyHz[index - 1]!) return undefined;
  }
  const spanHz = domain.actualStopHz - domain.actualStartHz;
  if (!Number.isFinite(domain.actualStartHz)
    || !Number.isFinite(domain.actualStopHz)
    || !Number.isFinite(spanHz)
    || spanHz <= 0
    || !Number.isFinite(width)
    || width <= 0
    || !Number.isFinite(height)
    || height <= 0
    || !Number.isFinite(minimum)
    || !Number.isFinite(maximum)
    || maximum <= minimum
    || trace.frequencyHz.at(-1)! < domain.actualStartHz
    || trace.frequencyHz[0]! > domain.actualStopHz) return undefined;
  ensureScratch(trace.frequencyHz.length);
  let count = 0;
  for (let index = 0; index < trace.frequencyHz.length; index++) {
    const frequencyHz = trace.frequencyHz[index]!;
    if (frequencyHz < domain.actualStartHz || frequencyHz > domain.actualStopHz) continue;
    const x = (frequencyHz - domain.actualStartHz) / spanHz * width;
    const y = powerY(trace.powerDbm[index]!, height, minimum, maximum);
    if (!Number.isFinite(x) || y === undefined) return undefined;
    scratchX[count] = x;
    scratchY[count] = y;
    count++;
  }
  return count < 2 ? undefined : count;
}

export function SpectrumPlot({ sweep, traces, firmwareTraces = [], visibleFirmwareTraceIds = [], activeTraceId = 1, markers = [], activeMarkerId, detections = [], detectionOverlay = false, selectedDetectionId, display = DEFAULT_DISPLAY, busy, onMarkerPlace }: SpectrumPlotProps) {
  const sweepDomainRenderable = typeof sweep === 'object'
    && sweep !== null
    && isFiniteNumber(sweep.actualStartHz)
    && isFiniteNumber(sweep.actualStopHz);
  const sweepPointCount = sweep && Array.isArray(sweep.frequencyHz)
    ? sweep.frequencyHz.length
    : undefined;
  const effectiveDisplay = validSpectrumDisplay(display) ? display : DEFAULT_DISPLAY;
  const maximumDbm = effectiveDisplay.referenceLevelDbm;
  const minimumDbm = maximumDbm - effectiveDisplay.decibelsPerDivision * effectiveDisplay.divisions;
  const visibleTraces: readonly TraceFrame[] = (traces === undefined
    ? sweep ? [{
      traceId: 1,
      mode: 'clear-write',
      frequencyHz: sweep.frequencyHz,
      powerDbm: sweep.powerDbm,
      actualRbwHz: sweep.actualRbwHz,
      ...(sweep.resolutionBandwidthQualification === undefined
        ? {}
        : { resolutionBandwidthQualification: sweep.resolutionBandwidthQualification }),
      sweepCount: 1,
      sourceSweepId: sweep.id,
      evidence: 'host-derived',
    }] : []
    : traces).filter(isRenderableHostTrace);
  const visibleFirmwareIds = new Set(visibleFirmwareTraceIds);
  const firmwareOverlays = firmwareTraces.filter(isRenderableFirmwareTrace)
    .filter((trace) => trace.traceId !== 1 && visibleFirmwareIds.has(trace.traceId));
  const paintOrder = [...visibleTraces].sort((left, right) => Number(left.traceId === activeTraceId) - Number(right.traceId === activeTraceId));
  const renderableMarkers = markers.filter(isRenderableMarker);
  const renderableDetections = detections.filter(isRenderableDetection);
  const activeMarker = renderableMarkers.find((marker) => marker.markerId === activeMarkerId);
  const hostTraceLegend = sweep
    ? paintOrder
      .filter((trace) => projectTraceIntoScratch(trace, sweep, PLOT_WIDTH, PLOT_HEIGHT, minimumDbm, maximumDbm) !== undefined)
      .sort((left, right) => left.traceId - right.traceId)
    : [];
  const firmwareTraceLegend = sweep
    ? firmwareOverlays
      .filter((trace) => projectTraceIntoScratch(trace, sweep, PLOT_WIDTH, PLOT_HEIGHT, minimumDbm, maximumDbm) !== undefined)
      .sort((left, right) => left.traceId - right.traceId)
    : [];

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const themeRef = useRef<PlotTheme | undefined>(undefined);
  const gradientRef = useRef<{ height: number; gradient: CanvasGradient } | undefined>(undefined);
  const sizeRef = useRef<{ width: number; height: number; dpr: number }>({ width: PLOT_WIDTH, height: PLOT_HEIGHT, dpr: 1 });
  const frameRef = useRef<number | undefined>(undefined);
  const drawStateRef = useRef<DrawState | undefined>(undefined);
  drawStateRef.current = sweep ? {
    sweep,
    paintOrder,
    fillTrace: visibleTraces[0],
    firmwareOverlays,
    renderableMarkers,
    renderableDetections,
    detectionOverlay,
    selectedDetectionId,
    activeTraceId,
    activeMarker,
    minimumDbm,
    maximumDbm,
  } : undefined;

  // DPR-aware backing-store sizing on resize only; the 2d context and canvas
  // are retained for the component lifetime and never recreated per sweep.
  const measureBackingStore = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cssWidth = 0;
    let cssHeight = 0;
    try {
      const bounds = canvas.getBoundingClientRect();
      cssWidth = bounds.width;
      cssHeight = bounds.height;
    } catch { /* jsdom layout is unavailable; retain the logical size. */ }
    const dpr = typeof devicePixelRatio === 'number' && Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
    const next = cssWidth > 0 && cssHeight > 0
      ? { width: Math.round(cssWidth * dpr), height: Math.round(cssHeight * dpr), dpr }
      : { width: PLOT_WIDTH, height: PLOT_HEIGHT, dpr: 1 };
    const current = sizeRef.current;
    if (next.width === current.width && next.height === current.height && next.dpr === current.dpr
      && canvas.width === next.width && canvas.height === next.height) return;
    sizeRef.current = next;
    if (canvas.width !== next.width) canvas.width = next.width;
    if (canvas.height !== next.height) canvas.height = next.height;
    gradientRef.current = undefined;
  };

  const draw = () => {
    const canvas = canvasRef.current;
    const state = drawStateRef.current;
    if (!canvas || !state) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const theme = themeRef.current ??= resolvePlotTheme(canvas);
    const { width, height, dpr } = sizeRef.current;
    const { sweep: domain } = state;
    try {
      context.clearRect(0, 0, width, height);
      // Grid: 9 vertical / 5 horizontal hairlines.
      context.save();
      context.strokeStyle = theme.grid;
      context.lineWidth = 1;
      context.beginPath();
      for (let index = 0; index < 9; index++) {
        const x = index * width / 8;
        context.moveTo(x, 0);
        context.lineTo(x, height);
      }
      for (let index = 0; index < 5; index++) {
        const y = index * height / 4;
        context.moveTo(0, y);
        context.lineTo(width, y);
      }
      context.stroke();
      context.restore();

      // Detection bands behind the traces (Detect view only).
      if (state.detectionOverlay) {
        for (const detection of state.renderableDetections) {
          const geometry = detectionGeometry(detection, domain, width);
          if (!geometry) continue;
          const selected = detection.id === state.selectedDetectionId;
          context.save();
          context.fillStyle = selected ? theme.detectionBandSelectedFill : theme.detectionBandFill;
          context.strokeStyle = selected ? theme.detectionBandSelectedStroke : theme.detectionBandStroke;
          context.lineWidth = (selected ? 2 : 1) * dpr;
          context.fillRect(geometry.startX, 0, geometry.width, height);
          context.strokeRect(geometry.startX, 0, geometry.width, height);
          context.restore();
        }
      }

      // Gradient fill under trace 1 (persistent gradient, rebuilt on resize).
      if (state.fillTrace) {
        const count = projectTraceIntoScratch(state.fillTrace, domain, width, height, state.minimumDbm, state.maximumDbm);
        if (count !== undefined) {
          if (!gradientRef.current || gradientRef.current.height !== height) {
            const gradient = context.createLinearGradient(0, 0, 0, height);
            for (const [offset, color, alpha] of theme.gradientStops) {
              gradient.addColorStop(offset, colorWithAlpha(color, alpha));
            }
            gradientRef.current = { height, gradient };
          }
          context.save();
          context.beginPath();
          context.moveTo(scratchX[0]!, height);
          for (let index = 0; index < count; index++) context.lineTo(scratchX[index]!, scratchY[index]!);
          context.lineTo(scratchX[count - 1]!, height);
          context.closePath();
          context.fillStyle = gradientRef.current.gradient;
          context.fill();
          context.restore();
        }
      }

      // Host traces in paint order (active drawn last, with glow + crisp pass).
      for (const trace of state.paintOrder) {
        const count = projectTraceIntoScratch(trace, domain, width, height, state.minimumDbm, state.maximumDbm);
        if (count === undefined) continue;
        const style = theme.host[trace.traceId as TraceId] ?? theme.host[1];
        const active = trace.traceId === state.activeTraceId;
        strokeScratchPath(context, count, dpr, {
          color: style.color,
          width: active ? theme.activeWidth : style.width,
          dash: style.dash,
          dashOffset: style.dashOffset,
          opacity: active ? 1 : style.opacity,
          glow: active,
        });
      }

      // Firmware readback overlays.
      for (const trace of state.firmwareOverlays) {
        const count = projectTraceIntoScratch(trace, domain, width, height, state.minimumDbm, state.maximumDbm);
        if (count === undefined) continue;
        const style = theme.firmware[trace.traceId as FirmwareTraceId] ?? theme.firmware[2];
        strokeScratchPath(context, count, dpr, {
          color: style.color,
          width: style.width,
          dash: style.dash,
          dashOffset: style.dashOffset,
          opacity: style.opacity,
          glow: false,
        });
      }

      // Detection center lines above the traces (Detect view only).
      if (state.detectionOverlay) {
        for (const detection of state.renderableDetections) {
          const geometry = detectionGeometry(detection, domain, width);
          if (!geometry) continue;
          const selected = detection.id === state.selectedDetectionId;
          context.save();
          context.globalAlpha = selected ? 1 : 0.86;
          context.strokeStyle = selected ? theme.detectionCenterSelected : theme.detectionCenter;
          context.lineWidth = (selected ? 2.2 : 1.15) * dpr;
          if (!selected && typeof context.setLineDash === 'function') context.setLineDash([5 * dpr, 5 * dpr]);
          context.shadowColor = context.strokeStyle;
          context.shadowBlur = (selected ? 5 : 3) * dpr;
          context.beginPath();
          context.moveTo(geometry.centerX, 0);
          context.lineTo(geometry.centerX, height);
          context.stroke();
          context.restore();
        }
      }

      // Marker verticals from the marker's trace point down to the baseline.
      for (const marker of state.renderableMarkers) {
        const placement = markerOverlayPlacement(marker, domain, width, height, state.minimumDbm, state.maximumDbm);
        if (!placement) continue;
        const x = placement.leftPercent / 100 * width;
        const style = theme.host[marker.traceId as TraceId] ?? theme.host[1];
        const active = marker.markerId === state.activeMarker?.markerId;
        context.save();
        context.globalAlpha = MARKER_LINE_OPACITY;
        context.strokeStyle = style.color;
        context.lineWidth = 1 * dpr;
        if (typeof context.setLineDash === 'function') context.setLineDash(MARKER_LINE_DASH.map((value) => value * dpr));
        if (active) {
          context.shadowColor = style.color;
          context.shadowBlur = 5 * dpr;
        }
        context.beginPath();
        context.moveTo(x, placement.traceY);
        context.lineTo(x, height);
        context.stroke();
        context.restore();
      }

      // Active-marker observed 3 dB bracket.
      if (state.activeMarker) drawThreeDecibelBracket(context, theme, state, width, height, dpr);
    } catch {
      // A partial 2d context (test stubs) or an interrupted paint must never
      // break the retained DOM around the canvas; the next frame repaints.
    }
  };

  const scheduleDraw = () => {
    // rAF latest-wins: one scheduled frame draws the newest state; skipped
    // intermediate sweeps never touch the canvas.
    if (typeof requestAnimationFrame !== 'function') { draw(); return; }
    if (frameRef.current !== undefined) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined;
      draw();
    });
  };

  useLayoutEffect(() => {
    measureBackingStore();
    scheduleDraw();
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => {
        measureBackingStore();
        scheduleDraw();
      });
      observer.observe(canvas);
    }
    // Track devicePixelRatio changes (monitor moves / zoom) without polling.
    let media: MediaQueryList | undefined;
    const onDprChange = () => {
      measureBackingStore();
      scheduleDraw();
      armDprListener();
    };
    const armDprListener = () => {
      media?.removeEventListener?.('change', onDprChange);
      if (typeof matchMedia !== 'function') return;
      try {
        media = matchMedia(`(resolution: ${sizeRef.current.dpr}dppx)`);
        media.addEventListener?.('change', onDprChange);
      } catch { media = undefined; }
    };
    armDprListener();
    return () => {
      observer?.disconnect();
      media?.removeEventListener?.('change', onDprChange);
      if (frameRef.current !== undefined && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = undefined;
      }
    };
  }, [Boolean(sweep)]);

  const pointerFrequency = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!sweep || !onMarkerPlace) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const spanHz = sweep.actualStopHz - sweep.actualStartHz;
    if (!Number.isFinite(bounds.width) || bounds.width <= 0
      || !Number.isFinite(sweep.actualStartHz)
      || !Number.isFinite(spanHz)
      || spanHz <= 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const frequencyHz = Math.round(sweep.actualStartHz + fraction * spanHz);
    const nativeEvent = event.nativeEvent as AtomMarkerPointerEvent;
    const token = nativeEvent[ATOM_MARKER_REQUEST_PROPERTY]?.token;
    const acknowledgement = typeof token === 'string' && UUID_PATTERN.test(token)
      ? { token, accepted: false, frequencyHz: undefined as number | undefined }
      : undefined;
    if (acknowledgement) {
      try {
        Object.defineProperty(nativeEvent, ATOM_MARKER_RESULT_PROPERTY, {
          value: acknowledgement,
          enumerable: false,
          configurable: false,
          writable: false,
        });
      } catch {
        // A computer-originated event that cannot carry the trusted result
        // token must not mutate marker state and then report a false failure.
        return;
      }
    }
    if (onMarkerPlace(frequencyHz) !== true) return;
    if (acknowledgement) {
      acknowledgement.accepted = true;
      acknowledgement.frequencyHz = frequencyHz;
    }
  };

  return <section
    className={`plot-panel ${sweep && activeMarker ? 'has-marker-readout-gutter' : ''}`}
    aria-label="Spectrum plot"
    aria-description={DEVELOPMENT_RENDERER && sweep
      ? `sweepId=${sweep.id}; sequence=${sweep.sequence}`
      : undefined}
  >
    <div className="panel-header"><div><span className="live-indicator"/><strong>{busy ? 'Acquiring' : sweep ? `Sweep ${sweep.sequence}` : 'No sweep'}</strong>{hostTraceLegend.length + firmwareTraceLegend.length > 0 && <small>{hostTraceLegend.map((trace) => `H${trace.traceId} ${traceAbbreviation(trace.mode)}`).join(' · ')}{firmwareTraceLegend.map((trace) => ` · D${trace.traceId} ${trace.role.toUpperCase()}`).join('')}</small>}</div><div className="plot-meta"><span><Activity size={13}/>{sweepPointCount === undefined ? '—' : `${sweepPointCount} points`}</span><span><Orbit size={13}/>{renderableDetections.length} signal{renderableDetections.length === 1 ? '' : 's'}</span><span>{hostTraceLegend.length} host · {firmwareTraceLegend.length} device</span></div></div>
    {sweep && activeMarker && <MarkerReadoutGutter marker={activeMarker}/>}
    <div className={`plot-canvas ${busy ? 'is-loading' : ''} ${onMarkerPlace ? 'marker-placeable' : ''}`}>
      <div className="y-labels">{Array.from({ length: 5 }, (_, index) => <span key={index}>{formatAxisLevel(maximumDbm - index * effectiveDisplay.decibelsPerDivision * 2.5)}</span>)}<em>dBm</em></div>
      {!sweep ? <div className="plot-empty"><div className="empty-atom"><AtomicMark size={76}/></div><strong>No sweep</strong><p>Connect and acquire.</p></div> : <div className="plot-graph"><div className="plot-data-viewport"><canvas
        ref={canvasRef}
        data-agent-control={onMarkerPlace ? 'spectrum.marker-place' : undefined}
        aria-label="Measured power by frequency"
        onPointerDown={pointerFrequency}
        onPointerMove={(event) => { if (event.buttons === 1) pointerFrequency(event); }}
      /></div><div className="plot-marker-overlay" data-testid="plot-marker-overlay">{renderableMarkers.map((marker) => {
        const placement = markerOverlayPlacement(marker, sweep, PLOT_WIDTH, PLOT_HEIGHT, minimumDbm, maximumDbm);
        if (!placement) return null;
        return <div
          key={marker.markerId}
          className={`plot-marker-overlay-item t${marker.traceId} ${marker.markerId === activeMarkerId ? 'active' : ''}`}
          style={{ left: `${placement.leftPercent}%`, top: `${placement.traceTopPercent}%` }}
          data-marker-label-placement="above"
          data-marker-trace-y={placement.traceY}
          aria-label={`M${marker.markerId} ${markerCenterLabel(marker)}`}
        ><span>M{marker.markerId}</span><i className="marker-diamond" data-testid={`marker-m${marker.markerId}-diamond`}/></div>;
      })}</div></div>}
      {sweepDomainRenderable && <div className="x-labels"><span>{formatFrequency(sweep.actualStartHz)}</span><span>{formatFrequency(sweep.actualStartHz + (sweep.actualStopHz - sweep.actualStartHz) / 2)}</span><span>{formatFrequency(sweep.actualStopHz)}</span></div>}
    </div>
  </section>;
}

function strokeScratchPath(
  context: CanvasRenderingContext2D,
  count: number,
  dpr: number,
  style: { color: string; width: number; dash: readonly number[]; dashOffset: number; opacity: number; glow: boolean },
): void {
  context.save();
  context.globalAlpha = style.opacity;
  context.strokeStyle = style.color;
  context.lineWidth = style.width * dpr;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  if (typeof context.setLineDash === 'function' && style.dash.length > 0) {
    context.setLineDash(style.dash.map((value) => value * dpr));
    context.lineDashOffset = style.dashOffset * dpr;
  }
  context.beginPath();
  context.moveTo(scratchX[0]!, scratchY[0]!);
  for (let index = 1; index < count; index++) context.lineTo(scratchX[index]!, scratchY[index]!);
  if (style.glow) {
    // Matches the retired 1.5σ feGaussianBlur glow: one blurred pass under
    // one crisp pass, without re-rasterizing an SVG filter per sweep.
    context.shadowColor = style.color;
    context.shadowBlur = 3.5 * dpr;
    context.stroke();
    context.shadowBlur = 0;
  }
  context.stroke();
  context.restore();
}

function drawThreeDecibelBracket(
  context: CanvasRenderingContext2D,
  theme: PlotTheme,
  state: DrawState,
  width: number,
  height: number,
  dpr: number,
): void {
  const marker = state.activeMarker;
  if (!marker) return;
  const characterization = marker.localCharacterization;
  if (!('threeDecibelBandwidth' in characterization)) return;
  const measurement = characterization.threeDecibelBandwidth;
  if (measurement.status === 'unavailable') return;
  const sweep = state.sweep;
  const spanHz = sweep.actualStopHz - sweep.actualStartHz;
  if (!Number.isFinite(spanHz) || spanHz <= 0
    || !Number.isFinite(width) || width <= 0
    || !Number.isFinite(height) || height <= 0
    || !Number.isFinite(measurement.startHz)
    || !Number.isFinite(measurement.stopHz)
    || !Number.isFinite(measurement.halfPowerLevelDbm)
    || measurement.stopHz <= measurement.startHz
    || measurement.startHz < sweep.actualStartHz
    || measurement.stopHz > sweep.actualStopHz) return;
  const startX = (measurement.startHz - sweep.actualStartHz) / spanHz * width;
  const stopX = (measurement.stopHz - sweep.actualStartHz) / spanHz * width;
  const y = powerY(measurement.halfPowerLevelDbm, height, state.minimumDbm, state.maximumDbm);
  if (y === undefined) return;
  context.save();
  context.strokeStyle = theme.bracket;
  context.lineWidth = BRACKET_WIDTH * dpr;
  if (measurement.status === 'resolution-limited') {
    context.globalAlpha = BRACKET_RESOLUTION_LIMITED_OPACITY;
    if (typeof context.setLineDash === 'function') context.setLineDash(BRACKET_RESOLUTION_LIMITED_DASH.map((value) => value * dpr));
  } else {
    context.globalAlpha = BRACKET_OPACITY;
  }
  context.beginPath();
  context.moveTo(startX, y);
  context.lineTo(stopX, y);
  context.moveTo(startX, Math.max(0, y - 7 * dpr));
  context.lineTo(startX, Math.min(height, y + 7 * dpr));
  context.moveTo(stopX, Math.max(0, y - 7 * dpr));
  context.lineTo(stopX, Math.min(height, y + 7 * dpr));
  context.stroke();
  context.restore();
}

function colorWithAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return color;
  const value = Number.parseInt(hex[1]!, 16);
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${alpha})`;
}

function MarkerReadoutGutter({ marker }: { marker: MarkerReading }) {
  const characterization = marker.localCharacterization;
  const measurement = 'threeDecibelBandwidth' in characterization
    ? characterization.threeDecibelBandwidth
    : undefined;
  const measured = measurement?.status !== undefined && measurement.status !== 'unavailable'
    ? measurement
    : undefined;
  const componentOccupiedBandwidth = 'componentOccupiedBandwidth' in characterization
    ? characterization.componentOccupiedBandwidth
    : undefined;
  const shape = characterization.widthClassification === 'resolution-limited-narrow'
    ? 'Narrow · resolution limited'
    : characterization.widthClassification === 'resolved-wideband'
      ? 'Resolved local response · >2 resolution elements'
      : '3 dB unavailable';
  return <aside className={`marker-readout-gutter marker-active-readout t${marker.traceId}`} data-testid="marker-readout-gutter" aria-label={`Active marker M${marker.markerId} measurement`}>
    <div><small>M{marker.markerId}</small><strong>{formatMarkerLevel(marker)}</strong><span>{formatFrequency(marker.frequencyHz)} · {markerCenterLabel(marker)}</span></div>
    <div><small>LOCAL SHAPE</small><strong>{shape}</strong><span>{measured ? `${formatFrequency(measured.bandwidthHz)} observed 3 dB width` : markerUnavailableLabel(marker)}{componentOccupiedBandwidth ? ` · ${formatFrequency(componentOccupiedBandwidth.bandwidthHz)} 99% component OBW` : ''}</span></div>
    <div><small>SIGNAL / NOISE CONTEXT</small><strong>{characterization.peakToRobustFloorDb.toFixed(1)} dB peak-to-floor</strong><span>{characterization.prominenceDb.toFixed(1)} dB prominence · {markerContextLabel(marker)}</span></div>
  </aside>;
}

export function markerOverlayPlacement(
  marker: MarkerReading,
  sweep: Pick<Sweep, 'actualStartHz' | 'actualStopHz'>,
  width: number,
  height: number,
  minimumDbm: number,
  maximumDbm: number,
): {
  leftPercent: number;
  traceTopPercent: number;
  traceY: number;
  placement: 'above';
} | undefined {
  const spanHz = sweep.actualStopHz - sweep.actualStartHz;
  if (!Number.isFinite(sweep.actualStartHz)
    || !Number.isFinite(sweep.actualStopHz)
    || !Number.isFinite(spanHz)
    || spanHz <= 0
    || !Number.isFinite(width)
    || width <= 0
    || !Number.isFinite(height)
    || height <= 0
    || !Number.isFinite(minimumDbm)
    || !Number.isFinite(maximumDbm)
    || maximumDbm <= minimumDbm
    || !Number.isFinite(marker.frequencyHz)
    || !Number.isFinite(marker.powerDbm)) return undefined;
  const markerX = (marker.frequencyHz - sweep.actualStartHz) / spanHz * width;
  if (!Number.isFinite(markerX) || markerX < 0 || markerX > width) return undefined;
  const markerY = powerY(marker.powerDbm, height, minimumDbm, maximumDbm);
  if (markerY === undefined) return undefined;
  return {
    leftPercent: markerX / width * 100,
    traceTopPercent: markerY / height * 100,
    traceY: markerY,
    placement: 'above',
  };
}

function markerCenterLabel(marker: MarkerReading): string {
  const characterization = marker.localCharacterization;
  if (characterization.markerCenterMethod === 'resolved-component-linear-power-centroid') {
    return `noise-subtracted linear-power center (${formatFrequency(characterization.powerCentroidHz)} centroid)`;
  }
  return characterization.markerCenterMethod === 'local-peak'
    ? 'true local peak'
    : 'fixed measured bin';
}

function isRenderableMarker(marker: unknown): marker is MarkerReading {
  if (typeof marker !== 'object' || marker === null) return false;
  const candidate = marker as Partial<MarkerReading>;
  const characterization = candidate.localCharacterization as unknown;
  if (!isFiniteNumber(candidate.frequencyHz)
    || !isFiniteNumber(candidate.powerDbm)
    || typeof characterization !== 'object'
    || characterization === null) return false;
  const values = characterization as Record<string, unknown>;
  if (!isFiniteNumber(values.peakToRobustFloorDb)
    || !isFiniteNumber(values.prominenceDb)
    || !['fixed-frequency', 'local-peak', 'resolved-component-linear-power-centroid'].includes(String(values.markerCenterMethod))
    || !['resolution-limited-narrow', 'resolved-wideband', 'unavailable'].includes(String(values.widthClassification))) return false;
  if (values.markerCenterMethod === 'resolved-component-linear-power-centroid'
    && !isFiniteNumber(values.powerCentroidHz)) return false;
  if (values.componentRelationship === 'nearest-threshold-component'
    && !isFiniteNumber(values.componentDistanceHz)) return false;
  if (values.physicalDetection !== undefined) {
    if (typeof values.physicalDetection !== 'object' || values.physicalDetection === null) return false;
    const physical = values.physicalDetection as Record<string, unknown>;
    if (physical.relationship !== 'contains-local-peak'
      && (physical.relationship !== 'nearest-current-detection' || !isFiniteNumber(physical.distanceHz))) return false;
  }
  if ('componentOccupiedBandwidth' in values) {
    const occupied = values.componentOccupiedBandwidth;
    if (typeof occupied !== 'object' || occupied === null
      || !isFiniteNumber((occupied as Record<string, unknown>).bandwidthHz)) return false;
  }
  if ('threeDecibelBandwidth' in values) {
    const measurement = values.threeDecibelBandwidth;
    if (typeof measurement !== 'object' || measurement === null) return false;
    const bandwidth = measurement as Record<string, unknown>;
    if (bandwidth.status !== 'resolved'
      && bandwidth.status !== 'resolution-limited'
      && bandwidth.status !== 'unavailable') return false;
    if (bandwidth.status === 'unavailable' && typeof bandwidth.reason !== 'string') return false;
    if (bandwidth.status !== 'unavailable'
      && (!isFiniteNumber(bandwidth.startHz)
        || !isFiniteNumber(bandwidth.stopHz)
        || !isFiniteNumber(bandwidth.bandwidthHz)
        || !isFiniteNumber(bandwidth.halfPowerLevelDbm))) return false;
  }
  return true;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function markerUnavailableLabel(marker: MarkerReading): string {
  const characterization = marker.localCharacterization;
  if ('unavailableReason' in characterization) {
    return characterization.unavailableReason === 'insufficient-local-prominence'
      ? 'Insufficient local prominence'
      : 'No qualified local component';
  }
  if ('threeDecibelBandwidth' in characterization && characterization.threeDecibelBandwidth.status === 'unavailable') {
    return characterization.threeDecibelBandwidth.reason.replaceAll('-', ' ');
  }
  return 'Half-power edges unavailable';
}

function markerContextLabel(marker: MarkerReading): string {
  const characterization = marker.localCharacterization;
  if (characterization.componentRelationship === 'nearest-threshold-component') {
    return `nearest component ${formatFrequency(characterization.componentDistanceHz)} away`;
  }
  const detection = characterization.physicalDetection;
  if (!detection) return 'trace-only';
  return detection.relationship === 'contains-local-peak'
    ? `${detection.detectionState} ${detection.detectionId}`
    : `nearest detection ${formatFrequency(detection.distanceHz)} away`;
}

function isRenderableHostTrace(value: unknown): value is TraceFrame {
  if (typeof value !== 'object' || value === null) return false;
  const trace = value as Partial<TraceFrame>;
  return typeof trace.traceId === 'number'
    && Number.isSafeInteger(trace.traceId)
    && Array.isArray(trace.frequencyHz)
    && Array.isArray(trace.powerDbm)
    && ['clear-write', 'max-hold', 'min-hold', 'average', 'view', 'blank'].includes(String(trace.mode));
}

function isRenderableFirmwareTrace(value: unknown): value is FirmwareTraceFrame {
  if (typeof value !== 'object' || value === null) return false;
  const trace = value as Partial<FirmwareTraceFrame>;
  return typeof trace.traceId === 'number'
    && Number.isSafeInteger(trace.traceId)
    && Array.isArray(trace.frequencyHz)
    && Array.isArray(trace.powerDbm)
    && (trace.role === 'measured' || trace.role === 'stored' || trace.role === 'raw');
}

function isRenderableDetection(value: unknown): value is DetectedSignal {
  if (typeof value !== 'object' || value === null) return false;
  const detection = value as Partial<DetectedSignal>;
  return typeof detection.id === 'string'
    && isFiniteNumber(detection.startHz)
    && isFiniteNumber(detection.stopHz)
    && detection.stopHz >= detection.startHz;
}

export function detectionGeometry(detection: DetectedSignal, sweep: Pick<Sweep, 'actualStartHz' | 'actualStopHz'>, width: number): { startX: number; width: number; centerX: number } | undefined {
  const spanHz = sweep.actualStopHz - sweep.actualStartHz;
  if (!Number.isFinite(sweep.actualStartHz)
    || !Number.isFinite(sweep.actualStopHz)
    || !Number.isFinite(spanHz)
    || spanHz <= 0
    || !Number.isFinite(width)
    || width <= 0
    || !Number.isFinite(detection.startHz)
    || !Number.isFinite(detection.stopHz)
    || detection.stopHz < detection.startHz
    || detection.stopHz < sweep.actualStartHz
    || detection.startHz > sweep.actualStopHz) return undefined;
  const startHz = Math.max(sweep.actualStartHz, detection.startHz);
  const stopHz = Math.min(sweep.actualStopHz, detection.stopHz);
  const centerHz = Math.min(sweep.actualStopHz, Math.max(sweep.actualStartHz, (detection.startHz + detection.stopHz) / 2));
  const startX = (startHz - sweep.actualStartHz) / spanHz * width;
  const stopX = (stopHz - sweep.actualStartHz) / spanHz * width;
  return { startX, width: Math.max(0, stopX - startX), centerX: (centerHz - sweep.actualStartHz) / spanHz * width };
}

function traceAbbreviation(mode: TraceFrame['mode']): string { return ({ 'clear-write': 'CLRWR', 'max-hold': 'MAXH', 'min-hold': 'MINH', average: 'AVG', view: 'VIEW', blank: 'BLANK' })[mode]; }
function formatAxisLevel(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(1); }
function formatMarkerLevel(marker: MarkerReading): string {
  if (marker.mode === 'delta' && marker.deltaPowerDb !== undefined) return `Δ ${marker.deltaPowerDb >= 0 ? '+' : ''}${marker.deltaPowerDb.toFixed(1)} dB`;
  if (marker.mode === 'noise-density' && marker.noiseDensityDbmHz !== undefined) return `${marker.noiseDensityDbmHz.toFixed(1)} dBm/Hz`;
  return formatLevel(marker.powerDbm);
}
