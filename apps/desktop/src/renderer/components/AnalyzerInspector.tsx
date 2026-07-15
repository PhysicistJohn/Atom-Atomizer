import { Info } from 'lucide-react';
import type { AnalyzerConfig, AnalyzerConfigPatch, InstrumentAcquisitionCapability } from '@tinysa/contracts';
import { formatFrequency, parseFrequency } from '../format.js';
import { EditableParameter } from './ParameterRow.js';

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
  const unavailable = disabled || !capability;
  const permits = (startHz: number, stopHz: number) => capability !== undefined
    && startHz >= capability.frequencyHz.min
    && stopHz <= capability.frequencyHz.max;

  return <aside className="inspector inspector-setup">
    <fieldset disabled={unavailable} className="acquisition-dock parameter-stack">
      <EditableParameter label="Start frequency" value={config.startHz} displayValue={formatFrequency(config.startHz)} unit="Hz" minimum={capability?.frequencyHz.min ?? 0} maximum={Math.min(config.stopHz - 1, capability?.frequencyHz.max ?? 0)} step={capability?.frequencyHz.step ?? 1} controlId="analyzer.start" disabled={unavailable} onCommit={(value) => updateFrequency('startHz', value)}/>
      <EditableParameter label="Stop frequency" value={config.stopHz} displayValue={formatFrequency(config.stopHz)} unit="Hz" minimum={Math.max(config.startHz + 1, capability?.frequencyHz.min ?? 0)} maximum={capability?.frequencyHz.max ?? 0} step={capability?.frequencyHz.step ?? 1} controlId="analyzer.stop" disabled={unavailable} onCommit={(value) => updateFrequency('stopHz', value)}/>
      <div className="range-summary" aria-label="Derived frequency range">
        <span><small>Center</small><strong>{formatFrequency((config.startHz + config.stopHz) / 2)}</strong></span>
        <span><small>Span</small><strong>{formatFrequency(config.stopHz - config.startHz)}</strong></span>
      </div>
      <EditableParameter label="Sweep points" value={config.points} displayValue={`${config.points} points`} minimum={capability?.points.min ?? 2} maximum={capability?.points.max ?? 2} step={capability?.points.step ?? 1} disabled={unavailable} controlId="analyzer.points" onCommit={(value) => onChange({ points: Number(value) })}/>
      <div className="quick-ranges" aria-label="Frequency presets"><span>Presets</span><div>
        <button data-agent-control="analyzer.preset.fm" type="button" disabled={!permits(88e6, 108e6)} onClick={() => onChange({ startHz: 88e6, stopHz: 108e6 })}>FM band</button>
        <button data-agent-control="analyzer.preset.2g4" type="button" disabled={!permits(2.4e9, 2.5e9)} onClick={() => onChange({ startHz: 2.4e9, stopHz: 2.5e9 })}>2.4 GHz</button>
        <button data-agent-control="analyzer.preset.5g" type="button" disabled={!permits(5.15e9, 5.85e9)} onClick={() => onChange({ startHz: 5.15e9, stopHz: 5.85e9 })}>5 GHz</button>
      </div></div>
    </fieldset>
    <div className="channel-contract-note"><Info size={14}/><p>{capability?.controls.model === 'synthetic-scalar'
      ? `Synthetic scalar timing is fixed and exact at ${capability.sweepTimeSeconds.manualSeconds.min} s; no receiver RBW, attenuation, detector, gain, or trigger setting is claimed.`
      : 'The receiver contract sends every displayed control or rejects it. Geometry, actual RBW, and attenuation retain device readback; controls without a query API remain explicitly command-acknowledged.'}</p></div>
  </aside>;
}
