/// <reference types="node" />

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workingDirectory = process.cwd();
const webRoot = basename(workingDirectory) === 'web'
  && basename(dirname(workingDirectory)) === 'apps'
  ? workingDirectory
  : resolve(workingDirectory, 'apps/web');
const repositoryRoot = resolve(webRoot, '../..');

describe('Wrangler-only web build contract', () => {
  it('keeps the Cloudflare Worker build without OpenAI Sites hooks or metadata', () => {
    const viteConfig = readFileSync(
      resolve(webRoot, 'vite.config.ts'),
      'utf8',
    );

    expect(viteConfig).toContain("main: './worker/index.ts'");
    expect(viteConfig).toContain('cloudflare({');
    expect(viteConfig).not.toMatch(
      /sites-vite-plugin|\bsites\(\)|\.openai|hosting\.json/,
    );
    expect(
      existsSync(resolve(webRoot, 'build/sites-vite-plugin.ts')),
    ).toBe(false);
    expect(
      existsSync(resolve(webRoot, '.openai/hosting.json')),
    ).toBe(false);
  });

  it('deploys the generated server bundle with Wrangler', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(webRoot, 'package.json'), 'utf8'),
    ) as { readonly scripts?: Readonly<Record<string, string>> };
    expect(packageJson.scripts?.['deploy:cloudflare']).toBe(
      'npm run build && wrangler deploy --name atomizer --config dist/server/wrangler.json',
    );

    const ignoreRules = readFileSync(
      resolve(repositoryRoot, '.gitignore'),
      'utf8',
    ).split(/\r?\n/);
    expect(ignoreRules).not.toContain('.openai/');
  });
});
