import { Activity, BarChart3, Cpu, Layers3, Radio, ScanSearch } from 'lucide-react';
import type { MeasurementViewId } from '@tinysa/contracts';
import type { WorkspaceId } from '../ui-contracts.js';

type VisibleMeasurementViewId = Exclude<MeasurementViewId, 'envelope-stft'>;

const measurementViews: readonly { id: VisibleMeasurementViewId; label: string; icon: typeof Activity }[] = [
  { id: 'spectrum', label: 'Spectrum', icon: Activity },
  { id: 'waterfall', label: 'Waterfall', icon: Layers3 },
  { id: 'channel', label: 'Channel', icon: BarChart3 },
];

const workspaces = [
  { id: 'classification' as const, label: 'Detect', icon: ScanSearch },
  { id: 'generator' as const, label: 'Generate', icon: Radio },
  { id: 'device' as const, label: 'Device', icon: Cpu },
];

export function Sidebar({ active, measurementView, output, generationAvailable, onSelect, onMeasurementView }: {
  active: WorkspaceId;
  measurementView: MeasurementViewId;
  output: 'off'|'on'|'unknown';
  generationAvailable: boolean;
  onSelect(id: WorkspaceId): void;
  onMeasurementView(id: VisibleMeasurementViewId): void;
}) {
  return <aside className="sidebar"><nav aria-label="Primary navigation">
    {measurementViews.map((item) => {
      const Icon = item.icon;
      const activeItem = active === 'spectrum' && measurementView === item.id;
      return <button key={item.id} className={`nav-item ${activeItem ? 'active' : ''}`} onClick={() => onMeasurementView(item.id)} aria-current={activeItem ? 'page' : undefined} title={item.label} data-agent-control={`measurement.view.${item.id}`}><span className="nav-icon"><Icon size={19}/></span><span>{item.label}</span></button>;
    })}
    {workspaces.map((item) => {
    const Icon = item.icon;
    const disabled = item.id === 'generator' && !generationAvailable;
    const activeItem = item.id === 'classification'
      ? active === 'classification' || active === 'detection'
      : active === item.id;
    return <button key={item.id} className={`nav-item ${activeItem ? 'active' : ''}`} disabled={disabled} onClick={() => onSelect(item.id)} aria-current={activeItem ? 'page' : undefined} title={disabled ? 'Connected driver exposes no configurable signal source' : item.label} data-agent-control={`workspace.${item.id}`}><span className="nav-icon"><Icon size={19}/>{item.id === 'generator' && output !== 'off' && <i className={`rf-mini ${output}`}/>}</span><span>{item.label}</span></button>;
    })}
  </nav></aside>;
}
