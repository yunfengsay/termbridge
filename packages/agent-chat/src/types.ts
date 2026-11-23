/**
 * The cross-platform Agent conversation contract.
 *
 * Portions of the block/message model are adapted from Orca
 * (https://github.com/stablyai/orca) at revision
 * 55b33920180efa188a19dfb7fac0fc993f10a922, files
 * `src/shared/native-chat-types.ts` and `src/shared/native-chat-merge.ts`.
 * Copyright (c) 2026 Lovecast Inc. — MIT. See THIRD_PARTY_NOTICES.md.
 *
 * Everything here must survive msgpack: plain JSON only, no class instances,
 * Maps or Dates. Nothing in this file may reach for the filesystem, a provider
 * credential or a shell — adapters own those and hand this module plain data.
 */

/** Providers whose already-running sessions this batch can read structurally. */
export const AGENT_CHAT_PROVIDERS = ['codex', 'claude'] as const;
export type AgentChatProvider = (typeof AGENT_CHAT_PROVIDERS)[number];

/**
 * Who owns the Agent process. `external` is a session Herdr already runs — TB
 * only observes its records and sends through Herdr's existing input channel.
 * `managed` is reserved for a future TB-created run and is not implemented.
 */
export const AGENT_CHAT_OWNERS = ['external', 'managed'] as const;
export type AgentChatOwner = (typeof AGENT_CHAT_OWNERS)[number];

/**
 * Identity of one conversation. Every field is authoritative: a binding is
 * built from Herdr's own snapshot, never guessed from cwd, title or "most
 * recent file".
 */
export interface AgentChatBinding {
  /** The Host that owns the Agent. Clients keep their own active-Host choice. */
  hostId: string;
  /** Stable TB conversation id. For external sessions this is the TB session id. */
  conversationId: string;
  provider: AgentChatProvider;
  /** The provider's own session id, as the Agent runtime reports it. */
  providerSessionId: string;
  owner: AgentChatOwner;
  /** Exact Herdr pane. Present for every `external` conversation. */
  paneId?: string;
  workspace?: string;
  title?: string;
  cwd?: string;
}

/** Where a message came from. Only structured records are trusted in batch 1. */
export const AGENT_CHAT_SOURCES = ['transcript', 'local'] as const;
export type AgentChatSource = (typeof AGENT_CHAT_SOURCES)[number];

/**
 * Higher wins when two sources describe the same message id. `local` is the
 * client's own optimistic echo of a send; the provider's record replaces it.
 */
export const AGENT_CHAT_SOURCE_PRIORITY: Record<AgentChatSource, number> = {
  transcript: 2,
  local: 1,
};

/**
 * Model-internal reasoning is deliberately absent. The product contract limits
 * a message to prose, tool activity, attachments and explicit asks; a provider's
 * private thinking is neither shown nor put on the wire.
 */
export const AGENT_CHAT_ROLES = ['user', 'assistant', 'tool', 'system'] as const;
export type AgentChatRole = (typeof AGENT_CHAT_ROLES)[number];

/** Prose or Markdown: an assistant body, a user prompt, a reasoning summary. */
export interface AgentChatTextBlock {
  type: 'text';
  text: string;
}

/** A tool invocation. `input` is a bounded preview string, never a live handle. */
export interface AgentChatToolCallBlock {
  type: 'tool-call';
  name: string;
  /** Already-serialized, already-truncated argument preview. */
  input: string;
  /** Provider identity within its own item stream, when it supplies one. */
  callId?: string;
  /** True when the preview was cut to the wire budget. */
  truncated?: boolean;
}

/** The result the provider recorded for a prior tool call. */
export interface AgentChatToolResultBlock {
  type: 'tool-result';
  output: string;
  isError?: boolean;
  callId?: string;
  truncated?: boolean;
}

/**
 * An image the provider recorded. `name` is display-only. No Host path ever
 * travels here: a remote device cannot open one, and it leaks the filesystem.
 */
