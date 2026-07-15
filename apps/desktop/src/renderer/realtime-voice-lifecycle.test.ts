import { describe, expect, it } from 'vitest';
import {
  ATOM_REALTIME_CALL_ARGUMENT_CHARACTER_LIMIT,
  ATOM_REALTIME_CALL_ID_CHARACTER_LIMIT,
  ATOM_REALTIME_RESPONSE_OUTPUT_ITEM_LIMIT,
} from './atom-agent-retention.js';
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

  it('accepts a call-free user interruption but rejects other incomplete response states', () => {
    const interrupted = new RealtimeResponseLifecycle();
    interrupted.begin(created('resp-cancelled'));
    expect(interrupted.complete({ type: 'response.done', response: { id: 'resp-cancelled', status: 'cancelled', output: [] } })).toMatchObject({ status: 'cancelled', calls: [] });

    const failed = new RealtimeResponseLifecycle();
    failed.begin(created('resp-failed'));
    expect(() => failed.complete({ type: 'response.done', response: { id: 'resp-failed', status: 'failed', status_details: { type: 'failed', error: { code: 'server_error', message: 'Realtime generation failed upstream' } }, output: [] } })).toThrow(/status failed: server_error · Realtime generation failed upstream/);
  });

  it('delivers every tool output before exactly one response continuation', () => {
    const events = buildRealtimeToolContinuation([
      { callId: 'call-1', output: { ok: true, output: { connection: 'ready' } } },
      { callId: 'call-2', output: { ok: true }, screenshot: { screenshotId: '123e4567-e89b-42d3-a456-426614174000', imageDataUrl: 'data:image/png;base64,AA==', width: 1200, height: 800, capturedAt: '2026-07-12T01:00:00.000Z', focusedTarget: 'APPLICATION' } },
    ], ['get_application_state', 'computer_screenshot']);

    expect(events.filter((event) => event.type === 'conversation.item.create')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'response.create')).toHaveLength(1);
    const continuation=events.at(-1) as {type:string;response:{output_modalities:readonly string[];tools:readonly {name:string}[];max_output_tokens?:unknown;truncation?:unknown}};
    expect(continuation.type).toBe('response.create');
    expect(continuation.response.output_modalities).toEqual(['audio']);
    expect(continuation.response.tools.map(tool=>tool.name)).toEqual(['load_atom_tools','get_application_state','computer_screenshot']);
    expect(continuation.response).not.toHaveProperty('max_output_tokens');
    expect(continuation.response).not.toHaveProperty('truncation');
  });

  it('rejects oversized response collections and variable-width call fields before exposure', () => {
    const outputOverflow = new RealtimeResponseLifecycle();
    outputOverflow.begin(created('response-output-overflow'));
    expect(() => outputOverflow.complete(done('response-output-overflow', Array.from(
      { length: ATOM_REALTIME_RESPONSE_OUTPUT_ITEM_LIMIT + 1 },
      () => ({ type: 'message' }),
    )))).toThrow(/bounded .*item output limit/);

    const idOverflow = new RealtimeResponseLifecycle();
    idOverflow.begin(created('response-id-overflow'));
    expect(() => idOverflow.complete(done('response-id-overflow', [call('x'.repeat(ATOM_REALTIME_CALL_ID_CHARACTER_LIMIT + 1))]))).toThrow(/call_id exceeded/);

    const argumentOverflow = new RealtimeResponseLifecycle();
    argumentOverflow.begin(created('response-argument-overflow'));
    expect(() => argumentOverflow.complete(done('response-argument-overflow', [{
      ...call('bounded-call'),
      arguments: 'x'.repeat(ATOM_REALTIME_CALL_ARGUMENT_CHARACTER_LIMIT + 1),
    }]))).toThrow(/arguments exceeded/);
  });
});
