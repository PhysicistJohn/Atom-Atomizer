import { GeneratorWorkspace } from '../components/GeneratorWorkspace.js';
import { generatorOutputState, selectBusy, selectGeneratorCapability, selectSignalLabProfileCapability, useStore } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

export function GeneratorContainer({ runtime }: { runtime: RendererRuntime }) {
  const s = useStore(runtime.store, (state) => state);
  const { features } = runtime;
  const busy = selectBusy(s, runtime.kernel.instrumentTransactionOwner.current);
  return <GeneratorWorkspace
    config={s.generator} capability={selectGeneratorCapability(s)}
    signalLabProfiles={selectSignalLabProfileCapability(s)} selectedSignalLabProfile={s.selectedProfile} selectedSignalLabChannel={s.selectedSignalLabChannel}
    output={generatorOutputState(s.instrument.session)} busy={busy} onChange={(config) => runtime.store.set({ generator: config })}
    onApply={() => void features.configureGeneratorFromUi()} onOutput={(enabled) => void features.setOutputFromUi(enabled)}
    onSignalLabProfile={(profileId) => void features.selectSignalLabProfile(profileId)}
    onSignalLabChannel={(channel) => void features.configureSignalLabChannel(channel)}
    onSignalLabCustomWaveform={(standard, selections) => void features.configureSignalLabCustomWaveform(standard, selections)}
  />;
}
