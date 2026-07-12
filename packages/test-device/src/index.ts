import {
  TINYSA_USB_PRODUCT_ID,
  TINYSA_USB_VENDOR_ID,
  ZS407_FIRMWARE_LIMITS,
  portCandidateSchema,
  type PortCandidate,
} from '@tinysa/contracts';
import type { ByteTransport, TransportEvent } from '@tinysa/device';

type ByteListener = (bytes: Uint8Array) => void;
type EventListener = (event: TransportEvent) => void;
export interface FakeOptions {
  chunkSize?: number;
  latencyMs?: number;
  sweepLatencyMs?: number;
  includeBootBanner?: boolean;
  batteryMillivolts?: number;
  versionResponse?: string;
  infoResponse?: string;
  screenCaptureByteOrder?: 'big-endian' | 'little-endian';
}

const encoder = new TextEncoder();
const PROMPT = encoder.encode('ch> ');
const HELP_COMMANDS = [
  'version', 'reset', 'freq', 'saveconfig', 'clearconfig', 'data', 'frequencies', 'scan', 'hop', 'scanraw', 'abort', 'zero',
  'sweep', 'pause', 'resume', 'wait', 'waitscan', 'repeat', 'status', 'caloutput', 'save', 'recall', 'trace', 'trigger', 'marker',
  'channel', 'line', 'capture', 'refresh', 'touch', 'release', 'vbat', 'help', 'info', 'if', 'if1', 'lna2', 'agc', 'actual_freq',
  'freq_corr', 'attenuate', 'level', 'sweeptime', 'leveloffset', 'levelchange', 'modulation', 'rbw', 'mode', 'spur', 'avoid',
  'lna', 'direct', 'ultra', 'load', 'ext_gain', 'output', 'deviceid', 'selftest', 'correction', 'calc', 'menu', 'text', 'remark',
] as const;

export class FakeTinySaTransport implements ByteTransport {
  readonly kind = 'protocol-test-double' as const;
  readonly port: PortCandidate;
  readonly writes: string[] = [];
  #bytes = new Set<ByteListener>();
  #events = new Set<EventListener>();
  #open = false;
  #bootPending = false;
  #mode: 'input' | 'output' = 'input';
  #output = false;
  #startHz = 88_000_000;
  #stopHz = 108_000_000;
  #points = 450;
  #rbwKhz: number | 'auto' = 'auto';
  #attenuationDb: number | 'auto' = 'auto';
  #sweepTimeSeconds = 0;
  #sweepIndex = 0;
  #rawSweepOffsetDb = 174;

  constructor(private readonly options: FakeOptions = {}) {
    this.port = portCandidateSchema.parse({
      id: 'fake-zs407:SIM-407:0483:5740',
      path: 'fake://zs407',
      manufacturer: 'TinySA test fixture',
      product: 'Protocol-only ZS407 test double',
      serialNumber: 'SIM-407',
      vendorId: TINYSA_USB_VENDOR_ID,
      productId: TINYSA_USB_PRODUCT_ID,
      usbMatch: 'protocol-test-double',
      transport: 'protocol-test-double',
      execution: 'protocol-test-double',
    });
  }

  async list(): Promise<PortCandidate[]> { return [this.port]; }

