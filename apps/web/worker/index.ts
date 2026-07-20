import { DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES, handleImageOptimization } from 'vinext/server/image-optimization';
import handler from 'vinext/server/app-router-entry';
import { ATOM_AGENT_MODEL } from '@tinysa/agent';

interface Env {
  // Set with `wrangler secret put OPENAI_KEY` in apps/web. Never exposed to the
  // browser: the standard key stays on the worker and only short-lived
  // ephemeral tokens minted from it ever reach the client.
  OPENAI_KEY?: string;
  ASSETS: { fetch(input: Request): Promise<Response> };
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const OPENAI_EPHEMERAL_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// Mint one short-lived Realtime ephemeral token from the worker-held key. The
// browser opens its own Realtime connection with this token; the standard key
// is never sent to the client. Tokens expire in ~1 minute and are single-use
// per connection, so the browser requests one per conversation/voice call.
async function mintEphemeralToken(env: Env): Promise<Response> {
  if (!env.OPENAI_KEY) return jsonResponse({ error: 'Atom is not configured on this deployment' }, 503);
  let upstream: Response;
  try {
    upstream = await fetch(OPENAI_EPHEMERAL_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.OPENAI_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session: { type: 'realtime', model: ATOM_AGENT_MODEL } }),
    });
  } catch {
    return jsonResponse({ error: 'Could not reach the Realtime token service' }, 502);
  }
  const payload = await upstream.text();
  if (!upstream.ok) return jsonResponse({ error: 'Realtime token request was rejected', detail: payload.slice(0, 300) }, 502);
  let parsed: { value?: unknown; expires_at?: unknown; client_secret?: { value?: unknown; expires_at?: unknown } };
  try { parsed = JSON.parse(payload); } catch { return jsonResponse({ error: 'Realtime token service returned malformed JSON' }, 502); }
  const value = typeof parsed.value === 'string' ? parsed.value : typeof parsed.client_secret?.value === 'string' ? parsed.client_secret.value : undefined;
  const expiresAt = typeof parsed.expires_at === 'number' ? parsed.expires_at : typeof parsed.client_secret?.expires_at === 'number' ? parsed.client_secret.expires_at : null;
  if (!value) return jsonResponse({ error: 'Realtime token service returned no ephemeral secret' }, 502);
  return jsonResponse({ value, expiresAt, model: ATOM_AGENT_MODEL });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/atom/status') {
      return jsonResponse({ configured: Boolean(env.OPENAI_KEY), model: ATOM_AGENT_MODEL });
    }
    if (url.pathname === '/api/atom/realtime-token') {
      if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
      return mintEphemeralToken(env);
    }
    if (url.pathname === '/_vinext/image') {
      const widths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, widths);
    }
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
