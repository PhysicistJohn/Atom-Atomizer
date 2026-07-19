// Manual TEXT-agent E2E session: drives ONE real Atom text operation over CDP
// against the running "Atomizer Dev" desktop app. NOT wired into any suite —
// it exercises the live OpenAI Realtime websocket, so it cannot run keyless
// in CI. Run it by hand:
//
//   node tools/smoke/agent-text-session.mjs
//
// Required environment (the script only verifies; it never launches/kills):
//   1. The desktop app is already running with CDP enabled, e.g.
//        open -a "Atomizer Dev" --args --remote-debugging-port=9222
//      (or `npm run dev` with the same flag). The script fails fast if no CDP
//      page target answers on http://localhost:9222/json.
//   2. OPENAI_KEY was present in the app's environment at launch — the Atom
//      composer is disabled without it and this script fails with guidance.
//   3. A SignalLab session is connected (the factory startup default
//      auto-connects; the script waits up to 45s, then fails with guidance).
//   4. Network access to the OpenAI Realtime API.
//
// Scenario: sends "Switch to the wifi profile and take one sweep." through the
// real Atom composer, then asserts from the rendered transcript that
//   - the select_signal_lab_profile tool executed ("… completed" chip),
//   - the acquire_sweep tool executed ("… completed" chip),
//   - Atom's final reply mentions the wifi profile,
//   - no system-level operation failure was appended.
// Exit 0 = every step passed.

const CDP_JSON = 'http://localhost:9222/json';
const PROMPT = 'Switch to the wifi profile and take one sweep.';
const OPERATION_TIMEOUT_MS = 180_000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function pass(step, detail = '') { console.log(`PASS  ${step}${detail ? ` — ${detail}` : ''}`); }
function fail(step, detail = '') {
  failures += 1;
  console.error(`FAILED ${step}${detail ? ` — ${detail}` : ''}`);
}

// --------------------------------------------------------------------------
// Minimal CDP client over Node 22 native WebSocket (same shape as
// tools/smoke/desktop-smoke.mjs, which stays the orchestrator's own harness).
// --------------------------------------------------------------------------
let ws;
let nextId = 1;
const pending = new Map();

