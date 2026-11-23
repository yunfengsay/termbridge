/**
 * Host wiring for the graphical Agent conversation.
 *
 * This file is the only place the conversation service meets Herdr and the
 * wire. The Host entry point registers it and forwards control messages; it
 * does not learn anything about transcript formats or provider layouts.
 */

import { encodeControl, type AgentChatKey, type ControlMessage } from '@termbridge/protocol';
import { pasteAndSubmit, type HerdrBridge, type HerdrSession } from '../herdr.js';
import {
  AgentChatDeliveryUnknown,
  AgentChatService,
  type AgentChatBackend,
  type ConversationDescriptor,
} from './service.js';

/** The control messages this router owns. */
const HANDLED = new Set([
  'agent_chat_list',
  'agent_chat_subscribe',
  'agent_chat_unsubscribe',
  'agent_chat_earlier',
  'agent_chat_send',
  'agent_chat_key',
]);

/**
 * What each named key actually writes.
 *
 * The Host owns this table, so a client naming a key can never turn into a
 * client sending bytes. Written raw — no bracketed paste, no trailing return —
 * because a key is not a prompt: wrapping it would submit the pane's current
 * line as a side effect.
 */
const NAMED_KEY_BYTES: Record<string, string> = {
  escape: '\u001b',
  tab: '\t',
  enter: '\r',
  backspace: '\u007f',
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  left: '\u001b[D',
  home: '\u001b[H',
  end: '\u001b[F',
  'alt-enter': '\u001b\r',
  'alt-backspace': '\u001b\u007f',
};

/**
 * Resolves a named key to the bytes a terminal expects.
 *
 * `ctrl-<letter>` is the control code for that letter; `alt-<letter>` is escape
 * followed by it — the same meanings the Terminal's own modifier buttons have.
 * Derived here rather than sent by the client, so naming a key can never become
 * sending an arbitrary sequence.
 */
function keyBytes(key: AgentChatKey): string | undefined {
  const named = NAMED_KEY_BYTES[key];
  if (named !== undefined) return named;
  const ctrl = /^ctrl-([a-z])$/.exec(key);
  if (ctrl) return String.fromCharCode(ctrl[1]!.toUpperCase().charCodeAt(0) - 64);
  const alt = /^alt-([a-z])$/.exec(key);
  if (alt) return `\u001b${alt[1]}`;
  return undefined;
}

export interface AgentChatRouterOptions {
  hostId: string;
  herdr: HerdrBridge;
  send(clientId: number, frame: Buffer): void;
  log?: (message: string) => void;
}

export interface AgentChatRouter {
  /** Returns true when the message was this router's to handle. */
  handle(clientId: number, msg: ControlMessage): Promise<boolean>;
  dropClient(clientId: number): void;
  /**
   * Whether this connection currently holds a subscription to this conversation.
   *
   * The chat view is the only way a client holds a session it has not attached,
   * so anything else that must check "may this socket act on this session"
   * — an image upload, for one — asks here instead of trusting the ID it was
   * handed.
   */
  hasSubscriber(clientId: number, conversationId: string): boolean;
  stop(): void;
}

/**
 * Herdr's status only changes when its snapshot is re-read. The Host already
 * refreshes on its own cadence; this shorter floor keeps a watched conversation's
 * "Agent 正在处理" honest without turning the 600 ms read loop into 600 ms of
 * socket traffic.
 */
const STATUS_REFRESH_FLOOR_MS = 2_000;

