import { describe, expect, it } from 'vitest';
import { RealtimeResponseLifecycle, buildRealtimeToolContinuation } from './realtime-voice-lifecycle.js';

const created = (id: string) => ({ type: 'response.created', response: { id } });
const done = (id: string, output: readonly unknown[] = []) => ({ type: 'response.done', response: { id, status: 'completed', output } });
const call = (callId: string, name = 'get_application_state') => ({ type: 'function_call', status: 'completed', call_id: callId, name, arguments: '{}' });

describe('Realtime voice response lifecycle', () => {
  it('does not expose a tool call until its response is done and idle', () => {
    const lifecycle = new RealtimeResponseLifecycle();
    lifecycle.begin(created('resp-1'));
    expect(() => lifecycle.assertIdle()).toThrow(/still active/);

    const completed = lifecycle.complete(done('resp-1', [call('call-1')]));

    expect(completed.calls).toEqual([{ responseId: 'resp-1', callId: 'call-1', name: 'get_application_state', arguments: '{}' }]);
    expect(() => lifecycle.assertIdle()).not.toThrow();
  });

  it('rejects overlapping responses and mismatched completion IDs', () => {
    const lifecycle = new RealtimeResponseLifecycle();
    lifecycle.begin(created('resp-1'));
    expect(() => lifecycle.begin(created('resp-2'))).toThrow(/still active/);
    expect(() => lifecycle.complete(done('resp-2'))).toThrow(/active response was resp-1/);
  });

  it('delivers every tool output before exactly one response continuation', () => {
    const events = buildRealtimeToolContinuation([
      { callId: 'call-1', output: { ok: true, output: { connection: 'ready' } } },
      { callId: 'call-2', output: { ok: true }, screenshot: { imageDataUrl: 'data:image/png;base64,AA==', width: 1200, height: 800, capturedAt: '2026-07-12T01:00:00.000Z' } },
    ]);

    expect(events.filter((event) => event.type === 'conversation.item.create')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'response.create')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'response.create', response: { output_modalities: ['audio'] } });
  });
});
