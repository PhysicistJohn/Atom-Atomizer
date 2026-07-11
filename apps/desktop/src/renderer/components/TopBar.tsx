import { Cable, ChevronDown } from 'lucide-react';
import type { DeviceSnapshot } from '@tinysa/contracts';
import { AtomicMark } from './AtomicMark.js';

export function TopBar({ snapshot, simulated, agentOpen, agentConfigured, onConnection, onAgent }: { snapshot: DeviceSnapshot; simulated: boolean; agentOpen:boolean;agentConfigured:boolean;onConnection(): void;onAgent():void }) {
  const ready = snapshot.connection === 'ready';
  return <header className="topbar">
    <div className="brand-lockup"><div className="brand-symbol"><AtomicMark size={27}/></div><div><small>tinySA</small><strong>Atomizer</strong></div></div>
    <div className="topbar-actions">
      {simulated && <span className="environment-badge">DIGITAL TWIN</span>}
      {snapshot.generatorOutput !== 'off' && <span className={`top-rf-state ${snapshot.generatorOutput}`}>RF {snapshot.generatorOutput.toUpperCase()}</span>}
      <button className={`connection-pill ${ready ? 'is-ready' : ''}`} onClick={onConnection} aria-haspopup="dialog">
        <span className="status-dot"/><Cable size={15}/><span><b>{ready ? snapshot.identity?.model ?? 'IDENTITY MISSING' : 'No instrument'}</b><small>{ready ? snapshot.identity?.firmwareVersion : 'Choose USB device'}</small></span><ChevronDown size={14}/>
      </button>
      <button className={`atom-launch ${agentOpen?'active':''}`} onClick={onAgent} aria-label="Open Atom AI copilot"><span className="atom-launch-orb"><AtomicMark size={23} active={agentOpen}/></span><span><b>Atom</b><small>{agentConfigured ? 'Ready' : 'Needs key'}</small></span></button>
    </div>
  </header>;
}
