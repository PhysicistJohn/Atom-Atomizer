import type { Protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ATOMIZER_CLASSIFIER_ASSET_SCHEME = 'atomizer-classifier';
export const ATOMIZER_CLASSIFIER_ASSET_ORIGIN =
  `${ATOMIZER_CLASSIFIER_ASSET_SCHEME}://runtime`;

const CLASSIFIER_ASSET_FILENAMES = new Set([
  'runtime-package-manifest.json',
  'time-domain-v3-dual-binding.json',
  'time-domain-v3-rejector-weights.json',
  'time-domain-v3-classifier-weights.json',
  'time-domain-v3-openset-policy.json',
]);

type ProtocolLike = Pick<Protocol, 'handle'>;

/**
 * The custom protocol is needed only by the packaged file: renderer. During
 * development, Vite serves the same byte-verified package from its public
 * directory over the already trusted loopback origin. Skipping registration
 * there also avoids Electron's requirement that privileged schemes be
 * declared before app readiness when the dev launcher imports main late.
 */
export function requiresClassifierAssetProtocol(
  developmentRendererUrl: URL | undefined,
): boolean {
  return developmentRendererUrl === undefined;
}

function response(
  body: BodyInit | null,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

/**
 * Serve only the five deployment files from one fixed directory. No request
 * path is ever joined: the exact allow-listed basename is selected first.
 */
export async function classifierAssetResponse(
  request: Request,
  assetRoot: string,
): Promise<Response> {
  if (request.method !== 'GET') {
    return response(null, 405, { allow: 'GET' });
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return response(null, 400);
  }
  const filename = url.pathname.startsWith('/')
    ? url.pathname.slice(1)
    : url.pathname;
  if (
    url.protocol !== `${ATOMIZER_CLASSIFIER_ASSET_SCHEME}:`
    || url.host !== 'runtime'
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || !CLASSIFIER_ASSET_FILENAMES.has(filename)
  ) {
    return response(null, 404);
  }
  try {
    const bytes = await readFile(join(assetRoot, filename));
    return response(Uint8Array.from(bytes).buffer, 200, {
      'content-length': String(bytes.byteLength),
    });
  } catch {
    return response(null, 404);
  }
}

export function registerClassifierAssetProtocol(
  target: ProtocolLike,
  assetRoot: string,
): void {
  target.handle(
    ATOMIZER_CLASSIFIER_ASSET_SCHEME,
    (request) => classifierAssetResponse(request, assetRoot),
  );
}
