import { ChevronDown } from 'lucide-react';
import { ZS407_FIRMWARE_LIMITS, type AnalyzerConfig } from '@tinysa/contracts';
import { formatFrequency, parseFrequency } from '../format.js';
import { EditableParameter, SelectParameter } from './ParameterRow.js';

const RBW_OPTIONS = [3, 10, 30, 100, 300] as const;
const ATTENUATION_OPTIONS = [0, 10, 20, 30, 31] as const;
const SWEEP_TIME_OPTIONS = [0.05, 0.1, 0.5, 1] as const;

export function AnalyzerInspector({ config, disabled, onChange }: { config: AnalyzerConfig; disabled: boolean; onChange(config: AnalyzerConfig): void }) {
  const updateFrequency = (field: 'startHz' | 'stopHz', text: string) => {
    const next = { ...config, [field]: parseFrequency(text) };
    if (next.stopHz <= next.startHz) throw new Error('Stop frequency must be greater than start frequency');
    onChange(next);
  };
  const harmonicRange = config.stopHz > ZS407_FIRMWARE_LIMITS.analyzerUltraTransitionHz;
  const rbwOptions = [
    { value: 'auto', label: 'Automatic' },
    ...(typeof config.rbwKhz === 'number' && !RBW_OPTIONS.includes(config.rbwKhz as typeof RBW_OPTIONS[number]) ? [{ value: config.rbwKhz, label: `${config.rbwKhz} kHz · custom` }] : []),
    ...RBW_OPTIONS.map((value) => ({ value, label: `${value} kHz` })),
  ];
  const attenuationOptions = [
    { value: 'auto', label: 'Automatic' },
    ...(typeof config.attenuationDb === 'number' && !ATTENUATION_OPTIONS.includes(config.attenuationDb as typeof ATTENUATION_OPTIONS[number]) ? [{ value: config.attenuationDb, label: `${config.attenuationDb} dB · custom` }] : []),
    ...ATTENUATION_OPTIONS.map((value) => ({ value, label: `${value} dB` })),
  ];
  const sweepTimeOptions = [
    { value: 'auto', label: 'Automatic' },
    ...(typeof config.sweepTimeSeconds === 'number' && !SWEEP_TIME_OPTIONS.includes(config.sweepTimeSeconds as typeof SWEEP_TIME_OPTIONS[number]) ? [{ value: config.sweepTimeSeconds, label: `${config.sweepTimeSeconds} s · custom` }] : []),
    { value: 0.05, label: '50 ms' }, { value: 0.1, label: '100 ms' }, { value: 0.5, label: '500 ms' }, { value: 1, label: '1 second' },
  ];

  return <aside className="inspector inspector-setup">
    <fieldset disabled={disabled} className="acquisition-dock parameter-stack">
      <EditableParameter label="Start frequency" value={formatFrequency(config.startHz)} displayValue={formatFrequency(config.startHz)} type="text" controlId="analyzer.start" disabled={disabled} onCommit={(value) => updateFrequency('startHz', value)}/>
      <EditableParameter label="Stop frequency" value={formatFrequency(config.stopHz)} displayValue={formatFrequency(config.stopHz)} type="text" controlId="analyzer.stop" disabled={disabled} onCommit={(value) => updateFrequency('stopHz', value)}/>
      <div className="range-summary" aria-label="Derived frequency range">
        <span><small>Center</small><strong>{formatFrequency((config.startHz + config.stopHz) / 2)}</strong></span>
        <span><small>Span</small><strong>{formatFrequency(config.stopHz - config.startHz)}</strong></span>
      </div>
      <EditableParameter label="Sweep points" value={config.points} displayValue={`${config.points} points`} minimum={ZS407_FIRMWARE_LIMITS.minimumSweepPoints} maximum={ZS407_FIRMWARE_LIMITS.maximumSweepPoints} step={1} disabled={disabled} controlId="analyzer.points" onCommit={(value) => onChange({ ...config, points: Number(value) })}/>
      <SelectParameter label="Resolution bandwidth" value={config.rbwKhz} options={rbwOptions} disabled={disabled} controlId="analyzer.rbw" onValue={(value) => onChange({ ...config, rbwKhz: value === 'auto' ? 'auto' : Number(value) })}/>
      <SelectParameter label="Sweep transfer" value={config.acquisitionFormat} options={[{ value: 'raw', label: 'Raw · fastest' }, { value: 'text', label: 'Text · inspectable' }]} disabled={disabled} controlId="analyzer.transfer" onValue={(value) => onChange({ ...config, acquisitionFormat: value as AnalyzerConfig['acquisitionFormat'] })}/>
      <div className="quick-ranges" aria-label="Frequency presets"><span>Presets</span><div><button type="button" onClick={() => onChange({ ...config, startHz: 88e6, stopHz: 108e6 })}>FM band</button><button type="button" onClick={() => onChange({ ...config, startHz: 2.4e9, stopHz: 2.5e9 })}>2.4 GHz</button><button type="button" onClick={() => onChange({ ...config, startHz: 5.15e9, stopHz: 5.85e9 })}>5 GHz</button></div></div>
    </fieldset>
    <details className="advanced-sweep">
      <summary><span><ChevronDown size={14}/>Advanced</span><strong>{detectorLabel(config.detector)}</strong></summary>
      <fieldset disabled={disabled} className="parameter-stack">
        <SelectParameter label="Attenuation" value={config.attenuationDb} options={attenuationOptions} disabled={disabled} controlId="analyzer.attenuation" onValue={(value) => onChange({ ...config, attenuationDb: value === 'auto' ? 'auto' : Number(value) })}/>
        <SelectParameter label="Sweep time" value={config.sweepTimeSeconds} options={sweepTimeOptions} disabled={disabled} controlId="analyzer.sweep-time" onValue={(value) => onChange({ ...config, sweepTimeSeconds: value === 'auto' ? 'auto' : Number(value) })}/>
        <SelectParameter label="Detector" value={config.detector} options={[{ value: 'sample', label: 'Sample' }, { value: 'maximum-hold', label: 'Maximum hold' }, { value: 'minimum-hold', label: 'Minimum hold' }, { value: 'maximum-decay', label: 'Maximum decay' }, { value: 'average-4', label: 'Average · 4' }, { value: 'average-16', label: 'Average · 16' }, { value: 'average', label: 'Average' }, { value: 'quasi-peak', label: 'Quasi peak' }]} disabled={disabled} controlId="analyzer.detector" onValue={(value) => onChange({ ...config, detector: value as AnalyzerConfig['detector'] })}/>
        <SelectParameter label="Spur rejection" value={config.spurRejection} options={AUTO_SWITCH_OPTIONS} disabled={disabled} controlId="analyzer.spur-rejection" onValue={(value) => onChange({ ...config, spurRejection: value as AnalyzerConfig['spurRejection'] })}/>
        <SelectParameter label="Avoid spurs" value={config.avoidSpurs} options={AUTO_SWITCH_OPTIONS} disabled={disabled} controlId="analyzer.avoid-spurs" onValue={(value) => onChange({ ...config, avoidSpurs: value as AnalyzerConfig['avoidSpurs'] })}/>
        <SelectParameter label="Low-noise amplifier" value={config.lna} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} disabled={disabled} controlId="analyzer.lna" onValue={(value) => onChange({ ...config, lna: value as AnalyzerConfig['lna'] })}/>
        <SelectParameter label="Trigger" value={config.trigger.mode} options={[{ value: 'auto', label: 'Free run' }, { value: 'normal', label: 'Normal' }, { value: 'single', label: 'Single' }]} disabled={disabled} controlId="analyzer.trigger" onValue={(value) => { const mode = value as AnalyzerConfig['trigger']['mode']; onChange({ ...config, trigger: mode === 'auto' ? { mode } : { mode, levelDbm: config.trigger.levelDbm ?? -60 } }); }}/>
        {config.trigger.mode !== 'auto' && <EditableParameter label="Trigger level" value={config.trigger.levelDbm ?? -60} displayValue={`${config.trigger.levelDbm ?? -60} dBm`} unit="dBm" minimum={-174} maximum={30} disabled={disabled} controlId="analyzer.trigger-level" onCommit={(value) => onChange({ ...config, trigger: { ...config.trigger, levelDbm: Number(value) } })}/>}
      </fieldset>
    </details>
    {harmonicRange && <div className="range-warning">Harmonic path above 7.3701 GHz · amplitude accuracy remains unqualified until this instrument is characterized.</div>}
  </aside>;
}

const AUTO_SWITCH_OPTIONS = [{ value: 'auto', label: 'Automatic' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] as const;

function detectorLabel(value: AnalyzerConfig['detector']): string {
  return value.replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}
