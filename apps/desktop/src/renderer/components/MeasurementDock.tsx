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
import { formatFrequency, formatLabel, formatPowerDensity, formatPowerLevel, powerAxisUnit } from '../format.js';
import { DEVELOPMENT_RENDERER } from '../development.js';
import { EditableParameter, SelectParameter, ToggleParameter } from './ParameterRow.js';

export type MeasurementDockPanel = 'markers' | 'traces' | 'display';

export interface MeasurementDockProps {
  /** Controlled by the measurement drawer when present; direct component
   * consumers can continue to use the internal tab state. */
  panel?: MeasurementDockPanel;
  initialPanel?: MeasurementDockPanel;
  onPanel?(panel: MeasurementDockPanel): void;
  /**
   * The spectrum workspace already exposes direct Markers, Traces, and
   * Display buttons in its utility bar. Hide this duplicate selector when the
   * dock is used inside that controlled drawer; standalone consumers retain
   * the normal local tab navigation.
   */
  showTabs?: boolean;
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
  const [uncontrolledPanel, setUncontrolledPanel] = useState<MeasurementDockPanel>(props.initialPanel ?? 'markers');
  const panel = props.panel ?? uncontrolledPanel;
  const showTabs = props.showTabs ?? true;
  const selectPanel = (next: MeasurementDockPanel) => {
    if (props.panel === undefined) setUncontrolledPanel(next);
    props.onPanel?.(next);
  };
  const activeMarker = props.markers.find((marker) => marker.id === props.activeMarkerId);
  if (!activeMarker) throw new Error(`Active marker M${props.activeMarkerId} does not exist`);
  const activeReading = props.readings.find((reading) => reading.markerId === props.activeMarkerId);
  const activeFrame = props.frames.find((frame) => frame.traceId === activeMarker.traceId);
  const displayFrame = props.frames.find((frame) => frame.traceId === props.activeTraceId);
  const activePowerReference = activeReading?.powerReference ?? activeFrame?.powerReference;
  const relativePower = activePowerReference === 'uncalibrated-dbfs-relative';
  const enabledMarkers = props.markers.filter((marker) => marker.enabled);
  const visibleTraces = props.traces.filter((trace) => trace.mode !== 'blank');

