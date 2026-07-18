// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAtomRealtimeVoiceSessionConfig } from '@tinysa/agent';
import {
  ATOM_REALTIME_CALL_ARGUMENT_CHARACTER_LIMIT,
  ATOM_REALTIME_TOOL_CALL_LIMIT,
  ATOM_UI_MESSAGE_CHARACTER_LIMIT,
  ATOM_UI_MESSAGE_LIMIT,
} from './atom-agent-retention.js';
import { ATOM_REALTIME_STARTUP_TIMEOUT_MILLISECONDS, useAtomAgent } from './useAtomAgent.js';

const originalMediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
const BACKEND_A = { sessionId: 'session:a', driverId: 'tinysa-zs407', sourceKind: 'serial-port', execution: 'physical' } as const;
const BACKEND_B = { sessionId: 'session:b', driverId: 'signal-lab', sourceKind: 'signal-lab', execution: 'signal-lab-simulation' } as const;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if(originalMediaDevicesDescriptor)Object.defineProperty(navigator, 'mediaDevices', originalMediaDevicesDescriptor);
  else Reflect.deleteProperty(navigator, 'mediaDevices');
  FakePeerConnection.instances.length = 0;
});

beforeEach(() => {
  let turn = 0;
  window.atomAgent = {
    status: vi.fn().mockResolvedValue({ configured: false, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: false, realtime: false, textTransport: 'realtime-websocket' }),
    agentTurn: vi.fn().mockImplementation(async () => {
      turn++;
      return { conversationId: `conversation-${turn}`, transport: 'realtime-websocket', text: `answer ${turn}`, toolCalls: [] };
    }),
    createRealtimeCall: vi.fn(),
    computerScreenshot: vi.fn(),
    computerClick: vi.fn(),
    computerType: vi.fn(),
    computerKey: vi.fn(),
    computerScroll: vi.fn(),
  };
});

describe('useAtomAgent long-session retention', () => {
  it('bounds the visible transcript without resetting the authoritative API conversation', async () => {
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute: vi.fn() }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    const turns = ATOM_UI_MESSAGE_LIMIT / 2 + 16;
    for (let index = 1; index <= turns; index++) {
      await act(async () => result.current.sendText(`prompt ${index}`));
    }

    expect(result.current.messages).toHaveLength(ATOM_UI_MESSAGE_LIMIT);
    expect(result.current.messages.at(-2)?.text).toBe(`prompt ${turns}`);
    expect(result.current.messages.at(-1)?.text).toBe(`answer ${turns}`);
    expect(result.current.messages.some((message) => message.role === 'user')).toBe(true);

    const requests = vi.mocked(window.atomAgent.agentTurn).mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(turns);
    expect(requests[0]?.conversationId).toBeUndefined();
    expect(requests.at(-1)?.conversationId).toBe(`conversation-${turns - 1}`);
  });

  it('admits only one text operation before React can publish its thinking state', async () => {
    const pending = deferred<{ conversationId: string; transport: 'realtime-websocket'; text: string; toolCalls: [] }>();
    vi.mocked(window.atomAgent.agentTurn).mockReturnValueOnce(pending.promise);
    const execute = vi.fn();
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.sendText('first');
      second = result.current.sendText('second');
      void result.current.startVoice();
    });

    expect(window.atomAgent.agentTurn).toHaveBeenCalledTimes(1);
    expect(window.atomAgent.createRealtimeCall).not.toHaveBeenCalled();
    pending.resolve({ conversationId: 'conversation-single', transport: 'realtime-websocket', text: 'done', toolCalls: [] });
    await act(async () => { await Promise.all([first, second]); });
    expect(result.current.messages.filter((message) => message.role === 'user').map((message) => message.text)).toEqual(['first']);
  });

  it('rejects an oversized text tool batch before executing any call', async () => {
    const calls = Array.from({ length: ATOM_REALTIME_TOOL_CALL_LIMIT + 1 }, (_, index) => ({
      callId: `call-${index}`,
      name: 'get_application_state',
      arguments: '{}',
    }));
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce(textTurn('response-loader', [loaderCall('loader-cap', ['get_application_state'])]))
      .mockResolvedValueOnce(textTurn('response-overflow', calls));
    const execute = vi.fn();
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    await act(async () => { await result.current.sendText('Run too many tools.'); });

    expect(execute).not.toHaveBeenCalled();
    expect(result.current.messages.some((message) => message.role === 'system' && message.text.includes(`bounded ${ATOM_REALTIME_TOOL_CALL_LIMIT}-tool`))).toBe(true);
  });

  it('retains text call IDs across responses and rejects a replay batch atomically', async () => {
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce(textTurn('response-loader', [loaderCall('loader-replay', ['get_application_state'])]))
      .mockResolvedValueOnce(textTurn('response-first', [applicationCall('replayed')]))
      .mockResolvedValueOnce(textTurn('response-replay', [applicationCall('new-call'), applicationCall('replayed')]));
    const execute = vi.fn().mockResolvedValue({ state: 'ok' });
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    await act(async () => { await result.current.sendText('Exercise replay admission.'); });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.current.messages.some((message) => message.role === 'system' && message.text.includes('repeated function call replayed'))).toBe(true);
  });

  it('retains the text replay ledger across separate user turns in one conversation', async () => {
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce(textTurn('turn-one-loader', [loaderCall('loader-one', ['get_application_state'])]))
      .mockResolvedValueOnce(textTurn('turn-one-call', [applicationCall('cross-turn-id')]))
      .mockResolvedValueOnce({ conversationId: 'turn-one-complete', transport: 'realtime-websocket', text: 'first complete', toolCalls: [] })
      .mockResolvedValueOnce(textTurn('turn-two-loader', [loaderCall('loader-two', ['get_application_state'])]))
      .mockResolvedValueOnce(textTurn('turn-two-replay', [applicationCall('cross-turn-id')]));
    const execute = vi.fn().mockResolvedValue({ state: 'ok' });
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    await act(async () => { await result.current.sendText('First turn.'); });
    await act(async () => { await result.current.sendText('Second turn.'); });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.current.messages.some((message) => message.role === 'system' && message.text.includes('repeated function call cross-turn-id'))).toBe(true);
  });

  it('rejects every call in a batch when any argument exceeds its width bound', async () => {
    vi.mocked(window.atomAgent.agentTurn)
      .mockResolvedValueOnce(textTurn('response-loader', [loaderCall('loader-width', ['get_application_state'])]))
      .mockResolvedValueOnce(textTurn('response-width', [
        applicationCall('valid-before-oversize'),
        applicationCall('oversize', 'x'.repeat(ATOM_REALTIME_CALL_ARGUMENT_CHARACTER_LIMIT + 1)),
      ]));
    const execute = vi.fn();
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    await act(async () => { await result.current.sendText('Reject wide arguments.'); });

    expect(execute).not.toHaveBeenCalled();
    expect(result.current.messages.some((message) => message.role === 'system' && message.text.includes(`${ATOM_REALTIME_CALL_ARGUMENT_CHARACTER_LIMIT}-character`))).toBe(true);
  });

  it('bounds a single text response as well as the row count', async () => {
    vi.mocked(window.atomAgent.agentTurn).mockResolvedValueOnce({
      conversationId: 'wide-response', transport: 'realtime-websocket',
      text: 'x'.repeat(ATOM_UI_MESSAGE_CHARACTER_LIMIT + 500), toolCalls: [],
    });
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute: vi.fn() }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    await act(async () => { await result.current.sendText('Show a wide response.'); });

    const response = [...result.current.messages].reverse().find((message) => message.role === 'assistant');
    expect(response?.text).toHaveLength(ATOM_UI_MESSAGE_CHARACTER_LIMIT);
    expect(response?.text).toMatch(/transcript truncated/);
  });
});

