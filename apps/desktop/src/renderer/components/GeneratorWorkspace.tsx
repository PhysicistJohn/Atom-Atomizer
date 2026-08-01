import type { CanonicalInstrumentSurface, CanonicalOperationParameterIntent } from '@tinysa/contracts';
import { CanonicalOperationPanel, CanonicalOperationRequired } from './CanonicalOperationPanel.js';

/** This route is a placement for driver-declared source operations. */
export function GeneratorWorkspace({ canonicalSurface, busy, onCanonicalOperation }: {
  canonicalSurface?: CanonicalInstrumentSurface;
  busy: boolean;
  onCanonicalOperation?(operationId: string, parameters: readonly CanonicalOperationParameterIntent[]): void | Promise<unknown>;
}) {
  const hasSourceOperation = canonicalSurface?.operations.some(({ scope }) => scope === 'source' || scope === 'instrument');
  return <div className="generator-layout">
    <section className="generator-controls canonical-source-controls">
      {canonicalSurface && onCanonicalOperation && hasSourceOperation
        ? <CanonicalOperationPanel
            surface={canonicalSurface}
            placement="source"
            busy={busy}
            onExecute={onCanonicalOperation}
          />
        : <CanonicalOperationRequired title="Source controls"/>}
    </section>
  </div>;
}
