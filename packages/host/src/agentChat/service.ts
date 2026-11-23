/**
 * The Host's Agent conversation service.
 *
 * It answers exactly three questions: which already-running Agents can be shown
 * as a conversation, what that conversation contains, and what happened to a
 * prompt the user sent. Everything else — pane lifecycle, focus, layout —
 * remains Herdr's. Opening a conversation must never move, restart or take over
 * a pane, so this module has no way to do any of those things.
 */

import {
  externalSessionCapabilities,
  NO_STRUCTURED_HISTORY,
  type AgentChatBinding,
  type AgentChatCapabilities,
  type AgentChatDelivery,
  type AgentChatMessage,
  type AgentChatProvider,
  type AgentChatStatus,
  type DeliveryOutcome,
} from '@termbridge/agent-chat';
import { WatchedConversation, type ConversationSubscriber } from './conversation.js';
import { isLocated, locateTranscript, type AgentSessionRef, type LocateResult } from './transcriptLocator.js';

/** How often a watched transcript is checked for appended records. */
export const POLL_INTERVAL_MS = 600;
/**
 * How long a "no structured record" verdict is trusted before it is re-checked.
 * Locating a transcript verifies the session id inside the file, so repeating it
 * for every pane on every list refresh would be real work for no new answer.
 */
export const AVAILABILITY_TTL_MS = 60_000;
/**
 * How often an unbound conversation looks for its record again. One exists only
 * while someone has a freshly started Agent open, and each look is a bounded
 * stat and directory read — often enough that the first reply appears promptly,
 * rarely enough that the 600 ms read loop does not become a directory scan.
 */
export const BIND_RETRY_MS = 2_000;

const NOT_AN_AGENT = '这个会话不是已识别的 Codex/Claude Agent。';
const UNCONFIRMABLE = '这个会话的对话记录不可用，无法再确认这条消息；请在终端确认后再决定是否重发。';

/** One Herdr pane as the Host understands it, with no Herdr types leaking in. */
export interface ConversationDescriptor {
  conversationId: string;
  paneId: string;
  /** Herdr's agent label, e.g. `codex` / `claude`. Unknown values are ignored. */
  agent?: string;
  providerSessionId?: string;
  sessionRef?: AgentSessionRef;
  workspace?: string;
  title?: string;
  cwd?: string;
  /** Herdr's own agent status string. */
  status: string;
}

/** The Host's side of the Agent's existing input channel. */
export interface AgentChatBackend {
  list(): Promise<ConversationDescriptor[]>;
  describe(conversationId: string): Promise<ConversationDescriptor | undefined>;
  /**
   * Deliver one complete prompt. Resolves only when the channel accepted it.
   * Rejecting with `AgentChatDeliveryUnknown` means the outcome is unknown and
   * the caller must not present it as either delivered or safe to resend.
   */
  deliver(conversationId: string, text: string): Promise<void>;
}

/** Thrown by a backend whose write may or may not have reached the Agent. */
export class AgentChatDeliveryUnknown extends Error {}

export interface AgentChatEventSink {
  snapshot(clientId: number, message: AgentChatSnapshotEvent): void;
  append(clientId: number, message: AgentChatAppendEvent): void;
  delivery(clientId: number, message: AgentChatDelivery & { generation: number }): void;
}

export interface AgentChatSnapshotEvent {
  requestId: string;
  conversationId: string;
  generation: number;
  binding?: AgentChatBinding;
  status: AgentChatStatus;
  capabilities: AgentChatCapabilities;
  messages: AgentChatMessage[];
  seq: number;
  earlierCursor?: number;
  error?: string;
}

export interface AgentChatAppendEvent {
  conversationId: string;
  generation: number;
  status: AgentChatStatus;
  capabilities: AgentChatCapabilities;
  messages: AgentChatMessage[];
  seq: number;
}

/** The answer to one `loadEarlier`, refused or fulfilled. */
export type EarlierPage =
  | { ok: true; messages: AgentChatMessage[]; cursor?: number; atHead: boolean }
  | { ok: false; error: string };

