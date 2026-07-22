import { ConnectionDialog } from '../components/ConnectionDialog.js';
import { connectedCandidateKey } from '../controllers/connection.js';
import { shallowEqual, useStore, type AtomizerRendererState } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

export function ConnectionContainer({ runtime }: { runtime: RendererRuntime }) {
  const open = useStore(runtime.store, (state) => state.connectionOpen);
  return open ? <OpenConnectionDialog runtime={runtime}/> : null;
}

const selectConnectionDialogState = (state: AtomizerRendererState) => ({
  candidates: state.candidates,
  selectedCandidateId: state.selectedCandidateId,
  connectionBusy: state.connectionBusy,
  error: state.error,
  discoveryFailures: state.discoveryFailures,
  connectedId: connectedCandidateKey(state),
  preference: state.instrument.preference,
  connectionCleanup: state.instrument.connectionCleanup,
});

function OpenConnectionDialog({ runtime }: { runtime: RendererRuntime }) {
  const s = useStore(runtime.store, selectConnectionDialogState, shallowEqual);
  const { connection } = runtime;
  return <ConnectionDialog
    candidates={s.candidates}
    selectedId={s.selectedCandidateId}
    connectedId={s.connectedId}
    busy={s.connectionBusy}
    error={s.error}
    failures={s.discoveryFailures}
    preference={s.preference}
    connectionCleanup={s.connectionCleanup}
    onChoose={(id) => void connection.chooseCandidate(id)}
    onRefresh={() => void connection.refreshCandidates()}
    onDisconnect={() => void connection.disconnect()}
    onMakeDefault={() => void connection.makeSelectedDefault()}
    onClose={() => runtime.store.set({ connectionOpen: false })}
  />;
}
