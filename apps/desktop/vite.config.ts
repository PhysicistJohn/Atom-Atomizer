import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createDevelopmentRendererCspPlugin } from './src/main/development-renderer-csp-vite.ts';
import { createOptionalBayesianClassifierVitePlugin } from './src/main/optional-bayesian-classifier-vite.ts';
import { developmentRendererTrust, validateDevelopmentServerUrl } from './src/main/renderer-trust.ts';

const root = fileURLToPath(new URL('./src/renderer', import.meta.url));
const developmentUrl = validateDevelopmentServerUrl(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173');
const developmentHost = developmentUrl.hostname === '[::1]' ? '::1' : developmentUrl.hostname;
export default defineConfig({
  plugins: [
    createOptionalBayesianClassifierVitePlugin({
      forceUnavailable: process.env.ATOMIZER_DISABLE_BAYESIAN_CLASSIFIER === '1',
    }),
    react(),
    createDevelopmentRendererCspPlugin(developmentRendererTrust(developmentUrl), react.preambleCode),
  ],
  root,
  base: './',
  server: {
    host: developmentHost,
    port: Number(developmentUrl.port),
    strictPort: true,
  },
  build: {
    outDir: resolve(root, '../../dist/renderer'),
    emptyOutDir: true,
    rollupOptions: { input: { atomizer: resolve(root, 'index.html') } },
  },
});
