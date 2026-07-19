import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { createOptionalBayesianClassifierVitePlugin } from './apps/desktop/src/main/optional-bayesian-classifier-vite.ts';

export default defineConfig({
  plugins: [createOptionalBayesianClassifierVitePlugin()],
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
    coverage: { provider: 'v8', reporter: ['text', 'html'] }
  }
});
