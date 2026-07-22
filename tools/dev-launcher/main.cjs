'use strict';

const { app, BrowserWindow, crashReporter, dialog } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync } = require('node:fs');
const { request } = require('node:http');
const { homedir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { inspect } = require('node:util');
const { appendBoundedLogSync } = require('./bounded-log.cjs');
const { requirePrivateEnvironmentFile } = require('./private-environment-file.cjs');
const {
  boundedErrorMessage,
  normalizeRendererLoadFailure,
  rendererGoneDiagnostic,
  rendererProcessMetricSnapshot,
  routeRendererConsoleMessage,
} = require('./renderer-diagnostics.cjs');

const APP_NAME = 'Atomizer Dev';
const LAUNCHER_CONTRACT_VERSION = 4;
const SIGNAL_LAB_INSTRUMENT_POLICY = 'signal-lab-default-no-fallback';
const LOG_FILE = join(homedir(), 'Library', 'Logs', `${APP_NAME}.log`);
const STARTUP_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 150;
const RENDERER_MEMORY_SAMPLE_INTERVAL_MS = 15_000;

let viteProcess;
let quitting = false;
let crashDumpsPath;

mkdirSync(dirname(LOG_FILE), { recursive: true });

function formatLogValue(value) {
  const formatted = typeof value === 'string' ? value : inspect(value, { depth: 6, breakLength: 140 });
  const bytes = Buffer.from(formatted, 'utf8');
  if (bytes.length <= 8 * 1024) return formatted;
  return `${bytes.subarray(0, 8 * 1024).toString('utf8')}…[field truncated]`;
}

function log(level, ...values) {
  const line = `${new Date().toISOString()} [${level}] ${values.map(formatLogValue).join(' ')}\n`;
  appendBoundedLogSync(LOG_FILE, line);
}

function startLocalCrashReporter() {
  crashReporter.start({
    productName: APP_NAME,
    uploadToServer: false,
    globalExtra: {
      atomizer_mode: 'live-development',
      launcher_contract: String(LAUNCHER_CONTRACT_VERSION),
    },
  });
  crashDumpsPath = app.getPath('crashDumps');
  log('CRASH-REPORTER', {
    uploadToServer: crashReporter.getUploadToServer(),
    crashDumpsPath,
  });
}

function attachRendererDiagnostics(contents) {
  let lastMemorySample;

  const sampleMemory = (reason) => {
    if (contents.isDestroyed()) return;
    let osProcessId;
    try {
      osProcessId = contents.getOSProcessId();
      lastMemorySample = Object.freeze({
        reason,
        webContentsId: contents.id,
        osProcessId,
        metric: rendererProcessMetricSnapshot(app.getAppMetrics(), osProcessId),
      });
      log('RENDERER-MEMORY', lastMemorySample);
    } catch (error) {
      if (reason !== 'periodic') {
        log('RENDERER-MEMORY-UNAVAILABLE', {
          reason,
          webContentsId: contents.id,
          osProcessId,
          error: boundedErrorMessage(error),
        });
      }
    }
  };

  contents.on('console-message', (...args) => {
    const routed = routeRendererConsoleMessage(...args);
    log(routed.level, routed.value);
  });
  contents.on('did-finish-load', () => sampleMemory('did-finish-load'));
  contents.on('did-fail-load', (_loadEvent, code, description, url, isMainFrame) => log('RENDERER-LOAD', normalizeRendererLoadFailure(code, description, url, isMainFrame)));
  contents.on('render-process-gone', (_goneEvent, details) => {
    let osProcessId;
    try { osProcessId = contents.getOSProcessId(); } catch { /* Process is already gone. */ }
    log('RENDERER-GONE', rendererGoneDiagnostic(details, {
      webContentsId: contents.id,
      osProcessId,
      currentMetric: rendererProcessMetricSnapshot(app.getAppMetrics(), osProcessId),
      lastMemorySample,
      crashDumpsPath,
    }));
  });
  contents.on('preload-error', (_preloadEvent, preloadPath, error) => log('PRELOAD', { preloadPath, error: boundedErrorMessage(error) }));

  const memoryTimer = setInterval(() => sampleMemory('periodic'), RENDERER_MEMORY_SAMPLE_INTERVAL_MS);
  memoryTimer.unref?.();
  contents.once('destroyed', () => clearInterval(memoryTimer));
}

function requireExactObject(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const contractKeys = [...expectedKeys].sort();
  if (actualKeys.length !== contractKeys.length || actualKeys.some((key, index) => key !== contractKeys[index])) {
    throw new TypeError(`${label} keys must be exactly: ${contractKeys.join(', ')}`);
  }
  return value;
}

function readJson(file, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is unreadable or invalid JSON at ${file}: ${formatLogValue(error)}`);
  }
  return parsed;
}

function loadContract() {
  const installFile = join(__dirname, 'launcher-config.json');
  const install = requireExactObject(
    readJson(installFile, 'Installed launcher contract'),
    ['contractVersion', 'repoRoot'],
    'Installed launcher contract',
  );
  if (install.contractVersion !== LAUNCHER_CONTRACT_VERSION) {
    throw new Error(`Installed launcher contract version must be ${LAUNCHER_CONTRACT_VERSION}`);
  }
  if (typeof install.repoRoot !== 'string' || !install.repoRoot.startsWith('/')) {
    throw new TypeError('Installed launcher repoRoot must be an absolute path');
  }

  const repoRoot = resolve(install.repoRoot);
  const runtimeFile = join(repoRoot, 'tools', 'dev-launcher', 'config.json');
  const runtime = requireExactObject(
    readJson(runtimeFile, 'Development runtime contract'),
    ['contractVersion', 'instrumentPolicy', 'port'],
    'Development runtime contract',
  );
  if (runtime.contractVersion !== LAUNCHER_CONTRACT_VERSION) {
    throw new Error(`Development runtime contract version must be ${LAUNCHER_CONTRACT_VERSION}`);
  }
  if (runtime.instrumentPolicy !== SIGNAL_LAB_INSTRUMENT_POLICY) {
    throw new TypeError(`instrumentPolicy must be exactly "${SIGNAL_LAB_INSTRUMENT_POLICY}"`);
  }
  if (!Number.isInteger(runtime.port) || runtime.port < 1024 || runtime.port > 65535) {
    throw new TypeError('port must be an integer from 1024 through 65535');
  }

  const environmentFile = join(repoRoot, '.env');
  requirePrivateEnvironmentFile(environmentFile);
  const requiredPaths = [
    'package.json',
    'apps/desktop/node_modules/electron/package.json',
    'node_modules/tsup/dist/cli-default.js',
    'node_modules/vite/bin/vite.js',
    'apps/desktop/src/main/main.ts',
    'apps/desktop/src/main/preload.ts',
    'apps/desktop/vite.config.ts',
    // The in-process SignalLab driver bundles these sibling-repo sources.
    '../Atom-SignalLab/src/measurement-service.ts',
    '../Atom-SignalLab/contracts/signal-lab-measurement-bridge-v1.json',
  ];
  for (const relativePath of requiredPaths) {
    const absolutePath = join(repoRoot, relativePath);
    if (!existsSync(absolutePath)) throw new Error(`Required development file is missing: ${absolutePath}`);
  }

  return Object.freeze({
    repoRoot,
    environmentFile,
    instrumentPolicy: runtime.instrumentPolicy,
    port: runtime.port,
    devServerUrl: `http://localhost:${runtime.port}`,
  });
}

