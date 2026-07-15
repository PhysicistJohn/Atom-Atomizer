import { describe, expect, it, vi } from 'vitest';
import {
  MAX_AGENT_TURN_REQUEST_BYTES_V1,
  MAX_COMPUTER_TARGET_CHARACTERS_V1,
  MAX_COMPUTER_TEXT_BYTES_V1,
  MAX_REALTIME_SDP_BYTES_V1,
  registerAtomizerAuxiliaryIpc,
  validateAgentTurnRequest,
  type AtomizerAuxiliaryIpcOperations,
  type AuxiliaryIpcRegistrar,
} from './atomizer-auxiliary-ipc.js';
import {
  ATOMIZER_AI_IPC_CHANNELS,
  ATOMIZER_AUXILIARY_IPC_CHANNELS,
  ATOMIZER_FILES_IPC_CHANNELS,
} from './atomizer-ipc-channels.js';
import { BoundedPrivilegedIpcAdmission } from './privileged-ipc-admission.js';

interface TestEvent { trusted: boolean }
const SCREENSHOT_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('Atomizer auxiliary privileged IPC', () => {
  it('registers and removes the exact file, AI, and computer channel catalog', () => {
    const ipc = new FakeIpc();
    const operations = fakeOperations();
    const remove = registerAtomizerAuxiliaryIpc(
      ipc,
      operations,
      assertTrusted,
      new BoundedPrivilegedIpcAdmission(),
    );

    expect([...ipc.handlers.keys()]).toEqual(ATOMIZER_AUXILIARY_IPC_CHANNELS);
    remove();
    expect(ipc.handlers.size).toBe(0);
    expect(ipc.removed).toEqual(ATOMIZER_AUXILIARY_IPC_CHANNELS);
  });

  it('rejects untrusted events before parsing across every file, AI, and computer handler', () => {
    const ipc = new FakeIpc();
    const operations = fakeOperations();
    registerAtomizerAuxiliaryIpc(ipc, operations, assertTrusted, new BoundedPrivilegedIpcAdmission());

    for (const channel of ATOMIZER_AUXILIARY_IPC_CHANNELS) {
      expect(() => ipc.invokeFrom(channel, { trusted: false })).toThrow(/untrusted renderer/i);
    }
    for (const operation of Object.values(operations)) expect(operation).not.toHaveBeenCalled();
  });

  it('validates exact arity and payloads before invoking each operation family', () => {
    const ipc = new FakeIpc();
    const operations = fakeOperations();
    registerAtomizerAuxiliaryIpc(ipc, operations, assertTrusted, new BoundedPrivilegedIpcAdmission());

    expect(ipc.invoke(ATOMIZER_AI_IPC_CHANNELS.status)).toBe('status');
    expect(() => ipc.invoke(ATOMIZER_AI_IPC_CHANNELS.status, 'extra')).toThrow(/exactly 0 arguments/);
    expect(ipc.invoke(ATOMIZER_AI_IPC_CHANNELS.realtimeCall, 'v=0')).toBe('answer');
    expect(() => ipc.invoke(ATOMIZER_AI_IPC_CHANNELS.realtimeCall, 4)).toThrow(/sdp must be a string/);
    expect(ipc.invoke(ATOMIZER_AI_IPC_CHANNELS.agentTurn, { prompt: 'inspect' })).toBe('turn');
    expect(() => ipc.invoke(ATOMIZER_AI_IPC_CHANNELS.agentTurn, { prompt: 'inspect', forged: true })).toThrow(/undeclared/);
    expect(ipc.invoke(ATOMIZER_AI_IPC_CHANNELS.computerScreenshot)).toBe('screenshot');
    expect(ipc.invoke(ATOMIZER_AI_IPC_CHANNELS.computerClick, { screenshotId: SCREENSHOT_ID, x: 1, y: 2 })).toBe('click');
    expect(ipc.invoke(ATOMIZER_AI_IPC_CHANNELS.computerType, { expectedTarget: 'prompt', text: 'hello' })).toBe('type');
    expect(ipc.invoke(ATOMIZER_AI_IPC_CHANNELS.computerKey, { expectedTarget: 'prompt', key: 'ENTER' })).toBe('key');
    expect(ipc.invoke(ATOMIZER_AI_IPC_CHANNELS.computerScroll, { screenshotId: SCREENSHOT_ID, x: 1, y: 2, deltaX: 0, deltaY: 10 })).toBe('scroll');
    expect(() => ipc.invoke(ATOMIZER_FILES_IPC_CHANNELS.exportSweep, { format: 'csv', sweep: { forged: true } })).toThrow();
    expect(operations.exportSweep).not.toHaveBeenCalled();
  });

  it('rejects oversized SDP and computer-control strings or scalars before operation invocation', () => {
    const ipc = new FakeIpc();
    const operations = fakeOperations();
    registerAtomizerAuxiliaryIpc(ipc, operations, assertTrusted, new BoundedPrivilegedIpcAdmission());

    expect(() => ipc.invoke(
      ATOMIZER_AI_IPC_CHANNELS.realtimeCall,
      `v=0\r\n${'a'.repeat(MAX_REALTIME_SDP_BYTES_V1)}`,
    )).toThrow(/at most/i);
    expect(() => ipc.invoke(
      ATOMIZER_AI_IPC_CHANNELS.computerClick,
      { screenshotId: 'not-a-uuid', x: 1, y: 2 },
    )).toThrow(/UUID/);
    expect(() => ipc.invoke(
      ATOMIZER_AI_IPC_CHANNELS.computerClick,
      { screenshotId: SCREENSHOT_ID, x: Number.MAX_SAFE_INTEGER, y: 2 },
    )).toThrow(/0 through/);
    expect(() => ipc.invoke(
      ATOMIZER_AI_IPC_CHANNELS.computerType,
      { expectedTarget: 'x'.repeat(MAX_COMPUTER_TARGET_CHARACTERS_V1 + 1), text: 'hello' },
    )).toThrow(/expectedTarget/);
    expect(() => ipc.invoke(
      ATOMIZER_AI_IPC_CHANNELS.computerType,
      { expectedTarget: 'prompt', text: '€'.repeat(Math.floor(MAX_COMPUTER_TEXT_BYTES_V1 / 3) + 1) },
    )).toThrow(/UTF-8 bytes/);
    expect(() => ipc.invoke(
      ATOMIZER_AI_IPC_CHANNELS.computerKey,
      { expectedTarget: 'prompt', key: 'DELETE' },
    )).toThrow(/allow-listed/);
    expect(() => ipc.invoke(
      ATOMIZER_AI_IPC_CHANNELS.computerScroll,
      { screenshotId: SCREENSHOT_ID, x: 1, y: 2, deltaX: 0, deltaY: Number.MAX_SAFE_INTEGER },
    )).toThrow(/deltaY/);

    expect(operations.createRealtimeCall).not.toHaveBeenCalled();
    expect(operations.computerClick).not.toHaveBeenCalled();
    expect(operations.computerType).not.toHaveBeenCalled();
    expect(operations.computerKey).not.toHaveBeenCalled();
    expect(operations.computerScroll).not.toHaveBeenCalled();
  });

  it('strictly validates response-scoped tool output identities and image data', () => {
    const valid = {
      conversationId: 'conversation-1',
      toolOutputs: [{
        callId: 'call-1',
        output: '{"ok":true}',
        imageDataUrl: 'data:image/jpeg;base64,aW1hZ2U=',
      }],
      loadedToolNames: ['get_application_state'],
    };
    expect(validateAgentTurnRequest(valid)).toEqual(valid);

    const invalidOutputs = [
      [{ callId: '', output: '{}' }],
      [{ callId: ' call-1 ', output: '{}' }],
      [{ callId: 'call-1', output: '' }],
      [{ callId: 'call-1', output: '{}', forged: true }],
      [{ callId: 'call-1', output: '{}' }, { callId: 'call-1', output: '{}' }],
      [{ callId: 'call-1', output: '{}', imageDataUrl: 'data:image/jpeg;base64,not base64' }],
      [{ callId: 'call-1', output: '{}', imageDataUrl: 'data:image/jpeg;base64,AB==' }],
      [{ callId: 'call-1', output: '{}', imageDataUrl: 'https://example.test/image.jpg' }],
    ];
    for (const toolOutputs of invalidOutputs) {
      expect(() => validateAgentTurnRequest({
        conversationId: 'conversation-1', toolOutputs, loadedToolNames: ['get_application_state'],
      })).toThrow();
    }
  });

  it('rejects aggregate tool output bytes even when every item is below its individual ceiling', () => {
    const payload = 'YWFh'.repeat(Math.ceil((MAX_AGENT_TURN_REQUEST_BYTES_V1 + 1_024) / 8));
    const imageDataUrl = `data:image/jpeg;base64,${payload}`;
    expect(imageDataUrl.length).toBeLessThan(12_000_000);
    expect(() => validateAgentTurnRequest({
      conversationId: 'conversation-1',
      toolOutputs: [
        { callId: 'call-1', output: '{}', imageDataUrl },
        { callId: 'call-2', output: '{}', imageDataUrl },
      ],
      loadedToolNames: ['get_application_state'],
    })).toThrow(new RegExp(`${MAX_AGENT_TURN_REQUEST_BYTES_V1} UTF-8 bytes`));
  });

  it('shares one hard cap across auxiliary operation families and releases it on settlement', async () => {
    const ipc = new FakeIpc();
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => { resolve = done; });
    const operations = fakeOperations();
    operations.aiStatus.mockReturnValue(pending);
    const admission = new BoundedPrivilegedIpcAdmission(1);
    registerAtomizerAuxiliaryIpc(ipc, operations, assertTrusted, admission);

    const first = ipc.invoke(ATOMIZER_AI_IPC_CHANNELS.status) as Promise<string>;
    expect(admission.pending).toBe(1);
    expect(() => ipc.invoke(ATOMIZER_AI_IPC_CHANNELS.computerScreenshot)).toThrow(/admission limit/i);
    expect(() => ipc.invoke(ATOMIZER_FILES_IPC_CHANNELS.exportSweep, {})).toThrow(/admission limit/i);
    expect(operations.computerScreenshot).not.toHaveBeenCalled();

    resolve('status');
    await expect(first).resolves.toBe('status');
    expect(admission.pending).toBe(0);
    expect(ipc.invoke(ATOMIZER_AI_IPC_CHANNELS.computerScreenshot)).toBe('screenshot');
  });
});

