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

  // Classify the modulation off the render path, once per capture. Decoding the
  // bounded prefix + async embedding inference must never touch React props (the
  // raw payload is multi-megabyte), so it lives in an effect keyed on the
  // capture identity and only its compact result crosses into JSX.
  const [modulation, setModulation] = useState<ModulationClassification | undefined>(undefined);
  const [modulationPending, setModulationPending] = useState(false);
  const captureId = capture?.measurementId;
  const captureBandwidthHz = s.iqConfiguration.bandwidthHz;
  useEffect(() => {
    if (!capture) { setModulation(undefined); setModulationPending(false); return; }
    let cancelled = false;
    setModulationPending(true);
    try {
      const { re, im } = decodeComplexIqChannels(capture);
      classifyIqModulation(re, im, captureBandwidthHz)
        .then((result) => { if (!cancelled) { setModulation(result); setModulationPending(false); } })
        .catch(() => { if (!cancelled) { setModulation(undefined); setModulationPending(false); } });
    } catch { if (!cancelled) { setModulation(undefined); setModulationPending(false); } }
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
    modulationPending={modulationPending}
    busy={!connected || busy}
    captureUnavailableReason={selectIqCaptureUnavailableReason(s)}
    onChange={(configuration) => runtime.acquisition.stageIqConfiguration(configuration)}
  />;
}
