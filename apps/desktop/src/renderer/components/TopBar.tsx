import { Cable, ChevronDown, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { DeviceSnapshot } from '@tinysa/contracts';
import { AtomicMark } from './AtomicMark.js';

export function TopBar({ snapshot, simulated, agentOpen, agentConfigured, firmwareUpdateAvailable, onConnection, onFirmwareUpdate, onAgent }: { snapshot: DeviceSnapshot; simulated: boolean; agentOpen:boolean;agentConfigured:boolean;firmwareUpdateAvailable:boolean;onConnection(): void;onFirmwareUpdate():void;onAgent():void }) {
  const ready = snapshot.connection === 'ready';
  const connecting = snapshot.connection === 'connecting' || snapshot.connection === 'identifying';
  const twin = snapshot.identity?.execution === 'firmware-digital-twin' || snapshot.pendingPort?.execution === 'firmware-digital-twin';
  return <header className="topbar">
    <div className="brand-lockup"><div className="brand-symbol"><AtomicMark size={27}/></div><div><small>tinySA</small><strong>Atomizer</strong></div></div>
    <div className="topbar-actions">
      {simulated && <span className="environment-badge">{connecting ? 'TWIN BOOTING' : 'DIGITAL TWIN'}</span>}
      {firmwareUpdateAvailable && <button data-agent-control="firmware.open" className="firmware-update-launch" onClick={onFirmwareUpdate}><ShieldCheck size={14}/><span><b>Firmware</b><small>Update ready</small></span></button>}
      {snapshot.generatorOutput !== 'off' && <span className={`top-rf-state ${snapshot.generatorOutput}`}>RF {snapshot.generatorOutput.toUpperCase()}</span>}
      <button data-agent-control="connection.open" className={`connection-pill ${ready ? 'is-ready' : ''}`} onClick={onConnection} aria-haspopup="dialog">
        <span className="status-dot"/>{connecting ? <LoaderCircle className="spin" size={15}/> : <Cable size={15}/>}<span><b>{ready ? snapshot.identity?.model ?? 'IDENTITY MISSING' : connecting ? twin ? 'Starting executable twin' : 'Identifying instrument' : 'No instrument'}</b><small>{ready ? snapshot.identity?.firmwareVersion : connecting ? twin ? 'Booting pinned firmware in Renode' : 'Verifying ZS407 identity' : 'Choose USB device'}</small></span><ChevronDown size={14}/>
      </button>
      <button data-agent-control="atom.toggle" className={`atom-launch ${agentOpen?'active':''}`} onClick={onAgent} aria-label="Toggle Atom AI copilot"><span className="atom-launch-orb"><AtomicMark size={23} active={agentOpen}/></span><span><b>Atom</b><small>{agentConfigured ? 'Ready' : 'Needs key'}</small></span></button>
    </div>
  </header>;
}
