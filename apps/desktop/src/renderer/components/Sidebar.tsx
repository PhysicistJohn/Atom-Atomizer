import { Activity, Cpu, Radio, ScanSearch, Sparkles } from 'lucide-react';
import type { WorkspaceId } from '../ui-contracts.js';

const primary = [
  { id: 'spectrum' as const, label: 'Spectrum', icon: Activity },
  { id: 'detection' as const, label: 'Detect', icon: ScanSearch },
  { id: 'classification' as const, label: 'Classify', icon: Sparkles },
  { id: 'generator' as const, label: 'Generate', icon: Radio },
  { id: 'device' as const, label: 'Device', icon: Cpu },
];

export function Sidebar({ active, output, generatorAvailable, onSelect }: { active: WorkspaceId; output: 'off'|'on'|'unknown'; generatorAvailable: boolean; onSelect(id: WorkspaceId): void }) {
  return <aside className="sidebar"><nav aria-label="Primary navigation">{primary.map((item) => {
    const Icon = item.icon;
    const disabled = item.id === 'generator' && !generatorAvailable;
    return <button key={item.id} className={`nav-item ${active === item.id ? 'active' : ''}`} disabled={disabled} onClick={() => onSelect(item.id)} aria-current={active === item.id ? 'page' : undefined} title={disabled ? 'Connected driver exposes no RF generator' : item.label} data-agent-control={`workspace.${item.id}`}><span className="nav-icon"><Icon size={19}/>{item.id === 'generator' && output !== 'off' && <i className={`rf-mini ${output}`}/>}</span><span>{item.label}</span></button>;
  })}</nav></aside>;
}
