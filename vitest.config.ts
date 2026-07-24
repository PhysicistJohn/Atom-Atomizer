import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  server: {
    fs: {
      // Both editions bundle sibling-repo SignalLab sources (measurement
      // service + contract document) from ../Atom-SignalLab.
      allow: [fileURLToPath(new URL('..', import.meta.url))],
    },
  },
  resolve: {
    dedupe: ['react', 'react-dom', 'lucide-react'],
    alias: {
      '@tinysa/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
      '@tinysa/instrument-runtime': fileURLToPath(new URL('./packages/instrument-runtime/src/index.ts', import.meta.url)),
      '@tinysa/device': fileURLToPath(new URL('./packages/tinysa/src/index.ts', import.meta.url)),
      '@tinysa/test-device': fileURLToPath(new URL('./packages/test-device/src/index.ts', import.meta.url)),
      '@tinysa/analysis': fileURLToPath(new URL('./packages/analysis/src/index.ts', import.meta.url)),
      '@tinysa/agent': fileURLToPath(new URL('./packages/agent/src/index.ts', import.meta.url)),
    },
  },
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'],
    // The default 5 s timeout and an uncapped worker pool make the suite
    // machine-dependent: on a normal laptop the slower DSP/analysis and
    // renderer tests time out under contention even though every one of them
    // passes when run alone. Pin both so the default gate is deterministic.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    minWorkers: 1,
    maxWorkers: 4,
    coverage: { provider: 'v8', reporter: ['text', 'html'] }
  }
});
