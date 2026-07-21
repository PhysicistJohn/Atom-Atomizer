import { useEffect, useMemo, useState } from 'react';
import { IqWorkspace, type IqCaptureMeta } from '../components/IqWorkspace.js';
import { decodeComplexIqChannels, previewComplexIq } from '../complex-iq.js';
import { classifyIqModulation, recoverIqConstellation, type ModulationClassification, type RecoveredConstellation } from '../embedding-classifier-runtime.js';
import { useLatchedModulation } from '../latched-modulation.js';
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
  // the readout doesn't flicker during a Run. Per-capture results feed a rolling
  // latch (see below) so the displayed class is the dominant one over ~the last
  // second, not a jittery frame-by-frame identification.
  const [rawModulation, setRawModulation] = useState<ModulationClassification | undefined>(undefined);
  // Blind-recovered symbol constellation (equalize + carrier lock), computed
  // from the same decoded prefix. Shown when it resolves distinct symbols.
  const [recovered, setRecovered] = useState<RecoveredConstellation | undefined>(undefined);
  const captureId = capture?.measurementId;
  const captureBandwidthHz = s.iqConfiguration.bandwidthHz;
  useEffect(() => {
    if (!capture) { setRawModulation(undefined); setRecovered(undefined); return; }
    let cancelled = false;
    try {
      // Recovery needs enough symbols to populate a dense high-order grid (256-QAM
      // wants ~2k symbols); at ~8 sps that is a 16k-sample prefix. The classifier
      // keeps its usual 4k-sample view (a zero-copy prefix) so its behavior is
      // unchanged. estimateSps caps its own analysis window, so the longer decode
      // only costs a linear CMA pass, not a quadratic periodogram.
      const { re, im } = decodeComplexIqChannels(capture, 16_384);
      try { setRecovered(recoverIqConstellation(re, im)); } catch { /* keep the last recovery */ }
      classifyIqModulation(re.subarray(0, 4_096), im.subarray(0, 4_096), captureBandwidthHz)
        .then((result) => { if (!cancelled) setRawModulation(result); })
        .catch(() => { /* keep the last result through a transient decode/inference error */ });
    } catch { /* keep the last result */ }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureId]);

  // Latch the readout to the dominant class over a rolling ~1s window so a Run
  // shows a stable identification instead of flickering between frames.
  const modulation = useLatchedModulation(rawModulation, capture !== undefined);

  return <IqWorkspace
    configuration={s.iqConfiguration}
    capability={selectIqCapability(s)}
    preview={preview}
    previewError={previewError}
    captureMeta={captureMeta}
    modulation={modulation}
    recovered={recovered}
    busy={!connected || busy}
    captureUnavailableReason={selectIqCaptureUnavailableReason(s)}
    onChange={(configuration) => runtime.acquisition.stageIqConfiguration(configuration)}
  />;
}