export interface AgentChatListEntry {
  conversationId: string;
  paneId: string;
  provider?: AgentChatProvider;
  title?: string;
  workspace?: string;
  status: string;
  /**
   * True when the conversation view can open: a structured transcript for this
   * exact session was found, or a recognized Agent has not written one yet and
   * nothing contradicts its identity. The latter opens empty and binds once the
   * record appears.
   */
  chat: boolean;
  /** Why chat is unavailable. Present only when `chat` is false. */
  reason?: string;
}

export interface AgentChatServiceOptions {
  hostId: string;
  backend: AgentChatBackend;
  sink: AgentChatEventSink;
  /** Overridable in tests. */
  home?: string;
  pollIntervalMs?: number;
  bindRetryMs?: number;
  recordOverdueMs?: number;
  log?: (message: string) => void;
}

/** Providers whose already-running sessions this build can read structurally. */
function providerOf(agent: string | undefined): AgentChatProvider | undefined {
  const name = agent?.toLowerCase();
  return name === 'codex' || name === 'claude' ? name : undefined;
}

export class AgentChatService {
  private readonly conversations = new Map<string, WatchedConversation>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly pollTails = new Map<string, Promise<void>>();
  /** Keyed by provider session id, so a pane that restarts is re-verified. */
  private readonly locations = new Map<string, { path?: string; reason?: string; pending?: boolean; at: number }>();
  /**
   * The in-flight subscribe each connection is currently running, if any.
   *
   * Subscribing awaits the filesystem, and the client may unsubscribe or drop
   * during that window. Without this the late half of the call would install
   * its subscriber anyway, silently handing back a grant the connection had
   * given up — and the subscription is what authorizes an image upload, so a
   * socket that is gone would still be able to write a file. Revoking marks the
   * token and forgets it, so the map only ever holds live attempts.
   */
  private readonly attempts = new Map<number, { revoked: boolean }>();
  /** When each unbound conversation last looked for its record. */
  private readonly bindCheckedAt = new WeakMap<WatchedConversation, number>();
  /**
   * The `degraded` notice each conversation's subscribers were last sent.
   * Capabilities only travel with a snapshot or an append, so a notice that
   * changes on its own — time passing — needs an append to carry it.
   */
  private readonly announced = new WeakMap<WatchedConversation, string | undefined>();

  constructor(private readonly options: AgentChatServiceOptions) {}

  /** Conversations the client may open, each with an honest availability flag. */
  async list(): Promise<AgentChatListEntry[]> {
    const descriptors = await this.options.backend.list();
    const entries: AgentChatListEntry[] = [];
    for (const descriptor of descriptors) {
      const provider = providerOf(descriptor.agent);
      if (!provider) {
        entries.push({
          conversationId: descriptor.conversationId,
          paneId: descriptor.paneId,
          title: descriptor.title,
          workspace: descriptor.workspace,
          status: descriptor.status,
          chat: false,
          reason: NOT_AN_AGENT,
        });
        continue;
      }
      // A watched conversation is open by definition, bound or still waiting.
      const located = this.conversations.has(descriptor.conversationId)
        ? undefined
        : await this.locate(descriptor, provider);
      const refused = located && !isLocated(located) && !located.pending ? located : undefined;
      entries.push({
        conversationId: descriptor.conversationId,
        paneId: descriptor.paneId,
        provider,
        title: descriptor.title,
        workspace: descriptor.workspace,
        status: descriptor.status,
        chat: !refused,
        ...(refused ? { reason: refused.reason } : {}),
      });
    }
    return entries;
  }

