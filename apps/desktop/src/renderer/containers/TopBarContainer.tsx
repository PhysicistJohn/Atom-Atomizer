import { memo } from 'react';
import { TopBar } from '../components/TopBar.js';
import { sameSessionWithoutConfiguration, useStore, type AtomizerRendererState } from '../store.js';
import type { RendererRuntime } from '../AppShell.js';

const selectTopBarState = (state: AtomizerRendererState) => ({
  startup: state.instrument.startup,
  session: state.instrument.session,
});

const sameTopBarState = (
  left: ReturnType<typeof selectTopBarState>,
  right: ReturnType<typeof selectTopBarState>,
) => Object.is(left.startup, right.startup)
  && sameSessionWithoutConfiguration(left.session, right.session);

/** Configuration-only session revisions never affect the connection header. */
export const TopBarContainer = memo(function TopBarContainer({
  runtime,
  agentOpen,
  agentConfigured,
}: {
  runtime: RendererRuntime;
  agentOpen: boolean;
  agentConfigured: boolean;
}) {
  const instrument = useStore(runtime.store, selectTopBarState, sameTopBarState);
  return <TopBar
    instrument={instrument}
    agentOpen={agentOpen}
    agentConfigured={agentConfigured}
    onConnection={() => runtime.store.set({ connectionOpen: true })}
    onAgent={() => runtime.store.setKey('agentOpen', (value) => !value)}
  />;
});
