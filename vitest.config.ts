import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: {
    '@tinysa/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
    '@tinysa/device': fileURLToPath(new URL('./packages/tinysa/src/index.ts', import.meta.url)),
    '@tinysa/test-device': fileURLToPath(new URL('./packages/test-device/src/index.ts', import.meta.url)),
    '@tinysa/analysis': fileURLToPath(new URL('./packages/analysis/src/index.ts', import.meta.url)),
    '@tinysa/agent': fileURLToPath(new URL('./packages/agent/src/index.ts', import.meta.url))
  } },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'],
    coverage: { provider: 'v8', reporter: ['text', 'html'] }
  }
});
