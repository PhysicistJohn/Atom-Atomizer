// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RenderCommitPublisher, createRendererRuntime } from './AppShell.js';
import {
  AtomizerStore,
  createInitialRendererState,
  shallowEqual,
  useStore,
} from './store.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function createStore() {
  return new AtomizerStore(createInitialRendererState({
    initialWorkspace: 'spectrum',
    initialAgentOpen: false,
  }));
}

describe('renderer store selectors', () => {
  it('migrates the old oversized I/Q preference to the display-sized default', () => {
    localStorage.setItem('atomizer:v2:complex-iq', JSON.stringify({
      kind: 'complex-iq', centerHz: 433_920_000, sampleRateHz: 8_000_000,
      bandwidthHz: 4_000_000, sampleCount: 65_536, sampleFormat: 'cf32le',
    }));

    const store = createStore();
    expect(store.get().iqConfiguration).toMatchObject({
      centerHz: 433_920_000,
      sampleRateHz: 8_000_000,
      bandwidthHz: 4_000_000,
      sampleCount: 16_384,
    });
    store.persistAll();
    expect(JSON.parse(localStorage.getItem('atomizer:v2:complex-iq-v2') ?? '{}')).toMatchObject({
      centerHz: 433_920_000,
      sampleRateHz: 8_000_000,
      bandwidthHz: 4_000_000,
      sampleCount: 16_384,
    });
  });

  it('retains an equal selected record across unrelated global writes', () => {
    const store = createStore();
    let renders = 0;
    function Probe() {
      const state = useStore(store, (current) => ({
        workspace: current.workspace,
        agentOpen: current.agentOpen,
      }), shallowEqual);
      renders++;
      return <output>{state.workspace}:{String(state.agentOpen)}</output>;
    }

    render(<Probe/>);
    expect(renders).toBe(1);

    act(() => store.set({ diagnostics: ['background acquisition bookkeeping'] }));
    expect(renders).toBe(1);

    act(() => store.set({ workspace: 'classification' }));
    expect(renders).toBe(2);
    expect(screen.getByText('classification:false')).toBeDefined();
  });

  it('reselects the current snapshot when an inline selector changes identity', () => {
    const store = createStore();
    function Probe({ selectAgent }: { selectAgent: boolean }) {
      const value = useStore(store, (state) => selectAgent ? state.agentOpen : state.workspace);
      return <output>{String(value)}</output>;
    }

    const view = render(<Probe selectAgent={false}/>);
    expect(screen.getByText('spectrum')).toBeDefined();
    view.rerender(<Probe selectAgent={true}/>);
    expect(screen.getByText('false')).toBeDefined();
  });

  it('publishes every store revision through the zero-DOM commit leaf', async () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'spectrum', initialAgentOpen: false });
    render(<RenderCommitPublisher runtime={runtime}/>);

    act(() => runtime.store.set({ diagnostics: ['revision invisible to the App shell slice'] }));

    await expect(runtime.kernel.renderCommit.await()).resolves.toBeUndefined();
  });
});
