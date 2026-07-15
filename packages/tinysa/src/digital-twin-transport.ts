import { spawn, type ChildProcess } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  TINYSA_SHELL_PROMPT,
  ZS407_FIRMWARE_LIMITS,
  digitalTwinProvenanceSchema,
  portCandidateSchema,
  type AnalyzerConfig,
  type DigitalTwinProvenance,
  type GeneratorConfig,
  type InstrumentTransportKind,
  type PortCandidate,
} from '@tinysa/contracts';
import type { ByteTransport, TransportAcquisitionMetadata, TransportDiscoveryResult, TransportEvent } from './transport.js';

const BRIDGE_CONTRACT_VERSION = 1 as const;
const BRIDGE_READY_TIMEOUT_MS = 120_000;
const BRIDGE_REQUEST_TIMEOUT_MS = 180_000;
const BRIDGE_SHUTDOWN_TIMEOUT_MS = 10_000;
const BRIDGE_PROCESS_GROUP_EXIT_GRACE_MS = 500;
const MAX_BRIDGE_LINE_BYTES = 2_000_000;
const MAX_BRIDGE_SCRIPT_BYTES = 1_000_000;
const MAX_STDERR_CHARS = 8_000;
const EMPTY_BUFFER = Buffer.alloc(0);
const encoder = new TextEncoder();
const prompt = encoder.encode(TINYSA_SHELL_PROMPT);
const HELP_COMMANDS = [
  'version', 'info', 'help', 'status', 'pause', 'resume', 'abort',
  'mode', 'sweep', 'scan', 'scanraw', 'zero', 'rbw', 'attenuate', 'sweeptime', 'spur', 'avoid', 'lna', 'trigger', 'calc', 'trace', 'marker',
  'freq', 'level', 'modulation', 'output', 'vbat', 'deviceid', 'capture', 'touch', 'release',
] as const;

interface BridgeReady {
  type: 'ready';
  contractVersion: 1;
  backend: 'renode-executable-twin';
  firmwareRelease: 'lab-v0.2.0-protocol';
  firmwareSourceCommit: 'd12bd826555eee51505542a55fd184ade5817d58';
  firmwareBinarySha256: 'a1dbaa03978a25b2a8b2a0e85f60029a6cc736481732eff68e93362724683dd7';
  usbTransactionsModeled: false;
  bridge: 'renode-monitor-v1';
  bootEvidence: string;
}

interface BridgeResponse { id: string; ok: boolean; contractVersion: 1; result?: unknown; error?: { code?: unknown; message?: unknown }; }

type TwinBridgeProcess = ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable };
type TwinBridgeState = 'booting' | 'ready' | 'closing' | 'closed' | 'faulted';

class TwinBridgeClient {
  readonly #child: TwinBridgeProcess;
  readonly #pending = new Map<string, { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  readonly #ready: Promise<DigitalTwinProvenance>;
  readonly #exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #resolveReady?: (value: DigitalTwinProvenance) => void;
  #rejectReady?: (error: Error) => void;
  #resolveExit?: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  #requestSequence = 0;
  #stderr = '';
  #stdout = EMPTY_BUFFER;
  #readySettled = false;
  #exitSettled = false;
  #terminalNotified = false;
  #shutdownAcknowledged = false;
  #state: TwinBridgeState = 'booting';
  #terminalError?: Error;
  #closePromise?: Promise<void>;
  #terminationPromise?: Promise<void>;

