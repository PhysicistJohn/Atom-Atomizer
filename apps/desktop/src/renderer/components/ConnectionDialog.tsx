import { Cable, Check, Cpu, FlaskConical, LoaderCircle, RefreshCw, Usb, X } from 'lucide-react';
import type {
  AtomizerInstrumentConnectionCleanupState,
  AtomizerInstrumentPreferenceState,
  InstrumentCandidate,
  InstrumentDiscoveryFailure,
} from '@tinysa/contracts';
import { instrumentCandidateUiKey } from '../ui-contracts.js';
import { instrumentCandidateMatchesPreference } from '../instrument-preference.js';

export function ConnectionDialog({ candidates, selectedId, busy, error, failures, preference, connectionCleanup, onSelect, onRefresh, onConnect, onDisconnect, onMakeDefault, connected, onClose }: {
  candidates: readonly InstrumentCandidate[];
  selectedId?: string;
  busy: boolean;
  error?: string;
  failures: readonly InstrumentDiscoveryFailure[];
  preference?: AtomizerInstrumentPreferenceState;
  connected: boolean;
  connectionCleanup: AtomizerInstrumentConnectionCleanupState;
  onSelect(id: string): void;
  onRefresh(): void;
  onConnect(): void;
  onDisconnect(): void;
  onMakeDefault(): void;
  onClose(): void;
}) {
  const selected = candidates.find((candidate) => instrumentCandidateUiKey(candidate) === selectedId);
  const isPreferred = selected !== undefined && instrumentCandidateMatchesPreference(selected, preference);
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
    <div className="dialog-head"><h2 id="connection-title">Connect</h2><button data-agent-control="connection.close" className="icon-button" onClick={onClose} aria-label="Close"><X size={17}/></button></div>
    {connected ? <div className="connected-state"><div className="connected-glyph"><Check size={24}/></div><h3>Connected</h3><button data-agent-control="connection.disconnect" className="danger-outline" disabled={busy} onClick={onDisconnect}>Disconnect</button></div> : <>
      {connectionCleanup.status === 'required' && <div className="inline-error" role="alert">
        <strong>Connection cleanup required</strong>{' '}
        {connectionCleanup.driverId} retained a failed {connectionCleanup.phase === 'rejected-session' ? 'session' : 'connection'} teardown.
        <button data-agent-control="connection.retry-cleanup" className="danger-outline" disabled={busy} onClick={onDisconnect}>Retry safe cleanup</button>
      </div>}
      <div className="dialog-toolbar"><p>Available instrument sources</p><button data-agent-control="connection.refresh" className="text-button" onClick={onRefresh} disabled={busy}><RefreshCw size={13}/>Refresh</button></div>
      <div className="port-list">{candidates.length === 0 ? <div className="no-ports"><Usb size={22}/><strong>No instrument source found</strong><span>SignalLab, TinySA USB, and executable firmware-twin discovery are independent. Inspect the failures below.</span></div> : candidates.map((candidate, index) => {
        const preferred = instrumentCandidateMatchesPreference(candidate, preference);
        const candidateKey = instrumentCandidateUiKey(candidate);
        return <button key={candidateKey} data-agent-control={`connection.candidate.${index + 1}.select`} className={`port-option ${selectedId === candidateKey ? 'selected' : ''}`} onClick={() => onSelect(candidateKey)}>
          <span className="port-icon">{sourceIcon(candidate.sourceKind)}</span>
          <span><strong>{candidate.displayName}</strong><small>{candidateDescription(candidate)}{preferred ? ' · STARTUP DEFAULT' : ''}</small></span>
          <i>{selectedId === candidateKey && <Check size={15}/>}</i>
        </button>;
      })}</div>
      {failures.length > 0 && <div className="inline-error" role="status">{failures.map((failure) => `${failure.driverId}: ${failure.message}`).join(' · ')}</div>}
      {error && <div className="inline-error">{error}</div>}
      <div className="dialog-actions">
        <button data-agent-exclusion="human-preference-boundary" className="secondary" disabled={!selected || busy || isPreferred || connectionCleanup.status === 'required'} onClick={onMakeDefault}>{isPreferred ? 'Startup default' : 'Use at startup'}</button>
        <button data-agent-control="connection.cancel" className="secondary" onClick={onClose}>Cancel</button>
        <button data-agent-control="connection.connect" className="primary" disabled={!selected || busy || connectionCleanup.status === 'required'} onClick={onConnect}>{busy ? <><LoaderCircle className="spin" size={14}/>Connecting</> : 'Connect'}</button>
      </div>
    </>}
  </section></div>;
}

function sourceIcon(source: InstrumentCandidate['sourceKind']) {
  if (source === 'signal-lab') return <FlaskConical size={17}/>;
  if (source === 'tinysa-firmware-twin') return <Cpu size={17}/>;
  return <Cable size={17}/>;
}

function candidateDescription(candidate: InstrumentCandidate): string {
  if (candidate.sourceKind === 'signal-lab') return `SignalLab measurement bridge · ${candidate.signalLab.sourceId} · no USB, firmware, or RF claims`;
  if (candidate.sourceKind === 'tinysa-firmware-twin') return `Renode bridge · ${candidate.firmwareTwin.repositoryCommit.slice(0, 12)} · USB transactions not modeled`;
  const serial = candidate.serialPort;
  const usb = serial.vendorId && serial.productId ? `${serial.vendorId}:${serial.productId}` : 'unverified USB identity';
  return `${serial.path} · ${usb}${serial.serialNumber ? ` · ${serial.serialNumber}` : ''} · exclusive CDC; finish any Flasher session first`;
}
