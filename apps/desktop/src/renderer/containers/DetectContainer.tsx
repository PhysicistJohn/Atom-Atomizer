import { useMemo } from 'react';
import { DetectWorkspace } from '../components/DetectWorkspace.js';
import { selectBusy, selectDetectedPowerCapability, shallowEqual, useStore, type AtomizerRendererState } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

const selectDetectState = (state: AtomizerRendererState) => ({
  connected: state.instrument.session !== undefined,
  detectedPowerCapability: selectDetectedPowerCapability(state),
  detections: state.detections,
  classification: state.classification,
  continuous: state.continuous,
  sweep: state.sweep,
  detectionConfig: state.detectionConfig,
  zeroConfig: state.zeroConfig,
  zeroCapture: state.zeroCapture,
  envelope: state.envelope,
  detectedPowerTargetStagingFailure: state.detectedPowerTargetStagingFailure,
});

/**
 * Read-only projection of the application-global detector and classification
 * pipeline. Mounting or unmounting this workspace never starts acquisition,
 * selects an evidence flavor, or creates classifier work.
 */
export function DetectContainer({ runtime }: { runtime: RendererRuntime }) {
  const { acquisition, kernel } = runtime;
  const s = useStore(runtime.store, (state) => ({
    ...selectDetectState(state),
    busy: selectBusy(state, kernel.instrumentTransactionOwner.current),
  }), shallowEqual);
  const target = useMemo(() => s.detections
    .filter((detection) => detection.state !== 'released')
    .reduce<(typeof s.detections)[number] | undefined>((strongest, detection) =>
      strongest && strongest.peakDbm >= detection.peakDbm ? strongest : detection, undefined), [s.detections]);

  return <DetectWorkspace
    modulation={s.classification.result}
    pending={s.classification.pending}
    source={s.classification.source}
    live={s.continuous}
    sampleCount={s.classification.sampleCount}
    sweep={s.sweep}
    detectionConfig={s.detectionConfig}
    detectorBusy={s.busy}
    onDetectionConfig={(config) => kernel.applyDetectionConfiguration(config)}
    zeroConfig={s.zeroConfig}
    zeroCapture={s.zeroCapture}
    envelope={s.envelope}
    detectedPowerCapability={s.detectedPowerCapability}
    captureUnavailableReason={s.detectedPowerTargetStagingFailure}
    captureTarget={target}
    busy={!s.connected || s.busy}
    onAcquireZero={() => void acquisition.acquireZeroSpanFromUi()}
  />;
}
