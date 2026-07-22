import { DeviceWorkspace } from '../components/DeviceWorkspace.js';
import { sameSessionWithoutConfiguration, selectBusy, selectTouchBusy, useStore, type AtomizerRendererState } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

const selectDeviceState = (state: AtomizerRendererState) => ({
  session: state.instrument.session,
  diagnostics: state.diagnostics,
  screenFrame: state.screenFrame,
  selectedProfile: state.selectedProfile,
});

type DeviceState = ReturnType<typeof selectDeviceState> & { readonly busy: boolean; readonly touchBusy: boolean };
const sameDeviceState = (left: DeviceState, right: DeviceState) =>
  sameSessionWithoutConfiguration(left.session, right.session)
  && Object.is(left.diagnostics, right.diagnostics)
  && Object.is(left.screenFrame, right.screenFrame)
  && left.selectedProfile === right.selectedProfile
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
    diagnostics={s.diagnostics}
    frame={s.screenFrame}
    busy={s.busy}
    touchBusy={s.touchBusy}
    selectedProfile={s.selectedProfile}
    onProfile={(profileId) => void features.selectSignalLabProfile(profileId)}
    onRefresh={() => void features.refreshDiagnosticsFromUi()}
    onCapture={() => void features.captureScreenFromUi()}
    onTap={(point) => features.tapScreen(point)}
  />;
}
