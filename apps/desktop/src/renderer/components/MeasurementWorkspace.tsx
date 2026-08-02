import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { BarChart3, Clock3, Crosshair, Gauge, RadioTower, Repeat2, SlidersHorizontal, Square, X, Zap } from 'lucide-react';
import type {
  CanonicalInstrumentSurface,
  CanonicalOperationParameterIntent,
  ChannelMeasurementConfiguration,
  DetectedSignal,
  FirmwareTraceFrame,
  FirmwareTraceId,
  FirmwareTraceVisibility,
  MarkerConfiguration,
  MarkerId,
  MarkerReading,
  MarkerSearchAction,
  MarkerSearchConfiguration,
  MeasurementViewId,
  SpectrumDisplayConfiguration,
  Sweep,
  TraceBankConfiguration,
  TraceConfiguration,
  TraceFrame,
  TraceId,
  WaterfallConfiguration,
} from '@tinysa/contracts';
import { calculateSweepMetrics } from '@tinysa/analysis';
import type { AcquisitionState } from '../ui-contracts.js';
import { formatFrequency, formatPowerLevel } from '../format.js';
import { CanonicalOperationPanel, CanonicalOperationRequired } from './CanonicalOperationPanel.js';
import { ChannelAnalysisView } from './ChannelAnalysisView.js';
import { MeasurementDock, type MeasurementDockPanel } from './MeasurementDock.js';
import { SpectrumPlot } from './SpectrumPlot.js';
import { WaterfallView } from './WaterfallView.js';

type Drawer = 'setup' | MeasurementDockPanel;

export interface MeasurementWorkspaceProps {
  measurementActions?: ReactNode;
  /** Controlled by the shared top-level secondary-surface selection when mounted by Atomizer. */
  secondaryPanelActive?: boolean;
  onSecondaryPanelActiveChange?(active: boolean): void;
  view: MeasurementViewId;
  /** The sole driver-owned, device-neutral mutable-control surface. */
  canonicalSurface?: CanonicalInstrumentSurface;
  onCanonicalOperation?(operationId: string, parameters: readonly CanonicalOperationParameterIntent[]): void | Promise<unknown>;
  /** Whether Spectrum/Waterfall/Channel can ever populate for this session:
   * natively (spectrumCapability) or via a host-derived-from-complex-I/Q
   * projection. See SpectrumPlotProps.spectrumCapabilityAvailable's doc comment. */
  spectrumCapabilityAvailable: boolean;
  busy: boolean;
  streaming: boolean;
  /** The generic global single-frame acquisition action, when currently available. */
  onCapture?(): void;
  sweep?: Sweep;
  history: readonly Sweep[];
  detections: readonly DetectedSignal[];
  acquisition: AcquisitionState;
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
  markerSearch: MarkerSearchConfiguration;
  display: SpectrumDisplayConfiguration;
  onTrace(configuration: TraceConfiguration): void;
  onTraceReset(traceId: TraceId): void;
  onMarker(configuration: MarkerConfiguration): void;
  onActiveMarker(markerId: MarkerId): void;
  onSearch(action: MarkerSearchAction): void;
  onSearchConfiguration(configuration: MarkerSearchConfiguration): void;
  onDisplay(configuration: SpectrumDisplayConfiguration): void;
  onAutoScale(): void;
  onMarkerPlace(frequencyHz: number): boolean;
  waterfall: WaterfallConfiguration;
  onWaterfall(configuration: WaterfallConfiguration): void;
  channel: ChannelMeasurementConfiguration;
  onChannel(configuration: ChannelMeasurementConfiguration): void;
}

