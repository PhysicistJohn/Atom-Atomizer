import {
  ATOM_AGENT_MODEL,
  ATOM_AGENT_REASONING_EFFORT,
  ATOM_AGENT_VOICE,
  createAtomRealtimeCallBootstrapConfig,
  createAtomRealtimeVoiceSessionConfig,
  type AgentStatus,
  type AgentTurnRequest,
  type AgentTurnResult
} from '@tinysa/agent';
import { RealtimeTextSession, type RealtimeSocketFactory } from './realtime-text.js';

const OPENAI_API = 'https://api.openai.com/v1';
const MAX_SDP_BYTES = 256_000;
const MAX_TEXT_CONVERSATIONS = 4;
const TEXT_CONVERSATION_IDLE_MS = 5 * 60_000;

interface RealtimeConversationEntry {
  session: RealtimeTextSession;
  expiry: ReturnType<typeof setTimeout>;
}

/** Trusted, exact-model OpenAI boundary. There is deliberately no fallback path. */
export class OpenAiGateway {
  readonly #socketFactory: RealtimeSocketFactory | undefined;
  readonly #realtimeConversations = new Map<string, RealtimeConversationEntry>();
  readonly #realtimeTextSessions = new Set<RealtimeTextSession>();
  #reservedTextSessionSlots = 0;

  constructor(options: { socketFactory?: RealtimeSocketFactory } = {}) {
    this.#socketFactory = options.socketFactory;
  }

  #key(): string | undefined {
    return process.env.OPENAI_KEY?.trim() || undefined;
  }

  status(): AgentStatus {
    const configured = Boolean(this.#key());
    return {
      configured,
      model: ATOM_AGENT_MODEL,
      voice: ATOM_AGENT_VOICE,
      reasoningEffort: ATOM_AGENT_REASONING_EFFORT,
      textAgent: configured,
      realtime: configured,
      textTransport: 'realtime-websocket'
    };
  }

  async createRealtimeCall(sdp: string): Promise<string> {
    const key = this.#requireKey();
    if (!sdp.startsWith('v=0') || Buffer.byteLength(sdp) > MAX_SDP_BYTES) {
      throw new Error('Invalid or oversized WebRTC session description');
    }
    const form = new FormData();
    form.set('sdp', sdp);
    form.set('session', JSON.stringify(createAtomRealtimeCallBootstrapConfig()));
    const response = await fetch(`${OPENAI_API}/realtime/calls`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form
    });
    const answer = await response.text();
    if (!response.ok) throw apiError('Realtime session', response, answer);
    if (!answer.startsWith('v=0')) throw new Error('OpenAI returned an invalid WebRTC answer');
    return answer;
  }

  /** Text, tools and screenshots use one trusted Realtime WebSocket path. */
  async agentTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.#requireKey();

    if (request.conversationId) {
      const entry = this.#realtimeConversations.get(request.conversationId);
      if (!entry) throw new Error('Atom conversation is unavailable; the request was not retried or rerouted');
      return this.#realtimeTurn(request, entry.session);
    }
    if (request.toolOutputs?.length) {
      throw new Error('Atom tool results require the active conversation; the request was not retried or rerouted');
    }
    if (!request.prompt?.trim()) throw new Error('A prompt is required');
    return this.#realtimeTurn(request);
  }

  close(): void {
    for (const entry of this.#realtimeConversations.values()) clearTimeout(entry.expiry);
    this.#realtimeConversations.clear();
    const sessions = [...this.#realtimeTextSessions];
    this.#realtimeTextSessions.clear();
    this.#reservedTextSessionSlots = 0;
    for (const session of sessions) session.close();
  }

  async #realtimeTurn(request: AgentTurnRequest, existing?: RealtimeTextSession): Promise<AgentTurnResult> {
    if (request.conversationId) this.#releaseConversationId(request.conversationId, false);
    const session = existing ?? this.#createTextSession();
    try {
      const result = await session.turn(request);
      this.#storeConversation(result.conversationId, session);
      return result;
    } catch (error) {
      this.#releaseTextSession(session);
      throw error;
    }
  }

  #storeConversation(conversationId: string, session: RealtimeTextSession): void {
    const existing = this.#realtimeConversations.get(conversationId);
    if (existing && existing.session !== session) {
      throw new Error('Realtime text response reused an active conversation ID');
    }
    if (existing) clearTimeout(existing.expiry);
    const expiry = setTimeout(() => {
      const entry = this.#realtimeConversations.get(conversationId);
      if (entry?.session !== session) return;
      this.#realtimeConversations.delete(conversationId);
      this.#releaseTextSession(session);
    }, TEXT_CONVERSATION_IDLE_MS);
    expiry.unref?.();
    this.#realtimeConversations.set(conversationId, { session, expiry });
  }

  #releaseConversationId(conversationId: string, close: boolean): void {
    const entry = this.#realtimeConversations.get(conversationId);
    if (!entry) return;
    clearTimeout(entry.expiry);
    this.#realtimeConversations.delete(conversationId);
    if (close) this.#releaseTextSession(entry.session);
  }

  #createTextSession(): RealtimeTextSession {
    this.#reserveTextSessionSlot();
    try {
      const session = new RealtimeTextSession(this.#requireKey(), this.#socketFactory);
      this.#realtimeTextSessions.add(session);
      return session;
    } catch (error) {
      this.#releaseTextSessionSlot();
      throw error;
    }
  }

  #reserveTextSessionSlot(): void {
    while (this.#reservedTextSessionSlots >= MAX_TEXT_CONVERSATIONS) {
      const oldest = this.#realtimeConversations.keys().next().value as string | undefined;
      if (!oldest) {
        throw new Error(`Atom text conversation capacity of ${MAX_TEXT_CONVERSATIONS} is occupied by in-flight sessions`);
      }
      this.#releaseConversationId(oldest, true);
    }
    // Reserve synchronously before constructing the socket. This remains safe
    // even if a test socket factory or future adapter re-enters the gateway.
    this.#reservedTextSessionSlots += 1;
  }

  #releaseTextSession(session: RealtimeTextSession): void {
    if (!this.#realtimeTextSessions.delete(session)) return;
    this.#releaseTextSessionSlot();
    session.close();
  }

  #releaseTextSessionSlot(): void {
    if (this.#reservedTextSessionSlots < 1) throw new Error('Atom text conversation capacity accounting underflow');
    this.#reservedTextSessionSlots -= 1;
  }

  #requireKey(): string {
    const key = this.#key();
    if (!key) throw new Error('OPENAI_KEY is not configured in the trusted Electron process');
    return key;
  }
}

function apiError(operation: string, response: Response, raw: string): Error {
  let detail = '';
  try {
    const value = JSON.parse(raw) as { error?: { message?: unknown } };
    if (typeof value.error?.message === 'string') detail = safeApiMessage(value.error.message);
  } catch { /* Avoid returning HTML or opaque response bodies. */ }
  const requestId = response.headers.get('x-request-id')?.trim();
  return new Error(`${operation} failed (${response.status})${requestId ? ` [request ${safeApiMessage(requestId)}]` : ''}${detail ? `: ${detail}` : ''}`);
}

function safeApiMessage(message: string): string {
  return message.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}
