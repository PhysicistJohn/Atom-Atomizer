import { useState } from 'react';
import { Cable, Check, LoaderCircle, Network, Power, RefreshCw, Usb, X } from 'lucide-react';
import type {
  AtomizerInstrumentConnectionCleanupState,
  AtomizerInstrumentPreferenceState,
  InstrumentCandidate,
  InstrumentDiscoveryFailure,
} from '@tinysa/contracts';
import { instrumentCandidateUiKey } from '../ui-contracts.js';
import { instrumentCandidateMatchesPreference } from '../instrument-preference.js';

export function ConnectionDialog({ candidates, selectedId, connectedId, busy, error, failures, preference, connectionCleanup, onChoose, onRefresh, onDisconnect, onMakeDefault, onAddManualEndpoint, onClose }: {
  candidates: readonly InstrumentCandidate[];
  selectedId?: string;
  connectedId?: string;
  busy: boolean;
  error?: string;
  failures: readonly InstrumentDiscoveryFailure[];
  preference?: AtomizerInstrumentPreferenceState;
  connectionCleanup: AtomizerInstrumentConnectionCleanupState;
  onChoose(id: string): void;
  onRefresh(): void;
  onDisconnect(): void;
  onMakeDefault(): void;
  onAddManualEndpoint(endpoint: string): Promise<boolean>;
  onClose(): void;
}) {
  const selected = candidates.find((candidate) => instrumentCandidateUiKey(candidate) === selectedId);
  const isPreferred = selected !== undefined && instrumentCandidateMatchesPreference(selected, preference);
  const blocked = connectionCleanup.status === 'required';
  const [manualEndpoint, setManualEndpoint] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  async function submitManualEndpoint(): Promise<void> {
    if (!manualEndpoint.trim() || manualBusy) return;
    setManualBusy(true);
    try {
      // Failure is surfaced through the shared `error` state below, same as
      // every other connection action -- no separate error UI to keep in sync.
      if (await onAddManualEndpoint(manualEndpoint)) setManualEndpoint('');
    } finally {
      setManualBusy(false);
    }
  }
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
    <div className="dialog-head"><h2 id="connection-title">Instrument source</h2><button data-agent-control="connection.close" className="icon-button" onClick={onClose} aria-label="Close"><X size={17}/></button></div>
    {blocked && <div className="inline-error" role="alert">
      <strong>Connection cleanup required</strong>{' '}
      A driver retained a failed {connectionCleanup.phase === 'rejected-session' ? 'session' : 'connection'} teardown.
      <button data-agent-control="connection.retry-cleanup" className="danger-outline" disabled={busy} onClick={onDisconnect}>Retry safe cleanup</button>
    </div>}
    <div className="dialog-toolbar"><p>Select a source to connect</p><button data-agent-control="connection.refresh" className="text-button" onClick={onRefresh} disabled={busy}><RefreshCw size={13}/>Refresh</button></div>
    <div className="port-list">{candidates.length === 0 ? <div className="no-ports"><Usb size={22}/><strong>No instrument source found</strong><span>Refresh checks available sources and rechecks remembered network addresses. A compatible source on a routed network may need to be added by address once before it can appear here automatically. Inspect the failures below.</span></div> : candidates.map((candidate, index) => {
      const preferred = instrumentCandidateMatchesPreference(candidate, preference);
      const candidateKey = instrumentCandidateUiKey(candidate);
      const isConnected = connectedId === candidateKey;
      const isConnecting = busy && selectedId === candidateKey && !isConnected;
      return <button key={candidateKey} data-agent-control={`connection.candidate.${index + 1}.select`} className={`port-option ${isConnected ? 'connected' : ''} ${selectedId === candidateKey ? 'selected' : ''}`} disabled={busy || blocked} aria-pressed={isConnected} onClick={() => onChoose(candidateKey)}>
        <span className="port-icon"><Cable size={17}/></span>
        <span><strong>{candidate.displayName}</strong><small>{candidateDescription(candidate)}{preferred ? ' · STARTUP DEFAULT' : ''}</small></span>
        <i>{isConnecting ? <LoaderCircle className="spin" size={15}/> : isConnected ? <span className="port-connected"><Check size={14}/>CONNECTED</span> : null}</i>
      </button>;
    })}</div>
    <div className="manual-endpoint" data-agent-exclusion="human-manual-endpoint-boundary">
      <label htmlFor="manual-endpoint">Connect by network address</label>
      <div className="manual-endpoint-row">
        <input
          id="manual-endpoint"
          type="text"
          placeholder="ip:host"
          value={manualEndpoint}
          disabled={manualBusy || busy}
          onChange={(event) => setManualEndpoint(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void submitManualEndpoint(); }}
        />
        <button
          className="text-button"
          disabled={manualBusy || busy || !manualEndpoint.trim()}
          onClick={() => void submitManualEndpoint()}
        >
          {manualBusy ? <LoaderCircle className="spin" size={13}/> : <Network size={13}/>}
          Add address
        </button>
      </div>
      <span className="manual-endpoint-hint">Verifies a compatible source, then lists it above to connect. Remembered addresses are rechecked on later refreshes.</span>
    </div>
    {failures.length > 0 && <div className="inline-error" role="status">{failures.map((failure) => failure.message).join(' · ')}</div>}
    {error && <div className="inline-error">{error}</div>}
    <div className="dialog-actions">
      <button data-agent-exclusion="human-preference-boundary" className="secondary" disabled={!selected || busy || isPreferred || blocked} onClick={onMakeDefault}>{isPreferred ? 'Startup default' : 'Use at startup'}</button>
      <button data-agent-control="connection.disconnect" className="danger-outline" disabled={!connectedId || busy} onClick={onDisconnect}><Power size={14}/>Disconnect</button>
    </div>
  </section></div>;
}

function candidateDescription(_candidate: InstrumentCandidate): string {
  // Candidate identity and protocol details remain inside the driver.  The
  // display name is the driver-provided human selector; Atomizer needs no
  // source-family switch to decide how it can be connected.
  return 'Driver-provided connection candidate';
}
