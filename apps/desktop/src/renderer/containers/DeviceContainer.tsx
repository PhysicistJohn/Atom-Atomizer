import { DeviceWorkspace } from '../components/DeviceWorkspace.js';
import { sameSessionWithoutConfiguration, selectBusy, selectTouchBusy, useStore, type AtomizerRendererState } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

const selectDeviceState = (state: AtomizerRendererState) => ({
  session: state.instrument.session,
  canonicalSurface: state.canonicalSurface,
  diagnostics: state.diagnostics,
  screenFrame: state.screenFrame,
});

type DeviceState = ReturnType<typeof selectDeviceState> & { readonly busy: boolean; readonly touchBusy: boolean };
const sameDeviceState = (left: DeviceState, right: DeviceState) =>
  sameSessionWithoutConfiguration(left.session, right.session)
  && Object.is(left.canonicalSurface, right.canonicalSurface)
  && Object.is(left.diagnostics, right.diagnostics)
  && Object.is(left.screenFrame, right.screenFrame)
  && left.busy === right.busy
  && left.touchBusy === right.touchBusy;

export function DeviceContainer({ runtime }: { runtime: RendererRuntime }) {
  const { features } = runtime;
  const s = useStore(runtime.store, (state) => ({
    ...selectDeviceState(state),
    busy: selectBusy(state, runtime.kernel.instrumentTransactionOwner.current),
    touchBusy: selectTouchBusy(state),
  }), sameDeviceState);
  return <DeviceWorkspace
    session={s.session}
    canonicalSurface={s.canonicalSurface}
    diagnostics={s.diagnostics}
    frame={s.screenFrame}
    busy={s.busy}
    touchBusy={s.touchBusy}
    onRefresh={() => void features.refreshDiagnosticsFromUi()}
    onCapture={() => void features.captureScreenFromUi()}
    onTap={(point) => features.tapScreen(point)}
  />;
}
