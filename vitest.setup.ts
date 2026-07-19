/**
 * Node 26 ships an experimental `localStorage` on globalThis that jsdom's
 * environment wiring can leave broken (accessing or using it throws, or writes
 * do not round-trip). Renderer tests rely on a functioning Web Storage API, so
 * when a DOM-like (jsdom) environment lacks one, install a spec-shaped,
 * Map-backed polyfill. Under Node 22 the probe passes and this file changes
 * nothing, keeping the existing baseline behavior intact.
 */

function hasWorkingLocalStorage(scope: typeof globalThis): boolean {
  try {
    const storage = (scope as { localStorage?: Storage }).localStorage;
    if (!storage) return false;
    const probeKey = '__vitest_setup_local_storage_probe__';
    storage.setItem(probeKey, 'probe');
    const roundTripped = storage.getItem(probeKey) === 'probe';
    storage.removeItem(probeKey);
    return roundTripped;
  } catch {
    return false;
  }
}

function createMapBackedStorage(): Storage {
  const entries = new Map<string, string>();
  const storage = {
    get length(): number {
      return entries.size;
    },
    key(index: number): string | null {
      if (!Number.isInteger(index) || index < 0 || index >= entries.size) return null;
      return [...entries.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      const value = entries.get(String(key));
      return value === undefined ? null : value;
    },
    setItem(key: string, value: string): void {
      entries.set(String(key), String(value));
    },
    removeItem(key: string): void {
      entries.delete(String(key));
    },
    clear(): void {
      entries.clear();
    },
  };
  return storage as Storage;
}

// Only a DOM-like test environment (jsdom/happy-dom) is expected to provide
// Web Storage; plain node-environment suites are left untouched.
if (typeof window !== 'undefined' && !hasWorkingLocalStorage(globalThis)) {
  const polyfill = createMapBackedStorage();
  for (const scope of new Set<object>([globalThis, window])) {
    Object.defineProperty(scope, 'localStorage', {
      configurable: true,
      enumerable: true,
      get: () => polyfill,
    });
  }
}
