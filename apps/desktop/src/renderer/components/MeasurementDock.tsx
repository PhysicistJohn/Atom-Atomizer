import { useState } from 'react';
import { BarChart3, ChevronLeft, ChevronRight, Crosshair, Eye, Gauge, RotateCcw, ScanSearch, Sigma, X } from 'lucide-react';
import type {
  MarkerConfiguration,
  MarkerId,
  MarkerReading,
  MarkerSearchAction,
  MarkerSearchConfiguration,
  SpectrumDisplayConfiguration,
  TraceBankConfiguration,
  TraceConfiguration,
  TraceFrame,
  TraceId,
} from '@tinysa/contracts';
import { formatFrequency, formatLevel } from '../format.js';

type Panel = 'markers' | 'traces' | 'display';

export interface MeasurementDockProps {
  traces: TraceBankConfiguration;
  frames: readonly TraceFrame[];
  markers: readonly MarkerConfiguration[];
  readings: readonly MarkerReading[];
  activeMarkerId: MarkerId;
  search: MarkerSearchConfiguration;
  display: SpectrumDisplayConfiguration;
  onTrace(configuration: TraceConfiguration): void;
  onTraceReset(traceId: TraceId): void;
  onMarker(configuration: MarkerConfiguration): void;
  onActiveMarker(markerId: MarkerId): void;
  onSearch(action: MarkerSearchAction): void;
  onSearchConfiguration(configuration: MarkerSearchConfiguration): void;
  onDisplay(configuration: SpectrumDisplayConfiguration): void;
  onAutoScale(): void;
}

