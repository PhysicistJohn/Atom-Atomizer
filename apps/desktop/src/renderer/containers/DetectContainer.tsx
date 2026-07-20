import { useEffect, useState } from 'react';
import { DetectWorkspace } from '../components/DetectWorkspace.js';
import { decodeComplexIqChannels } from '../complex-iq.js';
import { classifyIqModulation, classifyScalarSweep, type ModulationClassification } from '../embedding-classifier-runtime.js';
import { selectBusy, selectDetectedPowerCapability, selectIqCapability, useStore } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

/**
 * The Detect panel: the embedding modulation classifier, in whichever flavor the
 * connected instrument supports, plus the shared signal-detector settings and
 * detected-power envelope capture. Complex-I/Q instruments (SDR / SignalLab) get
 * the I/Q flavor off `iqCapture`; scalar analyzers (tinySA) get the magnitude
 * flavor off the swept spectrum + the strongest detected signal. Inference is a
 * dynamic-imported, zero-dependency forward pass, run off the render path in an
 * effect keyed on the input identity so the multi-megabyte payloads never become
 * React props.
 */
export function DetectContainer({ runtime }: { runtime: RendererRuntime }) {
  const s = useStore(runtime.store, (state) => state);
  const { acquisition, kernel } = runtime;
  const connected = s.instrument.session !== undefined;
  const busy = selectBusy(s, kernel.instrumentTransactionOwner.current);
  const iqCapable = selectIqCapability(s) !== undefined;
  const capture = s.iqCapture;
  const sweep = s.sweep;
  const captureBandwidthHz = s.iqConfiguration.bandwidthHz;

  // The strongest live detection is both the magnitude classifier's target and
  // the detected-power envelope-capture target (the capture itself auto-resolves
  // the visible target; this drives the display + the classify input).
  const target = s.detections
    .filter((d) => d.state !== 'released')
    .reduce<(typeof s.detections)[number] | undefined>((best, d) => (best && best.peakDbm >= d.peakDbm ? best : d), undefined);

  const source: 'iq' | 'scalar' | 'none' =
    iqCapable && capture ? 'iq' : !iqCapable && sweep && target ? 'scalar' : 'none';

  // Re-classify only when the actual classification input changes — the I/Q
  // flavor depends solely on the capture, so it must not re-run on every sweep
  // during a spectrum Run (that just re-classifies the same frozen capture).
  const classifyKey = source === 'iq'
    ? `iq:${capture?.measurementId}`
    : source === 'scalar'
      ? `scalar:${sweep?.id}:${target?.id}`
      : 'none';

  const [modulation, setModulation] = useState<ModulationClassification | undefined>(undefined);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const done = (result?: ModulationClassification) => {
      if (!cancelled) { setModulation(result); setPending(false); }
    };
    if (source === 'iq' && capture) {
      setPending(true);
      try {
        const { re, im } = decodeComplexIqChannels(capture);
        classifyIqModulation(re, im, captureBandwidthHz).then(done).catch(() => done(undefined));
      } catch { done(undefined); }
    } else if (source === 'scalar' && sweep && target) {
      setPending(true);
      classifyScalarSweep(sweep.powerDbm, sweep.frequencyHz, target.peakHz, target.bandwidthHz)
        .then(done)
        .catch(() => done(undefined));
    } else {
      setModulation(undefined);
      setPending(false);
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classifyKey]);

  return <DetectWorkspace
    modulation={modulation}
    pending={pending}
    source={source}
    sweep={sweep}
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
