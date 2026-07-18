import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Renderer-memory evidence source emitted by the development Electron app. */
export const DEFAULT_ATOMIZER_RENDERER_MEMORY_LOG_PATH = join(
  homedir(),
  'Library',
  'Logs',
  'Atomizer Dev.log',
);

/** Parse only complete Electron renderer-memory records from the Atomizer log. */
export function parseAtomizerRendererMemoryLog(
  text,
  source = DEFAULT_ATOMIZER_RENDERER_MEMORY_LOG_PATH,
) {
  if (typeof text !== 'string') throw new TypeError('Atomizer renderer-memory log must be text');
  const normalizedSource = requireNonEmptyString(source, 'renderer-memory log source');
  const starts = [...text.matchAll(/^(\S+) \[RENDERER-MEMORY\] \{/gm)];
  const samples = [];
  for (const [index, start] of starts.entries()) {
    const recordEnd = starts[index + 1]?.index ?? text.length;
    const tail = text.slice(start.index, recordEnd);
    // util.inspect writes the record's outer brace at column zero; the metric
    // object's brace is indented. Stop there so unrelated subsequent log lines
    // cannot make an otherwise complete record look truncated.
    const outerClose = /^\}\s*$/mu.exec(tail);
    if (!outerClose) continue;
    const block = tail.slice(0, outerClose.index + outerClose[0].length);
    const capturedAt = start[1];
    const capturedMs = Date.parse(capturedAt);
    const webContentsId = Number(/\bwebContentsId:\s*(\d+)/u.exec(block)?.[1]);
    const osProcessId = Number(/\bosProcessId:\s*(\d+)/u.exec(block)?.[1]);
    const creationText = /\bcreationTime:\s*([\d.]+)/u.exec(block)?.[1] ?? null;
    const workingSetKb = Number(/\bworkingSetKb:\s*(\d+)/u.exec(block)?.[1]);
    const bytes = workingSetKb * 1_024;
    if (!Number.isFinite(capturedMs)
      || !Number.isSafeInteger(webContentsId)
      || webContentsId < 1
      || !Number.isSafeInteger(osProcessId)
      || osProcessId < 1
      || creationText === null
      || !Number.isFinite(Number(creationText))
      || !Number.isSafeInteger(workingSetKb)
      || workingSetKb < 0
      || !Number.isSafeInteger(bytes)) continue;
    samples.push({
      bytes,
      source: normalizedSource,
      capturedAt,
      identity: `webContents:${webContentsId}:pid:${osProcessId}:created:${creationText}`,
    });
  }
  return samples;
}

/** Parse admitted app-session diagnostics, never launcher-validation sessions. */
export function parseAtomizerSignalLabSessionLog(
  text,
  source = DEFAULT_ATOMIZER_RENDERER_MEMORY_LOG_PATH,
) {
  if (typeof text !== 'string') throw new TypeError('Atomizer SignalLab session log must be text');
  const normalizedSource = requireNonEmptyString(source, 'SignalLab session log source');
  const records = [];
  for (const [index, line] of text.split('\n').entries()) {
    const match = /^(\S+) \[ATOMIZER-SIGNAL-LAB-SESSION\] (\{.*\})$/u.exec(line);
    if (!match) continue;
    const capturedAt = match[1];
    let value;
    try { value = JSON.parse(match[2]); } catch { continue; }
    const provenance = value?.provenance;
    if (!Number.isFinite(Date.parse(capturedAt))
      || !validOpaqueSessionId(value?.sessionId)
      || value?.driverId !== 'signal-lab'
      || provenance?.sourceKind !== 'signal-lab'
      || provenance?.execution !== 'signal-lab-simulation'
      || provenance?.transport !== 'signal-lab-measurement-bridge'
      || provenance?.contractId !== 'tinysa-signal-lab-atomizer-measurement'
      || provenance?.contractVersion !== 1
      || !validSignalLabHashes(provenance)
      || !noPhysicalClaims(provenance?.claims)) continue;
    records.push({
      sessionId: value.sessionId,
      driverId: value.driverId,
      provenance,
      source: normalizedSource,
      capturedAt,
      lineNumber: index + 1,
      recordKind: 'admitted-app-session',
    });
  }
  return records;
}

