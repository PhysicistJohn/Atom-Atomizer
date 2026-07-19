import type { AtomizerStore } from './store.js';

const RENDER_COMMIT_TIMEOUT_MILLISECONDS = 2_000;

interface RenderCommitWaiter {
  targetRevision: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: number;
}

/**
 * Bridges the store's synchronous mutation revision to React's committed
 * output. The App shell publishes the rendered revision from a layout effect;
 * `await()` resolves once the requested store revision has been committed to
 * the DOM, preserving the former `awaitControllerRenderCommit` semantics
 * (2 s bound, identical error strings, waiters rejected on unmount).
 */
export class RenderCommitGate {
  readonly #store: AtomizerStore;
  readonly #waiters = new Map<symbol, RenderCommitWaiter>();
  #committedRevision = 0;
  readonly mounted = { current: true };

  constructor(store: AtomizerStore) {
    this.#store = store;
  }

  /** Called from the shell's `useLayoutEffect` after every committed render. */
  publish(renderedRevision: number): void {
    this.#committedRevision = Math.max(this.#committedRevision, renderedRevision);
    for (const [id, waiter] of this.#waiters) {
      if (waiter.targetRevision > this.#committedRevision) continue;
      window.clearTimeout(waiter.timeout);
      this.#waiters.delete(id);
      waiter.resolve();
    }
  }

  rejectAllForUnmount(): void {
    for (const waiter of this.#waiters.values()) {
      window.clearTimeout(waiter.timeout);
      waiter.reject(new Error('Atomizer renderer unmounted before the requested controller state committed'));
    }
    this.#waiters.clear();
  }

  await(): Promise<void> {
    const targetRevision = this.#store.revision;
    if (this.#committedRevision >= targetRevision) return Promise.resolve();
    if (!this.mounted.current) return Promise.reject(new Error('Atomizer renderer is unavailable'));
    return new Promise<void>((resolve, reject) => {
      const id = Symbol('renderer-commit-waiter');
      const timeout = window.setTimeout(() => {
        this.#waiters.delete(id);
        reject(new Error('Atomizer renderer did not commit the staged controller state before the bounded computer-action deadline'));
      }, RENDER_COMMIT_TIMEOUT_MILLISECONDS);
      this.#waiters.set(id, { targetRevision, resolve, reject, timeout });
    });
  }
}
