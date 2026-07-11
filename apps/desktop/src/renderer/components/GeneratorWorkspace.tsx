import { AlertTriangle, Gauge, Power, Radio, ShieldCheck, Waves } from 'lucide-react';
import { ZS407_FIRMWARE_LIMITS, type DeviceSnapshot, type GeneratorConfig } from '@tinysa/contracts';
import { formatFrequency } from '../format.js';

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
      <div className="generator-form">
        <label><span>Frequency</span><div className="large-input"><input data-agent-control="generator.frequency" type="number" min="1" max={maximumHz} value={config.frequencyHz} onChange={(event) => onChange({ ...config, frequencyHz: Number(event.target.value) })}/><em>Hz</em></div><small>{formatFrequency(config.frequencyHz)} · max {formatFrequency(maximumHz)}</small></label>
        <label><span>Output level</span><div className="large-input"><input data-agent-control="generator.level" type="number" min={ZS407_FIRMWARE_LIMITS.generatorMinimumDbm} max={ZS407_FIRMWARE_LIMITS.generatorMaximumDbm} step="0.5" value={config.levelDbm} onChange={(event) => onChange({ ...config, levelDbm: Number(event.target.value) })}/><em>dBm</em></div></label>
        <label><span>RF path</span><select value={config.path} onChange={(event) => onChange({ ...config, path: event.target.value as GeneratorConfig['path'] })}><option value="normal">Fundamental · ≤ 6.3 GHz</option><option value="mixer">Mixer / harmonic · ≤ 17.9226 GHz</option></select></label>
        <label><span>Modulation</span><select value={config.modulation} onChange={(event) => onChange({ ...config, modulation: event.target.value as GeneratorConfig['modulation'] })}><option value="off">Unmodulated</option><option value="am">Amplitude modulation</option><option value="fm">Frequency modulation</option></select></label>
        {config.modulation !== 'off' && <label><span>Modulation rate</span><div className="large-input small"><input type="number" min="1" max={config.modulation === 'fm' ? 3_500 : 10_000} value={config.modulationFrequencyHz} onChange={(event) => onChange({ ...config, modulationFrequencyHz: Number(event.target.value) })}/><em>Hz</em></div></label>}
        {config.modulation === 'am' && <label><span>AM depth</span><div className="large-input small"><input type="number" min="0" max="100" value={config.amDepthPercent} onChange={(event) => onChange({ ...config, amDepthPercent: Number(event.target.value) })}/><em>%</em></div></label>}
        {config.modulation === 'fm' && <label><span>FM deviation</span><div className="large-input small"><input type="number" min="1000" max="300000" value={config.fmDeviationHz} onChange={(event) => onChange({ ...config, fmDeviationHz: Number(event.target.value) })}/><em>Hz</em></div></label>}
        {!valid && <div className="inline-error">Configuration exceeds the firmware-derived range for the selected path.</div>}
        <button data-agent-control="generator.apply" className="secondary full" disabled={!ready || busy || on || !valid} onClick={onApply}><Gauge size={14}/>Apply with output off</button>
      </div>
    </section>

    <section className="safety-panel"><div><ShieldCheck size={18}/><strong>Before enabling</strong></div><ul><li><AlertTriangle size={13}/>Verify load and attenuation.</li><li><AlertTriangle size={13}/>Harmonic output is unqualified.</li></ul></section>
  </div>;
}
