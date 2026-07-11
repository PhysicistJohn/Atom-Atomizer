import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, AudioWaveform, BarChart3, Clock3, Crosshair, Layers3, RadioTower, Repeat2, SlidersHorizontal, Square, Zap } from 'lucide-react';
import type {
  AnalyzerConfig,
  ChannelMeasurementConfiguration,
  DetectedSignal,
  EnvelopeStftConfiguration,
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
  ZeroSpanCapture,
  ZeroSpanConfig,
} from '@tinysa/contracts';
import { calculateSweepMetrics } from '@tinysa/analysis';
import type { AcquisitionState } from '../ui-contracts.js';
import { formatFrequency, formatLevel } from '../format.js';
import { AnalyzerInspector } from './AnalyzerInspector.js';
import { ChannelAnalysisView } from './ChannelAnalysisView.js';
import { EnvelopeStftView } from './EnvelopeStftView.js';
import { MeasurementDock } from './MeasurementDock.js';
import { SpectrumPlot } from './SpectrumPlot.js';
import { WaterfallView } from './WaterfallView.js';

type Overlay = 'setup' | 'controls';

export interface MeasurementWorkspaceProps {
  acquisitionActions: ReactNode;
  view: MeasurementViewId;
  onView(view: MeasurementViewId): void;
  analyzer: AnalyzerConfig;
  busy: boolean;
  connected: boolean;
  streaming: boolean;
  onAnalyzer(configuration: AnalyzerConfig): void;
  sweep?: Sweep;
  history: readonly Sweep[];
  detections: readonly DetectedSignal[];
  acquisition: AcquisitionState;
  traces: TraceBankConfiguration;
  frames: readonly TraceFrame[];
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
  onMarkerPlace(frequencyHz: number): void;
  waterfall: WaterfallConfiguration;
  onWaterfall(configuration: WaterfallConfiguration): void;
  channel: ChannelMeasurementConfiguration;
  onChannel(configuration: ChannelMeasurementConfiguration): void;
  zeroConfig: ZeroSpanConfig;
  zeroCapture?: ZeroSpanCapture;
  stft: EnvelopeStftConfiguration;
  onZeroConfig(configuration: ZeroSpanConfig): void;
  onStft(configuration: EnvelopeStftConfiguration): void;
  onAcquireZero(): void;
}

