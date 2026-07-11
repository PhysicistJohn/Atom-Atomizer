import { useState } from 'react';
import { ArrowRight, SlidersHorizontal } from 'lucide-react';
import type { AnalyzerConfig } from '@tinysa/contracts';
import { formatFrequency, parseFrequency } from '../format.js';

export function AnalyzerInspector({ config, disabled, onChange }: { config: AnalyzerConfig; disabled: boolean; onChange(config: AnalyzerConfig): void }) {
  const [frequencyError,setFrequencyError]=useState<string>();
  const updateFrequency = (field: 'startHz'|'stopHz', text: string) => { try { onChange({ ...config, [field]: parseFrequency(text) });setFrequencyError(undefined); } catch(error) { setFrequencyError(error instanceof Error?error.message:String(error)); } };
  return <aside className="inspector"><div className="inspector-head"><div><SlidersHorizontal size={16}/><span>Sweep setup</span></div><small>Commanded values</small></div>
    <fieldset disabled={disabled} className="acquisition-dock">
      <div className="frequency-window"><label><span>Start</span><input aria-invalid={Boolean(frequencyError)} key={`start-${config.startHz}`} defaultValue={formatFrequency(config.startHz)} onBlur={(e)=>updateFrequency('startHz',e.target.value)}/></label><ArrowRight size={14}/><label><span>Stop</span><input aria-invalid={Boolean(frequencyError)} key={`stop-${config.stopHz}`} defaultValue={formatFrequency(config.stopHz)} onBlur={(e)=>updateFrequency('stopHz',e.target.value)}/></label></div>
      <div className="derived-range"><span><small>Center</small><strong>{formatFrequency((config.startHz+config.stopHz)/2)}</strong></span><span><small>Span</small><strong>{formatFrequency(config.stopHz-config.startHz)}</strong></span></div>
      <label className="dock-select"><span>Points</span><select value={config.points} onChange={(e)=>onChange({...config,points:Number(e.target.value)})}><option value="145">145</option><option value="290">290</option><option value="450">450</option></select></label>
      <label className="dock-select"><span>Resolution</span><select value={config.rbwKhz ?? 'auto'} onChange={(e)=>onChange({...config,...(e.target.value==='auto'?{rbwKhz:undefined}:{rbwKhz:Number(e.target.value)})})}><option value="auto">Auto RBW</option><option value="10">10 kHz</option><option value="30">30 kHz</option><option value="100">100 kHz</option></select></label>
      <label className="dock-select"><span>Attenuation</span><select value={config.attenuationDb} onChange={(e)=>onChange({...config,attenuationDb:e.target.value==='auto'?'auto':Number(e.target.value)})}><option value="auto">Automatic</option><option value="0">0 dB</option><option value="10">10 dB</option><option value="20">20 dB</option><option value="30">30 dB</option></select></label>
      <div className="quick-ranges" aria-label="Frequency presets"><button type="button" onClick={()=>onChange({...config,startHz:88e6,stopHz:108e6})}>FM</button><button type="button" onClick={()=>onChange({...config,startHz:2.4e9,stopHz:2.5e9})}>2.4G</button><button type="button" onClick={()=>onChange({...config,startHz:5.15e9,stopHz:5.85e9})}>5G</button></div>
    </fieldset>
    {frequencyError&&<div className="control-error" role="alert">{frequencyError}</div>}
  </aside>;
}
