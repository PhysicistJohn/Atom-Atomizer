import { Activity, Orbit } from 'lucide-react';
import { useId } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { DetectedSignal, FirmwareTraceFrame, FirmwareTraceId, MarkerId, MarkerReading, SpectrumDisplayConfiguration, Sweep, TraceFrame, TraceId } from '@tinysa/contracts';
import { formatFrequency, formatLevel } from '../format.js';
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

export function SpectrumPlot({ sweep, traces, firmwareTraces = [], visibleFirmwareTraceIds = [], activeTraceId = 1, markers = [], activeMarkerId, detections = [], detectionOverlay = false, selectedDetectionId, display = DEFAULT_DISPLAY, busy, onMarkerPlace }: SpectrumPlotProps) {
  const width = PLOT_WIDTH;
  const height = PLOT_HEIGHT;
  const resourcePrefix = useId().replaceAll(':', '');
  const traceFillId = `${resourcePrefix}-trace-fill`;
  const traceGlowId = `${resourcePrefix}-trace-glow`;
  const sweepDomainRenderable = typeof sweep === 'object'
    && sweep !== null
    && isFiniteNumber(sweep.actualStartHz)
    && isFiniteNumber(sweep.actualStopHz);
  const sweepPointCount = sweep && Array.isArray(sweep.frequencyHz)
    ? sweep.frequencyHz.length
    : undefined;
  const effectiveDisplay = validDisplay(display) ? display : DEFAULT_DISPLAY;
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
  const fillGeometry = sweep && visibleTraces[0]
    ? traceGeometry(visibleTraces[0], sweep, width, height, minimumDbm, maximumDbm)
    : undefined;
  const hostTraceGeometries = sweep ? paintOrder.flatMap((trace) => {
    const geometry = traceGeometry(trace, sweep, width, height, minimumDbm, maximumDbm);
    return geometry ? [{ trace, geometry }] : [];
  }) : [];
  const firmwareTraceGeometries = sweep ? firmwareOverlays.flatMap((trace) => {
    const geometry = traceGeometry(trace, sweep, width, height, minimumDbm, maximumDbm);
    return geometry ? [{ trace, geometry }] : [];
  }) : [];
  const hostTraceLegend = [...hostTraceGeometries].sort((left, right) => left.trace.traceId - right.trace.traceId);
  const firmwareTraceLegend = [...firmwareTraceGeometries].sort((left, right) => left.trace.traceId - right.trace.traceId);
  const pointerFrequency = (event: ReactPointerEvent<SVGSVGElement>) => {
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

  return <section className={`plot-panel ${sweep && activeMarker ? 'has-marker-readout-gutter' : ''}`} aria-label="Spectrum plot">
    <div className="panel-header"><div><span className="live-indicator"/><strong>{busy ? 'Acquiring' : sweep ? `Sweep ${sweep.sequence}` : 'No sweep'}</strong>{hostTraceLegend.length + firmwareTraceLegend.length > 0 && <small>{hostTraceLegend.map(({ trace }) => `H${trace.traceId} ${traceAbbreviation(trace.mode)}`).join(' · ')}{firmwareTraceLegend.map(({ trace }) => ` · D${trace.traceId} ${trace.role.toUpperCase()}`).join('')}</small>}</div><div className="plot-meta"><span><Activity size={13}/>{sweepPointCount === undefined ? '—' : `${sweepPointCount} points`}</span><span><Orbit size={13}/>{renderableDetections.length} signal{renderableDetections.length === 1 ? '' : 's'}</span><span>{hostTraceLegend.length} host · {firmwareTraceLegend.length} device</span></div></div>
    {sweep && activeMarker && <MarkerReadoutGutter marker={activeMarker}/>}
    <div className={`plot-canvas ${busy ? 'is-loading' : ''} ${onMarkerPlace ? 'marker-placeable' : ''}`}>
      <div className="y-labels">{Array.from({ length: 5 }, (_, index) => <span key={index}>{formatAxisLevel(maximumDbm - index * effectiveDisplay.decibelsPerDivision * 2.5)}</span>)}<em>dBm</em></div>
      {!sweep ? <div className="plot-empty"><div className="empty-atom"><AtomicMark size={76}/></div><strong>No sweep</strong><p>Connect and acquire.</p></div> : <div className="plot-graph"><div className="plot-data-viewport"><svg data-agent-control={onMarkerPlace ? 'spectrum.marker-place' : undefined} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Measured power by frequency" onPointerDown={pointerFrequency} onPointerMove={(event) => { if (event.buttons === 1) pointerFrequency(event); }}>
        <defs><linearGradient id={traceFillId} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#64d2ff" stopOpacity=".18"/><stop offset=".7" stopColor="#0a84ff" stopOpacity=".035"/><stop offset="1" stopColor="#bf5af2" stopOpacity="0"/></linearGradient><filter id={traceGlowId}><feGaussianBlur stdDeviation="1.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
        {Array.from({ length: 9 }, (_, index) => <line key={`v${index}`} x1={index * width / 8} x2={index * width / 8} y1="0" y2={height} className="plot-grid"/>)}
        {Array.from({ length: 5 }, (_, index) => <line key={`h${index}`} x1="0" x2={width} y1={index * height / 4} y2={index * height / 4} className="plot-grid"/>)}
        {detectionOverlay && <g className="detection-overlays" data-testid="detection-overlays" aria-label={`${renderableDetections.length} detected signal ${renderableDetections.length === 1 ? 'region' : 'regions'}`}>
          {renderableDetections.map((detection) => {
            const geometry = detectionGeometry(detection, sweep, width);
            if (!geometry) return null;
            return <rect key={`band-${detection.id}`} className={`detection-band ${detection.id === selectedDetectionId ? 'selected' : ''}`} x={geometry.startX} y="0" width={geometry.width} height={height} vectorEffect="non-scaling-stroke"/>;
          })}
        </g>}
        {fillGeometry && <polygon points={`${fillGeometry.firstX},${height} ${fillGeometry.points} ${fillGeometry.lastX},${height}`} fill={`url(#${traceFillId})`}/>}
        {hostTraceGeometries.map(({ trace, geometry }) => <polyline key={trace.traceId} points={geometry.points} className={`trace-line t${trace.traceId} ${trace.traceId === activeTraceId ? 'active' : ''}`} vectorEffect="non-scaling-stroke" filter={trace.traceId === activeTraceId ? `url(#${traceGlowId})` : undefined}/>)}
        {firmwareTraceGeometries.map(({ trace, geometry }) => <polyline key={`firmware-${trace.traceId}`} points={geometry.points} className={`trace-line firmware-trace f${trace.traceId}`} vectorEffect="non-scaling-stroke"/>)}
        {detectionOverlay && renderableDetections.map((detection) => {
          const geometry = detectionGeometry(detection, sweep, width);
          if (!geometry) return null;
          return <line key={`center-${detection.id}`} className={`detection-center ${detection.id === selectedDetectionId ? 'selected' : ''}`} x1={geometry.centerX} x2={geometry.centerX} y1="0" y2={height} vectorEffect="non-scaling-stroke"/>;
        })}
        {renderableMarkers.map((marker) => {
          const placement = markerOverlayPlacement(marker, sweep, width, height, minimumDbm, maximumDbm);
          if (!placement) return null;
          const x = placement.leftPercent / 100 * width;
          return <line key={marker.markerId} className={`plot-marker-line t${marker.traceId} ${marker.markerId === activeMarkerId ? 'active' : ''}`} x1={x} x2={x} y1={placement.traceY} y2={height} vectorEffect="non-scaling-stroke"/>;
        })}
        {activeMarker && <MarkerThreeDecibelBracket marker={activeMarker} sweep={sweep} width={width} height={height} minimumDbm={minimumDbm} maximumDbm={maximumDbm}/>}
      </svg></div><div className="plot-marker-overlay" data-testid="plot-marker-overlay">{renderableMarkers.map((marker) => {
        const placement = markerOverlayPlacement(marker, sweep, width, height, minimumDbm, maximumDbm);
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

function MarkerThreeDecibelBracket({ marker, sweep, width, height, minimumDbm, maximumDbm }: {
  marker: MarkerReading;
  sweep: Sweep;
  width: number;
  height: number;
  minimumDbm: number;
  maximumDbm: number;
}) {
  const characterization = marker.localCharacterization;
  if (!('threeDecibelBandwidth' in characterization)) return null;
  const measurement = characterization.threeDecibelBandwidth;
  if (measurement.status === 'unavailable') return null;
  const spanHz = sweep.actualStopHz - sweep.actualStartHz;
  if (!Number.isFinite(spanHz) || spanHz <= 0
    || !Number.isFinite(width) || width <= 0
    || !Number.isFinite(height) || height <= 0
    || !Number.isFinite(measurement.startHz)
    || !Number.isFinite(measurement.stopHz)
    || !Number.isFinite(measurement.halfPowerLevelDbm)
    || measurement.stopHz <= measurement.startHz
    || measurement.startHz < sweep.actualStartHz
    || measurement.stopHz > sweep.actualStopHz) return null;
  const startX = (measurement.startHz - sweep.actualStartHz) / spanHz * width;
  const stopX = (measurement.stopHz - sweep.actualStartHz) / spanHz * width;
  const y = powerY(measurement.halfPowerLevelDbm, height, minimumDbm, maximumDbm);
  if (y === undefined) return null;
  return <g className={`marker-three-db-bracket ${measurement.status}`} data-testid="marker-three-db-bracket" aria-label={`M${marker.markerId} observed 3 dB response from ${measurement.startHz} to ${measurement.stopHz} Hz`}>
    <line x1={startX} x2={stopX} y1={y} y2={y} vectorEffect="non-scaling-stroke"/>
    <line x1={startX} x2={startX} y1={Math.max(0, y - 7)} y2={Math.min(height, y + 7)} vectorEffect="non-scaling-stroke"/>
    <line x1={stopX} x2={stopX} y1={Math.max(0, y - 7)} y2={Math.min(height, y + 7)} vectorEffect="non-scaling-stroke"/>
  </g>;
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

function detectionGeometry(detection: DetectedSignal, sweep: Sweep, width: number): { startX: number; width: number; centerX: number } | undefined {
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

function traceGeometry(
  trace: Pick<TraceFrame | FirmwareTraceFrame, 'frequencyHz' | 'powerDbm'>,
  sweep: Pick<Sweep, 'actualStartHz' | 'actualStopHz'>,
  width: number,
  height: number,
  minimum: number,
  maximum: number,
): { readonly points: string; readonly firstX: number; readonly lastX: number } | undefined {
  if (trace.frequencyHz.length !== trace.powerDbm.length || trace.frequencyHz.length < 2) return undefined;
  if (trace.frequencyHz.some((value) => !Number.isFinite(value))
    || trace.powerDbm.some((value) => !Number.isFinite(value))) return undefined;
  for (let index = 1; index < trace.frequencyHz.length; index++) {
    if (trace.frequencyHz[index]! <= trace.frequencyHz[index - 1]!) return undefined;
  }
  const spanHz = sweep.actualStopHz - sweep.actualStartHz;
  if (!Number.isFinite(sweep.actualStartHz)
    || !Number.isFinite(sweep.actualStopHz)
    || !Number.isFinite(spanHz)
    || spanHz <= 0
    || !Number.isFinite(width)
    || width <= 0
    || !Number.isFinite(height)
    || height <= 0
    || !Number.isFinite(minimum)
    || !Number.isFinite(maximum)
    || maximum <= minimum
    || trace.frequencyHz.at(-1)! < sweep.actualStartHz
    || trace.frequencyHz[0]! > sweep.actualStopHz) return undefined;
  const finiteCoordinates: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < trace.frequencyHz.length; index++) {
    const frequencyHz = trace.frequencyHz[index]!;
    // Trace frames are evidence-bearing physical grids and may legitimately be
    // a subspan of the active sweep. Clip a wider frame to the visible sweep
    // before projection so stale/off-screen samples cannot paint outside the
    // shared data viewport (whose overflow is intentionally visible for marker
    // headroom).
    if (frequencyHz < sweep.actualStartHz || frequencyHz > sweep.actualStopHz) continue;
    const x = (frequencyHz - sweep.actualStartHz) / spanHz * width;
    const y = powerY(trace.powerDbm[index]!, height, minimum, maximum);
    if (!Number.isFinite(x) || y === undefined) return undefined;
    finiteCoordinates.push({ x, y });
  }
  if (finiteCoordinates.length < 2) return undefined;
  return {
    points: finiteCoordinates.map(({ x, y }) => `${x},${y}`).join(' '),
    firstX: finiteCoordinates[0]!.x,
    lastX: finiteCoordinates.at(-1)!.x,
  };
}
function powerY(value: number, height: number, minimum: number, maximum: number): number | undefined {
  if (!Number.isFinite(value)
    || !Number.isFinite(height)
    || height <= 0
    || !Number.isFinite(minimum)
    || !Number.isFinite(maximum)
    || maximum <= minimum) return undefined;
  return height - (Math.min(maximum, Math.max(minimum, value)) - minimum) / (maximum - minimum) * height;
}
function validDisplay(display: SpectrumDisplayConfiguration): boolean {
  return Number.isFinite(display.referenceLevelDbm)
    && Number.isFinite(display.decibelsPerDivision)
    && display.decibelsPerDivision > 0
    && Number.isFinite(display.divisions)
    && display.divisions > 0;
}
function traceAbbreviation(mode: TraceFrame['mode']): string { return ({ 'clear-write': 'CLRWR', 'max-hold': 'MAXH', 'min-hold': 'MINH', average: 'AVG', view: 'VIEW', blank: 'BLANK' })[mode]; }
function formatAxisLevel(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(1); }
function formatMarkerLevel(marker: MarkerReading): string {
  if (marker.mode === 'delta' && marker.deltaPowerDb !== undefined) return `Δ ${marker.deltaPowerDb >= 0 ? '+' : ''}${marker.deltaPowerDb.toFixed(1)} dB`;
  if (marker.mode === 'noise-density' && marker.noiseDensityDbmHz !== undefined) return `${marker.noiseDensityDbmHz.toFixed(1)} dBm/Hz`;
  return formatLevel(marker.powerDbm);
}
