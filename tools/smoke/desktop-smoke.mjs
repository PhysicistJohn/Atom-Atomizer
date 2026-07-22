// Desktop E2E smoke: drives the REAL installed "Atomizer Dev" app over CDP.
// Plain Node 22 ESM, no dependencies. Exit 0 = every step passed.
//
//   node tools/smoke/desktop-smoke.mjs
//
// Steps: ensure app + CDP -> ensure SignalLab connection -> single sweep ->
// continuous sweep sequence increases -> renderer RSS delta (log only) ->
// switch profile family to 5G NR -> spectrum center reads 1.84 GHz region ->
// classification Detect pipeline renders -> stop continuous.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CDP_JSON = 'http://localhost:9222/json';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function pass(step, detail = '') { console.log(`PASS  ${step}${detail ? ` — ${detail}` : ''}`); }
function fail(step, detail = '') {
  failures += 1;
  console.error(`FAILED ${step}${detail ? ` — ${detail}` : ''}`);
}
function info(step, detail) { console.log(`INFO  ${step} — ${detail}`); }

// ---------------------------------------------------------------------------
// Step 1: ensure the app is running with CDP on :9222.
// ---------------------------------------------------------------------------
async function fetchPageTarget() {
  const response = await fetch(CDP_JSON, { signal: AbortSignal.timeout(3000) });
  const targets = await response.json();
  return targets.find((target) => target.type === 'page');
}

async function ensureApp() {
  try {
    const target = await fetchPageTarget();
    if (target) { pass('app-running', 'CDP already reachable on :9222'); return target; }
  } catch { /* not running yet */ }
  info('app-launch', 'CDP unreachable; launching "Atomizer Dev" with --remote-debugging-port=9222');
  // The dev installer auto-launches the app WITHOUT the debug flag, and `open`
  // on a running app ignores new --args entirely; kill any flagless instance
  // first so the flagged launch below actually takes effect.
  await run('pkill', ['-f', 'Atomizer Dev.app']).catch(() => undefined);
  await wait(2000);
  await run('open', ['-a', 'Atomizer Dev', '--args', '--remote-debugging-port=9222']);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await wait(1500);
    try {
      const target = await fetchPageTarget();
      if (target) { pass('app-running', 'CDP came up after launch'); return target; }
    } catch { /* keep waiting */ }
  }
  throw new Error('app-running: CDP target did not appear on :9222 within 60s');
}

// ---------------------------------------------------------------------------
// Minimal CDP client over Node 22 native WebSocket.
// ---------------------------------------------------------------------------
let ws;
let nextId = 1;
const pending = new Map();

async function connectCdp(target) {
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP WebSocket failed to open'));
  });
}

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(`page evaluate threw: ${result.exceptionDetails.text}`);
  return result.result?.value;
}

const click = (control) => evaluate(`(() => {
  const button = document.querySelector('button[data-agent-control="${control}"]');
  if (!button) return 'missing';
  if (button.disabled) return 'disabled';
  button.click();
  return 'ok';
})()`);

async function clickOrFail(step, control, enableTimeoutMs = 15_000) {
  // Controls flick to disabled while an acquisition or retune is in flight;
  // wait for the control to become clickable before failing the step.
  const deadline = Date.now() + enableTimeoutMs;
  let outcome = await click(control);
  while (outcome === 'disabled' && Date.now() < deadline) {
    await wait(500);
    outcome = await click(control);
  }
  if (outcome !== 'ok') throw new Error(`${step}: control ${control} was ${outcome}`);
}

async function pollFor(step, expression, timeoutMs = 30_000, intervalMs = 750) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(expression);
    if (last) return last;
    await wait(intervalMs);
  }
  throw new Error(`${step}: condition not met within ${timeoutMs}ms (last=${JSON.stringify(last)})`);
}