  private constructor(child: TwinBridgeProcess, private readonly onUnexpectedFailure: (error: Error) => void) {
    this.#child = child;
    this.#ready = new Promise((resolveReady, rejectReady) => { this.#resolveReady = resolveReady; this.#rejectReady = rejectReady; });
    this.#exited = new Promise((resolveExit) => { this.#resolveExit = resolveExit; });
    this.#child.stdout.on('data', (chunk: Buffer | string) => this.#acceptStdout(toBuffer(chunk)));
    this.#child.stdout.once('end', () => {
      if (this.#state === 'closed' || this.#state === 'faulted') return;
      if (this.#state === 'closing' && this.#shutdownAcknowledged) return;
      this.#poison(new Error(this.#stdout.length
        ? 'Digital twin bridge ended with an unterminated response frame'
        : 'Digital twin bridge stdout ended unexpectedly'));
    });
    this.#child.stderr.on('data', (chunk: Buffer | string) => this.#acceptStderr(toBuffer(chunk)));
    this.#child.once('exit', (code, signal) => this.#acceptProcessExit(code, signal));
    this.#child.once('close', (code, signal) => this.#settleExit(code, signal));
    this.#child.once('error', (error) => {
      const wrapped = new Error(`Digital twin bridge process failed: ${error.message}`);
      this.#poison(wrapped);
    });
  }

  static async launch(command: string, onUnexpectedFailure: (error: Error) => void): Promise<TwinBridgeClient> {
    const admitted = await admitBridgeCommand(command);
    let child: TwinBridgeProcess | undefined;
    try {
      child = spawn('/bin/sh', ['-c', '. /dev/fd/3', admitted.path], {
        cwd: admitted.cwd,
        detached: true,
        env: bridgeEnvironment(process.env),
        stdio: ['pipe', 'pipe', 'pipe', admitted.handle.fd],
      }) as TwinBridgeProcess;
      return new TwinBridgeClient(child, onUnexpectedFailure);
    } catch (error) {
      child?.kill('SIGKILL');
      throw error;
    } finally {
      await admitted.handle.close();
    }
  }

  async start(): Promise<DigitalTwinProvenance> {
    const timer = setTimeout(() => this.#poison(new Error('Digital twin bridge boot timed out')), BRIDGE_READY_TIMEOUT_MS);
    try {
      const provenance = await this.#ready;
      if (this.#state !== 'ready') throw this.#terminalError ?? new Error('Digital twin bridge failed during startup');
      return provenance;
    }
    finally { clearTimeout(timer); }
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#state !== 'ready') throw new Error('Digital twin bridge is unavailable');
    return this.#beginRequest(method, params, BRIDGE_REQUEST_TIMEOUT_MS);
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      const attempt = this.#closeOnce();
      this.#closePromise = attempt;
      void attempt.catch(() => {
        if (this.#closePromise === attempt) this.#closePromise = undefined;
      });
    }
    return this.#closePromise;
  }

  async #closeOnce(): Promise<void> {
    if (this.#state === 'closed') return;
    if (this.#state === 'faulted') {
      await this.#terminate();
      this.#state = 'closed';
      return;
    }
    if (this.#state === 'booting') {
      this.#poison(new Error('Digital twin bridge was closed before startup completed'), false);
      await this.#terminate();
      this.#state = 'closed';
      return;
    }
    this.#state = 'closing';
    try {
      await this.#beginRequest('shutdown', {}, BRIDGE_SHUTDOWN_TIMEOUT_MS, true);
      const exit = await withTimeout(this.#exited, BRIDGE_SHUTDOWN_TIMEOUT_MS, 'Digital twin bridge did not stop after shutdown');
      if (exit.code !== 0 || exit.signal !== null) {
        throw new Error(`Digital twin bridge shutdown exited (code ${String(exit.code)}, signal ${String(exit.signal)})`);
      }
      await this.#confirmProcessGroupExited(this.#child.pid);
      this.#state = 'closed';
    } catch (value) {
      const error = asError(value);
      this.#poison(error, false);
      try { await this.#terminate(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Digital twin bridge shutdown failed and forced process-group cleanup also failed');
      }
      throw error;
    }
  }

  #beginRequest(method: string, params: Record<string, unknown>, timeoutMs: number, whileClosing = false): Promise<unknown> {
    if ((whileClosing && this.#state !== 'closing') || (!whileClosing && this.#state !== 'ready')) {
      return Promise.reject(new Error('Digital twin bridge is unavailable'));
    }
    const id = `twin-${++this.#requestSequence}`;
    const payload = `${JSON.stringify({ id, contractVersion: BRIDGE_CONTRACT_VERSION, method, params })}\n`;
    const response = new Promise<unknown>((resolveValue, reject) => {
      const timer = setTimeout(() => {
        this.#poison(new Error(`Digital twin ${method} timed out; the request was not retried`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve: resolveValue, reject, timer });
    });
    try {
      this.#child.stdin.write(payload, (error) => {
        if (error) this.#poison(new Error(`Digital twin ${method} request could not be written: ${error.message}`));
      });
    } catch (value) {
      this.#poison(new Error(`Digital twin ${method} request could not be written: ${asError(value).message}`));
    }
    return response;
  }

  #acceptStdout(chunk: Buffer): void {
    if (this.#state === 'closed' || this.#state === 'faulted') return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const segmentLength = end - offset;
      if (this.#stdout.length + segmentLength > MAX_BRIDGE_LINE_BYTES) {
        this.#poison(new Error('Digital twin bridge emitted an oversized response'));
        return;
      }
      if (segmentLength) {
        const segment = chunk.subarray(offset, end);
        this.#stdout = this.#stdout.length ? Buffer.concat([this.#stdout, segment]) : Buffer.from(segment);
      }
      if (newline < 0) return;
      const frame = this.#stdout;
      this.#stdout = EMPTY_BUFFER;
      this.#handleFrame(frame);
      if (this.#isTerminal()) return;
      offset = newline + 1;
    }
  }

  #acceptStderr(chunk: Buffer): void {
    const bounded = chunk.subarray(Math.max(0, chunk.length - MAX_STDERR_CHARS * 4)).toString('utf8');
    this.#stderr = `${this.#stderr}${bounded}`.slice(-MAX_STDERR_CHARS);
  }

  #handleFrame(frame: Buffer): void {
    try {
      if (frame.at(-1) === 0x0d) throw new Error('Digital twin bridge emitted a non-canonical CRLF frame');
      const line = new TextDecoder('utf-8', { fatal: true }).decode(frame);
      const record = asRecord(JSON.parse(line), 'Digital twin bridge response');
      if (record.type === 'ready') {
        if (this.#readySettled || this.#state !== 'booting') throw new Error('Digital twin bridge emitted duplicate ready state');
        const ready = validateReady(record);
        const provenance = digitalTwinProvenanceSchema.parse({
          contractVersion: ready.contractVersion,
          bridge: ready.bridge,
          firmwareRelease: ready.firmwareRelease,
          repositoryCommit: ready.firmwareSourceCommit,
          firmwareBinarySha256: ready.firmwareBinarySha256,
          usbTransactionsModeled: ready.usbTransactionsModeled,
          bootEvidence: ready.bootEvidence,
        });
        this.#readySettled = true;
        this.#state = 'ready';
        this.#resolveReady?.(provenance);
        return;
      }
      if (record.type === 'fatal') throw validateFatal(record);
      const response = validateResponse(record);
      const pending = this.#pending.get(response.id);
      if (!pending) throw new Error(`Digital twin bridge returned unknown request ${response.id}`);
      this.#pending.delete(response.id);
      clearTimeout(pending.timer);
      if (!response.ok) pending.reject(bridgeError(response.error));
      else {
        if (pending.method === 'shutdown' && this.#state === 'closing') this.#shutdownAcknowledged = true;
        pending.resolve(response.result);
      }
    } catch (value) {
      const error = value instanceof SyntaxError
        ? new Error(`Digital twin bridge emitted malformed JSON: ${singleLine(frame.toString('utf8'))}`)
        : asError(value);
      this.#poison(error);
    }
  }

  #settleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exitSettled) return;
    this.#exitSettled = true;
    this.#resolveExit?.({ code, signal });
  }

  #acceptProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#settleExit(code, signal);
    if (this.#state === 'faulted' || this.#state === 'closed') return;
    if (this.#state === 'closing' && code === 0 && signal === null) return;
    this.#poison(new Error(`Digital twin bridge exited (code ${String(code)}, signal ${String(signal)})${this.#stderr ? `: ${singleLine(this.#stderr)}` : ''}`));
  }

  #poison(error: Error, notify = true): void {
    if (this.#state === 'faulted' || this.#state === 'closed') return;
    this.#state = 'faulted';
    this.#terminalError = error;
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#rejectReady?.(error);
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    void this.#terminate();
    if (notify && !this.#terminalNotified) {
      this.#terminalNotified = true;
      try { this.onUnexpectedFailure(error); } catch { /* Observational only. */ }
    }
  }

  #terminate(): Promise<void> {
    if (this.#terminationPromise) return this.#terminationPromise;
    const pid = this.#child.pid;
    if (pid === undefined) {
      this.#child.kill('SIGKILL');
    } else {
      try { process.kill(-pid, 'SIGSTOP'); } catch { /* The leader may already have exited. */ }
      try { process.kill(-pid, 'SIGKILL'); }
      catch { this.#child.kill('SIGKILL'); }
    }
    const attempt = this.#finishTermination(pid);
    this.#terminationPromise = attempt;
    void attempt.catch(() => {
      if (this.#terminationPromise === attempt) this.#terminationPromise = undefined;
    });
    return attempt;
  }

  async #finishTermination(pid: number | undefined): Promise<void> {
    await withTimeout(this.#exited, BRIDGE_SHUTDOWN_TIMEOUT_MS, 'Digital twin bridge did not terminate after SIGKILL');
    if (pid === undefined) return;
    const deadline = Date.now() + BRIDGE_SHUTDOWN_TIMEOUT_MS;
    let permissionError: Error | undefined;
    while (Date.now() < deadline) {
      let probe: ProcessGroupProbe;
      try { probe = probeProcessGroup(pid); }
      catch (value) {
        throw new Error(`Digital twin bridge process-group verification failed: ${asError(value).message}`, { cause: value });
      }
      if (probe.state === 'gone') return;
      if (probe.state === 'permission-denied') {
        permissionError = probe.error;
        await new Promise<void>((resolveValue) => setTimeout(resolveValue, 10));
        continue;
      }
      permissionError = undefined;
      try { process.kill(-pid, 'SIGKILL'); } catch { /* The next probe determines completion. */ }
      await new Promise<void>((resolveValue) => setTimeout(resolveValue, 10));
    }
    if (permissionError) {
      throw new Error(`Digital twin bridge process-group verification failed: ${permissionError.message}`, { cause: permissionError });
    }
    throw new Error('Digital twin bridge process group remained alive after SIGKILL');
  }

  async #confirmProcessGroupExited(pid: number | undefined): Promise<void> {
    if (pid === undefined) return;
    const deadline = Date.now() + BRIDGE_PROCESS_GROUP_EXIT_GRACE_MS;
    let permissionError: Error | undefined;
    while (Date.now() < deadline) {
      let probe: ProcessGroupProbe;
      try { probe = probeProcessGroup(pid); }
      catch (value) {
        throw new Error(`Digital twin graceful process-group verification failed: ${asError(value).message}`, { cause: value });
      }
      if (probe.state === 'gone') return;
      if (probe.state === 'permission-denied') permissionError = probe.error;
      else permissionError = undefined;
      await new Promise<void>((resolveValue) => setTimeout(resolveValue, 10));
    }
    if (permissionError) {
      throw new Error(`Digital twin graceful process-group verification failed: ${permissionError.message}`, { cause: permissionError });
    }
    throw new Error('Digital twin bridge process group remained alive after graceful shutdown');
  }

  #isTerminal(): boolean { return this.#state === 'faulted' || this.#state === 'closed'; }
}

export class RenodeDigitalTwinTransport implements ByteTransport {
  readonly kind = 'renode-monitor-bridge' as const;
  readonly port: PortCandidate;
  readonly #bytes = new Set<(bytes: Uint8Array) => void>();
  readonly #events = new Set<(event: TransportEvent) => void>();
  readonly #bridgeCommand: string;
  #client?: TwinBridgeClient;
  #open = false;
  #closing = false;
  #startHz = 88_000_000;
  #stopHz = 108_000_000;
  #points = 450;
  #rbwKhz: number | 'auto' = 'auto';
  #attenuationDb: number | 'auto' = 'auto';
  #sweepTimeSeconds: number | 'auto' = 'auto';
  #detector: AnalyzerConfig['detector'] = 'sample';
  #spurRejection: AnalyzerConfig['spurRejection'] = 'auto';
  #lna: AnalyzerConfig['lna'] = 'off';
  #avoidSpurs: AnalyzerConfig['avoidSpurs'] = 'auto';
  #triggerMode: AnalyzerConfig['trigger']['mode'] = 'auto';
  #triggerLevelDbm?: number;
  #mode: 'input' | 'output' = 'input';
  #generator: GeneratorConfig = { frequencyHz: 100_000_000, levelDbm: -30, path: 'mixer', modulation: 'off', modulationFrequencyHz: 1_000, amDepthPercent: 80, fmDeviationHz: 3_000 };
  #generatorConfigured = false;
  #generatorEnabled = false;
  #lastAcquisition?: TransportAcquisitionMetadata;

  constructor(firmwareRepository: string) {
    this.#bridgeCommand = resolve(firmwareRepository, 'tools/run-atomizer-twin-bridge.sh');
    this.port = portCandidateSchema.parse({
      id: 'digital-twin:zs407:lab-v0.2.0-protocol',
      path: 'twin://renode/zs407/lab-v0.2.0-protocol',
      manufacturer: 'TinySA Firmware',
      product: 'ZS407 executable digital twin',
      usbMatch: 'firmware-digital-twin',
      transport: 'renode-monitor-bridge',
      execution: 'firmware-digital-twin',
      digitalTwin: {
        contractVersion: 1,
        bridge: 'renode-monitor-v1',
        firmwareRelease: 'lab-v0.2.0-protocol',
        repositoryCommit: 'd12bd826555eee51505542a55fd184ade5817d58',
        firmwareBinarySha256: 'a1dbaa03978a25b2a8b2a0e85f60029a6cc736481732eff68e93362724683dd7',
        usbTransactionsModeled: false,
      },
    });
  }

  async list(): Promise<TransportDiscoveryResult> { return { candidates: [structuredClone(this.port)], failures: [] }; }

  async open(candidate: PortCandidate): Promise<void> {
    if (this.#open || this.#client) throw new Error('Digital twin transport is already open');
    const input = portCandidateSchema.parse(candidate);
    if (input.id !== this.port.id || input.execution !== 'firmware-digital-twin') throw new Error('Digital twin transport received an unknown candidate');
    delete candidate.digitalTwin?.bootEvidence;
    const client = await TwinBridgeClient.launch(this.#bridgeCommand, (error) => this.#unexpectedFailure(error));
    this.#client = client;
    try {
      const provenance = await client.start();
      candidate.digitalTwin = provenance;
      this.port.digitalTwin = structuredClone(provenance);
      this.#open = true;
      this.#emitEvent({ type: 'opened' });
    } catch (error) {
      try {
        await client.close();
        if (this.#client === client) this.#client = undefined;
      }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Digital twin startup failed and bridge cleanup also failed'); }
      throw error;
    }
  }

  async close(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    this.#closing = true;
    this.#open = false;
    try {
      await client.close();
      this.#client = undefined; this.#open = false; this.#closing = false; this.#generatorConfigured = false; this.#generatorEnabled = false; this.#lastAcquisition = undefined;
      this.#emitEvent({ type: 'closed', reason: 'Digital twin bridge stopped' });
    }
    finally { this.#closing = false; }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.#open || !this.#client) throw new Error('Digital twin transport is not open');
    const wire = new TextDecoder('utf8', { fatal: true }).decode(bytes);
    if (!wire.endsWith('\r')) throw new Error('Digital twin shell adapter requires a carriage-return terminator');
    const command = wire.slice(0, -1);
    if (!command || command.length > 47 || !/^[\x20-\x7e]+$/.test(command)) throw new Error('Digital twin shell adapter received a malformed command');
    const payload = await this.#response(command);
    const echo = encoder.encode(`${command}\r\n`);
    const body = typeof payload === 'string' ? encoder.encode(payload ? `${payload}\r\n` : '') : payload;
    this.#emitBytes(concatenate(echo, body, prompt));
  }

  onBytes(listener: (bytes: Uint8Array) => void): () => void { this.#bytes.add(listener); return () => this.#bytes.delete(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { this.#events.add(listener); return () => this.#events.delete(listener); }
  consumeAcquisitionMetadata(): TransportAcquisitionMetadata | undefined { const value = this.#lastAcquisition; this.#lastAcquisition = undefined; return value ? structuredClone(value) : undefined; }

  async #response(command: string): Promise<string | Uint8Array> {
    const [name, ...args] = command.split(/\s+/);
    switch (name) {
      case 'version': return 'tinySA4_v0.2.0_protocol-v2\r\nHW Version:V0.5.4 + ZS407 max2871 · RENODE EXECUTABLE TWIN';
      case 'info': return 'tinySA4 + ZS407\r\nVersion: lab-v0.2.0-protocol\r\nPlatform: STM32F303 executable twin\r\nBridge: renode-monitor-v1 · USB transactions not modeled';
      case 'help': return `commands: ${HELP_COMMANDS.slice(0, 24).join(' ')}\r\nOther commands: ${HELP_COMMANDS.slice(24).join(' ')}`;
      case 'mode': return this.#modeCommand(args);
      case 'output': return this.#outputCommand(args);
      case 'sweep': return this.#sweepCommand(args);
      case 'rbw': return this.#rbwCommand(args);
      case 'attenuate': return this.#attenuationCommand(args);
      case 'sweeptime': return this.#sweepTimeCommand(args);
      case 'calc': return this.#detectorCommand(args);
      case 'spur': return this.#optionCommand(args, ['off', 'on', 'auto'], (value) => { this.#spurRejection = value as AnalyzerConfig['spurRejection']; });
      case 'avoid': return this.#optionCommand(args, ['auto', 'off', 'on'], (value) => { this.#avoidSpurs = value as AnalyzerConfig['avoidSpurs']; });
      case 'lna': return this.#optionCommand(args, ['off', 'on'], (value) => { this.#lna = value as AnalyzerConfig['lna']; });
      case 'trigger': return this.#triggerCommand(args);
      case 'scan': return this.#scan(args, false);
      case 'scanraw': return this.#scan(args, true);
      case 'zero': return args.length ? 'usage: zero {level}' : 'zero {level}\r\n174dBm';
      case 'freq': this.#generator = { ...this.#generator, frequencyHz: unsigned(args[0], 'generator frequency') }; return '';
      case 'level': this.#generator = { ...this.#generator, levelDbm: numeric(args[0], 'generator level') }; return '';
      case 'modulation': return this.#modulationCommand(args);
      case 'capture': return this.#capture();
      case 'touch': return this.#touch(args);
      case 'release': await this.#request('release_touch'); return '';
      case 'vbat': return '4170 mV';
      case 'deviceid': return 'deviceid 407';
      case 'status': return 'Resumed';
      case 'trace': return args.length === 0 ? '1: dBm 0.000000 10.000000' : '';
      case 'marker':
      case 'pause':
      case 'resume':
      case 'abort': return '';
      default: return `${name}?`;
    }
  }

  #modeCommand(args: string[]): string {
    const value = args.at(-1);
    if (value !== 'input' && value !== 'output') return 'usage: mode [low] input|output';
    this.#mode = value; this.#generatorEnabled = false;
    if (value === 'input') { this.#rbwKhz = 'auto'; this.#attenuationDb = 'auto'; this.#sweepTimeSeconds = 'auto'; this.#generatorConfigured = false; }
    return '';
  }

  async #outputCommand(args: string[]): Promise<string> {
    const value = args[0];
    if (value === 'normal' || value === 'mixer') { this.#generator = { ...this.#generator, path: value }; return ''; }
    if (value !== 'on' && value !== 'off') return 'usage: output on|off|normal|mixer';
    const enabled = value === 'on';
    if (this.#mode === 'output' && this.#generatorConfigured && enabled !== this.#generatorEnabled) {
      await this.#request('set_generator_output', { enabled });
    }
    this.#generatorEnabled = enabled;
    return '';
  }

  #sweepCommand(args: string[]): string {
    if (!args.length) return `${this.#startHz} ${this.#stopHz} ${this.#points}`;
    if (args.length < 1 || args.length > 3) return 'usage: sweep {start(Hz)} [stop(Hz)] [points]';
    const start = unsigned(args[0], 'sweep start');
    const stop = args[1] === undefined ? this.#stopHz : unsigned(args[1], 'sweep stop');
    const points = args[2] === undefined ? this.#points : unsigned(args[2], 'sweep points');
    if (start > stop) return 'frequency range is invalid';
    if (points < ZS407_FIRMWARE_LIMITS.minimumSweepPoints || points > ZS407_FIRMWARE_LIMITS.maximumSweepPoints) return `sweep points exceeds range ${ZS407_FIRMWARE_LIMITS.maximumSweepPoints}`;
    this.#startHz = start; this.#stopHz = stop; this.#points = points;
    return '';
  }

  #rbwCommand(args: string[]): string {
    if (!args.length) return `usage: rbw 0.2..850|auto\r\n${engineering(this.#rbwKhz === 'auto' ? 10_000 : this.#rbwKhz * 1_000)}Hz`;
    if (args[0] === 'auto') this.#rbwKhz = 'auto';
    else { const value = numeric(args[0], 'RBW'); if (value < 0.2 || value > 850) return 'usage: rbw 0.2..850|auto'; this.#rbwKhz = value; }
    return '';
  }

  #attenuationCommand(args: string[]): string {
    if (!args.length) return `usage: attenuate 0..31|auto\r\n${this.#attenuationDb === 'auto' ? '0.00' : this.#attenuationDb.toFixed(2)}`;
    if (args[0] === 'auto') this.#attenuationDb = 'auto';
    else { const value = numeric(args[0], 'attenuation'); if (value < 0 || value > 31) return 'usage: attenuate 0..31|auto'; this.#attenuationDb = value; }
    return '';
  }

  #sweepTimeCommand(args: string[]): string {
    if (!args.length) return `usage: sweeptime 0.003..60\r\n${this.#sweepTimeSeconds === 'auto' ? '0.08' : this.#sweepTimeSeconds}s`;
    const value = numeric(args[0], 'sweep time');
    if (value === 0) { this.#sweepTimeSeconds = 'auto'; return ''; }
    if (value < 0.003 || value > 60) return 'usage: sweeptime 0.003..60';
    this.#sweepTimeSeconds = value;
    return '';
  }

  #detectorCommand(args: string[]): string {
    const map: Record<string, AnalyzerConfig['detector']> = { off: 'sample', minh: 'minimum-hold', maxh: 'maximum-hold', maxd: 'maximum-decay', aver4: 'average-4', aver16: 'average-16', aver: 'average', quasi: 'quasi-peak' };
    const value = args.at(-1); if (!value || !map[value]) return 'usage: calc off|minh|maxh|maxd|aver4|aver16|aver|quasi'; this.#detector = map[value]; return '';
  }

  #optionCommand(args: string[], options: readonly string[], apply: (value: string) => void): string {
    const value = args[0]; if (!value || !options.includes(value)) return `usage: ${options.join('|')}`; apply(value); return '';
  }

  #triggerCommand(args: string[]): string {
    const value = args[0]; if (!value) return 'trigger {value}|auto|normal|single';
    if (value === 'auto' || value === 'normal' || value === 'single') this.#triggerMode = value;
    else { this.#triggerLevelDbm = numeric(value, 'trigger level'); if (this.#triggerMode === 'auto') this.#triggerMode = 'normal'; }
    return '';
  }

  #currentTrigger(): AnalyzerConfig['trigger'] {
    if (this.#triggerMode === 'auto') return { mode: 'auto' };
    if (this.#triggerLevelDbm === undefined) throw new Error(`Digital twin ${this.#triggerMode} trigger has no configured level`);
    return { mode: this.#triggerMode, levelDbm: this.#triggerLevelDbm };
  }

  async #scan(args: string[], raw: boolean): Promise<string | Uint8Array> {
    if (args.length < 2 || args.length > 4) return `usage: ${raw ? 'scanraw' : 'scan'} {start(Hz)} {stop(Hz)} [points] [options]`;
    const startHz = unsigned(args[0], 'scan start'); const stopHz = unsigned(args[1], 'scan stop'); const points = args[2] === undefined ? this.#points : unsigned(args[2], 'scan points');
    if (startHz > stopHz) return 'frequency range is invalid';
    if (points < ZS407_FIRMWARE_LIMITS.minimumSweepPoints || points > ZS407_FIRMWARE_LIMITS.maximumSweepPoints) return `sweep points exceeds range ${ZS407_FIRMWARE_LIMITS.maximumSweepPoints}`;
    const result = sweepResult(await this.#request('acquire_sweep', {
      startHz, stopHz, points, rbwKhz: this.#rbwKhz, attenuationDb: this.#attenuationDb, sweepTimeSeconds: this.#sweepTimeSeconds,
      detector: this.#detector, spurRejection: this.#spurRejection, lna: this.#lna, avoidSpurs: this.#avoidSpurs, trigger: this.#currentTrigger(),
    }), points);
    this.#lastAcquisition = { source: 'renode-executable-state', startHz, stopHz, points, actualRbwHz: result.actualRbwHz, actualAttenuationDb: result.actualAttenuationDb, evidence: result.bridgeEvidence };
    if (raw) return encodeRawSweep(result.powerDbm.map((power) => power + 174));
    const outmask = args[3] === undefined ? 0 : unsigned(args[3], 'scan outmask');
    if (outmask !== 3) return '';
    return result.frequencyHz.map((frequency, index) => `${frequency} ${result.powerDbm[index]!.toFixed(5)} 0.000000`).join('\r\n');
  }

  async #modulationCommand(args: string[]): Promise<string> {
    const value = args[0];
    if (value === 'freq') this.#generator = { ...this.#generator, modulationFrequencyHz: unsigned(args[1], 'modulation frequency') };
    else if (value === 'depth') this.#generator = { ...this.#generator, amDepthPercent: unsigned(args[1], 'AM depth') };
    else if (value === 'deviation') this.#generator = { ...this.#generator, fmDeviationHz: unsigned(args[1], 'FM deviation') };
    else if (value === 'off' || value === 'am' || value === 'fm') {
      this.#generator = { ...this.#generator, modulation: value };
      await this.#request('configure_generator', this.#generator);
      this.#generatorConfigured = true; this.#generatorEnabled = false;
    } else return 'usage: modulation off|am|fm|freq|depth|deviation';
    return '';
  }

  async #capture(): Promise<Uint8Array> {
    const record = asRecord(await this.#request('capture_screen'), 'Digital twin screen result');
    if (record.width !== 480 || record.height !== 320 || record.format !== 'rgb565le' || typeof record.pixelsBase64 !== 'string') throw new Error('Digital twin returned an invalid screen frame');
    const pixels = Uint8Array.from(Buffer.from(record.pixelsBase64, 'base64'));
    if (pixels.length !== 480 * 320 * 2) throw new Error(`Digital twin screen has ${pixels.length} bytes`);
    return pixels;
  }

  async #touch(args: string[]): Promise<string> { const x = unsigned(args[0], 'touch x'); const y = unsigned(args[1], 'touch y'); await this.#request('touch', { x, y }); return ''; }
  #request(method: string, params: Record<string, unknown> = {}): Promise<unknown> { const client = this.#client; if (!client) throw new Error('Digital twin bridge is unavailable'); return client.request(method, params); }
  #emitBytes(bytes: Uint8Array): void { for (const listener of this.#bytes) listener(bytes); }
  #emitEvent(event: TransportEvent): void { for (const listener of this.#events) listener(event); }
  #unexpectedFailure(error: Error): void { if (this.#closing) return; this.#open = false; this.#emitEvent({ type: 'error', error }); }
}

export class PhysicalOrTwinTransport implements ByteTransport {
  readonly #bytes = new Set<(bytes: Uint8Array) => void>();
  readonly #events = new Set<(event: TransportEvent) => void>();
  #active?: ByteTransport;
  #teardownOnly = false;
  constructor(readonly physical: ByteTransport, readonly twin: RenodeDigitalTwinTransport) {
    for (const transport of [physical, twin]) {
      transport.onBytes((bytes) => { if (this.#active === transport) for (const listener of this.#bytes) listener(bytes); });
      transport.onEvent((event) => { if (this.#active === transport) for (const listener of this.#events) listener(event); });
    }
  }
  get kind(): InstrumentTransportKind { return this.#active?.kind ?? this.physical.kind; }
  async list(): Promise<TransportDiscoveryResult> {
    try {
      const physical = await this.physical.list();
      return {
        candidates: [structuredClone(this.twin.port), ...physical.candidates],
        failures: [...physical.failures],
      };
    } catch (value) {
      return {
        candidates: [structuredClone(this.twin.port)],
        failures: [{
          sourceKind: 'serial-port',
          transport: this.physical.kind,
          code: 'enumeration-failed',
          message: boundedMessage(value, 'Physical instrument enumeration failed'),
          recoverable: true,
        }],
      };
    }
  }
  async open(candidate: PortCandidate): Promise<void> {
    if (this.#active) throw new Error('An instrument transport is already open');
    const input = portCandidateSchema.parse(candidate);
    const target = input.execution === 'firmware-digital-twin' ? this.twin : this.physical;
    this.#active = target;
    this.#teardownOnly = false;
    try { await target.open(candidate); }
    catch (error) { this.#teardownOnly = true; throw error; }
  }
  async close(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    this.#teardownOnly = true;
    await active.close();
    if (this.#active === active) {
      this.#active = undefined;
      this.#teardownOnly = false;
    }
  }
  write(bytes: Uint8Array): Promise<void> {
    if (!this.#active) return Promise.reject(new Error('No instrument transport is open'));
    if (this.#teardownOnly) return Promise.reject(new Error('Instrument transport is retained for teardown only'));
    return this.#active.write(bytes);
  }
  onBytes(listener: (bytes: Uint8Array) => void): () => void { this.#bytes.add(listener); return () => this.#bytes.delete(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { this.#events.add(listener); return () => this.#events.delete(listener); }
  consumeAcquisitionMetadata(): TransportAcquisitionMetadata | undefined {
    return this.#teardownOnly ? undefined : this.#active?.consumeAcquisitionMetadata();
  }
}

function validateReady(record: Record<string, unknown>): BridgeReady {
  const exact: Omit<BridgeReady, 'bootEvidence'> = {
    type: 'ready', contractVersion: 1, backend: 'renode-executable-twin', firmwareRelease: 'lab-v0.2.0-protocol',
    firmwareSourceCommit: 'd12bd826555eee51505542a55fd184ade5817d58', firmwareBinarySha256: 'a1dbaa03978a25b2a8b2a0e85f60029a6cc736481732eff68e93362724683dd7',
    usbTransactionsModeled: false, bridge: 'renode-monitor-v1',
  };
  assertExactKeys(record, [...Object.keys(exact), 'bootEvidence'], 'Digital twin ready envelope');
  for (const [key, value] of Object.entries(exact)) if (record[key] !== value) throw new Error(`Digital twin ready mismatch at ${key}`);
  if (typeof record.bootEvidence !== 'string' || !record.bootEvidence.startsWith('ZS407_TWIN_BOOT=PASS')) throw new Error('Digital twin omitted boot evidence');
  return { ...exact, bootEvidence: record.bootEvidence };
}
function validateResponse(record: Record<string, unknown>): BridgeResponse {
  if (typeof record.id !== 'string' || !record.id.length || record.id.length > 256 || typeof record.ok !== 'boolean' || record.contractVersion !== 1) {
    throw new Error('Digital twin bridge returned an invalid response envelope');
  }
  assertExactKeys(record, record.ok ? ['id', 'ok', 'contractVersion', 'result'] : ['id', 'ok', 'contractVersion', 'error'], 'Digital twin response envelope');
  if (!record.ok) validateBridgeError(record.error);
  return record as unknown as BridgeResponse;
}
function validateFatal(record: Record<string, unknown>): Error {
  assertExactKeys(record, ['type', 'contractVersion', 'error'], 'Digital twin fatal envelope');
  if (record.contractVersion !== 1) throw new Error('Digital twin fatal envelope has the wrong contract version');
  return bridgeError(validateBridgeError(record.error));
}
function validateBridgeError(value: unknown): Record<string, unknown> {
  const record = asRecord(value, 'Digital twin bridge error');
  assertExactKeys(record, ['code', 'message'], 'Digital twin bridge error');
  if (typeof record.code !== 'string' || !record.code.length || record.code.length > 128
    || typeof record.message !== 'string' || !record.message.length || record.message.length > 4_096) {
    throw new Error('Digital twin bridge returned an invalid error envelope');
  }
  return record;
}
function bridgeError(value: unknown): Error { const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}; return new Error(typeof record.message === 'string' ? singleLine(record.message) : 'Digital twin bridge failed without a valid error message'); }
function sweepResult(value: unknown, points: number): { frequencyHz: number[]; powerDbm: number[]; actualRbwHz: number; actualAttenuationDb: number; bridgeEvidence: string } {
  const record = asRecord(value, 'Digital twin sweep');
  if (!Array.isArray(record.frequencyHz) || !Array.isArray(record.powerDbm) || record.frequencyHz.length !== points || record.powerDbm.length !== points) throw new Error('Digital twin sweep has the wrong point count');
  const frequencyHz = record.frequencyHz.map((item) => { if (!Number.isSafeInteger(item)) throw new Error('Digital twin sweep contains an invalid frequency'); return item as number; });
  const powerDbm = record.powerDbm.map((item) => { if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error('Digital twin sweep contains invalid power'); return item; });
  if (typeof record.actualRbwHz !== 'number' || !Number.isFinite(record.actualRbwHz) || record.actualRbwHz <= 0 || typeof record.actualAttenuationDb !== 'number' || !Number.isFinite(record.actualAttenuationDb) || typeof record.bridgeEvidence !== 'string' || !record.bridgeEvidence.startsWith('ZS407_TWIN_SWEEP')) throw new Error('Digital twin sweep metadata is invalid');
  return { frequencyHz, powerDbm, actualRbwHz: record.actualRbwHz, actualAttenuationDb: record.actualAttenuationDb, bridgeEvidence: record.bridgeEvidence };
}
function encodeRawSweep(values: readonly number[]): Uint8Array { const payload = new Uint8Array(2 + values.length * 3); payload[0] = 0x7b; values.forEach((power, index) => { const signed = Math.round(power * ZS407_FIRMWARE_LIMITS.rawRssiDivisor); const encoded = signed < 0 ? signed + 0x1_0000 : signed; const offset = 1 + index * 3; payload[offset] = 0x78; payload[offset + 1] = encoded & 0xff; payload[offset + 2] = encoded >> 8; }); payload[payload.length - 1] = 0x7d; return payload; }
function unsigned(value: string | undefined, label: string): number { if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${label} must be an unsigned integer`); const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds safe integer range`); return parsed; }
function numeric(value: string | undefined, label: string): number { const parsed = Number(value); if (value === undefined || !Number.isFinite(parsed)) throw new Error(`${label} must be numeric`); return parsed; }
function asRecord(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) throw new Error(`${label} contains undeclared or missing fields`);
}
function engineering(value: number): string { if (value >= 1e9) return `${value / 1e9}G`; if (value >= 1e6) return `${value / 1e6}M`; if (value >= 1e3) return `${value / 1e3}k`; return String(value); }
function concatenate(...parts: Uint8Array[]): Uint8Array { const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
function singleLine(value: string): string { return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1_000); }
function boundedMessage(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4_096) || fallback;
}

async function admitBridgeCommand(command: string): Promise<{ path: string; cwd: string; handle: FileHandle }> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`Digital twin bridge descriptor launch is unsupported on ${process.platform}`);
  }
  const path = resolve(command);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (value) {
    throw new Error(`Digital twin bridge could not be opened safely: ${asError(value).message}`, { cause: value });
  }
  try {
    const before = await handle.stat({ bigint: true });
    validateBridgeMetadata(path, before);
    const canonical = await realpath(path);
    if (canonical !== path) throw new Error('Digital twin bridge path contains a symbolic-link component');
    const after = await handle.stat({ bigint: true });
    if (!sameFileMetadata(before, after)) throw new Error('Digital twin bridge changed during admission');
    return { path, cwd: dirname(dirname(path)), handle };
  } catch (value) {
    await handle.close();
    throw new Error(`Digital twin bridge was not admitted: ${asError(value).message}`, { cause: value });
  }
}

function validateBridgeMetadata(path: string, metadata: BigIntStats): void {
  if (!metadata.isFile()) throw new Error(`${path} is not a regular file`);
  if (metadata.size <= 0n || metadata.size > BigInt(MAX_BRIDGE_SCRIPT_BYTES)) {
    throw new Error(`Digital twin bridge size must be between 1 and ${MAX_BRIDGE_SCRIPT_BYTES} bytes`);
  }
  if (metadata.nlink !== 1n) throw new Error('Digital twin bridge must have exactly one filesystem link');
  const uid = process.getuid?.();
  if (uid === undefined || metadata.uid !== BigInt(uid)) throw new Error('Digital twin bridge must be owned by the application user');
  if ((metadata.mode & 0o022n) !== 0n) throw new Error('Digital twin bridge must not be group- or world-writable');
  if ((metadata.mode & 0o111n) === 0n) throw new Error('Digital twin bridge must be executable');
}

function sameFileMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function bridgeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ', 'TINYSA_ARTIFACTS_DIR', 'TINYSA_TWIN_ROOT'] as const;
  const result: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const name of allowed) {
    const value = environment[name];
    if (value !== undefined && !value.includes('\0')) result[name] = value;
  }
  return result;
}

function toBuffer(value: Buffer | string): Buffer { return Buffer.isBuffer(value) ? value : Buffer.from(value); }
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }

type ProcessGroupProbe = { state: 'gone' } | { state: 'live' } | { state: 'permission-denied'; error: Error };

function probeProcessGroup(pid: number): ProcessGroupProbe {
  try {
    process.kill(-pid, 0);
    return { state: 'live' };
  } catch (value) {
    const error = value as NodeJS.ErrnoException;
    if (error.code === 'ESRCH') return { state: 'gone' };
    // Darwin can report EPERM while a process group contains only not-yet-reaped zombies.
    // It is indeterminate, never evidence that the group has exited.
    if (error.code === 'EPERM') return { state: 'permission-denied', error: asError(value) };
    throw value;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolveValue, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolveValue(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
