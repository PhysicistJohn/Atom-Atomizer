import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export const SIGNAL_LAB_BRIDGE_ENVIRONMENT_VARIABLE = 'ATOMIZER_SIGNAL_LAB_BRIDGE' as const;
export const SIGNAL_LAB_PACKAGED_BRIDGE_RELATIVE_PATH = 'signal-lab/dist/bridge/atomizer-bridge.js' as const;
export const SIGNAL_LAB_BRIDGE_CONTRACT_ID = 'tinysa-signal-lab-atomizer-measurement' as const;
export const SIGNAL_LAB_BRIDGE_CONTRACT_VERSION = 1 as const;
export const SIGNAL_LAB_BRIDGE_PROTOCOL = 'signal-lab-measurement-bridge' as const;

const MAX_FREQUENCY_HZ = 17_922_600_000;
const MAX_SPECTRUM_POINTS = 4_096;
const MAX_DETECTED_POWER_POINTS = 4_096;
const MIN_SAMPLE_PERIOD_SECONDS = 0.000_001;
const MAX_SAMPLE_PERIOD_SECONDS = 10;
const MAX_REQUEST_LINE_BYTES = 65_536;
const MAX_RESPONSE_LINE_BYTES = 1_048_576;
const SERVER_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 7_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const MAX_DIAGNOSTIC_LINE_CHARACTERS = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROFILE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export interface SignalLabBridgeLocation {
  readonly executablePath: string;
  readonly repositoryRoot: string;
  readonly source: 'environment' | 'packaged-resource' | 'sibling-development';
}

export interface SignalLabBridgeResolverOptions {
  readonly atomizerRepositoryRoot?: string;
  /** Electron's resourcesPath, injected by a packaging boundary without importing Electron here. */
  readonly packagedResourcesRoot?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface SignalLabBridgeIdentity {
  readonly driverId: 'signal-lab';
  readonly sourceKind: 'signal-lab-simulation';
  readonly execution: 'signal-lab-simulation';
  readonly transport: typeof SIGNAL_LAB_BRIDGE_PROTOCOL;
  readonly contractId: typeof SIGNAL_LAB_BRIDGE_CONTRACT_ID;
  readonly contractVersion: typeof SIGNAL_LAB_BRIDGE_CONTRACT_VERSION;
  readonly contractSha256: string;
  readonly catalogSha256: string;
  readonly generatorSha256: string;
  readonly claims: Readonly<{ usbEmulated: false; firmwareExecuted: false; rfEmitted: false }>;
}

export type SignalLabBridgeCapability =
  | Readonly<{
    kind: 'swept-spectrum';
    minimumFrequencyHz: 1;
    maximumFrequencyHz: typeof MAX_FREQUENCY_HZ;
    minimumPoints: 2;
    maximumPoints: typeof MAX_SPECTRUM_POINTS;
    frequencyUnit: 'Hz';
    powerUnit: 'dBm';
    qualification: 'synthetic-visual-projection';
  }>
  | Readonly<{
    kind: 'detected-power-timeseries';
    minimumPoints: 1;
    maximumPoints: typeof MAX_DETECTED_POWER_POINTS;
    minimumSamplePeriodSeconds: typeof MIN_SAMPLE_PERIOD_SECONDS;
    maximumSamplePeriodSeconds: typeof MAX_SAMPLE_PERIOD_SECONDS;
    powerUnit: 'dBm';
    qualification: 'synthetic-visual-projection';
  }>;

export interface SignalLabBridgeReady {
  readonly type: 'ready';
  readonly protocol: typeof SIGNAL_LAB_BRIDGE_PROTOCOL;
  readonly contractId: typeof SIGNAL_LAB_BRIDGE_CONTRACT_ID;
  readonly contractVersion: typeof SIGNAL_LAB_BRIDGE_CONTRACT_VERSION;
  readonly service: 'tinysa-signal-lab';
  readonly sessionId: string;
  readonly identity: SignalLabBridgeIdentity;
  readonly capabilities: readonly SignalLabBridgeCapability[];
  readonly limits: Readonly<{
    maxRequestLineBytes: typeof MAX_REQUEST_LINE_BYTES;
    maxResponseLineBytes: typeof MAX_RESPONSE_LINE_BYTES;
    maxQueuedRequests: 32;
    maxSessionRequests: 10_000;
    requestTimeoutMs: typeof SERVER_REQUEST_TIMEOUT_MS;
  }>;
}

export interface SignalLabChannelConfiguration {
  readonly model: 'awgn' | 'rayleigh';
  readonly noiseFloorDbm: number;
  readonly seed: number;
  readonly fadingRateHz: number;
}

export interface SignalLabWaveformDescriptor {
  readonly id: string;
  readonly label: string;
  readonly family: 'tone' | 'analog' | 'geran' | 'e-utra' | 'nr' | 'wlan';
  readonly model: string;
  readonly qualification: 'visual' | 'standards-derived' | 'conformance-validated';
  readonly centerHz: number;
  readonly occupiedBandwidthHz: number;
  readonly recommendedSpanHz: number;
  readonly projection: Readonly<{
    allocation: 'carrier' | 'sidebands' | 'full' | 'boosted' | 'single-prb' | 'narrowband' | 'multi-ru' | 'resource-unit';
    modulation: 'unmodulated' | 'am' | 'fm' | 'gmsk' | 'qpsk' | 'aqpsk' | '8psk' | '16qam' | '32qam' | '64qam' | '256qam' | '1024qam' | 'ofdm-mixed' | 'he-ofdm';
    timing: 'continuous' | 'burst' | 'frame' | 'subslot' | 'slot' | 'sbfd-du' | 'sbfd-ud' | 'sbfd-dud';
    subcarrierSpacingHz?: number;
    nominalResourceBlocks?: number;
  }>;
  readonly standard: Readonly<{
    organization: 'TinySA SignalLab' | '3GPP' | 'IEEE';
    specification: string;
    clause: string;
    revision: string;
    url: string;
  }>;
  readonly disclosure: string;
  readonly assetSha256?: string;
}

export interface SignalLabBridgeStatus {
  readonly kind: 'status';
  readonly sessionId: string;
  readonly configurationRevision: string;
  readonly updatedAt: string;
  readonly available: true;
  readonly active: true;
  readonly profile: string;
  readonly profiles: readonly string[];
  readonly waveform: SignalLabWaveformDescriptor;
  readonly catalog: readonly SignalLabWaveformDescriptor[];
  readonly channel: SignalLabChannelConfiguration;
  readonly capabilities: readonly SignalLabBridgeCapability[];
  readonly identity: SignalLabBridgeIdentity;
}

interface SignalLabMeasurementBase {
  readonly measurementId: string;
  readonly sessionId: string;
  readonly configurationRevision: string;
  readonly sequence: number;
  readonly capturedAt: string;
  readonly elapsedSeconds: number;
  readonly complete: true;
  readonly qualification: 'synthetic-visual-projection';
  readonly provenance: SignalLabBridgeIdentity;
}

export interface SignalLabSpectrumMeasurement extends SignalLabMeasurementBase {
  readonly kind: 'swept-spectrum';
  readonly startHz: number;
  readonly stopHz: number;
  readonly points: number;
  readonly frequencyHz: readonly number[];
  readonly powerDbm: readonly number[];
}

export interface SignalLabDetectedPowerMeasurement extends SignalLabMeasurementBase {
  readonly kind: 'detected-power-timeseries';
  readonly centerFrequencyHz: number;
  readonly points: number;
  readonly samplePeriodSeconds: number;
  readonly powerDbm: readonly number[];
}

export type SignalLabBridgeMeasurement = SignalLabSpectrumMeasurement | SignalLabDetectedPowerMeasurement;

export interface SignalLabBridgeClientOptions {
  readonly readyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  /** Defaults to process.execPath; injectable so the exact packaged Electron runtime can be exercised. */
  readonly runtimeExecutablePath?: string;
  readonly diagnostics?: (line: string) => void;
  readonly onTerminalFailure?: (error: Error) => void;
}

interface NormalizedSignalLabBridgeClientOptions {
  readonly readyTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly runtimeExecutablePath: string;
  readonly diagnostics?: (line: string) => void;
  readonly onTerminalFailure?: (error: Error) => void;
}

/** Ownership token for a bridge process opened before session admission. */
export interface SignalLabPendingConnectionCleanup {
  readonly cleanupConfirmed: boolean;
  cleanupPendingConnection(): Promise<void>;
}

export class SignalLabBridgeProtocolError extends Error {
  override readonly name = 'SignalLabBridgeProtocolError';
}

export class SignalLabBridgeTerminalError extends Error {
  override readonly name = 'SignalLabBridgeTerminalError';
}

export async function resolveSignalLabBridgeLocation(
  options: SignalLabBridgeResolverOptions = {},
): Promise<SignalLabBridgeLocation> {
  const environment = options.environment ?? process.env;
  const override = environment[SIGNAL_LAB_BRIDGE_ENVIRONMENT_VARIABLE]?.trim();
  if (override && !isAbsolute(override)) {
    throw new Error(`${SIGNAL_LAB_BRIDGE_ENVIRONMENT_VARIABLE} must be an absolute path`);
  }
  const packagedResourcesRoot = options.packagedResourcesRoot?.trim();
  if (packagedResourcesRoot && !isAbsolute(packagedResourcesRoot)) {
    throw new Error('SignalLab packaged resources root must be an absolute path');
  }
  const atomizerRepositoryRoot = resolve(options.atomizerRepositoryRoot ?? process.cwd());
  const source: SignalLabBridgeLocation['source'] = override
    ? 'environment'
    : packagedResourcesRoot
      ? 'packaged-resource'
      : 'sibling-development';
  const executablePath = override
    ? resolve(override)
    : packagedResourcesRoot
      ? resolve(packagedResourcesRoot, SIGNAL_LAB_PACKAGED_BRIDGE_RELATIVE_PATH)
      : resolve(atomizerRepositoryRoot, '..', 'TinySA_SignalLab', 'dist', 'bridge', 'atomizer-bridge.js');
  await requireSafeExecutable(executablePath);
  return Object.freeze({
    executablePath,
    repositoryRoot: resolve(executablePath, '..', '..', '..'),
    source,
  });
}

/**
 * A single-session, single-in-flight consumer for SignalLab's versioned NDJSON
 * measurement bridge. Any framing, correlation, timeout, process, or schema
 * failure poisons the client permanently and is never retried.
 */
export class SignalLabBridgeClient {
  readonly ready: SignalLabBridgeReady;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #options: NormalizedSignalLabBridgeClientOptions;
  readonly #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly #resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  #state: 'booting' | 'ready' | 'closing' | 'closed' | 'faulted' = 'booting';
  #terminalError: Error | undefined;
  #pending: PendingRequest | undefined;
  #requestSequence = 0;
  #stdout = Buffer.alloc(0);
  #stderr = '';
  #shutdownAcknowledged = false;
  #exitConfirmed = false;

