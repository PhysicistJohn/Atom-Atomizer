import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import {
  OEM_ZS407_FIRMWARE_RELEASE,
  firmwareFlashRequestSchema,
  firmwareUpdateJournalSchema,
  firmwareUpdatePreflightSchema,
  type DeviceDiagnostics,
  type DeviceSnapshot,
  type FirmwareFlashRequest,
  type FirmwareUpdatePreflight,
  type FirmwareUpdateState,
  type PortCandidate,
  type ScreenFrame,
} from '@tinysa/contracts';

const MINIMUM_UPDATE_BATTERY_MV = 4_000;
const DFU_CONFIRMATION_OUTPUT = /Download done[.\s]|File downloaded successfully/i;
export const FIRMWARE_UPDATE_JOURNAL_FILENAME = 'firmware-update-journal-v1.json' as const;

interface FirmwareUpdateDevice {
  snapshot(): DeviceSnapshot;
  readDiagnostics(): Promise<DeviceDiagnostics>;
  captureScreen(): Promise<ScreenFrame>;
  disconnect(): Promise<void>;
  listDevices(): Promise<PortCandidate[]>;
  connect(candidate: PortCandidate): Promise<DeviceSnapshot>;
}

export class FirmwareUpdater {
  readonly #artifactPath: string;
  readonly #journalPath: string;
  #dfuUtilityPath?: string;
  #journalLoaded = false;
  #state: FirmwareUpdateState = initialState();

  constructor(private readonly cacheDirectory: string, private readonly device: FirmwareUpdateDevice) {
    this.#artifactPath = join(cacheDirectory, `${OEM_ZS407_FIRMWARE_RELEASE.version}.bin`);
    this.#journalPath = join(cacheDirectory, FIRMWARE_UPDATE_JOURNAL_FILENAME);
  }

