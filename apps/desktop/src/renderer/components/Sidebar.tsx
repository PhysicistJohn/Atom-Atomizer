import { Activity, BarChart3, Cpu, Layers3, LoaderCircle, Play, Radio, Repeat2, ScanSearch, StopCircle, Waves } from 'lucide-react';
import type { MeasurementViewId } from '@tinysa/contracts';
import { DEVELOPMENT_RENDERER } from '../development.js';
import type { AcquisitionState, WorkspaceId } from '../ui-contracts.js';

type VisibleMeasurementViewId = Exclude<MeasurementViewId, 'envelope-stft'>;

const measurementViews: readonly { id: VisibleMeasurementViewId; label: string; icon: typeof Activity }[] = [
  { id: 'spectrum', label: 'Spectrum', icon: Activity },
  { id: 'waterfall', label: 'Waterfall', icon: Layers3 },
  { id: 'channel', label: 'Channel', icon: BarChart3 },
];

const workspaces = [
  { id: 'iq' as const, label: 'I/Q', icon: Waves },
  { id: 'classification' as const, label: 'Detect', icon: ScanSearch },
  { id: 'generator' as const, label: 'Generate', icon: Radio },
  { id: 'device' as const, label: 'Device', icon: Cpu },
];

export function Sidebar({
  active,
  measurementView,
  output,
  generationAvailable,
  iqAvailable = false,
  spectrumAvailable = false,
  connected,
  acquisition,
  continuous,
  acquisitionMode,
  acquisitionBusy,
  acquisitionDisabled,
  acquisitionDisabledReason,
  latestSweep,
  onSelect,
  onMeasurementView,
  onRun,
  onSingle,
  onStop,
}: {
  active: WorkspaceId;
  measurementView: MeasurementViewId;
  output: 'off'|'on'|'unknown';
  generationAvailable: boolean;
  iqAvailable?: boolean;
  spectrumAvailable?: boolean;
  connected: boolean;
  acquisition: AcquisitionState;
  continuous: boolean;
  acquisitionMode?: 'spectrum' | 'complex-iq';
  acquisitionBusy: boolean;
  acquisitionDisabled: boolean;
  acquisitionDisabledReason?: string;
  latestSweep?: { readonly id: string; readonly sequence: number };
  onSelect(id: WorkspaceId): void;
  onMeasurementView(id: VisibleMeasurementViewId): void;
  onRun(): void;
  onSingle(): void;
  onStop(): void;
}) {
  const acquiringSingle = !continuous && acquisition === 'acquiring';
  const iqAcquisition = acquisitionMode === 'complex-iq';
  const globalAnalysisLabel = iqAcquisition
    ? spectrumAvailable ? 'Global · I/Q + spectrum' : 'Global · I/Q'
    : 'Global · spectrum';
  const globalRunTitle = iqAcquisition
    ? spectrumAvailable
      ? 'Start global I/Q classification and spectrum detection'
      : 'Start global I/Q classification'
    : 'Start global spectrum detection and classification';
  const globalSingleTitle = iqAcquisition
    ? spectrumAvailable
      ? 'Acquire one global I/Q and spectrum analysis frame'
      : 'Acquire one global I/Q analysis frame'
    : 'Acquire one global spectrum analysis frame';
  const acquisitionStatus = continuous
    ? acquisition === 'stopping' ? 'Stopping global analysis' : acquisition === 'retuning' ? 'Retuning global analysis' : globalAnalysisLabel
    : acquiringSingle ? 'Collecting' : acquisition === 'configuring' ? 'Configuring' : connected ? 'Ready' : 'Offline';
  return <aside className="sidebar">
    <nav aria-label="Primary navigation">
      {measurementViews.map((item) => {
        const Icon = item.icon;
        const activeItem = active === 'spectrum' && measurementView === item.id;
        return <button type="button" key={item.id} className={`nav-item ${activeItem ? 'active' : ''}`} onClick={() => onMeasurementView(item.id)} aria-current={activeItem ? 'page' : undefined} title={item.label} data-agent-control={`measurement.view.${item.id}`}><span className="nav-icon"><Icon size={19}/></span><span>{item.label}</span></button>;
      })}
      {workspaces.filter((item) => item.id !== 'iq' || iqAvailable).map((item) => {
        const Icon = item.icon;
        const disabled = item.id === 'generator' && !generationAvailable;
        const activeItem = item.id === 'classification'
          ? active === 'classification' || active === 'detection'
          : active === item.id;
        return <button type="button" key={item.id} className={`nav-item ${activeItem ? 'active' : ''}`} disabled={disabled} onClick={() => onSelect(item.id)} aria-current={activeItem ? 'page' : undefined} title={disabled ? 'Connected driver exposes no configurable signal source' : item.label} data-agent-control={`workspace.${item.id}`}><span className="nav-icon"><Icon size={19}/>{item.id === 'generator' && output !== 'off' && <i className={`rf-mini ${output}`}/>}</span><span>{item.label}</span></button>;
      })}
    </nav>
    <section
      className={`sidebar-acquisition ${continuous || acquiringSingle ? 'active' : ''}`}
      aria-label="Acquisition controls"
      aria-description={DEVELOPMENT_RENDERER
        ? `DEV ACQUISITION LANDMARK; controls=${continuous ? 'Stop' : 'Run,Single'}; sweepId=${latestSweep?.id ?? 'none'}; sequence=${latestSweep?.sequence ?? 'none'}`
        : undefined}
    >
      <div className="sidebar-acquisition-state" aria-live="polite"><i/><span>{acquisitionStatus}</span></div>
      {continuous
        ? <button type="button" data-agent-control="acquisition.continuous.stop" className="sidebar-acquisition-stop stop-acquisition" disabled={acquisition === 'stopping'} title={iqAcquisition ? 'Stop global analysis after the in-flight I/Q buffer' : 'Stop global spectrum analysis'} onClick={onStop}><StopCircle size={13}/><span>{acquisition === 'stopping' ? 'Stopping…' : 'Stop'}</span></button>
        : <div className="sidebar-acquisition-buttons">
          <button type="button" data-agent-control="acquisition.continuous.start" disabled={acquisitionDisabled} title={acquisitionDisabled ? acquisitionDisabledReason : globalRunTitle} onClick={onRun}><Repeat2 size={13}/><span>Run</span></button>
          <button type="button" data-agent-control="acquisition.single" disabled={acquisitionDisabled} title={acquisitionDisabled ? acquisitionDisabledReason : globalSingleTitle} onClick={onSingle}>{acquisitionBusy ? <LoaderCircle className="spin" size={13}/> : <Play size={13} fill="currentColor"/>}<span>{acquiringSingle ? 'Acquiring…' : 'Single'}</span></button>
        </div>}
    </section>
  </aside>;
}