  /**
   * Bind one client to one conversation. A client that switches conversations
   * raises its own generation; every later event carries the generation it was
   * produced for, so a late event from the previous binding is discardable.
   */
  async subscribe(
    clientId: number,
    conversationId: string,
    generation: number,
    requestId: string,
  ): Promise<void> {
    this.unsubscribeOthers(clientId, conversationId);
    // A previous attempt from this same connection is superseded: its snapshot
    // would carry a generation the client has already moved past.
    const attempt = { revoked: false };
    this.revoke(clientId);
    this.attempts.set(clientId, attempt);
    const revoked = () => attempt.revoked;
    try {
      const descriptor = await this.options.backend.describe(conversationId);
      if (revoked()) return;
      const provider = providerOf(descriptor?.agent);
      if (!descriptor || !provider) {
        this.emitUnavailable(clientId, conversationId, generation, requestId, NOT_AN_AGENT);
        return;
      }

      let conversation = this.conversations.get(conversationId);
      if (!conversation) {
        // A user opening a conversation is a deliberate act: re-check rather than
        // trust a cached "unavailable", since a session that had written nothing
        // yet may have a record by now.
        const located = await this.locate(descriptor, provider, true);
        if (revoked()) return;
        // A record that is not written yet is no reason to refuse: a freshly
        // started Agent has had no turn, and the prompt that starts one can be
        // sent from here. Only a contradicted or unusable identity closes the view.
        if (!isLocated(located) && !located.pending) {
          this.emitUnavailable(clientId, conversationId, generation, requestId, located.reason);
          return;
        }
        // Another connection may have opened the same conversation while this
        // one was locating it. Overwriting the map here would strand the first
        // client's subscriber on an object nothing else reaches: it would stop
        // receiving appends and lose the grant its uploads depend on.
        conversation = this.conversations.get(conversationId);
        if (!conversation) {
          conversation = new WatchedConversation(
            bindingOf(this.options.hostId, descriptor, provider),
            isLocated(located) ? located.path : undefined,
            'loading',
            descriptor.status,
            undefined,
            this.options.recordOverdueMs,
          );
          this.conversations.set(conversationId, conversation);
          // It was just looked for; the next look waits its turn.
          if (!conversation.bound) this.bindCheckedAt.set(conversation, Date.now());
        }
      }
      conversation.applyHerdrStatus(descriptor.status);

      const subscriber: ConversationSubscriber = { clientId, generation, requestId };
      conversation.addSubscriber(subscriber);
      /**
       * Undo only what this attempt installed.
       *
       * Subscribers are keyed by connection, so a newer subscribe from the same
       * client overwrites this one, and a losing attempt that deleted by key
       * would take the newer subscription — with its upload grant and watcher —
       * out along with itself. Today every await is followed by a revocation
       * check that returns before a newer attempt can install anything, so this
       * is defence in depth rather than a reachable bug; it keeps the invariant
       * local instead of resting on that ordering argument surviving edits.
       */
      const withdraw = () => {
        if (conversation.subscriberFor(clientId) !== subscriber) return;
        conversation.removeSubscriber(clientId);
        this.releaseIfIdle(conversationId);
      };
      try {
        await conversation.open();
      } catch (error) {
        withdraw();
        if (!revoked()) this.emitUnavailable(clientId, conversationId, generation, requestId, readError(error));
        return;
      }
      // Opening the transcript is the last await, and the client may have gone in
      // the meantime. Take the subscriber back out rather than leave a grant
      // behind for a connection that already unsubscribed or disconnected.
      if (revoked()) {
        withdraw();
        return;
      }
      this.startWatching(conversationId);
      this.emitSnapshot(conversation, subscriber);
    } finally {
      // Only this attempt's own entry is cleared; a newer one has replaced it.
      if (this.attempts.get(clientId) === attempt) this.attempts.delete(clientId);
    }
  }

  unsubscribe(clientId: number, conversationId: string): void {
    // Revoke first: a subscribe still in flight for this client is cancelled by
    // the bump, whether or not it has reached a conversation yet.
    this.revoke(clientId);
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.removeSubscriber(clientId);
    this.releaseIfIdle(conversationId);
  }

  /** Cancels whatever subscribe this connection still has in flight. */
  private revoke(clientId: number): void {
    const attempt = this.attempts.get(clientId);
    if (!attempt) return;
    attempt.revoked = true;
    this.attempts.delete(clientId);
  }

  /**
   * Whether this connection currently holds a live subscription to this
   * conversation. It is the same grant the send path checks, so anything else
   * authorized by it can rely on the subscription having been accepted rather
   * than on the client naming an ID.
   */
  hasSubscriber(clientId: number, conversationId: string): boolean {
    return this.conversations.get(conversationId)?.subscriberFor(clientId) !== undefined;
  }

  /**
   * The generation this connection is subscribed on, or undefined.
   *
   * A control aimed at a conversation must name the subscription it was issued
   * under, so one that was queued before the user switched away cannot land on
   * whatever they are looking at now.
   */
  generationFor(clientId: number, conversationId: string): number | undefined {
    return this.conversations.get(conversationId)?.subscriberFor(clientId)?.generation;
  }

