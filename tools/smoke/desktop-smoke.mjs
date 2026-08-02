// Generic Atomizer desktop smoke. Attaches to an existing Dev app over CDP;
// it never launches, kills, or disconnects an operator's application.
//
//   node tools/smoke/desktop-smoke.mjs

const CDP = 'http://localhost:9222/json';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
let ws;
let requestId = 0;
const pending = new Map();

const pass = (step, detail = '') => console.log(`PASS  ${step}${detail ? ` — ${detail}` : ''}`);
const info = (step, detail) => console.log(`INFO  ${step} — ${detail}`);
const fail = (step, error) => { failures += 1; console.error(`FAILED ${step} — ${error}`); };

async function target() {
  try {
    const response = await fetch(CDP, { signal: AbortSignal.timeout(3000) });
    return (await response.json()).find((candidate) => candidate.type === 'page');
  } catch { return undefined; }
}

async function attach() {
  const page = await target();
  if (!page) throw new Error('no CDP page on :9222; start Atomizer Dev with CDP enabled, then rerun');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const transaction = pending.get(message.id);
    if (!transaction) return;
    pending.delete(message.id);
    message.error ? transaction.reject(new Error(message.error.message)) : transaction.resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP WebSocket failed to open'));
  });
  pass('app-running', 'attached to existing CDP page');
}

function send(method, params = {}) {
  const id = ++requestId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
}

async function waitFor(step, expression, timeout = 30_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await evaluate(expression);
    if (last) return last;
    await sleep(500);
  }
  throw new Error(`${step} timed out (last=${JSON.stringify(last)})`);
}

async function press(control, required = true, timeout = 15_000) {
  const expression = `(() => {
    const button = document.querySelector('button[data-agent-control="${control}"]');
    if (!button) return 'missing';
    if (button.disabled) return 'disabled';
    button.click(); return 'ok';
  })()`;
  const end = Date.now() + timeout;
  let outcome = await evaluate(expression);
  while (outcome === 'disabled' && Date.now() < end) {
    await sleep(500);
    outcome = await evaluate(expression);
  }
  if (required && outcome !== 'ok') throw new Error(`${control} was ${outcome}`);
  return outcome;
}

const SEQUENCE = `(() => {
  const values = [...document.querySelectorAll('[aria-description]')].flatMap((node) =>
    [...(node.getAttribute('aria-description') ?? '').matchAll(/\\bsequence=(\\d+)/g)].map((match) => Number(match[1])),
  ).filter(Number.isFinite);
  return values.length ? Math.max(...values) : -1;
})()`;

async function progress(step, before, timeout = 30_000) {
  const expression = before >= 0 ? `(${SEQUENCE}) > ${before}` : `(${SEQUENCE}) >= 0`;
  return waitFor(step, expression, timeout);
}

async function noAlert(step, scope = 'body') {
  const alert = await evaluate(`(() => [...(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll('[role="alert"]') ?? [])]
    .map((node) => (node.textContent ?? '').trim()).find(Boolean) ?? '')()`);
  if (alert) throw new Error(`${step}: ${String(alert).slice(0, 300)}`);
}

async function connect() {
  await waitFor('app-ready', `Boolean(document.querySelector('button[data-agent-control="connection.open"]'))`, 60_000);
  const ready = `Boolean(document.querySelector('button[data-agent-control="connection.open"].is-ready'))`;
  try {
    await waitFor('existing-session', ready, 20_000);
    await waitFor('acquisition-controls', `Boolean(document.querySelector('button[data-agent-control="acquisition.single"]'))`, 60_000);
    pass('connected', 'existing session ready');
    return;
  } catch { /* connect the first advertised candidate below */ }

  await press('connection.open');
  await waitFor('connection-candidates', `Boolean(document.querySelector('button[data-agent-control="connection.candidate.1.select"]'))`, 20_000);
  const candidate = await evaluate(`(() => {
    const first = [...document.querySelectorAll('button[data-agent-control^="connection.candidate."][data-agent-control$=".select"]')][0];
    if (!first) return 'missing'; if (first.disabled) return 'disabled'; first.click(); return 'ok';
  })()`);
  if (candidate !== 'ok') throw new Error(`first advertised candidate was ${candidate}`);
  await sleep(250);
  const result = await evaluate(`(() => {
    const button = document.querySelector('button[data-agent-control="connection.connect"]')
      ?? [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Connect');
    if (!button) return 'missing'; if (button.disabled) return 'disabled'; button.click(); return 'ok';
  })()`);
  if (result !== 'ok') throw new Error(`Connect was ${result}`);
  await waitFor('connected-session', ready, 45_000);
  await waitFor('acquisition-controls', `Boolean(document.querySelector('button[data-agent-control="acquisition.single"]'))`, 60_000);
  await press('connection.close', false);
  pass('connected', 'first advertised candidate connected');
}

