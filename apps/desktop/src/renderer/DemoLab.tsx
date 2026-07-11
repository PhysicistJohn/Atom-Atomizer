import { useEffect, useMemo, useState } from 'react';
import { Activity, AudioLines, Boxes, Grid3X3, RadioTower, Waves, Wifi } from 'lucide-react';
import type { DemoLabStatus, ReplayChannelConfiguration, SynthesizedSignalProfile, WaveformDescriptor } from '@tinysa/contracts';
import { EditableParameter, SelectParameter } from './components/ParameterRow.js';

type CatalogGroup = 'lab' | 'geran' | 'e-utra' | 'nr' | 'wlan';

const groups: readonly { id: CatalogGroup; label: string }[] = [
  { id: 'lab', label: 'LAB' },
  { id: 'geran', label: 'GSM' },
  { id: 'e-utra', label: 'LTE' },
  { id: 'nr', label: '5G NR' },
  { id: 'wlan', label: 'WI-FI' },
];

const labIcons = { cw: RadioTower, am: Activity, fm: Waves } as const;

export function DemoLab() {
  const [status, setStatus] = useState<DemoLabStatus>();
  const [group, setGroup] = useState<CatalogGroup>('lab');
  const [browseId, setBrowseId] = useState<SynthesizedSignalProfile>('cw');
  const [switching, setSwitching] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const apply = (next: DemoLabStatus) => {
      setStatus(next);
      setBrowseId(next.profile);
      setGroup(catalogGroup(next.waveform));
    };
    const unsubscribe = window.demoLab.subscribe(apply);
    void window.demoLab.status().then(apply).catch((value) => setError(message(value)));
    return unsubscribe;
  }, []);

  async function select(profile: SynthesizedSignalProfile): Promise<void> {
    setSwitching(profile);
    setError(undefined);
    try { setStatus(await window.demoLab.select(profile)); }
    catch (value) { setError(message(value)); }
    finally { setSwitching(undefined); }
  }

  async function configureChannel(channel: ReplayChannelConfiguration): Promise<void> {
    setSwitching('channel');
    setError(undefined);
    try { setStatus(await window.demoLab.configureChannel(channel)); }
    catch (value) { setError(message(value)); }
    finally { setSwitching(undefined); }
  }

  const groupCatalog = useMemo(() => status?.catalog.filter((descriptor) => catalogGroup(descriptor) === group) ?? [], [group, status?.catalog]);
  const browsed = groupCatalog.find((descriptor) => descriptor.id === browseId) ?? groupCatalog[0];
  const channel = status?.channel;

  function chooseGroup(next: CatalogGroup): void {
    setGroup(next);
    const first = status?.catalog.find((descriptor) => catalogGroup(descriptor) === next);
    if (!first) throw new Error(`Signal Lab catalog group ${next} is empty`);
    const target = status?.profile && catalogGroup(status.waveform) === next ? status.profile : first.id;
    setBrowseId(target);
    if (target !== status?.profile) void select(target);
  }

  function chooseProfile(profile: SynthesizedSignalProfile): void {
    setBrowseId(profile);
    void select(profile);
  }

  return <main className="demo-lab">
    <header><div className="demo-orbit"><i/><i/><i/><b/></div><strong>Signal Lab</strong><span><i/>{status?.playback ? 'LIVE' : 'PAUSED'}</span></header>
    <section className="profile-catalog" aria-label="Synthesized waveform catalog">
      <nav className="catalog-tabs" aria-label="Waveform families">{groups.map((item) => {
        const count = status?.catalog.filter((descriptor) => catalogGroup(descriptor) === item.id).length ?? 0;
        return <button key={item.id} className={group === item.id ? 'active' : ''} onClick={() => chooseGroup(item.id)}><span>{item.label}</span><small>{count}</small></button>;
      })}</nav>
      {group === 'lab' ? <div className="lab-signals">{groupCatalog.map((descriptor) => {
        const Icon = labIcons[descriptor.id as keyof typeof labIcons];
        if (!Icon) throw new Error(`Visual lab profile ${descriptor.id} has no icon contract`);
        const active = status?.profile === descriptor.id;
        return <button key={descriptor.id} className={active ? 'active' : ''} disabled={!status?.active || Boolean(switching)} onClick={() => chooseProfile(descriptor.id)} title={descriptor.disclosure}><span><Icon size={18}/></span><strong>{descriptor.label.replace(' replay', '')}</strong><small>{descriptor.model}</small><i>{active && <b/>}</i></button>;
      })}</div> : <ProfileBrowser descriptor={requireDescriptor(browsed, group)} catalog={groupCatalog} active={status?.profile === browsed?.id} switching={switching === browsed?.id} disabled={!status?.active || Boolean(switching)} onSelect={chooseProfile}/>}
    </section>
    <section className="channel-model">
      <div><span>Channel</span></div>
      <div className="channel-buttons"><button className={channel?.model === 'awgn' ? 'active' : ''} disabled={!channel || Boolean(switching)} onClick={() => channel && void configureChannel({ ...channel, model: 'awgn' })}>AWGN</button><button className={channel?.model === 'rayleigh' ? 'active' : ''} disabled={!channel || Boolean(switching)} onClick={() => channel && void configureChannel({ ...channel, model: 'rayleigh' })}>Rayleigh</button></div>
      <div className="channel-parameters parameter-stack">
        <EditableParameter label="Noise floor" value={channel?.noiseFloorDbm ?? -108} displayValue={`${channel?.noiseFloorDbm ?? -108} dBm`} unit="dBm" minimum={-130} maximum={-60} disabled={!channel || Boolean(switching)} controlId="demo.channel.noise-floor" onCommit={(value) => { if (!channel) throw new Error('Replay channel is unavailable'); void configureChannel({ ...channel, noiseFloorDbm: Number(value) }); }}/>
        {channel?.model === 'rayleigh' && <EditableParameter label="Fading rate" value={channel.fadingRateHz} displayValue={`${channel.fadingRateHz.toFixed(1)} Hz`} unit="Hz" minimum={0.1} maximum={20} step={0.1} disabled={Boolean(switching)} controlId="demo.channel.fading-rate" onCommit={(value) => void configureChannel({ ...channel, fadingRateHz: Number(value) })}/>}
      </div>
      <p>{channel?.model === 'rayleigh' ? 'Rayleigh fading + AWGN' : 'AWGN + receiver ripple'}</p>
    </section>
    {error && <div className="demo-error" role="alert">{error}</div>}
    <footer><span>{status?.waveform.qualification.toUpperCase() ?? 'NO PROFILE'} · {status?.waveform.model.split(' · ')[0] ?? '—'}</span></footer>
  </main>;
}

