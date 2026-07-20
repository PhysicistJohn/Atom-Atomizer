import { useEffect, useMemo, useState } from 'react';
import { IqWorkspace, type IqCaptureMeta } from '../components/IqWorkspace.js';
import { decodeComplexIqChannels, previewComplexIq } from '../complex-iq.js';
import { classifyIqModulation, type ModulationClassification } from '../embedding-classifier-runtime.js';
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

  // Live modulation identification: auto-classify every streamed capture so the
  // I/Q view reports what modulation is present in real time (this is where the
  // complex-I/Q stream is actually live — the Detect panel classifies whatever
  // capture is current). Decoding + the zero-dependency embedding forward pass
  // run off the render path, keyed on capture identity; only the compact result
  // crosses into JSX. The last good result is held across a transient failure so
  // the readout doesn't flicker during a Run.
  const [modulation, setModulation] = useState<ModulationClassification | undefined>(undefined);
  const captureId = capture?.measurementId;
  const captureBandwidthHz = s.iqConfiguration.bandwidthHz;
  useEffect(() => {
    if (!capture) { setModulation(undefined); return; }
    let cancelled = false;
    try {
      const { re, im } = decodeComplexIqChannels(capture);
      classifyIqModulation(re, im, captureBandwidthHz)
        .then((result) => { if (!cancelled) setModulation(result); })
        .catch(() => { /* keep the last result through a transient decode/inference error */ });
    } catch { /* keep the last result */ }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureId]);

  return <IqWorkspace
    configuration={s.iqConfiguration}
    capability={selectIqCapability(s)}
    preview={preview}
    previewError={previewError}
    captureMeta={captureMeta}
    modulation={modulation}
    busy={!connected || busy}
    captureUnavailableReason={selectIqCaptureUnavailableReason(s)}
    onChange={(configuration) => runtime.acquisition.stageIqConfiguration(configuration)}
  />;
}