  return <section className="measurement-dock" aria-label="Markers, traces, and display controls">
    {showTabs && <nav className="measurement-tabs" aria-label="Measurement controls">
      <button type="button" aria-pressed={panel === 'markers'} className={panel === 'markers' ? 'active' : ''} onClick={() => selectPanel('markers')} data-agent-control="measurement.markers"><Crosshair size={15}/><span>Markers</span><em>{enabledMarkers.length}/8</em></button>
      <button type="button" aria-pressed={panel === 'traces'} className={panel === 'traces' ? 'active' : ''} onClick={() => selectPanel('traces')} data-agent-control="measurement.traces"><BarChart3 size={15}/><span>Traces</span><em>{visibleTraces.length}/4</em></button>
      <button type="button" aria-pressed={panel === 'display'} className={panel === 'display' ? 'active' : ''} onClick={() => selectPanel('display')} data-agent-control="measurement.display"><Gauge size={15}/><span>Display</span><em>{props.display.decibelsPerDivision} dB/div</em></button>
    </nav>}

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
      <div
        className="active-marker-result"
        aria-label={`Marker M${activeMarker.id} current reading`}
        aria-description={DEVELOPMENT_RENDERER && activeReading
          ? `sourceSweepId=${activeReading.sourceSweepId}`
          : undefined}
      ><small>M{activeMarker.id} · {activeMarker.mode.replace('-', ' ').toUpperCase()}</small><strong>{activeReading ? formatMarkerReading(activeReading) : 'No trace data'}</strong><span>{activeReading ? formatFrequency(activeReading.frequencyHz) : 'Place on the trace or run a peak search'}</span></div>
      {activeReading && <MarkerCharacterizationCard reading={activeReading}/>}
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
        <div className="search-action-grid"><button onClick={() => props.onSearch('peak')} data-agent-control="marker.search.peak"><ScanSearch size={14}/>Peak</button><button onClick={() => props.onSearch('minimum')} data-agent-control="marker.search.minimum"><Sigma size={14}/>Minimum</button><button disabled={relativePower} title={relativePower ? 'Directional search requires a calibrated absolute dBm minimum level' : undefined} onClick={() => props.onSearch('next-left')} data-agent-control="marker.search.left"><ChevronLeft size={14}/>Previous</button><button disabled={relativePower} title={relativePower ? 'Directional search requires a calibrated absolute dBm minimum level' : undefined} onClick={() => props.onSearch('next-right')} data-agent-control="marker.search.right">Next<ChevronRight size={14}/></button></div>
        <div className="parameter-stack">
          <EditableParameter label="Minimum level" value={props.search.minimumLevelDbm} displayValue={relativePower ? 'Unavailable · calibrated dBm required' : `${props.search.minimumLevelDbm} dBm`} unit="dBm" minimum={-174} maximum={30} disabled={relativePower} controlId="marker.search.threshold" onCommit={(value) => props.onSearchConfiguration({ ...props.search, minimumLevelDbm: Number(value) })}/>
          <EditableParameter label="Peak excursion" value={props.search.minimumExcursionDb} displayValue={`${props.search.minimumExcursionDb} dB`} unit="dB" minimum={0} maximum={100} controlId="marker.search.excursion" onCommit={(value) => props.onSearchConfiguration({ ...props.search, minimumExcursionDb: Number(value) })}/>
        </div>
      </section>
    </div>}

    {panel === 'traces' && <TracePanel {...props}/>}

    {panel === 'display' && <div className="measurement-panel display-panel">
      <section className="display-fit-action" aria-label="Fit display scale">
        <div><strong>Fit the display</strong><span>Set both axes from the latest trace.</span></div>
        <button className="secondary" onClick={props.onAutoScale} data-agent-control="display.auto-scale"><Gauge size={14}/>Fit latest trace</button>
      </section>
      <details className="display-manual-scale">
        <summary><span>Manual scale</span><small>{props.display.referenceLevelDbm} {powerAxisUnit(displayFrame?.powerReference)} · {props.display.decibelsPerDivision} dB / div</small></summary>
        <div className="parameter-stack">
          <EditableParameter label="Reference level" value={props.display.referenceLevelDbm} displayValue={`${props.display.referenceLevelDbm} ${powerAxisUnit(displayFrame?.powerReference)}`} unit={powerAxisUnit(displayFrame?.powerReference)} minimum={-150} maximum={30} controlId="display.reference-level" onCommit={(value) => props.onDisplay({ ...props.display, referenceLevelDbm: Number(value) })}/>
          <SelectParameter label="Vertical scale" value={props.display.decibelsPerDivision} options={[1, 2, 5, 10, 20].map((value) => ({ value, label: `${value} dB / division` }))} controlId="display.scale" onValue={(value) => props.onDisplay({ ...props.display, decibelsPerDivision: Number(value) as SpectrumDisplayConfiguration['decibelsPerDivision'] })}/>
        </div>
      </details>
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
  const visibleOverlayCount = firmwareOverlays.filter((item) => props.visibleFirmwareTraceIds.includes(item.traceId)).length;
  return <div className="measurement-panel trace-panel">
    <div className="trace-selector" aria-label="Choose a trace to configure">{props.traces.map((item) => <button key={item.id} className={`t${item.id} ${item.id === trace.id ? 'active' : ''}`} aria-pressed={item.id === trace.id} onClick={() => props.onActiveTrace(item.id)} data-agent-control={`trace.${item.id}.select`}><i className={`trace-color t${item.id}`}/><span>TRACE {item.id}</span><small>{traceModeLabel(item.mode)}</small></button>)}</div>
    <div className="trace-readout"><span><i className={`trace-color t${trace.id}`}/><small>TRACE {trace.id}</small></span><strong>{traceModeLabel(trace.mode)}</strong><em>{frame ? `${frame.sweepCount} sweep${frame.sweepCount === 1 ? '' : 's'} captured` : 'Waiting for a sweep'}</em></div>
    <section className="trace-behavior" aria-labelledby={`trace-${trace.id}-behavior-label`}>
      <div className="panel-section-label"><span id={`trace-${trace.id}-behavior-label`}>How this trace updates</span><small>Choose an outcome for new sweeps</small></div>
      <div className="trace-behavior-grid" role="radiogroup" aria-label={`Trace ${trace.id} behavior`} data-agent-control={`trace.${trace.id}.mode`}>
        {TRACE_BEHAVIOR_OPTIONS.map((option) => <label
          key={option.value}
          className={trace.mode === option.value ? 'active' : ''}
        ><input
          type="radio"
          name={`trace-${trace.id}-behavior`}
          checked={trace.mode === option.value}
          onChange={() => props.onTrace({ ...trace, mode: option.value })}
          data-agent-control={`trace.${trace.id}.mode.${option.value}`}
        /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}
      </div>
      {trace.mode === 'average' && <div className="parameter-stack trace-behavior-detail">
        <EditableParameter label="Sweeps to average" value={trace.averageCount} displayValue={`${trace.averageCount} sweeps`} minimum={2} maximum={100} step={1} controlId={`trace.${trace.id}.average-count`} onCommit={(value) => props.onTrace({ ...trace, averageCount: Number(value) })}/>
      </div>}
    </section>
    <div className="panel-action"><button className="secondary full" onClick={() => props.onTraceReset(trace.id)} data-agent-control={`trace.${trace.id}.reset`}><RotateCcw size={14}/>Clear captured data</button></div>
    {firmwareOverlays.length > 0 && <details className="firmware-trace-bank">
      <summary><span>Instrument overlays</span><small>{visibleOverlayCount === 0 ? 'Hidden' : `${visibleOverlayCount} shown`}</small></summary>
      <div className="parameter-stack">{firmwareOverlays.map((item) => <ToggleParameter key={item.traceId} label={`D${item.traceId} · ${firmwareTraceRole(item)}`} value={props.visibleFirmwareTraceIds.includes(item.traceId)} controlId={`firmware-trace.${item.traceId}.visible`} onToggle={(visible) => props.onFirmwareTraceVisibility(item.traceId, visible)}/>)}</div>
    </details>}
  </div>;
}

const TRACE_BEHAVIOR_OPTIONS: readonly Readonly<{
  value: TraceConfiguration['mode'];
  label: string;
  description: string;
}>[] = [
  { value: 'clear-write', label: 'Live', description: 'Show the latest sweep' },
  { value: 'max-hold', label: 'Peak hold', description: 'Keep the highest values' },
  { value: 'average', label: 'Average', description: 'Smooth repeated sweeps' },
  { value: 'view', label: 'Freeze', description: 'Keep this trace unchanged' },
  { value: 'min-hold', label: 'Minimum hold', description: 'Keep the lowest values' },
  { value: 'blank', label: 'Off', description: 'Hide this trace' },
];

function formatMarkerReading(reading: MarkerReading | undefined): string {
  if (!reading) return '—';
  if (reading.mode === 'delta' && reading.deltaPowerDb !== undefined && reading.deltaFrequencyHz !== undefined) return `Δ ${reading.deltaPowerDb >= 0 ? '+' : ''}${reading.deltaPowerDb.toFixed(1)} dB · ${formatSignedFrequency(reading.deltaFrequencyHz)}`;
  if (reading.mode === 'noise-density' && reading.noiseDensityDbmHz !== undefined) return formatPowerDensity(reading.noiseDensityDbmHz, reading.powerReference);
  return formatPowerLevel(reading.powerDbm, reading.powerReference);
}

function MarkerCharacterizationCard({ reading }: { reading: MarkerReading }) {
  const characterization = reading.localCharacterization;
  const measurement = 'threeDecibelBandwidth' in characterization
    ? characterization.threeDecibelBandwidth
    : undefined;
  const measured = measurement?.status !== undefined && measurement.status !== 'unavailable'
    ? measurement
    : undefined;
  const componentOccupiedBandwidth = 'componentOccupiedBandwidth' in characterization
    ? characterization.componentOccupiedBandwidth
    : undefined;
  const widthLabel = characterization.widthClassification === 'resolution-limited-narrow'
    ? 'Narrow · resolution limited'
    : characterization.widthClassification === 'resolved-wideband'
      ? 'Resolved local response · >2 resolution elements'
      : '3 dB unavailable';
  const reason = characterization.widthClassification === 'unavailable'
    ? 'unavailableReason' in characterization
      ? characterizationUnavailableReason(characterization.unavailableReason)
      : measurement?.status === 'unavailable'
        ? crossingUnavailableReason(measurement.reason)
        : 'Half-power response unavailable'
    : undefined;
  const detection = characterization.physicalDetection;
  return <section className="marker-characterization-card" aria-label={`Marker M${reading.markerId} local characterization`}>
    <div className="marker-characterization-heading"><span>{widthLabel}</span><small>Observed local response · separate 3 dB / component OBW</small></div>
    <div className="marker-characterization-grid">
      <div><small>3 dB response width</small><strong>{measured ? formatFrequency(measured.bandwidthHz) : '—'}</strong><span>{measured ? `${formatFrequency(measured.startHz)} – ${formatFrequency(measured.stopHz)}` : reason}</span></div>
      <div><small>99% component occupied bandwidth</small><strong>{componentOccupiedBandwidth ? formatFrequency(componentOccupiedBandwidth.bandwidthHz) : '—'}</strong><span>{componentOccupiedBandwidth ? `${formatFrequency(componentOccupiedBandwidth.startHz)} – ${formatFrequency(componentOccupiedBandwidth.stopHz)} · robust-floor subtracted` : 'Requires a prominence-qualified threshold component'}</span></div>
      <div><small>Signal / noise context</small><strong>{characterization.peakToRobustFloorDb.toFixed(1)} dB peak-to-floor</strong><span>{characterization.prominenceDb.toFixed(1)} dB prominence · gate {characterization.requiredProminenceDb.toFixed(1)} dB</span></div>
      <div><small>Local evidence</small><strong>{detection ? `${detection.detectionState} ${detection.detectionId}` : 'Trace-only component'}</strong><span>{detection ? detection.relationship === 'contains-local-peak' ? 'Detection contains local peak' : `Nearest detection · ${formatFrequency(detection.distanceHz)} away` : characterization.componentRelationship === 'nearest-threshold-component' ? `Nearest component · ${formatFrequency(characterization.componentDistanceHz)} away` : 'No current candidate/active detector row'}</span></div>
    </div>
  </section>;
}

function characterizationUnavailableReason(reason: 'no-qualified-local-component' | 'insufficient-local-prominence'): string {
  return reason === 'no-qualified-local-component'
    ? 'No local component clears the robust-floor gate'
    : 'Local peak prominence does not clear the evidence gate';
}

function crossingUnavailableReason(reason: 'lower-crossing-not-observed' | 'upper-crossing-not-observed' | 'crossing-outside-window' | 'nonmonotone-half-power-response' | 'no-sampled-peak'): string {
  return ({
    'lower-crossing-not-observed': 'Lower half-power edge is truncated or buried',
    'upper-crossing-not-observed': 'Upper half-power edge is truncated or buried',
    'crossing-outside-window': 'Half-power response leaves the local component window',
    'nonmonotone-half-power-response': 'Resolved half-power islands do not identify one contiguous response',
    'no-sampled-peak': 'No sampled local peak is available',
  })[reason];
}

function formatSignedFrequency(value: number): string { return `${value >= 0 ? '+' : '−'}${formatFrequency(Math.abs(value))}`; }
function traceModeLabel(value: TraceConfiguration['mode']): string {
  if (value === 'blank') return 'Off';
  if (value === 'clear-write') return 'Live';
  if (value === 'max-hold') return 'Peak hold';
  if (value === 'min-hold') return 'Minimum hold';
  if (value === 'view') return 'Freeze';
  return formatLabel(value);
}
function firmwareTraceRole(frame: FirmwareTraceFrame): string {
  const role = frame.role === 'measured' ? 'Measured' : frame.role === 'raw' ? 'Raw' : 'Stored';
  return frame.frozen === true ? `${role} · frozen` : frame.frozen === false ? role : `${role} · freeze unknown`;
}
