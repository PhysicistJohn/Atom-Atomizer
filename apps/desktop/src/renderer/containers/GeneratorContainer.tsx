import { GeneratorWorkspace } from '../components/GeneratorWorkspace.js';
import { generatorOutputState, selectBusy, selectGeneratorCapability, selectSignalLabProfileCapability, shallowEqual, useStore, type AtomizerRendererState } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

const selectGeneratorState = (state: AtomizerRendererState) => ({
  generator: state.generator,
  capability: selectGeneratorCapability(state),
  signalLabProfiles: selectSignalLabProfileCapability(state),
  output: generatorOutputState(state.instrument.session),
  selectedProfile: state.selectedProfile,
  selectedSignalLabChannel: state.selectedSignalLabChannel,
});

export function GeneratorContainer({ runtime }: { runtime: RendererRuntime }) {
  const { features } = runtime;
  const s = useStore(runtime.store, (state) => ({
    ...selectGeneratorState(state),
    busy: selectBusy(state, runtime.kernel.instrumentTransactionOwner.current),
  }), shallowEqual);
  return <GeneratorWorkspace
    config={s.generator} capability={s.capability}
    signalLabProfiles={s.signalLabProfiles} selectedSignalLabProfile={s.selectedProfile} selectedSignalLabChannel={s.selectedSignalLabChannel}
    output={s.output} busy={s.busy} onChange={(config) => runtime.store.set({ generator: config })}
    onApply={() => void features.configureGeneratorFromUi()} onOutput={(enabled) => void features.setOutputFromUi(enabled)}
    onSignalLabProfile={(profileId) => void features.selectSignalLabProfile(profileId)}
    onSignalLabChannel={(channel) => void features.configureSignalLabChannel(channel)}
    onSignalLabCustomWaveform={(standard, selections) => void features.configureSignalLabCustomWaveform(standard, selections)}
  />;
}