export function createAgentChatRouter(options: AgentChatRouterOptions): AgentChatRouter {
  const { herdr, send } = options;
  let refreshedAt = 0;
  let refreshing: Promise<void> | undefined;

  /** Refresh at most once per floor, sharing one call across conversations. */
  function refreshStatus(): Promise<void> {
    if (Date.now() - refreshedAt < STATUS_REFRESH_FLOOR_MS) return Promise.resolve();
    refreshing ??= herdr.refresh()
      .then(() => undefined, () => undefined)
      .finally(() => { refreshedAt = Date.now(); refreshing = undefined; });
    return refreshing;
  }

  const backend: AgentChatBackend = {
    async list() {
      // Herdr's snapshot is the authority for which panes exist at all.
      try {
        await herdr.refresh();
        refreshedAt = Date.now();
      } catch {
        // A stale snapshot still lists real panes; availability is per-entry.
      }
      return [...herdr.sessions.values()].map(describeSession);
    },
    async describe(conversationId) {
      await refreshStatus();
      const session = herdr.sessions.get(conversationId);
      return session ? describeSession(session) : undefined;
    },
    async deliver(conversationId, text) {
      const session = herdr.sessions.get(conversationId);
      if (!session) throw new Error('这个会话已经不在 Herdr 中。');
      try {
        // The same bracketed-paste-then-submit the Terminal composer uses, so a
        // multi-line prompt arrives as one message and is submitted exactly once.
        await herdr.write(session, pasteAndSubmit(text), 'agent-chat');
      } catch (error) {
        // Herdr accepted the connection but did not confirm the write, so the
        // bytes may already be in the pane. Saying "failed" here would invite a
        // resend that duplicates the task.
        throw new AgentChatDeliveryUnknown(readError(error));
      }
    },
  };

  const service = new AgentChatService({
    hostId: options.hostId,
    backend,
    log: options.log,
    sink: {
      snapshot: (clientId, event) => send(clientId, encodeControl({
        t: 'agent_chat_snapshot',
        requestId: event.requestId,
        conversationId: event.conversationId,
        generation: event.generation,
        ...(event.binding ? { binding: event.binding } : {}),
        status: event.status,
        capabilities: event.capabilities,
        messages: event.messages,
        seq: event.seq,
        ...(event.earlierCursor !== undefined ? { earlierCursor: event.earlierCursor } : {}),
        ...(event.error ? { error: event.error } : {}),
      })),
      append: (clientId, event) => send(clientId, encodeControl({
        t: 'agent_chat_append',
        conversationId: event.conversationId,
        generation: event.generation,
        status: event.status,
        capabilities: event.capabilities,
        messages: event.messages,
        seq: event.seq,
      })),
      delivery: (clientId, event) => send(clientId, encodeControl({
        t: 'agent_chat_delivery',
        requestId: event.requestId,
        conversationId: event.conversationId,
        generation: event.generation,
        state: event.state,
        at: event.at,
        ...(event.messageId ? { messageId: event.messageId } : {}),
        ...(event.error ? { error: event.error } : {}),
      })),
    },
  });

  return {
    async handle(clientId, msg) {
      if (!HANDLED.has(msg.t)) return false;
      switch (msg.t) {
        case 'agent_chat_list': {
          const conversations = await service.list();
          send(clientId, encodeControl({
            t: 'agent_chat_list_result',
            requestId: msg.requestId,
            conversations,
          }));
          return true;
        }
        case 'agent_chat_subscribe':
          await service.subscribe(clientId, msg.conversationId, msg.generation, msg.requestId);
          return true;
        case 'agent_chat_unsubscribe':
          service.unsubscribe(clientId, msg.conversationId);
          return true;
        case 'agent_chat_earlier': {
          const page = await service.loadEarlier(clientId, msg.conversationId, msg.generation, msg.cursor);
          // The request's own generation is echoed, never the current one: a
          // client that has moved on discards this by the same rule it uses for
          // every other event, instead of showing an error it no longer cares about.
          send(clientId, encodeControl(page.ok
            ? {
              t: 'agent_chat_earlier_result',
              requestId: msg.requestId,
              conversationId: msg.conversationId,
              generation: msg.generation,
              messages: page.messages,
              ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
              atHead: page.atHead,
            }
            : {
              t: 'agent_chat_earlier_result',
              requestId: msg.requestId,
              conversationId: msg.conversationId,
              generation: msg.generation,
              messages: [],
              atHead: true,
              error: page.error,
            }));
          return true;
        }
        case 'agent_chat_send':
          await service.send(clientId, msg.conversationId, msg.requestId, msg.text);
          return true;
        case 'agent_chat_key': {
          // Authorized exactly like a send: this connection must hold a live
          // subscription to this conversation, on the generation it claims.
          const reply = (ok: boolean, error?: string) => send(clientId, encodeControl({
            t: 'agent_chat_key_result', requestId: msg.requestId, conversationId: msg.conversationId,
            generation: msg.generation, ok, ...(error ? { error } : {}),
          }));
          const allowed = service.hasSubscriber(clientId, msg.conversationId)
            && service.generationFor(clientId, msg.conversationId) === msg.generation;
          if (!allowed) { reply(false, '这个会话当前没有有效订阅。'); return true; }
          const session = herdr.sessions.get(msg.conversationId);
          const bytes = keyBytes(msg.key);
          if (!session || bytes === undefined) {
            reply(false, session ? '不支持这个按键。' : '这个会话已经不在 Herdr 中。');
            return true;
          }
          try {
            await herdr.write(session, Buffer.from(bytes, 'utf8'), 'agent-chat-key');
            reply(true);
          } catch (error) {
            // A key is not resent on its own: the user presses it again if they
            // decide it did not land.
            reply(false, readError(error));
          }
          return true;
        }
        default:
          return false;
      }
    },
    dropClient: (clientId) => service.dropClient(clientId),
    /** The chat view's own grant on a conversation, for callers outside this router. */
    hasSubscriber: (clientId: number, conversationId: string) => service.hasSubscriber(clientId, conversationId),
    stop: () => service.stop(),
  };
}

function describeSession(session: HerdrSession): ConversationDescriptor {
  return {
    conversationId: session.id,
    paneId: session.paneId,
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.agentSessionId ? { providerSessionId: session.agentSessionId } : {}),
    ...(session.agentSessionRef ? { sessionRef: session.agentSessionRef } : {}),
    ...(session.workspace ? { workspace: session.workspace } : {}),
    ...(session.name ? { title: session.name } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    status: session.status,
  };
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
