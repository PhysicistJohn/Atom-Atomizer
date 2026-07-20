import type {
  AtomizerInstrumentState,
  InstrumentCandidate,
  InstrumentDiscoveryFailure,
  InstrumentSessionSnapshot,
} from '@tinysa/contracts';
import { instrumentCandidateUiKey } from '../ui-contracts.js';
import {
  instrumentCandidateMatchesPreference,
  instrumentPreferenceSelectionForCandidate,
} from '../instrument-preference.js';
import { errorMessage, type RendererKernel } from './kernel.js';

export class ConnectionController {
  constructor(private readonly k: RendererKernel) {}

  acceptDiscovery(nextCandidates: readonly InstrumentCandidate[], failures: readonly InstrumentDiscoveryFailure[]): void {
    const k = this.k;
    k.set({ candidates: [...nextCandidates], discoveryFailures: [...failures] });
    k.setKey('selectedCandidateId', (current) => {
      if (current && nextCandidates.some((candidate) => instrumentCandidateUiKey(candidate) === current)) return current;
      const preferred = preferredCandidate(nextCandidates, k.state.instrument);
      const selected = preferred ?? nextCandidates[0];
      return selected ? instrumentCandidateUiKey(selected) : undefined;
    });
  }

  async refreshCandidates(): Promise<void> {
    try { await this.k.acquisition.runInstrumentTransaction('discover-instruments', () => this.refreshCandidatesOwned()); }
    catch (value) { this.k.set({ error: errorMessage(value) }); }
  }

  async refreshCandidatesOwned(): Promise<void> {
    const k = this.k;
    k.set({ error: undefined });
    try {
      const discoveryEventSequence = k.instrumentDiscoveryEventSequence.current;
      const next = await window.atomizerInstrument.discover();
      if (k.instrumentDiscoveryEventSequence.current === discoveryEventSequence) {
        this.acceptDiscovery(next.candidates, next.failures);
      }
    } catch (value) { k.set({ error: errorMessage(value) }); }
  }

  connectCandidate(candidate: InstrumentCandidate): Promise<InstrumentSessionSnapshot> {
    return this.k.acquisition.runInstrumentTransaction('connect-instrument', () => this.connectCandidateOwned(candidate));
  }

  async connectCandidateOwned(candidate: InstrumentCandidate): Promise<InstrumentSessionSnapshot> {
    const k = this.k;
    k.set({ connectionBusy: true, error: undefined });
    k.invalidateAcquiredEvidence();
    try {
      const next = await window.atomizerInstrument.connect(candidate);
      k.events.acceptSession(next);
      // Selecting a source connects and closes the chooser in one step.
      // Reopening it while connected shows the source list with the active
      // source marked (no dead-end "Connected" screen), so switching or
      // disconnecting stays one click away.
      k.set({ connectionOpen: false, notice: connectionNotice(next) });
      return next;
    } catch (value) {
      k.set({ error: errorMessage(value) });
      throw value;
    } finally { k.set({ connectionBusy: false }); }
  }

  async connect(): Promise<void> {
    const k = this.k;
    const candidate = k.state.candidates.find((value) => instrumentCandidateUiKey(value) === k.state.selectedCandidateId);
    if (!candidate) { k.set({ error: 'Select an available instrument source before connecting' }); return; }
    try { await this.connectCandidate(candidate); } catch { /* Presented in the connection dialog. */ }
  }

  // Selection-driven connect: picking a source connects to it, switching away
  // from any current session first. The manager refuses to open a second
  // session, so the disconnect-before-connect ordering is mandatory, not
  // cosmetic. Picking the already-active source is a no-op.
  async chooseCandidate(candidateKey: string): Promise<void> {
    const k = this.k;
    const candidate = k.state.candidates.find((value) => instrumentCandidateUiKey(value) === candidateKey);
    if (!candidate) return;
    k.set({ selectedCandidateId: candidateKey });
    if (connectedCandidateKey(k.state) === candidateKey) return;
    if (k.state.instrument.session) {
      try { await this.disconnectDevice(); } catch { return; }
    }
    try { await this.connectCandidate(candidate); } catch { /* Presented in the connection dialog. */ }
  }