  get cleanupConfirmed(): boolean { return this.#state === 'closed' || this.#exitConfirmed; }

  private constructor(
    child: ChildProcessWithoutNullStreams,
    ready: SignalLabBridgeReady,
    options: NormalizedSignalLabBridgeClientOptions,
    exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
    resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void,
  ) {
    this.#child = child;
    this.ready = ready;
    this.#options = options;
    this.#exit = exit;
    this.#resolveExit = resolveExit;
    this.#state = 'ready';
  }

  static async launch(
    location: SignalLabBridgeLocation,
    options: SignalLabBridgeClientOptions = {},
    retainPendingConnection?: (lease: SignalLabPendingConnectionCleanup) => void,
  ): Promise<SignalLabBridgeClient> {
    await requireSafeExecutable(location.executablePath);
    const admittedOptions = normalizeOptions(options);
    const child = spawn(admittedOptions.runtimeExecutablePath, ['--disable-proto=throw', location.executablePath], {
      cwd: location.repositoryRoot,
      env: admittedEnvironment(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveValue) => { resolveExit = resolveValue; });
    const boot = new BootProtocol(child, admittedOptions, exit, resolveExit);
    retainPendingConnection?.(boot);
    const ready = await boot.waitForReady();
    const client = new SignalLabBridgeClient(child, ready, admittedOptions, exit, resolveExit);
    retainPendingConnection?.(client);
    try {
      boot.transferTo(client);
      client.#assertOperational();
      return client;
    } catch (value) {
      const error = asError(value, 'SignalLab bridge failed during ready handoff');
      client.#fail(error);
      try {
        await withTimeout(exit, admittedOptions.shutdownTimeoutMs, 'SignalLab bridge did not terminate after failed ready handoff');
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'SignalLab bridge ready handoff and process termination both failed');
      }
      throw error;
    }
  }

  async status(): Promise<SignalLabBridgeStatus> {
    return this.#request('status', {});
  }

  async selectProfile(profile: string): Promise<SignalLabBridgeStatus> {
    profileId(profile, 'SignalLab profile');
    return this.#request('select_profile', { profile });
  }

  async configureChannel(channel: SignalLabChannelConfiguration): Promise<SignalLabBridgeStatus> {
    parseChannel(channel);
    return this.#request('configure_channel', { channel });
  }

  async acquireSpectrum(params: Readonly<{ startHz: number; stopHz: number; points: number }>): Promise<SignalLabSpectrumMeasurement> {
    frequency(params.startHz, 'sweep start');
    frequency(params.stopHz, 'sweep stop');
    if (params.stopHz <= params.startHz) throw new RangeError('SignalLab sweep stop must exceed start');
    integer(params.points, 2, MAX_SPECTRUM_POINTS, 'sweep points');
    return this.#request('acquire_spectrum', params);
  }

  async acquireDetectedPower(params: Readonly<{ points: number; samplePeriodSeconds: number }>): Promise<SignalLabDetectedPowerMeasurement> {
    integer(params.points, 1, MAX_DETECTED_POWER_POINTS, 'detected-power points');
    finite(params.samplePeriodSeconds, MIN_SAMPLE_PERIOD_SECONDS, MAX_SAMPLE_PERIOD_SECONDS, 'detected-power sample period');
    return this.#request('acquire_detected_power', params);
  }

  async close(): Promise<void> {
    if (this.#state === 'closed') return;
    if (this.#state === 'faulted') {
      const terminal = this.#terminalError ?? new SignalLabBridgeTerminalError('SignalLab bridge is faulted');
      this.#terminateProcess();
      try {
        await withTimeout(this.#exit, this.#options.shutdownTimeoutMs, 'SignalLab bridge did not terminate after a terminal fault');
      } catch (cleanup) {
        throw new AggregateError([terminal, cleanup], 'SignalLab bridge faulted and process termination could not be confirmed');
      }
      throw terminal;
    }
    if (this.#state !== 'ready') throw new SignalLabBridgeTerminalError(`SignalLab bridge cannot close from ${this.#state}`);
    this.#state = 'closing';
    try {
      const result = await this.#requestWhileClosing('shutdown', {});
      const record = exactRecord(result, ['kind', 'closed'], [], 'SignalLab shutdown result');
      literal(record.kind, 'shutdown', 'SignalLab shutdown result kind');
      literal(record.closed, true, 'SignalLab shutdown closed flag');
      this.#shutdownAcknowledged = true;
      const exited = await withTimeout(this.#exit, this.#options.shutdownTimeoutMs, 'SignalLab bridge did not exit after shutdown');
      if (exited.code !== 0 || exited.signal !== null) {
        throw new SignalLabBridgeTerminalError(`SignalLab bridge shutdown exited with code ${String(exited.code)} signal ${String(exited.signal)}`);
      }
      this.#state = 'closed';
    } catch (value) {
      const error = asError(value, 'SignalLab bridge shutdown failed');
      this.#fail(error);
      try {
        await withTimeout(this.#exit, this.#options.shutdownTimeoutMs, 'SignalLab bridge did not terminate after failed shutdown');
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'SignalLab bridge shutdown and process termination both failed');
      }
      throw error;
    }
  }

  /**
   * Cleanup-only lifecycle used when bridge composition failed before a
   * session owner existed. Unlike close(), a prior terminal protocol error is
   * not rethrown once child-process exit has been confirmed.
   */
  async cleanupPendingConnection(): Promise<void> {
    if (this.#state === 'closed') return;
    if (this.#state === 'ready') {
      try { await this.close(); return; }
      catch (value) {
        if (this.#exitConfirmed) {
          this.#state = 'closed';
          return;
        }
        throw value;
      }
    }
    if (this.#state !== 'faulted') {
      throw new SignalLabBridgeTerminalError(`SignalLab pending connection cannot be cleaned from ${this.#state}`);
    }
    this.#terminateProcess();
    await withTimeout(this.#exit, this.#options.shutdownTimeoutMs, 'SignalLab pending connection process did not terminate');
    this.#state = 'closed';
  }

  #request<M extends BridgeMethod>(method: M, params: BridgeParams[M]): Promise<BridgeResult[M]> {
    if (this.#state !== 'ready') return Promise.reject(this.#unavailable());
    return this.#beginRequest(method, params) as Promise<BridgeResult[M]>;
  }

  #requestWhileClosing<M extends BridgeMethod>(method: M, params: BridgeParams[M]): Promise<BridgeResult[M]> {
    if (this.#state !== 'closing') return Promise.reject(this.#unavailable());
    return this.#beginRequest(method, params) as Promise<BridgeResult[M]>;
  }

  #beginRequest(method: BridgeMethod, params: BridgeParams[BridgeMethod]): Promise<unknown> {
    if (this.#pending) return Promise.reject(new SignalLabBridgeTerminalError('SignalLab bridge permits exactly one in-flight request'));
    const requestId = `atomizer-${++this.#requestSequence}`;
    const line = JSON.stringify({ type: 'request', contractVersion: 1, requestId, method, params });
    if (Buffer.byteLength(line, 'utf8') > MAX_REQUEST_LINE_BYTES) {
      return Promise.reject(new SignalLabBridgeProtocolError('SignalLab request exceeds the versioned line bound'));
    }
    const result = new Promise<unknown>((resolveValue, reject) => {
      const timer = setTimeout(() => {
        const error = new SignalLabBridgeTerminalError(`SignalLab ${method} timed out; the request was not retried`);
        this.#fail(error);
        reject(error);
      }, this.#options.requestTimeoutMs);
      this.#pending = { requestId, method, resolve: resolveValue, reject, timer };
    });
    try {
      this.#child.stdin.write(`${line}\n`, 'utf8', (error) => {
        if (error) this.#fail(new SignalLabBridgeTerminalError(`SignalLab ${method} write failed: ${error.message}`, { cause: error }));
      });
    } catch (value) {
      const error = asError(value, `SignalLab ${method} write failed`);
      this.#fail(error);
    }
    return result;
  }

  acceptStdout(chunk: Buffer): void {
    if (this.#state === 'faulted' || this.#state === 'closed') return;
    this.#stdout = Buffer.concat([this.#stdout, chunk]);
    while (true) {
      const newline = this.#stdout.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.#stdout.subarray(0, newline);
      this.#stdout = this.#stdout.subarray(newline + 1);
      if (line.byteLength > MAX_RESPONSE_LINE_BYTES) {
        this.#fail(new SignalLabBridgeProtocolError('SignalLab bridge emitted an oversized response line'));
        return;
      }
      this.#acceptLine(line);
      if (this.#terminalError) return;
    }
    if (this.#stdout.byteLength > MAX_RESPONSE_LINE_BYTES) {
      this.#fail(new SignalLabBridgeProtocolError('SignalLab bridge response exceeded the line bound before LF'));
    }
  }

  acceptStderr(chunk: Buffer): void {
    this.#stderr += chunk.toString('utf8');
    while (true) {
      const newline = this.#stderr.indexOf('\n');
      if (newline < 0) break;
      this.#logDiagnostic(this.#stderr.slice(0, newline));
      this.#stderr = this.#stderr.slice(newline + 1);
    }
    if (this.#stderr.length > MAX_DIAGNOSTIC_LINE_CHARACTERS) {
      this.#logDiagnostic(this.#stderr.slice(0, MAX_DIAGNOSTIC_LINE_CHARACTERS));
      this.#stderr = '';
    }
  }

  acceptProcessError(value: Error): void {
    this.#fail(new SignalLabBridgeTerminalError(`SignalLab bridge process failed: ${value.message}`, { cause: value }));
  }

  acceptClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#stderr) { this.#logDiagnostic(this.#stderr); this.#stderr = ''; }
    this.#exitConfirmed = true;
    this.#resolveExit({ code, signal });
    if (this.#state === 'closing' && this.#shutdownAcknowledged && code === 0 && signal === null) {
      this.#state = 'closed';
      return;
    }
    if (this.#state !== 'closed' && this.#state !== 'faulted') {
      this.#fail(new SignalLabBridgeTerminalError(
        `SignalLab bridge exited unexpectedly with code ${String(code)} signal ${String(signal)}`,
      ), false);
    }
  }

  acceptStdoutEnd(): void {
    if (this.#state === 'faulted' || this.#state === 'closed') return;
    if (this.#state === 'closing' && this.#shutdownAcknowledged) return;
    this.#fail(this.#stdout.byteLength > 0
      ? new SignalLabBridgeProtocolError('SignalLab bridge closed stdout with an unterminated protocol line')
      : new SignalLabBridgeTerminalError('SignalLab bridge closed stdout unexpectedly'));
  }

  #acceptLine(bytes: Buffer): void {
    if (bytes.byteLength === 0) { this.#fail(new SignalLabBridgeProtocolError('SignalLab bridge emitted an empty protocol line')); return; }
    if (bytes.at(-1) === 0x0d) { this.#fail(new SignalLabBridgeProtocolError('SignalLab bridge used CRLF instead of the contracted LF framing')); return; }
    let line: string;
    try { line = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (value) { this.#fail(new SignalLabBridgeProtocolError('SignalLab bridge emitted invalid UTF-8', { cause: value })); return; }
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (cause) { this.#fail(new SignalLabBridgeProtocolError('SignalLab bridge emitted malformed JSON', { cause })); return; }
    const pending = this.#pending;
    if (!pending) { this.#fail(new SignalLabBridgeProtocolError('SignalLab bridge emitted an unsolicited protocol message')); return; }
    try {
      const response = parseResponse(value, pending, this.ready);
      this.#pending = undefined;
      clearTimeout(pending.timer);
      if (pending.method === 'shutdown') this.#shutdownAcknowledged = true;
      pending.resolve(response);
    } catch (value) {
      const error = asError(value, 'SignalLab bridge response violated the versioned contract');
      this.#fail(error);
    }
  }

  #fail(error: Error, terminate = true): void {
    if (this.#state === 'faulted' || this.#state === 'closed') return;
    this.#state = 'faulted';
    this.#terminalError = error;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    if (terminate) this.#terminateProcess();
    try { this.#options.onTerminalFailure?.(error); } catch { /* Observers cannot change bridge state. */ }
  }

  #terminateProcess(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGKILL');
  }

  #unavailable(): Error {
    return this.#terminalError ?? new SignalLabBridgeTerminalError(`SignalLab bridge is ${this.#state}`);
  }

  #assertOperational(): void {
    if (this.#state !== 'ready') throw this.#unavailable();
  }

  #logDiagnostic(value: string): void {
    const line = value.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_DIAGNOSTIC_LINE_CHARACTERS);
    if (!line) return;
    try { this.#options.diagnostics?.(line); } catch { /* Diagnostics are observational. */ }
  }
}

type BridgeMethod = 'status' | 'select_profile' | 'configure_channel' | 'acquire_spectrum' | 'acquire_detected_power' | 'shutdown';
interface BridgeParams {
  status: Record<string, never>;
  select_profile: { profile: string };
  configure_channel: { channel: SignalLabChannelConfiguration };
  acquire_spectrum: { startHz: number; stopHz: number; points: number };
  acquire_detected_power: { points: number; samplePeriodSeconds: number };
  shutdown: Record<string, never>;
}
interface BridgeResult {
  status: SignalLabBridgeStatus;
  select_profile: SignalLabBridgeStatus;
  configure_channel: SignalLabBridgeStatus;
  acquire_spectrum: SignalLabSpectrumMeasurement;
  acquire_detected_power: SignalLabDetectedPowerMeasurement;
  shutdown: { kind: 'shutdown'; closed: true };
}
interface PendingRequest {
  readonly requestId: string;
  readonly method: BridgeMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class BootProtocol {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #options: NormalizedSignalLabBridgeClientOptions;
  readonly #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly #resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  readonly #ready: Promise<SignalLabBridgeReady>;
  #resolveReady!: (value: SignalLabBridgeReady) => void;
  #rejectReady!: (error: Error) => void;
  #buffer = Buffer.alloc(0);
  #stderr = '';
  #settled = false;
  #transferred = false;
  #readyValue: SignalLabBridgeReady | undefined;
  #client: SignalLabBridgeClient | undefined;
  #failureBeforeTransfer: Error | undefined;
  #closeBeforeTransfer: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  #exitConfirmed = false;

  get cleanupConfirmed(): boolean { return this.#exitConfirmed; }

  constructor(
    child: ChildProcessWithoutNullStreams,
    options: NormalizedSignalLabBridgeClientOptions,
    exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
    resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void,
  ) {
    this.#child = child;
    this.#options = options;
    this.#exit = exit;
    this.#resolveExit = resolveExit;
    this.#ready = new Promise((resolveValue, reject) => { this.#resolveReady = resolveValue; this.#rejectReady = reject; });
    child.stdout.on('data', this.#onStdout);
    child.stdout.once('end', this.#onStdoutEnd);
    child.stderr.on('data', this.#onStderr);
    child.once('error', this.#onError);
    child.once('close', this.#onClose);
  }

  async waitForReady(): Promise<SignalLabBridgeReady> {
    try {
      return await withTimeout(this.#ready, this.#options.readyTimeoutMs, 'SignalLab bridge ready handshake timed out');
    } catch (value) {
      const error = asError(value, 'SignalLab bridge failed before ready');
      this.#fail(error);
      try {
        await withTimeout(this.#exit, this.#options.shutdownTimeoutMs, 'SignalLab bridge did not terminate after failed startup');
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'SignalLab bridge startup and process termination both failed');
      }
      throw error;
    }
  }

  async cleanupPendingConnection(): Promise<void> {
    if (this.#exitConfirmed) return;
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGKILL');
    await withTimeout(this.#exit, this.#options.shutdownTimeoutMs, 'SignalLab bridge boot process did not terminate during pending cleanup');
  }

  transferTo(client: SignalLabBridgeClient): void {
    if (!this.#readyValue || this.#transferred) throw new Error('SignalLab bridge boot protocol cannot be transferred');
    this.#transferred = true;
    this.#client = client;
    if (this.#buffer.byteLength > 0) {
      client.acceptStdout(this.#buffer);
      this.#buffer = Buffer.alloc(0);
    }
    if (this.#stderr) { client.acceptStderr(Buffer.from(this.#stderr, 'utf8')); this.#stderr = ''; }
    if (this.#failureBeforeTransfer) client.acceptProcessError(this.#failureBeforeTransfer);
    else if (this.#closeBeforeTransfer) client.acceptClose(this.#closeBeforeTransfer.code, this.#closeBeforeTransfer.signal);
  }

  readonly #onStdout = (chunk: Buffer): void => {
    if (this.#transferred) { this.#client?.acceptStdout(chunk); return; }
    if (this.#settled) {
      if (this.#buffer.byteLength + chunk.byteLength > MAX_RESPONSE_LINE_BYTES) {
        this.#fail(new SignalLabBridgeProtocolError('SignalLab post-ready handoff data exceeded the response bound'));
      } else {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
      }
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const newline = this.#buffer.indexOf(0x0a);
    if (newline < 0) {
      if (this.#buffer.byteLength > MAX_RESPONSE_LINE_BYTES) this.#fail(new SignalLabBridgeProtocolError('SignalLab ready line exceeded the response bound'));
      return;
    }
    const line = this.#buffer.subarray(0, newline);
    this.#buffer = this.#buffer.subarray(newline + 1);
    if (line.byteLength === 0 || line.at(-1) === 0x0d) { this.#fail(new SignalLabBridgeProtocolError('SignalLab ready framing is invalid')); return; }
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(line);
      const ready = parseReady(JSON.parse(decoded));
      this.#readyValue = ready;
      this.#settled = true;
      this.#resolveReady(ready);
    } catch (value) {
      this.#fail(asError(value, 'SignalLab bridge ready handshake violated the versioned contract'));
    }
  };

  readonly #onStdoutEnd = (): void => {
    if (this.#transferred) { this.#client?.acceptStdoutEnd(); return; }
    if (!this.#settled) this.#fail(new SignalLabBridgeTerminalError('SignalLab bridge closed stdout before ready'));
    else this.#fail(this.#buffer.byteLength > 0
      ? new SignalLabBridgeProtocolError('SignalLab bridge closed stdout with an unterminated protocol line')
      : new SignalLabBridgeTerminalError('SignalLab bridge closed stdout unexpectedly'));
  };

  readonly #onStderr = (chunk: Buffer): void => {
    if (this.#transferred) { this.#client?.acceptStderr(chunk); return; }
    this.#stderr = `${this.#stderr}${chunk.toString('utf8')}`.slice(-MAX_DIAGNOSTIC_LINE_CHARACTERS);
  };

  readonly #onError = (error: Error): void => {
    if (this.#transferred) { this.#client?.acceptProcessError(error); return; }
    const failure = new SignalLabBridgeTerminalError(`SignalLab bridge process failed: ${error.message}`, { cause: error });
    this.#fail(failure);
  };

  readonly #onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.#exitConfirmed = true;
    this.#resolveExit({ code, signal });
    if (this.#transferred) { this.#client?.acceptClose(code, signal); return; }
    if (!this.#settled) {
      const suffix = this.#stderr.trim() ? `; see SignalLab diagnostics: ${this.#stderr.trim().slice(0, 256)}` : '';
      this.#fail(new SignalLabBridgeTerminalError(`SignalLab bridge exited before ready with code ${String(code)} signal ${String(signal)}${suffix}`), false);
    } else this.#closeBeforeTransfer ??= { code, signal };
  };

  #fail(error: Error, terminate = true): void {
    if (this.#settled) {
      if (this.#readyValue && !this.#transferred) {
        this.#failureBeforeTransfer ??= error;
        if (terminate && this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGKILL');
      }
      return;
    }
    this.#settled = true;
    this.#rejectReady(error);
    if (terminate && this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGKILL');
    try { this.#options.onTerminalFailure?.(error); } catch { /* Observational only. */ }
  }
}

function parseReady(value: unknown): SignalLabBridgeReady {
  const ready = exactRecord(value, ['type', 'protocol', 'contractId', 'contractVersion', 'service', 'sessionId', 'identity', 'capabilities', 'limits'], [], 'SignalLab ready');
  literal(ready.type, 'ready', 'SignalLab ready type');
  literal(ready.protocol, SIGNAL_LAB_BRIDGE_PROTOCOL, 'SignalLab ready protocol');
  literal(ready.contractId, SIGNAL_LAB_BRIDGE_CONTRACT_ID, 'SignalLab ready contract ID');
  literal(ready.contractVersion, 1, 'SignalLab ready contract version');
  literal(ready.service, 'tinysa-signal-lab', 'SignalLab ready service');
  uuid(ready.sessionId, 'SignalLab ready session ID');
  const identity = parseIdentity(ready.identity);
  const capabilities = parseCapabilities(ready.capabilities);
  const limits = exactRecord(ready.limits, ['maxRequestLineBytes', 'maxResponseLineBytes', 'maxQueuedRequests', 'maxSessionRequests', 'requestTimeoutMs'], [], 'SignalLab ready limits');
  literal(limits.maxRequestLineBytes, MAX_REQUEST_LINE_BYTES, 'SignalLab request line limit');
  literal(limits.maxResponseLineBytes, MAX_RESPONSE_LINE_BYTES, 'SignalLab response line limit');
  literal(limits.maxQueuedRequests, 32, 'SignalLab queue limit');
  literal(limits.maxSessionRequests, 10_000, 'SignalLab session request limit');
  literal(limits.requestTimeoutMs, SERVER_REQUEST_TIMEOUT_MS, 'SignalLab server request timeout');
  return Object.freeze({
    type: 'ready', protocol: SIGNAL_LAB_BRIDGE_PROTOCOL, contractId: SIGNAL_LAB_BRIDGE_CONTRACT_ID,
    contractVersion: 1, service: 'tinysa-signal-lab', sessionId: ready.sessionId as string,
    identity, capabilities, limits: Object.freeze({
      maxRequestLineBytes: MAX_REQUEST_LINE_BYTES, maxResponseLineBytes: MAX_RESPONSE_LINE_BYTES,
      maxQueuedRequests: 32, maxSessionRequests: 10_000, requestTimeoutMs: SERVER_REQUEST_TIMEOUT_MS,
    }),
  });
}

function parseResponse(value: unknown, pending: PendingRequest, ready: SignalLabBridgeReady): unknown {
  const response = record(value, 'SignalLab response');
  if (response.ok === true) {
    exactKeys(response, ['type', 'contractVersion', 'requestId', 'ok', 'result'], [], 'SignalLab success response');
    literal(response.type, 'response', 'SignalLab response type');
    literal(response.contractVersion, 1, 'SignalLab response contract version');
    literal(response.requestId, pending.requestId, 'SignalLab response correlation ID');
    return parseSuccessResult(response.result, pending.method, ready);
  }
  if (response.ok === false) {
    exactKeys(response, ['type', 'contractVersion', 'requestId', 'ok', 'error'], [], 'SignalLab error response');
    literal(response.type, 'response', 'SignalLab response type');
    literal(response.contractVersion, 1, 'SignalLab response contract version');
    literal(response.requestId, pending.requestId, 'SignalLab response correlation ID');
    const error = exactRecord(response.error, ['code', 'message'], [], 'SignalLab error response body');
    oneOf(error.code, [
      'INVALID_ENCODING', 'INVALID_JSON', 'INVALID_REQUEST', 'LINE_TOO_LARGE', 'LINE_TERMINATOR_REQUIRED',
      'DUPLICATE_REQUEST_ID', 'SESSION_REQUEST_LIMIT', 'OVERLOADED', 'REQUEST_TIMEOUT', 'SERVICE_CLOSED',
      'SHUTTING_DOWN', 'RESPONSE_TOO_LARGE', 'INTERNAL_ERROR',
    ] as const, 'SignalLab error code');
    const detail = boundedString(error.message, 1, 256, 'SignalLab error message');
    throw new SignalLabBridgeTerminalError(`SignalLab bridge rejected ${pending.method}: ${String(error.code)}: ${detail}`);
  }
  throw new SignalLabBridgeProtocolError('SignalLab response must carry a literal boolean ok discriminator');
}

function parseSuccessResult(value: unknown, method: BridgeMethod, ready: SignalLabBridgeReady): unknown {
  if (method === 'status' || method === 'select_profile' || method === 'configure_channel') return parseStatus(value, ready);
  if (method === 'acquire_spectrum') return parseSpectrum(value, ready);
  if (method === 'acquire_detected_power') return parseDetectedPower(value, ready);
  const result = exactRecord(value, ['kind', 'closed'], [], 'SignalLab shutdown result');
  literal(result.kind, 'shutdown', 'SignalLab shutdown kind');
  literal(result.closed, true, 'SignalLab shutdown state');
  return Object.freeze({ kind: 'shutdown' as const, closed: true as const });
}

function parseStatus(value: unknown, ready: SignalLabBridgeReady): SignalLabBridgeStatus {
  const status = exactRecord(value, [
    'kind', 'sessionId', 'configurationRevision', 'updatedAt', 'available', 'active', 'profile', 'profiles',
    'waveform', 'catalog', 'channel', 'capabilities', 'identity',
  ], [], 'SignalLab status');
  literal(status.kind, 'status', 'SignalLab status kind');
  literal(status.sessionId, ready.sessionId, 'SignalLab status session ID');
  uuid(status.configurationRevision, 'SignalLab status configuration revision');
  instant(status.updatedAt, 'SignalLab status timestamp');
  literal(status.available, true, 'SignalLab availability');
  literal(status.active, true, 'SignalLab activity');
  const profile = profileId(status.profile, 'SignalLab selected profile');
  const profiles = array(status.profiles, 1, 256, 'SignalLab profiles').map((item) => profileId(item, 'SignalLab profile'));
  if (new Set(profiles).size !== profiles.length) throw new SignalLabBridgeProtocolError('SignalLab profiles are not unique');
  if (!profiles.includes(profile)) throw new SignalLabBridgeProtocolError('SignalLab selected profile is not advertised');
  const catalog = array(status.catalog, profiles.length, profiles.length, 'SignalLab catalog').map((item) => parseWaveform(item));
  if (catalog.some((item, index) => item.id !== profiles[index])) throw new SignalLabBridgeProtocolError('SignalLab catalog does not exactly match profile ordering');
  const waveform = parseWaveform(status.waveform);
  if (waveform.id !== profile) throw new SignalLabBridgeProtocolError('SignalLab selected waveform does not match selected profile');
  const selectedCatalogWaveform = catalog[profiles.indexOf(profile)];
  if (!selectedCatalogWaveform || !isDeepStrictEqual(waveform, selectedCatalogWaveform)) {
    throw new SignalLabBridgeProtocolError('SignalLab selected waveform drifted from its catalog entry');
  }
  const channel = parseChannel(status.channel);
  const capabilities = parseCapabilities(status.capabilities);
  const identity = parseIdentity(status.identity);
  if (!isDeepStrictEqual(capabilities, ready.capabilities)) throw new SignalLabBridgeProtocolError('SignalLab status capabilities drifted from ready');
  if (!isDeepStrictEqual(identity, ready.identity)) throw new SignalLabBridgeProtocolError('SignalLab status identity drifted from ready');
  return Object.freeze({
    kind: 'status', sessionId: ready.sessionId, configurationRevision: status.configurationRevision as string,
    updatedAt: status.updatedAt as string, available: true, active: true, profile,
    profiles: Object.freeze(profiles), waveform, catalog: Object.freeze(catalog), channel, capabilities, identity,
  });
}

function parseSpectrum(value: unknown, ready: SignalLabBridgeReady): SignalLabSpectrumMeasurement {
  const measurement = exactRecord(value, [
    ...MEASUREMENT_BASE_KEYS, 'kind', 'startHz', 'stopHz', 'points', 'frequencyHz', 'powerDbm',
  ], [], 'SignalLab spectrum measurement');
  const base = parseMeasurementBase(measurement, ready);
  literal(measurement.kind, 'swept-spectrum', 'SignalLab spectrum kind');
  const startHz = integer(measurement.startHz, 1, MAX_FREQUENCY_HZ, 'SignalLab spectrum start');
  const stopHz = integer(measurement.stopHz, 1, MAX_FREQUENCY_HZ, 'SignalLab spectrum stop');
  if (stopHz <= startHz) throw new SignalLabBridgeProtocolError('SignalLab spectrum stop must exceed start');
  const points = integer(measurement.points, 2, MAX_SPECTRUM_POINTS, 'SignalLab spectrum points');
  const frequencyHz = array(measurement.frequencyHz, points, points, 'SignalLab spectrum frequencies')
    .map((item) => finite(item, 1, MAX_FREQUENCY_HZ, 'SignalLab spectrum frequency'));
  const powerDbm = array(measurement.powerDbm, points, points, 'SignalLab spectrum power')
    .map((item) => finite(item, -1_000, 1_000, 'SignalLab spectrum power'));
  if (frequencyHz[0] !== startHz || frequencyHz.at(-1) !== stopHz) throw new SignalLabBridgeProtocolError('SignalLab spectrum endpoints do not match geometry');
  for (let index = 1; index < frequencyHz.length; index++) {
    if (frequencyHz[index]! <= frequencyHz[index - 1]!) throw new SignalLabBridgeProtocolError('SignalLab spectrum frequencies are not strictly increasing');
  }
  return Object.freeze({ ...base, kind: 'swept-spectrum', startHz, stopHz, points, frequencyHz: Object.freeze(frequencyHz), powerDbm: Object.freeze(powerDbm) });
}

function parseDetectedPower(value: unknown, ready: SignalLabBridgeReady): SignalLabDetectedPowerMeasurement {
  const measurement = exactRecord(value, [
    ...MEASUREMENT_BASE_KEYS, 'kind', 'centerFrequencyHz', 'points', 'samplePeriodSeconds', 'powerDbm',
  ], [], 'SignalLab detected-power measurement');
  const base = parseMeasurementBase(measurement, ready);
  literal(measurement.kind, 'detected-power-timeseries', 'SignalLab detected-power kind');
  const centerFrequencyHz = integer(measurement.centerFrequencyHz, 1, MAX_FREQUENCY_HZ, 'SignalLab detected-power center');
  const points = integer(measurement.points, 1, MAX_DETECTED_POWER_POINTS, 'SignalLab detected-power points');
  const samplePeriodSeconds = finite(measurement.samplePeriodSeconds, MIN_SAMPLE_PERIOD_SECONDS, MAX_SAMPLE_PERIOD_SECONDS, 'SignalLab detected-power sample period');
  const powerDbm = array(measurement.powerDbm, points, points, 'SignalLab detected-power samples')
    .map((item) => finite(item, -1_000, 1_000, 'SignalLab detected-power sample'));
  return Object.freeze({ ...base, kind: 'detected-power-timeseries', centerFrequencyHz, points, samplePeriodSeconds, powerDbm: Object.freeze(powerDbm) });
}

const MEASUREMENT_BASE_KEYS = [
  'measurementId', 'sessionId', 'configurationRevision', 'sequence', 'capturedAt', 'elapsedSeconds',
  'complete', 'qualification', 'provenance',
] as const;

function parseMeasurementBase(value: Record<string, unknown>, ready: SignalLabBridgeReady): SignalLabMeasurementBase {
  uuid(value.measurementId, 'SignalLab measurement ID');
  literal(value.sessionId, ready.sessionId, 'SignalLab measurement session ID');
  uuid(value.configurationRevision, 'SignalLab measurement configuration revision');
  const sequence = integer(value.sequence, 1, Number.MAX_SAFE_INTEGER, 'SignalLab measurement sequence');
  instant(value.capturedAt, 'SignalLab measurement timestamp');
  const elapsedSeconds = finite(value.elapsedSeconds, 0, 60, 'SignalLab measurement elapsed time');
  literal(value.complete, true, 'SignalLab measurement completeness');
  literal(value.qualification, 'synthetic-visual-projection', 'SignalLab measurement qualification');
  const provenance = parseIdentity(value.provenance);
  if (!isDeepStrictEqual(provenance, ready.identity)) throw new SignalLabBridgeProtocolError('SignalLab measurement provenance drifted from ready');
  return {
    measurementId: value.measurementId as string, sessionId: ready.sessionId,
    configurationRevision: value.configurationRevision as string, sequence,
    capturedAt: value.capturedAt as string, elapsedSeconds, complete: true,
    qualification: 'synthetic-visual-projection', provenance,
  };
}

function parseIdentity(value: unknown): SignalLabBridgeIdentity {
  const identity = exactRecord(value, [
    'driverId', 'sourceKind', 'execution', 'transport', 'contractId', 'contractVersion',
    'contractSha256', 'catalogSha256', 'generatorSha256', 'claims',
  ], [], 'SignalLab source identity');
  literal(identity.driverId, 'signal-lab', 'SignalLab driver identity');
  literal(identity.sourceKind, 'signal-lab-simulation', 'SignalLab source kind');
  literal(identity.execution, 'signal-lab-simulation', 'SignalLab execution kind');
  literal(identity.transport, SIGNAL_LAB_BRIDGE_PROTOCOL, 'SignalLab transport');
  literal(identity.contractId, SIGNAL_LAB_BRIDGE_CONTRACT_ID, 'SignalLab identity contract ID');
  literal(identity.contractVersion, 1, 'SignalLab identity contract version');
  sha256(identity.contractSha256, 'SignalLab contract hash');
  sha256(identity.catalogSha256, 'SignalLab catalog hash');
  sha256(identity.generatorSha256, 'SignalLab generator hash');
  const claims = exactRecord(identity.claims, ['usbEmulated', 'firmwareExecuted', 'rfEmitted'], [], 'SignalLab claims');
  literal(claims.usbEmulated, false, 'SignalLab USB claim');
  literal(claims.firmwareExecuted, false, 'SignalLab firmware claim');
  literal(claims.rfEmitted, false, 'SignalLab RF claim');
  return Object.freeze({
    driverId: 'signal-lab', sourceKind: 'signal-lab-simulation', execution: 'signal-lab-simulation',
    transport: SIGNAL_LAB_BRIDGE_PROTOCOL, contractId: SIGNAL_LAB_BRIDGE_CONTRACT_ID, contractVersion: 1,
    contractSha256: identity.contractSha256 as string, catalogSha256: identity.catalogSha256 as string,
    generatorSha256: identity.generatorSha256 as string,
    claims: Object.freeze({ usbEmulated: false, firmwareExecuted: false, rfEmitted: false }),
  });
}

function parseCapabilities(value: unknown): readonly SignalLabBridgeCapability[] {
  const values = array(value, 2, 2, 'SignalLab capabilities');
  const spectrum = exactRecord(values[0], [
    'kind', 'minimumFrequencyHz', 'maximumFrequencyHz', 'minimumPoints', 'maximumPoints',
    'frequencyUnit', 'powerUnit', 'qualification',
  ], [], 'SignalLab spectrum capability');
  literal(spectrum.kind, 'swept-spectrum', 'SignalLab spectrum capability kind');
  literal(spectrum.minimumFrequencyHz, 1, 'SignalLab minimum spectrum frequency');
  literal(spectrum.maximumFrequencyHz, MAX_FREQUENCY_HZ, 'SignalLab maximum spectrum frequency');
  literal(spectrum.minimumPoints, 2, 'SignalLab minimum spectrum points');
  literal(spectrum.maximumPoints, MAX_SPECTRUM_POINTS, 'SignalLab maximum spectrum points');
  literal(spectrum.frequencyUnit, 'Hz', 'SignalLab frequency unit');
  literal(spectrum.powerUnit, 'dBm', 'SignalLab spectrum power unit');
  literal(spectrum.qualification, 'synthetic-visual-projection', 'SignalLab spectrum qualification');
  const detected = exactRecord(values[1], [
    'kind', 'minimumPoints', 'maximumPoints', 'minimumSamplePeriodSeconds', 'maximumSamplePeriodSeconds',
    'powerUnit', 'qualification',
  ], [], 'SignalLab detected-power capability');
  literal(detected.kind, 'detected-power-timeseries', 'SignalLab detected-power capability kind');
  literal(detected.minimumPoints, 1, 'SignalLab minimum detected-power points');
  literal(detected.maximumPoints, MAX_DETECTED_POWER_POINTS, 'SignalLab maximum detected-power points');
  literal(detected.minimumSamplePeriodSeconds, MIN_SAMPLE_PERIOD_SECONDS, 'SignalLab minimum sample period');
  literal(detected.maximumSamplePeriodSeconds, MAX_SAMPLE_PERIOD_SECONDS, 'SignalLab maximum sample period');
  literal(detected.powerUnit, 'dBm', 'SignalLab detected-power unit');
  literal(detected.qualification, 'synthetic-visual-projection', 'SignalLab detected-power qualification');
  return Object.freeze([
    Object.freeze({
      kind: 'swept-spectrum' as const, minimumFrequencyHz: 1 as const, maximumFrequencyHz: MAX_FREQUENCY_HZ,
      minimumPoints: 2 as const, maximumPoints: MAX_SPECTRUM_POINTS, frequencyUnit: 'Hz' as const,
      powerUnit: 'dBm' as const, qualification: 'synthetic-visual-projection' as const,
    }),
    Object.freeze({
      kind: 'detected-power-timeseries' as const, minimumPoints: 1 as const, maximumPoints: MAX_DETECTED_POWER_POINTS,
      minimumSamplePeriodSeconds: MIN_SAMPLE_PERIOD_SECONDS, maximumSamplePeriodSeconds: MAX_SAMPLE_PERIOD_SECONDS,
      powerUnit: 'dBm' as const, qualification: 'synthetic-visual-projection' as const,
    }),
  ]);
}

function parseChannel(value: unknown): SignalLabChannelConfiguration {
  const channel = exactRecord(value, ['model', 'noiseFloorDbm', 'seed', 'fadingRateHz'], [], 'SignalLab channel');
  const model = oneOf(channel.model, ['awgn', 'rayleigh'] as const, 'SignalLab channel model');
  const noiseFloorDbm = finite(channel.noiseFloorDbm, -150, -30, 'SignalLab noise floor');
  const seed = integer(channel.seed, 1, 0xffff_ffff, 'SignalLab channel seed');
  const fadingRateHz = finite(channel.fadingRateHz, 0.1, 100, 'SignalLab fading rate');
  return Object.freeze({ model, noiseFloorDbm, seed, fadingRateHz });
}

function parseWaveform(value: unknown): SignalLabWaveformDescriptor {
  const waveform = exactRecord(value, [
    'id', 'label', 'family', 'model', 'qualification', 'centerHz', 'occupiedBandwidthHz',
    'recommendedSpanHz', 'projection', 'standard', 'disclosure',
  ], ['assetSha256'], 'SignalLab waveform');
  const id = profileId(waveform.id, 'SignalLab waveform ID');
  const label = boundedString(waveform.label, 1, 512, 'SignalLab waveform label');
  const family = oneOf(waveform.family, ['tone', 'analog', 'geran', 'e-utra', 'nr', 'wlan'] as const, 'SignalLab waveform family');
  const model = boundedString(waveform.model, 1, 1_024, 'SignalLab waveform model');
  const qualification = oneOf(waveform.qualification, ['visual', 'standards-derived', 'conformance-validated'] as const, 'SignalLab waveform qualification');
  const centerHz = integer(waveform.centerHz, 1, MAX_FREQUENCY_HZ, 'SignalLab waveform center');
  const occupiedBandwidthHz = integer(waveform.occupiedBandwidthHz, 1, MAX_FREQUENCY_HZ, 'SignalLab occupied bandwidth');
  const recommendedSpanHz = integer(waveform.recommendedSpanHz, occupiedBandwidthHz, MAX_FREQUENCY_HZ, 'SignalLab recommended span');
  const projectionRecord = exactRecord(waveform.projection, ['allocation', 'modulation', 'timing'], ['subcarrierSpacingHz', 'nominalResourceBlocks'], 'SignalLab waveform projection');
  const projection: SignalLabWaveformDescriptor['projection'] = Object.freeze({
    allocation: oneOf(projectionRecord.allocation, ['carrier', 'sidebands', 'full', 'boosted', 'single-prb', 'narrowband', 'multi-ru', 'resource-unit'] as const, 'SignalLab projection allocation'),
    modulation: oneOf(projectionRecord.modulation, ['unmodulated', 'am', 'fm', 'gmsk', 'qpsk', 'aqpsk', '8psk', '16qam', '32qam', '64qam', '256qam', '1024qam', 'ofdm-mixed', 'he-ofdm'] as const, 'SignalLab projection modulation'),
    timing: oneOf(projectionRecord.timing, ['continuous', 'burst', 'frame', 'subslot', 'slot', 'sbfd-du', 'sbfd-ud', 'sbfd-dud'] as const, 'SignalLab projection timing'),
    ...(projectionRecord.subcarrierSpacingHz === undefined ? {} : { subcarrierSpacingHz: integer(projectionRecord.subcarrierSpacingHz, 1, MAX_FREQUENCY_HZ, 'SignalLab subcarrier spacing') }),
    ...(projectionRecord.nominalResourceBlocks === undefined ? {} : { nominalResourceBlocks: integer(projectionRecord.nominalResourceBlocks, 1, 100_000, 'SignalLab resource blocks') }),
  });
  const standardRecord = exactRecord(waveform.standard, ['organization', 'specification', 'clause', 'revision', 'url'], [], 'SignalLab waveform standard');
  const standard: SignalLabWaveformDescriptor['standard'] = Object.freeze({
    organization: oneOf(standardRecord.organization, ['TinySA SignalLab', '3GPP', 'IEEE'] as const, 'SignalLab standards organization'),
    specification: boundedString(standardRecord.specification, 1, 512, 'SignalLab specification'),
    clause: boundedString(standardRecord.clause, 1, 512, 'SignalLab specification clause'),
    revision: boundedString(standardRecord.revision, 1, 512, 'SignalLab specification revision'),
    url: webUrl(standardRecord.url, 'SignalLab specification URL'),
  });
  const disclosure = boundedString(waveform.disclosure, 1, 4_096, 'SignalLab waveform disclosure');
  const assetSha256 = waveform.assetSha256 === undefined ? undefined : sha256(waveform.assetSha256, 'SignalLab waveform asset hash');
  if (qualification === 'conformance-validated' && !assetSha256) throw new SignalLabBridgeProtocolError('Conformance-validated SignalLab waveform is missing its asset hash');
  return Object.freeze({
    id, label, family, model, qualification, centerHz, occupiedBandwidthHz, recommendedSpanHz,
    projection, standard, disclosure, ...(assetSha256 ? { assetSha256 } : {}),
  });
}

async function requireSafeExecutable(path: string): Promise<void> {
  let metadata;
  try { metadata = await lstat(path); }
  catch (cause) { throw new Error(`SignalLab measurement bridge is unavailable: ${path}`, { cause }); }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`SignalLab measurement bridge must be a regular non-symlink file: ${path}`);
  if (await realpath(path) !== path) throw new Error(`SignalLab measurement bridge path must not contain indirection: ${path}`);
  if ((metadata.mode & 0o111) === 0) throw new Error(`SignalLab measurement bridge is not executable: ${path}`);
  if ((metadata.mode & 0o022) !== 0) throw new Error(`SignalLab measurement bridge must not be group- or world-writable: ${path}`);
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid() && metadata.uid !== 0) {
    throw new Error(`SignalLab measurement bridge must be owned by the current user or root: ${path}`);
  }
}

function normalizeOptions(options: SignalLabBridgeClientOptions): NormalizedSignalLabBridgeClientOptions {
  const runtimeExecutablePath = options.runtimeExecutablePath?.trim() || process.execPath;
  if (!isAbsolute(runtimeExecutablePath)) throw new TypeError('SignalLab bridge runtime executable path must be absolute');
  return {
    readyTimeoutMs: duration(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, 'SignalLab ready timeout'),
    requestTimeoutMs: duration(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 'SignalLab request timeout'),
    shutdownTimeoutMs: duration(options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS, 'SignalLab shutdown timeout'),
    runtimeExecutablePath: resolve(runtimeExecutablePath),
    diagnostics: options.diagnostics,
    onTerminalFailure: options.onTerminalFailure,
  };
}

function admittedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const admitted: NodeJS.ProcessEnv = {};
  for (const name of ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ']) {
    const value = environment[name];
    if (value !== undefined) admitted[name] = value;
  }
  admitted.NODE_ENV = 'production';
  // In Electron, process.execPath is the Electron binary. This makes that exact,
  // admitted runtime execute the bridge as Node rather than starting another app.
  admitted.ELECTRON_RUN_AS_NODE = '1';
  return admitted;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SignalLabBridgeProtocolError(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new SignalLabBridgeProtocolError(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  const result = record(value, label);
  exactKeys(result, required, optional, label);
  return result;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const keys = Object.keys(value).sort();
  const admitted = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const extra = keys.filter((key) => !admitted.has(key));
  if (missing.length || extra.length) throw new SignalLabBridgeProtocolError(`${label} fields are invalid (missing: ${missing.join(',') || 'none'}; extra: ${extra.join(',') || 'none'})`);
}

function array(value: unknown, minimum: number, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new SignalLabBridgeProtocolError(`${label} length is outside ${minimum}..${maximum}`);
  return value;
}

function literal<const T extends string | number | boolean | null>(value: unknown, expected: T, label: string): asserts value is T {
  if (value !== expected) throw new SignalLabBridgeProtocolError(`${label} must be ${String(expected)}`);
}

function boundedString(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) throw new SignalLabBridgeProtocolError(`${label} is not a bounded string`);
  return value;
}

function profileId(value: unknown, label: string): string {
  const result = boundedString(value, 1, 256, label);
  if (!PROFILE_PATTERN.test(result)) throw new SignalLabBridgeProtocolError(`${label} is not a canonical profile ID`);
  return result;
}

function uuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new SignalLabBridgeProtocolError(`${label} is not a UUID`);
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new SignalLabBridgeProtocolError(`${label} is not a lowercase SHA-256 digest`);
  return value;
}

function instant(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) throw new SignalLabBridgeProtocolError(`${label} is not a canonical UTC instant`);
}

function finite(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new SignalLabBridgeProtocolError(`${label} is outside ${minimum}..${maximum}`);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  const result = finite(value, minimum, maximum, label);
  if (!Number.isSafeInteger(result)) throw new SignalLabBridgeProtocolError(`${label} must be a safe integer`);
  return result;
}

function frequency(value: unknown, label: string): number { return integer(value, 1, MAX_FREQUENCY_HZ, label); }

function oneOf<const T extends readonly (string | number)[]>(value: unknown, admitted: T, label: string): T[number] {
  if (!admitted.includes(value as never)) throw new SignalLabBridgeProtocolError(`${label} is not admitted`);
  return value as T[number];
}

function webUrl(value: unknown, label: string): string {
  const result = boundedString(value, 1, 2_048, label);
  let parsed: URL;
  try { parsed = new URL(result); }
  catch (cause) { throw new SignalLabBridgeProtocolError(`${label} is invalid`, { cause }); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new SignalLabBridgeProtocolError(`${label} must use HTTP(S)`);
  return result;
}

function duration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 10 || value > 120_000) throw new RangeError(`${label} must be an integer in 10..120000 ms`);
  return value;
}

function asError(value: unknown, context: string): Error {
  if (value instanceof Error) return value;
  return new SignalLabBridgeTerminalError(`${context}: ${String(value)}`);
}

function withTimeout<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolveValue, reject) => {
    const timer = setTimeout(() => reject(new SignalLabBridgeTerminalError(message)), milliseconds);
    operation.then(
      (value) => { clearTimeout(timer); resolveValue(value); },
      (value: unknown) => { clearTimeout(timer); reject(value); },
    );
  });
}