/** Parse complete column-zero SignalLab bridge READY records from the app log. */
export function parseAtomizerSignalLabReadyLog(
  text,
  source = DEFAULT_ATOMIZER_RENDERER_MEMORY_LOG_PATH,
) {
  if (typeof text !== 'string') throw new TypeError('Atomizer SignalLab READY log must be text');
  const normalizedSource = requireNonEmptyString(source, 'SignalLab READY log source');
  const records = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('{"type":"ready"')) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    // The dev launcher performs a separate build-time handshake whose READY is
    // immediately closed by this reserved request. It is not the app's admitted
    // instrument session and must never satisfy a live release gate.
    const nextJsonLine = lines.slice(index + 1).find((candidate) => candidate.startsWith('{'));
    let nextRecord = null;
    try { nextRecord = nextJsonLine ? JSON.parse(nextJsonLine) : null; } catch { /* Ignore. */ }
    if (nextRecord?.type === 'response'
      && nextRecord.requestId === 'atomizer-dev-launcher-validation'
      && nextRecord.result?.kind === 'shutdown') continue;
    if (value?.type !== 'ready'
      || value.protocol !== 'signal-lab-measurement-bridge'
      || value.contractId !== 'tinysa-signal-lab-atomizer-measurement'
      || value.contractVersion !== 1
      || value.service !== 'tinysa-signal-lab'
      || !validOpaqueSessionId(value.sessionId)
      || value.identity?.driverId !== 'signal-lab'
      || value.identity?.sourceKind !== 'signal-lab-simulation'
      || value.identity?.execution !== 'signal-lab-simulation'
      || value.identity?.transport !== 'signal-lab-measurement-bridge'
      || !validSignalLabHashes(value.identity)
      || !noPhysicalClaims(value.identity?.claims)) continue;
    records.push({
      sessionId: value.sessionId,
      driverId: 'signal-lab',
      identity: value.identity,
      source: normalizedSource,
      lineNumber: index + 1,
      recordKind: 'raw-ready-test-seam',
    });
  }
  return records;
}

/**
 * Bind the latest tagged admitted-session record and reject any later session
 * change. Set `minimumSessionLine` to one plus the prior log line count before
 * reconnecting when a release run must prove its record crossed that boundary.
 * Raw bridge READY parsing is available only through `allowRawReadyRecords` for
 * isolated parser/test seams; it is never the release default.
 */
export function createAtomizerLogSignalLabSessionInspector(options = {}) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('signalLabSessionLogOptions must be an object');
  }
  const logPath = resolve(options.logPath ?? DEFAULT_ATOMIZER_RENDERER_MEMORY_LOG_PATH);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const minimumSessionLine = options.minimumSessionLine ?? options.minimumReadyLine ?? 1;
  const expectedSessionId = options.expectedSessionId ?? null;
  const allowRawReadyRecords = options.allowRawReadyRecords ?? false;
  const readLog = options.readLog ?? ((path) => readFile(path, 'utf8'));
  const now = options.now ?? Date.now;
  const wait = options.wait ?? delay;
  requirePositiveSafeInteger(timeoutMs, 'SignalLab READY log timeoutMs');
  requirePositiveSafeInteger(pollIntervalMs, 'SignalLab READY log pollIntervalMs');
  requirePositiveSafeInteger(minimumSessionLine, 'SignalLab session log minimumSessionLine');
  if (expectedSessionId !== null
    && !validOpaqueSessionId(expectedSessionId)) {
    throw new TypeError('SignalLab READY log expectedSessionId must be an opaque UUID');
  }
  if (typeof allowRawReadyRecords !== 'boolean') {
    throw new TypeError('SignalLab session log allowRawReadyRecords must be a boolean');
  }
  if (typeof readLog !== 'function' || typeof now !== 'function' || typeof wait !== 'function') {
    throw new TypeError('SignalLab READY log readLog, now, and wait options must be functions');
  }
  let bound = null;
  return async function inspectAtomizerSignalLabSession() {
    const invokedAtMs = now();
    if (!Number.isFinite(invokedAtMs)) throw new Error('SignalLab READY inspector clock was not finite');
    const deadline = invokedAtMs + timeoutMs;
    let lastReadError = null;
    while (now() <= deadline) {
      try {
        const text = String(await readLog(logPath));
        const taggedRecords = parseAtomizerSignalLabSessionLog(text, logPath);
        const records = (taggedRecords.length > 0 || !allowRawReadyRecords
          ? taggedRecords
          : parseAtomizerSignalLabReadyLog(text, logPath))
          .filter(({ lineNumber }) => lineNumber >= minimumSessionLine);
        const latest = records.at(-1) ?? null;
        if (latest) {
          if (expectedSessionId !== null && latest.sessionId !== expectedSessionId) {
            throw new Error(
              `Latest SignalLab READY session ${latest.sessionId} did not match expected ${expectedSessionId}`,
            );
          }
          if (bound !== null && latest.sessionId !== bound.sessionId) {
            throw new Error(
              `SignalLab READY session changed from ${bound.sessionId} to ${latest.sessionId}`,
            );
          }
          bound = latest;
          return latest;
        }
        lastReadError = null;
      } catch (error) {
        if (/SignalLab READY session (?:changed|[0-9a-f-]+ did not match)/iu.test(errorMessage(error))) {
          throw error;
        }
        lastReadError = error;
      }
      await wait(pollIntervalMs);
    }
    const suffix = lastReadError
      ? `; last log read failed: ${errorMessage(lastReadError)}`
      : '';
    throw new Error(
      `Timed out after ${timeoutMs} ms waiting for an admitted SignalLab session record at/after line ${minimumSessionLine} in ${logPath}${suffix}`,
    );
  };
}

