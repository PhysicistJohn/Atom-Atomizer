import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createDevelopmentRendererCspPlugin } from './src/main/development-renderer-csp-vite.ts';
import { developmentRendererTrust, validateDevelopmentServerUrl } from './src/main/renderer-trust.ts';

const root = fileURLToPath(new URL('./src/renderer', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const signalLabSourceRoot = fileURLToPath(new URL('../../../Atom-SignalLab/src', import.meta.url));
const classifierSourceRoot = fileURLToPath(new URL('../../../Atom-Classifier/src', import.meta.url));
const developmentUrl = validateDevelopmentServerUrl(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173');
const developmentHost = developmentUrl.hostname === '[::1]' ? '::1' : developmentUrl.hostname;
export default defineConfig({
  plugins: [
    react(),
    createDevelopmentRendererCspPlugin(developmentRendererTrust(developmentUrl), react.preambleCode),
  ],
  root,
  base: './',
  resolve: {
    // SignalLab Studio is source-bundled into Atomizer. Pin renderer singletons
    // even when both sibling checkouts have installed their own dependencies.
    dedupe: ['react', 'react-dom', 'lucide-react'],
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
