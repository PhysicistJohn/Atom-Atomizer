import { Sidebar } from '../components/Sidebar.js';
import { DEVELOPMENT_RENDERER } from '../development.js';
import {
  acquisitionModeForSession,
  generatorOutputState,
  selectAcquisitionDisabledReason,
  selectBusy,
  selectGeneratorCapability,
  selectIqCapability,
  selectSignalLabProfileCapability,
  selectSpectrumCapability,
  shallowEqual,
  useStore,
  type AtomizerRendererState,
} from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

export function SidebarContainer({ runtime }: { runtime: RendererRuntime }) {
  const { kernel } = runtime;
  const state = useStore(runtime.store, (current: AtomizerRendererState) => {
    const session = current.instrument.session;
    const iqAvailable = selectIqCapability(current) !== undefined;
    const busy = selectBusy(current, kernel.instrumentTransactionOwner.current);
    return {
      workspace: current.workspace,
      measurementView: current.measurementView,
      output: generatorOutputState(session),
      generationAvailable: selectGeneratorCapability(current) !== undefined
        || selectSignalLabProfileCapability(current) !== undefined,
      iqAvailable,
      spectrumAvailable: selectSpectrumCapability(current) !== undefined,
      connected: session !== undefined,
      acquisition: current.acquisition,
      continuous: current.continuous,
      continuousMode: current.continuousMode,
      busy,
      acquisitionDisabledReason: selectAcquisitionDisabledReason(current, busy),
      // This evidence exists only for development inspection/accessibility
      // tests. Production sidebars remain detached from advancing sweeps.
      latestSweepId: DEVELOPMENT_RENDERER ? current.sweep?.id : undefined,
      latestSweepSequence: DEVELOPMENT_RENDERER ? current.sweep?.sequence : undefined,
    };
  }, shallowEqual);
  const contextualAcquisitionMode = acquisitionModeForSession(state.iqAvailable);
  const latestSweep = state.latestSweepId === undefined || state.latestSweepSequence === undefined
    ? undefined
    : { id: state.latestSweepId, sequence: state.latestSweepSequence };

  return <Sidebar
    active={state.workspace}
    measurementView={state.measurementView}
    output={state.output}
    generationAvailable={state.generationAvailable}
    iqAvailable={state.iqAvailable}
    spectrumAvailable={state.spectrumAvailable}
    connected={state.connected}
    acquisition={state.acquisition}
    continuous={state.continuous}
    acquisitionMode={state.continuous ? state.continuousMode : contextualAcquisitionMode}
    acquisitionBusy={state.busy}
    acquisitionDisabled={state.acquisitionDisabledReason !== undefined}
    acquisitionDisabledReason={state.acquisitionDisabledReason}
    latestSweep={latestSweep}
    onSelect={(next) => kernel.changeWorkspace(next)}
    onMeasurementView={(view) => runtime.measurement.changeMeasurementView(view)}
    onRun={() => void runtime.acquisition.startContinuousFromUi()}
    onSingle={() => void runtime.acquisition.acquireFromUi()}
    onStop={() => void runtime.acquisition.stopContinuousFromUi()}
  />;
}