async function connectCdp() {
  let target;
  try {
    const response = await fetch(CDP_JSON, { signal: AbortSignal.timeout(3000) });
    const targets = await response.json();
    target = targets.find((candidate) => candidate.type === 'page');
  } catch { /* handled below */ }
  if (!target) {
    throw new Error('CDP unreachable on :9222 — start the app first: open -a "Atomizer Dev" --args --remote-debugging-port=9222');
  }
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
  pass('cdp-connected', target.url ?? 'page target');
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

// --------------------------------------------------------------------------
// Steps.
// --------------------------------------------------------------------------
async function ensureConnectedSession() {
  await pollFor('app-ready', `Boolean(document.querySelector('button[data-agent-control="connection.open"]'))`, 60_000);
  try {
    await pollFor('signal-lab-session', `(() => {
      const pill = document.querySelector('button[data-agent-control="connection.open"]');
      return Boolean(pill && pill.classList.contains('is-ready'));
    })()`, 45_000);
  } catch {
    throw new Error('no connected instrument session — connect SignalLab (Connection dialog) and re-run');
  }
  pass('signal-lab-session', 'connected session present');
}

async function resetProfileAwayFromWifi() {
  // Idempotence: park the source on a 5G NR profile through the visual picker
  // so "switch to the wifi profile" always demands a real commanded selection.
  await evaluate(`document.querySelector('button[data-agent-control="workspace.generator"]')?.click(); 'ok'`);
  await pollFor('generator-family-tabs', `Boolean([...document.querySelectorAll('button')]
    .find((b) => (b.textContent ?? '').trim().startsWith('5G NR')))`, 15_000);
  const clicked = await evaluate(`(() => {
    const tab = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim().startsWith('5G NR'));
    if (!tab) return 'missing';
    if (tab.disabled) return 'disabled';
    tab.click();
    return 'ok';
  })()`);
  if (clicked !== 'ok') throw new Error(`profile-reset: 5G NR tab was ${clicked}`);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  pass('profile-reset', 'parked on 5G NR before prompting');
}

async function ensureAtomComposer() {
  await evaluate(`(() => {
    if (document.querySelector('.atom-panel')) return 'open';
    const toggle = document.querySelector('button[data-agent-control="atom.toggle"]');
    if (!toggle) return 'missing-toggle';
    toggle.click();
    return 'toggled';
  })()`);
  await pollFor('atom-panel', `Boolean(document.querySelector('.atom-panel .atom-composer textarea'))`, 10_000);
  const composerState = await evaluate(`(() => {
    const composer = document.querySelector('.atom-panel .atom-composer textarea');
    return { disabled: composer.disabled, placeholder: composer.placeholder };
  })()`);
  if (composerState.disabled) {
    throw new Error(`Atom composer is disabled (“${composerState.placeholder}”) — relaunch the app with OPENAI_KEY in its environment`);
  }
  pass('atom-composer', 'panel open, composer enabled (OPENAI_KEY configured)');
}

const READ_TRANSCRIPT = `[...document.querySelectorAll('.atom-panel .atom-message')].map((node) => ({
  role: [...node.classList].find((cls) => ['assistant','user','tool','system'].includes(cls)) ?? 'unknown',
  status: node.classList.contains('failed') ? 'failed' : node.classList.contains('streaming') ? 'streaming' : 'complete',
  text: node.querySelector('p')?.textContent ?? '',
}))`;

async function sendPromptThroughComposer() {
  const before = await evaluate(`(${READ_TRANSCRIPT}).length`);
  const submitted = await evaluate(`(() => {
    const composer = document.querySelector('.atom-panel .atom-composer textarea');
    const sendButton = document.querySelector('.atom-panel .atom-composer button[aria-label="Send to Atom"]');
    if (!composer || !sendButton) return 'missing';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(composer, ${JSON.stringify(PROMPT)});
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    if (sendButton.disabled) return 'send-disabled';
    sendButton.click();
    return 'ok';
  })()`);
  if (submitted !== 'ok') throw new Error(`prompt-submit: composer state was ${submitted}`);
  await pollFor('prompt-appended', `(${READ_TRANSCRIPT}).length > ${before}`, 10_000);
  pass('prompt-submitted', JSON.stringify(PROMPT));
  return before;
}

async function awaitOperationOutcome(baselineCount) {
  // One text operation is done when the connection state returns to IDLE (the
  // atom-foot status line) or a system failure message lands.
  await pollFor('operation-settled', `(() => {
    const foot = document.querySelector('.atom-panel .atom-foot span')?.textContent ?? '';
    const transcript = (${READ_TRANSCRIPT}).slice(${baselineCount});
    const failed = transcript.some((message) => message.role === 'system' && message.status === 'failed');
    return failed || /IDLE|ERROR|UNCONFIGURED/.test(foot);
  })()`, OPERATION_TIMEOUT_MS, 1_500);
  const transcript = (await evaluate(READ_TRANSCRIPT)).slice(baselineCount);

  const systemFailures = transcript.filter((message) => message.role === 'system' && message.status === 'failed');
  if (systemFailures.length) fail('operation-clean', systemFailures.map((message) => message.text).join(' | ').slice(0, 300));
  else pass('operation-clean', 'no system-level operation failure appended');

  const toolChips = transcript.filter((message) => message.role === 'tool').map((message) => message.text);
  const profileToolRan = toolChips.some((text) => /^select signal lab profile completed/.test(text));
  if (profileToolRan) pass('select_signal_lab_profile-executed', 'completed chip present');
  else fail('select_signal_lab_profile-executed', `tool chips: ${JSON.stringify(toolChips).slice(0, 400)}`);

  const sweepToolRan = toolChips.some((text) => /^acquire sweep completed/.test(text));
  if (sweepToolRan) pass('acquire_sweep-executed', 'completed chip present');
  else fail('acquire_sweep-executed', `tool chips: ${JSON.stringify(toolChips).slice(0, 400)}`);

  const assistantReplies = transcript.filter((message) => message.role === 'assistant').map((message) => message.text);
  const finalReply = assistantReplies.at(-1) ?? '';
  if (/wi[^a-z0-9]?fi/i.test(assistantReplies.join(' '))) pass('reply-mentions-profile', finalReply.slice(0, 160));
  else fail('reply-mentions-profile', `assistant replies: ${JSON.stringify(assistantReplies).slice(0, 400)}`);

  const selectedProfile = await evaluate(`(() => {
    const chips = ${READ_TRANSCRIPT};
    return chips.filter((message) => message.role === 'tool').map((message) => message.text).join('\\n');
  })()`);
  console.log(`INFO  transcript-tools —\n${selectedProfile.split('\n').map((line) => `        ${line}`).join('\n')}`);
}

// --------------------------------------------------------------------------
try {
  await connectCdp();
  await ensureConnectedSession();
  await resetProfileAwayFromWifi();
  await ensureAtomComposer();
  const baseline = await sendPromptThroughComposer();
  await awaitOperationOutcome(baseline);
} catch (error) {
  fail('agent-text-session', error instanceof Error ? error.message : String(error));
}
ws?.close();
if (failures) {
  console.error(`\n${failures} step(s) failed`);
  process.exit(1);
}
console.log('\nAll agent text-session steps passed');
process.exit(0);