// ---------------------------------------------------------------------------
// Step helpers.
// ---------------------------------------------------------------------------
async function ensureConnected() {
  // The renderer (Vite) may still be loading; wait for the top bar first.
  await pollFor('app-ready', `Boolean(document.querySelector('button[data-agent-control="connection.open"]'))`, 60_000);
  const isConnected = `(() => {
    const pill = document.querySelector('button[data-agent-control="connection.open"]');
    return Boolean(pill && pill.classList.contains('is-ready'));
  })()`;
  // The app auto-connects SignalLab via startup preference; give that a chance.
  try {
    await pollFor('auto-connect', isConnected, 45_000);
    // A fresh launcher install rebuilds everything and the first Vite compile
    // can mount the connection pill well before the sidebar acquisition
    // controls exist; wait for the full control surface before proceeding.
    await pollFor('controls-mounted', `Boolean(document.querySelector('button[data-agent-control="acquisition.single"]'))`, 60_000);
    pass('connected', 'session established (auto-connect or pre-existing)');
    return;
  } catch { /* fall through to the manual dialog path */ }
  info('connect-dialog', 'auto-connect did not complete; using the connection dialog');
  await clickOrFail('connect-dialog-open', 'connection.open');
  await pollFor('connect-dialog-candidates', `Boolean(document.querySelector('button[data-agent-control="connection.candidate.1.select"]'))`, 20_000);
  // Prefer a SignalLab candidate; otherwise take the first one.
  await evaluate(`(() => {
    const candidates = [...document.querySelectorAll('button[data-agent-control^="connection.candidate."]')];
    const target = candidates.find((c) => /signallab/i.test(c.textContent ?? '')) ?? candidates[0];
    if (target) target.click();
    return target ? 'ok' : 'none';
  })()`);
  await wait(500);
  // The Connect button carries connection.connect; fall back to exact text 'Connect'.
  const clicked = await evaluate(`(() => {
    const tagged = document.querySelector('button[data-agent-control="connection.connect"]');
    if (tagged && !tagged.disabled) { tagged.click(); return 'ok'; }
    const byText = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Connect');
    if (byText && !byText.disabled) { byText.click(); return 'ok'; }
    return 'missing';
  })()`);
  if (clicked !== 'ok') throw new Error('connect: Connect button not clickable');
  await pollFor('connect-session', isConnected, 45_000);
  await click('connection.close'); // Dismiss the dialog if it is still open.
  pass('connected', 'session established via connection dialog');
}

const READ_SEQUENCE = `(() => {
  const plot = document.querySelector('section[aria-description*="sequence="]');
  if (plot) {
    const match = /sequence=(\\d+)/.exec(plot.getAttribute('aria-description') ?? '');
    if (match) return Number(match[1]);
  }
  const header = document.querySelector('.panel-header strong');
  const match = /Sweep (\\d+)/.exec(header?.textContent ?? '');
  return match ? Number(match[1]) : -1;
})()`;

async function singleSweep() {
  // The app may be sitting on any workspace; the sweep readouts only render
  // on the measurement views, so land on spectrum first.
  await clickOrFail('single-sweep', 'measurement.view.spectrum');
  await pollFor('spectrum-panel', `Boolean(document.querySelector('.panel-header'))`, 15_000);
  // A previous sweep may already be rendered (auto-connect, earlier runs), so
  // static text alone is vacuous: require the sequence number to ADVANCE.
  const before = await evaluate(READ_SEQUENCE);
  await clickOrFail('single-sweep', 'acquisition.single');
  await pollFor('single-sweep-advanced', `(${READ_SEQUENCE}) > ${Number.isFinite(before) ? before : -1}`, 20_000);
  await pollFor('single-sweep-dom', `(() => {
    const text = document.body.innerText;
    return /Sweep/.test(text) && /1024 points/.test(text);
  })()`, 20_000);
  const after = await evaluate(READ_SEQUENCE);
  pass('single-sweep', `sequence advanced ${before} -> ${after}; DOM shows 'Sweep' with 1024 points`);
}

async function continuousSequenceIncreases() {
  await clickOrFail('continuous-start', 'acquisition.continuous.start');
  await wait(5000);
  const first = await evaluate(READ_SEQUENCE);
  await wait(3000);
  const second = await evaluate(READ_SEQUENCE);
  if (typeof first !== 'number' || first < 0) throw new Error(`continuous-sequence: could not read first sequence (got ${first})`);
  if (typeof second !== 'number' || second <= first) {
    throw new Error(`continuous-sequence: sequence did not increase (${first} -> ${second})`);
  }
  pass('continuous-sequence', `sweep sequence increased ${first} -> ${second}`);
}