describe('useAtomAgent text tool-batch failure barrier', () => {
  it('stops after a configure failure and returns one failed-prior result for every remaining call', async () => {
    const calls = [
      namedCall('configure-failed', 'configure_analyzer', '{"startHz":1000000}'),
      namedCall('acquire-skipped', 'acquire_sweep'),
      namedCall('summary-skipped', 'get_latest_sweep_summary'),
    ];
    installTextBatch(['configure_analyzer', 'acquire_sweep', 'get_latest_sweep_summary'], calls);
    const execute = vi.fn().mockRejectedValueOnce(new Error('configuration transport failed'));
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    await act(async () => { await result.current.sendText('Configure, acquire, then summarize.'); });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('configure_analyzer', { startHz: 1_000_000 });
    const outputs = textBatchOutputs(calls);
    expect(outputs).toHaveLength(calls.length);
    expect(outputs.map(({ callId }) => callId)).toEqual(calls.map(({ callId }) => callId));
    expect(outputs[0]?.result).toEqual({ ok: false, error: 'configuration transport failed' });
    expect(outputs.slice(1).map(({ result }) => result)).toEqual([
      failedPrior('configure-failed'),
      failedPrior('configure-failed'),
    ]);
    expect(result.current.messages.filter((message) => message.role === 'tool' && message.text.includes('skipped'))).toHaveLength(2);
  });

  it('preserves a successful configure before an acquire failure, then skips dependent reads', async () => {
    const calls = [
      namedCall('configure-ok', 'configure_analyzer', '{"startHz":1000000}'),
      namedCall('acquire-failed', 'acquire_sweep'),
      namedCall('summary-skipped', 'get_latest_sweep_summary'),
    ];
    installTextBatch(['configure_analyzer', 'acquire_sweep', 'get_latest_sweep_summary'], calls);
    const execute = vi.fn()
      .mockResolvedValueOnce({ stagedRevision: 4 })
      .mockRejectedValueOnce(new Error('fresh sweep failed'));
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    await act(async () => { await result.current.sendText('Acquire fresh evidence.'); });

    expect(execute.mock.calls.map(([name]) => name)).toEqual(['configure_analyzer', 'acquire_sweep']);
    const outputs = textBatchOutputs(calls);
    expect(outputs).toHaveLength(calls.length);
    expect(outputs[0]?.result).toEqual({ ok: true, output: { stagedRevision: 4 } });
    expect(outputs[1]?.result).toEqual({ ok: false, error: 'fresh sweep failed' });
    expect(outputs[2]?.result).toEqual(failedPrior('acquire-failed'));
  });

  it('treats approval denial as failure and skips every later call without host effects', async () => {
    const calls = [
      namedCall('rf-denied', 'set_rf_output', '{"enabled":true}'),
      namedCall('state-skipped', 'get_instrument_state'),
    ];
    installTextBatch(['set_rf_output', 'get_instrument_state'], calls);
    const execute = vi.fn();
    const context = backendContext(BACKEND_A);
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => context, execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    let operation!: Promise<void>;
    act(() => { operation = result.current.sendText('Enable output, then read state.'); });
    await waitFor(() => expect(result.current.approval?.call.callId).toBe('rf-denied'));
    act(() => result.current.resolveApproval(false));
    await act(async () => { await operation; });

    expect(execute).not.toHaveBeenCalled();
    const outputs = textBatchOutputs(calls);
    expect(outputs).toHaveLength(calls.length);
    expect(outputs[0]?.result).toEqual({ ok: false, error: 'User denied the high-impact action' });
    expect(outputs[1]?.result).toEqual(failedPrior('rf-denied'));
    expect(result.current.messages.some((message) => message.role === 'tool' && message.text.includes('denied'))).toBe(true);
  });

  it('executes RF-off cleanup after an approved enable succeeds and a later call fails', async () => {
    const calls = [
      namedCall('rf-enable-ok', 'set_rf_output', '{"enabled":true}'),
      namedCall('acquire-after-enable-failed', 'acquire_sweep'),
      namedCall('rf-off-after-failure', 'set_rf_output', '{"enabled":false}'),
    ];
    installTextBatch(['set_rf_output', 'acquire_sweep'], calls);
    const execute = vi.fn().mockImplementation(async (name:string,args:unknown) => {
      if(name==='acquire_sweep')throw new Error('acquisition failed after RF enable');
      return { name, args };
    });
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => backendContext(BACKEND_A), execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    let operation!: Promise<void>;
    act(() => { operation = result.current.sendText('Enable, acquire, and always turn RF off.'); });
    await waitFor(() => expect(result.current.approval?.call.callId).toBe('rf-enable-ok'));
    act(() => result.current.resolveApproval(true));
    await act(async () => { await operation; });

    expect(execute.mock.calls).toEqual([
      ['set_rf_output', { enabled: true }],
      ['acquire_sweep', {}],
      ['set_rf_output', { enabled: false }],
    ]);
    expect(textBatchOutputs(calls).map(({ result: output }) => output)).toEqual([
      { ok: true, output: { name: 'set_rf_output', args: { enabled: true } } },
      { ok: false, error: 'acquisition failed after RF enable' },
      { ok: true, output: { name: 'set_rf_output', args: { enabled: false } } },
    ]);
  });

  it('executes stop cleanup after streaming starts and a later call fails', async () => {
    const calls = [
      namedCall('stream-start-ok', 'start_continuous_sweeps'),
      namedCall('stream-followup-failed', 'acquire_sweep'),
      namedCall('stream-stop-cleanup', 'stop_continuous_sweeps'),
    ];
    installTextBatch(['start_continuous_sweeps', 'acquire_sweep', 'stop_continuous_sweeps'], calls);
    const execute = vi.fn()
      .mockResolvedValueOnce({ started: true })
      .mockRejectedValueOnce(new Error('stream follow-up failed'))
      .mockResolvedValueOnce({ stopped: true });
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    await act(async () => { await result.current.sendText('Start, inspect, and always stop.'); });

    expect(execute.mock.calls.map(([name]) => name)).toEqual(['start_continuous_sweeps', 'acquire_sweep', 'stop_continuous_sweeps']);
    expect(textBatchOutputs(calls).map(({ result: output }) => output)).toEqual([
      { ok: true, output: { started: true } },
      { ok: false, error: 'stream follow-up failed' },
      { ok: true, output: { stopped: true } },
    ]);
  });

  it('allows connect to establish the backend identity required by a later approved high-impact call', async () => {
    const calls = [
      namedCall('connect-ok', 'connect_device', '{"candidateId":"candidate-1"}'),
      namedCall('rf-enable-after-connect', 'set_rf_output', '{"enabled":true}'),
    ];
    installTextBatch(['connect_device', 'set_rf_output'], calls);
    let context = backendContext();
    const execute = vi.fn().mockImplementation(async (name:string,args:unknown) => {
      if(name==='connect_device')context=backendContext(BACKEND_A);
      return { name, args };
    });
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => context, execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    let operation!: Promise<void>;
    act(() => { operation = result.current.sendText('Connect, then enable RF.'); });
    await waitFor(() => expect(result.current.approval?.call.callId).toBe('rf-enable-after-connect'));
    act(() => result.current.resolveApproval(true));
    await act(async () => { await operation; });

    expect(execute.mock.calls).toEqual([
      ['connect_device', { candidateId: 'candidate-1' }],
      ['set_rf_output', { enabled: true }],
    ]);
    expect(textBatchOutputs(calls).map(({ result: output }) => output)).toEqual([
      { ok: true, output: { name: 'connect_device', args: { candidateId: 'candidate-1' } } },
      { ok: true, output: { name: 'set_rf_output', args: { enabled: true } } },
    ]);
  });

  it('rejects a high-impact call before approval when no complete backend identity exists', async () => {
    const calls = [namedCall('rf-enable-no-backend', 'set_rf_output', '{"enabled":true}')];
    installTextBatch(['set_rf_output'], calls);
    const execute = vi.fn();
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => backendContext(), execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    await act(async () => { await result.current.sendText('Enable RF without an active backend.'); });

    expect(execute).not.toHaveBeenCalled();
    expect(result.current.approval).toBeUndefined();
    expect(textBatchOutputs(calls).map(({ result: output }) => output)).toEqual([
      { ok: false, error: 'No complete active execution backend identity is available for high-impact action' },
    ]);
  });

  it('rejects an approved high-impact call when the complete backend identity changes during approval', async () => {
    const calls = [
      namedCall('rf-enable-identity-change', 'set_rf_output', '{"enabled":true}'),
      namedCall('state-after-change-skipped', 'get_instrument_state'),
    ];
    installTextBatch(['set_rf_output', 'get_instrument_state'], calls);
    let context = backendContext(BACKEND_A);
    const execute = vi.fn();
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => context, execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    let operation!: Promise<void>;
    act(() => { operation = result.current.sendText('Enable RF on this backend.'); });
    await waitFor(() => expect(result.current.approval?.call.callId).toBe('rf-enable-identity-change'));
    context=backendContext(BACKEND_B);
    act(() => result.current.resolveApproval(true));
    await act(async () => { await operation; });

    expect(execute).not.toHaveBeenCalled();
    expect(textBatchOutputs(calls).map(({ result: output }) => output)).toEqual([
      { ok: false, error: 'Active execution backend changed while high-impact approval was pending' },
      failedPrior('rf-enable-identity-change'),
    ]);
  });

  it('continues independent observe calls after one observe call fails', async () => {
    const calls = [
      namedCall('application-failed', 'get_application_state'),
      namedCall('instrument-ok', 'get_instrument_state'),
    ];
    installTextBatch(['get_application_state', 'get_instrument_state'], calls);
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error('application projection unavailable'))
      .mockResolvedValueOnce({ sourceKind: 'signal-lab' });
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    await act(async () => { await result.current.sendText('Read two independent projections.'); });

    expect(execute.mock.calls.map(([name]) => name)).toEqual(['get_application_state', 'get_instrument_state']);
    expect(textBatchOutputs(calls).map(({ result: output }) => output)).toEqual([
      { ok: false, error: 'application projection unavailable' },
      { ok: true, output: { sourceKind: 'signal-lab' } },
    ]);
  });

  it('continues a valid observe call when another observe call fails schema preflight', async () => {
    const calls = [
      namedCall('application-invalid', 'get_application_state', '{"unexpected":true}'),
      namedCall('instrument-valid', 'get_instrument_state'),
    ];
    installTextBatch(['get_application_state', 'get_instrument_state'], calls);
    const execute = vi.fn().mockResolvedValueOnce({ sourceKind: 'signal-lab' });
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    await act(async () => { await result.current.sendText('Read independent projections with one malformed call.'); });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith('get_instrument_state', {});
    const outputs = textBatchOutputs(calls);
    expect(outputs).toHaveLength(calls.length);
    expect(outputs[0]?.result).toMatchObject({ ok: false, recoverable: true });
    expect(outputs[0]?.result).not.toHaveProperty('skipped');
    expect(outputs[1]?.result).toEqual({ ok: true, output: { sourceKind: 'signal-lab' } });
  });

  it('preflights an invalid mixed batch atomically and returns one result per call with zero host effects', async () => {
    const calls = [
      namedCall('state-valid', 'get_application_state'),
      namedCall('configure-invalid', 'configure_analyzer'),
      namedCall('rf-enable-suppressed', 'set_rf_output', '{"enabled":true}'),
      namedCall('acquire-valid', 'acquire_sweep'),
      namedCall('rf-off-cleanup', 'set_rf_output', '{"enabled":false}'),
      namedCall('stop-cleanup', 'stop_continuous_sweeps'),
      namedCall('disconnect-cleanup', 'disconnect_device'),
    ];
    installTextBatch(['get_application_state', 'configure_analyzer', 'set_rf_output', 'acquire_sweep', 'stop_continuous_sweeps', 'disconnect_device'], calls);
    const execute = vi.fn().mockImplementation(async (name:string) => ({ cleanup: name }));
    const context = backendContext(BACKEND_A);
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => context, execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    await act(async () => { await result.current.sendText('Run an invalid mixed batch.'); });

    expect(execute.mock.calls).toEqual([
      ['set_rf_output', { enabled: false }],
      ['stop_continuous_sweeps', {}],
      ['disconnect_device', {}],
    ]);
    const outputs = textBatchOutputs(calls);
    expect(outputs).toHaveLength(calls.length);
    expect(outputs.map(({ callId }) => callId)).toEqual(calls.map(({ callId }) => callId));
    expect(outputs[0]?.result).toEqual(preflightSkipped('configure-invalid'));
    expect(outputs[1]?.result).toMatchObject({ ok: false, recoverable: true });
    expect(outputs[1]?.result).not.toHaveProperty('skipped');
    expect(outputs[2]?.result).toEqual(preflightSkipped('configure-invalid'));
    expect(outputs[3]?.result).toEqual(preflightSkipped('configure-invalid'));
    expect(outputs[4]?.result).toEqual({ ok: true, output: { cleanup: 'set_rf_output' } });
    expect(outputs[5]?.result).toEqual({ ok: true, output: { cleanup: 'stop_continuous_sweeps' } });
    expect(outputs[6]?.result).toEqual({ ok: true, output: { cleanup: 'disconnect_device' } });
    expect(result.current.approval).toBeUndefined();
  });

  it('preserves call and result order through a successful mixed chain', async () => {
    const calls = [
      namedCall('configure-ok', 'configure_analyzer', '{"startHz":1000000}'),
      namedCall('acquire-ok', 'acquire_sweep'),
      namedCall('summary-ok', 'get_latest_sweep_summary'),
    ];
    installTextBatch(['configure_analyzer', 'acquire_sweep', 'get_latest_sweep_summary'], calls);
    const execute = vi.fn()
      .mockResolvedValueOnce({ stagedRevision: 9 })
      .mockResolvedValueOnce({ sequence: 10 })
      .mockResolvedValueOnce({ peakHz: 1_500_000 });
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    await waitFor(() => expect(result.current.state).toBe('unconfigured'));

    await act(async () => { await result.current.sendText('Run a successful chain.'); });

    expect(execute.mock.calls.map(([name]) => name)).toEqual(['configure_analyzer', 'acquire_sweep', 'get_latest_sweep_summary']);
    const outputs = textBatchOutputs(calls);
    expect(outputs).toHaveLength(calls.length);
    expect(outputs.map(({ callId }) => callId)).toEqual(calls.map(({ callId }) => callId));
    expect(outputs.map(({ result: output }) => output)).toEqual([
      { ok: true, output: { stagedRevision: 9 } },
      { ok: true, output: { sequence: 10 } },
      { ok: true, output: { peakHz: 1_500_000 } },
    ]);
  });
});