export function MeasurementWorkspace(props: MeasurementWorkspaceProps) {
  const [drawer, setDrawer] = useState<Drawer>();
  const drawerRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const focusDrawerRef = useRef(false);
  const previousViewRef = useRef(props.view);
  const activeDetections = props.detections.filter((item) =>
    typeof item === 'object' && item !== null && item.state === 'active');
  const view = props.view === 'envelope-stft' ? 'spectrum' : props.view;
  const hasCanonicalOperation = props.canonicalSurface !== undefined && props.onCanonicalOperation !== undefined;
  const setupLabel = 'Instrument setup';
  const traceToolsAvailable = view === 'spectrum';
  // Rendering is gated by the shared owner as well as the local subpanel.
  // This prevents even a transient overlap while React tears down a drawer
  // after Atom or the connection sheet takes the secondary surface.
  const visibleDrawer = props.secondaryPanelActive === false ? undefined : drawer;
  const closeDrawer = useCallback((restoreFocus = true, releaseSurface = true) => {
    const focusTarget = returnFocusRef.current;
    focusDrawerRef.current = false;
    setDrawer(undefined);
    if (releaseSurface && drawer !== undefined) props.onSecondaryPanelActiveChange?.(false);
    if (restoreFocus && focusTarget) window.requestAnimationFrame(() => focusTarget.focus());
  }, [drawer, props.onSecondaryPanelActiveChange]);
  const toggleDrawer = (next: Drawer, trigger: HTMLButtonElement) => {
    if (visibleDrawer === next) {
      closeDrawer();
      return;
    }
    returnFocusRef.current = trigger;
    focusDrawerRef.current = true;
    setDrawer(next);
    props.onSecondaryPanelActiveChange?.(true);
  };
  useEffect(() => {
    if (!visibleDrawer) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      closeDrawer();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [visibleDrawer, closeDrawer]);
  useEffect(() => {
    if (!visibleDrawer || !focusDrawerRef.current) return;
    focusDrawerRef.current = false;
    window.requestAnimationFrame(() => drawerRef.current?.focus());
  }, [visibleDrawer]);
  useEffect(() => {
    if (props.secondaryPanelActive !== false || drawer === undefined) return;
    // Another peer surface owns the slot. Clear only our local subpanel; the
    // owner has already changed, so do not release its shared selection.
    focusDrawerRef.current = false;
    returnFocusRef.current = null;
    setDrawer(undefined);
  }, [drawer, props.secondaryPanelActive]);
  useEffect(() => {
    if (previousViewRef.current === props.view) return;
    previousViewRef.current = props.view;
    focusDrawerRef.current = false;
    closeDrawer(false);
  }, [closeDrawer, props.view]);
  const drawerTitle = visibleDrawer === 'setup'
    ? setupLabel
    : visibleDrawer === 'traces'
      ? 'Trace controls'
      : visibleDrawer === 'markers'
        ? 'Marker controls'
        : 'Display controls';
  return <section className="measurement-workspace">
    <header className="measurement-viewbar">
      <div className="measurement-view-utilities" role="toolbar" aria-label="Measurement utilities">
        {props.measurementActions && <div className="stage-measurement-actions">{props.measurementActions}</div>}
        <div className="measurement-view-actions">
          <button type="button" className={visibleDrawer === 'setup' ? 'active' : ''} aria-label={setupLabel} aria-expanded={visibleDrawer === 'setup'} aria-controls="measurement-control-drawer" onClick={(event) => toggleDrawer('setup', event.currentTarget)} data-agent-control="measurement.setup"><SlidersHorizontal size={14}/><span>{setupLabel}</span></button>
          {traceToolsAvailable && <>
            <button type="button" className={visibleDrawer === 'traces' ? 'active' : ''} aria-label="Traces" aria-expanded={visibleDrawer === 'traces'} aria-controls="measurement-control-drawer" onClick={(event) => toggleDrawer('traces', event.currentTarget)} data-agent-control="measurement.controls"><BarChart3 size={14}/><span>Traces</span></button>
            <button type="button" className={visibleDrawer === 'markers' ? 'active' : ''} aria-label="Markers" aria-expanded={visibleDrawer === 'markers'} aria-controls="measurement-control-drawer" onClick={(event) => toggleDrawer('markers', event.currentTarget)} data-agent-exclusion="human-disclosure"><Crosshair size={14}/><span>Markers</span></button>
            <button type="button" className={visibleDrawer === 'display' ? 'active' : ''} aria-label="Display" aria-expanded={visibleDrawer === 'display'} aria-controls="measurement-control-drawer" onClick={(event) => toggleDrawer('display', event.currentTarget)} data-agent-exclusion="human-disclosure"><Gauge size={14}/><span>Display</span></button>
          </>}
        </div>
      </div>
    </header>
    <div className={`measurement-stage${visibleDrawer ? ' drawer-open' : ''}${visibleDrawer && visibleDrawer !== 'setup' ? ' controls-open' : ''}`}>
      {visibleDrawer && <button type="button" className="measurement-overlay-scrim" aria-label="Close panel" data-agent-exclusion="human-overlay-dismiss" onClick={() => closeDrawer()}/>}
      {visibleDrawer && <div id="measurement-control-drawer" ref={drawerRef} tabIndex={-1} className={`measurement-overlay ${visibleDrawer === 'setup' ? 'setup' : 'controls'}`} role="region" aria-label={`${drawerTitle} panel`}>
        <header className="measurement-drawer-header"><span>{visibleDrawer === 'setup' ? <SlidersHorizontal size={15}/> : visibleDrawer === 'markers' ? <Crosshair size={15}/> : visibleDrawer === 'display' ? <Gauge size={15}/> : <BarChart3 size={15}/>}<strong>{drawerTitle}</strong></span><button type="button" className="measurement-overlay-close" aria-label={`Close ${drawerTitle}`} data-agent-exclusion="human-overlay-dismiss" onClick={() => closeDrawer()}><X size={16}/></button></header>
        <div className="measurement-drawer-body">{visibleDrawer === 'setup'
          ? hasCanonicalOperation
            ? <CanonicalOperationPanel surface={props.canonicalSurface!} placement="acquisition" busy={props.busy && !props.streaming} onExecute={props.onCanonicalOperation!}/>
            : <CanonicalOperationRequired title="Instrument controls"/>
          : <MeasurementDock panel={visibleDrawer} showTabs={false} traces={props.traces} frames={props.frames} firmwareFrames={props.firmwareFrames} visibleFirmwareTraceIds={props.visibleFirmwareTraceIds} onFirmwareTraceVisibility={props.onFirmwareTraceVisibility} activeTraceId={props.activeTraceId} onActiveTrace={props.onActiveTrace} markers={props.markers} readings={props.readings} activeMarkerId={props.activeMarkerId} search={props.markerSearch} display={props.display} onTrace={props.onTrace} onTraceReset={props.onTraceReset} onMarker={props.onMarker} onActiveMarker={props.onActiveMarker} onSearch={props.onSearch} onSearchConfiguration={props.onSearchConfiguration} onDisplay={props.onDisplay} onAutoScale={props.onAutoScale}/>
        }</div>
      </div>}
      <div className="measurement-stage-content" aria-label="Measurement view">
        {view === 'spectrum' && <div className="spectrum-stage"><SpectrumPlot sweep={props.sweep} traces={props.frames} firmwareTraces={props.firmwareFrames} visibleFirmwareTraceIds={props.visibleFirmwareTraceIds} activeTraceId={props.activeTraceId} markers={props.readings} activeMarkerId={props.activeMarkerId} display={props.display} onMarkerPlace={props.onMarkerPlace} detections={activeDetections} busy={props.busy} spectrumCapabilityAvailable={props.spectrumCapabilityAvailable}/><MetricStrip sweep={props.sweep} detections={activeDetections.length} acquisition={props.acquisition} historyCount={props.history.length}/></div>}
        {view === 'waterfall' && <WaterfallView history={props.history} configuration={props.waterfall} spectrumCapabilityAvailable={props.spectrumCapabilityAvailable} onConfiguration={props.onWaterfall}/>}
        {view === 'channel' && <ChannelAnalysisView sweep={props.sweep} configuration={props.channel} display={props.display} spectrumCapabilityAvailable={props.spectrumCapabilityAvailable} onCapture={props.onCapture} onConfiguration={props.onChannel}/>}
      </div>
    </div>
  </section>;
}

export function MetricStrip({ sweep, detections, acquisition, historyCount }: { sweep?: Sweep; detections: number; acquisition: AcquisitionState; historyCount: number }) {
  const metrics = useMemo(() => safeSweepMetrics(sweep), [sweep]);
  const elapsedMilliseconds = sweep && Number.isFinite(sweep.elapsedMilliseconds)
    ? sweep.elapsedMilliseconds
    : undefined;
  const pointCount = sweep && Array.isArray(sweep.frequencyHz)
    ? sweep.frequencyHz.length
    : undefined;
  return <section className="metric-strip compact-metrics">
    <Metric icon={<Zap size={13}/>} accent="mint" label="Peak" value={metrics ? formatPowerLevel(metrics.peakDbm, sweep?.powerReference) : '—'} detail={metrics ? formatFrequency(metrics.peakHz) : undefined}/>
    <Metric icon={<Square size={12}/>} label="Robust floor" value={metrics ? formatPowerLevel(metrics.noiseFloorDbm, sweep?.powerReference) : '—'}/>
    <Metric icon={<RadioTower size={13}/>} accent="amber" label="Tracked" value={String(detections).padStart(2, '0')}/>
    <Metric icon={<BarChart3 size={13}/>} label="OBW · 99%" value={metrics ? formatFrequency(metrics.occupiedBandwidth99Hz) : '—'}/>
    <Metric icon={<Clock3 size={13}/>} label="Sweep" value={acquisition === 'retuning' ? 'RETUNING' : elapsedMilliseconds === undefined ? acquisition.toUpperCase() : `${elapsedMilliseconds.toFixed(0)} ms`} detail={pointCount === undefined ? undefined : `${pointCount} points · ${acquisition.toUpperCase()}`}/>
    <Metric icon={<Repeat2 size={13}/>} label="History" value={`${historyCount} / 50`}/>
  </section>;
}

function safeSweepMetrics(sweep: Sweep | undefined): ReturnType<typeof calculateSweepMetrics> | undefined {
  if (!sweep || !Array.isArray(sweep.frequencyHz) || !Array.isArray(sweep.powerDbm)) return undefined;
  try {
    return calculateSweepMetrics(sweep);
  } catch {
    return undefined;
  }
}

function Metric({ icon, accent = '', label, value, detail }: { icon: ReactNode; accent?: string; label: string; value: string; detail?: string }) {
  return <div><span className={`metric-icon ${accent}`}>{icon}</span><span><small>{label}</small><strong>{value}</strong>{detail && <em>{detail}</em>}</span></div>;
}
