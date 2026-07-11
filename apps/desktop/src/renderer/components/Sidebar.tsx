import { Activity, Binary, Radio, ScanSearch, Sparkles } from 'lucide-react';
import type { WorkspaceId } from '../ui-contracts.js';

const primary = [
  { id: 'spectrum' as const, label: 'Spectrum', icon: Activity },
  { id: 'detection' as const, label: 'Detect', icon: ScanSearch },
  { id: 'classification' as const, label: 'Classify', icon: Sparkles, badge: 'LAB' },
  { id: 'generator' as const, label: 'Generate', icon: Radio }
];

export function Sidebar({ active, output, onSelect }: { active: WorkspaceId; output: 'off'|'on'|'unknown'; onSelect(id: WorkspaceId): void }) {
  return <aside className="sidebar"><nav aria-label="Primary navigation">{primary.map((item) => {
    const Icon = item.icon;
    return <button key={item.id} className={`nav-item ${active === item.id ? 'active' : ''}`} onClick={() => onSelect(item.id)} aria-current={active === item.id ? 'page' : undefined} title={item.label}><span className="nav-icon"><Icon size={19}/>{item.id === 'generator' && output !== 'off' && <i className={`rf-mini ${output}`}/>}</span><span>{item.label}</span>{item.badge && <em>{item.badge}</em>}</button>;
  })}</nav><div className="sidebar-bottom"><div className="protocol-tag"><Binary size={14}/><span>USB<br/>115200</span></div></div></aside>;
}
