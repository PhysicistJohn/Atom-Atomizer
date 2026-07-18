'use strict';

const MAX_RENDERER_CONSOLE_MESSAGE_CHARACTERS = 4_096;
const MAX_RENDERER_SOURCE_CHARACTERS = 1_024;
const MAX_RENDERER_LOAD_DESCRIPTION_CHARACTERS = 1_024;
const MAX_RENDERER_LOAD_URL_CHARACTERS = 2_048;
const SIGNAL_LAB_SESSION_CONSOLE_PREFIX = '[ATOMIZER-SIGNAL-LAB-SESSION] ';
const SIGNAL_LAB_SESSION_LOG_LEVEL = 'ATOMIZER-SIGNAL-LAB-SESSION';

function normalizeRendererConsoleMessage(details, legacyLevel, legacyMessage, legacyLine, legacySourceId) {
  const modern = details && typeof details === 'object' && typeof details.message === 'string';
  const rawLevel = modern ? details.level : legacyLevel;
  const rawMessage = modern ? details.message : legacyMessage;
  const rawLine = modern ? details.lineNumber : legacyLine;
  const rawSourceId = modern ? details.sourceId : legacySourceId;
  return Object.freeze({
    level: normalizeConsoleLevel(rawLevel),
    message: boundConsoleMessage(rawMessage),
    line: finiteInteger(rawLine),
    sourceId: boundSourceId(rawSourceId),
  });
}

/**
 * Promote only a validated, redacted SignalLab admission record into its own
 * one-line launcher log record. Every other renderer message retains the
 * ordinary bounded diagnostic shape.
 */
function routeRendererConsoleMessage(details, legacyLevel, legacyMessage, legacyLine, legacySourceId) {
  const normalized = normalizeRendererConsoleMessage(
    details,
    legacyLevel,
    legacyMessage,
    legacyLine,
    legacySourceId,
  );
  const fallback = Object.freeze({ level: 'RENDERER', value: normalized });
  if (normalized.level !== 'info'
    || !normalized.message.startsWith(SIGNAL_LAB_SESSION_CONSOLE_PREFIX)) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(normalized.message.slice(SIGNAL_LAB_SESSION_CONSOLE_PREFIX.length));
  } catch {
    return fallback;
  }
  const admission = normalizeSignalLabSessionAdmission(parsed);
  return admission === undefined
    ? fallback
    : Object.freeze({ level: SIGNAL_LAB_SESSION_LOG_LEVEL, value: JSON.stringify(admission) });
}

function normalizeSignalLabSessionAdmission(value) {
  const provenance = value?.provenance;
  const claims = provenance?.claims;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1
    || value.event !== 'admitted'
    || value.driverId !== 'signal-lab'
    || !isUuid(value.sessionId)
    || provenance?.sourceKind !== 'signal-lab'
    || !isBoundedNonEmptyString(provenance.sourceId, 256)
    || provenance.execution !== 'signal-lab-simulation'
    || provenance.transport !== 'signal-lab-measurement-bridge'
    || provenance.qualification !== 'synthetic-visual-projection'
    || provenance.contractId !== 'tinysa-signal-lab-atomizer-measurement'
    || provenance.contractVersion !== 1
    || !isSha256(provenance.contractSha256)
    || !isSha256(provenance.catalogSha256)
    || !isSha256(provenance.generatorSha256)
    || claims?.usbEmulated !== false
    || claims?.firmwareExecuted !== false
    || claims?.rfEmitted !== false) return undefined;

  // Rebuild from a fixed allow-list so renderer data outside this evidence
  // contract (candidate, device, serial details, capabilities, etc.) cannot be
  // promoted into the admitted-session log record.
  return Object.freeze({
    schemaVersion: 1,
    event: 'admitted',
    sessionId: value.sessionId,
    driverId: 'signal-lab',
    provenance: Object.freeze({
      sourceKind: 'signal-lab',
      sourceId: provenance.sourceId,
      execution: 'signal-lab-simulation',
      transport: 'signal-lab-measurement-bridge',
      qualification: 'synthetic-visual-projection',
      contractId: 'tinysa-signal-lab-atomizer-measurement',
      contractVersion: 1,
      contractSha256: provenance.contractSha256,
      catalogSha256: provenance.catalogSha256,
      generatorSha256: provenance.generatorSha256,
      claims: Object.freeze({
        usbEmulated: false,
        firmwareExecuted: false,
        rfEmitted: false,
      }),
    }),
  });
}

