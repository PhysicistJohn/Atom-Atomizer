'use strict';

const MAX_RENDERER_CONSOLE_MESSAGE_CHARACTERS = 4_096;
const MAX_RENDERER_SOURCE_CHARACTERS = 1_024;
const MAX_RENDERER_LOAD_DESCRIPTION_CHARACTERS = 1_024;
const MAX_RENDERER_LOAD_URL_CHARACTERS = 2_048;

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

module.exports = {
  MAX_RENDERER_CONSOLE_MESSAGE_CHARACTERS,
  MAX_RENDERER_LOAD_DESCRIPTION_CHARACTERS,
  MAX_RENDERER_LOAD_URL_CHARACTERS,
  boundedErrorMessage,
  normalizeRendererConsoleMessage,
  normalizeRendererLoadFailure,
  rendererGoneDiagnostic,
  rendererProcessMetricSnapshot,
};
