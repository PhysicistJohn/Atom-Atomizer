import { Info } from 'lucide-react';
import type { AnalyzerConfig, AnalyzerConfigPatch, InstrumentAcquisitionCapability } from '@tinysa/contracts';
import { formatFrequency, parseFrequency } from '../format.js';
import { EditableParameter, SelectParameter } from './ParameterRow.js';
import { AutomaticNumericParameter, TriggerParameters, sentenceCase } from './ReceiverControlRows.js';

type SpectrumCapability = Extract<InstrumentAcquisitionCapability, { kind: 'swept-spectrum' }>;

export function AnalyzerInspector({ config, capability, disabled, onChange }: {
  config: AnalyzerConfig;
  capability?: SpectrumCapability;
  disabled: boolean;
  onChange(patch: AnalyzerConfigPatch): void;
}) {
  const updateFrequency = (field: 'startHz' | 'stopHz', text: string) => {
    const next = { ...config, [field]: parseFrequency(text) };
    if (next.stopHz <= next.startHz) throw new Error('Stop frequency must be greater than start frequency');
    onChange({ [field]: next[field] });
  };
  // Classic analyzer retune: center moves the window at constant span; span
  // zooms about the current center. Either edit shifts the window inward when
  // it would cross a capability edge, so moving around never errors out.
  const retune = (centerHz: number, spanHz: number) => {
    if (!capability) return;
    const { min, max } = capability.frequencyHz;
    const boundedSpan = Math.max(2, Math.min(Math.round(spanHz), max - min));
    let startHz = Math.round(centerHz - boundedSpan / 2);
    let stopHz = startHz + boundedSpan;
    if (startHz < min) { startHz = min; stopHz = min + boundedSpan; }
    if (stopHz > max) { stopHz = max; startHz = max - boundedSpan; }
    onChange({ startHz, stopHz });
  };
  const centerHz = (config.startHz + config.stopHz) / 2;
  const spanHz = config.stopHz - config.startHz;
  const unavailable = disabled || !capability;
  const permits = (startHz: number, stopHz: number) => capability !== undefined
    && rangePermits(startHz, capability.frequencyHz)
    && rangePermits(stopHz, capability.frequencyHz);
  const receiverControls = capability?.controls.model === 'receiver' ? capability.controls : undefined;

  return <aside className="inspector inspector-setup">
    <fieldset disabled={unavailable} className="acquisition-dock parameter-stack">
      <EditableParameter label="Start frequency" value={config.startHz} displayValue={formatFrequency(config.startHz)} unit="Hz" minimum={capability?.frequencyHz.min ?? 0} maximum={Math.min(config.stopHz - 1, capability?.frequencyHz.max ?? 0)} step={capability?.frequencyHz.step ?? 1} controlId="analyzer.start" disabled={unavailable} onCommit={(value) => updateFrequency('startHz', value)}/>
      <EditableParameter label="Stop frequency" value={config.stopHz} displayValue={formatFrequency(config.stopHz)} unit="Hz" minimum={Math.max(config.startHz + 1, capability?.frequencyHz.min ?? 0)} maximum={capability?.frequencyHz.max ?? 0} step={capability?.frequencyHz.step ?? 1} controlId="analyzer.stop" disabled={unavailable} onCommit={(value) => updateFrequency('stopHz', value)}/>
      <EditableParameter label="Center frequency" value={centerHz} displayValue={formatFrequency(centerHz)} unit="Hz" minimum={capability?.frequencyHz.min ?? 0} maximum={capability?.frequencyHz.max ?? 0} step={capability?.frequencyHz.step ?? 1} controlId="analyzer.center" disabled={unavailable} onCommit={(value) => retune(parseFrequency(value), spanHz)}/>
      <EditableParameter label="Span" value={spanHz} displayValue={formatFrequency(spanHz)} unit="Hz" minimum={2} maximum={(capability?.frequencyHz.max ?? 0) - (capability?.frequencyHz.min ?? 0)} step={capability?.frequencyHz.step ?? 1} controlId="analyzer.span" disabled={unavailable} onCommit={(value) => retune(centerHz, parseFrequency(value))}/>
      <EditableParameter label="Sweep points" value={config.points} displayValue={`${config.points} points`} minimum={capability?.points.min ?? 2} maximum={capability?.points.max ?? 2} step={capability?.points.step ?? 1} disabled={unavailable} controlId="analyzer.points" onCommit={(value) => onChange({ points: Number(value) })}/>
      <div className="quick-ranges" aria-label="Frequency presets"><span>Presets</span><div>
        <button data-agent-control="analyzer.preset.fm" type="button" disabled={!permits(88e6, 108e6)} onClick={() => onChange({ startHz: 88e6, stopHz: 108e6 })}>FM band</button>
        <button data-agent-control="analyzer.preset.2g4" type="button" disabled={!permits(2.4e9, 2.5e9)} onClick={() => onChange({ startHz: 2.4e9, stopHz: 2.5e9 })}>2.4 GHz</button>
        <button data-agent-control="analyzer.preset.5g" type="button" disabled={!permits(5.15e9, 5.85e9)} onClick={() => onChange({ startHz: 5.15e9, stopHz: 5.85e9 })}>5 GHz</button>
      </div></div>
    </fieldset>
    {receiverControls ? <details className="receiver-control-disclosure" open data-agent-control="analyzer.advanced">
      <summary><span>Receiver controls</span><strong>{receiverControls.acquisitionFormats.join(' / ')} · capability-derived</strong></summary>
      <div className="receiver-control-rows parameter-stack" aria-label="Swept-analyzer receiver controls">
        <SelectParameter label="Transfer" value={config.acquisitionFormat} options={receiverControls.acquisitionFormats.map((value) => ({ value, label: sentenceCase(value) }))} disabled={unavailable} controlId="analyzer.transfer" onValue={(acquisitionFormat) => onChange({ acquisitionFormat: acquisitionFormat as AnalyzerConfig['acquisitionFormat'] })}/>
        <AutomaticNumericParameter label="RBW" value={config.rbwKhz} capability={receiverControls.resolutionBandwidthKhz} unit="kHz" disabled={unavailable} controlId="analyzer.rbw" onValue={(rbwKhz) => onChange({ rbwKhz })}/>
        <AutomaticNumericParameter label="Attenuation" value={config.attenuationDb} capability={receiverControls.attenuationDb} unit="dB" disabled={unavailable} controlId="analyzer.attenuation" onValue={(attenuationDb) => onChange({ attenuationDb })}/>
        <AutomaticNumericParameter label="Sweep time" value={config.sweepTimeSeconds} capability={{ automatic: capability!.sweepTimeSeconds.automatic, manual: capability!.sweepTimeSeconds.manualSeconds }} unit="s" disabled={unavailable} controlId="analyzer.sweep-time" displayValue={formatSeconds} onValue={(sweepTimeSeconds) => onChange({ sweepTimeSeconds })}/>
        <SelectParameter label="Detector" value={config.detector} options={receiverControls.detectors.map((value) => ({ value, label: sentenceCase(value) }))} disabled={unavailable} controlId="analyzer.detector" onValue={(detector) => onChange({ detector: detector as AnalyzerConfig['detector'] })}/>
        <SelectParameter label="Spur rejection" value={config.spurRejection} options={receiverControls.spurRejection.map((value) => ({ value, label: sentenceCase(value) }))} disabled={unavailable} controlId="analyzer.spur-rejection" onValue={(spurRejection) => onChange({ spurRejection: spurRejection as AnalyzerConfig['spurRejection'] })}/>
        <SelectParameter label="Avoid spurs" value={config.avoidSpurs} options={receiverControls.avoidSpurs.map((value) => ({ value, label: sentenceCase(value) }))} disabled={unavailable} controlId="analyzer.avoid-spurs" onValue={(avoidSpurs) => onChange({ avoidSpurs: avoidSpurs as AnalyzerConfig['avoidSpurs'] })}/>
        <SelectParameter label="LNA" value={config.lna} options={receiverControls.lowNoiseAmplifier.map((value) => ({ value, label: sentenceCase(value) }))} disabled={unavailable} controlId="analyzer.lna" onValue={(lna) => onChange({ lna: lna as AnalyzerConfig['lna'] })}/>
        <TriggerParameters trigger={config.trigger} modes={receiverControls.triggerModes} level={receiverControls.triggerLevelDbm} disabled={unavailable} controlPrefix="analyzer" onTrigger={(trigger) => onChange({ trigger })}/>
      </div>
    </details> : <div className="receiver-control-applicability synthetic" role="status">
      {capability?.controls.model === 'synthetic-scalar'
        ? `Receiver controls not applicable · synthetic scalar source · exact ${formatSeconds(capability.sweepTimeSeconds.manualSeconds.min)} timing`
        : 'Receiver controls unavailable · connect a swept-spectrum source'}
    </div>}
    <div className="channel-contract-note"><Info size={14}/><p>{capability?.controls.model === 'synthetic-scalar'
      ? `Synthetic scalar timing is fixed and exact at ${capability.sweepTimeSeconds.manualSeconds.min} s; no receiver RBW, attenuation, detector, gain, or trigger setting is claimed.`
      : 'The receiver contract sends every displayed control or rejects it. Geometry, actual RBW, and attenuation retain device readback; controls without a query API remain explicitly command-acknowledged.'}</p></div>
  </aside>;
}

function rangePermits(value: number, range: { min: number; max: number; step?: number }): boolean {
  if (value < range.min || value > range.max) return false;
  if (!range.step) return true;
  const steps = (value - range.min) / range.step;
  return Math.abs(steps - Math.round(steps)) <= 1e-9 * Math.max(1, Math.abs(steps));
}

function formatSeconds(seconds: number): string {
  return seconds < 1 ? `${Number((seconds * 1_000).toPrecision(12))} ms` : `${seconds} s`;
}