function appendProcessOutput(result) {
  if (result.stdout) appendBoundedLogSync(LOG_FILE, result.stdout);
  if (result.stderr) appendBoundedLogSync(LOG_FILE, result.stderr);
}

function electronNodeEnvironment(extra = {}) {
  return {
    ...process.env,
    ...extra,
    ELECTRON_RUN_AS_NODE: '1',
    FORCE_COLOR: '0',
  };
}

function runBuild(contract, label, cwd, args) {
  log('BUILD', label);
  const cli = join(contract.repoRoot, 'node_modules', 'tsup', 'dist', 'cli-default.js');
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: electronNodeEnvironment(),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  appendProcessOutput(result);
  if (result.error) throw new Error(`${label} could not start: ${formatLogValue(result.error)}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${String(result.status)}. See ${LOG_FILE}`);
}

function buildDevelopmentEntries(contract) {
  const packageBuilds = [
    ['contracts', []],
    ['instrument-runtime', []],
    ['analysis', []],
    ['agent', []],
    ['tinysa', ['--external', 'serialport', '--external', '@tinysa/instrument-runtime']],
    ['test-device', []],
  ];
  for (const [packageDirectory, extraArgs] of packageBuilds) {
    const cwd = join(contract.repoRoot, 'packages', packageDirectory);
    runBuild(contract, `Building ${packageDirectory}`, cwd, ['src/index.ts', '--format', 'esm', ...extraArgs]);
  }

  const desktop = join(contract.repoRoot, 'apps', 'desktop');
  runBuild(contract, 'Building Electron main process', desktop, [
    'src/main/main.ts', '--format', 'esm', '--out-dir', 'dist/main', '--external', 'electron', '--external', 'serialport',
  ]);
  runBuild(contract, 'Building Electron preload', desktop, [
    'src/main/preload.ts', '--format', 'cjs', '--out-dir', 'dist/main', '--external', 'electron',
  ]);
}

function stopVite() {
  if (!viteProcess || viteProcess.exitCode !== null || viteProcess.killed) return;
  log('VITE', `Stopping development server pid=${viteProcess.pid}`);
  viteProcess.kill('SIGTERM');
}

