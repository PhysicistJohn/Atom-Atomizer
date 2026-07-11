import { Activity, Orbit } from 'lucide-react';
import type { PointerEvent } from 'react';
import type { DetectedSignal, MarkerId, MarkerReading, SpectrumDisplayConfiguration, Sweep, TraceFrame } from '@tinysa/contracts';
import { formatFrequency, formatLevel } from '../format.js';
import { AtomicMark } from './AtomicMark.js';

export interface SpectrumPlotProps {
  sweep?: Sweep;
  traces?: readonly TraceFrame[];
  markers?: readonly MarkerReading[];
  activeMarkerId?: MarkerId;
  detections?: readonly DetectedSignal[];
  display?: SpectrumDisplayConfiguration;
  busy: boolean;
  onMarkerPlace?(frequencyHz: number): void;
}

const DEFAULT_DISPLAY: SpectrumDisplayConfiguration = { referenceLevelDbm: -20, decibelsPerDivision: 10, divisions: 10 };

export function SpectrumPlot({ sweep, traces = [], markers = [], activeMarkerId, detections = [], display = DEFAULT_DISPLAY, busy, onMarkerPlace }: SpectrumPlotProps) {
  const width = 1200;
  const height = 430;
  const maximumDbm = display.referenceLevelDbm;
  const minimumDbm = maximumDbm - display.decibelsPerDivision * display.divisions;
  const visibleTraces: readonly TraceFrame[] = traces.length ? traces : sweep ? [{ traceId: 1, mode: 'clear-write', frequencyHz: sweep.frequencyHz, powerDbm: sweep.powerDbm, sweepCount: 1, sourceSweepId: sweep.id, evidence: 'host-derived' }] : [];
  const activeMarker = markers.find((marker) => marker.markerId === activeMarkerId);
  const pointerFrequency = (event: PointerEvent<SVGSVGElement>) => {
    if (!sweep || !onMarkerPlace) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    onMarkerPlace(Math.round(sweep.actualStartHz + fraction * (sweep.actualStopHz - sweep.actualStartHz)));
  };

  return <section className="plot-panel" aria-label="Spectrum plot">
    <div className="panel-header"><div><span className="live-indicator"/><strong>{busy ? 'Acquiring' : sweep ? `Sweep ${sweep.sequence}` : 'No sweep'}</strong>{visibleTraces.length > 0 && <small>{visibleTraces.map((trace) => `T${trace.traceId} ${traceAbbreviation(trace.mode)}`).join(' · ')}</small>}</div><div className="plot-meta"><span><Activity size={13}/>{sweep ? `${sweep.frequencyHz.length} points` : '—'}</span><span><Orbit size={13}/>{detections.length} signal{detections.length === 1 ? '' : 's'}</span><span>{visibleTraces.length} trace{visibleTraces.length === 1 ? '' : 's'}</span></div></div>
    <div className={`plot-canvas ${busy ? 'is-loading' : ''} ${onMarkerPlace ? 'marker-placeable' : ''}`}>
      <div className="y-labels">{Array.from({ length: 5 }, (_, index) => <span key={index}>{formatAxisLevel(maximumDbm - index * display.decibelsPerDivision * 2.5)}</span>)}<em>dBm</em></div>
      {!sweep ? <div className="plot-empty"><div className="empty-atom"><AtomicMark size={76}/></div><strong>No sweep</strong><p>Connect and acquire.</p></div> : <svg data-agent-control="spectrum.marker-place" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Measured power by frequency" onPointerDown={pointerFrequency} onPointerMove={(event) => { if (event.buttons === 1) pointerFrequency(event); }}>
        <defs><linearGradient id="trace-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#64d2ff" stopOpacity=".18"/><stop offset=".7" stopColor="#0a84ff" stopOpacity=".035"/><stop offset="1" stopColor="#bf5af2" stopOpacity="0"/></linearGradient><filter id="trace-glow"><feGaussianBlur stdDeviation="1.5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
        {Array.from({ length: 9 }, (_, index) => <line key={`v${index}`} x1={index * width / 8} x2={index * width / 8} y1="0" y2={height} className="plot-grid"/>)}
        {Array.from({ length: 5 }, (_, index) => <line key={`h${index}`} x1="0" x2={width} y1={index * height / 4} y2={index * height / 4} className="plot-grid"/>)}
        {detections.map((detection) => { const x = (detection.startHz - sweep.actualStartHz) / (sweep.actualStopHz - sweep.actualStartHz) * width; const bandWidth = Math.max(3, detection.bandwidthHz / (sweep.actualStopHz - sweep.actualStartHz) * width); return <g key={detection.id}><rect x={x} y="0" width={bandWidth} height={height} className="detection-band"/><line x1={x + bandWidth / 2} x2={x + bandWidth / 2} y1="12" y2={height} className="detection-center"/></g>; })}
        {visibleTraces[0] && <polygon points={`0,${height} ${tracePoints(visibleTraces[0], width, height, minimumDbm, maximumDbm)} ${width},${height}`} fill="url(#trace-fill)"/>}
        {visibleTraces.slice().reverse().map((trace) => <polyline key={trace.traceId} points={tracePoints(trace, width, height, minimumDbm, maximumDbm)} className={`trace-line t${trace.traceId}`} vectorEffect="non-scaling-stroke" filter={trace.traceId === 1 ? 'url(#trace-glow)' : undefined}/>)}
        {markers.map((marker) => {
          const x = (marker.frequencyHz - sweep.actualStartHz) / (sweep.actualStopHz - sweep.actualStartHz) * width;
          const y = powerY(marker.powerDbm, height, minimumDbm, maximumDbm);
          if (x < 0 || x > width) return null;
          return <g key={marker.markerId} className={`plot-marker t${marker.traceId} ${marker.markerId === activeMarkerId ? 'active' : ''}`}><line x1={x} x2={x} y1={Math.max(0, y - 28)} y2={height} vectorEffect="non-scaling-stroke"/><circle cx={x} cy={y} r={marker.markerId === activeMarkerId ? 5 : 3.5} vectorEffect="non-scaling-stroke"/><text x={x + 7} y={Math.max(12, y - 8)}>M{marker.markerId}</text></g>;
        })}
      </svg>}
      {sweep && activeMarker && <div className={`peak-readout marker-active-readout t${activeMarker.traceId}`} style={{ left: `${Math.min(88, Math.max(12, (activeMarker.frequencyHz - sweep.actualStartHz) / (sweep.actualStopHz - sweep.actualStartHz) * 100))}%`, top: `${Math.min(82, Math.max(17, powerY(activeMarker.powerDbm, height, minimumDbm, maximumDbm) / height * 100))}%` }}><small>M{activeMarker.markerId}</small><strong>{formatMarkerLevel(activeMarker)}</strong><span>{formatFrequency(activeMarker.frequencyHz)}</span></div>}
      {sweep && <div className="x-labels"><span>{formatFrequency(sweep.actualStartHz)}</span><span>{formatFrequency((sweep.actualStartHz + sweep.actualStopHz) / 2)}</span><span>{formatFrequency(sweep.actualStopHz)}</span></div>}
    </div>
  </section>;
}