function ProfileBrowser({ descriptor, catalog, active, switching, disabled, onSelect }: {
  descriptor: WaveformDescriptor;
  catalog: readonly WaveformDescriptor[];
  active: boolean;
  switching: boolean;
  disabled: boolean;
  onSelect(profile: SynthesizedSignalProfile): void;
}) {
  const Icon = descriptor.family === 'geran' ? AudioLines : descriptor.family === 'e-utra' ? Grid3X3 : descriptor.family === 'nr' ? Boxes : Wifi;
  return <div className="profile-browser">
    <SelectParameter label={`${familyLabel(descriptor)} waveform model`} value={descriptor.id} disabled={disabled} controlId="demo.waveform-model" options={catalog.map((entry) => ({ value: entry.id, label: entry.label }))} onValue={(value) => onSelect(value as SynthesizedSignalProfile)}/>
    <article className={active ? 'active' : ''} title={descriptor.disclosure}>
      <span className="profile-icon"><Icon size={21}/></span>
      <div><small>{descriptor.qualification === 'standards-derived' ? 'STD-DERIVED' : 'VISUAL'}</small><h2>{descriptor.label}</h2><p>{switching ? 'Switching model…' : descriptor.model}</p></div>
      <i>{active && <b/>}</i>
      <dl><div><dt>ALLOCATION</dt><dd>{descriptor.projection.allocation.replace('-', ' ').toUpperCase()}</dd></div><div><dt>TIMING</dt><dd>{descriptor.projection.timing.replace('sbfd-', 'SBFD ').toUpperCase()}</dd></div><div><dt>SOURCE</dt><dd>{descriptor.standard.clause}</dd></div></dl>
    </article>
  </div>;
}

function catalogGroup(descriptor: WaveformDescriptor): CatalogGroup {
  return descriptor.family === 'tone' || descriptor.family === 'analog' ? 'lab' : descriptor.family;
}

function familyLabel(descriptor: WaveformDescriptor): string {
  return ({ geran: 'GSM', 'e-utra': 'LTE', nr: '5G NR', wlan: 'Wi-Fi', tone: 'Lab', analog: 'Lab' })[descriptor.family];
}

function requireDescriptor(descriptor: WaveformDescriptor | undefined, group: CatalogGroup): WaveformDescriptor {
  if (!descriptor) throw new Error(`Signal Lab catalog group ${group} has no waveform descriptor`);
  return descriptor;
}

function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