async function stop(report = true) {
  const result = await press('acquisition.continuous.stop', false);
  if (result === 'ok' || result === 'disabled') {
    await waitFor('continuous-stop', `(() => {
      const run = document.querySelector('button[data-agent-control="acquisition.continuous.start"]');
      const single = document.querySelector('button[data-agent-control="acquisition.single"]');
      return Boolean(run && single && !run.disabled && !single.disabled);
    })()`);
    if (report) pass('continuous-stop', 'stopped');
  }
}

async function acquireOnce() {
  const before = await evaluate(SEQUENCE);
  await press('acquisition.single');
  const after = await progress('single-acquisition', before);
  await noAlert('single-acquisition');
  pass('single-acquisition', `rendered sequence ${before} -> ${after}`);
}

async function acquireContinuously() {
  try {
    await press('acquisition.continuous.start');
    await sleep(2500);
    const first = await evaluate(SEQUENCE);
    await sleep(3000);
    const second = await evaluate(SEQUENCE);
    if (!(first >= 0 && second > first)) throw new Error(`rendered sequence did not advance (${first} -> ${second})`);
    await noAlert('continuous-acquisition');
    pass('continuous-acquisition', `rendered sequence ${first} -> ${second}`);
  } finally {
    await stop();
  }
}

async function canonicalSetup() {
  await press('measurement.view.spectrum', false);
  await press('measurement.setup');
  await waitFor('canonical-setup', `Boolean(document.querySelector('.canonical-operation-panel'))`, 20_000);
  const parameters = await evaluate(`(() => [...document.querySelectorAll('.canonical-operation-panel [data-canonical-parameter]')].map((node) => {
    const direct = node.querySelector('.canonical-direct-editor');
    const control = direct?.querySelector('details.editable-parameter > summary, select, button.toggle-parameter, input');
    return { id: node.getAttribute('data-canonical-parameter') ?? '', hasDirectEditor: Boolean(direct),
      control: control?.tagName ?? '', disabled: Boolean(control?.matches(':disabled, [aria-disabled="true"]')) };
  }))()`);
  if (!parameters?.length) throw new Error('driver declared no canonical parameters');
  const invalid = parameters.filter(({ hasDirectEditor, control }) => !hasDirectEditor || !control);
  if (invalid.length) throw new Error(`direct value editor missing for ${invalid.map(({ id }) => id || 'unnamed').join(', ')}`);
  if (await evaluate(`Boolean(document.querySelector('.canonical-operation-panel select[aria-label$=" mode"]'))`)) {
    throw new Error('legacy Auto/Manual mode selector is still visible');
  }
  if (await evaluate(`Boolean(document.querySelector('.canonical-operation-panel .canonical-setting-summary, .canonical-operation-panel .canonical-setting-choices, .canonical-operation-panel .canonical-operation-apply, .canonical-operation-panel .canonical-recommendation'))`)) {
    throw new Error('legacy staged canonical-setting surface is still visible');
  }
  if (await evaluate(`(() => [...document.querySelectorAll('.canonical-operation-panel button, .canonical-operation-panel strong, .canonical-operation-panel small')]
    .some((node) => /^(Recommended|Custom|Apply settings|Use recommended)$/i.test((node.textContent ?? '').trim())))()`)) {
    throw new Error('legacy Recommended/Custom action is still visible');
  }
  pass('canonical-setup', `${parameters.length} parameter(s) expose direct value editors`);

  const action = await evaluate(`(() => {
    const compactAuto = [...document.querySelectorAll('.canonical-operation-panel .canonical-auto')]
      .find((button) => !button.disabled);
    if (compactAuto) { compactAuto.click(); return 'direct Auto'; }
    const summary = [...document.querySelectorAll('.canonical-operation-panel details.editable-parameter > summary')]
      .find((item) => item.getAttribute('aria-disabled') !== 'true' && !item.closest('.disabled'));
    if (!summary) return false;
    summary.click();
    return 'keypad Auto';
  })()`);
  if (!action) {
    info('canonical-operation', 'visible operation is unavailable; contract was still checked');
    return;
  }
  if (action === 'keypad Auto') {
    await waitFor('canonical-keypad-auto', `Boolean(document.querySelector('.numeric-entry-panel .numeric-key-auto:not(:disabled)'))`);
    const keypadAuto = await evaluate(`(() => {
      const button = document.querySelector('.numeric-entry-panel .numeric-key-auto');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    if (!keypadAuto) throw new Error('numeric canonical control did not offer Auto');
    await waitFor('canonical-keypad-close', `!document.querySelector('.numeric-entry-panel')`);
  }
  const outcome = await waitFor('canonical-operation', `(() => {
    const panel = document.querySelector('.canonical-operation-panel');
    const alert = [...(panel?.querySelectorAll('[role="alert"]') ?? [])].map((node) => (node.textContent ?? '').trim()).find(Boolean);
    if (alert) return 'ERROR:' + alert;
    const controls = [...(panel?.querySelectorAll('.canonical-direct-editor summary, .canonical-direct-editor select, .canonical-direct-editor button.toggle-parameter, .canonical-direct-editor input, .canonical-direct-editor .canonical-auto') ?? [])];
    return controls.length > 0 && controls.every((control) => !control.matches(':disabled, [aria-disabled="true"]')) ? 'PASS' : '';
  })()`);
  if (String(outcome).startsWith('ERROR:')) throw new Error(String(outcome).slice(6));
  pass('canonical-operation', `${action} applied immediately through the generic canonical surface`);
}

const IQ_CAPTURE = `(() => {
  const root = document.querySelector('.iq-workspace');
  const footer = root?.querySelector('.iq-evidence-footer')?.textContent?.trim() ?? '';
  const detail = root?.getAttribute('aria-description') ?? '';
  return { present: Boolean(root), captured: footer.length > 0 && !/no complex-sample capture yet/i.test(footer),
    id: /\\bcaptureId=([^;]+)/.exec(detail)?.[1] ?? /\\bCapture\\s+(.+?)\\s+·/.exec(footer)?.[1] ?? '',
    sequence: Number(/\\bsequence=(\\d+)/.exec(detail)?.[1] ?? -1) };
})()`;

async function iqVisual() {
  const available = await evaluate(`(() => { const button = document.querySelector('button[data-agent-control="workspace.iq"]'); return Boolean(button && !button.disabled); })()`);
  if (!available) {
    info('iq-visual', 'I/Q capability is not exposed; skipped');
    return;
  }
  await press('workspace.iq');
  await waitFor('iq-workspace', `Boolean(document.querySelector('.iq-workspace'))`, 15_000);
  await press('acquisition.single');
  await waitFor('iq-first-capture', `(${IQ_CAPTURE}).captured`);
  const before = await evaluate(IQ_CAPTURE);
  await press('acquisition.single');
  await waitFor('iq-liveness', `(() => { const now = ${IQ_CAPTURE}; const before = ${JSON.stringify(before)}; return now.captured && ((now.id && now.id !== before.id) || (now.sequence >= 0 && now.sequence > before.sequence)); })()`);
  const visual = await evaluate(`(() => { const canvases = [...document.querySelectorAll('.iq-workspace canvas.iq-canvas')]; return canvases.length > 0 && canvases.every((canvas) => canvas.width > 0 && canvas.height > 0 && canvas.toDataURL('image/png').length > 200); })()`);
  if (!visual) throw new Error('captured I/Q did not produce painted canvas evidence');
  pass('iq-visual', 'two captures advanced and rendered I/Q evidence');
}

const steps = [
  ['connect', connect],
  ['single-acquisition', acquireOnce],
  ['continuous-acquisition', acquireContinuously],
  ['canonical-setup', canonicalSetup],
  ['iq-visual', iqVisual],
];

try {
  await attach();
  for (const [name, step] of steps) {
    try { await step(); } catch (error) { fail(name, error instanceof Error ? error.message : String(error)); break; }
  }
} catch (error) {
  fail('bootstrap', error instanceof Error ? error.message : String(error));
} finally {
  try { await stop(false); } catch { /* best effort: never leave Run active */ }
  try { ws?.close(); } catch { /* ignore */ }
}

if (failures) {
  console.error(`FAILED desktop smoke: ${failures} step(s) failed`);
  process.exit(1);
}
console.log('PASS  desktop smoke: all applicable generic steps passed');