describe('useAtomAgent voice-session ownership', () => {
  beforeEach(() => installVoiceFakes());

  it('owns exactly one peer across React StrictMode effect replay and releases it on unmount', async () => {
    const { unmount } = renderHook(
      () => useAtomAgent({ applicationContext: () => '{}', execute: vi.fn() }),
      { wrapper: StrictMode },
    );
    await waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
    await waitFor(() => expect(window.atomAgent.createRealtimeCall).toHaveBeenCalledOnce());

    unmount();

    expect(FakePeerConnection.instances[0]?.closed).toBe(true);
  });

  it('rejects response events until the exact voice session is verified', async () => {
    const execute = vi.fn();
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    await waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
    await waitFor(() => expect(window.atomAgent.createRealtimeCall).toHaveBeenCalledOnce());
    const channel = FakePeerConnection.instances[0]!.channel;

    emitVoice(channel, responseCreated('unverified-response'));

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(execute).not.toHaveBeenCalled();
    expect(result.current.messages.some((message) => message.role === 'system' && message.text.includes('before exact session verification'))).toBe(true);
    expect(channel.onmessage).toBeNull();
  });

  it('stops a late microphone capture from an invalidated startup generation', async () => {
    const lateCapture = deferred<MediaStream>();
    const staleStream = new FakeMediaStream();
    const replacementStream = new FakeMediaStream();
    vi.mocked(navigator.mediaDevices.getUserMedia)
      .mockReset()
      .mockReturnValueOnce(lateCapture.promise)
      .mockResolvedValueOnce(replacementStream as unknown as MediaStream);
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute: vi.fn() }));
    await waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));

    act(() => result.current.stopVoice());
    await act(async () => { await result.current.startVoice(); });
    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(FakePeerConnection.instances[1]?.closed).toBe(false);

    lateCapture.resolve(staleStream as unknown as MediaStream);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(staleStream.track.readyState).toBe('ended');
    expect(replacementStream.track.readyState).toBe('live');
    expect(FakePeerConnection.instances[1]?.closed).toBe(false);
  });

  it('lets a text request preempt a hanging automatic voice startup without losing the prompt', async () => {
    const lateCapture = deferred<MediaStream>();
    const staleStream = new FakeMediaStream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReset().mockReturnValue(lateCapture.promise);
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute: vi.fn() }));
    await waitFor(() => expect(result.current.state).toBe('connecting'));

    await act(async () => { await result.current.sendText('Inspect the session safely.'); });

    expect(window.atomAgent.agentTurn).toHaveBeenCalledOnce();
    expect(result.current.messages.some((message) => message.role === 'user' && message.text === 'Inspect the session safely.')).toBe(true);
    expect(result.current.messages.some((message) => message.role === 'assistant' && message.text === 'answer 1')).toBe(true);
    expect(FakePeerConnection.instances[0]?.closed).toBe(true);
    expect(result.current.state).toBe('idle');

    lateCapture.resolve(staleStream as unknown as MediaStream);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(staleStream.track.readyState).toBe('ended');
    expect(window.atomAgent.createRealtimeCall).not.toHaveBeenCalled();
  });

  it('bounds voice startup even when microphone capture never settles', async () => {
    vi.useFakeTimers();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReset().mockReturnValue(new Promise<MediaStream>(() => undefined));
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute: vi.fn() }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.state).toBe('connecting');

    await act(async () => { vi.advanceTimersByTime(ATOM_REALTIME_STARTUP_TIMEOUT_MILLISECONDS); await Promise.resolve(); });

    expect(result.current.state).toBe('error');
    expect(result.current.messages.some((message) => message.role === 'system' && message.text.includes('startup did not complete'))).toBe(true);
    expect(FakePeerConnection.instances[0]?.closed).toBe(true);
  });

  it('fences a late tool completion from a stopped session and a replacement session', async () => {
    const pendingExecution = deferred<unknown>();
    const execute = vi.fn().mockReturnValueOnce(pendingExecution.promise);
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    const first = await activeVoiceChannel();
    expect(window.atomAgent.agentTurn).not.toHaveBeenCalled();

    await loadVoiceTools(first, 'late-loader', ['get_application_state']);
    emitVoice(first, responseCreated('late-response'));
    emitVoice(first, responseDone('late-response', [applicationCall('late-call')]));
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());

    act(() => result.current.stopVoice());
    expect(first.onopen).toBeNull();
    expect(first.onclose).toBeNull();
    expect(first.onerror).toBeNull();
    expect(first.onmessage).toBeNull();
    await act(async () => { await result.current.startVoice(); });
    const replacement = FakePeerConnection.instances.at(-1)!.channel;
    expect(replacement).not.toBe(first);

    pendingExecution.resolve({ stale: true });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(replacement.sent.some((value) => value.includes('late-call'))).toBe(false);
    expect(FakePeerConnection.instances.at(-1)?.closed).toBe(false);
    expect(result.current.state).not.toBe('error');
  });

  it('does not rebind an interrupted response to the next voice operation', async () => {
    const execute = vi.fn().mockResolvedValue({ state: 'ok' });
    renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    const channel = await activeVoiceChannel();
    await loadVoiceTools(channel, 'initial-loader', ['get_application_state']);
    emitVoice(channel, responseCreated('interrupted-response'));

    emitVoice(channel, { type: 'input_audio_buffer.speech_started' });
    emitVoice(channel, responseDone('interrupted-response', [applicationCall('interrupted-call')]));
    await act(async () => { await Promise.resolve(); });

    expect(execute).not.toHaveBeenCalled();
    expect(channel.sent.some((value) => value.includes('interrupted-call'))).toBe(false);

    await loadVoiceTools(channel, 'replacement-loader', ['get_application_state']);
    emitVoice(channel, responseCreated('replacement-response'));
    emitVoice(channel, responseDone('replacement-response', [applicationCall('replacement-call')]));
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await waitFor(() => expect(channel.sent.some((value) => value.includes('replacement-call'))).toBe(true));
  });

  it('cancels a pending voice approval on stop without executing or leaking it into a restart', async () => {
    const execute = vi.fn();
    const context = backendContext(BACKEND_A);
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => context, execute }));
    const first = await activeVoiceChannel();
    await loadVoiceTools(first, 'approval-loader', ['set_rf_output']);
    emitVoice(first, responseCreated('approval-response'));
    emitVoice(first, responseDone('approval-response', [{ callId: 'approval-call', name: 'set_rf_output', arguments: '{"enabled":true}' }]));
    await waitFor(() => expect(result.current.approval?.call.callId).toBe('approval-call'));

    act(() => result.current.stopVoice());
    await waitFor(() => expect(result.current.approval).toBeUndefined());
    await act(async () => { await result.current.startVoice(); });
    await act(async () => { await Promise.resolve(); });

    expect(execute).not.toHaveBeenCalled();
    expect(FakePeerConnection.instances.at(-1)?.closed).toBe(false);
  });

  it('lets an explicit text request replace an active voice session', async () => {
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute: vi.fn() }));
    await activeVoiceChannel();

    await act(async () => { await result.current.sendText('Switch to text.'); });

    expect(window.atomAgent.agentTurn).toHaveBeenCalledOnce();
    expect(result.current.messages.some((message) => message.text === 'Switch to text.')).toBe(true);
    expect(FakePeerConnection.instances[0]?.closed).toBe(true);
    expect(result.current.state).toBe('idle');
  });

  it('fails the active voice session before retaining an oversized streaming draft', async () => {
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute: vi.fn() }));
    const channel = await activeVoiceChannel();

    emitVoice(channel, {
      type: 'response.output_audio_transcript.delta',
      delta: 'x'.repeat(ATOM_UI_MESSAGE_CHARACTER_LIMIT + 1),
    });

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.messages.every((message) => message.text.length <= ATOM_UI_MESSAGE_CHARACTER_LIMIT)).toBe(true);
    expect(channel.onmessage).toBeNull();
  });
});

