import type {
  AtomizerInstrumentState,
  InstrumentCandidate,
  InstrumentDiscoveryFailure,
  InstrumentSessionSnapshot,
} from '@tinysa/contracts';
import { instrumentCandidateUiKey, sameInstrumentCandidateDescriptor } from '../ui-contracts.js';
import {
  instrumentCandidateMatchesPreference,
  instrumentPreferenceSelectionForCandidate,
} from '../instrument-preference.js';
import { errorMessage, type RendererKernel } from './kernel.js';

/**
 * `InstrumentManager` rejects `connect()` for any candidate that does not
 * exactly match its own latest completed discovery -- including a discovery
 * the renderer never itself requested (e.g. `writePreference()` runs one
 * internally before persisting a selection). A stale candidate is always
 * structurally recoverable: the underlying device did not change, only the
 * opaque discovery revision did, so re-discovering and matching the same
 * device by its stable identity (everything but `discoveryRevision` --
 * see `sameInstrumentCandidateDescriptor`) and retrying once is strictly
 * better than surfacing a confusing internal revision-mismatch message an
 * operator has no way to act on.
 */
function isStaleCandidateMessage(value: unknown): boolean {
  return errorMessage(value).toLowerCase().includes('stale')
    && errorMessage(value).toLowerCase().includes('discovery');
}

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

  /**
   * One-time manual network bootstrap. The main process owns the supported
   * driver routing; the renderer only submits an address and refreshes the
   * normal candidate list after a successful admission.
   */
  async addManualEndpoint(endpoint: string): Promise<boolean> {
    const k = this.k;
    k.set({ error: undefined });
    const addManualEndpoint = window.atomizerInstrument.addManualEndpoint;
    if (!addManualEndpoint) {
      k.set({ error: 'Manual network addresses are unavailable in this edition.' });
      return false;
    }
    try {
      const result = await addManualEndpoint(endpoint);
      if (!result.ok) {
        k.set({ error: result.message });
        return false;
      }
      await this.refreshCandidates();
      return true;
    } catch (value) {
      k.set({ error: errorMessage(value) });
      return false;
    }
  }

  connectCandidate(candidate: InstrumentCandidate): Promise<InstrumentSessionSnapshot> {
    return this.k.acquisition.runInstrumentTransaction('connect-instrument', () => this.connectCandidateOwned(candidate));
  }

  async connectCandidateOwned(candidate: InstrumentCandidate): Promise<InstrumentSessionSnapshot> {
    const k = this.k;
    k.set({ connectionBusy: true, error: undefined });
    k.invalidateAcquiredEvidence();
    try {
      let next: InstrumentSessionSnapshot;
      try {
        next = await window.atomizerInstrument.connect(candidate);
      } catch (value) {
        if (!isStaleCandidateMessage(value)) throw value;
        // See isStaleCandidateMessage's doc comment. Re-discover, match the
        // same device by stable identity (never by object equality, since
        // `discoveryRevision` is exactly what changed), and retry exactly
        // once -- this must never loop, so a device that has genuinely
        // disappeared or a second stale rejection surfaces a real error
        // instead of retrying forever.
        const fresh = await window.atomizerInstrument.discover();
        this.acceptDiscovery(fresh.candidates, fresh.failures);
        const rematched = fresh.candidates.find((value) => sameInstrumentCandidateDescriptor(value, candidate));
        if (!rematched) {
          throw new Error(
            `${candidate.displayName} is no longer in the discovered instrument list -- it may have disappeared. Refresh and try again.`,
          );
        }
        next = await window.atomizerInstrument.connect(rematched);
      }
      k.events.acceptSession(next);
      // Selecting a source connects and closes the chooser in one step.
      // Reopening it while connected shows the source list with the active
      // source marked (no dead-end "Connected" screen), so switching or
      // disconnecting stays one click away.
      k.store.update((current) => ({
        // An operator can move from the connection sheet to Atom while the
        // request is in flight. Only release the surface this request owns.
        secondaryPanel: current.secondaryPanel === 'connection' ? undefined : current.secondaryPanel,
        notice: connectionNotice(next),
      }));
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
        notice: 'Instrument disconnected',
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
// discoveryRevision differs from the current candidate list. Match the
// driver-owned stable descriptor instead of inspecting a candidate family or
// treating the opaque revision as identity.
export function connectedCandidateKey(state: { instrument: AtomizerInstrumentState; candidates: readonly InstrumentCandidate[] }): string | undefined {
  const session = state.instrument.session;
  if (!session) return undefined;
  const match = state.candidates.find((candidate) => sameInstrumentCandidateDescriptor(candidate, session.candidate));
  return match ? instrumentCandidateUiKey(match) : undefined;
}

export function preferredCandidate(candidates: readonly InstrumentCandidate[], state: AtomizerInstrumentState): InstrumentCandidate | undefined {
  const preference = state.preference?.preference;
  if (!preference) return undefined;
  return candidates.find((candidate) => instrumentCandidateMatchesPreference(candidate, state.preference));
}

/**
 * Execution truth belongs to an admitted session, not to a discovery
 * candidate.  A candidate can therefore only be labeled virtual after it is
 * matched to the driver-provided session descriptor; before admission the
 * answer is deliberately unknown.
 */
export function candidateSessionIsVirtual(
  candidate: InstrumentCandidate,
  session: Pick<InstrumentSessionSnapshot, 'candidate' | 'provenance'> | undefined = undefined,
): boolean | undefined {
  if (!session || !sameInstrumentCandidateDescriptor(candidate, session.candidate)) return undefined;
  return session.provenance.execution !== 'physical';
}

/** @deprecated Use `candidateSessionIsVirtual`; bare candidates have no execution evidence. */
export const instrumentCandidateIsSimulated = candidateSessionIsVirtual;

export function connectionNotice(session: InstrumentSessionSnapshot): string {
  const provenance = session.provenance;
  const execution = provenance.execution === 'physical' ? 'physical session' : 'virtual session';
  const transport = typeof provenance.transport === 'string'
    ? ` · ${provenance.transport.replaceAll('-', ' ')}`
    : '';
  return `${session.candidate.displayName} connected · ${execution}${transport}`;
}
