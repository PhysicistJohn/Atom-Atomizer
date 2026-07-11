import { useEffect, useState } from 'react';
import { Activity, AudioLines, RadioTower, Waves } from 'lucide-react';
import type { DemoLabStatus, SynthesizedSignalProfile } from '@tinysa/contracts';

const signals = [
  { id: 'cw' as const, label: 'CW', detail: 'Single carrier', icon: RadioTower },
  { id: 'am' as const, label: 'AM', detail: 'Carrier + sidebands', icon: Activity },
  { id: 'fm' as const, label: 'FM', detail: 'Deviation comb', icon: Waves },
  { id: 'lte' as const, label: 'LTE-like', detail: 'Occupied OFDM channel', icon: AudioLines },
];

export function DemoLab() {
  const [status, setStatus] = useState<DemoLabStatus>();
  const [switching, setSwitching] = useState<SynthesizedSignalProfile>();
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

  return <main className="demo-lab">
    <header><div className="demo-orbit"><i/><i/><i/><b/></div><div><small>TINYSA ATOMIZER</small><strong>Signal Lab</strong></div><span><i/>{status?.playback ? 'LIVE' : 'ATTACHED'}</span></header>
    <section className="demo-copy"><span>SYNTHETIC REPLAY</span><h1>Choose a signal</h1><p>A continuously evolving RF scene is streamed through the byte-level ZS407 simulator.</p></section>
    <section className="signal-switcher" aria-label="Synthesized signal profile">{signals.map((signal) => {
      const Icon = signal.icon;
      const active = status?.profile === signal.id;
      return <button key={signal.id} className={active ? 'active' : ''} disabled={!status?.active || Boolean(switching)} onClick={() => void select(signal.id)}><span><Icon size={17}/></span><span><strong>{signal.label}</strong><small>{switching === signal.id ? 'Switching…' : signal.detail}</small></span><i>{active && <b/>}</i></button>;
    })}</section>
    {error && <div className="demo-error" role="alert">{error}</div>}
    <footer><span>{status?.active ? status.playback ? 'SYNTHETIC REPLAY LIVE' : 'REPLAY PAUSED' : 'DEMO STANDBY'}</span><span>88—108 MHz canvas</span></footer>
  </main>;
}

function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
