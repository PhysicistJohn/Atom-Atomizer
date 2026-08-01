import { GeneratorWorkspace } from '../components/GeneratorWorkspace.js';
import { selectBusy, shallowEqual, useStore, type AtomizerRendererState } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

const selectGeneratorState = (state: AtomizerRendererState) => ({
  canonicalSurface: state.canonicalSurface,
});

export function GeneratorContainer({ runtime }: { runtime: RendererRuntime }) {
  const s = useStore(runtime.store, (state) => ({
    ...selectGeneratorState(state),
    busy: selectBusy(state, runtime.kernel.instrumentTransactionOwner.current),
  }), shallowEqual);
  return <GeneratorWorkspace
    canonicalSurface={s.canonicalSurface}
    busy={s.busy}
    onCanonicalOperation={s.canonicalSurface
      ? (operationId, parameters) => runtime.events.executeCanonicalOperation(s.canonicalSurface!, operationId, parameters)
      : undefined}
  />;
}
