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
    const context = JSON.stringify({ topology: { instrument: { execution: 'physical' } } });
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

function textTurn(conversationId: string, toolCalls: readonly { callId: string; name: string; arguments: string }[]) {
  return { conversationId, transport: 'realtime-websocket' as const, text: '', toolCalls };
}

function loaderCall(callId: string, toolNames: readonly string[]) {
  return { callId, name: 'load_atom_tools', arguments: JSON.stringify({ toolNames }) };
}

function applicationCall(callId: string, argumentsValue = '{}') {
  return { callId, name: 'get_application_state', arguments: argumentsValue };
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
