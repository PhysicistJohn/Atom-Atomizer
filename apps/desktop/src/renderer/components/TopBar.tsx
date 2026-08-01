import { Cable, ChevronDown, LoaderCircle } from 'lucide-react';
import type { AtomizerInstrumentState, InstrumentSessionSnapshot } from '@tinysa/contracts';
import { formatLabel } from '../format.js';
import { AtomicMark } from './AtomicMark.js';

export function TopBar({ instrument, agentOpen, agentConfigured, onConnection, onAgent }: {
  instrument: Pick<AtomizerInstrumentState, 'startup' | 'session'>;
  agentOpen: boolean;
  agentConfigured: boolean;
  onConnection(): void;
  onAgent(): void;
}) {
  const session = instrument.session;
  const connecting = !session && instrument.startup.status === 'not-started';
  const virtualSession = session?.provenance.execution !== undefined
    && session.provenance.execution !== 'physical';
  const labels = sessionLabels(session);
  const rfStatus = rfStatusLabel(session);
  return <header className="topbar">
    <div className="brand-lockup"><div className="brand-symbol"><AtomicMark size={27}/></div><div><small>AtomOS</small><strong>Atomizer</strong></div></div>
    <div className="topbar-actions">
      {virtualSession && <span className="environment-badge" title="This session is not attached to a physical instrument">VIRTUAL INSTRUMENT</span>}
      {rfStatus && <span className={`top-rf-state ${rfStatus.state}`} title={rfStatus.title} aria-label={rfStatus.ariaLabel}>
        <span>RF {rfStatus.state.toUpperCase()}</span><small>{rfStatus.qualification}</small>
      </span>}
      <button data-agent-control="connection.open" className={`connection-pill ${session ? 'is-ready' : ''}`} onClick={onConnection} aria-haspopup="dialog">
        <span className="status-dot"/>{connecting ? <LoaderCircle className="spin" size={15}/> : <Cable size={15}/>}<span><b>{labels.title}</b><small>{labels.detail}</small></span><ChevronDown size={14}/>
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
    qualification: 'VIRTUAL CONTROL',
    ariaLabel: `RF output ${session.rfOutput}, virtual control state`,
    title: `RF output-${session.rfOutput} is virtual instrument state and does not claim physical RF emission`,
  };
}

function sessionLabels(session: InstrumentSessionSnapshot | undefined): { title: string; detail: string } {
  if (!session) return { title: 'No instrument', detail: 'Choose an instrument source' };
  return {
    title: session.candidate.displayName,
    detail: `${executionLabel(session.provenance.execution)} · ${formatLabel(session.provenance.transport)}`,
  };
}

function executionLabel(execution: InstrumentSessionSnapshot['provenance']['execution']): string {
  return execution === 'physical' ? 'Physical session' : 'Virtual session';
}