  async state(): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#synchronizeDevice();
    if (this.#state.phase === 'available' && !this.#state.artifact) await this.#inspectCachedArtifact();
    if (this.#state.phase !== 'flashing' && this.#state.phase !== 'reconnecting') await this.#inspectDfuUtility();
    return structuredClone(this.#state);
  }

  async download(): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#requireWriteNotStarted();
    this.#requireOutdatedPhysicalDevice();
    this.#state = { ...this.#state, phase: 'downloading', error: undefined, artifact: undefined };
    const temporaryPath = `${this.#artifactPath}.${randomUUID()}.part`;
    try {
      const response = await fetch(OEM_ZS407_FIRMWARE_RELEASE.downloadUrl, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/octet-stream' },
      });
      if (!response.ok) throw new Error(`OEM firmware server returned HTTP ${response.status}`);
      const declaredLength = response.headers.get('content-length');
      if (declaredLength !== String(OEM_ZS407_FIRMWARE_RELEASE.sizeBytes)) {
        throw new Error(`OEM firmware Content-Length ${declaredLength ?? 'missing'} does not match pinned ${OEM_ZS407_FIRMWARE_RELEASE.sizeBytes}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      verifyFirmwareArtifact(bytes);
      await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, this.#artifactPath);
      this.#state = {
        ...this.#state,
        phase: 'verified',
        artifact: { sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes, sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256, verifiedAt: new Date().toISOString() },
        error: undefined,
      };
      return structuredClone(this.#state);
    } catch (value) {
      let cleanupFailure: unknown;
      try { await rm(temporaryPath, { force: true }); } catch (cleanupValue) { cleanupFailure = cleanupValue; }
      const cleanup = cleanupFailure ? `. Temporary artifact cleanup also failed: ${message(cleanupFailure)}` : '';
      throw await this.#fail(`Firmware download verification failed: ${message(value)}${cleanup}`);
    }
  }

  async prepare(input: FirmwareUpdatePreflight): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#requireWriteNotStarted();
    const preflight = firmwareUpdatePreflightSchema.parse(input);
    this.#requireOutdatedPhysicalDevice();
    if (this.#state.phase !== 'verified' || !this.#state.artifact) throw new Error('The pinned OEM firmware must be downloaded and verified before preparation');
    try {
      const diagnostics = await this.device.readDiagnostics();
      if (diagnostics.identity.execution !== 'physical' || !diagnostics.identity.usbIdentityVerified) throw new Error('Preflight diagnostics did not retain verified physical USB identity');
      if (diagnostics.telemetry.batteryMillivolts < MINIMUM_UPDATE_BATTERY_MV) {
        throw new Error(`Battery is ${diagnostics.telemetry.batteryMillivolts} mV; firmware update requires at least ${MINIMUM_UPDATE_BATTERY_MV} mV`);
      }
      const screen = await this.device.captureScreen();
      const preparation = {
        id: randomUUID(),
        preparedAt: new Date().toISOString(),
        batteryMillivolts: diagnostics.telemetry.batteryMillivolts,
        deviceId: diagnostics.telemetry.deviceId,
        screenSha256: sha256(screen.pixels),
        ...preflight,
      } as const;
      await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
      await writeFile(join(this.cacheDirectory, `preflight-${preparation.id}.json`), JSON.stringify({
        schemaVersion: 1,
        target: OEM_ZS407_FIRMWARE_RELEASE,
        preparation,
        identity: diagnostics.identity,
        firmwareVersionResponse: diagnostics.firmwareVersionResponse,
        infoLines: diagnostics.infoLines,
        commands: diagnostics.commands,
        analyzerReadback: diagnostics.analyzerReadback,
        telemetry: diagnostics.telemetry,
        artifact: this.#state.artifact,
      }, null, 2), { flag: 'wx', mode: 0o600 });
      this.#state = { ...this.#state, phase: 'awaiting-dfu', preparation, dfuDevice: { detected: false, count: 0 }, error: undefined };
      await this.#persistJournal();
      await this.device.disconnect();
      return structuredClone(this.#state);
    } catch (value) {
      throw await this.#fail(`Firmware preflight failed: ${message(value)}`);
    }
  }

  async detectDfu(): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#requireWriteNotStarted();
    if (!this.#state.preparation) throw new Error('Firmware update has no completed preflight record');
    try {
      const utility = await this.#requireDfuUtility();
      const listing = await runExecutable(utility, ['-l'], 15_000);
      const inspection = inspectStm32DfuDevices(`${listing.stdout}\n${listing.stderr}`);
      if (inspection.deviceCount > 1) throw new Error(`Detected ${inspection.deviceCount} STM32 DFU devices; exactly one physical device is required`);
      if (inspection.deviceCount === 1 && inspection.targets.length !== 1) throw new Error(`The STM32 DFU device exposes ${inspection.targets.length} exact alt-0 internal-flash targets; exactly one is required`);
      const detected = inspection.deviceCount === 1 && inspection.targets.length === 1;
      this.#state = {
        ...this.#state,
        phase: detected ? 'ready-to-flash' : 'awaiting-dfu',
        dfuDevice: { detected, count: inspection.deviceCount },
        error: undefined,
      };
      await this.#persistJournal();
      return structuredClone(this.#state);
    } catch (value) {
      throw await this.#fail(`DFU detection failed: ${message(value)}`);
    }
  }

  async flash(input: FirmwareFlashRequest): Promise<FirmwareUpdateState> {
    await this.#loadJournal();
    this.#requireWriteNotStarted();
    const request = firmwareFlashRequestSchema.parse(input);
    const preparation = this.#state.preparation;
    if (!preparation || preparation.id !== request.preparationId) throw new Error('Firmware flash preparation token does not match');
    if (this.#state.phase !== 'ready-to-flash' || !this.#state.dfuDevice.detected || this.#state.dfuDevice.count !== 1) {
      throw new Error('Exactly one verified STM32 DFU internal-flash target is required before flashing');
    }
    try {
      const utility = await this.#requireDfuUtility();
      verifyFirmwareArtifact(new Uint8Array(await readFile(this.#artifactPath)));
      const writeStartedAt = new Date().toISOString();
      this.#state = {
        ...this.#state,
        phase: 'flashing',
        writeDisposition: 'started',
        writeStartedAt,
        flashProgress: { stage: 'preparing', percent: 0, updatedAt: writeStartedAt },
        error: undefined,
      };
      await this.#persistJournal();
      await this.#writeResultAudit('write-started', { preparationId: preparation.id, writeStartedAt });
      const result = await runDfuExecutable(
        utility,
        ['-d', '0483:df11', '-a', '0', '-s', '0x08000000:leave', '-D', this.#artifactPath],
        120_000,
        (progress) => {
          const stage = progress.operation === 'erase' ? 'erasing' : 'writing';
          const percent = progress.operation === 'erase'
            ? Math.round(progress.percent * 0.4)
            : 40 + Math.round(progress.percent * 0.55);
          this.#state = {
            ...this.#state,
            flashProgress: { stage, percent, stagePercent: progress.percent, updatedAt: new Date().toISOString() },
          };
        },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      if (!DFU_CONFIRMATION_OUTPUT.test(output)) throw new Error('dfu-util exited without its successful-download confirmation');
      const writeCompletedAt = new Date().toISOString();
      this.#state = {
        ...this.#state,
        phase: 'reconnecting',
        writeDisposition: 'completed',
        writeCompletedAt,
        flashProgress: { stage: 'verifying-reboot', percent: 98, stagePercent: 100, updatedAt: writeCompletedAt },
      };
      await this.#persistJournal();
      await this.#writeResultAudit('write-complete', { preparationId: preparation.id, writeCompletedAt, output: bounded(output) });

      const candidate = await this.#waitForOnePhysicalDevice();
      const connected = await this.device.connect(candidate);
      if (connected.identity?.firmwareReportedRevision !== OEM_ZS407_FIRMWARE_RELEASE.revision || connected.identity.firmwareSourceCommit !== OEM_ZS407_FIRMWARE_RELEASE.sourceCommit) {
        const identityError = `Post-flash identity is ${connected.identity?.firmwareVersion ?? 'missing'}, expected ${OEM_ZS407_FIRMWARE_RELEASE.version}`;
        try { await this.device.disconnect(); }
        catch (disconnectFailure) { throw new Error(`${identityError}. Disconnect also failed: ${message(disconnectFailure)}`, { cause: disconnectFailure }); }
        throw new Error(identityError);
      }
      const completedAt = new Date().toISOString();
      this.#state = {
        ...this.#state,
        phase: 'completed',
        updateAvailable: false,
        current: { version: connected.identity.firmwareVersion, revision: connected.identity.firmwareReportedRevision, sourceCommit: connected.identity.firmwareSourceCommit },
        flashProgress: { stage: 'complete', percent: 100, stagePercent: 100, updatedAt: completedAt },
        completedAt,
        error: undefined,
      };
      await this.#writeResultAudit('verified-complete', { preparationId: preparation.id, writeCompletedAt, completedAt, identity: connected.identity });
      await this.#persistJournal();
      return structuredClone(this.#state);
    } catch (value) {
      const prefix = this.#state.writeDisposition === 'not-started'
        ? 'Firmware flash failed before any write attempt began'
        : this.#state.writeDisposition === 'completed'
          ? 'Firmware write completed but post-flash verification failed; do not flash again'
          : 'Firmware write may have begun but completion is unverified; do not flash again';
      throw await this.#fail(`${prefix}: ${message(value)}`);
    }
  }

  async #loadJournal(): Promise<void> {
    if (this.#journalLoaded) return;
    this.#journalLoaded = true;
    try {
      const journal = firmwareUpdateJournalSchema.parse(JSON.parse(await readFile(this.#journalPath, 'utf8')));
      this.#state = journal.state;
      if (this.#state.phase === 'ready-to-flash') {
        this.#state = { ...this.#state, phase: 'awaiting-dfu', dfuDevice: { detected: false, count: 0 }, error: undefined };
        await this.#persistJournal();
      } else if (this.#state.phase === 'flashing' || this.#state.phase === 'reconnecting') {
        this.#state = {
          ...this.#state,
          phase: 'failed',
          error: this.#state.writeDisposition === 'completed'
            ? 'The previous Atomizer process ended after firmware bytes were written. Do not flash again; verify the rebooted USB identity.'
            : 'The previous Atomizer process ended after the firmware write attempt began. Completion is unknown; do not flash again.',
        };
        await this.#persistJournal();
      }
    } catch (value) {
      if (isFileMissing(value)) return;
      this.#state = {
        ...initialState(),
        phase: 'failed',
        writeDisposition: 'indeterminate',
        error: `Firmware update journal is invalid or unreadable. Flashing is locked pending manual inspection: ${message(value)}`,
      };
    }
  }

  async #persistJournal(): Promise<void> {
    await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#journalPath}.${randomUUID()}.part`;
    const journal = firmwareUpdateJournalSchema.parse({
      schemaVersion: 1,
      targetVersion: OEM_ZS407_FIRMWARE_RELEASE.version,
      writtenAt: new Date().toISOString(),
      state: this.#state,
    });
    try {
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(journal, null, 2), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.#journalPath);
      const committed = await open(this.#journalPath, 'r');
      try { await committed.sync(); } finally { await committed.close(); }
      if (process.platform !== 'win32') {
        const directory = await open(this.cacheDirectory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (value) {
      try { await rm(temporaryPath, { force: true }); }
      catch (cleanupFailure) { throw new Error(`${message(value)}. Temporary journal cleanup also failed: ${message(cleanupFailure)}`, { cause: value }); }
      throw value;
    }
  }

  #requireWriteNotStarted(): void {
    if (this.#state.writeDisposition === 'not-started') return;
    if (this.#state.writeDisposition === 'indeterminate') {
      throw new Error('Firmware journal integrity is indeterminate; flashing remains locked pending manual inspection');
    }
    throw new Error('A firmware write attempt already began; the updater will not issue another write');
  }

  #synchronizeDevice(): void {
    if (this.#state.preparation || ['downloading', 'flashing', 'reconnecting', 'completed'].includes(this.#state.phase)) return;
    const identity = this.device.snapshot().identity;
    if (!identity || identity.execution !== 'physical' || !identity.usbIdentityVerified) {
      if (this.#state.phase !== 'failed') this.#state = { ...initialState(), dfuUtility: this.#state.dfuUtility };
      return;
    }
    const current = { version: identity.firmwareVersion, revision: identity.firmwareReportedRevision, sourceCommit: identity.firmwareSourceCommit };
    const updateAvailable = identity.firmwareReportedRevision !== OEM_ZS407_FIRMWARE_RELEASE.revision;
    const phase = this.#state.phase === 'failed' ? 'failed' : updateAvailable ? (this.#state.artifact ? 'verified' : 'available') : 'up-to-date';
    this.#state = { ...this.#state, phase, current, updateAvailable, error: phase === 'failed' ? this.#state.error : undefined };
  }

  #requireOutdatedPhysicalDevice(): void {
    this.#synchronizeDevice();
    const snapshot = this.device.snapshot();
    if (snapshot.connection !== 'ready' || snapshot.identity?.execution !== 'physical' || !snapshot.identity.usbIdentityVerified) {
      throw new Error('Firmware update requires one connected, exactly verified physical ZS407');
    }
    if (!this.#state.updateAvailable) throw new Error('The connected ZS407 already runs the pinned OEM firmware');
  }

  async #inspectDfuUtility(): Promise<void> {
    try {
      const path = await locateDfuUtility();
      if (!path) { this.#dfuUtilityPath = undefined; this.#state = { ...this.#state, dfuUtility: { available: false } }; return; }
      const result = await runExecutable(path, ['--version'], 10_000);
      const version = parseDfuUtilVersion(`${result.stdout}\n${result.stderr}`);
      this.#dfuUtilityPath = path;
      this.#state = { ...this.#state, dfuUtility: { available: true, version } };
    } catch (value) {
      this.#dfuUtilityPath = undefined;
      this.#state = { ...this.#state, dfuUtility: { available: false }, error: `DFU utility inspection failed: ${message(value)}` };
    }
  }

  async #inspectCachedArtifact(): Promise<void> {
    try {
      const bytes = new Uint8Array(await readFile(this.#artifactPath));
      verifyFirmwareArtifact(bytes);
      this.#state = { ...this.#state, phase: 'verified', artifact: { sizeBytes: OEM_ZS407_FIRMWARE_RELEASE.sizeBytes, sha256: OEM_ZS407_FIRMWARE_RELEASE.sha256, verifiedAt: new Date().toISOString() }, error: undefined };
    } catch (value) {
      if (isFileMissing(value)) return;
      this.#state = { ...this.#state, phase: 'failed', error: `Cached firmware verification failed: ${message(value)}` };
    }
  }

  async #requireDfuUtility(): Promise<string> {
    await this.#inspectDfuUtility();
    if (!this.#dfuUtilityPath || !this.#state.dfuUtility.available) throw new Error('dfu-util 0.11 is unavailable; install the exact prerequisite before entering DFU mode');
    return this.#dfuUtilityPath;
  }

  async #waitForOnePhysicalDevice(): Promise<PortCandidate> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const candidates = (await this.device.listDevices()).filter((candidate) => candidate.execution === 'physical' && candidate.usbMatch === 'exact-zs407-cdc');
      if (candidates.length > 1) throw new Error(`Post-flash discovery found ${candidates.length} exact physical ZS407 candidates`);
      if (candidates[0]) return candidates[0];
      await delay(1_000);
    }
    throw new Error('The ZS407 did not reappear on USB within 30 seconds');
  }

  async #writeResultAudit(stage: string, value: unknown): Promise<void> {
    const id = this.#state.preparation?.id;
    if (!id) throw new Error('Firmware result audit is missing its preparation ID');
    await writeFile(join(this.cacheDirectory, `result-${id}-${stage}.json`), JSON.stringify({ schemaVersion: 1, stage, target: OEM_ZS407_FIRMWARE_RELEASE, value }, null, 2), { flag: 'wx', mode: 0o600 });
  }

  async #fail(error: string): Promise<Error> {
    this.#state = { ...this.#state, phase: 'failed', error };
    if (this.#state.preparation || this.#state.writeDisposition !== 'not-started') {
      try {
        await this.#persistJournal();
      } catch (value) {
        this.#state = { ...this.#state, error: `${error}. Firmware journal persistence also failed: ${message(value)}` };
      }
    }
    return new Error(this.#state.error);
  }
}

export function verifyFirmwareArtifact(bytes: Uint8Array): void {
  if (bytes.byteLength !== OEM_ZS407_FIRMWARE_RELEASE.sizeBytes) throw new Error(`Firmware has ${bytes.byteLength} bytes, expected ${OEM_ZS407_FIRMWARE_RELEASE.sizeBytes}`);
  const actual = sha256(bytes);
  if (actual !== OEM_ZS407_FIRMWARE_RELEASE.sha256) throw new Error(`Firmware SHA-256 ${actual} does not match pinned ${OEM_ZS407_FIRMWARE_RELEASE.sha256}`);
}

export function parseStm32DfuDevices(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => /Found DFU:\s*\[0483:df11\]/i.test(line) && /alt=0\b/.test(line) && /name="@Internal Flash\b/i.test(line));
}

export function inspectStm32DfuDevices(output: string): { deviceCount: number; targets: string[] } {
  const lines = output.split(/\r?\n/).filter((line) => /Found DFU:\s*\[0483:df11\]/i.test(line));
  const devices = new Set(lines.map((line) => {
    const path = line.match(/\bpath="([^"]+)"/i)?.[1];
    const devnum = line.match(/\bdevnum=(\d+)\b/i)?.[1];
    const serial = line.match(/\bserial="([^"]*)"/i)?.[1];
    if (!path || !devnum) throw new Error(`Malformed STM32 DFU identity line: ${bounded(line)}`);
    return `${path}:${devnum}:${serial ?? ''}`;
  }));
  return { deviceCount: devices.size, targets: parseStm32DfuDevices(output) };
}

export function parseDfuUtilVersion(output: string): string {
  const version = output.match(/dfu-util\s+([0-9]+\.[0-9]+)/i)?.[1];
  if (version !== '0.11') throw new Error(`dfu-util version ${version ?? 'missing'} is unsupported; Atomizer requires 0.11`);
  return version;
}

export interface DfuTransferProgress {
  operation: 'erase' | 'download';
  percent: number;
}

export function parseDfuTransferProgress(output: string): DfuTransferProgress | undefined {
  const matches = [...output.matchAll(/(?:^|[\r\n])(Erase|Download)\s+\[[^\]]*\]\s+(\d{1,3})%/gim)];
  const match = matches.at(-1);
  if (!match) return undefined;
  const percent = Number(match[2]);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) return undefined;
  return { operation: match[1]!.toLowerCase() as DfuTransferProgress['operation'], percent };
}

async function locateDfuUtility(): Promise<string | undefined> {
  const explicit = process.env.TINYSA_DFU_UTIL?.trim();
  if (explicit) {
    await access(explicit, fsConstants.X_OK).catch(() => { throw new Error(`TINYSA_DFU_UTIL is not executable: ${explicit}`); });
    return explicit;
  }
  const candidates = [
    '/opt/homebrew/bin/dfu-util', '/usr/local/bin/dfu-util', '/usr/bin/dfu-util',
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, 'dfu-util')),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try { await access(candidate, fsConstants.X_OK); return candidate; } catch { /* Continue deterministic path discovery. */ }
  }
  return undefined;
}

