import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';
  const { cloudflare } = await import('@cloudflare/vite-plugin');
  return {
    define: { __ATOMIZER_ORT_EXTERNAL_WASM__: 'true' },
    resolve: {
      dedupe: ['react', 'react-dom', 'lucide-react'],
      // DACS verifies and passes its committed WASM bytes to ORT directly.
      conditions: [
        'onnxruntime-web-use-extern-wasm',
        'module',
        'browser',
        'development|production',
      ],
    },
    server: {
      fs: {
        // The browser edition bundles sibling-repo SignalLab sources
        // (measurement service + contract document) from ../../../Atom-SignalLab.
        allow: [new URL('../../..', import.meta.url).pathname],
      },
    },
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: {
          main: './worker/index.ts',
          compatibility_flags: ['nodejs_compat'],
        },
      }),
    ],
  };
});
