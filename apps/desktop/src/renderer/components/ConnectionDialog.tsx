import { useState } from 'react';
import { Cable, Check, Cpu, FlaskConical, LoaderCircle, Power, RadioTower, RefreshCw, Usb, X } from 'lucide-react';
import type {
  AtomizerInstrumentConnectionCleanupState,
  AtomizerInstrumentPreferenceState,
  InstrumentCandidate,
  InstrumentDiscoveryFailure,
} from '@tinysa/contracts';
import { instrumentCandidateUiKey } from '../ui-contracts.js';
import { instrumentCandidateMatchesPreference } from '../instrument-preference.js';

export function ConnectionDialog({ candidates, selectedId, connectedId, busy, error, failures, preference, connectionCleanup, onChoose, onRefresh, onDisconnect, onMakeDefault, onAddNeptuneEndpoint, onClose }: {
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
  onAddNeptuneEndpoint(sourceKind: 'neptune-p210' | 'neptune-p210-twin', endpoint: string): Promise<boolean>;
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
      if (await onAddNeptuneEndpoint('neptune-p210', manualEndpoint)) setManualEndpoint('');
    } finally {
      setManualBusy(false);
    }
  }
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
    <div className="dialog-head"><h2 id="connection-title">Instrument source</h2><button data-agent-control="connection.close" className="icon-button" onClick={onClose} aria-label="Close"><X size={17}/></button></div>
    {blocked && <div className="inline-error" role="alert">
      <strong>Connection cleanup required</strong>{' '}
      {connectionCleanup.driverId} retained a failed {connectionCleanup.phase === 'rejected-session' ? 'session' : 'connection'} teardown.
      <button data-agent-control="connection.retry-cleanup" className="danger-outline" disabled={busy} onClick={onDisconnect}>Retry safe cleanup</button>
    </div>}
    <div className="dialog-toolbar"><p>Select a source to connect</p><button data-agent-control="connection.refresh" className="text-button" onClick={onRefresh} disabled={busy}><RefreshCw size={13}/>Refresh</button></div>
    <div className="port-list">{candidates.length === 0 ? <div className="no-ports"><Usb size={22}/><strong>No instrument source found</strong><span>SignalLab, TinySA USB, executable firmware-twin, and Neptune P210 discovery are independent. Neptune P210 runs a live Bonjour/network scan and re-probes any recently-connected device (remembered for 7 days) on every refresh; a device on a routed network segment neither reaches will not appear here until it has been connected to at least once by address. Inspect the failures below.</span></div> : candidates.map((candidate, index) => {
      const preferred = instrumentCandidateMatchesPreference(candidate, preference);
      const candidateKey = instrumentCandidateUiKey(candidate);
      const isConnected = connectedId === candidateKey;
      const isConnecting = busy && selectedId === candidateKey && !isConnected;
      return <button key={candidateKey} data-agent-control={`connection.candidate.${index + 1}.select`} className={`port-option ${isConnected ? 'connected' : ''} ${selectedId === candidateKey ? 'selected' : ''}`} disabled={busy || blocked} aria-pressed={isConnected} onClick={() => onChoose(candidateKey)}>
        <span className="port-icon">{sourceIcon(candidate.sourceKind)}</span>
        <span><strong>{candidate.displayName}</strong><small>{candidateDescription(candidate)}{preferred ? ' · STARTUP DEFAULT' : ''}</small></span>
        <i>{isConnecting ? <LoaderCircle className="spin" size={15}/> : isConnected ? <span className="port-connected"><Check size={14}/>CONNECTED</span> : null}</i>
      </button>;
    })}</div>
    <div className="manual-endpoint" data-agent-exclusion="human-neptune-manual-endpoint-boundary">
      <label htmlFor="neptune-manual-endpoint">Connect a Neptune P210 by address</label>
      <div className="manual-endpoint-row">
        <input
          id="neptune-manual-endpoint"
          type="text"
          placeholder="ip:10.0.0.250"
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
          {manualBusy ? <LoaderCircle className="spin" size={13}/> : <RadioTower size={13}/>}
          Add
        </button>
      </div>
      <span className="manual-endpoint-hint">Verifies the device, then lists it above to connect — only needed once, remembered for 7 days after that.</span>
    </div>
    {failures.length > 0 && <div className="inline-error" role="status">{failures.map((failure) => `${failure.driverId}: ${failure.message}`).join(' · ')}</div>}
    {error && <div className="inline-error">{error}</div>}
    <div className="dialog-actions">
      <button data-agent-exclusion="human-preference-boundary" className="secondary" disabled={!selected || busy || isPreferred || blocked} onClick={onMakeDefault}>{isPreferred ? 'Startup default' : 'Use at startup'}</button>
      <button data-agent-control="connection.disconnect" className="danger-outline" disabled={!connectedId || busy} onClick={onDisconnect}><Power size={14}/>Disconnect</button>
    </div>
  </section></div>;
}

function sourceIcon(source: InstrumentCandidate['sourceKind']) {
  if (source === 'signal-lab') return <FlaskConical size={17}/>;
  if (source === 'tinysa-firmware-twin') return <Cpu size={17}/>;
  if (source === 'neptune-p210') return <RadioTower size={17}/>;
  if (source === 'neptune-p210-twin') return <Cpu size={17}/>;
  return <Cable size={17}/>;
}

function candidateDescription(candidate: InstrumentCandidate): string {
  if (candidate.sourceKind === 'signal-lab') return `SignalLab measurement bridge · ${candidate.signalLab.sourceId} · no USB, firmware, or RF claims`;
  if (candidate.sourceKind === 'tinysa-firmware-twin') return `Renode bridge · ${candidate.firmwareTwin.repositoryCommit.slice(0, 12)} · USB transactions not modeled`;
  if (candidate.sourceKind === 'neptune-p210') {
    const { endpoint, contextDescription } = candidate.neptuneP210;
    return `NeptuneSDR P210 (AD9361) · ${endpoint}${contextDescription ? ` · ${contextDescription}` : ''} · libiio network · complex I/Q only, no RF output`;
  }
  if (candidate.sourceKind === 'neptune-p210-twin') {
    const { endpoint, profile } = candidate.neptuneP210Twin;
    return `QEMU digital twin · ${endpoint} · ${profile} · physical RF not modeled`;
  }
  const serial = candidate.serialPort;
  const usb = serial.vendorId && serial.productId ? `${serial.vendorId}:${serial.productId}` : 'unverified USB identity';
  return `${serial.path} · ${usb}${serial.serialNumber ? ` · ${serial.serialNumber}` : ''} · exclusive CDC; finish any Flasher session first`;
}
