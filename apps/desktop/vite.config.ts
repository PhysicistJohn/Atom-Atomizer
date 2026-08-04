import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createDevelopmentRendererCspPlugin } from './src/main/development-renderer-csp-vite.ts';
import { developmentRendererTrust, validateDevelopmentServerUrl } from './src/main/renderer-trust.ts';

const root = fileURLToPath(new URL('./src/renderer', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const sharedPublicRoot = fileURLToPath(new URL('../web/public', import.meta.url));
const signalLabSourceRoot = fileURLToPath(new URL('../../../Atom-SignalLab/src', import.meta.url));
const classifierSourceRoot = fileURLToPath(new URL('../../../Atom-Classifier/src', import.meta.url));
const developmentUrl = validateDevelopmentServerUrl(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173');
const developmentHost = developmentUrl.hostname === '[::1]' ? '::1' : developmentUrl.hostname;
export default defineConfig({
  define: { __ATOMIZER_ORT_EXTERNAL_WASM__: 'true' },
  plugins: [
    react(),
    createDevelopmentRendererCspPlugin(developmentRendererTrust(developmentUrl), react.preambleCode),
  ],
  root,
  base: './',
  // Browser and packaged-desktop builds consume the same byte-identical
  // v3/v4/v7 runtime packages. Model and policy assets stay outside
  // JavaScript chunks.
  publicDir: sharedPublicRoot,
  resolve: {
    // SignalLab Studio is source-bundled into Atomizer. Pin renderer singletons
    // even when both sibling checkouts have installed their own dependencies.
    dedupe: ['react', 'react-dom', 'lucide-react'],
    // The runtime supplies and verifies one committed WASM binary. Select ORT's
    // external-WASM entry so the bundler does not emit a second 13.5 MB copy.
    conditions: [
      'onnxruntime-web-use-extern-wasm',
      'module',
      'browser',
      'development|production',
    ],
  },
  server: {
    host: developmentHost,
    port: Number(developmentUrl.port),
    strictPort: true,
    fs: { allow: [repositoryRoot, signalLabSourceRoot, classifierSourceRoot] },
  },
  build: {
    outDir: resolve(root, '../../dist/renderer'),
    emptyOutDir: true,
    rollupOptions: { input: { atomizer: resolve(root, 'index.html') } },
  },
});
