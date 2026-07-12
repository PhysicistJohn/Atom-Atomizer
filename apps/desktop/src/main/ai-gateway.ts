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
const MAX_CONTEXT_CHARS = 80_000;
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
    if (request.applicationContext.length > MAX_CONTEXT_CHARS) throw new Error('Application context is too large');

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
    for (const entry of this.#realtimeConversations.values()) {
      clearTimeout(entry.expiry);
      entry.session.close();
    }
    this.#realtimeConversations.clear();
  }

  async #realtimeTurn(request: AgentTurnRequest, existing?: RealtimeTextSession): Promise<AgentTurnResult> {
    if (request.conversationId) this.#releaseConversationId(request.conversationId, false);
    const session = existing ?? new RealtimeTextSession(this.#requireKey(), this.#socketFactory);
    if (!existing) this.#makeConversationCapacity();
    try {
      const result = await session.turn(request);
      this.#storeConversation(result.conversationId, session);
      return result;
    } catch (error) {
      session.close();
      throw error;
    }
  }

  #storeConversation(conversationId: string, session: RealtimeTextSession): void {
    const expiry = setTimeout(() => {
      const entry = this.#realtimeConversations.get(conversationId);
      if (entry?.session !== session) return;
      this.#realtimeConversations.delete(conversationId);
      session.close();
    }, TEXT_CONVERSATION_IDLE_MS);
    expiry.unref?.();
    this.#realtimeConversations.set(conversationId, { session, expiry });
  }

  #releaseConversationId(conversationId: string, close: boolean): void {
    const entry = this.#realtimeConversations.get(conversationId);
    if (!entry) return;
    clearTimeout(entry.expiry);
    this.#realtimeConversations.delete(conversationId);
    if (close) entry.session.close();
  }

  #makeConversationCapacity(): void {
    while (this.#realtimeConversations.size >= MAX_TEXT_CONVERSATIONS) {
      const oldest = this.#realtimeConversations.keys().next().value as string | undefined;
      if (!oldest) return;
      this.#releaseConversationId(oldest, true);
    }
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