export function MeasurementWorkspace(props: MeasurementWorkspaceProps) {
  const [overlay, setOverlay] = useState<Overlay>();
  const activeDetections = props.detections.filter((item) => item.state !== 'released');
  const toggleOverlay = (next: Overlay) => setOverlay((current) => current === next ? undefined : next);
  const selectView = (view: MeasurementViewId) => { setOverlay(undefined); props.onView(view); };
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOverlay(undefined); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);
  return <section className="measurement-workspace">
    <header className="measurement-viewbar">
      <div className="measurement-view-tabs" role="tablist" aria-label="Spectrum analysis views">
        <ViewTab id="spectrum" label="Spectrum" icon={<Activity size={14}/>} active={props.view} onView={selectView}/>
        <ViewTab id="waterfall" label="Waterfall" icon={<Layers3 size={14}/>} active={props.view} onView={selectView}/>
        <ViewTab id="channel" label="Channel" icon={<BarChart3 size={14}/>} active={props.view} onView={selectView}/>
        <ViewTab id="envelope-stft" label="Time / STFT" icon={<AudioWaveform size={14}/>} active={props.view} onView={selectView}/>
      </div>
      <div className="measurement-view-utilities">
        <div className="stage-acquisition-actions">{props.acquisitionActions}</div>
        <div className="measurement-view-actions">
          <button className={overlay === 'setup' ? 'active' : ''} onClick={() => toggleOverlay('setup')} data-agent-control="measurement.setup"><SlidersHorizontal size={14}/><span>Sweep setup</span></button>
          <button className={overlay === 'controls' ? 'active' : ''} onClick={() => toggleOverlay('controls')} data-agent-control="measurement.controls"><Crosshair size={14}/><span>Traces & markers</span></button>
        </div>
      </div>
    </header>
    <div className="measurement-stage">
      {overlay && <div className={`measurement-overlay ${overlay}`} role="region" aria-label={overlay === 'setup' ? 'Sweep setup overlay' : 'Trace and marker overlay'}>
        {overlay === 'setup' ? <AnalyzerInspector config={props.analyzer} disabled={props.busy} onChange={props.onAnalyzer}/> : <MeasurementDock traces={props.traces} frames={props.frames} activeTraceId={props.activeTraceId} onActiveTrace={props.onActiveTrace} markers={props.markers} readings={props.readings} activeMarkerId={props.activeMarkerId} search={props.markerSearch} display={props.display} onTrace={props.onTrace} onTraceReset={props.onTraceReset} onMarker={props.onMarker} onActiveMarker={props.onActiveMarker} onSearch={props.onSearch} onSearchConfiguration={props.onSearchConfiguration} onDisplay={props.onDisplay} onAutoScale={props.onAutoScale}/>}
      </div>}
      <div className="measurement-stage-content" role="tabpanel">
        {props.view === 'spectrum' && <div className="spectrum-stage"><SpectrumPlot sweep={props.sweep} traces={props.frames} markers={props.readings} activeMarkerId={props.activeMarkerId} display={props.display} onMarkerPlace={props.onMarkerPlace} detections={activeDetections} busy={props.busy}/><MetricStrip sweep={props.sweep} detections={activeDetections.length} acquisition={props.acquisition} historyCount={props.history.length}/></div>}
        {props.view === 'waterfall' && <WaterfallView history={props.history} configuration={props.waterfall} onConfiguration={props.onWaterfall}/>} 
        {props.view === 'channel' && <ChannelAnalysisView sweep={props.sweep} configuration={props.channel} display={props.display} onConfiguration={props.onChannel}/>} 
        {props.view === 'envelope-stft' && <EnvelopeStftView zeroConfig={props.zeroConfig} capture={props.zeroCapture} configuration={props.stft} connected={props.connected} streaming={props.streaming} busy={props.busy} onZeroConfig={props.onZeroConfig} onConfiguration={props.onStft} onAcquire={props.onAcquireZero}/>} 
      </div>
    </div>
  </section>;
}

function ViewTab({ id, label, icon, active, onView }: { id: MeasurementViewId; label: string; icon: ReactNode; active: MeasurementViewId; onView(view: MeasurementViewId): void }) {
  return <button role="tab" aria-selected={active === id} className={active === id ? 'active' : ''} onClick={() => onView(id)} data-agent-control={`measurement.view.${id}`}>{icon}<strong>{label}</strong></button>;
}

function MetricStrip({ sweep, detections, acquisition, historyCount }: { sweep?: Sweep; detections: number; acquisition: AcquisitionState; historyCount: number }) {
  const metrics = sweep ? calculateSweepMetrics(sweep) : undefined;
  return <section className="metric-strip compact-metrics">
    <Metric icon={<Zap size={13}/>} accent="mint" label="Peak" value={metrics ? formatLevel(metrics.peakDbm) : '—'} detail={metrics ? formatFrequency(metrics.peakHz) : undefined}/>
    <Metric icon={<Square size={12}/>} label="Robust floor" value={metrics ? formatLevel(metrics.noiseFloorDbm) : '—'}/>
    <Metric icon={<RadioTower size={13}/>} accent="amber" label="Tracked" value={String(detections).padStart(2, '0')}/>
    <Metric icon={<BarChart3 size={13}/>} label="OBW · 99%" value={metrics ? formatFrequency(metrics.occupiedBandwidth99Hz) : '—'}/>
    <Metric icon={<Clock3 size={13}/>} label="Sweep" value={sweep ? `${sweep.elapsedMilliseconds.toFixed(0)} ms` : acquisition.toUpperCase()} detail={sweep ? `${sweep.frequencyHz.length} points` : undefined}/>
    <Metric icon={<Repeat2 size={13}/>} label="History" value={`${historyCount} / 50`}/>
  </section>;
}

function Metric({ icon, accent = '', label, value, detail }: { icon: ReactNode; accent?: string; label: string; value: string; detail?: string }) {
  return <div><span className={`metric-icon ${accent}`}>{icon}</span><span><small>{label}</small><strong>{value}</strong>{detail && <em>{detail}</em>}</span></div>;
}
