import { Activity, RadioTower, ScanSearch } from 'lucide-react';
import { robustNoiseFloor, type EnvelopeClassification } from '@tinysa/analysis';
import type {
  DetectedSignal, InstrumentAcquisitionCapability, SignalDetectionConfig, Sweep, ZeroSpanCapture, ZeroSpanConfig,
} from '@tinysa/contracts';
import { formatFrequency, formatPowerLevel } from '../format.js';
import { EditableParameter, SelectParameter } from './ParameterRow.js';

export type DetectedPowerCapability = Extract<InstrumentAcquisitionCapability, { kind: 'detected-power-timeseries' }>;

/**
 * The signal-detector settings and the detected-power (zero-span) envelope
 * capture control. These are shared spectrum/measurement affordances — the
 * detector feeds both the spectrum overlay and the magnitude classifier's
 * target selection — that used to live in the retired classification panel and
 * now live alongside the embedding classifier in the Detect panel.
 */

function titleCase(value: string): string {
  return value.replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function envelopeLabel(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return 'Unknown';
  return titleCase(value.replace(/^(observable|signal-lab(-family)?):/, ''));
}
function formatCaptureWindow(seconds: number): string {
  return seconds < 1 ? `${Number((seconds * 1_000).toPrecision(12))} ms` : `${Number(seconds.toPrecision(12))} s`;
}
function includeCurrentOption(
  options: readonly { value: number; label: string }[],
  value: number,
  label: string,
): readonly { value: number; label: string }[] {
  return options.some((option) => option.value === value) ? options : [{ value, label }, ...options];
}

export function DetectionSettings({ sweep, config, busy, onConfig }: {
  sweep?: Sweep;
  config: SignalDetectionConfig;
  busy: boolean;
  onConfig(config: SignalDetectionConfig): void;
}) {
  const floor = sweep ? robustNoiseFloor(sweep.powerDbm) : Number.NaN;
  const relativePower = sweep?.powerReference === 'uncalibrated-dbfs-relative';
  const minimumBandwidthOptions = includeCurrentOption(
    [{ value: 0, label: 'Any width' }, { value: 10_000, label: '10 kHz' }, { value: 100_000, label: '100 kHz' }, { value: 1_000_000, label: '1 MHz' }],
    config.minimumBandwidthHz,
    `${formatFrequency(config.minimumBandwidthHz)} · custom`,
  );
  const promotionOptions = includeCurrentOption(
    [1, 2, 3, 5].map((value) => ({ value, label: `${value} sweep${value === 1 ? '' : 's'}` })),
    config.minimumConsecutiveSweeps,
    `${config.minimumConsecutiveSweeps} sweeps · custom`,
  );
  const releaseOptions = includeCurrentOption(
    [{ value: 0, label: 'First missed sweep' }, { value: 1, label: '1 missed sweep' }, { value: 2, label: '2 missed sweeps' }, { value: 5, label: '5 missed sweeps' }],
    config.releaseAfterMissedSweeps,
    `${config.releaseAfterMissedSweeps} missed sweeps · custom`,
  );
  return <section className="detection-settings-panel">
    <div className="panel-header"><div><ScanSearch size={14}/>Detection</div><span>{busy ? 'UPDATING' : 'FULL VISIBLE SPAN'}</span></div>
    <div className="detector-visual"><div className="floor-line"><span style={{ width: sweep ? '68%' : '0%' }}/></div><div><small>LOWER-TAIL CANDIDATE BASELINE</small><strong>{Number.isFinite(floor) ? formatPowerLevel(floor, sweep?.powerReference) : '—'}</strong></div></div>
    <fieldset disabled={busy} className="control-section parameter-stack">
      <SelectParameter label="Threshold mode" value={config.threshold.strategy} options={relativePower
        ? [{ value: 'noise-relative', label: 'Adaptive to candidate baseline' }]
        : [{ value: 'noise-relative', label: 'Adaptive to candidate baseline' }, { value: 'absolute', label: 'Absolute power level' }]} disabled={busy} controlId="detection.threshold-mode" onValue={(value) => onConfig({ ...config, threshold: value === 'noise-relative' ? { strategy: 'noise-relative', marginDb: 10 } : { strategy: 'absolute', levelDbm: -80 } })}/>
      {config.threshold.strategy === 'noise-relative'
        ? <EditableParameter label="Margin above floor" value={config.threshold.marginDb} displayValue={`+${config.threshold.marginDb} dB`} unit="dB" minimum={3} maximum={30} disabled={busy} controlId="detection.margin" onCommit={(value) => onConfig({ ...config, threshold: { strategy: 'noise-relative', marginDb: Number(value) } })}/>
        : <EditableParameter label="Absolute threshold" value={config.threshold.levelDbm} displayValue={relativePower ? 'Unavailable · calibrated dBm required' : `${config.threshold.levelDbm} dBm`} unit="dBm" minimum={-120} maximum={0} disabled={busy || relativePower} controlId="detection.absolute-level" onCommit={(value) => onConfig({ ...config, threshold: { strategy: 'absolute', levelDbm: Number(value) } })}/>
      }
      <EditableParameter label="Minimum prominence" value={config.minimumProminenceDb} displayValue={`${config.minimumProminenceDb} dB`} unit="dB" minimum={0} maximum={30} disabled={busy} controlId="detection.prominence" onCommit={(value) => onConfig({ ...config, minimumProminenceDb: Number(value) })}/>
      <SelectParameter label="Minimum bandwidth" value={config.minimumBandwidthHz} options={minimumBandwidthOptions} disabled={busy} controlId="detection.minimum-bandwidth" onValue={(value) => onConfig({ ...config, minimumBandwidthHz: Number(value) })}/>
      <SelectParameter label="Promote after" value={config.minimumConsecutiveSweeps} options={promotionOptions} disabled={busy} controlId="detection.promote" onValue={(value) => onConfig({ ...config, minimumConsecutiveSweeps: Number(value) })}/>
      <SelectParameter label="Release after" value={config.releaseAfterMissedSweeps} options={releaseOptions} disabled={busy} controlId="detection.release" onValue={(value) => onConfig({ ...config, releaseAfterMissedSweeps: Number(value) })}/>
    </fieldset>
    {relativePower && <p className="detect-note" role="status">Absolute dBm detection is unavailable for this uncalibrated dBFS-relative FFT. Adaptive margin and prominence remain usable as dB ratios.</p>}
  </section>;
}

/** Rows rendered at once. A display cap only -- never a count. */
const RENDERED_SIGNAL_REGION_LIMIT = 8;

/** Visible projection of the frequency-local detector/tracker. The detector
 * has always run globally; this makes its candidate and promoted rows visible
 * without conflating them with modulation-classifier output. */
export function SignalDetectionResults({ sweep, detections, config }: {
  sweep?: Sweep;
  detections: readonly DetectedSignal[];
  config: SignalDetectionConfig;
}) {
  const admitted = detections
    .filter((signal) => signal.state !== 'released'
      && signal.missedSweeps === 0
      && Number.isFinite(signal.peakHz)
      && Number.isFinite(signal.peakDbm)
      && Number.isFinite(signal.bandwidthHz)
      && Number.isFinite(signal.prominenceDb))
    .sort((left, right) => Number(right.state === 'active') - Number(left.state === 'active')
      || right.peakDbm - left.peakDbm);
  // Count the whole admitted set, then cap only what is rendered. Counting
  // after the slice reported the cap itself as the tracked total, which
  // silently disagreed with the spectrum metric strip.
  const activeCount = admitted.filter((signal) => signal.state === 'active').length;
  const candidateCount = admitted.length - activeCount;
  const current = admitted.slice(0, RENDERED_SIGNAL_REGION_LIMIT);
  const hiddenCount = admitted.length - current.length;
  return <section className="detection-results-panel" aria-label="Detected signal regions">
    <header><span><RadioTower size={14}/><strong>Signal regions</strong></span><em aria-live="polite" aria-atomic="true">{activeCount} tracked · {candidateCount} candidate{candidateCount === 1 ? '' : 's'}{hiddenCount > 0 ? ` · showing ${current.length}` : ''}</em></header>
    {current.length === 0
      ? <div className="detection-results-empty"><strong>{sweep ? 'No regions above threshold' : 'No sweep to detect'}</strong><span>{sweep ? 'Adjust the relative margin or acquire another frame.' : 'Use Single for one candidate look, or Run for persistent tracking.'}</span></div>
      : <div className="detection-result-list">{current.map((signal) => {
        const promoted = signal.state === 'active';
        const progress = Math.min(signal.persistenceSweeps, config.minimumConsecutiveSweeps);
        return <article key={signal.id} className={promoted ? 'active' : 'candidate'}>
          <div><span className="detection-state">{promoted ? 'TRACKED' : 'CANDIDATE'}</span><strong>{formatFrequency(signal.peakHz)}</strong><em>{formatPowerLevel(signal.peakDbm, sweep?.powerReference)}</em></div>
          <div><span>{formatFrequency(signal.bandwidthHz)} wide</span><span>{signal.prominenceDb.toFixed(1)} dB prominence</span><strong>{promoted ? `${signal.persistenceSweeps} sweeps tracked` : `${progress} / ${config.minimumConsecutiveSweeps} sweeps to track`}</strong></div>
        </article>;
      })}</div>}
    {candidateCount > 0 && <p>Single exposes a candidate immediately. Repeat Single or use Run to satisfy the configured persistence gate.</p>}
  </section>;
}

export function CaptureEvidenceStrip({ configuration, capture, envelope, capability, unavailableReason, target, busy, onAcquire }: {
  configuration: ZeroSpanConfig;
  capture?: ZeroSpanCapture;
  envelope?: EnvelopeClassification;
  capability?: DetectedPowerCapability;
  unavailableReason?: string;
  target?: DetectedSignal;
  busy: boolean;
  onAcquire(): void;
}) {
  const ready = capability !== undefined && target !== undefined && unavailableReason === undefined;
  const agileFixedTune = target?.associationMode === 'frequency-agile-2g4-activity';
  return <section className="classification-capture-strip" aria-label="Detected-power envelope capture">
    <div className="capture-strip-state"><span className="capture-strip-icon"><Activity size={14}/></span><span><small>DETECTED POWER · NOT I/Q</small><strong>{capture ? `${capture.powerDbm.length} samples captured` : ready ? 'Ready to capture' : unavailableReason ? 'Target tune unavailable' : capability ? 'Awaiting a detected signal' : 'Capture unavailable'}</strong><em>{unavailableReason ?? `${configuration.points} samples · ${formatCaptureWindow(configuration.sweepTimeSeconds)}`}</em></span></div>
    <div><small>CAPTURE TARGET</small><strong>{target ? formatFrequency(target.peakHz) : 'No active target'}</strong><em>{agileFixedTune ? `Fixed tune from latest physical member at ${formatFrequency(target.peakHz)}` : target ? `Centers capture on the strongest detected signal` : 'Auto selects prominent excess power across the visible spectrum'}</em></div>
    <div><small>ENVELOPE CHARACTER</small><strong>{envelope ? envelopeLabel(envelope.label) : agileFixedTune ? 'Fixed-tune trace only' : 'No envelope evidence'}</strong><em>{envelope ? `${Math.round(envelope.confidence * 100)}% · ${envelope.features.transitionCount} transitions` : capture ? 'Envelope pending' : 'Optional detected-power evidence'}</em></div>
    <div className="capture-strip-action"><button className="secondary" disabled={busy || !ready} onClick={onAcquire} data-agent-control="classification.capture-envelope">{capture ? 'Recapture envelope' : 'Capture envelope'}</button></div>
  </section>;
}
