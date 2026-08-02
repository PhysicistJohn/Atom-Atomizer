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
  it('retains an equal selected record across unrelated global writes', () => {
    const store = createStore();
    let renders = 0;
    function Probe() {
      const state = useStore(store, (current) => ({
        workspace: current.workspace,
        secondaryPanel: current.secondaryPanel,
      }), shallowEqual);
      renders++;
      return <output>{state.workspace}:{String(state.secondaryPanel)}</output>;
    }

    render(<Probe/>);
    expect(renders).toBe(1);

    act(() => store.set({ diagnostics: ['background acquisition bookkeeping'] }));
    expect(renders).toBe(1);

    act(() => store.set({ workspace: 'classification' }));
    expect(renders).toBe(2);
    expect(screen.getByText('classification:undefined')).toBeDefined();
  });

  it('reselects the current snapshot when an inline selector changes identity', () => {
    const store = createStore();
    function Probe({ selectSecondaryPanel }: { selectSecondaryPanel: boolean }) {
      const value = useStore(store, (state) => selectSecondaryPanel ? state.secondaryPanel : state.workspace);
      return <output>{String(value)}</output>;
    }

    const view = render(<Probe selectSecondaryPanel={false}/>);
    expect(screen.getByText('spectrum')).toBeDefined();
    view.rerender(<Probe selectSecondaryPanel/>);
    expect(screen.getByText('undefined')).toBeDefined();
  });

  it('gives peer secondary surfaces one shared owner', () => {
    const store = createStore();
    act(() => store.set({ secondaryPanel: 'atom' }));
    expect(store.get().secondaryPanel).toBe('atom');

    act(() => store.set({ secondaryPanel: 'measurement' }));
    expect(store.get().secondaryPanel).toBe('measurement');

    act(() => store.set({ secondaryPanel: 'connection' }));
    expect(store.get().secondaryPanel).toBe('connection');
  });

  it('publishes every store revision through the zero-DOM commit leaf', async () => {
    const runtime = createRendererRuntime({ initialWorkspace: 'spectrum', initialAgentOpen: false });
    render(<RenderCommitPublisher runtime={runtime}/>);

    act(() => runtime.store.set({ diagnostics: ['revision invisible to the App shell slice'] }));

    await expect(runtime.kernel.renderCommit.await()).resolves.toBeUndefined();
  });
});
