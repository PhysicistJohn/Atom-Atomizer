import { TINYSA_SHELL_PROMPT, ZS407_FIRMWARE_LIMITS } from '@tinysa/contracts';

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder('utf-8', { fatal: true });
const PROMPT = encoder.encode(TINYSA_SHELL_PROMPT);
const CRLF = encoder.encode('\r\n');

export interface ParsedResponse<T> {
  value: T;
  consumedBytes: number;
}

export class PromptParser {
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  constructor(private readonly maxBytes = 4 * 1024 * 1024) {}

  push(chunk: Uint8Array): Uint8Array[] {
    this.#buffer = appendBytes(this.#buffer, chunk, this.maxBytes);
    const frames: Uint8Array[] = [];
    let index: number;
    while ((index = findSequence(this.#buffer, PROMPT)) >= 0) {
      frames.push(this.#buffer.slice(0, index));
      this.#buffer = this.#buffer.slice(index + PROMPT.length);
    }
    return frames;
  }

  reset(): void { this.#buffer = new Uint8Array(); }
  get pendingBytes(): number { return this.#buffer.length; }
}

export function appendBytes(existing: Uint8Array, chunk: Uint8Array, maximumBytes = 4 * 1024 * 1024): Uint8Array {
  if (existing.length + chunk.length > maximumBytes) {
    throw new Error(`Protocol response exceeded ${maximumBytes} bytes`);
  }
  const next = new Uint8Array(existing.length + chunk.length);
  next.set(existing);
  next.set(chunk, existing.length);
  return next;
}

export function extractTextResponse(buffer: Uint8Array, command: string): ParsedResponse<string> | undefined {
  const payloadStart = findCommandPayloadStart(buffer, command);
  if (payloadStart < 0) return undefined;
  const promptIndex = findSequence(buffer, PROMPT, payloadStart);
  if (promptIndex < 0) return undefined;
  const payload = stripTrailingCrlf(buffer.slice(payloadStart, promptIndex));
  let text: string;
  try {
    text = fatalDecoder.decode(payload);
  } catch (error) {
    throw new Error(`Command ${command} returned invalid UTF-8`, { cause: error });
  }
  return { value: text, consumedBytes: promptIndex + PROMPT.length };
}

export function extractFixedBinaryResponse(buffer: Uint8Array, command: string, payloadBytes: number): ParsedResponse<Uint8Array> | undefined {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) throw new RangeError('payloadBytes must be a non-negative safe integer');
  const payloadStart = findCommandPayloadStart(buffer, command);
  if (payloadStart < 0) return undefined;
  const promptStart = payloadStart + payloadBytes;
  const required = promptStart + PROMPT.length;
  if (buffer.length < required) return undefined;
  if (!bytesEqual(buffer.subarray(promptStart, required), PROMPT)) {
    throw new Error(`Command ${command} did not end fixed binary payload with the exact shell prompt`);
  }
  return { value: buffer.slice(payloadStart, promptStart), consumedBytes: required };
}

export function extractRawSweepResponse(buffer: Uint8Array, command: string, points: number): ParsedResponse<readonly number[]> | undefined {
  if (!Number.isInteger(points) || points < ZS407_FIRMWARE_LIMITS.minimumSweepPoints || points > ZS407_FIRMWARE_LIMITS.maximumSweepPoints) {
    throw new RangeError(`Raw sweep points must be ${ZS407_FIRMWARE_LIMITS.minimumSweepPoints}..${ZS407_FIRMWARE_LIMITS.maximumSweepPoints}`);
  }
  const payloadBytes = 2 + points * 3;
  const response = extractFixedBinaryResponse(buffer, command, payloadBytes);
  if (!response) return undefined;
  const payload = response.value;
  if (payload[0] !== 0x7b || payload[payload.length - 1] !== 0x7d) {
    throw new Error('scanraw payload is missing its opening or closing brace');
  }
  const powerDbm: number[] = [];
  for (let index = 0; index < points; index++) {
    const offset = 1 + index * 3;
    if (payload[offset] !== 0x78) throw new Error(`scanraw point ${index} is missing its x marker`);
    const unsigned = payload[offset + 1]! | (payload[offset + 2]! << 8);
    const signed = unsigned >= 0x8000 ? unsigned - 0x1_0000 : unsigned;
    powerDbm.push(signed / ZS407_FIRMWARE_LIMITS.rawRssiDivisor);
  }
  return { value: powerDbm, consumedBytes: response.consumedBytes };
}

export function cleanTextResponse(bytes: Uint8Array, command: string): string {
  let text: string;
  try { text = fatalDecoder.decode(bytes).replaceAll('\r', '').trim(); }
  catch (error) { throw new Error(`Command ${command} returned invalid UTF-8`, { cause: error }); }
  const lines = text.split('\n');
  const echoIndex = lines.findIndex((line) => line.trim() === command.trim());
  if (echoIndex >= 0) lines.splice(0, echoIndex + 1);
  return lines.join('\n').trim();
}

export function findSequence(haystack: Uint8Array, needle: Uint8Array, fromIndex = 0): number {
  if (needle.length === 0) return fromIndex <= haystack.length ? fromIndex : -1;
  outer: for (let index = Math.max(0, fromIndex); index <= haystack.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function findCommandPayloadStart(buffer: Uint8Array, command: string): number {
  const echo = encoder.encode(command);
  let searchFrom = 0;
  while (searchFrom <= buffer.length - echo.length) {
    const echoIndex = findSequence(buffer, echo, searchFrom);
    if (echoIndex < 0) return -1;
    const lineStart = echoIndex === 0 || endsWithCrlf(buffer, echoIndex) || endsWithPrompt(buffer, echoIndex);
    const lineEnd = echoIndex + echo.length;
    const hasCrlf = lineEnd + CRLF.length <= buffer.length && bytesEqual(buffer.subarray(lineEnd, lineEnd + CRLF.length), CRLF);
    if (lineStart && hasCrlf) return lineEnd + CRLF.length;
    searchFrom = echoIndex + 1;
  }
  return -1;
}

function endsWithCrlf(buffer: Uint8Array, endExclusive: number): boolean {
  return endExclusive >= 2 && buffer[endExclusive - 2] === 0x0d && buffer[endExclusive - 1] === 0x0a;
}

function endsWithPrompt(buffer: Uint8Array, endExclusive: number): boolean {
  return endExclusive >= PROMPT.length && bytesEqual(buffer.subarray(endExclusive - PROMPT.length, endExclusive), PROMPT);
}

function stripTrailingCrlf(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end >= 2 && bytes[end - 2] === 0x0d && bytes[end - 1] === 0x0a) end -= 2;
  return bytes.slice(0, end);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}
