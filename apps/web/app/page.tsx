'use client';

import { useEffect, useState, type ComponentType } from 'react';
import { installWebBridge } from '../src/web-bridge.js';

interface AtomizerWebAppProps {
  initialWorkspace?: 'spectrum' | 'generator';
  initialAgentOpen?: boolean;
}

interface WebLaunch {
  App: ComponentType<AtomizerWebAppProps>;
  signalLab: boolean;
}

export default function AtomizerWebPage() {
  const [launch, setLaunch] = useState<WebLaunch>();

  useEffect(() => {
    installWebBridge();
    if (location.protocol === 'https:' && 'serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js');
    }
    let active = true;
    const signalLab = location.hostname === 'signal.radio-lab.app';
    if (signalLab) document.title = 'SignalLab — AtomOS';

    void (async () => {
      if (signalLab) {
        try {
          const discovery = await window.atomizerInstrument.discover();
          const candidate = discovery.candidates.find((value) => value.sourceKind === 'signal-lab');
          if (candidate) await window.atomizerInstrument.connect(candidate);
        } catch (error) {
          console.error('[SignalLab Web] automatic browser connection failed', error);
        }
      }
      const { App } = await import('../../desktop/src/renderer/App.js');
      if (active) setLaunch({ App, signalLab });
    })();
    return () => { active = false; };
  }, []);

  if (!launch) {
    return (
      <main className="web-loading" aria-label="Loading Atomizer">
        <span>Atom<span>OS</span></span>
        <strong>Atomizer</strong>
      </main>
    );
  }

  const { App, signalLab } = launch;
  return (
    <>
      <div className="web-edition-badge" aria-label="Atomizer browser edition">
        Browser edition · SignalLab
      </div>
      <App
        initialWorkspace={signalLab ? 'generator' : 'spectrum'}
        initialAgentOpen={!signalLab}
      />
    </>
  );
}