function waitForVite(child, contract) {
  return new Promise((resolveReady, rejectReady) => {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      child.off('exit', handleExit);
      if (error) rejectReady(error);
      else resolveReady();
    };
    const handleExit = (code, signal) => {
      finish(new Error(`Vite exited before becoming ready (code=${String(code)}, signal=${String(signal)}). See ${LOG_FILE}`));
    };
    const probe = () => {
      const probeRequest = request(contract.devServerUrl, { method: 'GET', timeout: 750 }, (response) => {
        response.resume();
        if (response.statusCode === 200) finish();
      });
      probeRequest.on('timeout', () => probeRequest.destroy());
      probeRequest.on('error', () => {});
      probeRequest.end();
    };

    child.once('exit', handleExit);
    const pollTimer = setInterval(probe, POLL_INTERVAL_MS);
    const timeoutTimer = setTimeout(() => {
      finish(new Error(`Vite did not become ready at ${contract.devServerUrl} within ${STARTUP_TIMEOUT_MS}ms. See ${LOG_FILE}`));
    }, Math.max(0, deadline - Date.now()));
    probe();
  });
}

async function startVite(contract) {
  const viteCli = join(contract.repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const desktop = join(contract.repoRoot, 'apps', 'desktop');
  viteProcess = spawn(process.execPath, [viteCli, '--strictPort', '--host', 'localhost', '--port', String(contract.port)], {
    cwd: desktop,
    env: electronNodeEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  viteProcess.stdout.on('data', (chunk) => appendBoundedLogSync(LOG_FILE, chunk));
  viteProcess.stderr.on('data', (chunk) => appendBoundedLogSync(LOG_FILE, chunk));
  viteProcess.on('error', (error) => log('ERROR', 'Vite process error', error));
  log('VITE', `Starting pid=${viteProcess.pid} url=${contract.devServerUrl}`);
  await waitForVite(viteProcess, contract);
  log('VITE', `Ready at ${contract.devServerUrl}`);
}

function focusApplication() {
  const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (!window) {
    app.focus({ steal: true });
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function launch() {
  const contract = loadContract();
  log('START', `${APP_NAME} launcher contract`, contract);
  startLocalCrashReporter();
  process.chdir(contract.repoRoot);
  process.env.NODE_ENV = 'development';
  process.env.VITE_DEV_SERVER_URL = contract.devServerUrl;
  process.env.TINYSA_ENV_FILE = contract.environmentFile;
  delete process.env.TINYSA_FIRMWARE_REPO;
  delete process.env.TINYSA_SIMULATOR;

  buildDevelopmentEntries(contract);
  await startVite(contract);
  await app.whenReady();
  app.on('web-contents-created', (_event, contents) => {
    attachRendererDiagnostics(contents);
  });
  const icon = join(process.resourcesPath, 'atomizer-dev.png');
  if (!existsSync(icon)) throw new Error(`Installed application icon is missing: ${icon}`);
  app.dock.setIcon(icon);

  const mainEntry = join(contract.repoRoot, 'apps', 'desktop', 'dist', 'main', 'main.js');
  // Builds can take long enough for local metadata to change. Revalidate the
  // exact path consumed by Electron main immediately before importing it.
  requirePrivateEnvironmentFile(contract.environmentFile);
  log('ELECTRON', `Importing ${mainEntry} with ${contract.instrumentPolicy} (SignalLab in-process)`);
  await import(pathToFileURL(mainEntry).href);
}

function failLoudly(error) {
  const message = error instanceof Error ? error.message : formatLogValue(error);
  log('FATAL', error);
  dialog.showErrorBox(`${APP_NAME} failed to launch`, `${message}\n\nFull startup log:\n${LOG_FILE}`);
  process.exitCode = 1;
  // Once the imported application owns an instrument, app.quit() must pass
  // through its RF-safe before-quit gate. will-quit stops Vite only after that
  // gate admits the exit; pre-import startup failures still quit normally.
  app.quit();
}

app.setName(APP_NAME);
app.setPath('userData', join(app.getPath('appData'), APP_NAME));
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', focusApplication);
  app.on('activate', focusApplication);
  // The imported application may prevent before-quit while it performs its
  // RF-safe disconnect. Keep the live-edit server available if that shutdown
  // fails and the application restores its window for a retry.
  app.on('will-quit', () => {
    quitting = true;
    stopVite();
  });
  process.on('uncaughtException', failLoudly);
  process.on('unhandledRejection', failLoudly);
  log('START', `\n${'='.repeat(72)}\nLaunching from ${process.resourcesPath}`);
  void launch().catch(failLoudly);
}

process.on('exit', () => {
  if (!quitting) stopVite();
});
