import type { AgentMessage } from '@tinysa/agent';
import { describe, expect, it } from 'vitest';
import {
  appendBoundedAtomDraft,
  ATOM_REALTIME_CALL_ARGUMENT_CHARACTER_LIMIT,
  ATOM_UI_MESSAGE_CHARACTER_LIMIT,
  ATOM_UI_MESSAGE_LIMIT,
  RealtimeCallIdLedger,
  retainRecentAtomMessages,
} from './atom-agent-retention.js';

function message(index: number, overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: `message-${index}`,
    role: 'tool',
    text: `message ${index}`,
    createdAt: new Date(index * 1_000).toISOString(),
    status: 'complete',
    ...overrides,
  };
}

describe('Atom agent renderer retention', () => {
  it('retains only the newest bounded UI window in chronological order', () => {
    const input = Array.from({ length: ATOM_UI_MESSAGE_LIMIT + 80 }, (_, index) => message(index));

    const retained = retainRecentAtomMessages(input);

    expect(retained).toHaveLength(ATOM_UI_MESSAGE_LIMIT);
    expect(retained[0]?.id).toBe('message-80');
    expect(retained.at(-1)?.id).toBe(`message-${ATOM_UI_MESSAGE_LIMIT + 79}`);
    expect(input).toHaveLength(ATOM_UI_MESSAGE_LIMIT + 80);
  });

  it('keeps active streams addressable and preserves the latest user row used by the panel UX', () => {
    const input = Array.from({ length: 300 }, (_, index) => message(index));
    input[3] = message(3, { role: 'user', text: 'older user' });
    input[4] = message(4, { role: 'assistant', status: 'streaming', text: 'still streaming' });
    input[5] = message(5, { role: 'user', text: 'latest user' });

    const retained = retainRecentAtomMessages(input, 10);

    expect(retained).toHaveLength(10);
    expect(retained.map((entry) => entry.id)).toEqual([
      'message-4',
      'message-5',
      'message-292',
      'message-293',
      'message-294',
      'message-295',
      'message-296',
      'message-297',
      'message-298',
      'message-299',
    ]);
    expect(retained.some((entry) => entry.id === 'message-3')).toBe(false);
  });

  it('does not allocate a replacement array while the transcript is below its cap', () => {
    const input = [message(0)];
    expect(retainRecentAtomMessages(input)).toBe(input);
  });

  it('hard-bounds each variable-width transcript row without mutating the caller input', () => {
    const oversized = message(0, { text: 'x'.repeat(ATOM_UI_MESSAGE_CHARACTER_LIMIT + 500) });
    const input = [oversized];

    const retained = retainRecentAtomMessages(input);

    expect(retained).not.toBe(input);
    expect(retained[0]?.text).toHaveLength(ATOM_UI_MESSAGE_CHARACTER_LIMIT);
    expect(retained[0]?.text).toMatch(/transcript truncated/);
    expect(input[0]?.text).toHaveLength(ATOM_UI_MESSAGE_CHARACTER_LIMIT + 500);
  });

  it('checks streaming width before concatenation and fails closed at the exact boundary', () => {
    expect(appendBoundedAtomDraft('1234', '56', 6)).toBe('123456');
    expect(() => appendBoundedAtomDraft('1234', '567', 6)).toThrow(/bounded 6-character/);
    expect(() => appendBoundedAtomDraft('', 'x', 0)).toThrow(/positive safe integer/);
  });

  it('keeps every admitted call ID until a voice-session reset and fails closed at the cap', () => {
    const ledger = new RealtimeCallIdLedger(3, 32);
    ledger.record('call-1');
    ledger.record('call-2');
    ledger.record('call-3');

    expect(ledger.size).toBe(3);
    expect(() => ledger.record('call-4')).toThrow(/bounded 3-call replay ledger/);
    expect(ledger.size).toBe(3);
    expect(() => ledger.record('call-1')).toThrow(/repeated function call call-1/);

    ledger.reset();
    expect(ledger.size).toBe(0);
    expect(() => ledger.record('call-1')).not.toThrow();
  });

  it('bounds the retained width of opaque voice call IDs', () => {
    const ledger = new RealtimeCallIdLedger(2, 8);
    expect(() => ledger.record('123456789')).toThrow(/8-character limit/);
    expect(() => ledger.record('')).toThrow(/non-empty/);
    expect(ledger.size).toBe(0);
  });

  it('admits response batches atomically before any tool in the batch can execute', () => {
    const ledger = new RealtimeCallIdLedger(3, 32);
    ledger.record('prior');

    expect(() => ledger.recordAll(['next-1', 'next-2', 'overflow'])).toThrow(/bounded 3-call replay ledger/);
    expect(ledger.size).toBe(1);
    expect(() => ledger.record('next-1')).not.toThrow();
    expect(() => ledger.recordAll(['next-2', 'next-2'])).toThrow(/repeated function call next-2/);
    expect(ledger.size).toBe(2);
  });

  it('bounds every call argument before atomically recording any ID', () => {
    const ledger = new RealtimeCallIdLedger(3, 32, 8);

    expect(() => ledger.recordCalls([
      { callId: 'first', arguments: '{}' },
      { callId: 'second', arguments: '123456789' },
    ])).toThrow(/8-character limit/);
    expect(ledger.size).toBe(0);
    expect(() => ledger.recordCalls([{ callId: 'first', arguments: '12345678' }])).not.toThrow();
    expect(() => ledger.recordCalls([
      { callId: 'second', arguments: '{}' },
      { callId: 'first', arguments: '{}' },
    ])).toThrow(/repeated function call first/);
    expect(ledger.size).toBe(1);
  });

  it('rejects invalid caps instead of silently disabling the bound', () => {
    expect(() => retainRecentAtomMessages([message(0)], 0)).toThrow(/positive safe integer/);
    expect(() => retainRecentAtomMessages([message(0)], 1, 0)).toThrow(/positive safe integer/);
    expect(() => new RealtimeCallIdLedger(Number.POSITIVE_INFINITY)).toThrow(/positive safe integer/);
    expect(() => new RealtimeCallIdLedger(1, 1, Number.POSITIVE_INFINITY)).toThrow(/positive safe integer/);
    expect(ATOM_REALTIME_CALL_ARGUMENT_CHARACTER_LIMIT).toBeGreaterThan(0);
  });
});