function rendererProcessMetricSnapshot(metrics, osProcessId) {
  if (!Array.isArray(metrics) || !Number.isSafeInteger(osProcessId) || osProcessId < 1) return undefined;
  const metric = metrics.find((candidate) => candidate && candidate.pid === osProcessId);
  if (!metric || typeof metric !== 'object') return undefined;
  return Object.freeze({
    type: boundedString(metric.type, 32),
    name: boundedString(metric.name, 128),
    creationTime: finiteNumber(metric.creationTime),
    cpuPercent: finiteNumber(metric.cpu?.percentCPUUsage),
    idleWakeupsPerSecond: finiteNumber(metric.cpu?.idleWakeupsPerSecond),
    workingSetKb: finiteNumber(metric.memory?.workingSetSize),
    peakWorkingSetKb: finiteNumber(metric.memory?.peakWorkingSetSize),
    privateBytesKb: finiteNumber(metric.memory?.privateBytes),
  });
}

function normalizeRendererLoadFailure(code, description, url, isMainFrame) {
  return Object.freeze({
    code: finiteInteger(code),
    description: boundedString(description, MAX_RENDERER_LOAD_DESCRIPTION_CHARACTERS) ?? '',
    url: boundDiagnosticUrl(url),
    isMainFrame: isMainFrame === true,
  });
}

function rendererGoneDiagnostic(details, context) {
  return Object.freeze({
    webContentsId: finiteInteger(context?.webContentsId),
    osProcessId: finiteInteger(context?.osProcessId),
    reason: boundedString(details?.reason, 64),
    exitCode: finiteInteger(details?.exitCode),
    currentMetric: context?.currentMetric,
    lastMemorySample: context?.lastMemorySample,
    crashDumpsPath: boundedString(context?.crashDumpsPath, 2_048),
  });
}

function boundedErrorMessage(error) {
  return boundedString(error instanceof Error ? error.message : error, 1_024) ?? 'unknown error';
}

function normalizeConsoleLevel(value) {
  if (typeof value === 'string') {
    if (value === 'debug' || value === 'info' || value === 'warning' || value === 'error') return value;
    return 'unknown';
  }
  return ['debug', 'info', 'warning', 'error'][finiteInteger(value) ?? -1] ?? 'unknown';
}

function boundConsoleMessage(value) {
  if (typeof value !== 'string') return '';
  if (value.includes('data:image/')) return `[renderer console message omitted because it contains image data; characters=${value.length}]`;
  if (value.length <= MAX_RENDERER_CONSOLE_MESSAGE_CHARACTERS) return value;
  return `${value.slice(0, MAX_RENDERER_CONSOLE_MESSAGE_CHARACTERS)}…[${value.length - MAX_RENDERER_CONSOLE_MESSAGE_CHARACTERS} characters truncated]`;
}

function boundSourceId(value) {
  if (typeof value !== 'string') return '';
  const withoutQuery = value.split(/[?#]/u, 1)[0] ?? '';
  return withoutQuery.length <= MAX_RENDERER_SOURCE_CHARACTERS
    ? withoutQuery
    : `${withoutQuery.slice(0, MAX_RENDERER_SOURCE_CHARACTERS)}…`;
}

function boundDiagnosticUrl(value) {
  if (typeof value !== 'string') return '';
  const withoutQueryOrFragment = value.split(/[?#]/u, 1)[0] ?? '';
  const withoutCredentials = withoutQueryOrFragment.replace(
    /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/u,
    '$1<credentials>@',
  );
  return boundedString(withoutCredentials, MAX_RENDERER_LOAD_URL_CHARACTERS) ?? '';
}

function boundedString(value, maximumCharacters) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length <= maximumCharacters ? value : `${value.slice(0, maximumCharacters)}…`;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function finiteInteger(value) {
  return Number.isSafeInteger(value) ? value : undefined;
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isBoundedNonEmptyString(value, maximumCharacters) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumCharacters && /\S/u.test(value);
}

module.exports = {
  MAX_RENDERER_CONSOLE_MESSAGE_CHARACTERS,
  MAX_RENDERER_LOAD_DESCRIPTION_CHARACTERS,
  MAX_RENDERER_LOAD_URL_CHARACTERS,
  boundedErrorMessage,
  normalizeRendererConsoleMessage,
  normalizeRendererLoadFailure,
  rendererGoneDiagnostic,
  rendererProcessMetricSnapshot,
  routeRendererConsoleMessage,
};