describe('useAtomAgent voice tool-batch failure barrier', () => {
  beforeEach(() => installVoiceFakes());

  it('stops after a configure failure and delivers one failed-prior result for every remaining call', async () => {
    const calls = [
      namedCall('voice-configure-failed', 'configure_analyzer', '{"startHz":1000000}'),
      namedCall('voice-acquire-skipped', 'acquire_sweep'),
      namedCall('voice-summary-skipped', 'get_latest_sweep_summary'),
    ];
    const execute = vi.fn().mockRejectedValueOnce(new Error('voice configuration failed'));
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    const channel = await activeVoiceChannel();
    await loadVoiceTools(channel, 'voice-configure-loader', ['configure_analyzer', 'acquire_sweep', 'get_latest_sweep_summary']);
    const offset = emitVoiceToolBatch(channel, 'voice-configure-response', calls);

    await waitFor(() => expect(voiceBatchOutputs(channel, offset)).toHaveLength(calls.length));

    expect(execute).toHaveBeenCalledTimes(1);
    const outputs = voiceBatchOutputs(channel, offset);
    expect(outputs.map(({ callId }) => callId)).toEqual(calls.map(({ callId }) => callId));
    expect(outputs.map(({ result: output }) => output)).toEqual([
      { ok: false, error: 'voice configuration failed' },
      failedPrior('voice-configure-failed'),
      failedPrior('voice-configure-failed'),
    ]);
    expect(result.current.messages.filter((message) => message.role === 'tool' && message.text.includes('skipped'))).toHaveLength(2);
  });

  it('preserves a successful configure before an acquire failure and skips the dependent read', async () => {
    const calls = [
      namedCall('voice-configure-ok', 'configure_analyzer', '{"startHz":1000000}'),
      namedCall('voice-acquire-failed', 'acquire_sweep'),
      namedCall('voice-summary-skipped', 'get_latest_sweep_summary'),
    ];
    const execute = vi.fn()
      .mockResolvedValueOnce({ stagedRevision: 2 })
      .mockRejectedValueOnce(new Error('voice acquisition failed'));
    renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    const channel = await activeVoiceChannel();
    await loadVoiceTools(channel, 'voice-acquire-loader', ['configure_analyzer', 'acquire_sweep', 'get_latest_sweep_summary']);
    const offset = emitVoiceToolBatch(channel, 'voice-acquire-response', calls);

    await waitFor(() => expect(voiceBatchOutputs(channel, offset)).toHaveLength(calls.length));

    expect(execute.mock.calls.map(([name]) => name)).toEqual(['configure_analyzer', 'acquire_sweep']);
    expect(voiceBatchOutputs(channel, offset).map(({ result: output }) => output)).toEqual([
      { ok: true, output: { stagedRevision: 2 } },
      { ok: false, error: 'voice acquisition failed' },
      failedPrior('voice-acquire-failed'),
    ]);
  });

  it('treats voice approval denial as failure and skips every later call', async () => {
    const calls = [
      namedCall('voice-rf-denied', 'set_rf_output', '{"enabled":true}'),
      namedCall('voice-state-skipped', 'get_instrument_state'),
    ];
    const execute = vi.fn();
    const context = backendContext(BACKEND_A);
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => context, execute }));
    const channel = await activeVoiceChannel();
    await loadVoiceTools(channel, 'voice-approval-loader', ['set_rf_output', 'get_instrument_state']);
    const offset = emitVoiceToolBatch(channel, 'voice-approval-response', calls);
    await waitFor(() => expect(result.current.approval?.call.callId).toBe('voice-rf-denied'));

    act(() => result.current.resolveApproval(false));
    await waitFor(() => expect(voiceBatchOutputs(channel, offset)).toHaveLength(calls.length));

    expect(execute).not.toHaveBeenCalled();
    expect(voiceBatchOutputs(channel, offset).map(({ result: output }) => output)).toEqual([
      { ok: false, error: 'User denied the high-impact action' },
      failedPrior('voice-rf-denied'),
    ]);
  });

  it('executes voice RF-off cleanup after an approved enable succeeds and a later call fails', async () => {
    const calls = [
      namedCall('voice-rf-enable-ok', 'set_rf_output', '{"enabled":true}'),
      namedCall('voice-acquire-after-enable-failed', 'acquire_sweep'),
      namedCall('voice-rf-off-after-failure', 'set_rf_output', '{"enabled":false}'),
    ];
    const execute = vi.fn().mockImplementation(async (name:string,args:unknown) => {
      if(name==='acquire_sweep')throw new Error('voice acquisition failed after RF enable');
      return { name, args };
    });
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => backendContext(BACKEND_A), execute }));
    const channel = await activeVoiceChannel();
    await loadVoiceTools(channel, 'voice-rf-cleanup-loader', ['set_rf_output', 'acquire_sweep']);
    const offset = emitVoiceToolBatch(channel, 'voice-rf-cleanup-response', calls);
    await waitFor(() => expect(result.current.approval?.call.callId).toBe('voice-rf-enable-ok'));

    act(() => result.current.resolveApproval(true));
    await waitFor(() => expect(voiceBatchOutputs(channel, offset)).toHaveLength(calls.length));

    expect(execute.mock.calls).toEqual([
      ['set_rf_output', { enabled: true }],
      ['acquire_sweep', {}],
      ['set_rf_output', { enabled: false }],
    ]);
    expect(voiceBatchOutputs(channel, offset).map(({ result: output }) => output)).toEqual([
      { ok: true, output: { name: 'set_rf_output', args: { enabled: true } } },
      { ok: false, error: 'voice acquisition failed after RF enable' },
      { ok: true, output: { name: 'set_rf_output', args: { enabled: false } } },
    ]);
  });

  it('executes voice stop cleanup after streaming starts and a later call fails', async () => {
    const calls = [
      namedCall('voice-stream-start-ok', 'start_continuous_sweeps'),
      namedCall('voice-stream-followup-failed', 'acquire_sweep'),
      namedCall('voice-stream-stop-cleanup', 'stop_continuous_sweeps'),
    ];
    const execute = vi.fn()
      .mockResolvedValueOnce({ started: true })
      .mockRejectedValueOnce(new Error('voice stream follow-up failed'))
      .mockResolvedValueOnce({ stopped: true });
    renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    const channel = await activeVoiceChannel();
    await loadVoiceTools(channel, 'voice-stream-cleanup-loader', ['start_continuous_sweeps', 'acquire_sweep', 'stop_continuous_sweeps']);
    const offset = emitVoiceToolBatch(channel, 'voice-stream-cleanup-response', calls);

    await waitFor(() => expect(voiceBatchOutputs(channel, offset)).toHaveLength(calls.length));

    expect(execute.mock.calls.map(([name]) => name)).toEqual(['start_continuous_sweeps', 'acquire_sweep', 'stop_continuous_sweeps']);
    expect(voiceBatchOutputs(channel, offset).map(({ result: output }) => output)).toEqual([
      { ok: true, output: { started: true } },
      { ok: false, error: 'voice stream follow-up failed' },
      { ok: true, output: { stopped: true } },
    ]);
  });

  it('allows voice connect to establish the identity required by a later approved high-impact call', async () => {
    const calls = [
      namedCall('voice-connect-ok', 'connect_device', '{"candidateId":"candidate-1"}'),
      namedCall('voice-rf-enable-after-connect', 'set_rf_output', '{"enabled":true}'),
    ];
    let context = backendContext();
    const execute = vi.fn().mockImplementation(async (name:string,args:unknown) => {
      if(name==='connect_device')context=backendContext(BACKEND_A);
      return { name, args };
    });
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => context, execute }));
    const channel = await activeVoiceChannel();
    await loadVoiceTools(channel, 'voice-connect-enable-loader', ['connect_device', 'set_rf_output']);
    const offset = emitVoiceToolBatch(channel, 'voice-connect-enable-response', calls);
    await waitFor(() => expect(result.current.approval?.call.callId).toBe('voice-rf-enable-after-connect'));

    act(() => result.current.resolveApproval(true));
    await waitFor(() => expect(voiceBatchOutputs(channel, offset)).toHaveLength(calls.length));

    expect(execute.mock.calls).toEqual([
      ['connect_device', { candidateId: 'candidate-1' }],
      ['set_rf_output', { enabled: true }],
    ]);
    expect(voiceBatchOutputs(channel, offset).map(({ result: output }) => output)).toEqual([
      { ok: true, output: { name: 'connect_device', args: { candidateId: 'candidate-1' } } },
      { ok: true, output: { name: 'set_rf_output', args: { enabled: true } } },
    ]);
  });

  it('rejects a voice high-impact call before approval when no complete backend identity exists', async () => {
    const calls = [namedCall('voice-rf-enable-no-backend', 'set_rf_output', '{"enabled":true}')];
    const execute = vi.fn();
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => backendContext(), execute }));
    const channel = await activeVoiceChannel();
    await loadVoiceTools(channel, 'voice-no-backend-loader', ['set_rf_output']);
    const offset = emitVoiceToolBatch(channel, 'voice-no-backend-response', calls);

    await waitFor(() => expect(voiceBatchOutputs(channel, offset)).toHaveLength(calls.length));

    expect(execute).not.toHaveBeenCalled();
    expect(result.current.approval).toBeUndefined();
    expect(voiceBatchOutputs(channel, offset).map(({ result: output }) => output)).toEqual([
      { ok: false, error: 'No complete active execution backend identity is available for high-impact action' },
    ]);
  });

  it('rejects a voice high-impact call when the complete backend identity changes during approval', async () => {
    const calls = [
      namedCall('voice-rf-enable-identity-change', 'set_rf_output', '{"enabled":true}'),
      namedCall('voice-state-after-change-skipped', 'get_instrument_state'),
    ];
    let context = backendContext(BACKEND_A);
    const execute = vi.fn();
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => context, execute }));
    const channel = await activeVoiceChannel();
    await loadVoiceTools(channel, 'voice-identity-change-loader', ['set_rf_output', 'get_instrument_state']);
    const offset = emitVoiceToolBatch(channel, 'voice-identity-change-response', calls);
    await waitFor(() => expect(result.current.approval?.call.callId).toBe('voice-rf-enable-identity-change'));

    context=backendContext(BACKEND_B);
    act(() => result.current.resolveApproval(true));
    await waitFor(() => expect(voiceBatchOutputs(channel, offset)).toHaveLength(calls.length));

    expect(execute).not.toHaveBeenCalled();
    expect(voiceBatchOutputs(channel, offset).map(({ result: output }) => output)).toEqual([
      { ok: false, error: 'Active execution backend changed while high-impact approval was pending' },
      failedPrior('voice-rf-enable-identity-change'),
    ]);
  });

  it('continues independent voice observe calls after one observe call fails', async () => {
    const calls = [
      namedCall('voice-application-failed', 'get_application_state'),
      namedCall('voice-instrument-ok', 'get_instrument_state'),
    ];
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error('voice application read failed'))
      .mockResolvedValueOnce({ sourceKind: 'signal-lab' });
    renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    const channel = await activeVoiceChannel();
    await loadVoiceTools(channel, 'voice-observe-loader', ['get_application_state', 'get_instrument_state']);
    const offset = emitVoiceToolBatch(channel, 'voice-observe-response', calls);

    await waitFor(() => expect(voiceBatchOutputs(channel, offset)).toHaveLength(calls.length));

    expect(execute.mock.calls.map(([name]) => name)).toEqual(['get_application_state', 'get_instrument_state']);
    expect(voiceBatchOutputs(channel, offset).map(({ result: output }) => output)).toEqual([
      { ok: false, error: 'voice application read failed' },
      { ok: true, output: { sourceKind: 'signal-lab' } },
    ]);
  });

  it('preflights an invalid mixed voice batch atomically with exact result cardinality and zero host effects', async () => {
    const calls = [
      namedCall('voice-state-valid', 'get_application_state'),
      namedCall('voice-configure-invalid', 'configure_analyzer'),
      namedCall('voice-rf-enable-suppressed', 'set_rf_output', '{"enabled":true}'),
      namedCall('voice-acquire-valid', 'acquire_sweep'),
      namedCall('voice-rf-off-cleanup', 'set_rf_output', '{"enabled":false}'),
      namedCall('voice-stop-cleanup', 'stop_continuous_sweeps'),
      namedCall('voice-disconnect-cleanup', 'disconnect_device'),
    ];
    const execute = vi.fn().mockImplementation(async (name:string) => ({ cleanup: name }));
    const context = backendContext(BACKEND_A);
    const { result } = renderHook(() => useAtomAgent({ applicationContext: () => context, execute }));
    const channel = await activeVoiceChannel();
    await loadVoiceTools(channel, 'voice-preflight-loader', ['get_application_state', 'configure_analyzer', 'set_rf_output', 'acquire_sweep', 'stop_continuous_sweeps', 'disconnect_device']);
    const offset = emitVoiceToolBatch(channel, 'voice-preflight-response', calls);

    await waitFor(() => expect(voiceBatchOutputs(channel, offset)).toHaveLength(calls.length));

    expect(execute.mock.calls).toEqual([
      ['set_rf_output', { enabled: false }],
      ['stop_continuous_sweeps', {}],
      ['disconnect_device', {}],
    ]);
    const outputs = voiceBatchOutputs(channel, offset);
    expect(outputs.map(({ callId }) => callId)).toEqual(calls.map(({ callId }) => callId));
    expect(outputs[0]?.result).toEqual(preflightSkipped('voice-configure-invalid'));
    expect(outputs[1]?.result).toMatchObject({ ok: false, recoverable: true });
    expect(outputs[1]?.result).not.toHaveProperty('skipped');
    expect(outputs[2]?.result).toEqual(preflightSkipped('voice-configure-invalid'));
    expect(outputs[3]?.result).toEqual(preflightSkipped('voice-configure-invalid'));
    expect(outputs[4]?.result).toEqual({ ok: true, output: { cleanup: 'set_rf_output' } });
    expect(outputs[5]?.result).toEqual({ ok: true, output: { cleanup: 'stop_continuous_sweeps' } });
    expect(outputs[6]?.result).toEqual({ ok: true, output: { cleanup: 'disconnect_device' } });
    expect(result.current.approval).toBeUndefined();
  });

  it('preserves call and result order through a successful mixed voice chain', async () => {
    const calls = [
      namedCall('voice-configure-ok', 'configure_analyzer', '{"startHz":1000000}'),
      namedCall('voice-acquire-ok', 'acquire_sweep'),
      namedCall('voice-summary-ok', 'get_latest_sweep_summary'),
    ];
    const execute = vi.fn()
      .mockResolvedValueOnce({ stagedRevision: 7 })
      .mockResolvedValueOnce({ sequence: 8 })
      .mockResolvedValueOnce({ peakHz: 1_250_000 });
    renderHook(() => useAtomAgent({ applicationContext: () => '{}', execute }));
    const channel = await activeVoiceChannel();
    await loadVoiceTools(channel, 'voice-success-loader', ['configure_analyzer', 'acquire_sweep', 'get_latest_sweep_summary']);
    const offset = emitVoiceToolBatch(channel, 'voice-success-response', calls);

    await waitFor(() => expect(voiceBatchOutputs(channel, offset)).toHaveLength(calls.length));

    expect(execute.mock.calls.map(([name]) => name)).toEqual(['configure_analyzer', 'acquire_sweep', 'get_latest_sweep_summary']);
    const outputs = voiceBatchOutputs(channel, offset);
    expect(outputs.map(({ callId }) => callId)).toEqual(calls.map(({ callId }) => callId));
    expect(outputs.map(({ result: output }) => output)).toEqual([
      { ok: true, output: { stagedRevision: 7 } },
      { ok: true, output: { sequence: 8 } },
      { ok: true, output: { peakHz: 1_250_000 } },
    ]);
  });
});

