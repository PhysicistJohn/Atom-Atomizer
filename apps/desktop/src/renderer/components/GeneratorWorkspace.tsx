import type { CanonicalInstrumentSurface, CanonicalOperationParameterIntent } from '@tinysa/contracts';
import { CanonicalOperationPanel } from './CanonicalOperationPanel.js';
import { CanonicalOperationRequired } from './IqWorkspace.js';

/** This route is a placement for driver-declared source operations. */
export function GeneratorWorkspace({ canonicalSurface, busy, onCanonicalOperation }: {
  canonicalSurface?: CanonicalInstrumentSurface;
  busy: boolean;
  onCanonicalOperation?(operationId: string, parameters: readonly CanonicalOperationParameterIntent[]): void | Promise<unknown>;
}) {
  const sourceOperationIds = canonicalSurface?.operations
    .filter((operation) => operation.scope === 'source' || operation.scope === 'instrument')
    .map((operation) => operation.id);
  return <div className="generator-layout">
    <section className="generator-controls canonical-source-controls">
      {canonicalSurface && onCanonicalOperation && sourceOperationIds?.length
        ? <CanonicalOperationPanel
            surface={canonicalSurface}
            operationIds={sourceOperationIds}
            busy={busy}
            onExecute={onCanonicalOperation}
          />
        : <CanonicalOperationRequired title="Source controls"/>}
    </section>
  </div>;
}
