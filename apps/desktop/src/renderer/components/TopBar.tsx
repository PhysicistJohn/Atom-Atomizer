import { Cable, ChevronDown, FlaskConical, LoaderCircle } from 'lucide-react';
import type { AtomizerInstrumentState, InstrumentSessionSnapshot } from '@tinysa/contracts';
import { AtomicMark } from './AtomicMark.js';

export function TopBar({ instrument, agentOpen, agentConfigured, onConnection, onAgent }: {
  instrument: AtomizerInstrumentState;
  agentOpen: boolean;
  agentConfigured: boolean;
  onConnection(): void;
  onAgent(): void;
}) {
  const session = instrument.session;
  const connecting = !session && instrument.startup.status === 'not-started';
  const customFirmware = session?.provenance.sourceKind === 'serial-port'
    && session.provenance.device.firmwareQualification === 'custom-unqualified';
  const synthetic = session?.provenance.sourceKind === 'signal-lab';
  const twin = session?.provenance.sourceKind === 'tinysa-firmware-twin';
  const labels = sessionLabels(session);
  const rfStatus = rfStatusLabel(session);
  return <header className="topbar">
    <div className="brand-lockup"><div className="brand-symbol"><AtomicMark size={27}/></div><div><small>tinySA</small><strong>Atomizer</strong></div></div>
    <div className="topbar-actions">
      {synthetic && <span className="environment-badge">SIGNALLAB SIMULATION</span>}
      {twin && <span className="environment-badge">FIRMWARE TWIN</span>}
      {customFirmware && <span className="environment-badge custom-firmware" title={session.provenance.sourceKind === 'serial-port' ? session.provenance.device.firmwareWarning : undefined}>CUSTOM FW · UNQUALIFIED</span>}
      {rfStatus && <span className={`top-rf-state ${rfStatus.state}`} title={rfStatus.title} aria-label={rfStatus.ariaLabel}>
        <span>RF {rfStatus.state.toUpperCase()}</span><small>{rfStatus.qualification}</small>
      </span>}
      <button data-agent-control="connection.open" className={`connection-pill ${session ? 'is-ready' : ''}`} onClick={onConnection} aria-haspopup="dialog">
        <span className="status-dot"/>{connecting ? <LoaderCircle className="spin" size={15}/> : synthetic ? <FlaskConical size={15}/> : <Cable size={15}/>}<span><b>{labels.title}</b><small>{labels.detail}</small></span><ChevronDown size={14}/>
      </button>
      <button data-agent-control="atom.toggle" className={`atom-launch ${agentOpen ? 'active' : ''}`} onClick={onAgent} aria-label="Toggle Atom AI copilot"><span className="atom-launch-orb"><AtomicMark size={23} active={agentOpen}/></span><span><b>Atom</b><small>{agentConfigured ? 'Ready' : 'Needs key'}</small></span></button>
    </div>
  </header>;
}

function rfStatusLabel(session: InstrumentSessionSnapshot | undefined): {
  state: 'off' | 'on' | 'unknown';
  qualification: string;
  ariaLabel: string;
  title: string;
} | undefined {
  if (!session || session.rfOutput === 'not-supported') return undefined;
  if (session.rfOutput === 'unknown') {
    return {
      state: 'unknown',
      qualification: 'UNVERIFIED',
      ariaLabel: 'RF output unknown, unverified',
      title: 'RF output state is unknown and unsafe; disconnect or re-establish a verified session before other work',
    };
  }
  if (session.rfOutputQualification === 'command-acknowledged') {
    return {
      state: session.rfOutput,
      qualification: 'COMMAND ACKNOWLEDGED',
      ariaLabel: `RF output ${session.rfOutput}, command acknowledged`,
      title: `RF output-${session.rfOutput} command was acknowledged by the physical instrument transport; emitted RF power was not independently measured`,
    };
  }
  if (session.rfOutputQualification === 'not-applicable') {
    return {
      state: session.rfOutput,
      qualification: 'NOT PHYSICAL RF',
      ariaLabel: `RF output ${session.rfOutput}, physical RF not applicable`,
      title: `RF output-${session.rfOutput} is source-local state and does not claim physical RF emission`,
    };
  }
  return {
    state: session.rfOutput,
    qualification: 'FIRMWARE-EXECUTED TWIN',
    ariaLabel: `RF output ${session.rfOutput}, firmware-executed twin state`,
    title: `RF output-${session.rfOutput} is executable firmware-twin state and does not claim physical RF emission`,
  };
}

function sessionLabels(session: InstrumentSessionSnapshot | undefined): { title: string; detail: string } {
  if (!session) return { title: 'No instrument', detail: 'Choose an instrument source' };
  if (session.provenance.sourceKind === 'signal-lab') {
    return { title: session.candidate.displayName, detail: 'Synthetic measurement bridge · no USB or firmware identity' };
  }
  if (session.provenance.sourceKind === 'tinysa-firmware-twin') {
    return { title: session.provenance.device.model, detail: `${session.provenance.device.firmwareVersion} · executable firmware twin` };
  }
  return { title: session.provenance.device.model, detail: session.provenance.device.firmwareVersion };
}
