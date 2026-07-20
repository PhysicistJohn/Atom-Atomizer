import { useMemo } from 'react';
import { IqWorkspace, type IqCaptureMeta } from '../components/IqWorkspace.js';
import { previewComplexIq } from '../complex-iq.js';
import { selectBusy, selectIqCapability, selectIqCaptureUnavailableReason, useStore } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

export function IqContainer({ runtime }: { runtime: RendererRuntime }) {
  const s = useStore(runtime.store, (state) => state);
  const connected = s.instrument.session !== undefined;
  const busy = selectBusy(s, runtime.kernel.instrumentTransactionOwner.current);
  // The raw capture (a multi-megabyte sample payload) must never become a
  // React prop: React's dev-build performance instrumentation deep-walks
  // props on every commit, which held the main thread ~83% busy during an
  // I/Q Run. Only the bounded preview and scalar metadata cross into JSX.
  const capture = s.iqCapture;
  const { preview, previewError, captureMeta } = useMemo(() => {
    if (!capture) return { preview: undefined, previewError: undefined, captureMeta: undefined };
    const meta: IqCaptureMeta = {
      measurementId: capture.measurementId,
      sequence: capture.sequence,
      centerHz: capture.centerHz,
      sampleCount: capture.sampleCount,
      sampleRateHz: capture.sampleRateHz,
      sampleFormat: capture.sampleFormat,
      qualification: capture.qualification,
    };
    try { return { preview: previewComplexIq(capture), previewError: undefined, captureMeta: meta }; }
    catch (error) {
      return { preview: undefined, previewError: error instanceof Error ? error.message : String(error), captureMeta: meta };
    }
  }, [capture]);

  return <IqWorkspace
    configuration={s.iqConfiguration}
    capability={selectIqCapability(s)}
    preview={preview}
    previewError={previewError}
    captureMeta={captureMeta}
    busy={!connected || busy}
    captureUnavailableReason={selectIqCaptureUnavailableReason(s)}
    onChange={(configuration) => runtime.acquisition.stageIqConfiguration(configuration)}
  />;
}
