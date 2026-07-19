import { ConnectionDialog } from '../components/ConnectionDialog.js';
import { useStore } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

export function ConnectionContainer({ runtime }: { runtime: RendererRuntime }) {
  const s = useStore(runtime.store, (state) => state);
  const { connection } = runtime;
  if (!s.connectionOpen) return null;
  return <ConnectionDialog
    candidates={s.candidates}
    selectedId={s.selectedCandidateId}
    busy={s.connectionBusy}
    error={s.error}
    failures={s.discoveryFailures}
    preference={s.instrument.preference}
    connected={s.instrument.session !== undefined}
    connectionCleanup={s.instrument.connectionCleanup}
    onSelect={(id) => runtime.store.set({ selectedCandidateId: id })}
    onRefresh={() => void connection.refreshCandidates()}
    onConnect={() => void connection.connect()}
    onDisconnect={() => void connection.disconnect()}
    onMakeDefault={() => void connection.makeSelectedDefault()}
    onClose={() => runtime.store.set({ connectionOpen: false })}
  />;
}
