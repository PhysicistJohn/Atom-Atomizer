import { useState } from 'react';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { ZS407_FIRMWARE_LIMITS, type AnalyzerConfig } from '@tinysa/contracts';
import { formatFrequency, parseFrequency } from '../format.js';

export function AnalyzerInspector({ config, disabled, onChange }: { config: AnalyzerConfig; disabled: boolean; onChange(config: AnalyzerConfig): void }) {
  const [frequencyError, setFrequencyError] = useState<string>();
  const updateFrequency = (field: 'startHz' | 'stopHz', text: string) => {
    try {
      const next = { ...config, [field]: parseFrequency(text) };
      if (next.stopHz <= next.startHz) throw new Error('Stop frequency must be greater than start frequency');
      onChange(next);
      setFrequencyError(undefined);
    } catch (error) {
      setFrequencyError(error instanceof Error ? error.message : String(error));
    }
  };
  const harmonicRange = config.stopHz > ZS407_FIRMWARE_LIMITS.analyzerUltraTransitionHz;

  return <aside className="inspector inspector-setup">
    <fieldset disabled={disabled} className="acquisition-dock">
      <div className="frequency-window">
        <label><span>Start</span><input data-agent-control="analyzer.start" aria-invalid={Boolean(frequencyError)} key={`start-${config.startHz}`} defaultValue={formatFrequency(config.startHz)} onBlur={(event) => updateFrequency('startHz', event.target.value)}/></label>
        <ArrowRight size={14}/>
        <label><span>Stop</span><input data-agent-control="analyzer.stop" aria-invalid={Boolean(frequencyError)} key={`stop-${config.stopHz}`} defaultValue={formatFrequency(config.stopHz)} onBlur={(event) => updateFrequency('stopHz', event.target.value)}/></label>
      </div>
      <div className="derived-range"><span><small>Center</small><strong>{formatFrequency((config.startHz + config.stopHz) / 2)}</strong></span><span><small>Span</small><strong>{formatFrequency(config.stopHz - config.startHz)}</strong></span></div>
      <label className="dock-select"><span>Points</span><input type="number" min={ZS407_FIRMWARE_LIMITS.minimumSweepPoints} max={ZS407_FIRMWARE_LIMITS.maximumSweepPoints} step="1" value={config.points} onChange={(event) => onChange({ ...config, points: Number(event.target.value) })}/></label>
      <label className="dock-select"><span>Transfer</span><select value={config.acquisitionFormat} onChange={(event) => onChange({ ...config, acquisitionFormat: event.target.value as AnalyzerConfig['acquisitionFormat'] })}><option value="raw">Raw · fast</option><option value="text">Text · inspectable</option></select></label>
      <label className="dock-select"><span>Resolution</span><select value={config.rbwKhz} onChange={(event) => onChange({ ...config, rbwKhz: event.target.value === 'auto' ? 'auto' : Number(event.target.value) })}><option value="auto">Auto RBW</option>{typeof config.rbwKhz === 'number' && ![3, 10, 30, 100, 300].includes(config.rbwKhz) && <option value={config.rbwKhz}>{config.rbwKhz} kHz · custom</option>}<option value="3">3 kHz</option><option value="10">10 kHz</option><option value="30">30 kHz</option><option value="100">100 kHz</option><option value="300">300 kHz</option></select></label>
      <div className="quick-ranges" aria-label="Frequency presets"><button type="button" onClick={() => onChange({ ...config, startHz: 88e6, stopHz: 108e6 })}>FM</button><button type="button" onClick={() => onChange({ ...config, startHz: 2.4e9, stopHz: 2.5e9 })}>2.4G</button><button type="button" onClick={() => onChange({ ...config, startHz: 5.15e9, stopHz: 5.85e9 })}>5G</button></div>
    </fieldset>
    <details className="advanced-sweep">
      <summary><ChevronDown size={13}/>Advanced <span>{config.detector} · {config.attenuationDb === 'auto' ? 'auto attenuation' : `${config.attenuationDb} dB`}</span></summary>
      <fieldset disabled={disabled}>
        <label><span>Attenuation</span><select value={config.attenuationDb} onChange={(event) => onChange({ ...config, attenuationDb: event.target.value === 'auto' ? 'auto' : Number(event.target.value) })}><option value="auto">Automatic</option>{typeof config.attenuationDb === 'number' && ![0, 10, 20, 30, 31].includes(config.attenuationDb) && <option value={config.attenuationDb}>{config.attenuationDb} dB · custom</option>}<option value="0">0 dB</option><option value="10">10 dB</option><option value="20">20 dB</option><option value="30">30 dB</option><option value="31">31 dB</option></select></label>
        <label><span>Sweep time</span><select value={config.sweepTimeSeconds} onChange={(event) => onChange({ ...config, sweepTimeSeconds: event.target.value === 'auto' ? 'auto' : Number(event.target.value) })}><option value="auto">Automatic</option>{typeof config.sweepTimeSeconds === 'number' && ![0.05, 0.1, 0.5, 1].includes(config.sweepTimeSeconds) && <option value={config.sweepTimeSeconds}>{config.sweepTimeSeconds} s · custom</option>}<option value="0.05">50 ms</option><option value="0.1">100 ms</option><option value="0.5">500 ms</option><option value="1">1 second</option></select></label>
        <label><span>Detector</span><select value={config.detector} onChange={(event) => onChange({ ...config, detector: event.target.value as AnalyzerConfig['detector'] })}><option value="sample">Sample</option><option value="maximum-hold">Maximum hold</option><option value="minimum-hold">Minimum hold</option><option value="maximum-decay">Maximum decay</option><option value="average-4">Average · 4</option><option value="average-16">Average · 16</option><option value="average">Average</option><option value="quasi-peak">Quasi peak</option></select></label>
        <label><span>Spur rejection</span><select value={config.spurRejection} onChange={(event) => onChange({ ...config, spurRejection: event.target.value as AnalyzerConfig['spurRejection'] })}><option value="auto">Automatic</option><option value="on">On</option><option value="off">Off</option></select></label>
        <label><span>Avoid spurs</span><select value={config.avoidSpurs} onChange={(event) => onChange({ ...config, avoidSpurs: event.target.value as AnalyzerConfig['avoidSpurs'] })}><option value="auto">Automatic</option><option value="on">On</option><option value="off">Off</option></select></label>
        <label><span>LNA</span><select value={config.lna} onChange={(event) => onChange({ ...config, lna: event.target.value as AnalyzerConfig['lna'] })}><option value="off">Off</option><option value="on">On</option></select></label>
        <label><span>Trigger</span><select value={config.trigger.mode} onChange={(event) => { const mode = event.target.value as AnalyzerConfig['trigger']['mode']; onChange({ ...config, trigger: mode === 'auto' ? { mode } : { mode, levelDbm: config.trigger.levelDbm ?? -60 } }); }}><option value="auto">Free run</option><option value="normal">Normal</option><option value="single">Single</option></select></label>
        {config.trigger.mode !== 'auto' && <label><span>Trigger level</span><div className="input-with-unit"><input type="number" min="-174" max="30" value={config.trigger.levelDbm} onChange={(event) => onChange({ ...config, trigger: { ...config.trigger, levelDbm: Number(event.target.value) } })}/><em>dBm</em></div></label>}
      </fieldset>
    </details>
    {frequencyError && <div className="control-error" role="alert">{frequencyError}</div>}
    {harmonicRange && <div className="range-warning">Above 7.3701 GHz uses the firmware harmonic path. Treat amplitude accuracy as unqualified until your physical ZS407 is characterized.</div>}
  </aside>;
}
