// Web E2E smoke: verifies the web dev server serves '/', then runs the
// API-level golden flow (apps/web/src/web-bridge.test.ts) under Node 22.
// Plain Node ESM, no dependencies. Exit 0 = both assertions passed.
//
//   node tools/smoke/web-smoke.mjs

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_URL = 'http://localhost:3000/';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function pass(step, detail = '') { console.log(`PASS  ${step}${detail ? ` — ${detail}` : ''}`); }
function fail(step, detail = '') {
  failures += 1;
  console.error(`FAILED ${step}${detail ? ` — ${detail}` : ''}`);
}
function info(step, detail) { console.log(`INFO  ${step} — ${detail}`); }

async function httpStatus(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'manual' });
    return response.status;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Step 1: ensure the web dev server is serving :3000 (reuse if already up).
// ---------------------------------------------------------------------------
let devServer;
let startedByUs = false;

function killDevServer() {
  if (!devServer || !startedByUs || devServer.killed) return;
  try {
    // npm spawns the real server as a child; kill the whole process group.
    process.kill(-devServer.pid, 'SIGTERM');
  } catch {
    try { devServer.kill('SIGTERM'); } catch { /* ignore */ }
  }
}
process.on('exit', killDevServer);
process.on('SIGINT', () => { killDevServer(); process.exit(130); });
process.on('SIGTERM', () => { killDevServer(); process.exit(143); });

async function ensureDevServer() {
  const existing = await httpStatus(WEB_URL);
  if (existing !== undefined) {
    info('dev-server', `:3000 already serving (HTTP ${existing}); reusing, will not kill`);
    return;
  }
  info('dev-server', "starting 'npm --prefix apps/web run dev'");
  devServer = spawn('npm', ['--prefix', 'apps/web', 'run', 'dev'], {
    cwd: REPO_ROOT,
    detached: true, // own process group so we can tear the whole tree down
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  startedByUs = true;
  let serverOutput = '';
  const capture = (chunk) => { serverOutput = (serverOutput + chunk.toString()).slice(-4000); };
  devServer.stdout.on('data', capture);
  devServer.stderr.on('data', capture);
  let exited = false;
  devServer.on('exit', () => { exited = true; });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`dev-server: process exited early. Tail of output:\n${serverOutput}`);
    const status = await httpStatus(WEB_URL);
    if (status !== undefined) { info('dev-server', `up (HTTP ${status})`); return; }
    await wait(1500);
  }
  throw new Error(`dev-server: :3000 not serving within 120s. Tail of output:\n${serverOutput}`);
}

// ---------------------------------------------------------------------------
// Step 2: HTTP 200 on '/'.
// ---------------------------------------------------------------------------
async function assertRootServes() {
  // A dev server can be up but still compiling; allow a few retries for 200.
  const deadline = Date.now() + 60_000;
  let status;
  while (Date.now() < deadline) {
    status = await httpStatus(WEB_URL);
    if (status === 200) { pass('web-root', "GET / returned HTTP 200"); return; }
    await wait(2000);
  }
  throw new Error(`web-root: GET / returned HTTP ${status ?? 'no response'} (expected 200)`);
}

// ---------------------------------------------------------------------------
// Step 3: API-level golden flow via vitest under Node 22.23.1.
// ---------------------------------------------------------------------------
function runGoldenFlow() {
  return new Promise((resolvePromise, rejectPromise) => {
    const command = 'source ~/.nvm/nvm.sh && nvm use 22.23.1 >/dev/null 2>&1 && npx vitest run apps/web/src/web-bridge.test.ts';
    const child = spawn('zsh', ['-c', command], { cwd: REPO_ROOT, stdio: 'inherit' });
    child.on('error', (error) => rejectPromise(new Error(`web-bridge-tests: could not spawn vitest: ${error.message}`)));
    child.on('exit', (code) => {
      if (code === 0) {
        pass('web-bridge-tests', 'apps/web/src/web-bridge.test.ts green under Node 22.23.1');
        resolvePromise();
      } else {
        rejectPromise(new Error(`web-bridge-tests: vitest exited with code ${code}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
try {
  await ensureDevServer();
  await assertRootServes();
  await runGoldenFlow();
} catch (error) {
  fail('web-smoke', error instanceof Error ? error.message : String(error));
} finally {
  killDevServer();
}

if (failures > 0) {
  console.error(`FAILED web smoke: ${failures} step(s) failed`);
  process.exit(1);
}
console.log('PASS  web smoke: all steps passed');
process.exit(0);
