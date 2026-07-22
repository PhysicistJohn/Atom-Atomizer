import { DetectWorkspace } from '../components/DetectWorkspace.js';
import { selectBusy, selectDetectedPowerCapability, useStore } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

/**
 * Read-only projection of the application-global detector and classification
 * pipeline. Mounting or unmounting this workspace never starts acquisition,
 * selects an evidence flavor, or creates classifier work.
 */
export function DetectContainer({ runtime }: { runtime: RendererRuntime }) {
  const s = useStore(runtime.store, (state) => state);
  const { acquisition, kernel } = runtime;
  const connected = s.instrument.session !== undefined;
  const busy = selectBusy(s, kernel.instrumentTransactionOwner.current);
  const target = s.detections
    .filter((detection) => detection.state !== 'released')
    .reduce<(typeof s.detections)[number] | undefined>((strongest, detection) =>
      strongest && strongest.peakDbm >= detection.peakDbm ? strongest : detection, undefined);

  return <DetectWorkspace
    modulation={s.classification.result}
    pending={s.classification.pending}
    source={s.classification.source}
    live={s.continuous}
    evidenceLooks={s.classification.evidenceLooks}
    sweep={s.sweep}
    detectionConfig={s.detectionConfig}
    detectorBusy={busy}
    onDetectionConfig={(config) => kernel.applyDetectionConfiguration(config)}
    zeroConfig={s.zeroConfig}
    zeroCapture={s.zeroCapture}
    envelope={s.envelope}
    detectedPowerCapability={selectDetectedPowerCapability(s)}
    captureUnavailableReason={s.detectedPowerTargetStagingFailure}
    captureTarget={target}
    busy={!connected || busy}
    onAcquireZero={() => void acquisition.acquireZeroSpanFromUi()}
  />;
}