/**
 * Return a sampler that waits for a renderer-memory record written after each
 * checkpoint invocation. This prevents a pre-run tail record from being
 * replayed as fresh evidence and is the default when no custom sampler exists.
 */
export function createAtomizerLogRendererMemorySampler(options = {}) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('rendererMemoryLogOptions must be an object');
  }
  const logPath = resolve(options.logPath ?? DEFAULT_ATOMIZER_RENDERER_MEMORY_LOG_PATH);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const readLog = options.readLog ?? ((path) => readFile(path, 'utf8'));
  const now = options.now ?? Date.now;
  const wait = options.wait ?? delay;
  requirePositiveSafeInteger(timeoutMs, 'renderer-memory log timeoutMs');
  requirePositiveSafeInteger(pollIntervalMs, 'renderer-memory log pollIntervalMs');
  if (typeof readLog !== 'function' || typeof now !== 'function' || typeof wait !== 'function') {
    throw new TypeError('renderer-memory log readLog, now, and wait options must be functions');
  }
  let lastReturnedCapturedMs = Number.NEGATIVE_INFINITY;
  return async function sampleFreshAtomizerRendererMemory() {
    const invokedAtMs = now();
    if (!Number.isFinite(invokedAtMs)) throw new Error('renderer-memory sampler clock was not finite');
    const deadline = invokedAtMs + timeoutMs;
    let lastReadError = null;
    while (now() <= deadline) {
      try {
        const samples = parseAtomizerRendererMemoryLog(String(await readLog(logPath)), logPath);
        const sample = samples.find(({ capturedAt }) => {
          const capturedMs = Date.parse(capturedAt);
          return capturedMs >= invokedAtMs && capturedMs > lastReturnedCapturedMs;
        });
        if (sample) {
          lastReturnedCapturedMs = Date.parse(sample.capturedAt);
          return sample;
        }
        lastReadError = null;
      } catch (error) {
        lastReadError = error;
      }
      await wait(pollIntervalMs);
    }
    const suffix = lastReadError
      ? `; last log read failed: ${errorMessage(lastReadError)}`
      : '';
    throw new Error(
      `Timed out after ${timeoutMs} ms waiting for a fresh renderer-memory record in ${logPath}${suffix}`,
    );
  };
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function validOpaqueSessionId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function validSignalLabHashes(value) {
  return ['contractSha256', 'catalogSha256', 'generatorSha256'].every((field) => (
    typeof value?.[field] === 'string' && /^[a-f0-9]{64}$/u.test(value[field])
  ));
}

function noPhysicalClaims(value) {
  return value?.usbEmulated === false
    && value.firmwareExecuted === false
    && value.rfEmitted === false;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
