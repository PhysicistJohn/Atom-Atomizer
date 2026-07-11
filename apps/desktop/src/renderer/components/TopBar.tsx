import { Cable, ChevronDown } from 'lucide-react';
import type { DeviceSnapshot, SynthesizedSignalProfile } from '@tinysa/contracts';
import { AtomicMark } from './AtomicMark.js';

export function TopBar({ snapshot, simulated, demoProfile, agentOpen, agentConfigured, onConnection, onAgent }: { snapshot: DeviceSnapshot; simulated: boolean; demoProfile?: SynthesizedSignalProfile; agentOpen:boolean;agentConfigured:boolean;onConnection(): void;onAgent():void }) {
  const ready = snapshot.connection === 'ready';
  return <header className="topbar">
    <div className="brand-lockup"><div className="brand-symbol"><AtomicMark size={27}/></div><div><small>tinySA</small><strong>Atomizer</strong></div><span className="version">407</span></div>
    <div className="topbar-actions">
      {simulated && <span className="environment-badge">{demoProfile ? `SIGNAL LAB · ${demoLabel(demoProfile)}` : 'SIMULATED DATA'}</span>}
      {snapshot.generatorOutput !== 'off' && <span className={`top-rf-state ${snapshot.generatorOutput}`}>RF {snapshot.generatorOutput.toUpperCase()}</span>}
      <button className={`connection-pill ${ready ? 'is-ready' : ''}`} onClick={onConnection} aria-haspopup="dialog">
        <span className="status-dot"/><Cable size={15}/><span><b>{ready ? snapshot.identity?.model ?? 'IDENTITY MISSING' : 'No instrument'}</b><small>{ready ? snapshot.identity?.firmwareVersion : 'Choose USB device'}</small></span><ChevronDown size={14}/>
      </button>
      <button className={`atom-launch ${agentOpen?'active':''}`} onClick={onAgent} aria-label="Open Atom AI copilot"><span className="atom-launch-orb"><AtomicMark size={23} active={agentOpen}/></span><span><b>Atom</b><small>{agentConfigured?'Listening when you are':'Setup required'}</small></span><em>⌘K</em></button>
    </div>
  </header>;
}

function demoLabel(profile: SynthesizedSignalProfile): string {
  if (profile === 'cw' || profile === 'am' || profile === 'fm') return profile.toUpperCase();
  if (profile.startsWith('gsm-')) return `GSM · ${profile.replace('gsm-', '').replace('-normal-burst', '').toUpperCase()}`;
  if (profile.startsWith('lte-')) return `LTE · ${profile.slice(4).toUpperCase()}`;
  if (profile.startsWith('nr-')) return `5G · ${profile.slice(3).toUpperCase()}`;
  if (profile.startsWith('wifi6-')) return `WI-FI 6 · ${profile.slice(6).toUpperCase()}`;
  throw new Error(`Signal Lab profile ${profile} has no top-bar label`);
}
