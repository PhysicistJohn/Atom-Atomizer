import { useEffect, useState } from 'react';
import { Activity, AudioLines, Boxes, Grid3X3, RadioTower, Waves, Wifi } from 'lucide-react';
import type { DemoLabStatus, ReplayChannelConfiguration, SynthesizedSignalProfile } from '@tinysa/contracts';

const signals = [
  { id: 'cw' as const, label: 'CW', detail: 'Unmodulated carrier', icon: RadioTower },
  { id: 'am' as const, label: 'AM', detail: 'Breathing sidebands', icon: Activity },
  { id: 'fm' as const, label: 'FM', detail: '±75 kHz deviation', icon: Waves },
  { id: 'gsm-normal-burst' as const, label: 'GSM', detail: 'GMSK normal burst', icon: AudioLines },
  { id: 'lte-etm1.1' as const, label: 'LTE E-TM1.1', detail: '20 MHz full allocation', icon: Grid3X3 },
  { id: 'nr-fr1-tm1.1' as const, label: '5G NR TM1.1', detail: '100 MHz · 30 kHz SCS', icon: Boxes },
  { id: 'wifi6-he-su' as const, label: 'Wi-Fi 6 HE SU', detail: '20 MHz burst PPDU', icon: Wifi },
];

export function DemoLab() {
  const [status, setStatus] = useState<DemoLabStatus>();
  const [switching, setSwitching] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const unsubscribe = window.demoLab.subscribe(setStatus);
    void window.demoLab.status().then(setStatus).catch((value) => setError(message(value)));
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

  const channel = status?.channel;
  return <main className="demo-lab">
    <header><div className="demo-orbit"><i/><i/><i/><b/></div><div><small>TINYSA ATOMIZER</small><strong>Signal Lab</strong></div><span><i/>{status?.playback ? 'LIVE' : 'ATTACHED'}</span></header>
    <section className="demo-copy"><span>QUALIFIED SYNTHETIC REPLAY</span><h1>Choose a waveform</h1><p>Standard-derived spectrum projections and visual lab signals stream through the byte-level ZS407 simulator.</p></section>
    <section className="signal-switcher" aria-label="Synthesized waveform profile">{signals.map((signal) => {
      const Icon = signal.icon;
      const active = status?.profile === signal.id;
      const descriptor = status?.catalog.find((entry) => entry.id === signal.id);
      return <button key={signal.id} className={active ? 'active' : ''} disabled={!status?.active || Boolean(switching)} onClick={() => void select(signal.id)} title={descriptor?.disclosure}><span><Icon size={17}/></span><span><strong>{signal.label}</strong><small>{switching === signal.id ? 'Switching…' : signal.detail}</small><em>{descriptor?.qualification === 'standards-derived' ? 'STD-DERIVED' : 'VISUAL'}</em></span><i>{active && <b/>}</i></button>;
    })}</section>
    <section className="channel-model">
      <div><span>CHANNEL MODEL</span><small>SEEDED · REPRODUCIBLE</small></div>
      <div className="channel-buttons"><button className={channel?.model === 'awgn' ? 'active' : ''} disabled={!channel || Boolean(switching)} onClick={() => channel && void configureChannel({ ...channel, model: 'awgn' })}>AWGN</button><button className={channel?.model === 'rayleigh' ? 'active' : ''} disabled={!channel || Boolean(switching)} onClick={() => channel && void configureChannel({ ...channel, model: 'rayleigh' })}>Rayleigh</button></div>
      <label><span>Noise floor</span><input type="range" min="-130" max="-60" step="1" value={channel?.noiseFloorDbm ?? -108} disabled={!channel || Boolean(switching)} onChange={(event) => channel && void configureChannel({ ...channel, noiseFloorDbm: Number(event.target.value) })}/><output>{channel?.noiseFloorDbm ?? -108} dBm</output></label>
      {channel?.model === 'rayleigh' && <label><span>Fading rate</span><input type="range" min="0.1" max="20" step="0.1" value={channel.fadingRateHz} disabled={Boolean(switching)} onChange={(event) => void configureChannel({ ...channel, fadingRateHz: Number(event.target.value) })}/><output>{channel.fadingRateHz.toFixed(1)} Hz</output></label>}
      <p>{channel?.model === 'rayleigh' ? 'Frequency-selective correlated complex fading plus AWGN.' : 'Complex Gaussian periodogram noise plus receiver-shape artifacts.'}</p>
    </section>
    {error && <div className="demo-error" role="alert">{error}</div>}
    <footer><span>{status?.active ? status.playback ? 'SYNTHETIC REPLAY LIVE' : 'REPLAY PAUSED' : 'DEMO STANDBY'}</span><span>{status?.waveform.qualification.toUpperCase() ?? 'NO PROFILE'} · SEED {channel?.seed ?? '—'}</span></footer>
  </main>;
}

function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
