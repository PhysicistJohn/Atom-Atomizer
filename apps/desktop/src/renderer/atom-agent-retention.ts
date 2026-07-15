import type { AgentMessage } from '@tinysa/agent';

/**
 * The renderer transcript is a presentation cache, not the text-agent context:
 * the main process continues the authoritative conversation by conversation ID.
 * 256 rows retain dozens of tool-heavy turns without allowing a day-long UI
 * session to grow the React tree indefinitely.
 */
export const ATOM_UI_MESSAGE_LIMIT = 256;
export const ATOM_UI_MESSAGE_CHARACTER_LIMIT = 20_000;

/**
 * Realtime call IDs are the renderer's exactly-once ledger. They must never be
 * evicted while their text conversation or voice session is alive, so a
 * conversation fails closed after this many distinct calls.
 */
export const ATOM_REALTIME_CALL_ID_LIMIT = 4_096;
export const ATOM_REALTIME_CALL_ID_CHARACTER_LIMIT = 256;
export const ATOM_REALTIME_CALL_ARGUMENT_CHARACTER_LIMIT = 20_000;
export const ATOM_REALTIME_TOOL_CALL_LIMIT = 8;
export const ATOM_REALTIME_EVENT_CHARACTER_LIMIT = 1_000_000;
export const ATOM_REALTIME_RESPONSE_OUTPUT_ITEM_LIMIT = 64;

// Compatibility names for the voice-specific first user of this ledger.
export const ATOM_VOICE_CALL_ID_LIMIT = ATOM_REALTIME_CALL_ID_LIMIT;
export const ATOM_VOICE_CALL_ID_CHARACTER_LIMIT = ATOM_REALTIME_CALL_ID_CHARACTER_LIMIT;

const UI_TRUNCATION_MARKER = '\n[Atom UI transcript truncated at its bounded presentation limit]';

export function boundAtomUiMessageText(
  text: string,
  characterLimit = ATOM_UI_MESSAGE_CHARACTER_LIMIT,
): string {
  if (!Number.isSafeInteger(characterLimit) || characterLimit < 1) {
    throw new Error('Atom UI message character limit must be a positive safe integer');
  }
  if (text.length <= characterLimit) return text;
  if (characterLimit <= UI_TRUNCATION_MARKER.length) return UI_TRUNCATION_MARKER.slice(0, characterLimit);
  return `${text.slice(0, characterLimit - UI_TRUNCATION_MARKER.length)}${UI_TRUNCATION_MARKER}`;
}

/**
 * Streaming drafts fail closed instead of silently changing a transcript that
 * is still being assembled. Check widths before concatenating so an oversized
 * delta never creates an oversized intermediate string.
 */
export function appendBoundedAtomDraft(
  current: string,
  delta: string,
  characterLimit = ATOM_UI_MESSAGE_CHARACTER_LIMIT,
): string {
  if (!Number.isSafeInteger(characterLimit) || characterLimit < 1) {
    throw new Error('Atom streaming-draft character limit must be a positive safe integer');
  }
  if (current.length > characterLimit || delta.length > characterLimit - current.length) {
    throw new Error(`Realtime transcript exceeded the bounded ${characterLimit}-character presentation limit`);
  }
  return current + delta;
}

export function retainRecentAtomMessages(
  messages: AgentMessage[],
  limit = ATOM_UI_MESSAGE_LIMIT,
  characterLimit = ATOM_UI_MESSAGE_CHARACTER_LIMIT,
): AgentMessage[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Atom UI message limit must be a positive safe integer');
  if (!Number.isSafeInteger(characterLimit) || characterLimit < 1) throw new Error('Atom UI message character limit must be a positive safe integer');
  let bounded = messages;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const text = boundAtomUiMessageText(message.text, characterLimit);
    if (text === message.text) continue;
    if (bounded === messages) bounded = [...messages];
    bounded[index] = { ...message, text };
  }
  if (bounded.length <= limit) return bounded;

  // Keep in-flight rows addressable by their stream ID. Also keep the latest
  // user row because AtomAgentPanel uses its presence to suppress starter
  // prompts after a conversation has begun.
  const protectedIndexes = new Set<number>();
  let latestUserIndex = -1;
  for (let index = 0; index < bounded.length; index++) {
    const message = bounded[index]!;
    if (message.status === 'streaming') protectedIndexes.add(index);
    if (message.role === 'user') latestUserIndex = index;
  }
  if (latestUserIndex >= 0) protectedIndexes.add(latestUserIndex);

  const retained = new Set<number>();
  // The hook owns at most one assistant and one user stream. Choosing the most
  // recent protected rows also keeps this helper hard-bounded if malformed
  // input violates that invariant.
  for (const index of [...protectedIndexes].sort((left, right) => right - left).slice(0, limit)) retained.add(index);
  for (let index = bounded.length - 1; index >= 0 && retained.size < limit; index--) retained.add(index);

  return [...retained]
    .sort((left, right) => left - right)
    .map((index) => bounded[index]!);
}

export interface RealtimeToolCallIdentity {
  readonly callId: string;
  readonly arguments: string;
}

export class RealtimeCallIdLedger {
  readonly #callIds = new Set<string>();

  constructor(
    readonly limit = ATOM_REALTIME_CALL_ID_LIMIT,
    readonly characterLimit = ATOM_REALTIME_CALL_ID_CHARACTER_LIMIT,
    readonly argumentCharacterLimit = ATOM_REALTIME_CALL_ARGUMENT_CHARACTER_LIMIT,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Realtime call-ID limit must be a positive safe integer');
    if (!Number.isSafeInteger(characterLimit) || characterLimit < 1) throw new Error('Realtime call-ID character limit must be a positive safe integer');
    if (!Number.isSafeInteger(argumentCharacterLimit) || argumentCharacterLimit < 1) throw new Error('Realtime call-argument character limit must be a positive safe integer');
  }

  record(callId: string): void {
    this.recordAll([callId]);
  }

  recordAll(callIds: readonly string[]): void {
    const incoming = new Set<string>();
    for (const callId of callIds) {
      if (!callId.length) throw new Error('Realtime function call ID must be non-empty');
      if (callId.length > this.characterLimit) {
        throw new Error(`Realtime function call ID exceeded the bounded ${this.characterLimit}-character limit`);
      }
      if (this.#callIds.has(callId) || incoming.has(callId)) throw new Error(`Realtime repeated function call ${callId}`);
      incoming.add(callId);
    }
    if (this.#callIds.size + incoming.size > this.limit) {
      throw new Error(`Realtime conversation reached its bounded ${this.limit}-call replay ledger; start a new conversation`);
    }
    for (const callId of incoming) this.#callIds.add(callId);
  }

  /** Validates every variable-width field before atomically recording any ID. */
  recordCalls(calls: readonly RealtimeToolCallIdentity[]): void {
    for (const call of calls) {
      if (call.arguments.length > this.argumentCharacterLimit) {
        throw new Error(`Realtime function-call arguments exceeded the bounded ${this.argumentCharacterLimit}-character limit`);
      }
    }
    this.recordAll(calls.map((call) => call.callId));
  }

  reset(): void { this.#callIds.clear(); }

  get size(): number { return this.#callIds.size; }
}

export { RealtimeCallIdLedger as RealtimeVoiceCallIdLedger };