function textTurn(conversationId: string, toolCalls: readonly { callId: string; name: string; arguments: string }[]) {
  return { conversationId, transport: 'realtime-websocket' as const, text: '', toolCalls };
}

function installTextBatch(toolNames: readonly string[], calls: readonly TestToolCall[]): void {
  vi.mocked(window.atomAgent.agentTurn)
    .mockReset()
    .mockResolvedValueOnce(textTurn('text-loader-response', [loaderCall('text-batch-loader', toolNames)]))
    .mockResolvedValueOnce(textTurn('text-batch-response', calls))
    .mockResolvedValueOnce({ conversationId: 'text-batch-complete', transport: 'realtime-websocket', text: 'Batch complete.', toolCalls: [] });
}

function textBatchOutputs(calls: readonly TestToolCall[]): ParsedToolOutput[] {
  const callIds = new Set(calls.map(({ callId }) => callId));
  const request = vi.mocked(window.atomAgent.agentTurn).mock.calls
    .map(([value]) => value)
    .find((value) => value.toolOutputs?.some(({ callId }) => callIds.has(callId)));
  if(!request?.toolOutputs)throw new Error('Text batch tool outputs were not delivered');
  return request.toolOutputs
    .filter(({ callId }) => callIds.has(callId))
    .map(({ callId, output }) => ({ callId, result: JSON.parse(output) as Record<string, unknown> }));
}

