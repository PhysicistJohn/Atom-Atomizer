import { GeneratorWorkspace } from '../components/GeneratorWorkspace.js';
import { selectBusy, shallowEqual, useStore } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

export function GeneratorContainer({ runtime }: { runtime: RendererRuntime }) {
  const s = useStore(runtime.store, (state) => ({
    canonicalSurface: state.canonicalSurface,
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
