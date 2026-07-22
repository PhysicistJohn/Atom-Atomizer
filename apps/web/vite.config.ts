import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import { sites } from './build/sites-vite-plugin.js';

/**
 * .openai/hosting.json is gitignored (environment-specific hosting metadata,
 * regenerated per deployment target) so it will not exist on a fresh clone or
 * in CI. A static JSON import would make that a hard compile-time dependency;
 * read it defensively at config-eval time instead, falling back to no D1/R2
 * bindings (this repo's current committed default, since both are unset).
 */
function readHostingConfig(): { d1: string | null; r2: string | null } {
  try {
    const path = fileURLToPath(new URL('./.openai/hosting.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { d1: parsed.d1 ?? null, r2: parsed.r2 ?? null };
  } catch {
    return { d1: null, r2: null };
  }
}
const { d1, r2 } = readHostingConfig();

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';
  const { cloudflare } = await import('@cloudflare/vite-plugin');
  return {
    resolve: { dedupe: ['react', 'react-dom', 'lucide-react'] },
    server: {
      fs: {
        // The browser edition bundles sibling-repo SignalLab sources
        // (measurement service + contract document) from ../../../Atom-SignalLab.
        allow: [new URL('../../..', import.meta.url).pathname],
      },
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: {
          main: './worker/index.ts',
          compatibility_flags: ['nodejs_compat'],
          d1_databases: d1 ? [{ binding: d1, database_name: 'atomizer-web', database_id: '00000000-0000-4000-8000-000000000000' }] : [],
          r2_buckets: r2 ? [{ binding: r2, bucket_name: 'atomizer-web' }] : [],
        },
      }),
    ],
  };
});