function runExecutable(file: string, args: readonly string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} ${args.join(' ')} failed: ${bounded(stderr || stdout || error.message)}`, { cause: error }));
      else resolve({ stdout, stderr });
    });
  });
}

function runDfuExecutable(
  file: string,
  args: readonly string[],
  timeout: number,
  onProgress: (progress: DfuTransferProgress) => void,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let progressTail = '';
    let lastProgress = '';
    let settled = false;
    const timer = setTimeout(() => fail(new Error(`${file} ${args.join(' ')} timed out after ${timeout} ms`)), timeout);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
      reject(error);
    };
    const consume = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 2 * 1024 * 1024) {
        fail(new Error('dfu-util output exceeded the 2 MiB safety bound'));
        return;
      }
      progressTail = `${progressTail}${text}`.slice(-8_192);
      const progress = parseDfuTransferProgress(progressTail);
      const key = progress ? `${progress.operation}:${progress.percent}` : '';
      if (progress && key !== lastProgress) {
        lastProgress = key;
        onProgress(progress);
      }
    };

    child.stdout.on('data', (chunk: Buffer) => consume('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => consume('stderr', chunk));
    child.once('error', (error) => fail(new Error(`${file} ${args.join(' ')} could not start: ${message(error)}`, { cause: error })));
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${file} ${args.join(' ')} failed with code ${String(code)} signal ${signal ?? 'none'}: ${bounded(stderr || stdout)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function initialState(): FirmwareUpdateState {
  return {
    phase: 'idle',
    target: OEM_ZS407_FIRMWARE_RELEASE,
    updateAvailable: false,
    dfuUtility: { available: false },
    dfuDevice: { detected: false, count: 0 },
    writeDisposition: 'not-started',
  };
}
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function isFileMissing(value: unknown): boolean { return Boolean(value && typeof value === 'object' && 'code' in value && value.code === 'ENOENT'); }
function bounded(value: string): string { return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 20_000); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
