/**
 * Send receipts for a single conversation.
 *
 * The honest chain is: the Host accepted the request, the Agent's input channel
 * accepted the bytes, and finally the Agent's own structured record contains the
 * prompt. Only the last of those proves the Agent received it.
 *
 * Confirmation is deliberately narrow. A record confirms a send only when it
 * was written after the byte offset captured before the write, and each record
 * satisfies at most one pending send. Without a provider-supplied request id
 * this is "a matching input was observed", not exactly-once delivery: two
 * identical prompts are matched oldest-first, which is a choice, not a proof.
 */

import type { AgentChatDelivery, AgentChatDeliveryState } from './types.js';

/** Matching stops after this long so a stale pending cannot claim a later turn. */
export const DELIVERY_OBSERVE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Rounding allowed when a record's own time is compared with a send's. The
 * Agent writes its record on the Host's machine, so both come from one clock.
 */
export const RECORD_TIME_SLACK_MS = 2_000;

const EXPIRED_REASON = '超过确认窗口仍未在 Agent 记录中看到这条输入，请在终端确认后再决定是否重发。';
const REWIND_REASON = 'Agent 的记录被轮转或截断，无法再确认这条输入，请在终端确认后再决定是否重发。';

export interface PendingSend {
  requestId: string;
  /** The connection that asked, so only its owner is told about the result. */
  clientId: number;
  /** Normalized prompt text, compared verbatim against the provider's record. */
  text: string;
  /** Transcript byte offset captured BEFORE the write. Records at or after
   *  this offset are candidates; anything earlier is pre-existing history. */
  cursor: number;
  createdAt: number;
  state: AgentChatDeliveryState;
}

/**
 * Trailing whitespace and line-ending style differ between what a composer
 * sends and what a provider records. Nothing else is normalized: a fuzzy or
 * substring match would confirm the wrong turn.
 */
export function normalizePrompt(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/** A receipt plus the one connection that asked for it. */
export interface DeliveryOutcome {
  clientId: number;
  delivery: AgentChatDelivery;
}

export class DeliveryTracker {
  private readonly pending = new Map<string, PendingSend>();
  private order: string[] = [];

  constructor(
    private readonly conversationId: string,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.pending.size;
  }

  accept(requestId: string, clientId: number, text: string, cursor: number): DeliveryOutcome {
    const send: PendingSend = {
      requestId,
      clientId,
      text: normalizePrompt(text),
      cursor,
      createdAt: this.now(),
      state: 'accepted',
    };
    this.pending.set(requestId, send);
    this.order.push(requestId);
    return this.event(send);
  }

  /** The input channel acknowledged the write. Not yet proof of receipt. */
  markDelivered(requestId: string): DeliveryOutcome | undefined {
    const send = this.pending.get(requestId);
    if (!send || send.state !== 'accepted') return undefined;
    send.state = 'delivered';
    return this.event(send);
  }

  /** The write was rejected before any bytes left the Host: resending is safe. */
  markFailed(requestId: string, error: string): DeliveryOutcome | undefined {
    const send = this.take(requestId);
    if (!send) return undefined;
    send.state = 'failed';
    return this.event(send, error);
  }

  /**
   * The write's outcome is unknown — the call threw or timed out after the
   * bytes may already have been queued. The client must not resend.
   */
  markUncertain(requestId: string, error: string): DeliveryOutcome | undefined {
    const send = this.take(requestId);
    if (!send) return undefined;
    send.state = 'uncertain';
    return this.event(send, error);
  }

  /**
   * Offer one decoded user-prompt record to the pending sends. Returns the
   * receipt for the single send it confirms, if any. Call it exactly once per
   * record, in file order.
   *
   * `recordedAt` is the record's own time, when it carries one. It matters where
   * the offset cannot tell old from new — a record read in a file that was first
   * found after the send — and a record written before the send is never it.
   */
  observe(offset: number, promptText: string, messageId: string, recordedAt?: number | null): DeliveryOutcome | undefined {
    const text = normalizePrompt(promptText);
    if (!text) return undefined;
    const deadline = this.now() - DELIVERY_OBSERVE_WINDOW_MS;
    for (const requestId of this.order) {
      const send = this.pending.get(requestId);
      if (!send) continue;
      if (send.createdAt < deadline) continue;
      if (offset < send.cursor) continue;
      if (typeof recordedAt === 'number' && recordedAt < send.createdAt - RECORD_TIME_SLACK_MS) continue;
      if (send.text !== text) continue;
      this.take(requestId);
      send.state = 'observed';
      const outcome = this.event(send);
      return { clientId: outcome.clientId, delivery: { ...outcome.delivery, messageId } };
    }
    return undefined;
  }

  /**
   * Close matchers whose window has passed. Losing the ability to confirm a send
   * is itself a result: the caller must report `uncertain` rather than leave a
   * client waiting forever on a receipt that can no longer arrive.
   */
  expire(): DeliveryOutcome[] {
    const deadline = this.now() - DELIVERY_OBSERVE_WINDOW_MS;
    const outcomes: DeliveryOutcome[] = [];
    for (const [requestId, send] of [...this.pending]) {
      if (send.createdAt >= deadline) continue;
      this.take(requestId);
      send.state = 'uncertain';
      outcomes.push(this.event(send, EXPIRED_REASON));
    }
    return outcomes;
  }

  /**
   * The transcript was re-read from the start (rotation or truncation), so the
   * captured offsets no longer address the same bytes. Matching would replay old
   * history against live sends, so every matcher is dropped — and, since each
   * dropped matcher was the only proof available, reported as `uncertain`.
   */
  resetForRewind(): DeliveryOutcome[] {
    return this.abandon(REWIND_REASON);
  }

  /**
   * Every matcher loses its proof at once, for the stated reason. The bytes may
   * well have reached the Agent, so each send is reported `uncertain` — never
   * `failed`, which would invite a resend that duplicates the task.
   */
  abandon(reason: string): DeliveryOutcome[] {
    const outcomes: DeliveryOutcome[] = [];
    for (const requestId of [...this.order]) {
      const send = this.take(requestId);
      if (!send) continue;
      send.state = 'uncertain';
      outcomes.push(this.event(send, reason));
    }
    this.pending.clear();
    this.order = [];
    return outcomes;
  }

  /** Forget a disconnected client's matchers; its receipts have nowhere to go. */
  dropClient(clientId: number): void {
    for (const [requestId, send] of this.pending) {
      if (send.clientId === clientId) this.take(requestId);
    }
  }

  private take(requestId: string): PendingSend | undefined {
    const send = this.pending.get(requestId);
    if (!send) return undefined;
    this.pending.delete(requestId);
    this.order = this.order.filter((id) => id !== requestId);
    return send;
  }

  private event(send: PendingSend, error?: string): DeliveryOutcome {
    return {
      clientId: send.clientId,
      delivery: {
        requestId: send.requestId,
        conversationId: this.conversationId,
        state: send.state,
        at: this.now(),
        ...(error ? { error } : {}),
      },
    };
  }
}