export interface AgentChatImageRefBlock {
  type: 'image-ref';
  /** Present only for an http(s) URL the provider itself recorded. */
  url?: string;
  name?: string;
  alt?: string;
}

export type AgentChatBlock =
  | AgentChatTextBlock
  | AgentChatToolCallBlock
  | AgentChatToolResultBlock
  | AgentChatImageRefBlock;

export interface AgentChatMessage {
  /** Stable across re-reads and reconnects, so both ends dedup by it. */
  id: string;
  role: AgentChatRole;
  blocks: AgentChatBlock[];
  /** Epoch ms, or null when the record carried none. Null sorts first. */
  timestamp: number | null;
  source: AgentChatSource;
  /** Monotonic per conversation. Assigned by the Host, never by a client. */
  seq: number;
  /** Provider turn key when the record supplies one. */
  turnId?: string;
}

/** The provider-authored interrupt row both decoders emit. */
export const AGENT_CHAT_INTERRUPTED_TEXT = 'Conversation interrupted';

/**
 * What the bound adapter can actually do. A client disables a control whose
 * capability is false and shows `degraded` verbatim; it never infers ability
 * from the Agent's on-screen text.
 */
export interface AgentChatCapabilities {
  /** Structured history is readable for this conversation. */
  history: boolean;
  /** The composer can deliver text to the Agent. */
  send: boolean;
  /** Interrupting the current turn is a real, distinct action. */
  stop: boolean;
  /** Attachments can be submitted through the adapter. */
  attachments: boolean;
  /** Opaque file uploads, beyond the original image-only protocol. */
  fileAttachments?: boolean;
  /** Structured approvals exist and can be answered by id. */
  approvals: boolean;
  /** Structured questions exist and can be answered by id. */
  questions: boolean;
  /** Terminal remains reachable for this conversation. */
  terminal: boolean;
  /** Human-readable reason shown when a capability is missing. */
  degraded?: string;
}

export const AGENT_CHAT_STATUSES = ['loading', 'ready', 'working', 'empty', 'unavailable'] as const;
export type AgentChatStatus = (typeof AGENT_CHAT_STATUSES)[number];

/** The opening snapshot for one subscription. */
export interface AgentChatSnapshot {
  binding: AgentChatBinding;
  status: AgentChatStatus;
  capabilities: AgentChatCapabilities;
  messages: AgentChatMessage[];
  /** Highest seq in `messages`; the resume point for appends. */
  seq: number;
  /** Cursor for `loadEarlier`; absent when the head of history was reached. */
  earlierCursor?: string;
  /** Present when status is `unavailable`. */
  error?: string;
}

/**
 * Send lifecycle. These are observations, not optimism:
 *  - `accepted`  the Host validated the request and owns it
 *  - `delivered` the Agent's input channel accepted the bytes
 *  - `observed`  the Agent's own structured record now contains this prompt
 *  - `uncertain` delivery could not be confirmed; the client must not resend
 *  - `failed`    the Host or the input channel rejected it
 */
export const AGENT_CHAT_DELIVERY_STATES = [
  'accepted',
  'delivered',
  'observed',
  'uncertain',
  'failed',
] as const;
export type AgentChatDeliveryState = (typeof AGENT_CHAT_DELIVERY_STATES)[number];

export interface AgentChatDelivery {
  requestId: string;
  conversationId: string;
  state: AgentChatDeliveryState;
  at: number;
  /** Set once the prompt is matched in the transcript. */
  messageId?: string;
  /** Why the send failed, or why delivery cannot be confirmed. */
  error?: string;
}

/** True when a delivery state can no longer change. */
export function isTerminalDelivery(state: AgentChatDeliveryState): boolean {
  return state === 'observed' || state === 'failed' || state === 'uncertain';
}

/**
 * A resend would create a duplicate task unless the Host proved the first
 * attempt never reached the Agent. Only an outright rejection is safe.
 */
export function mayResend(delivery: AgentChatDelivery): boolean {
  return delivery.state === 'failed';
}
