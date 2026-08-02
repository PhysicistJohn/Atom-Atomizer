'use client';

import { useEffect, useState, type ComponentType } from 'react';
import { installWebBridge } from '../src/web-bridge.js';
import { connectWithStaleCandidateRetry } from '../../desktop/src/renderer/stale-candidate-retry.js';

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
    const appModule = import('../../desktop/src/renderer/AppShell.js');

    void appModule.then(({ App }) => {
      if (active) setLaunch({ App, signalLab });
    }).catch((error) => {
      console.error('[Atomizer Web] application shell failed to load', error);
    });

    void (async () => {
      // SignalLab is the factory-default source on every browser host, so
      // connect it at startup the way the desktop app auto-connects its
      // preferred candidate — the operator should not have to open the
      // chooser to get a working session.
      const autoConnect = (async () => {
        try {
          const discovery = await window.atomizerInstrument.discover();
          const candidate = discovery.candidates.find((value) => value.sourceKind === 'signal-lab');
          // The shell runs its own startup discovery concurrently with this
          // one, and each mints a fresh discovery revision, so whichever
          // lands last invalidates the other's candidates. Share the retry
          // every other connect path already uses instead of failing the
          // operator into the chooser.
          if (candidate) {
            await connectWithStaleCandidateRetry(candidate, {
              connect: (value) => window.atomizerInstrument.connect(value),
              discover: () => window.atomizerInstrument.discover(),
            });
          }
        } catch (error) {
          console.error('[Atomizer Web] automatic SignalLab connection failed', error);
        }
      })();
      await autoConnect;
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
        // Compact browser layouts start with the Atom bottom sheet closed so
        // measurement controls and I/Q plots own the initial viewport.
        initialAgentOpen={!signalLab && !window.matchMedia('(max-width: 1210px)').matches}
      />
    </>
  );
}
