import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { BarChart3, Clock3, Crosshair, RadioTower, Repeat2, SlidersHorizontal, Square, Zap } from 'lucide-react';
import type {
  AnalyzerConfig,
  AnalyzerConfigPatch,
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
  InstrumentAcquisitionCapability,
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
import { formatFrequency, formatLevel } from '../format.js';
import { AnalyzerInspector } from './AnalyzerInspector.js';
import { ChannelAnalysisView } from './ChannelAnalysisView.js';
import { MeasurementDock } from './MeasurementDock.js';
import { SpectrumPlot } from './SpectrumPlot.js';
import { WaterfallView } from './WaterfallView.js';

type Overlay = 'setup' | 'controls';

export interface MeasurementWorkspaceProps {
  acquisitionActions: ReactNode;
  view: MeasurementViewId;
  analyzer: AnalyzerConfig;
  spectrumCapability?: Extract<InstrumentAcquisitionCapability, { kind: 'swept-spectrum' }>;
  busy: boolean;
  streaming: boolean;
  onAnalyzer(patch: AnalyzerConfigPatch): void;
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
  const [overlay, setOverlay] = useState<Overlay>();
  const activeDetections = props.detections.filter((item) =>
    typeof item === 'object' && item !== null && item.state === 'active');
  const view = props.view === 'envelope-stft' ? 'spectrum' : props.view;
  const toggleOverlay = (next: Overlay) => setOverlay((current) => current === next ? undefined : next);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOverlay(undefined); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);
  return <section className="measurement-workspace">
    <header className="measurement-viewbar">
      <div className="measurement-view-utilities" role="toolbar" aria-label="Measurement utilities">
        <div className="stage-acquisition-actions">{props.acquisitionActions}</div>
        <div className="measurement-view-actions">
          <button className={overlay === 'setup' ? 'active' : ''} onClick={() => toggleOverlay('setup')} data-agent-control="measurement.setup"><SlidersHorizontal size={14}/><span>Sweep setup</span></button>
          <button className={overlay === 'controls' ? 'active' : ''} onClick={() => toggleOverlay('controls')} data-agent-control="measurement.controls"><Crosshair size={14}/><span>Traces & markers</span></button>
        </div>
      </div>
    </header>
    <div className="measurement-stage">
      {overlay && <div className={`measurement-overlay ${overlay}`} role="region" aria-label={overlay === 'setup' ? 'Sweep setup overlay' : 'Trace and marker overlay'}>
        {overlay === 'setup'
          ? <AnalyzerInspector config={props.analyzer} capability={props.spectrumCapability} disabled={props.busy && !props.streaming} onChange={props.onAnalyzer}/>
          : <MeasurementDock traces={props.traces} frames={props.frames} firmwareFrames={props.firmwareFrames} visibleFirmwareTraceIds={props.visibleFirmwareTraceIds} onFirmwareTraceVisibility={props.onFirmwareTraceVisibility} activeTraceId={props.activeTraceId} onActiveTrace={props.onActiveTrace} markers={props.markers} readings={props.readings} activeMarkerId={props.activeMarkerId} search={props.markerSearch} display={props.display} onTrace={props.onTrace} onTraceReset={props.onTraceReset} onMarker={props.onMarker} onActiveMarker={props.onActiveMarker} onSearch={props.onSearch} onSearchConfiguration={props.onSearchConfiguration} onDisplay={props.onDisplay} onAutoScale={props.onAutoScale}/>
        }
      </div>}
      <div className="measurement-stage-content" aria-label="Measurement view">
        {view === 'spectrum' && <div className="spectrum-stage"><SpectrumPlot sweep={props.sweep} traces={props.frames} firmwareTraces={props.firmwareFrames} visibleFirmwareTraceIds={props.visibleFirmwareTraceIds} activeTraceId={props.activeTraceId} markers={props.readings} activeMarkerId={props.activeMarkerId} display={props.display} onMarkerPlace={props.onMarkerPlace} detections={activeDetections} busy={props.busy}/><MetricStrip sweep={props.sweep} detections={activeDetections.length} acquisition={props.acquisition} historyCount={props.history.length}/></div>}
        {view === 'waterfall' && <WaterfallView history={props.history} configuration={props.waterfall} onConfiguration={props.onWaterfall}/>}
        {view === 'channel' && <ChannelAnalysisView sweep={props.sweep} configuration={props.channel} display={props.display} onConfiguration={props.onChannel}/>}
      </div>
    </div>
  </section>;
}

function MetricStrip({ sweep, detections, acquisition, historyCount }: { sweep?: Sweep; detections: number; acquisition: AcquisitionState; historyCount: number }) {
  const metrics = safeSweepMetrics(sweep);
  const elapsedMilliseconds = sweep && Number.isFinite(sweep.elapsedMilliseconds)
    ? sweep.elapsedMilliseconds
    : undefined;
  const pointCount = sweep && Array.isArray(sweep.frequencyHz)
    ? sweep.frequencyHz.length
    : undefined;
  return <section className="metric-strip compact-metrics">
    <Metric icon={<Zap size={13}/>} accent="mint" label="Peak" value={metrics ? formatLevel(metrics.peakDbm) : '—'} detail={metrics ? formatFrequency(metrics.peakHz) : undefined}/>
    <Metric icon={<Square size={12}/>} label="Robust floor" value={metrics ? formatLevel(metrics.noiseFloorDbm) : '—'}/>
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