export function MeasurementDock(props: MeasurementDockProps) {
  const [panel, setPanel] = useState<Panel>();
  const activeMarker = props.markers.find((marker) => marker.id === props.activeMarkerId)!;
  const activeReading = props.readings.find((reading) => reading.markerId === props.activeMarkerId);
  const enabledMarkers = props.markers.filter((marker) => marker.enabled);
  const visibleTraces = props.traces.filter((trace) => trace.mode !== 'blank');
  const toggle = (next: Panel) => setPanel((current) => current === next ? undefined : next);

  return <section className={`measurement-dock ${panel ? 'open' : ''}`} aria-label="Markers, traces, and display controls">
    <div className="measurement-commandbar">
      <div className="measurement-tabs">
        <button className={panel === 'markers' ? 'active' : ''} onClick={() => toggle('markers')} data-agent-control="measurement.markers"><Crosshair size={14}/><span>Markers</span><em>{enabledMarkers.length}/8</em></button>
        <button className={panel === 'traces' ? 'active' : ''} onClick={() => toggle('traces')} data-agent-control="measurement.traces"><BarChart3 size={14}/><span>Traces</span><em>{visibleTraces.length}/4</em></button>
        <button className={panel === 'display' ? 'active' : ''} onClick={() => toggle('display')} data-agent-control="measurement.display"><Gauge size={14}/><span>Display</span><em>{props.display.decibelsPerDivision} dB/div</em></button>
      </div>
      <div className="marker-readout-strip">
        {enabledMarkers.length === 0 && <span className="measurement-empty">No active markers</span>}
        {enabledMarkers.slice(0, 4).map((marker) => {
          const reading = props.readings.find((item) => item.markerId === marker.id);
          return <button key={marker.id} className={marker.id === props.activeMarkerId ? 'active' : ''} onClick={() => props.onActiveMarker(marker.id)}><i className={`trace-color t${marker.traceId}`}/><strong>M{marker.id}</strong><span>{formatMarkerReading(reading)}</span></button>;
        })}
        {enabledMarkers.length > 4 && <span className="more-markers">+{enabledMarkers.length - 4}</span>}
      </div>
      <span className="host-evidence">HOST MATH</span>
    </div>

    {panel === 'markers' && <div className="measurement-panel marker-panel">
      <div className="marker-selector">{props.markers.map((marker) => <button key={marker.id} className={`${marker.id === props.activeMarkerId ? 'active' : ''} ${marker.enabled ? 'enabled' : ''}`} onClick={() => props.onActiveMarker(marker.id)}><span>M{marker.id}</span><i/></button>)}</div>
      <div className="marker-settings">
        <button className={`state-toggle ${activeMarker.enabled ? 'on' : ''}`} onClick={() => props.onMarker({ ...activeMarker, enabled: !activeMarker.enabled })}>{activeMarker.enabled ? <Eye size={13}/> : <X size={13}/>}M{activeMarker.id} {activeMarker.enabled ? 'ON' : 'OFF'}</button>
        <label><span>Frequency</span><div><input type="number" value={activeMarker.frequencyHz} min={0} max={17_922_600_000} onChange={(event) => props.onMarker({ ...activeMarker, enabled: true, tracking: 'fixed', frequencyHz: Number(event.target.value) })}/><em>Hz</em></div></label>
        <label><span>Trace</span><select value={activeMarker.traceId} onChange={(event) => props.onMarker({ ...activeMarker, traceId: Number(event.target.value) as TraceId })}>{props.traces.map((trace) => <option key={trace.id} value={trace.id}>T{trace.id} · {trace.mode}</option>)}</select></label>
        <label><span>Readout</span><select value={activeMarker.mode} onChange={(event) => {
          const mode = event.target.value as MarkerConfiguration['mode'];
          props.onMarker({ ...activeMarker, mode, ...(mode === 'delta' && activeMarker.referenceMarkerId === undefined ? { referenceMarkerId: activeMarker.id === 1 ? 2 : 1 } : {}) });
        }}><option value="normal">Normal</option><option value="delta">Delta</option><option value="noise-density">Noise density</option></select></label>
        {activeMarker.mode === 'delta' && <label><span>Reference</span><select value={activeMarker.referenceMarkerId} onChange={(event) => props.onMarker({ ...activeMarker, referenceMarkerId: Number(event.target.value) as MarkerId })}>{props.markers.filter((marker) => marker.id !== activeMarker.id).map((marker) => <option key={marker.id} value={marker.id}>M{marker.id}</option>)}</select></label>}
        <button className={`tracking-toggle ${activeMarker.tracking === 'peak' ? 'on' : ''}`} onClick={() => props.onMarker({ ...activeMarker, enabled: true, tracking: activeMarker.tracking === 'peak' ? 'fixed' : 'peak' })}><ScanSearch size={13}/>Peak track</button>
      </div>
      <div className="marker-searches">
        <span>SEARCH ACTIVE MARKER</span>
        <div><button onClick={() => props.onSearch('peak')}><ScanSearch size={13}/>Peak</button><button onClick={() => props.onSearch('minimum')}><Sigma size={13}/>Min</button><button onClick={() => props.onSearch('next-left')}><ChevronLeft size={13}/>Next</button><button onClick={() => props.onSearch('next-right')}>Next<ChevronRight size={13}/></button></div>
        <label><span>Threshold</span><input type="number" value={props.search.minimumLevelDbm} onChange={(event) => props.onSearchConfiguration({ ...props.search, minimumLevelDbm: Number(event.target.value) })}/><em>dBm</em></label>
        <label><span>Excursion</span><input type="number" min="0" max="100" value={props.search.minimumExcursionDb} onChange={(event) => props.onSearchConfiguration({ ...props.search, minimumExcursionDb: Number(event.target.value) })}/><em>dB</em></label>
      </div>
      <div className="active-marker-result"><small>M{activeMarker.id} · {activeMarker.mode.replace('-', ' ').toUpperCase()}</small><strong>{activeReading ? formatMarkerReading(activeReading) : 'NO TRACE DATA'}</strong><span>{activeReading ? formatFrequency(activeReading.frequencyHz) : 'Click the trace or run a search to place it'}</span></div>
    </div>}

    {panel === 'traces' && <div className="measurement-panel trace-panel">
      {props.traces.map((trace) => {
        const frame = props.frames.find((item) => item.traceId === trace.id);
        return <div className={`trace-card t${trace.id}`} key={trace.id}><div><i className={`trace-color t${trace.id}`}/><span><strong>TRACE {trace.id}</strong><small>{frame ? `${frame.sweepCount} SWEEP${frame.sweepCount === 1 ? '' : 'S'}` : 'NO DATA'}</small></span><button title={`Reset trace ${trace.id}`} onClick={() => props.onTraceReset(trace.id)}><RotateCcw size={12}/></button></div><label><span>Mode</span><select value={trace.mode} onChange={(event) => props.onTrace({ ...trace, mode: event.target.value as TraceConfiguration['mode'] })}><option value="clear-write">Clear / Write</option><option value="max-hold">Max Hold</option><option value="min-hold">Min Hold</option><option value="average">Average</option><option value="view">View / Freeze</option><option value="blank">Blank</option></select></label>{trace.mode === 'average' && <label><span>Average count</span><input type="number" min="2" max="100" value={trace.averageCount} onChange={(event) => props.onTrace({ ...trace, averageCount: Number(event.target.value) })}/></label>}<p>HOST-DERIVED · T{trace.id}</p></div>;
      })}
    </div>}

    {panel === 'display' && <div className="measurement-panel display-panel">
      <div><small>AMPLITUDE AXIS</small><strong>{props.display.referenceLevelDbm} dBm reference</strong><span>{props.display.decibelsPerDivision} dB/div · {props.display.divisions} divisions</span></div>
      <label><span>Reference level</span><div><input type="number" min="-150" max="30" value={props.display.referenceLevelDbm} onChange={(event) => props.onDisplay({ ...props.display, referenceLevelDbm: Number(event.target.value) })}/><em>dBm</em></div></label>
      <label><span>Scale</span><select value={props.display.decibelsPerDivision} onChange={(event) => props.onDisplay({ ...props.display, decibelsPerDivision: Number(event.target.value) as SpectrumDisplayConfiguration['decibelsPerDivision'] })}><option value="1">1 dB/div</option><option value="2">2 dB/div</option><option value="5">5 dB/div</option><option value="10">10 dB/div</option><option value="20">20 dB/div</option></select></label>
      <button className="secondary" onClick={props.onAutoScale}><Gauge size={13}/>Auto scale latest</button>
      <p>Display scaling and simultaneous traces are transparent host projections of complete sweep data. They do not claim unreadable firmware state.</p>
    </div>}
  </section>;
}

function formatMarkerReading(reading: MarkerReading | undefined): string {
  if (!reading) return '—';
  if (reading.mode === 'delta' && reading.deltaPowerDb !== undefined && reading.deltaFrequencyHz !== undefined) {
    return `Δ ${reading.deltaPowerDb >= 0 ? '+' : ''}${reading.deltaPowerDb.toFixed(1)} dB · ${formatSignedFrequency(reading.deltaFrequencyHz)}`;
  }
  if (reading.mode === 'noise-density' && reading.noiseDensityDbmHz !== undefined) return `${reading.noiseDensityDbmHz.toFixed(1)} dBm/Hz`;
  return formatLevel(reading.powerDbm);
}

function formatSignedFrequency(value: number): string { return `${value >= 0 ? '+' : '−'}${formatFrequency(Math.abs(value))}`; }
