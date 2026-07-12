import { useState } from 'react';
import { BarChart3, ChevronLeft, ChevronRight, Crosshair, Gauge, RotateCcw, ScanSearch, Sigma } from 'lucide-react';
import type {
  MarkerConfiguration,
  FirmwareTraceFrame,
  FirmwareTraceId,
  FirmwareTraceVisibility,
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
import { EditableParameter, SelectParameter, ToggleParameter } from './ParameterRow.js';

type Panel = 'markers' | 'traces' | 'display';

export interface MeasurementDockProps {
  traces: TraceBankConfiguration;
  frames: readonly TraceFrame[];
  firmwareFrames: readonly FirmwareTraceFrame[];
  visibleFirmwareTraceIds: FirmwareTraceVisibility;
  onFirmwareTraceVisibility(traceId: FirmwareTraceId, visible: boolean): void;
  activeTraceId: TraceId;
  onActiveTrace(traceId: TraceId): void;
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
  const [panel, setPanel] = useState<Panel>('markers');
  const activeMarker = props.markers.find((marker) => marker.id === props.activeMarkerId);
  if (!activeMarker) throw new Error(`Active marker M${props.activeMarkerId} does not exist`);
  const activeReading = props.readings.find((reading) => reading.markerId === props.activeMarkerId);
  const enabledMarkers = props.markers.filter((marker) => marker.enabled);
  const visibleTraces = props.traces.filter((trace) => trace.mode !== 'blank');

  return <section className="measurement-dock" aria-label="Markers, traces, and display controls">
    <nav className="measurement-tabs" aria-label="Measurement controls">
      <button className={panel === 'markers' ? 'active' : ''} onClick={() => setPanel('markers')} data-agent-control="measurement.markers"><Crosshair size={15}/><span>Markers</span><em>{enabledMarkers.length}/8</em></button>
      <button className={panel === 'traces' ? 'active' : ''} onClick={() => setPanel('traces')} data-agent-control="measurement.traces"><BarChart3 size={15}/><span>Traces</span><em>{visibleTraces.length}/4</em></button>
      <button className={panel === 'display' ? 'active' : ''} onClick={() => setPanel('display')} data-agent-control="measurement.display"><Gauge size={15}/><span>Display</span><em>{props.display.decibelsPerDivision} dB/div</em></button>
    </nav>

    {panel === 'markers' && <div className="measurement-panel marker-panel">
      <div className="marker-selector" aria-label="Active marker">{props.markers.map((marker) => {
        const active = marker.id === props.activeMarkerId;
        return <button
          key={marker.id}
          type="button"
          className={`${active ? 'active' : ''} ${marker.enabled ? 'enabled' : ''}`}
          aria-label={`Marker ${marker.id}, ${marker.enabled ? 'visible' : 'hidden'}${active ? ', selected' : ''}`}
          aria-pressed={marker.enabled}
          title={active ? `${marker.enabled ? 'Hide' : 'Show'} marker ${marker.id}` : `Select marker ${marker.id}`}
          onClick={() => active ? props.onMarker({ ...marker, enabled: !marker.enabled }) : props.onActiveMarker(marker.id)}
          data-agent-control={`marker.${marker.id}.${active ? 'enabled' : 'select'}`}
        ><span>M{marker.id}</span><i/></button>;
      })}</div>
      <div className="active-marker-result"><small>M{activeMarker.id} · {activeMarker.mode.replace('-', ' ').toUpperCase()}</small><strong>{activeReading ? formatMarkerReading(activeReading) : 'No trace data'}</strong><span>{activeReading ? formatFrequency(activeReading.frequencyHz) : 'Place on the trace or run a peak search'}</span></div>
      <div className="parameter-stack marker-settings">
        <ToggleParameter label={`Marker M${activeMarker.id} visibility`} value={activeMarker.enabled} controlId={`marker.${activeMarker.id}.enabled`} onToggle={(enabled) => props.onMarker({ ...activeMarker, enabled })}/>
        <EditableParameter label="Frequency" value={activeMarker.frequencyHz} displayValue={formatFrequency(activeMarker.frequencyHz)} unit="Hz" minimum={0} maximum={17_922_600_000} controlId={`marker.${activeMarker.id}.frequency`} onCommit={(value) => props.onMarker({ ...activeMarker, enabled: true, tracking: 'fixed', frequencyHz: Number(value) })}/>
        <SelectParameter label="Trace" value={activeMarker.traceId} options={props.traces.map((trace) => ({ value: trace.id, label: `Trace ${trace.id} · ${traceModeLabel(trace.mode)}` }))} controlId={`marker.${activeMarker.id}.trace`} onValue={(value) => props.onMarker({ ...activeMarker, traceId: Number(value) as TraceId })}/>
        <SelectParameter label="Readout" value={activeMarker.mode} options={[{ value: 'normal', label: 'Normal' }, { value: 'delta', label: 'Delta' }, { value: 'noise-density', label: 'Noise density' }]} controlId={`marker.${activeMarker.id}.readout`} onValue={(value) => props.onMarker(markerWithMode(activeMarker, value as MarkerConfiguration['mode']))}/>
        {activeMarker.mode === 'delta' && <SelectParameter label="Reference marker" value={activeMarker.referenceMarkerId ?? (activeMarker.id === 1 ? 2 : 1)} options={props.markers.filter((marker) => marker.id !== activeMarker.id).map((marker) => ({ value: marker.id, label: `Marker ${marker.id}` }))} controlId={`marker.${activeMarker.id}.reference`} onValue={(value) => props.onMarker({ ...activeMarker, referenceMarkerId: Number(value) as MarkerId })}/>}
        <ToggleParameter label="Peak tracking" value={activeMarker.tracking === 'peak'} controlId={`marker.${activeMarker.id}.peak-track`} onToggle={(enabled) => props.onMarker({ ...activeMarker, enabled: true, tracking: enabled ? 'peak' : 'fixed' })}/>
      </div>
      <section className="marker-searches">
        <div className="panel-section-label"><span>Search</span><small>Moves M{activeMarker.id}</small></div>
        <div className="search-action-grid"><button onClick={() => props.onSearch('peak')} data-agent-control="marker.search.peak"><ScanSearch size={14}/>Peak</button><button onClick={() => props.onSearch('minimum')} data-agent-control="marker.search.minimum"><Sigma size={14}/>Minimum</button><button onClick={() => props.onSearch('next-left')} data-agent-control="marker.search.left"><ChevronLeft size={14}/>Previous</button><button onClick={() => props.onSearch('next-right')} data-agent-control="marker.search.right">Next<ChevronRight size={14}/></button></div>
        <div className="parameter-stack">
          <EditableParameter label="Minimum level" value={props.search.minimumLevelDbm} displayValue={`${props.search.minimumLevelDbm} dBm`} unit="dBm" minimum={-174} maximum={30} controlId="marker.search.threshold" onCommit={(value) => props.onSearchConfiguration({ ...props.search, minimumLevelDbm: Number(value) })}/>
          <EditableParameter label="Peak excursion" value={props.search.minimumExcursionDb} displayValue={`${props.search.minimumExcursionDb} dB`} unit="dB" minimum={0} maximum={100} controlId="marker.search.excursion" onCommit={(value) => props.onSearchConfiguration({ ...props.search, minimumExcursionDb: Number(value) })}/>
        </div>
      </section>
    </div>}

    {panel === 'traces' && <TracePanel {...props}/>}

    {panel === 'display' && <div className="measurement-panel display-panel parameter-stack">
      <EditableParameter label="Reference level" value={props.display.referenceLevelDbm} displayValue={`${props.display.referenceLevelDbm} dBm`} unit="dBm" minimum={-150} maximum={30} controlId="display.reference-level" onCommit={(value) => props.onDisplay({ ...props.display, referenceLevelDbm: Number(value) })}/>
      <SelectParameter label="Vertical scale" value={props.display.decibelsPerDivision} options={[1, 2, 5, 10, 20].map((value) => ({ value, label: `${value} dB / division` }))} controlId="display.scale" onValue={(value) => props.onDisplay({ ...props.display, decibelsPerDivision: Number(value) as SpectrumDisplayConfiguration['decibelsPerDivision'] })}/>
      <div className="panel-action"><button className="secondary full" onClick={props.onAutoScale} data-agent-control="display.auto-scale"><Gauge size={14}/>Auto scale latest trace</button></div>
    </div>}
  </section>;
}

function markerWithMode(marker: MarkerConfiguration, mode: MarkerConfiguration['mode']): MarkerConfiguration {
  const common = { id: marker.id, enabled: marker.enabled, traceId: marker.traceId, frequencyHz: marker.frequencyHz, tracking: marker.tracking };
  if (mode === 'delta') return { ...common, mode, referenceMarkerId: marker.mode === 'delta' ? marker.referenceMarkerId : marker.id === 1 ? 2 : 1 };
  return { ...common, mode };
}

function TracePanel(props: MeasurementDockProps) {
  const trace = props.traces.find((item) => item.id === props.activeTraceId);
  if (!trace) throw new Error(`Trace ${props.activeTraceId} does not exist`);
  const frame = props.frames.find((item) => item.traceId === trace.id);
  const firmwareOverlays = props.firmwareFrames.filter((item) => item.traceId !== 1);
  const traceEnabled = trace.mode !== 'blank';
  return <div className="measurement-panel trace-panel">
    <div className="trace-selector">{props.traces.map((item) => <button key={item.id} className={`t${item.id} ${item.id === trace.id ? 'active' : ''}`} onClick={() => props.onActiveTrace(item.id)} data-agent-control={`trace.${item.id}.select`}><i className={`trace-color t${item.id}`}/><span>TRACE {item.id}</span></button>)}</div>
    <div className="trace-readout"><span><i className={`trace-color t${trace.id}`}/><small>TRACE {trace.id}</small></span><strong>{traceModeLabel(trace.mode)}</strong><em>{frame ? `${frame.sweepCount} sweep${frame.sweepCount === 1 ? '' : 's'} captured` : 'No data captured'}</em></div>
    <div className="parameter-stack trace-settings">
      <ToggleParameter label={`Trace ${trace.id}`} value={traceEnabled} controlId={`trace.${trace.id}.enabled`} onToggle={(enabled) => props.onTrace({ ...trace, mode: enabled ? 'clear-write' : 'blank' })}/>
      {traceEnabled && <SelectParameter label="Trace mode" value={trace.mode} options={[{ value: 'clear-write', label: 'Clear / Write' }, { value: 'max-hold', label: 'Maximum Hold' }, { value: 'min-hold', label: 'Minimum Hold' }, { value: 'average', label: 'Average' }, { value: 'view', label: 'View / Freeze' }]} controlId={`trace.${trace.id}.mode`} onValue={(value) => props.onTrace({ ...trace, mode: value as TraceConfiguration['mode'] })}/>}
      {trace.mode === 'average' && <EditableParameter label="Average count" value={trace.averageCount} displayValue={`${trace.averageCount} sweeps`} minimum={2} maximum={100} step={1} controlId={`trace.${trace.id}.average-count`} onCommit={(value) => props.onTrace({ ...trace, averageCount: Number(value) })}/>}
    </div>
    <div className="panel-action"><button className="secondary full" onClick={() => props.onTraceReset(trace.id)} data-agent-control={`trace.${trace.id}.reset`}><RotateCcw size={14}/>Reset Trace {trace.id}</button></div>
    {firmwareOverlays.length > 0 && <section className="firmware-trace-bank">
      <div className="panel-section-label"><span>Instrument overlays</span><small>Explicit readback · off by default</small></div>
      <div className="parameter-stack">{firmwareOverlays.map((item) => <ToggleParameter key={item.traceId} label={`D${item.traceId} · ${firmwareTraceRole(item)}`} value={props.visibleFirmwareTraceIds.includes(item.traceId)} controlId={`firmware-trace.${item.traceId}.visible`} onToggle={(visible) => props.onFirmwareTraceVisibility(item.traceId, visible)}/>)}</div>
    </section>}
  </div>;
}

function formatMarkerReading(reading: MarkerReading | undefined): string {
  if (!reading) return '—';
  if (reading.mode === 'delta' && reading.deltaPowerDb !== undefined && reading.deltaFrequencyHz !== undefined) return `Δ ${reading.deltaPowerDb >= 0 ? '+' : ''}${reading.deltaPowerDb.toFixed(1)} dB · ${formatSignedFrequency(reading.deltaFrequencyHz)}`;
  if (reading.mode === 'noise-density' && reading.noiseDensityDbmHz !== undefined) return `${reading.noiseDensityDbmHz.toFixed(1)} dBm/Hz`;
  return formatLevel(reading.powerDbm);
}

function formatSignedFrequency(value: number): string { return `${value >= 0 ? '+' : '−'}${formatFrequency(Math.abs(value))}`; }
function traceModeLabel(value: TraceConfiguration['mode']): string {
  if (value === 'blank') return 'Off';
  return value.replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase()).replace('Min ', 'Minimum ').replace('Max ', 'Maximum ');
}
function firmwareTraceRole(frame: FirmwareTraceFrame): string {
  const role = frame.role === 'measured' ? 'Measured' : frame.role === 'raw' ? 'Raw' : 'Stored';
  return frame.frozen === true ? `${role} · frozen` : frame.frozen === false ? role : `${role} · freeze unknown`;
}
