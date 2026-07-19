import { DeviceWorkspace } from '../components/DeviceWorkspace.js';
import { selectBusy, selectTouchBusy, useStore } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

export function DeviceContainer({ runtime }: { runtime: RendererRuntime }) {
  const s = useStore(runtime.store, (state) => state);
  const { features } = runtime;
  const busy = selectBusy(s, runtime.kernel.instrumentTransactionOwner.current);
  return <DeviceWorkspace
    session={s.instrument.session}
    diagnostics={s.diagnostics}
    frame={s.screenFrame}
    busy={busy}
    touchBusy={selectTouchBusy(s)}
    selectedProfile={s.selectedProfile}
    onProfile={(profileId) => void features.selectSignalLabProfile(profileId)}
    onRefresh={() => void features.refreshDiagnosticsFromUi()}
    onCapture={() => void features.captureScreenFromUi()}
    onTap={(point) => features.tapScreen(point)}
  />;
}
