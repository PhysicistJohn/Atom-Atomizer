import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
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
import type { ByteTransport, TransportAcquisitionMetadata, TransportEvent } from './transport.js';

const BRIDGE_CONTRACT_VERSION = 1 as const;
const BRIDGE_READY_TIMEOUT_MS = 120_000;
const BRIDGE_REQUEST_TIMEOUT_MS = 180_000;
const MAX_BRIDGE_LINE_BYTES = 2_000_000;
const MAX_STDERR_CHARS = 8_000;
const encoder = new TextEncoder();
const prompt = encoder.encode(TINYSA_SHELL_PROMPT);
const HELP_COMMANDS = [
  'version', 'info', 'help', 'status', 'pause', 'resume', 'abort',
  'mode', 'sweep', 'scan', 'scanraw', 'rbw', 'attenuate', 'sweeptime', 'spur', 'avoid', 'lna', 'trigger', 'calc', 'trace', 'marker',
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

class TwinBridgeClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  readonly #ready: Promise<DigitalTwinProvenance>;
  readonly #exited: Promise<void>;
  #resolveReady?: (value: DigitalTwinProvenance) => void;
  #rejectReady?: (error: Error) => void;
  #requestSequence = 0;
  #stderr = '';
  #readySettled = false;
  #closing = false;

  constructor(command: string, private readonly onUnexpectedFailure: (error: Error) => void) {
    if (!existsSync(command)) throw new Error(`Digital twin bridge does not exist: ${command}`);
    this.#ready = new Promise((resolveReady, rejectReady) => { this.#resolveReady = resolveReady; this.#rejectReady = rejectReady; });
    this.#child = spawn(command, [], { cwd: resolve(command, '..', '..'), env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    output.on('line', (line) => this.#handleLine(line));
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk: string) => { this.#stderr = `${this.#stderr}${chunk}`.slice(-MAX_STDERR_CHARS); });
    this.#exited = new Promise((resolveExit) => {
      this.#child.once('exit', (code, signal) => {
        const error = new Error(`Digital twin bridge exited (code ${String(code)}, signal ${String(signal)})${this.#stderr ? `: ${singleLine(this.#stderr)}` : ''}`);
        if (!this.#readySettled) this.#rejectReady?.(error);
        for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.#pending.clear();
        if (!this.#closing) this.onUnexpectedFailure(error);
        resolveExit();
      });
    });
    this.#child.once('error', (error) => {
      const wrapped = new Error(`Digital twin bridge process failed: ${error.message}`);
      if (!this.#readySettled) this.#rejectReady?.(wrapped);
      if (!this.#closing) this.onUnexpectedFailure(wrapped);
    });
  }

  async start(): Promise<DigitalTwinProvenance> {
    const timer = setTimeout(() => this.#rejectReady?.(new Error('Digital twin bridge boot timed out')), BRIDGE_READY_TIMEOUT_MS);
    try { return await this.#ready; }
    finally { clearTimeout(timer); }
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#child.exitCode !== null || this.#closing) throw new Error('Digital twin bridge is unavailable');
    const id = `twin-${++this.#requestSequence}`;
    const payload = JSON.stringify({ id, contractVersion: BRIDGE_CONTRACT_VERSION, method, params });
    const response = new Promise<unknown>((resolveValue, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Digital twin ${method} timed out; the request was not retried`));
      }, BRIDGE_REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve: resolveValue, reject, timer });
    });
    this.#child.stdin.write(`${payload}\n`);
    return response;
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#exited;
    this.#closing = true;
    if (this.#child.exitCode !== null) return this.#exited;
    try { await this.#requestWhileClosing('shutdown'); }
    catch (error) { this.#child.kill('SIGTERM'); throw error; }
    const timeout = new Promise<never>((_, reject) => setTimeout(() => { this.#child.kill('SIGKILL'); reject(new Error('Digital twin bridge did not stop after shutdown')); }, 10_000));
    await Promise.race([this.#exited, timeout]);
  }

  #requestWhileClosing(method: string): Promise<unknown> {
    const id = `twin-${++this.#requestSequence}`;
    const response = new Promise<unknown>((resolveValue, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`Digital twin ${method} timed out`)); }, 10_000);
      this.#pending.set(id, { resolve: resolveValue, reject, timer });
    });
    this.#child.stdin.write(`${JSON.stringify({ id, contractVersion: BRIDGE_CONTRACT_VERSION, method, params: {} })}\n`);
    return response;
  }

  #handleLine(line: string): void {
    if (Buffer.byteLength(line) > MAX_BRIDGE_LINE_BYTES) { this.#failAll(new Error('Digital twin bridge emitted an oversized response')); return; }
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { this.#failAll(new Error(`Digital twin bridge emitted malformed JSON: ${singleLine(line)}`)); return; }
    const record = asRecord(value, 'Digital twin bridge response');
    if (record.type === 'ready') {
      if (this.#readySettled) { this.#failAll(new Error('Digital twin bridge emitted duplicate ready state')); return; }
      try {
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
        this.#resolveReady?.(provenance);
      } catch (error) { this.#rejectReady?.(error instanceof Error ? error : new Error(String(error))); }
      return;
    }
    if (record.type === 'fatal') {
      const error = bridgeError(record.error);
      if (!this.#readySettled) this.#rejectReady?.(error);
      this.#failAll(error);
      return;
    }
    const response = validateResponse(record);
    const pending = this.#pending.get(response.id);
    if (!pending) { this.#failAll(new Error(`Digital twin bridge returned unknown request ${response.id}`)); return; }
    this.#pending.delete(response.id); clearTimeout(pending.timer);
    if (!response.ok) pending.reject(bridgeError(response.error));
    else pending.resolve(response.result);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    if (!this.#closing) this.onUnexpectedFailure(error);
  }
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
  #trigger: AnalyzerConfig['trigger'] = { mode: 'auto' };
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

  async list(): Promise<PortCandidate[]> { return [structuredClone(this.port)]; }

  async open(candidate: PortCandidate): Promise<void> {
    if (this.#open || this.#client) throw new Error('Digital twin transport is already open');
    const input = portCandidateSchema.parse(candidate);
    if (input.id !== this.port.id || input.execution !== 'firmware-digital-twin') throw new Error('Digital twin transport received an unknown candidate');
    delete candidate.digitalTwin?.bootEvidence;
    const client = new TwinBridgeClient(this.#bridgeCommand, (error) => this.#unexpectedFailure(error));
    this.#client = client;
    try {
      const provenance = await client.start();
      candidate.digitalTwin = provenance;
      this.port.digitalTwin = structuredClone(provenance);
      this.#open = true;
      this.#emitEvent({ type: 'opened' });
    } catch (error) {
      this.#client = undefined;
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    this.#closing = true;
    try { await client.close(); }
    finally {
      this.#client = undefined; this.#open = false; this.#closing = false; this.#generatorConfigured = false; this.#generatorEnabled = false; this.#lastAcquisition = undefined;
      this.#emitEvent({ type: 'closed', reason: 'Digital twin bridge stopped' });
    }
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
      case 'freq': this.#generator = { ...this.#generator, frequencyHz: unsigned(args[0], 'generator frequency') }; return '';
      case 'level': this.#generator = { ...this.#generator, levelDbm: numeric(args[0], 'generator level') }; return '';
      case 'modulation': return this.#modulationCommand(args);
      case 'capture': return this.#capture();
      case 'touch': return this.#touch(args);
      case 'release': await this.#request('release_touch'); return '';
      case 'vbat': return '4170 mV';
      case 'deviceid': return 'deviceid 407';
      case 'status': return 'Resumed';
      case 'trace':
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
    const value = numeric(args[0], 'sweep time'); if (value < 0.003 || value > 60) return 'usage: sweeptime 0.003..60'; this.#sweepTimeSeconds = value; return '';
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
    if (value === 'auto' || value === 'normal' || value === 'single') this.#trigger = { ...this.#trigger, mode: value };
    else { const levelDbm = numeric(value, 'trigger level'); this.#trigger = { mode: this.#trigger.mode === 'auto' ? 'normal' : this.#trigger.mode, levelDbm }; }
    return '';
  }

  async #scan(args: string[], raw: boolean): Promise<string | Uint8Array> {
    if (args.length < 2 || args.length > 4) return `usage: ${raw ? 'scanraw' : 'scan'} {start(Hz)} {stop(Hz)} [points] [options]`;
    const startHz = unsigned(args[0], 'scan start'); const stopHz = unsigned(args[1], 'scan stop'); const points = args[2] === undefined ? this.#points : unsigned(args[2], 'scan points');
    if (startHz > stopHz) return 'frequency range is invalid';
    if (points < ZS407_FIRMWARE_LIMITS.minimumSweepPoints || points > ZS407_FIRMWARE_LIMITS.maximumSweepPoints) return `sweep points exceeds range ${ZS407_FIRMWARE_LIMITS.maximumSweepPoints}`;
    const result = sweepResult(await this.#request('acquire_sweep', {
      startHz, stopHz, points, rbwKhz: this.#rbwKhz, attenuationDb: this.#attenuationDb, sweepTimeSeconds: this.#sweepTimeSeconds,
      detector: this.#detector, spurRejection: this.#spurRejection, lna: this.#lna, avoidSpurs: this.#avoidSpurs, trigger: this.#trigger,
    }), points);
    this.#lastAcquisition = { source: 'renode-executable-state', startHz, stopHz, points, actualRbwHz: result.actualRbwHz, actualAttenuationDb: result.actualAttenuationDb, evidence: result.bridgeEvidence };
    if (raw) return encodeRawSweep(result.powerDbm);
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
  #unexpectedFailure(error: Error): void { if (this.#closing) return; this.#open = false; this.#client = undefined; this.#emitEvent({ type: 'error', error }); }
}

export class PhysicalOrTwinTransport implements ByteTransport {
  readonly #bytes = new Set<(bytes: Uint8Array) => void>();
  readonly #events = new Set<(event: TransportEvent) => void>();
  #active?: ByteTransport;
  constructor(readonly physical: ByteTransport, readonly twin: RenodeDigitalTwinTransport) {
    for (const transport of [physical, twin]) {
      transport.onBytes((bytes) => { if (this.#active === transport) for (const listener of this.#bytes) listener(bytes); });
      transport.onEvent((event) => { if (this.#active === transport) for (const listener of this.#events) listener(event); });
    }
  }
  get kind(): InstrumentTransportKind { return this.#active?.kind ?? this.physical.kind; }
  async list(): Promise<PortCandidate[]> {
    const physical = await this.physical.list();
    if (physical.some((candidate) => candidate.usbMatch === 'exact-zs407-cdc')) return physical;
    return [structuredClone(this.twin.port), ...physical];
  }
  async open(candidate: PortCandidate): Promise<void> {
    if (this.#active) throw new Error('An instrument transport is already open');
    const input = portCandidateSchema.parse(candidate);
    const target = input.execution === 'firmware-digital-twin' ? this.twin : this.physical;
    this.#active = target;
    try { await target.open(candidate); }
    catch (error) { this.#active = undefined; throw error; }
  }
  async close(): Promise<void> { const active = this.#active; if (!active) return; try { await active.close(); } finally { this.#active = undefined; } }
  write(bytes: Uint8Array): Promise<void> { if (!this.#active) throw new Error('No instrument transport is open'); return this.#active.write(bytes); }
  onBytes(listener: (bytes: Uint8Array) => void): () => void { this.#bytes.add(listener); return () => this.#bytes.delete(listener); }
  onEvent(listener: (event: TransportEvent) => void): () => void { this.#events.add(listener); return () => this.#events.delete(listener); }
  consumeAcquisitionMetadata(): TransportAcquisitionMetadata | undefined { return this.#active?.consumeAcquisitionMetadata(); }
}

function validateReady(record: Record<string, unknown>): BridgeReady {
  const exact: Omit<BridgeReady, 'bootEvidence'> = {
    type: 'ready', contractVersion: 1, backend: 'renode-executable-twin', firmwareRelease: 'lab-v0.2.0-protocol',
    firmwareSourceCommit: 'd12bd826555eee51505542a55fd184ade5817d58', firmwareBinarySha256: 'a1dbaa03978a25b2a8b2a0e85f60029a6cc736481732eff68e93362724683dd7',
    usbTransactionsModeled: false, bridge: 'renode-monitor-v1',
  };
  for (const [key, value] of Object.entries(exact)) if (record[key] !== value) throw new Error(`Digital twin ready mismatch at ${key}`);
  if (typeof record.bootEvidence !== 'string' || !record.bootEvidence.startsWith('ZS407_TWIN_BOOT=PASS')) throw new Error('Digital twin omitted boot evidence');
  return { ...exact, bootEvidence: record.bootEvidence };
}
function validateResponse(record: Record<string, unknown>): BridgeResponse { if (typeof record.id !== 'string' || typeof record.ok !== 'boolean' || record.contractVersion !== 1) throw new Error('Digital twin bridge returned an invalid response envelope'); return record as unknown as BridgeResponse; }
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
function engineering(value: number): string { if (value >= 1e9) return `${value / 1e9}G`; if (value >= 1e6) return `${value / 1e6}M`; if (value >= 1e3) return `${value / 1e3}k`; return String(value); }
function concatenate(...parts: Uint8Array[]): Uint8Array { const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
function singleLine(value: string): string { return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1_000); }
