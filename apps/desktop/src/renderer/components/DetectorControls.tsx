import { Activity, ScanSearch } from 'lucide-react';
import { robustNoiseFloor, type EnvelopeClassification } from '@tinysa/analysis';
import type {
  DetectedSignal, InstrumentAcquisitionCapability, SignalDetectionConfig, Sweep, ZeroSpanCapture, ZeroSpanConfig,
} from '@tinysa/contracts';
import { formatFrequency, formatLevel } from '../format.js';
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
    <div className="detector-visual"><div className="floor-line"><span style={{ width: sweep ? '68%' : '0%' }}/></div><div><small>LOWER-TAIL CANDIDATE BASELINE</small><strong>{Number.isFinite(floor) ? formatLevel(floor) : '—'}</strong></div></div>
    <fieldset disabled={busy} className="control-section parameter-stack">
      <SelectParameter label="Threshold mode" value={config.threshold.strategy} options={[{ value: 'noise-relative', label: 'Adaptive to candidate baseline' }, { value: 'absolute', label: 'Absolute power level' }]} disabled={busy} controlId="detection.threshold-mode" onValue={(value) => onConfig({ ...config, threshold: value === 'noise-relative' ? { strategy: 'noise-relative', marginDb: 10 } : { strategy: 'absolute', levelDbm: -80 } })}/>
      {config.threshold.strategy === 'noise-relative'
        ? <EditableParameter label="Margin above floor" value={config.threshold.marginDb} displayValue={`+${config.threshold.marginDb} dB`} unit="dB" minimum={3} maximum={30} disabled={busy} controlId="detection.margin" onCommit={(value) => onConfig({ ...config, threshold: { strategy: 'noise-relative', marginDb: Number(value) } })}/>
        : <EditableParameter label="Absolute threshold" value={config.threshold.levelDbm} displayValue={`${config.threshold.levelDbm} dBm`} unit="dBm" minimum={-120} maximum={0} disabled={busy} controlId="detection.absolute-level" onCommit={(value) => onConfig({ ...config, threshold: { strategy: 'absolute', levelDbm: Number(value) } })}/>
      }
      <EditableParameter label="Minimum prominence" value={config.minimumProminenceDb} displayValue={`${config.minimumProminenceDb} dB`} unit="dB" minimum={0} maximum={30} disabled={busy} controlId="detection.prominence" onCommit={(value) => onConfig({ ...config, minimumProminenceDb: Number(value) })}/>
      <SelectParameter label="Minimum bandwidth" value={config.minimumBandwidthHz} options={minimumBandwidthOptions} disabled={busy} controlId="detection.minimum-bandwidth" onValue={(value) => onConfig({ ...config, minimumBandwidthHz: Number(value) })}/>
      <SelectParameter label="Promote after" value={config.minimumConsecutiveSweeps} options={promotionOptions} disabled={busy} controlId="detection.promote" onValue={(value) => onConfig({ ...config, minimumConsecutiveSweeps: Number(value) })}/>
      <SelectParameter label="Release after" value={config.releaseAfterMissedSweeps} options={releaseOptions} disabled={busy} controlId="detection.release" onValue={(value) => onConfig({ ...config, releaseAfterMissedSweeps: Number(value) })}/>
    </fieldset>
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