async function rendererRssDelta() {
  const readRss = async () => {
    const { stdout } = await run('ps', ['ax', '-o', 'rss=,command=']);
    const line = stdout.split('\n').find((entry) => /Atomizer Dev Helper \(Renderer\)/.test(entry))
      ?? stdout.split('\n').find((entry) => /Atomizer.*Helper \(Renderer\)/.test(entry));
    if (!line) return undefined;
    return Number(line.trim().split(/\s+/)[0]); // KiB
  };
  const before = await readRss();
  await wait(10_000);
  const after = await readRss();
  if (before === undefined || after === undefined) {
    info('renderer-rss', 'renderer process not found via ps; skipping (log-only step)');
    return;
  }
  info('renderer-rss', `RSS ${(before / 1024).toFixed(1)} MiB -> ${(after / 1024).toFixed(1)} MiB (delta ${((after - before) / 1024).toFixed(1)} MiB over 10s, no assert)`);
}

async function switchFamilyTo5gNr() {
  await clickOrFail('generator-workspace', 'workspace.generator');
  await pollFor('generator-family-tabs', `Boolean([...document.querySelectorAll('nav[aria-label="Waveform families"] button, button')]
    .find((b) => (b.textContent ?? '').trim().startsWith('5G NR')))`, 15_000);
  const clicked = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const tab = buttons.find((b) => (b.textContent ?? '').trim().startsWith('5G NR'));
    if (!tab) return 'missing';
    if (tab.disabled) return 'disabled';
    tab.click();
    return 'ok';
  })()`);
  if (clicked !== 'ok') throw new Error(`family-5gnr: 5G NR tab was ${clicked}`);
  await wait(3000);
  const errorText = await evaluate(`(() => {
    const alerts = [...document.querySelectorAll('[role="alert"]')];
    const failed = alerts.map((a) => a.textContent ?? '').find((text) => /failed/i.test(text));
    return failed ?? '';
  })()`);
  if (errorText) throw new Error(`family-5gnr: error banner appeared: ${errorText.slice(0, 200)}`);
  pass('family-5gnr', 'switched to 5G NR with no failure banner');
}

async function spectrumCenterIs184GHz() {
  await clickOrFail('spectrum-view', 'measurement.view.spectrum');
  const matcher = `/1\\.8[34]\\d*\\s*GHz/.test(document.body.innerText)`;
  try {
    await pollFor('spectrum-center', matcher, 10_000);
  } catch {
    // The readout may lag until a sweep lands on the retuned configuration.
    await click('acquisition.single');
    await pollFor('spectrum-center', matcher, 15_000);
  }
  pass('spectrum-center', 'center frequency readout is in the 1.84 GHz region');
}

async function classificationDetectPanel() {
  await clickOrFail('classification-workspace', 'workspace.classification');
  await pollFor('classification-pipeline', `(() => {
    const flavor = document.querySelector('.detect-flavor')?.textContent ?? '';
    const result = document.querySelector('.detect-result');
    return Boolean(result) && flavor.includes('COMPLEX I/Q') && /LIVE · 500 MS TREND · [1-9][0-9]* SAMPLES?/.test(flavor);
  })()`, 15_000);
  pass('classification', 'global complex-I/Q classifier renders its live 500 ms trend');
}

async function stopContinuous() {
  const outcome = await click('acquisition.continuous.stop');
  if (outcome === 'missing') throw new Error('continuous-stop: stop control missing');
  if (outcome === 'disabled') info('continuous-stop', 'stop control disabled (already stopping)');
  pass('continuous-stop', 'continuous acquisition stopped');
}

async function wlanIqCapture() {
  // User-reported gap (2026-07-19): a WLAN sim never verified in desktop I/Q.
  // Select the Wi-Fi family, open the I/Q workspace, take one bounded buffer,
  // and require the sample readout to render actual capture evidence.
  await clickOrFail('wlan-iq-generator', 'workspace.generator');
  const clicked = await evaluate(`(() => {
    const tab = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim().startsWith('WI-FI'));
    if (!tab) return 'missing';
    if (tab.disabled) return 'disabled';
    tab.click();
    return 'ok';
  })()`);
  if (clicked !== 'ok') throw new Error(`wlan-iq: WI-FI family tab was ${clicked}`);
  await wait(2500);
  await clickOrFail('wlan-iq-workspace', 'workspace.iq');
  await pollFor('wlan-iq-panel', `document.body.innerText.includes('Capture setup')`, 15_000);
  await clickOrFail('wlan-iq-single', 'acquisition.single');
  await pollFor('wlan-iq-samples', `(() => {
    const text = document.body.innerText;
    return /SAMPLES/i.test(text) && /65,?536|32,?768|16,?384|8,?192|4,?096|2,?048|1,?024/.test(text)
      && !/NO COMPLEX-SAMPLE CAPTURE YET/i.test(text);
  })()`, 25_000);
  pass('wlan-iq', 'WLAN profile produced a rendered I/Q capture');
}

async function runRetargetsAcrossWorkspaces() {
  // Run follows the operator: a spectrum Run turns into live bounded I/Q
  // buffers when entering the I/Q workspace, and back into a live spectrum
  // stream when leaving. Both directions must visibly advance.
  const iqSequence = () => evaluate(`(() => {
    const m = /sequence=(\\d+)/.exec(document.querySelector('.iq-workspace')?.getAttribute('aria-description') ?? '');
    return m ? Number(m[1]) : -1;
  })()`);
  const landmarkSequence = () => evaluate(`(() => {
    const m = /sequence=(\\d+)/.exec(document.querySelector('[aria-label="Acquisition controls"]')?.getAttribute('aria-description') ?? '');
    return m ? Number(m[1]) : -1;
  })()`);
  await clickOrFail('run-retarget', 'measurement.view.spectrum');
  await wait(500);
  await clickOrFail('run-retarget', 'acquisition.continuous.start');
  await wait(2500);
  await clickOrFail('run-retarget', 'workspace.iq');
  await wait(3500);
  const iqCanvasHash = () => evaluate(`(async () => {
    const canvas = document.querySelector('canvas.iq-canvas');
    if (!canvas) return 'missing';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canvas.toDataURL('image/png')));
    return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  })()`);
  const iqBefore = await iqSequence();
  const pixelsBefore = await iqCanvasHash();
  await wait(2500);
  const iqAfter = await iqSequence();
  const pixelsAfter = await iqCanvasHash();
  if (!(iqBefore >= 0 && iqAfter > iqBefore)) {
    throw new Error(`run-retarget: I/Q did not advance during Run (sequence ${iqBefore} -> ${iqAfter})`);
  }
  // Sequence alone is not liveness: successive captures must be successive
  // moments of the signal, so the rendered time-domain pixels must change.
  if (pixelsBefore === 'missing' || pixelsBefore === pixelsAfter) {
    throw new Error(`run-retarget: I/Q plot pixels did not change across buffers (${pixelsBefore} -> ${pixelsAfter})`);
  }
  await clickOrFail('run-retarget', 'measurement.view.spectrum');
  await wait(3500);
  const sweepBefore = await landmarkSequence();
  await wait(2500);
  const sweepAfter = await landmarkSequence();
  await clickOrFail('run-retarget', 'acquisition.continuous.stop');
  if (!(sweepBefore >= 0 && sweepAfter > sweepBefore)) {
    throw new Error(`run-retarget: spectrum did not resume after leaving I/Q (sequence ${sweepBefore} -> ${sweepAfter})`);
  }
  pass('run-retarget', `IQ ${iqBefore}->${iqAfter}, spectrum ${sweepBefore}->${sweepAfter} across one Run`);
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
const steps = [
  ['ensure-connected', ensureConnected],
  ['single-sweep', singleSweep],
  ['continuous-sequence', continuousSequenceIncreases],
  ['renderer-rss', rendererRssDelta],
  ['family-5gnr', switchFamilyTo5gNr],
  ['spectrum-center', spectrumCenterIs184GHz],
  ['classification', classificationDetectPanel],
  ['continuous-stop', stopContinuous],
  ['wlan-iq', wlanIqCapture],
  ['run-retarget', runRetargetsAcrossWorkspaces],
];

try {
  const target = await ensureApp();
  await connectCdp(target);
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      fail(name, error instanceof Error ? error.message : String(error));
      if (name !== 'renderer-rss') {
        // Best-effort cleanup so a failed run does not leave continuous acquisition running.
        try { await click('acquisition.continuous.stop'); } catch { /* ignore */ }
        break;
      }
    }
  }
} catch (error) {
  fail('bootstrap', error instanceof Error ? error.message : String(error));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
}

if (failures > 0) {
  console.error(`FAILED desktop smoke: ${failures} step(s) failed`);
  process.exit(1);
}
console.log('PASS  desktop smoke: all steps passed');
process.exit(0);
