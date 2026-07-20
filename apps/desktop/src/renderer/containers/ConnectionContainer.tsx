import { ConnectionDialog } from '../components/ConnectionDialog.js';
import { connectedCandidateKey } from '../controllers/connection.js';
import { useStore } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

export function ConnectionContainer({ runtime }: { runtime: RendererRuntime }) {
  const s = useStore(runtime.store, (state) => state);
  const { connection } = runtime;
  if (!s.connectionOpen) return null;
  return <ConnectionDialog
    candidates={s.candidates}
    selectedId={s.selectedCandidateId}
    connectedId={connectedCandidateKey(s)}
    busy={s.connectionBusy}
    error={s.error}
    failures={s.discoveryFailures}
    preference={s.instrument.preference}
    connectionCleanup={s.instrument.connectionCleanup}
    onChoose={(id) => void connection.chooseCandidate(id)}
    onRefresh={() => void connection.refreshCandidates()}
    onDisconnect={() => void connection.disconnect()}
    onMakeDefault={() => void connection.makeSelectedDefault()}
    onClose={() => runtime.store.set({ connectionOpen: false })}
  />;
}