function loaderCall(callId: string, toolNames: readonly string[]) {
  return { callId, name: 'load_atom_tools', arguments: JSON.stringify({ toolNames }) };
}

function applicationCall(callId: string, argumentsValue = '{}') {
  return { callId, name: 'get_application_state', arguments: argumentsValue };
}

interface TestToolCall { readonly callId: string; readonly name: string; readonly arguments: string }
interface ParsedToolOutput { readonly callId: string; readonly result: Record<string, unknown> }
interface TestBackendIdentity { readonly sessionId: string; readonly driverId: string; readonly sourceKind: string; readonly execution: string }

function namedCall(callId: string, name: string, argumentsValue = '{}'): TestToolCall {
  return { callId, name, arguments: argumentsValue };
}

function backendContext(identity?: TestBackendIdentity): string {
  return JSON.stringify({ topology: { instrument: identity??null } });
}

function failedPrior(failedCallId: string): Record<string, unknown> {
  return {
    ok: false,
    error: `Skipped because prior tool call ${failedCallId} did not succeed`,
    recoverable: true,
    skipped: true,
    skipReason: 'failed-prior',
    failedCallId,
  };
}

function preflightSkipped(failedCallId: string): Record<string, unknown> {
  return {
    ok: false,
    error: `Skipped because mutating tool batch preflight failed at ${failedCallId}`,
    recoverable: true,
    skipped: true,
    skipReason: 'preflight',
    failedCallId,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

class FakeMediaTrack {
  readonly id = crypto.randomUUID();
  readonly kind = 'audio';
  enabled = true;
  readyState: MediaStreamTrackState = 'live';
  stop() { this.readyState = 'ended'; }
  getSettings(): MediaTrackSettings { return { echoCancellation: true, noiseSuppression: true, autoGainControl: true }; }
}

class FakeMediaStream {
  readonly id = crypto.randomUUID();
  readonly track = new FakeMediaTrack();
  getTracks() { return [this.track] as unknown as MediaStreamTrack[]; }
  getAudioTracks() { return [this.track] as unknown as MediaStreamTrack[]; }
}

class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 'closed'; }
}

