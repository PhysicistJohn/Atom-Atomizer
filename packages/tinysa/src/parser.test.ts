import { describe, expect, it } from 'vitest';
import { PromptParser, cleanTextResponse } from './parser.js';

describe('PromptParser', () => {
  it('handles arbitrary fragmentation and coalesced frames', () => {
    const parser = new PromptParser();
    expect(parser.push(new TextEncoder().encode('ver'))).toEqual([]);
    const frames = parser.push(new TextEncoder().encode('sion\r\nv1\r\nch>info\r\nunit\r\nch>'));
    expect(frames).toHaveLength(2);
    expect(cleanTextResponse(frames[0]!, 'version')).toBe('v1');
    expect(cleanTextResponse(frames[1]!, 'info')).toBe('unit');
  });
  it('bounds incomplete responses', () => {
    const parser = new PromptParser(3);
    expect(() => parser.push(new Uint8Array(4))).toThrow(/bounded/);
  });
});
