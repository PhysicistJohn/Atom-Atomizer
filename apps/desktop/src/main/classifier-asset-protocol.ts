import type { Protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ATOMIZER_CLASSIFIER_ASSET_SCHEME = 'atomizer-classifier';
export const ATOMIZER_CLASSIFIER_ASSET_ORIGIN =
  `${ATOMIZER_CLASSIFIER_ASSET_SCHEME}://runtime`;

const CLASSIFIER_ASSETS = new Map<string, {
  readonly relativePath: string;
  readonly contentType: string;
}>([
  // Keep the released v3 URLs stable while serving from the common classifier
  // root. DACS v7 uses an explicit namespace because both packages have a
  // runtime-package-manifest.json.
  ...[
    'runtime-package-manifest.json',
    'time-domain-v3-dual-binding.json',
    'time-domain-v3-rejector-weights.json',
    'time-domain-v3-classifier-weights.json',
    'time-domain-v3-openset-policy.json',
  ].map((filename) => [filename, {
    relativePath: join('classifier', 'v3', filename),
    contentType: 'application/json; charset=utf-8',
  }] as const),
  ['v7/runtime-package-manifest.json', {
    relativePath: join('classifier', 'v7', 'runtime-package-manifest.json'),
    contentType: 'application/json; charset=utf-8',
  }],
  ['v7/dacs-v7-prototypes.json', {
    relativePath: join('classifier', 'v7', 'dacs-v7-prototypes.json'),
    contentType: 'application/json; charset=utf-8',
  }],
  ['v7/dacs-v7-validation.json', {
    relativePath: join('classifier', 'v7', 'dacs-v7-validation.json'),
    contentType: 'application/json; charset=utf-8',
  }],
  ['v7/dacs-v7-encoder.onnx', {
    relativePath: join('classifier', 'v7', 'dacs-v7-encoder.onnx'),
    contentType: 'application/octet-stream',
  }],
  ['v7/onnxruntime-wasm-1.27.0.wasm', {
    relativePath: join('classifier', 'v7', 'onnxruntime-wasm-1.27.0.wasm'),
    contentType: 'application/wasm',
  }],
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
  contentType = 'application/json; charset=utf-8',
): Response {
  return new Response(body, {
    status,
    headers: {
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
      'content-type': contentType,
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

/**
 * Serve only the exact v3 and v7 deployment files from one fixed classifier
 * root. The request path is never joined; it selects a predeclared relative
 * path and media type.
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
  const asset = CLASSIFIER_ASSETS.get(filename);
  if (
    url.protocol !== `${ATOMIZER_CLASSIFIER_ASSET_SCHEME}:`
    || url.host !== 'runtime'
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || asset === undefined
  ) {
    return response(null, 404);
  }
  try {
    const bytes = await readFile(join(assetRoot, asset.relativePath));
    return response(Uint8Array.from(bytes).buffer, 200, {
      'content-length': String(bytes.byteLength),
    }, asset.contentType);
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
