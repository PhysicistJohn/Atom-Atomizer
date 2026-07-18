import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const firmwareRoot = resolve(root, '../Atom-Firmware');
const activeTrioContract = 'trio-composition-v4.json';
const manifest = JSON.parse(await readFile(resolve(root, 'contracts', activeTrioContract), 'utf8'));
if (manifest.contractVersion !== 4
  || manifest.$id !== `https://tinysa.local/contracts/${activeTrioContract}`) {
  throw new Error(`Firmware-twin smoke requires the active trio composition v4 contract, received ${JSON.stringify({ contractVersion: manifest.contractVersion, $id: manifest.$id })}`);
}
const declared = manifest.parties.firmware;
const child = spawn(process.execPath, [resolve(firmwareRoot, 'tools/atomizer-twin-bridge.mjs')], {
  cwd: firmwareRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16_000); });
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let sequence = 0;
let readyResolve;
let readyReject;
const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
const exit = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })));
child.once('error', (error) => readyReject(error));
lines.on('line', (line) => {
  let value;
  try { value = JSON.parse(line); }
  catch (error) {
    readyReject(new Error(`Twin bridge emitted malformed JSON: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }
  if (value.type === 'ready' || value.type === 'fatal') {
    if (value.type === 'fatal') readyReject(new Error(value.error?.message ?? 'Twin bridge failed during boot'));
    else readyResolve(value);
    return;
  }
  const waiter = pending.get(value.id);
  if (!waiter) return;
  pending.delete(value.id);
  clearTimeout(waiter.timer);
  if (value.ok) waiter.resolve(value.result);
  else waiter.reject(new Error(value.error?.message ?? `Twin request ${value.id} failed`));
});

try {
  const declaration = await bounded(ready, 120_000, 'Twin ready declaration');
  assertEqual(declaration.contractVersion, declared.bridgeContractVersion, 'bridge contract version');
  assertEqual(declaration.bridge, declared.bridge, 'bridge name');
  assertEqual(declaration.firmwareRelease, declared.firmwareRelease, 'firmware release');
  assertEqual(declaration.firmwareSourceCommit, declared.firmwareSourceCommit, 'firmware source commit');
  assertEqual(declaration.firmwareBinarySha256, declared.firmwareBinarySha256, 'firmware binary hash');
  assertEqual(declaration.usbTransactionsModeled, false, 'USB modeling');
  if (typeof declaration.bootEvidence !== 'string' || !declaration.bootEvidence.startsWith('ZS407_TWIN_BOOT=PASS')) throw new Error('Twin boot evidence is missing');

  const status = await request('status');
  if (typeof status.report !== 'string' || !status.report.includes('ZS407_TWIN_STATUS')) throw new Error('Twin status evidence is missing');
  const sweep = await request('acquire_sweep', {
    startHz: 88_000_000,
    stopHz: 108_000_000,
    points: 51,
    rbwKhz: 'auto',
    attenuationDb: 'auto',
    sweepTimeSeconds: 'auto',
    detector: 'sample',
    spurRejection: 'auto',
    lna: 'off',
    avoidSpurs: 'auto',
    trigger: { mode: 'auto' },
  });
  if (sweep.frequencyHz?.length !== 51 || sweep.powerDbm?.length !== 51 || sweep.evidence !== 'firmware-executed-renode') throw new Error('Twin sweep evidence is incomplete');
  if (!sweep.powerDbm.every(Number.isFinite)) throw new Error('Twin sweep contains non-finite power');
  const screen = await request('capture_screen');
  if (screen.width !== 480 || screen.height !== 320 || screen.format !== 'rgb565le' || Buffer.from(screen.pixelsBase64, 'base64').length !== 480 * 320 * 2) throw new Error('Twin screen evidence is incomplete');
  const generator = {
    frequencyHz: 100_000_000,
    levelDbm: -40,
    path: 'normal',
    modulation: 'fm',
    modulationFrequencyHz: 1_000,
    amDepthPercent: 50,
    fmDeviationHz: 25_000,
  };
  const configured = await request('configure_generator', generator);
  if (configured.configuration?.enabled !== false) throw new Error('Twin generator configuration did not force output off');
  const enabled = await request('set_generator_output', { enabled: true });
  if (enabled.enabled !== true) throw new Error('Twin generator output did not enter enabled state');
  const disabled = await request('set_generator_output', { enabled: false });
  if (disabled.enabled !== false) throw new Error('Twin generator output did not return off');
  await request('shutdown');
  const stopped = await bounded(exit, 10_000, 'Twin shutdown');
  if (stopped.code !== 0) throw new Error(`Twin bridge exited with code ${String(stopped.code)} and signal ${String(stopped.signal)}`);

  const peakDbm = Math.max(...sweep.powerDbm);
  console.log(JSON.stringify({
    status: 'PASS',
    execution: 'firmware-digital-twin',
    transport: declaration.bridge,
    usbTransactionsModeled: declaration.usbTransactionsModeled,
    bootEvidence: declaration.bootEvidence,
    sweepPoints: sweep.powerDbm.length,
    peakDbm,
    screenBytes: Buffer.from(screen.pixelsBase64, 'base64').length,
    generatorReturnedOff: disabled.enabled === false,
  }));
} catch (error) {
  child.kill('SIGKILL');
  const detail = stderr.trim() ? `\nTwin stderr:\n${stderr.trim()}` : '';
  throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
}

function request(method, params = {}) {
  const id = `release-${++sequence}`;
  return new Promise((resolveRequest, rejectRequest) => {
    if (!child.stdin.writable) {
      rejectRequest(new Error('Twin bridge stdin is unavailable'));
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`Twin request ${method} timed out`));
    }, 120_000);
    timer.unref?.();
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
    child.stdin.write(`${JSON.stringify({ id, contractVersion: 1, method, params })}\n`);
  });
}
function bounded(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}
function assertEqual(actual, expected, label) {
  if (!Object.is(actual, expected)) throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