  /** Drop everything a disconnected connection held, releasing its watchers. */
  dropClient(clientId: number): void {
    this.revoke(clientId);
    for (const [conversationId, conversation] of [...this.conversations]) {
      if (!conversation.subscriberFor(clientId)) continue;
      conversation.removeSubscriber(clientId);
      this.releaseIfIdle(conversationId);
    }
  }

  /**
   * One page of history older than `cursor`, for this client's scroll-up.
   *
   * The request carries the generation it was made under, and the answer is
   * refused unless that is still the client's live subscription. A page fetched
   * for a conversation the user has since left — or for a subscription that was
   * released and re-taken — must never be written into the view they are on now.
   */
  async loadEarlier(
    clientId: number,
    conversationId: string,
    generation: number,
    cursor: number,
  ): Promise<EarlierPage> {
    const conversation = this.conversations.get(conversationId);
    const subscriber = conversation?.subscriberFor(clientId);
    if (!conversation || !subscriber) {
      return { ok: false, error: '这个连接没有订阅该会话。' };
    }
    if (subscriber.generation !== generation) {
      return { ok: false, error: '这个请求属于已经切换掉的会话视图，已忽略。' };
    }
    const page = await conversation.loadEarlier(cursor);
    return { ok: true, ...page };
  }

  /**
   * Send one prompt. The receipt chain is accepted → delivered → observed, and
   * an unknown write outcome stops at `uncertain`: the Host will not decide on
   * the user's behalf that a possibly-delivered task is safe to send twice.
   */
  async send(
    clientId: number,
    conversationId: string,
    requestId: string,
    text: string,
  ): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    const subscriber = conversation?.subscriberFor(clientId);
    if (!conversation || !subscriber) {
      this.options.sink.delivery(clientId, {
        requestId,
        conversationId,
        state: 'failed',
        at: Date.now(),
        generation: 0,
        error: '这个连接没有订阅该会话，发送已拒绝。',
      });
      return;
    }
    if (!conversation.capabilities().send) {
      this.emitDelivery(clientId, subscriber.generation, {
        requestId,
        conversationId,
        state: 'failed',
        at: Date.now(),
        error: conversation.capabilities().degraded ?? '当前不能向这个 Agent 发送消息。',
      });
      return;
    }

    // Captured before the write: only records appended after this offset can
    // confirm this prompt, which is what keeps an identical older turn out.
    const cursor = await conversation.sendCursor();
    const accepted = conversation.delivery.accept(requestId, clientId, text, cursor);
    this.emitDelivery(clientId, subscriber.generation, accepted.delivery);

