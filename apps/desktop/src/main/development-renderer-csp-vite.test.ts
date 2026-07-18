import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTENT_SECURITY_POLICY_HEADER,
  PACKAGED_RENDERER_CSP,
  developmentRendererCsp,
  inlineScriptCspHash,
} from './renderer-csp.js';
import { developmentRendererTrust, validateDevelopmentServerUrl } from './renderer-trust.js';

describe('Atomizer live Vite development CSP', () => {
  let viteProcess: ChildProcess | undefined;
  let hmrWebSocket: WebSocket | undefined;

  afterEach(async () => {
    hmrWebSocket?.terminate();
    hmrWebSocket = undefined;
    await terminateChild(viteProcess);
    viteProcess = undefined;
  });

  it('sends an effective header before HTML and keeps React refresh plus exact-origin HMR working', async () => {
    const port = await reserveLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;
    const trust = developmentRendererTrust(validateDevelopmentServerUrl(origin));
    const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
    viteProcess = spawn(process.execPath, [
      resolve(repositoryRoot, 'node_modules/vite/bin/vite.js'),
      '--config',
      resolve(repositoryRoot, 'apps/desktop/vite.config.ts'),
      '--logLevel',
      'silent',
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, VITE_DEV_SERVER_URL: origin },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const processOutput: string[] = [];
    viteProcess.stdout?.on('data', (chunk: Buffer) => processOutput.push(chunk.toString('utf8')));
    viteProcess.stderr?.on('data', (chunk: Buffer) => processOutput.push(chunk.toString('utf8')));
    await waitForVite(origin, viteProcess, processOutput);

    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const policy = response.headers.get(CONTENT_SECURITY_POLICY_HEADER);
    expect(policy).toBeTruthy();

    const inlineScripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((match) => match[1] ?? '');
    expect(inlineScripts).toHaveLength(1);
    expect(inlineScripts[0]).toContain('injectIntoGlobalHook');
    expect(policy).toBe(developmentRendererCsp(trust, inlineScripts[0]!));
    expect(policy).toContain(inlineScriptCspHash(inlineScripts[0]!));
    expect(html).toContain(`content="${policy}"`);
    expect(html).toContain('src="/@vite/client"');
    expect(policy).toContain(`connect-src 'self' ws://127.0.0.1:${port}`);
    expect(policy).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline|https?:\/\/remote|wss?:\/\/remote|\*/);

    const rawResponse = await rawHttpGet('127.0.0.1', port, '/');
    const headerBoundary = rawResponse.indexOf('\r\n\r\n');
    expect(headerBoundary).toBeGreaterThan(0);
    expect(rawResponse.slice(0, headerBoundary).toLowerCase()).toContain(
      `${CONTENT_SECURITY_POLICY_HEADER.toLowerCase()}: ${policy}`.toLowerCase(),
    );
    expect(rawResponse.indexOf('<!doctype html>')).toBeGreaterThan(headerBoundary);

    const viteClientResponse = await fetch(`${origin}/@vite/client`);
    expect(viteClientResponse.status).toBe(200);
    const viteClient = await viteClientResponse.text();
    const websocketToken = /const wsToken = "([^"]+)"/.exec(viteClient)?.[1];
    expect(websocketToken).toBeTruthy();
    hmrWebSocket = new WebSocket(`ws://127.0.0.1:${port}/?token=${websocketToken}`, 'vite-hmr', { origin });
    await expectViteHmrConnection(hmrWebSocket);

    const refreshResponse = await fetch(`${origin}/@react-refresh`);
    expect(refreshResponse.status).toBe(200);
    expect(await refreshResponse.text()).toContain('injectIntoGlobalHook');
  }, 20_000);

  it('keeps an actual production renderer build free of every development grant', async () => {
    const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
    const outputDirectory = await mkdtemp(resolve(tmpdir(), 'atomizer-production-csp-'));
    try {
      viteProcess = spawn(process.execPath, [
        resolve(repositoryRoot, 'node_modules/vite/bin/vite.js'),
        'build',
        '--config',
        resolve(repositoryRoot, 'apps/desktop/vite.config.ts'),
        '--outDir',
        outputDirectory,
        '--emptyOutDir',
        '--logLevel',
        'silent',
      ], {
        cwd: repositoryRoot,
        env: { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:41999' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const buildOutput: string[] = [];
      viteProcess.stdout?.on('data', (chunk: Buffer) => buildOutput.push(chunk.toString('utf8')));
      viteProcess.stderr?.on('data', (chunk: Buffer) => buildOutput.push(chunk.toString('utf8')));
      const exitCode = await waitForChildExit(viteProcess, 15_000);
      viteProcess = undefined;
      expect(exitCode, buildOutput.join('')).toBe(0);

      const productionHtml = await readFile(resolve(outputDirectory, 'index.html'), 'utf8');
      expect(productionHtml).toContain(`content="${PACKAGED_RENDERER_CSP}"`);
      expect(productionHtml).not.toMatch(/localhost|127\.0\.0\.1|ws:\/\/|wss:\/\/|sha256-/);
    } finally {
      await terminateChild(viteProcess);
      viteProcess = undefined;
      await rm(outputDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);
});

async function rawHttpGet(host: string, port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host, port }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

async function reserveLoopbackPort(): Promise<number> {
  const reservation = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForVite(origin: string, child: ChildProcess, output: readonly string[]): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited before serving HTML: ${output.join('')}`);
    try {
      const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
    } catch {
      // The child is still starting. Its exact loopback endpoint is polled only
      // for the bounded startup interval above.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Vite did not begin serving its exact loopback origin: ${output.join('')}`);
}

async function terminateChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolveTermination) => {
    let forceTimer: ReturnType<typeof setTimeout>;
    let settleTimer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(forceTimer);
      clearTimeout(settleTimer);
      resolveTermination();
    };
    child.once('exit', done);
    forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    settleTimer = setTimeout(done, 2_000);
    child.kill('SIGTERM');
  });
}

async function waitForChildExit(child: ChildProcess, timeoutMilliseconds: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error('Child process did not exit within its bounded deadline')), timeoutMilliseconds);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
}

async function expectViteHmrConnection(websocket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Vite HMR WebSocket did not connect')), 5_000);
    websocket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    websocket.on('message', (message) => {
      if (JSON.parse(message.toString())?.type !== 'connected') return;
      clearTimeout(timeout);
      websocket.terminate();
      resolve();
    });
  });
}
