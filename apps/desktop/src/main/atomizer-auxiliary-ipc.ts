import { parseAtomLoadedToolNames, type AgentTurnRequest } from '@tinysa/agent';
import { sweepExportRequestSchema, type SweepExportRequest } from '@tinysa/contracts';
import {
  ATOMIZER_AI_IPC_CHANNELS,
  ATOMIZER_AUXILIARY_IPC_CHANNELS,
  ATOMIZER_FILES_IPC_CHANNELS,
} from './atomizer-ipc-channels.js';
import type { PrivilegedIpcAdmission } from './privileged-ipc-admission.js';

export interface AuxiliaryIpcRegistrar<Event = unknown> {
  handle(channel: string, listener: (event: Event, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface ComputerClickInput { screenshotId: string; x: number; y: number }
export interface ComputerTypeInput { expectedTarget: string; text: string }
export interface ComputerKeyInput { expectedTarget: string; key: string }
export interface ComputerScrollInput { screenshotId: string; x: number; y: number; deltaX: number; deltaY: number }

export const MAX_REALTIME_SDP_BYTES_V1 = 256_000;
export const MAX_COMPUTER_TARGET_CHARACTERS_V1 = 128;
export const MAX_COMPUTER_TEXT_CHARACTERS_V1 = 2_000;
export const MAX_COMPUTER_TEXT_BYTES_V1 = 4_000;
export const MAX_COMPUTER_COORDINATE_V1 = 32_767;
export const MAX_COMPUTER_SCROLL_DELTA_V1 = 32_767;
export const MAX_AGENT_TURN_REQUEST_BYTES_V1 = 16 * 1024 * 1024;
const MAX_AGENT_PROMPT_CHARACTERS_V1 = 20_000;
const MAX_AGENT_CONVERSATION_ID_CHARACTERS_V1 = 256;
const MAX_AGENT_TOOL_OUTPUTS_V1 = 16;
const MAX_AGENT_CALL_ID_CHARACTERS_V1 = 256;
const MAX_AGENT_TOOL_OUTPUT_CHARACTERS_V1 = 200_000;
const MAX_AGENT_IMAGE_DATA_URL_CHARACTERS_V1 = 12_000_000;
const SCREENSHOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_COMPUTER_KEYS = new Set([
  'ENTER', 'ESCAPE', 'TAB', 'ARROWUP', 'ARROWDOWN', 'ARROWLEFT', 'ARROWRIGHT',
  'BACKSPACE', 'META+K', 'CTRL+K',
]);

/** Operations remain independent from Electron so the entire privileged adapter is testable. */
export interface AtomizerAuxiliaryIpcOperations {
  exportSweep(request: SweepExportRequest): unknown;
  aiStatus(): unknown;
  createRealtimeCall(sdp: string): unknown;
  agentTurn(request: AgentTurnRequest): unknown;
  computerScreenshot(): unknown;
  computerClick(input: ComputerClickInput): unknown;
  computerType(input: ComputerTypeInput): unknown;
  computerKey(input: ComputerKeyInput): unknown;
  computerScroll(input: ComputerScrollInput): unknown;
}

/** Registers every file, AI, and computer-control operation behind one mandatory trust assertion. */
export function registerAtomizerAuxiliaryIpc<Event>(
  ipc: AuxiliaryIpcRegistrar<Event>,
  operations: AtomizerAuxiliaryIpcOperations,
  assertTrusted: (event: Event) => void,
  admission: PrivilegedIpcAdmission,
): () => void {
  const files = ATOMIZER_FILES_IPC_CHANNELS;
  const ai = ATOMIZER_AI_IPC_CHANNELS;
  const registrations = [
    [files.exportSweep, oneArgument('exportSweep', sweepExportRequestSchema.parse, operations.exportSweep)],
    [ai.status, noArguments('aiStatus', operations.aiStatus)],
    [ai.realtimeCall, oneArgument('createRealtimeCall', parseSdp, operations.createRealtimeCall)],
    [ai.agentTurn, oneArgument('agentTurn', validateAgentTurnRequest, operations.agentTurn)],
    [ai.computerScreenshot, noArguments('computerScreenshot', operations.computerScreenshot)],
    [ai.computerClick, oneArgument('computerClick', parseComputerClick, operations.computerClick)],
    [ai.computerType, oneArgument('computerType', parseComputerType, operations.computerType)],
    [ai.computerKey, oneArgument('computerKey', parseComputerKey, operations.computerKey)],
    [ai.computerScroll, oneArgument('computerScroll', parseComputerScroll, operations.computerScroll)],
  ] as const;

  const registered: string[] = [];
  try {
    for (const [channel, handler] of registrations) {
      ipc.handle(channel, (event, ...args) => {
        assertTrusted(event);
        return admission.run(channel, () => handler(...args));
      });
      registered.push(channel);
    }
  } catch (value) {
    for (const channel of registered) ipc.removeHandler(channel);
    throw value;
  }

  return () => {
    for (const channel of ATOMIZER_AUXILIARY_IPC_CHANNELS) ipc.removeHandler(channel);
  };
}

function noArguments<Output>(operation: string, invoke: () => Output): (...args: unknown[]) => Output {
  return (...args) => {
    requireArgumentCount(operation, args, 0);
    return invoke();
  };
}

function oneArgument<Input, Output>(
  operation: string,
  parse: (value: unknown) => Input,
  invoke: (value: Input) => Output,
): (...args: unknown[]) => Output {
  return (...args) => {
    requireArgumentCount(operation, args, 1);
    return invoke(parse(args[0]));
  };
}

function requireArgumentCount(operation: string, values: readonly unknown[], expected: number): void {
  if (values.length !== expected) {
    throw new TypeError(`Atomizer ${operation} requires exactly ${expected} argument${expected === 1 ? '' : 's'}`);
  }
}

function parseSdp(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('sdp must be a string');
  if (!value.startsWith('v=0') || value.includes('\0') || Buffer.byteLength(value) > MAX_REALTIME_SDP_BYTES_V1) {
    throw new TypeError(`sdp must be a valid WebRTC offer of at most ${MAX_REALTIME_SDP_BYTES_V1} bytes`);
  }
  return value;
}

export function validateAgentTurnRequest(value: unknown): AgentTurnRequest {
  if (!isPlainRecord(value)) throw new TypeError('Agent turn must be a plain object');
  const request = value as Record<string, unknown> & Partial<AgentTurnRequest>;
  const allowed = new Set(['prompt', 'conversationId', 'toolOutputs', 'loadedToolNames']);
  if (Object.keys(request).some((key) => !allowed.has(key))) throw new TypeError('Agent turn contains an undeclared field');
  if (request.prompt !== undefined && (typeof request.prompt !== 'string' || request.prompt.length > MAX_AGENT_PROMPT_CHARACTERS_V1 || request.prompt.includes('\0'))) {
    throw new TypeError('prompt must be a bounded string without NUL characters');
  }
  if (request.conversationId !== undefined && (typeof request.conversationId !== 'string'
    || request.conversationId.length < 1
    || request.conversationId.length > MAX_AGENT_CONVERSATION_ID_CHARACTERS_V1
    || request.conversationId.trim() !== request.conversationId
    || /[\u0000-\u001f\u007f]/.test(request.conversationId))) {
    throw new TypeError('conversationId must be a non-empty bounded identifier');
  }
  if (request.toolOutputs !== undefined
    && (!Array.isArray(request.toolOutputs) || request.toolOutputs.length > MAX_AGENT_TOOL_OUTPUTS_V1)) {
    throw new TypeError(`toolOutputs must contain at most ${MAX_AGENT_TOOL_OUTPUTS_V1} items`);
  }
  if (request.loadedToolNames !== undefined) parseAtomLoadedToolNames(request.loadedToolNames);
  // Reject the complete structured payload before decoding even one image;
  // individually bounded images must not create aggregate decode pressure.
  enforceAgentTurnAggregateBytes(request);
  if (request.toolOutputs !== undefined) validateAgentToolOutputs(request.toolOutputs);
  const hasPrompt = Boolean(request.prompt?.trim());
  const hasOutputs = Boolean(request.toolOutputs?.length);
  if (hasPrompt === hasOutputs) throw new TypeError('Agent turn requires either a prompt or tool outputs');
  if (hasPrompt && request.loadedToolNames !== undefined) throw new TypeError('A new Atom prompt cannot inherit response-scoped tools');
  if (hasOutputs && !request.loadedToolNames?.length) throw new TypeError('Atom tool results require an exact response-scoped tool selection');
  return request as AgentTurnRequest;
}

function validateAgentToolOutputs(value: unknown): asserts value is AgentTurnRequest['toolOutputs'] {
  if (!Array.isArray(value) || value.length > MAX_AGENT_TOOL_OUTPUTS_V1) {
    throw new TypeError(`toolOutputs must contain at most ${MAX_AGENT_TOOL_OUTPUTS_V1} items`);
  }
  const callIds = new Set<string>();
  for (const item of value) {
    if (!isPlainRecord(item)) throw new TypeError('Each tool output must be a plain object');
    const fields = Object.keys(item);
    if (fields.some((field) => field !== 'callId' && field !== 'output' && field !== 'imageDataUrl')
      || !Object.hasOwn(item, 'callId')
      || !Object.hasOwn(item, 'output')) {
      throw new TypeError('Each tool output must contain exactly callId, output, and optional imageDataUrl');
    }
    const callId = item.callId;
    if (typeof callId !== 'string'
      || callId.length < 1
      || callId.length > MAX_AGENT_CALL_ID_CHARACTERS_V1
      || callId.trim() !== callId
      || /[\u0000-\u001f\u007f]/.test(callId)) {
      throw new TypeError('Tool output callId must be a non-empty bounded identifier');
    }
    if (callIds.has(callId)) throw new TypeError(`Tool output callId ${callId} is duplicated`);
    callIds.add(callId);
    if (typeof item.output !== 'string'
      || item.output.length < 1
      || item.output.length > MAX_AGENT_TOOL_OUTPUT_CHARACTERS_V1
      || item.output.includes('\0')) {
      throw new TypeError('Tool output must be a non-empty bounded string without NUL characters');
    }
    if (item.imageDataUrl !== undefined) validateAgentImageDataUrl(item.imageDataUrl);
  }
}

function validateAgentImageDataUrl(value: unknown): void {
  if (typeof value !== 'string' || value.length > MAX_AGENT_IMAGE_DATA_URL_CHARACTERS_V1) {
    throw new TypeError('Tool output imageDataUrl must be a bounded PNG or JPEG data URL');
  }
  const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  const payload = match?.[1];
  if (!payload || payload.length % 4 !== 0) {
    throw new TypeError('Tool output imageDataUrl must contain valid padded base64');
  }
  const decoded = Buffer.from(payload, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== payload) {
    throw new TypeError('Tool output imageDataUrl must contain canonical base64');
  }
}

function enforceAgentTurnAggregateBytes(request: Record<string, unknown>): void {
  let total = 0;
  const add = (value: string): void => {
    total += Buffer.byteLength(value);
    if (total > MAX_AGENT_TURN_REQUEST_BYTES_V1) {
      throw new TypeError(`Agent turn must be at most ${MAX_AGENT_TURN_REQUEST_BYTES_V1} UTF-8 bytes`);
    }
  };
  if (typeof request.prompt === 'string') add(request.prompt);
  if (typeof request.conversationId === 'string') add(request.conversationId);
  if (Array.isArray(request.loadedToolNames)) {
    for (const name of request.loadedToolNames) if (typeof name === 'string') add(name);
  }
  if (Array.isArray(request.toolOutputs)) {
    for (const output of request.toolOutputs) {
      if (!isPlainRecord(output)) continue;
      if (typeof output.callId === 'string') add(output.callId);
      if (typeof output.output === 'string') add(output.output);
      if (typeof output.imageDataUrl === 'string') add(output.imageDataUrl);
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseComputerClick(value: unknown): ComputerClickInput {
  const input = validateComputerInput(value, ['screenshotId', 'x', 'y']);
  return {
    screenshotId: parseScreenshotId(input.screenshotId),
    x: parseCoordinate(input.x, 'x'),
    y: parseCoordinate(input.y, 'y'),
  };
}

function parseComputerType(value: unknown): ComputerTypeInput {
  const input = validateComputerInput(value, ['expectedTarget', 'text']);
  return {
    expectedTarget: parseExpectedTarget(input.expectedTarget),
    text: parseComputerText(input.text),
  };
}

function parseComputerKey(value: unknown): ComputerKeyInput {
  const input = validateComputerInput(value, ['expectedTarget', 'key']);
  const key = parseBoundedString(input.key, 'key', 16);
  if (!ALLOWED_COMPUTER_KEYS.has(key)) throw new TypeError('key must be an allow-listed computer key');
  return { expectedTarget: parseExpectedTarget(input.expectedTarget), key };
}

function parseComputerScroll(value: unknown): ComputerScrollInput {
  const input = validateComputerInput(value, ['screenshotId', 'x', 'y', 'deltaX', 'deltaY']);
  return {
    screenshotId: parseScreenshotId(input.screenshotId),
    x: parseCoordinate(input.x, 'x'),
    y: parseCoordinate(input.y, 'y'),
    deltaX: parseScrollDelta(input.deltaX, 'deltaX'),
    deltaY: parseScrollDelta(input.deltaY, 'deltaY'),
  };
}

function validateComputerInput(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('computer input must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== fields.length || fields.some((field) => !Object.hasOwn(input, field))) {
    throw new TypeError(`computer input must contain exactly ${fields.join(', ')}`);
  }
  return input;
}

function parseScreenshotId(value: unknown): string {
  const screenshotId = parseBoundedString(value, 'screenshotId', 36);
  if (!SCREENSHOT_ID_PATTERN.test(screenshotId)) throw new TypeError('screenshotId must be a UUID');
  return screenshotId;
}

function parseExpectedTarget(value: unknown): string {
  const target = parseBoundedString(value, 'expectedTarget', MAX_COMPUTER_TARGET_CHARACTERS_V1);
  if (/[\u0000-\u001f\u007f]/.test(target)) throw new TypeError('expectedTarget must not contain control characters');
  return target;
}

function parseComputerText(value: unknown): string {
  const text = parseBoundedString(value, 'text', MAX_COMPUTER_TEXT_CHARACTERS_V1);
  if (Buffer.byteLength(text) > MAX_COMPUTER_TEXT_BYTES_V1) {
    throw new TypeError(`text must be at most ${MAX_COMPUTER_TEXT_BYTES_V1} UTF-8 bytes`);
  }
  return text;
}

function parseBoundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.includes('\0')) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function parseCoordinate(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_COMPUTER_COORDINATE_V1) {
    throw new TypeError(`${field} must be an integer from 0 through ${MAX_COMPUTER_COORDINATE_V1}`);
  }
  return value as number;
}

function parseScrollDelta(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > MAX_COMPUTER_SCROLL_DELTA_V1) {
    throw new TypeError(`${field} must be an integer from -${MAX_COMPUTER_SCROLL_DELTA_V1} through ${MAX_COMPUTER_SCROLL_DELTA_V1}`);
  }
  return value as number;
}
