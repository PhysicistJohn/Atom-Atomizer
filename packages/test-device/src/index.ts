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
  signalProfile?: DemoSignalProfile;
  demoIdentity?: boolean;
}
export type DemoSignalProfile = 'survey' | 'cw' | 'am' | 'fm' | 'lte';

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
  #signalProfile: DemoSignalProfile;

  constructor(private readonly options: FakeOptions = {}) {
    this.#signalProfile = options.signalProfile ?? 'survey';
    this.port = portCandidateSchema.parse(options.demoIdentity ? {
      id: 'demo-zs407:ATOM-LAB:0483:5740',
      path: 'fake://atom-signal-lab',
      manufacturer: 'TinySA Atomizer',
      product: 'Signal Lab · Synthesized ZS407',
      serialNumber: 'ATOM-LAB',
      vendorId: TINYSA_USB_VENDOR_ID,
      productId: TINYSA_USB_PRODUCT_ID,
      usbMatch: 'exact-zs407-cdc',
    } : {
      id: 'fake-zs407:SIM-407:0483:5740',
      path: 'fake://zs407',
      manufacturer: 'tinysa.org',
      product: 'tinySA4',
      serialNumber: 'SIM-407',
      vendorId: TINYSA_USB_VENDOR_ID,
      productId: TINYSA_USB_PRODUCT_ID,
      usbMatch: 'exact-zs407-cdc',
    });
  }

  get signalProfile(): DemoSignalProfile { return this.#signalProfile; }
  setSignalProfile(profile: DemoSignalProfile): void {
    if (!['survey', 'cw', 'am', 'fm', 'lte'].includes(profile)) throw new Error(`Unsupported synthesized signal profile: ${profile}`);
    this.#signalProfile = profile;
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
      case 'version': return 'tinySA4_v1.4-224-gc979386\r\nHW Version:V0.5.4 + ZS407 max2871';
      case 'info': return 'tinySA4 + ZS407\r\nVersion: tinySA4_v1.4-224-gc979386\r\nPlatform: STM32F303';
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
      case 'capture': return fakeScreen(this.#signalProfile, this.#sweepIndex);
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
      const signed = Math.round(power * ZS407_FIRMWARE_LIMITS.rawRssiDivisor);
      const encoded = signed < 0 ? signed + 0x1_0000 : signed;
      const offset = 1 + index * 3;
      payload[offset] = 0x78;
      payload[offset + 1] = encoded & 0xff;
      payload[offset + 2] = (encoded >> 8) & 0xff;
    });
    payload[payload.length - 1] = 0x7d;
    return payload;
  }

  #powers(startHz: number, stopHz: number, points: number): number[] {
    if (startHz === stopHz) {
      return Array.from({ length: points }, (_, index) => this.#zeroSpanPower(index));
    }
    return Array.from({ length: points }, (_, index) => {
      const x = index / Math.max(1, points - 1);
      const noise = captureLikeNoise(index, points, this.#sweepIndex);
      if (this.#signalProfile === 'cw') return noise + 64 * Math.exp(-Math.pow((x - 0.5) / 0.006, 2));
      if (this.#signalProfile === 'am') {
        const carrier = 61 * Math.exp(-Math.pow((x - 0.5) / 0.005, 2));
        const lower = 44 * Math.exp(-Math.pow((x - 0.445) / 0.006, 2));
        const upper = 44 * Math.exp(-Math.pow((x - 0.555) / 0.006, 2));
        return noise + Math.max(carrier, lower, upper);
      }
      if (this.#signalProfile === 'fm') {
        let comb = 0;
        for (let sideband = -5; sideband <= 5; sideband++) {
          const height = 52 - Math.abs(sideband) * 4.6 + (Math.abs(sideband) % 2 ? 2 : 0);
          comb = Math.max(comb, height * Math.exp(-Math.pow((x - (0.5 + sideband * 0.025)) / 0.008, 2)));
        }
        return noise + comb;
      }
      if (this.#signalProfile === 'lte') {
        const left = 1 / (1 + Math.exp(-(x - 0.29) * 180));
        const right = 1 / (1 + Math.exp((x - 0.71) * 180));
        const occupied = left * right;
        const ofdmTexture = 2.2 * Math.sin(index * 1.91 + this.#sweepIndex * 0.6) + 1.4 * Math.cos(index * 0.43);
        return occupied > 0.01 ? -68 + 21 * (occupied - 1) + ofdmTexture : noise;
      }
      const peak1 = 54 * Math.exp(-Math.pow((x - 0.23) / 0.018, 2));
      const peak2 = 39 * Math.exp(-Math.pow((x - 0.51) / 0.045, 2));
      const peak3 = 47 * Math.exp(-Math.pow((x - 0.79) / 0.009, 2));
      return noise + Math.max(peak1, peak2, peak3);
    });
  }

  #actualRbwHz(): number { return this.#rbwKhz === 'auto' ? 10_000 : this.#rbwKhz * 1_000; }
  #actualAttenuationDb(): number { return this.#attenuationDb === 'auto' ? 0 : this.#attenuationDb; }

  #zeroSpanPower(index: number): number {
    const phase = (index + this.#sweepIndex * 3) * Math.PI / 13;
    const receiverNoise = 0.55 * smoothNoise(index / 3.5, this.#sweepIndex, 0x32a7f119)
      + 0.22 * signedNoise(index, this.#sweepIndex, 0x68bc21eb);
    if (this.#signalProfile === 'cw') return -52 + 0.35 * Math.sin(phase * 1.7) + receiverNoise;
    if (this.#signalProfile === 'am') return -68 + 15 * Math.sin(phase) + receiverNoise;
    if (this.#signalProfile === 'fm') return -56 + 0.5 * Math.sin(phase * 2.3) + receiverNoise;
    if (this.#signalProfile === 'lte') return -66 + 3.8 * Math.sin(phase * 1.9) + 2.1 * Math.cos(phase * 4.1) + receiverNoise;
    const envelope = 7 * Math.sin(phase);
    const pulse = index % 47 < 5 ? 13 : 0;
    return -82 + envelope + pulse + receiverNoise;
  }
}

function captureLikeNoise(index: number, points: number, sweepIndex: number): number {
  const x = index / Math.max(1, points - 1);
  const slowDrift = smoothNoise(sweepIndex / 4, 0, 0x11d42a57) * 0.35;
  const receiverShape = 1.35 * Math.sin(Math.PI * 2 * (x * 1.45 + 0.08 + sweepIndex * 0.002))
    + 0.95 * Math.cos(Math.PI * 2 * (x * 3.7 - 0.19))
    + 0.55 * Math.sin(Math.PI * 2 * (x * 9.2 + 0.31));
  const stableRipple = 1.25 * smoothNoise(index / 6.5, 0, 0x4a39b70d);
  const liveRipple = 0.9 * smoothNoise(index / 3.2, sweepIndex, 0x7c2e1f53);
  const fineGrain = 0.48 * signedNoise(index, sweepIndex, 0x2b91d6af);
  const edgeLift = 1.4 * Math.pow(Math.abs(x - 0.5) * 2, 1.7);
  const stableSpurs = 3.8 * gaussian(x, 0.083, 0.0025)
    + 2.7 * gaussian(x, 0.647, 0.0038)
    + 4.4 * gaussian(x, 0.914, 0.0022);
  return -108.7 + slowDrift + receiverShape + stableRipple + liveRipple + fineGrain + edgeLift + stableSpurs;
}

function smoothNoise(position: number, sweepIndex: number, salt: number): number {
  const left = Math.floor(position);
  const fraction = position - left;
  const blend = fraction * fraction * (3 - 2 * fraction);
  const start = signedNoise(left, sweepIndex, salt);
  return start + (signedNoise(left + 1, sweepIndex, salt) - start) * blend;
}

function signedNoise(index: number, sweepIndex: number, salt: number): number {
  let value = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(sweepIndex + 1, 0x85ebca77) ^ salt;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0xffff_ffff * 2 - 1;
}

function gaussian(value: number, center: number, width: number): number {
  return Math.exp(-Math.pow((value - center) / width, 2));
}

function fakeScreen(profile: DemoSignalProfile, sweepIndex = 0): Uint8Array {
  const width = ZS407_FIRMWARE_LIMITS.screenWidth;
  const height = ZS407_FIRMWARE_LIMITS.screenHeight;
  const pixels = new Uint8Array(width * height * 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const grid = x % 60 === 0 || y % 40 === 0;
      const normalized = x / width;
      const shape = profile === 'cw'
        ? 78 * Math.exp(-Math.pow((normalized - 0.5) / 0.018, 2))
        : profile === 'am'
          ? Math.max(72 * Math.exp(-Math.pow((normalized - 0.5) / 0.014, 2)), 49 * Math.exp(-Math.pow((normalized - 0.43) / 0.018, 2)), 49 * Math.exp(-Math.pow((normalized - 0.57) / 0.018, 2)))
          : profile === 'fm'
            ? Array.from({ length: 9 }, (_, index) => index - 4).reduce((peak, sideband) => Math.max(peak, (58 - Math.abs(sideband) * 5) * Math.exp(-Math.pow((normalized - (0.5 + sideband * 0.045)) / 0.016, 2))), 0)
            : profile === 'lte'
              ? (normalized > 0.3 && normalized < 0.7 ? 52 + 4 * Math.sin(x / 7) : 0)
              : 42 * Math.exp(-Math.pow((x - 245) / 46, 2));
      const floorTexture = captureLikeNoise(x, width, sweepIndex) + 108.7;
      const traceY = 226 - Math.round(shape) - Math.round(floorTexture * 1.35);
      const trace = Math.abs(y - traceY) <= 1;
      const header = y < 34;
      const rgb565 = trace ? 0x7ff0 : header ? 0x10a3 : grid ? 0x2145 : 0x0861;
      const offset = (y * width + x) * 2;
      pixels[offset] = rgb565 & 0xff;
      pixels[offset + 1] = rgb565 >> 8;
    }
  }
  return pixels;
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
