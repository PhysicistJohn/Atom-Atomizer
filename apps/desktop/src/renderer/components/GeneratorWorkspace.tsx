import { AlertTriangle, Gauge, Power, Radio, ShieldCheck, Waves } from 'lucide-react';
import { ZS407_FIRMWARE_LIMITS, type DeviceSnapshot, type GeneratorConfig } from '@tinysa/contracts';
import { formatFrequency } from '../format.js';
import { EditableParameter, SelectParameter } from './ParameterRow.js';

export function GeneratorWorkspace({ config, snapshot, busy, onChange, onApply, onOutput }: { config: GeneratorConfig; snapshot: DeviceSnapshot; busy: boolean; onChange(config: GeneratorConfig): void; onApply(): void; onOutput(enabled: boolean): void }) {
  const on = snapshot.generatorOutput === 'on';
  const unknown = snapshot.generatorOutput === 'unknown';
  const ready = snapshot.connection === 'ready';
  const maximumHz = config.path === 'normal' ? ZS407_FIRMWARE_LIMITS.generatorFundamentalMaximumHz : ZS407_FIRMWARE_LIMITS.generatorMixerMaximumHz;
  const valid = config.frequencyHz <= maximumHz && config.levelDbm >= ZS407_FIRMWARE_LIMITS.generatorMinimumDbm && config.levelDbm <= ZS407_FIRMWARE_LIMITS.generatorMaximumDbm;

  return <div className="generator-layout">
    <section className={`rf-stage ${on ? 'is-on' : ''} ${unknown ? 'is-unknown' : ''}`}>
      <div className="rf-halo"><Radio size={36}/><span/><span/><span/></div>
      <span className="rf-state-label">RF output</span>
      <h2>{snapshot.generatorOutput.toUpperCase()}</h2>
      <p>{on ? 'Energy may be present at the RF connector.' : unknown ? 'Physical output state is unknown. Inspect the instrument and connection.' : 'Commanded off · not a physical interlock.'}</p>
      <button data-agent-control="generator.rf-output" data-agent-risk="high-impact" className={`output-control ${on ? 'stop' : 'start'}`} disabled={!ready || busy || unknown || !valid} onClick={() => onOutput(!on)}><Power size={17}/>{on ? 'Disable RF output' : 'Enable RF output'}</button>
    </section>

    <section className="generator-controls">
      <div className="panel-header"><div><Waves size={14}/>Settings</div><span>COMMANDED · NO READBACK</span></div>
      <div className="generator-form parameter-stack">
        <EditableParameter label="Output frequency" value={config.frequencyHz} displayValue={formatFrequency(config.frequencyHz)} unit="Hz" minimum={1} maximum={maximumHz} disabled={busy || on} controlId="generator.frequency" onCommit={(value) => onChange({ ...config, frequencyHz: Number(value) })}/>
        <EditableParameter label="Output level" value={config.levelDbm} displayValue={`${config.levelDbm} dBm`} unit="dBm" minimum={ZS407_FIRMWARE_LIMITS.generatorMinimumDbm} maximum={ZS407_FIRMWARE_LIMITS.generatorMaximumDbm} step={0.5} disabled={busy || on} controlId="generator.level" onCommit={(value) => onChange({ ...config, levelDbm: Number(value) })}/>
        <SelectParameter label="RF path" value={config.path} options={[{ value: 'normal', label: `Fundamental · ≤ ${formatFrequency(ZS407_FIRMWARE_LIMITS.generatorFundamentalMaximumHz)}` }, { value: 'mixer', label: `Mixer · ≤ ${formatFrequency(ZS407_FIRMWARE_LIMITS.generatorMixerMaximumHz)}` }]} disabled={busy || on} controlId="generator.path" onValue={(value) => onChange({ ...config, path: value as GeneratorConfig['path'] })}/>
        <SelectParameter label="Modulation" value={config.modulation} options={[{ value: 'off', label: 'Unmodulated' }, { value: 'am', label: 'Amplitude modulation' }, { value: 'fm', label: 'Frequency modulation' }]} disabled={busy || on} controlId="generator.modulation" onValue={(value) => onChange({ ...config, modulation: value as GeneratorConfig['modulation'] })}/>
        {config.modulation !== 'off' && <EditableParameter label="Modulation rate" value={config.modulationFrequencyHz} displayValue={formatFrequency(config.modulationFrequencyHz)} unit="Hz" minimum={1} maximum={config.modulation === 'fm' ? 3_500 : 10_000} disabled={busy || on} controlId="generator.modulation-rate" onCommit={(value) => onChange({ ...config, modulationFrequencyHz: Number(value) })}/>}
        {config.modulation === 'am' && <EditableParameter label="AM depth" value={config.amDepthPercent} displayValue={`${config.amDepthPercent}%`} unit="%" minimum={0} maximum={100} disabled={busy || on} controlId="generator.am-depth" onCommit={(value) => onChange({ ...config, amDepthPercent: Number(value) })}/>}
        {config.modulation === 'fm' && <EditableParameter label="FM deviation" value={config.fmDeviationHz} displayValue={formatFrequency(config.fmDeviationHz)} unit="Hz" minimum={1_000} maximum={300_000} disabled={busy || on} controlId="generator.fm-deviation" onCommit={(value) => onChange({ ...config, fmDeviationHz: Number(value) })}/>}
        {!valid && <div className="inline-error">Configuration exceeds the firmware-derived range for the selected path.</div>}
        <div className="panel-action"><button data-agent-control="generator.apply" className="secondary full" disabled={!ready || busy || on || !valid} onClick={onApply}><Gauge size={14}/>Apply with output off</button></div>
      </div>
    </section>

    <section className="safety-panel"><div><ShieldCheck size={18}/><strong>Before enabling</strong></div><ul><li><AlertTriangle size={13}/>Verify load and attenuation.</li><li><AlertTriangle size={13}/>Harmonic output is unqualified.</li></ul></section>
  </div>;
}