  async open(candidate: PortCandidate): Promise<void> {
    if (this.#open) throw new Error('Fake ZS407 port is already open');
    if (candidate.id !== this.port.id) throw new Error('Unknown fake port');
    this.#open = true;
    this.#bootPending = this.options.includeBootBanner ?? true;
    this.#emitEvent({ type: 'opened' });
  }

  async close(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;
    this.#emitEvent({ type: 'closed' });
  }

  onBytes(listener: ByteListener): () => void { this.#bytes.add(listener); return () => this.#bytes.delete(listener); }
  onEvent(listener: EventListener): () => void { this.#events.add(listener); return () => this.#events.delete(listener); }
  consumeAcquisitionMetadata(): undefined { return undefined; }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.#open) throw new Error('Fake ZS407 port is closed');
    const wire = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!wire.endsWith('\r')) throw new Error('Fake ZS407 requires a carriage-return command terminator');
    const command = wire.slice(0, -1);
    if (!command || command.length > 47 || !/^[\x20-\x7e]+$/.test(command)) throw new Error('Fake ZS407 received a malformed command');
    this.writes.push(command);
    const payload = this.#response(command);
    const boot = this.#bootPending ? encoder.encode('\r\ntinySA Shell\r\nch> ') : new Uint8Array();
    this.#bootPending = false;
    const echo = encoder.encode(`${command}\r\n`);
    const body = typeof payload === 'string' ? encoder.encode(payload ? `${payload}\r\n` : '') : payload;
    const response = concatenate(boot, echo, body, PROMPT);
    const operation = command.split(' ', 1)[0];
    const latencyMs = operation === 'scan' || operation === 'scanraw'
      ? this.options.sweepLatencyMs ?? this.options.latencyMs
      : this.options.latencyMs;
    if (latencyMs) await delay(latencyMs);
    const chunkSize = this.options.chunkSize ?? response.length;
    for (let offset = 0; offset < response.length; offset += chunkSize) {
      const chunk = response.slice(offset, offset + chunkSize);
      for (const listener of this.#bytes) listener(chunk);
    }
  }

  unplug(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#emitEvent({ type: 'closed', reason: 'USB cable removed from simulated ZS407' });
  }

  #emitEvent(event: TransportEvent): void { for (const listener of this.#events) listener(event); }

  #response(command: string): string | Uint8Array {
    const [name, ...args] = command.split(/\s+/);
    switch (name) {
      case 'version': return this.options.versionResponse ?? 'tinySA4_v1.4-224-gc979386\r\nHW Version:V0.5.4 + ZS407 max2871';
      case 'info': return this.options.infoResponse ?? 'tinySA4 + ZS407\r\nVersion: tinySA4_v1.4-224-gc979386\r\nPlatform: STM32F303';
      case 'help': return `commands: ${HELP_COMMANDS.slice(0, 40).join(' ')}\r\nOther commands: ${HELP_COMMANDS.slice(40).join(' ')}`;
      case 'output': return this.#outputCommand(args);
      case 'mode': return this.#modeCommand(args);
      case 'sweep': return this.#sweepCommand(args);
      case 'rbw': return this.#rbwCommand(args);
      case 'attenuate': return this.#attenuationCommand(args);
      case 'sweeptime': return this.#sweepTimeCommand(args);
      case 'status': return 'Resumed';
      case 'vbat': return `${this.options.batteryMillivolts ?? 4_170} mV`;
      case 'deviceid': return 'deviceid 407';
      case 'scan': return this.#textSweep(args);
      case 'scanraw': return this.#rawSweep(args);
      case 'zero': return this.#zeroCommand(args);
      case 'capture': return fakeScreen(
        this.#sweepIndex,
        this.#startHz,
        this.#stopHz,
        this.options.screenCaptureByteOrder ?? 'little-endian',
      );
      case 'freq':
      case 'level':
      case 'modulation':
      case 'trace':
      case 'calc':
      case 'spur':
      case 'avoid':
      case 'lna':
      case 'trigger':
      case 'pause':
      case 'resume':
      case 'abort':
      case 'touch':
      case 'release':
        return '';
      default: return `${name}?`;
    }
  }

  #outputCommand(args: string[]): string {
    const option = args[0];
    if (option === 'on') this.#output = true;
    else if (option === 'off') this.#output = false;
    else if (option !== 'normal' && option !== 'mixer') return 'usage: output on|off|normal|mixer';
    return '';
  }

