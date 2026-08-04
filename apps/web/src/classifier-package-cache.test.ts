/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workingDirectory = process.cwd();
const webRoot = basename(workingDirectory) === 'web'
  && basename(dirname(workingDirectory)) === 'apps'
  ? workingDirectory
  : resolve(workingDirectory, 'apps/web');

describe('web classifier package cache policy', () => {
  it('always revalidates every stable classifier package prefix', () => {
    const source = readFileSync(
      resolve(webRoot, 'public/sw.js'),
      'utf8',
    );
    expect(source).toContain("const CACHE_NAME = 'atomizer-pwa-v5'");
    expect(source).toContain(
      "url.pathname.startsWith('/classifier/v3/')",
    );
    expect(source).toContain(
      "url.pathname.startsWith('/classifier/v4/')",
    );
    expect(source).toContain(
      "url.pathname.startsWith('/classifier/v7/')",
    );
  });
});