function tracePoints(trace: TraceFrame, width: number, height: number, minimum: number, maximum: number): string {
  return trace.powerDbm.map((value, index) => `${index / Math.max(1, trace.powerDbm.length - 1) * width},${powerY(value, height, minimum, maximum)}`).join(' ');
}
function powerY(value: number, height: number, minimum: number, maximum: number): number { return height - (Math.min(maximum, Math.max(minimum, value)) - minimum) / (maximum - minimum) * height; }
function traceAbbreviation(mode: TraceFrame['mode']): string { return ({ 'clear-write': 'CLRWR', 'max-hold': 'MAXH', 'min-hold': 'MINH', average: 'AVG', view: 'VIEW', blank: 'BLANK' })[mode]; }
function formatAxisLevel(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(1); }
function formatMarkerLevel(marker: MarkerReading): string {
  if (marker.mode === 'delta' && marker.deltaPowerDb !== undefined) return `Δ ${marker.deltaPowerDb >= 0 ? '+' : ''}${marker.deltaPowerDb.toFixed(1)} dB`;
  if (marker.mode === 'noise-density' && marker.noiseDensityDbmHz !== undefined) return `${marker.noiseDensityDbmHz.toFixed(1)} dBm/Hz`;
  return formatLevel(marker.powerDbm);
}