  #modeCommand(args: string[]): string {
    const option = args.at(-1);
    if (option !== 'input' && option !== 'output') return 'usage: mode [low] input|output';
    this.#mode = option;
    this.#output = false;
    if (option === 'input') {
      this.#rbwKhz = 'auto';
      this.#attenuationDb = 'auto';
      this.#sweepTimeSeconds = 0;
    }
    return '';
  }

  #sweepCommand(args: string[]): string {
    if (!args.length) return `${this.#startHz} ${this.#stopHz} ${this.#points}`;
    if (args.length === 2 && ['start', 'stop', 'center', 'span', 'cw'].includes(args[0]!)) {
      const value = strictInteger(args[1], 'sweep frequency');
      if (args[0] === 'start') this.#startHz = value;
      if (args[0] === 'stop') this.#stopHz = value;
      if (args[0] === 'cw') this.#startHz = this.#stopHz = value;
      if (args[0] === 'center') {
        const span = this.#stopHz - this.#startHz;
        this.#startHz = Math.round(value - span / 2);
        this.#stopHz = Math.round(value + span / 2);
      }
      if (args[0] === 'span') {
        const center = (this.#startHz + this.#stopHz) / 2;
        this.#startHz = Math.round(center - value / 2);
        this.#stopHz = Math.round(center + value / 2);
      }
      return '';
    }
    if (args.length >= 1 && args.length <= 3 && /^\d+$/.test(args[0]!)) {
      const start = strictInteger(args[0], 'sweep start');
      const stop = args[1] === undefined ? this.#stopHz : strictInteger(args[1], 'sweep stop');
      const points = args[2] === undefined ? this.#points : strictInteger(args[2], 'sweep points');
      if (start > stop) return 'frequency range is invalid';
      if (points < 1 || points > ZS407_FIRMWARE_LIMITS.maximumSweepPoints) return `sweep points exceeds range ${ZS407_FIRMWARE_LIMITS.maximumSweepPoints}`;
      this.#startHz = start;
      this.#stopHz = stop;
      this.#points = points;
      return '';
    }
    return 'usage: sweep {start(Hz)} [stop(Hz)] [points]';
  }

  #rbwCommand(args: string[]): string {
    if (!args.length) return `usage: rbw 0.2..850|auto\r\n${engineering(this.#actualRbwHz())}Hz`;
    if (args[0] === 'auto') this.#rbwKhz = 'auto';
    else {
      const value = Number(args[0]);
      if (!Number.isFinite(value) || value < 0.2 || value > 850) return 'usage: rbw 0.2..850|auto';
      this.#rbwKhz = value;
    }
    return '';
  }

  #attenuationCommand(args: string[]): string {
    if (!args.length) return `usage: attenuate 0..31|auto\r\n${this.#actualAttenuationDb().toFixed(2)}`;
    if (args[0] === 'auto') this.#attenuationDb = 'auto';
    else {
      const value = strictInteger(args[0], 'attenuation');
      if (value < 0 || value > 31) return 'usage: attenuate 0..31|auto';
      this.#attenuationDb = value;
    }
    return '';
  }

  #sweepTimeCommand(args: string[]): string {
    if (!args.length) return `usage: sweeptime 0.003..60\r\n${this.#sweepTimeSeconds || 0.08}s`;
    const value = Number(args[0]);
    if (!Number.isFinite(value) || value < 0 || value > 60) return 'usage: sweeptime 0.003..60';
    this.#sweepTimeSeconds = value;
    return '';
  }

  #textSweep(args: string[]): string {
    if (args.length < 2 || args.length > 4) return 'usage: scan {start(Hz)} {stop(Hz)} [points] [outmask]';
    const start = strictInteger(args[0], 'scan start');
    const stop = strictInteger(args[1], 'scan stop');
    const points = args[2] === undefined ? this.#points : strictInteger(args[2], 'scan points');
    const outmask = args[3] === undefined ? 0 : strictInteger(args[3], 'scan outmask');
    if (start > stop) return 'frequency range is invalid';
    if (points < 1 || points > ZS407_FIRMWARE_LIMITS.maximumSweepPoints) return `sweep points exceeds range ${ZS407_FIRMWARE_LIMITS.maximumSweepPoints}`;
    const values = this.#powers(start, stop, points);
    this.#sweepIndex++;
    if (outmask !== 3) return '';
    return values.map((power, index) => {
      const frequency = points === 1 ? start : Math.round(start + (stop - start) * index / (points - 1));
      return `${frequency} ${power.toFixed(5)} 0.000000`;
    }).join('\r\n');
  }

  #rawSweep(args: string[]): Uint8Array | string {
    if (args.length < 2 || args.length > 4) return 'usage: scanraw {start(Hz)} {stop(Hz)} [points] [options]';
    const start = strictInteger(args[0], 'scanraw start');
    const stop = strictInteger(args[1], 'scanraw stop');
    const points = args[2] === undefined ? this.#points : strictInteger(args[2], 'scanraw points');
    if (start > stop) return 'frequency range is invalid';
    const values = this.#powers(start, stop, points);
    this.#sweepIndex++;
    const payload = new Uint8Array(2 + points * 3);
    payload[0] = 0x7b;
    values.forEach((power, index) => {
      const signed = Math.round((power + this.#rawSweepOffsetDb) * ZS407_FIRMWARE_LIMITS.rawRssiDivisor);
      const encoded = signed < 0 ? signed + 0x1_0000 : signed;
      const offset = 1 + index * 3;
      payload[offset] = 0x78;
      payload[offset + 1] = encoded & 0xff;
      payload[offset + 2] = (encoded >> 8) & 0xff;
    });
    payload[payload.length - 1] = 0x7d;
    return payload;
  }

  #zeroCommand(args: string[]): string {
    if (args.length === 0) return `zero {level}\r\n${this.#rawSweepOffsetDb}dBm`;
    if (args.length !== 1 || !/^-?\d+$/.test(args[0]!)) return `zero {level}\r\n${this.#rawSweepOffsetDb}dBm`;
    this.#rawSweepOffsetDb = Number(args[0]);
    return '';
  }

  #powers(startHz: number, stopHz: number, points: number): number[] {
    return protocolFixturePowers(startHz, stopHz, points, this.#sweepIndex);
  }

  #actualRbwHz(): number { return this.#rbwKhz === 'auto' ? 10_000 : this.#rbwKhz * 1_000; }
  #actualAttenuationDb(): number { return this.#attenuationDb === 'auto' ? 0 : this.#attenuationDb; }

}

