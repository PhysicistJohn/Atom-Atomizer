import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATOMIZER_CLASSIFIER_ASSET_ORIGIN,
  ATOMIZER_CLASSIFIER_ASSET_SCHEME,
  classifierAssetResponse,
  registerClassifierAssetProtocol,
  requiresClassifierAssetProtocol,
} from './classifier-asset-protocol.js';

describe('packaged classifier asset protocol', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true })),
    );
  });

  it('serves an allow-listed file byte-for-byte with bounded response headers', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'atomizer-classifier-assets-'));
    temporaryDirectories.push(root);
    const source = Uint8Array.from([0x7b, 0x0a, 0x7d, 0x0a]);
    await writeFile(resolve(root, 'runtime-package-manifest.json'), source);

    const result = await classifierAssetResponse(
      new Request(
        `${ATOMIZER_CLASSIFIER_ASSET_ORIGIN}/runtime-package-manifest.json`,
      ),
      root,
    );

    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(result.headers.get('content-length')).toBe(String(source.byteLength));
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(source);
  });

  it.each([
    'subdirectory/runtime-package-manifest.json',
    'runtime-package-manifest.json%2fextra',
    'untracked.json',
    'runtime-package-manifest.json?alternate=true',
  ])('rejects non-canonical request path %s', async (path) => {
    const result = await classifierAssetResponse(
      new Request(`${ATOMIZER_CLASSIFIER_ASSET_ORIGIN}/${path}`),
      '/does/not/matter',
    );
    expect(result.status).toBe(404);
  });

  it('rejects non-GET methods', async () => {
    const result = await classifierAssetResponse(
      new Request(
        `${ATOMIZER_CLASSIFIER_ASSET_ORIGIN}/runtime-package-manifest.json`,
        { method: 'POST' },
      ),
      '/does/not/matter',
    );
    expect(result.status).toBe(405);
    expect(result.headers.get('allow')).toBe('GET');
  });

  it('registers exactly the fetch-enabled classifier scheme', () => {
    const handle = vi.fn();
    registerClassifierAssetProtocol({ handle }, '/assets');
    expect(handle).toHaveBeenCalledOnce();
    expect(handle.mock.calls[0]?.[0]).toBe(ATOMIZER_CLASSIFIER_ASSET_SCHEME);
    expect(handle.mock.calls[0]?.[1]).toBeTypeOf('function');
  });

  it('uses the custom protocol only for the packaged file renderer', () => {
    expect(requiresClassifierAssetProtocol(undefined)).toBe(true);
    expect(
      requiresClassifierAssetProtocol(new URL('http://localhost:5173')),
    ).toBe(false);
  });
});
