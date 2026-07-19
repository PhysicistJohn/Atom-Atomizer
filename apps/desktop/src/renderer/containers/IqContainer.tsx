import { IqWorkspace } from '../components/IqWorkspace.js';
import { selectBusy, selectIqCapability, selectIqCaptureUnavailableReason, useStore } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

export function IqContainer({ runtime }: { runtime: RendererRuntime }) {
  const s = useStore(runtime.store, (state) => state);
  const connected = s.instrument.session !== undefined;
  const busy = selectBusy(s, runtime.kernel.instrumentTransactionOwner.current);
  return <IqWorkspace
    configuration={s.iqConfiguration}
    capability={selectIqCapability(s)}
    capture={s.iqCapture}
    busy={!connected || busy}
    captureUnavailableReason={selectIqCaptureUnavailableReason(s)}
    onChange={(configuration) => runtime.acquisition.stageIqConfiguration(configuration)}
  />;
}