function fakeScreen(
  sweepIndex: number,
  startHz: number,
  stopHz: number,
  byteOrder: 'big-endian' | 'little-endian',
): Uint8Array {
  const width = ZS407_FIRMWARE_LIMITS.screenWidth;
  const height = ZS407_FIRMWARE_LIMITS.screenHeight;
  const pixels = new Uint8Array(width * height * 2);
  const powerDbm = protocolFixturePowers(startHz, stopHz, width, sweepIndex);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const grid = x % 60 === 0 || y % 40 === 0;
      const boundedPower = Math.min(-20, Math.max(-120, powerDbm[x]!));
      const traceY = 282 - Math.round((boundedPower + 120) / 100 * 230);
      const trace = Math.abs(y - traceY) <= 1;
      const header = y < 34;
      const rgb565 = trace ? 0x7ff0 : header ? 0x10a3 : grid ? 0x2145 : 0x0861;
      const offset = (y * width + x) * 2;
      if (byteOrder === 'big-endian') {
        pixels[offset] = rgb565 >> 8;
        pixels[offset + 1] = rgb565 & 0xff;
      } else {
        pixels[offset] = rgb565 & 0xff;
        pixels[offset + 1] = rgb565 >> 8;
      }
    }
  }
  return pixels;
}

function protocolFixturePowers(startHz: number, stopHz: number, points: number, sweepIndex: number): number[] {
  if (!Number.isInteger(points) || points < 1) throw new Error('Protocol fixture requires a positive point count');
  const center = (startHz + stopHz) / 2;
  const width = Math.max(1, Math.abs(stopHz - startHz) / 30);
  return Array.from({ length: points }, (_, index) => {
    const frequency = points === 1 ? startHz : startHz + (stopHz - startHz) * index / (points - 1);
    const noise = -108 + 1.7 * Math.sin(index * 1.618 + sweepIndex * 0.31) + 0.9 * Math.cos(index * 0.47 - sweepIndex * 0.19);
    const signal = -49 - 4.342944819 * ((frequency - center) / width) ** 2;
    const maximum = Math.max(noise, signal);
    return maximum + 10 * Math.log10(10 ** ((noise - maximum) / 10) + 10 ** ((signal - maximum) / 10));
  });
}

function strictInteger(value: string | undefined, label: string): number {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${label} must be an unsigned integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds safe integer range`);
  return number;
}

function engineering(value: number): string {
  if (value >= 1_000_000_000) return `${value / 1_000_000_000}G`;
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1_000) return `${value / 1_000}k`;
  return String(value);
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
