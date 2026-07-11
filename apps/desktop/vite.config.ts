import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('./src/renderer', import.meta.url));
export default defineConfig({
  plugins: [react()],
  root,
  base: './',
  build: {
    outDir: resolve(root, '../../dist/renderer'),
    emptyOutDir: true,
    rollupOptions: { input: { atomizer: resolve(root, 'index.html') } },
  },
});
