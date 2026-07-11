import { describe, expect, it } from 'vitest';
import {
  PromptParser,
  cleanTextResponse,
  extractFixedBinaryResponse,
  extractRawSweepResponse,
  extractTextResponse,
} from './parser.js';

const encode = (value: string) => new TextEncoder().encode(value);

describe('firmware response parsing', () => {
  it('handles arbitrary prompt fragmentation and coalesced frames', () => {
    const parser = new PromptParser();
    expect(parser.push(encode('version\r\nv1\r\nch'))).toEqual([]);
    const frames = parser.push(encode('> info\r\nunit\r\nch> '));
    expect(frames).toHaveLength(2);
    expect(cleanTextResponse(frames[0]!, 'version')).toBe('v1');
    expect(cleanTextResponse(frames[1]!, 'info')).toBe('unit');
  });

  it('correlates text to the exact echo after a startup prompt', () => {
    const response = extractTextResponse(encode('\r\ntinySA Shell\r\nch> version\r\ntinySA4_v1\r\nch> '), 'version');
    expect(response?.value).toBe('tinySA4_v1');
    expect(response?.consumedBytes).toBeGreaterThan(20);
  });

  it('uses fixed length rather than prompt search for binary capture', () => {
    const binary = Uint8Array.from([0x63, 0x68, 0x3e, 0x20, 0xff]);
    const response = extractFixedBinaryResponse(concat(encode('capture\r\n'), binary, encode('ch> ')), 'capture', binary.length);
    expect(response?.value).toEqual(binary);
  });

  it('validates and decodes signed dB x32 raw values before the device-reported offset is removed', () => {
    const payload = new Uint8Array(2 + 20 * 3); payload[0] = 0x7b; payload[payload.length - 1] = 0x7d;
    for (let index = 0; index < 20; index++) { const offset = 1 + index * 3; payload[offset] = 0x78; payload[offset + 1] = 0x40; payload[offset + 2] = 0x0a; }
    const response = extractRawSweepResponse(concat(encode('scanraw 1 2 20 0\r\n'), payload, encode('ch> ')), 'scanraw 1 2 20 0', 20);
    expect(response?.value).toEqual(Array(20).fill(82));
    const malformed = payload.slice(); malformed[4] = 0x79;
    expect(() => extractRawSweepResponse(concat(encode('scanraw 1 2 20 0\r\n'), malformed, encode('ch> ')), 'scanraw 1 2 20 0', 20)).toThrow(/point 1/i);
  });

  it('bounds incomplete responses', () => {
    const parser = new PromptParser(3);
    expect(() => parser.push(new Uint8Array(4))).toThrow(/exceeded 3 bytes/);
  });
});

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
