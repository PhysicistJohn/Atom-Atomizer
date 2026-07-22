import { useEffect, useMemo, useRef, useState } from 'react';
import { IqWorkspace, type IqCaptureMeta } from '../components/IqWorkspace.js';
import { previewComplexIq } from '../complex-iq.js';
import type { RecoveredConstellation } from '../embedding-classifier-runtime.js';
import { selectBusy, selectIqCapability, selectIqCaptureUnavailableReason, shallowEqual, useStore, type AtomizerRendererState } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';
import { IqRecoveryController } from '../controllers/iq-recovery.js';

const selectIqState = (state: AtomizerRendererState) => ({
  connected: state.instrument.session !== undefined,
  capability: selectIqCapability(state),
  captureUnavailableReason: selectIqCaptureUnavailableReason(state),
  iqCapture: state.iqCapture,
  iqConfiguration: state.iqConfiguration,
  classification: state.classification,
});

export function IqContainer({ runtime }: { runtime: RendererRuntime }) {
  const s = useStore(runtime.store, (state) => ({
    ...selectIqState(state),
    busy: selectBusy(state, runtime.kernel.instrumentTransactionOwner.current),
  }), shallowEqual);
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

  // Blind-recovered symbol constellation (equalize + carrier lock), computed
  // in a dedicated latest-wins worker only for this visualization.
  // Classification itself is application-global and continues while this
  // workspace is unmounted.
  const [recovered, setRecovered] = useState<RecoveredConstellation | undefined>(undefined);
  const recoveryRef = useRef<IqRecoveryController | undefined>(undefined);
  useEffect(() => {
    const controller = new IqRecoveryController(setRecovered);
    recoveryRef.current = controller;
    return () => {
      if (recoveryRef.current === controller) recoveryRef.current = undefined;
      controller.dispose();
    };
  }, []);
  useEffect(() => {
    if (capture) recoveryRef.current?.submit(capture);
    else recoveryRef.current?.reset();
  }, [capture]);
  const modulation = s.classification.result?.flavor === 'iq'
    ? s.classification.result
    : undefined;

  return <IqWorkspace
    configuration={s.iqConfiguration}
    capability={s.capability}
    preview={preview}
    previewError={previewError}
    captureMeta={captureMeta}
    modulation={modulation}
    recovered={recovered}
    busy={!s.connected || s.busy}
    captureUnavailableReason={s.captureUnavailableReason}
    onChange={(configuration) => runtime.acquisition.stageIqConfiguration(configuration)}
  />;
}