class FakeIpc implements AuxiliaryIpcRegistrar<TestEvent> {
  readonly handlers = new Map<string, (event: TestEvent, ...args: unknown[]) => unknown>();
  readonly removed: string[] = [];

  handle(channel: string, listener: (event: TestEvent, ...args: unknown[]) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate ${channel}`);
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
    this.removed.push(channel);
  }

  invoke(channel: string, ...args: unknown[]): unknown {
    return this.invokeFrom(channel, { trusted: true }, ...args);
  }

  invokeFrom(channel: string, event: TestEvent, ...args: unknown[]): unknown {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing ${channel}`);
    return handler(event, ...args);
  }
}

function assertTrusted(event: TestEvent): void {
  if (!event.trusted) throw new Error('Rejected IPC from an untrusted renderer frame or origin');
}

function fakeOperations() {
  return {
    exportSweep: vi.fn(() => 'export'),
    aiStatus: vi.fn(() => 'status' as unknown),
    createRealtimeCall: vi.fn(() => 'answer'),
    agentTurn: vi.fn(() => 'turn'),
    computerScreenshot: vi.fn(() => 'screenshot'),
    computerClick: vi.fn(() => 'click'),
    computerType: vi.fn(() => 'type'),
    computerKey: vi.fn(() => 'key'),
    computerScroll: vi.fn(() => 'scroll'),
  } satisfies AtomizerAuxiliaryIpcOperations;
}