  async disconnectDevice(): Promise<void> {
    const k = this.k;
    const sourceKind = k.state.instrument.session?.provenance.sourceKind;
    k.set({ connectionBusy: true, error: undefined });
    try {
      await window.atomizerInstrument.disconnect();
      k.continuousRequested.current = false;
      k.acquisition.wakeContinuousIqAdmissionWaiters();
      k.set({ continuous: false });
      k.events.acceptInstrumentState({
        ...k.state.instrument,
        session: undefined,
        streaming: { status: 'stopped' },
        connectionCleanup: { status: 'not-required' },
      });
      k.invalidateAcquiredEvidence();
      k.set({
        acquisition: 'idle',
        diagnostics: [],
        screenFrame: undefined,
        notice: sourceKind === 'serial-port' ? 'Physical instrument disconnected; RF state is no longer inferred' : sourceKind === 'tinysa-firmware-twin' ? 'Executable twin disconnected and its Renode process terminated' : 'Instrument source disconnected',
      });
    } catch (value) {
      k.set({ error: errorMessage(value) });
      throw value;
    } finally { k.set({ connectionBusy: false }); }
  }

  async disconnect(): Promise<void> { try { await this.disconnectDevice(); } catch { /* Presented in the connection dialog. */ } }

  async makeSelectedDefault(): Promise<void> {
    const k = this.k;
    const candidate = k.state.candidates.find((value) => instrumentCandidateUiKey(value) === k.state.selectedCandidateId);
    if (!candidate) { k.set({ error: 'Select an instrument source before setting the startup default' }); return; }
    try {
      const preference = await window.atomizerInstrument.writePreference(instrumentPreferenceSelectionForCandidate(candidate));
      k.events.acceptInstrumentState({ ...k.state.instrument, preference });
      k.set({ notice: `${candidate.displayName} will be used at the next startup` });
    } catch (value) { k.set({ error: `Startup preference failed: ${errorMessage(value)}` }); }
  }
}

// The connected candidate's UI key is derived from the live session, but its
// discoveryRevision differs from the current candidate list, so match on the
// stable identity triple instead of the full UI key.
export function connectedCandidateKey(state: { instrument: AtomizerInstrumentState; candidates: readonly InstrumentCandidate[] }): string | undefined {
  const session = state.instrument.session;
  if (!session) return undefined;
  const match = state.candidates.find((candidate) =>
    candidate.driverId === session.candidate.driverId
    && candidate.sourceKind === session.candidate.sourceKind
    && candidate.candidateId === session.candidate.candidateId);
  return match ? instrumentCandidateUiKey(match) : undefined;
}

export function preferredCandidate(candidates: readonly InstrumentCandidate[], state: AtomizerInstrumentState): InstrumentCandidate | undefined {
  const preference = state.preference?.preference;
  if (!preference) return undefined;
  return candidates.find((candidate) => instrumentCandidateMatchesPreference(candidate, state.preference));
}

export function instrumentCandidateIsSimulated(candidate: InstrumentCandidate): boolean {
  switch (candidate.sourceKind) {
    case 'serial-port': return false;
    case 'tinysa-firmware-twin':
    case 'signal-lab': return true;
    default: {
      const unhandledCandidate: never = candidate;
      throw new Error(`Instrument candidate simulation status is undefined for ${JSON.stringify(unhandledCandidate)}`);
    }
  }
}

export function connectionNotice(session: InstrumentSessionSnapshot): string {
  const provenance = session.provenance;
  if (provenance.sourceKind === 'signal-lab') return `${session.candidate.displayName} connected as a synthetic measurement source; USB, firmware execution, and RF emission are not claimed`;
  if (provenance.sourceKind === 'tinysa-firmware-twin') return `${provenance.device.model} executable firmware twin connected through ${provenance.bridge}`;
  if (provenance.device.firmwareQualification === 'custom-unqualified') {
    return `${provenance.device.model} connected with custom, source-unqualified firmware`;
  }
  if (provenance.device.firmwareQualification === 'custom-source-qualified-receive-only') {
    return `${provenance.device.model} connected with frozen-source-qualified custom receive-only firmware`;
  }
  return `${provenance.device.model} connected and identified`;
}