class FakePeerConnection {
  static readonly instances: FakePeerConnection[] = [];
  readonly channel = new FakeDataChannel();
  connectionState: RTCPeerConnectionState = 'new';
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: ((event: Event) => void) | null = null;
  closed = false;
  constructor() { FakePeerConnection.instances.push(this); }
  createDataChannel() { return this.channel as unknown as RTCDataChannel; }
  addTrack() { return {} as RTCRtpSender; }
  async createOffer() { return { type: 'offer' as const, sdp: 'v=0\r\n' }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() { this.closed = true; this.connectionState = 'closed'; }
}

function installVoiceFakes(): void {
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockImplementation(async () => new FakeMediaStream() as unknown as MediaStream) },
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.mocked(window.atomAgent.status).mockResolvedValue({ configured: true, model: 'gpt-realtime-2.1', voice: 'ballad', reasoningEffort: 'high', textAgent: true, realtime: true, textTransport: 'realtime-websocket' });
  vi.mocked(window.atomAgent.createRealtimeCall).mockResolvedValue('v=0\r\n');
}

async function activeVoiceChannel(): Promise<FakeDataChannel> {
  await waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
  await waitFor(() => expect(window.atomAgent.createRealtimeCall).toHaveBeenCalledOnce());
  const channel = FakePeerConnection.instances[0]!.channel;
  emitVoice(channel, { type: 'session.updated', session: createAtomRealtimeVoiceSessionConfig() });
  return channel;
}

