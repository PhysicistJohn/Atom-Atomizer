import { AlertTriangle, FlaskConical, Gauge, Power, Radio, ShieldCheck, Waves } from 'lucide-react';
import type { GeneratorConfig, InstrumentFeatureCapability } from '@tinysa/contracts';
import type { GeneratorOutputState } from '../ui-contracts.js';
import { formatFrequency } from '../format.js';
import { EditableParameter, SelectParameter } from './ParameterRow.js';

type RfGeneratorCapability = Extract<InstrumentFeatureCapability, { kind: 'rf-generator' }>;
type SignalLabProfileCapability = Extract<InstrumentFeatureCapability, { kind: 'signal-lab-profile-selection' }>;

export function GeneratorWorkspace({ config, capability, signalLabProfiles, selectedSignalLabProfile, output, busy, onChange, onApply, onOutput, onSignalLabProfile }: {
  config: GeneratorConfig;
  capability?: RfGeneratorCapability;
  signalLabProfiles?: SignalLabProfileCapability;
  selectedSignalLabProfile?: string;
  output: GeneratorOutputState;
  busy: boolean;
  onChange(config: GeneratorConfig): void;
  onApply(): void;
  onOutput(enabled: boolean): void;
  onSignalLabProfile(profileId: string): void;
}) {
  if (signalLabProfiles) return <SignalLabGenerationWorkspace
    capability={signalLabProfiles}
    selectedProfile={selectedSignalLabProfile}
    busy={busy}
    onProfile={onSignalLabProfile}
  />;

  const on = output === 'on';
  const unknown = output === 'unknown';
  const path = capability?.paths.find((candidate) => candidate.path === config.path);
  const modulationAvailable = config.modulation === 'off'
    || (config.modulation === 'am' && capability?.modulation.am !== undefined)
    || (config.modulation === 'fm' && capability?.modulation.fm !== undefined);
  const valid = capability !== undefined
    && path !== undefined
    && config.frequencyHz >= path.frequencyHz.min
    && config.frequencyHz <= path.frequencyHz.max
    && config.levelDbm >= capability.levelDbm.min
    && config.levelDbm <= capability.levelDbm.max
    && modulationAvailable
    && (config.modulation !== 'am' || within(config.modulationFrequencyHz, capability.modulation.am!.modulationFrequencyHz))
    && (config.modulation !== 'am' || within(config.amDepthPercent, capability.modulation.am!.depthPercent))
    && (config.modulation !== 'fm' || within(config.modulationFrequencyHz, capability.modulation.fm!.modulationFrequencyHz))
    && (config.modulation !== 'fm' || within(config.fmDeviationHz, capability.modulation.fm!.deviationHz));

  return <div className="generator-layout">
    <section className={`rf-stage ${on ? 'is-on' : ''} ${unknown ? 'is-unknown' : ''}`}>
      <div className="rf-halo"><Radio size={36}/><span/><span/><span/></div>
      <span className="rf-state-label">RF output</span>
      <h2>{capability ? output.toUpperCase() : 'UNAVAILABLE'}</h2>
      <p>{!capability ? 'The connected driver exposes no RF generator.' : on ? 'Energy may be present at the RF connector.' : unknown ? 'Physical output state is unknown. Inspect the instrument and connection.' : 'Commanded off · not a physical interlock.'}</p>
      <button data-agent-control="generator.rf-output" data-agent-risk="high-impact" className={`output-control ${on ? 'stop' : 'start'}`} disabled={!capability || busy || unknown || !valid} onClick={() => onOutput(!on)}><Power size={17}/>{on ? 'Disable RF output' : 'Enable RF output'}</button>
    </section>

    <section className="generator-controls">
      <div className="panel-header"><div><Waves size={14}/>Driver-neutral settings</div><span>COMMANDED · NO READBACK CLAIM</span></div>
      <div className="generator-form parameter-stack">
        <EditableParameter label="Output frequency" value={config.frequencyHz} displayValue={formatFrequency(config.frequencyHz)} unit="Hz" minimum={path?.frequencyHz.min ?? 0} maximum={path?.frequencyHz.max ?? 0} step={path?.frequencyHz.step ?? 1} disabled={!path || busy || on} controlId="generator.frequency" onCommit={(value) => onChange({ ...config, frequencyHz: Number(value) })}/>
        <EditableParameter label="Output level" value={config.levelDbm} displayValue={`${config.levelDbm} dBm`} unit="dBm" minimum={capability?.levelDbm.min ?? 0} maximum={capability?.levelDbm.max ?? 0} step={capability?.levelDbm.step ?? 0.5} disabled={!capability || busy || on} controlId="generator.level" onCommit={(value) => onChange({ ...config, levelDbm: Number(value) })}/>
        <SelectParameter label="RF path" value={config.path} options={(capability?.paths ?? []).map((candidate) => ({ value: candidate.path, label: `${candidate.path === 'normal' ? 'Fundamental' : 'Mixer'} · ≤ ${formatFrequency(candidate.frequencyHz.max)}` }))} disabled={!capability || busy || on} controlId="generator.path" onValue={(value) => onChange({ ...config, path: value as GeneratorConfig['path'] })}/>
        <SelectParameter label="Modulation" value={config.modulation} options={[
          { value: 'off', label: 'Unmodulated' },
          ...(capability?.modulation.am ? [{ value: 'am', label: 'Amplitude modulation' }] : []),
          ...(capability?.modulation.fm ? [{ value: 'fm', label: 'Frequency modulation' }] : []),
        ]} disabled={!capability || busy || on} controlId="generator.modulation" onValue={(value) => onChange({ ...config, modulation: value as GeneratorConfig['modulation'] })}/>
        {config.modulation === 'am' && capability?.modulation.am && <>
          <EditableParameter label="Modulation rate" value={config.modulationFrequencyHz} displayValue={formatFrequency(config.modulationFrequencyHz)} unit="Hz" minimum={capability.modulation.am.modulationFrequencyHz.min} maximum={capability.modulation.am.modulationFrequencyHz.max} step={capability.modulation.am.modulationFrequencyHz.step ?? 1} disabled={busy || on} controlId="generator.modulation-rate" onCommit={(value) => onChange({ ...config, modulationFrequencyHz: Number(value) })}/>
          <EditableParameter label="AM depth" value={config.amDepthPercent} displayValue={`${config.amDepthPercent}%`} unit="%" minimum={capability.modulation.am.depthPercent.min} maximum={capability.modulation.am.depthPercent.max} step={capability.modulation.am.depthPercent.step ?? 1} disabled={busy || on} controlId="generator.am-depth" onCommit={(value) => onChange({ ...config, amDepthPercent: Number(value) })}/>
        </>}
        {config.modulation === 'fm' && capability?.modulation.fm && <>
          <EditableParameter label="Modulation rate" value={config.modulationFrequencyHz} displayValue={formatFrequency(config.modulationFrequencyHz)} unit="Hz" minimum={capability.modulation.fm.modulationFrequencyHz.min} maximum={capability.modulation.fm.modulationFrequencyHz.max} step={capability.modulation.fm.modulationFrequencyHz.step ?? 1} disabled={busy || on} controlId="generator.modulation-rate" onCommit={(value) => onChange({ ...config, modulationFrequencyHz: Number(value) })}/>
          <EditableParameter label="FM deviation" value={config.fmDeviationHz} displayValue={formatFrequency(config.fmDeviationHz)} unit="Hz" minimum={capability.modulation.fm.deviationHz.min} maximum={capability.modulation.fm.deviationHz.max} step={capability.modulation.fm.deviationHz.step ?? 1} disabled={busy || on} controlId="generator.fm-deviation" onCommit={(value) => onChange({ ...config, fmDeviationHz: Number(value) })}/>
        </>}
        {!valid && capability && <div className="inline-error">Configuration exceeds the connected driver's declared range.</div>}
        <div className="channel-contract-note"><Waves size={14}/><p>Every shown path and modulation range comes from the connected driver; omitted capabilities remain unavailable.</p></div>
        <div className="panel-action"><button data-agent-control="generator.apply" className="secondary full" disabled={!capability || busy || on || !valid} onClick={onApply}><Gauge size={14}/>Apply with output off</button></div>
      </div>
    </section>

    <section className="safety-panel"><div><ShieldCheck size={18}/><strong>Before enabling</strong></div><ul><li><AlertTriangle size={13}/>Verify load and attenuation.</li><li><AlertTriangle size={13}/>Driver capability does not prove RF readback.</li></ul></section>
  </div>;
}

function SignalLabGenerationWorkspace({ capability, selectedProfile, busy, onProfile }: {
  capability: SignalLabProfileCapability;
  selectedProfile?: string;
  busy: boolean;
  onProfile(profileId: string): void;
}) {
  const activeProfileId = selectedProfile ?? capability.selectedProfileId;
  const activeProfile = capability.profiles.find((profile) => profile.profileId === activeProfileId);
  return <div className="generator-layout signal-lab-generation-layout">
    <section className="rf-stage signal-lab-stage">
      <div className="rf-halo"><FlaskConical size={36}/><span/><span/><span/></div>
      <span className="rf-state-label">Synthetic signal source</span>
      <h2>{activeProfileId.toUpperCase()}</h2>
      <p>SignalLab generates scalar simulated measurements. It does not command an RF output or claim emitted energy.</p>
      <span className="synthetic-source-state">ACTIVE · NO RF OUTPUT</span>
    </section>

    <section className="generator-controls">
      <div className="panel-header"><div><Waves size={14}/>SignalLab waveform</div><span>SIMULATED · HUMAN SELECTED</span></div>
      <div className="generator-form parameter-stack" data-agent-exclusion="human-signal-profile-boundary">
        <SelectParameter
          label="SignalLab profile"
          value={activeProfileId}
          options={capability.profiles.map(({ profileId, centerFrequencyHz }) => ({
            value: profileId,
            label: `${profileId} · ${(centerFrequencyHz / 1e6).toFixed(3)} MHz`,
          }))}
          disabled={busy}
          onValue={(value) => onProfile(String(value))}
        />
        <div className="signal-lab-profile-facts">
          <span><small>Center</small><strong>{activeProfile ? formatFrequency(activeProfile.centerFrequencyHz) : '—'}</strong></span>
          <span><small>Recommended span</small><strong>{activeProfile ? formatFrequency(activeProfile.recommendedSpanHz) : '—'}</strong></span>
        </div>
        <div className="channel-contract-note"><FlaskConical size={14}/><p>Changing profile invalidates prior evidence and recenters the analyzer on the selected scenario.</p></div>
      </div>
    </section>

    <section className="safety-panel"><div><ShieldCheck size={18}/><strong>Simulation boundary</strong></div><ul><li><AlertTriangle size={13}/>No USB device identity is claimed.</li><li><AlertTriangle size={13}/>No RF energy is emitted.</li></ul></section>
  </div>;
}

function within(value: number, range: { min: number; max: number }): boolean { return value >= range.min && value <= range.max; }
