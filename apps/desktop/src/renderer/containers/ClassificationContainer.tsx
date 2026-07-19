import { useMemo } from 'react';
import { readMarkers } from '@tinysa/analysis';
import { ClassificationWorkspace } from '../components/ClassificationWorkspace.js';
import { resolveVisibleClassificationTargetSelection } from '../classification-target-selection.js';
import { errorMessage } from '../controllers/kernel.js';
import { selectBusy, selectDetectedPowerCapability, useStore } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

export function ClassificationContainer({ runtime }: { runtime: RendererRuntime }) {
  const s = useStore(runtime.store, (state) => state);
  const { classification, acquisition, kernel } = runtime;
  const connected = s.instrument.session !== undefined;
  const busy = selectBusy(s, kernel.instrumentTransactionOwner.current);
  const classificationTargetSelection = useMemo(
    () => resolveVisibleClassificationTargetSelection(
      s.detections,
      s.sweep,
      s.explicitClassificationId,
    ),
    [s.detections, s.explicitClassificationId, s.sweep],
  );
  const markerReadings = useMemo(
    () => readMarkers(s.markers, s.traceFrames, s.detections),
    [s.markers, s.traceFrames, s.detections],
  );
  return <ClassificationWorkspace
    sweep={s.sweep}
    traces={s.traceFrames} firmwareTraces={s.firmwareTraceFrames} visibleFirmwareTraceIds={s.visibleFirmwareTraceIds}
    activeTraceId={s.activeTraceId} markers={markerReadings} activeMarkerId={s.activeMarkerId}
    display={s.displayConfiguration} onMarkerPlace={(frequencyHz) => runtime.measurement.placeActiveMarker(frequencyHz)}
    detections={s.detections} classifications={s.classifications}
    modelAvailability={s.classifierAvailability}
    selectedId={kernel.zeroCaptureReceiptRef.current?.selection.projectedRepresentativeId
      ?? classificationTargetSelection.detectionId}
    selectionOrigin={classificationTargetSelection.origin}
    onSelectedId={(detectionId) => {
      try { classification.selectClassificationCandidate(detectionId); }
      catch (value) {
        const failure = errorMessage(value);
        runtime.store.set({
          detectedPowerTargetStagingFailure: failure,
          notice: `Detected-power target tune unavailable: ${failure}`,
        });
      }
    }}
    onAutoSelect={() => { void classification.selectAutomaticClassificationCandidate(); }}
    detectionConfig={s.detectionConfig} detectorBusy={busy} onDetectionConfig={(config) => classification.applyDetectionConfiguration(config)}
    zeroConfig={s.zeroConfig} zeroCapture={s.zeroCapture} envelope={s.envelope}
    capability={selectDetectedPowerCapability(s)}
    captureUnavailableReason={s.detectedPowerTargetStagingFailure}
    busy={!connected || busy}
    onAcquireZero={() => void acquisition.acquireZeroSpanFromUi()}
  />;
}