function emitVoice(channel: FakeDataChannel, event: unknown): void {
  act(() => channel.onmessage?.({ data: JSON.stringify(event) } as MessageEvent));
}

function emitVoiceToolBatch(channel: FakeDataChannel, responseId: string, calls: readonly TestToolCall[]): number {
  const offset = channel.sent.length;
  emitVoice(channel, responseCreated(responseId));
  emitVoice(channel, responseDone(responseId, calls));
  return offset;
}

function voiceBatchOutputs(channel: FakeDataChannel, offset: number): ParsedToolOutput[] {
  const outputs: ParsedToolOutput[] = [];
  for(const raw of channel.sent.slice(offset)){
    const event = JSON.parse(raw) as { type?: unknown; item?: { type?: unknown; call_id?: unknown; output?: unknown } };
    if(event.type!=='conversation.item.create'||event.item?.type!=='function_call_output'||typeof event.item.call_id!=='string'||typeof event.item.output!=='string')continue;
    outputs.push({ callId: event.item.call_id, result: JSON.parse(event.item.output) as Record<string, unknown> });
  }
  return outputs;
}

async function loadVoiceTools(channel: FakeDataChannel, callId: string, toolNames: readonly string[]): Promise<void> {
  emitVoice(channel, responseCreated(`${callId}-response`));
  emitVoice(channel, responseDone(`${callId}-response`, [loaderCall(callId, toolNames)]));
  await waitFor(() => expect(channel.sent.some((value) => value.includes(callId))).toBe(true));
}

function responseCreated(id: string) { return { type: 'response.created', response: { id } }; }
function responseDone(id: string, calls: readonly { callId: string; name: string; arguments: string }[]) {
  return {
    type: 'response.done',
    response: {
      id,
      status: 'completed',
      output: calls.map((call) => ({ type: 'function_call', status: 'completed', call_id: call.callId, name: call.name, arguments: call.arguments })),
    },
  };
}