    try {
      await this.options.backend.deliver(conversationId, text);
    } catch (error) {
      const unknown = error instanceof AgentChatDeliveryUnknown;
      // Bytes that may have landed can start an unbound Agent's first turn.
      if (unknown) conversation.noteUnboundSend();
      const outcome = unknown
        ? conversation.delivery.markUncertain(requestId, readError(error))
        : conversation.delivery.markFailed(requestId, readError(error));
      if (outcome) this.emitDelivery(clientId, subscriber.generation, outcome.delivery);
      return;
    }
    conversation.noteUnboundSend();
    const delivered = conversation.delivery.markDelivered(requestId);
    if (delivered) this.emitDelivery(clientId, subscriber.generation, delivered.delivery);
    // Read straight away so a fast Agent's own record can upgrade the receipt
    // to `observed` without the client waiting for the next polling tick.
    await this.poll(conversationId);
  }

  /** Release every watcher. Called when the Host shuts down. */
  stop(): void {
    for (const conversationId of [...this.timers.keys()]) this.stopWatching(conversationId);
    this.conversations.clear();
    this.locations.clear();
  }

  private async locate(
    descriptor: ConversationDescriptor,
    provider: AgentChatProvider,
    force = false,
  ): Promise<LocateResult> {
    if (!descriptor.providerSessionId) {
      // Herdr learns the session from the Agent's own hook, which a freshly
      // started Agent may not have fired yet. The pane has not said who it is,
      // which is not the same as having said something false.
      return { reason: '这个 Agent 还没有报告会话标识，无法绑定结构化记录。', pending: true };
    }
    const key = `${provider}:${descriptor.providerSessionId}`;
    const cached = this.locations.get(key);
    const now = Date.now();
    // A found path stays found; only the negative verdict expires, so a session
    // whose records appear later is picked up without re-verifying every pane.
    if (cached?.path) return { path: cached.path, provider };
    if (!force && cached && now - cached.at < AVAILABILITY_TTL_MS) {
      return { reason: cached.reason ?? NO_STRUCTURED_HISTORY, ...(cached.pending ? { pending: true as const } : {}) };
    }

    const located = await locateTranscript({
      provider,
      providerSessionId: descriptor.providerSessionId,
      sessionRef: descriptor.sessionRef,
      cwd: descriptor.cwd,
      ...(this.options.home ? { home: this.options.home } : {}),
    });
    this.locations.set(key, isLocated(located)
      ? { path: located.path, at: now }
      : { reason: located.reason, ...(located.pending ? { pending: true } : {}), at: now });
    return located;
  }

  /**
   * Look for an unbound conversation's record. Returns true once the
   * conversation has changed shape — bound, or closed — and every subscriber
   * has been sent the snapshot that says so.
   */
  private async bindPending(
    conversationId: string,
    conversation: WatchedConversation,
    descriptor: ConversationDescriptor,
  ): Promise<boolean> {
    const provider = providerOf(descriptor.agent);
    if (!provider) {
      // The Agent has left the pane. Whatever holds its input now is not an
      // Agent, and a prompt typed into a shell would run as a command.
      this.close(conversationId, conversation, NOT_AN_AGENT);
      return true;
    }
    const now = Date.now();
    if (now - (this.bindCheckedAt.get(conversation) ?? 0) < (this.options.bindRetryMs ?? BIND_RETRY_MS)) return false;
    this.bindCheckedAt.set(conversation, now);
    const located = await this.locate(descriptor, provider, true);
    // Released while the filesystem was being read: nobody is left to tell.
    if (this.conversations.get(conversationId) !== conversation) return true;
    if (!isLocated(located)) {
      if (located.pending) return false;
      this.close(conversationId, conversation, located.reason);
      return true;
    }
    const receipts = await conversation.bind(bindingOf(this.options.hostId, descriptor, provider), located.path);
    this.emitReceipts(conversation, receipts);
    // A snapshot, not an append: the client has been showing an empty page
    // under this same subscription, and the record replaces it wholesale.
    for (const subscriber of conversation.listSubscribers()) this.emitSnapshot(conversation, subscriber);
    return true;
  }

  /**
   * An unbound conversation turned out not to be openable after all. Each
   * subscriber hears it exactly as a refused subscribe would have told it, a
   * send still waiting is settled rather than dropped, and the watcher goes:
   * nothing it could read now would be this session's.
   */
  private close(conversationId: string, conversation: WatchedConversation, reason: string): void {
    this.emitReceipts(conversation, conversation.delivery.abandon(UNCONFIRMABLE));
    for (const subscriber of conversation.listSubscribers()) {
      this.emitUnavailable(subscriber.clientId, conversationId, subscriber.generation, subscriber.requestId, reason);
      conversation.removeSubscriber(subscriber.clientId);
    }
    this.releaseIfIdle(conversationId);
  }

  private unsubscribeOthers(clientId: number, keep: string): void {
    for (const [conversationId, conversation] of [...this.conversations]) {
      if (conversationId === keep || !conversation.subscriberFor(clientId)) continue;
      conversation.removeSubscriber(clientId);
      this.releaseIfIdle(conversationId);
    }
  }

  private releaseIfIdle(conversationId: string): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.subscriberCount > 0) return;
    this.stopWatching(conversationId);
    this.conversations.delete(conversationId);
  }

  private startWatching(conversationId: string): void {
    if (this.timers.has(conversationId)) return;
    const interval = this.options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const timer = setInterval(() => void this.poll(conversationId), interval);
    timer.unref?.();
    this.timers.set(conversationId, timer);
  }

  private stopWatching(conversationId: string): void {
    const timer = this.timers.get(conversationId);
    if (!timer) return;
    clearInterval(timer);
    this.timers.delete(conversationId);
  }

  /**
   * Read one conversation's new records. Overlapping calls are serialized
   * rather than dropped, so a caller that awaits this always sees the effect of
   * its own turn — a dropped pass would silently lose a send receipt.
   */
  poll(conversationId: string): Promise<void> {
    const previous = this.pollTails.get(conversationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.pollNow(conversationId));
    this.pollTails.set(conversationId, current);
    return current.finally(() => {
      if (this.pollTails.get(conversationId) === current) this.pollTails.delete(conversationId);
    });
  }

  private async pollNow(conversationId: string): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.subscriberCount === 0) return;
    try {
      const descriptor = await this.options.backend.describe(conversationId).catch(() => undefined);
      const statusChanged = descriptor ? conversation.applyHerdrStatus(descriptor.status) : false;
      // A send whose confirmation window closed is reported, not forgotten: a
      // dropped matcher would leave its client showing "sending" forever.
      this.emitReceipts(conversation, conversation.delivery.expire());
      if (!conversation.bound && descriptor && await this.bindPending(conversationId, conversation, descriptor)) return;
      const result = await conversation.poll();
      if (result.rewound) {
        this.emitReceipts(conversation, result.receipts);
        for (const subscriber of conversation.listSubscribers()) {
          this.emitSnapshot(conversation, subscriber);
        }
        return;
      }
      this.emitReceipts(conversation, result.receipts);
      const capabilities = conversation.capabilities();
      const noticeChanged = capabilities.degraded !== this.announced.get(conversation);
      if (result.appended.length === 0 && !statusChanged && !noticeChanged) return;
      this.announced.set(conversation, capabilities.degraded);
      for (const subscriber of conversation.listSubscribers()) {
        this.options.sink.append(subscriber.clientId, {
          conversationId,
          generation: subscriber.generation,
          status: conversation.currentStatus,
          capabilities,
          messages: result.appended,
          seq: conversation.highestSeq,
        });
      }
    } catch (error) {
      this.options.log?.(`[host] agent chat poll failed for ${conversationId}: ${readError(error)}`);
    }
  }

  private emitReceipts(conversation: WatchedConversation, receipts: readonly DeliveryOutcome[]): void {
    for (const receipt of receipts) {
      const subscriber = conversation.subscriberFor(receipt.clientId);
      if (subscriber) this.emitDelivery(receipt.clientId, subscriber.generation, receipt.delivery);
    }
  }

  private emitSnapshot(conversation: WatchedConversation, subscriber: ConversationSubscriber): void {
    const capabilities = conversation.capabilities();
    this.announced.set(conversation, capabilities.degraded);
    this.options.sink.snapshot(subscriber.clientId, {
      requestId: subscriber.requestId,
      conversationId: conversation.binding.conversationId,
      generation: subscriber.generation,
      binding: conversation.binding,
      status: conversation.currentStatus,
      capabilities,
      messages: conversation.messages,
      seq: conversation.highestSeq,
      ...(conversation.earlierCursor !== undefined ? { earlierCursor: conversation.earlierCursor } : {}),
    });
  }

  private emitUnavailable(
    clientId: number,
    conversationId: string,
    generation: number,
    requestId: string,
    reason: string,
  ): void {
    this.options.sink.snapshot(clientId, {
      requestId,
      conversationId,
      generation,
      status: 'unavailable',
      capabilities: externalSessionCapabilities({
        provider: 'claude',
        history: false,
        send: false,
        degraded: reason || NO_STRUCTURED_HISTORY,
      }),
      messages: [],
      seq: 0,
      error: reason || NO_STRUCTURED_HISTORY,
    });
  }

  private emitDelivery(clientId: number, generation: number, delivery: AgentChatDelivery): void {
    this.options.sink.delivery(clientId, { ...delivery, generation });
  }
}

function bindingOf(
  hostId: string,
  descriptor: ConversationDescriptor,
  provider: AgentChatProvider,
): AgentChatBinding {
  return {
    hostId,
    conversationId: descriptor.conversationId,
    provider,
    providerSessionId: descriptor.providerSessionId ?? '',
    owner: 'external',
    paneId: descriptor.paneId,
    ...(descriptor.workspace ? { workspace: descriptor.workspace } : {}),
    ...(descriptor.title ? { title: descriptor.title } : {}),
    ...(descriptor.cwd ? { cwd: descriptor.cwd } : {}),
  };
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
