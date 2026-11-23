/**
 * One watched conversation: its located transcript, its decoded window, its
 * subscribers and its pending send receipts.
 *
 * The watcher exists only while someone is subscribed, reads only the bytes
 * appended since its last pass, and rebuilds from scratch when the file shrinks
 * under it. Nothing here scrapes a terminal screen: a conversation with no
 * readable structured record is reported unavailable rather than approximated.
 *
 * A recognized Agent that has not written its record yet — one that was just
 * started and has had no turn — is watched unbound: it shows no messages, takes
 * a prompt through the same input channel, and binds to its record once the
 * Agent's own identity leads to it.
 */

import {
  DeliveryTracker,
  appendAgentChatMessages,
  boundAgentChatWindow,
  createAgentChatMerger,
  decoderFor,
  externalSessionCapabilities,
  replaceAgentChatList,
  type AgentChatBinding,
  type AgentChatCapabilities,
  type AgentChatMessage,
  type AgentChatStatus,
  type DeliveryOutcome,
  type TranscriptDecoder,
} from '@termbridge/agent-chat';
import { stat } from 'node:fs/promises';
import {
  createTranscriptCursor,
  readTranscriptRange,
  readTranscriptSince,
  type TranscriptCursor,
  type TranscriptLine,
} from './incrementalReader.js';

/**
 * How long a conversation keeps reading as "working" after the last sign of
 * activity. Herdr reports a streaming Agent as working and done in alternation,
 * and new records only arrive in bursts, so without this the label would flicker
 * several times during one reply. The latch says "recently active", which is
 * what the reported facts actually support.
 */
export const WORKING_LATCH_MS = 4_000;

/** Bytes of history opened with a conversation, and per `loadEarlier` page. */
export const HISTORY_WINDOW_BYTES = 384 * 1024;
/** Messages a client is asked to hold. Older ones stay behind `loadEarlier`. */
export const HISTORY_WINDOW_MESSAGES = 200;

/**
 * How long a prompt sent before the record exists may go unanswered by one
 * before the view says so. A Claude record appears with the first turn, and a
 * Codex one once the Agent reports its session to Herdr; until then an empty
 * page is simply the truth, and a warning would only be noise.
 */
export const RECORD_OVERDUE_MS = 20_000;
export const RECORD_OVERDUE = '消息已送到 Agent，但还没有读到它的对话记录；回复暂时请在终端查看。';

export interface ConversationSubscriber {
  clientId: number;
  /** The client's own subscription generation; echoed on every event. */
  generation: number;
  /** The subscribe request, reused when the Host must push a fresh snapshot. */
  requestId: string;
}

export interface ConversationPage {
  messages: AgentChatMessage[];
  cursor?: number;
  atHead: boolean;
}

export class WatchedConversation {
  readonly delivery: DeliveryTracker;
  private decoder: TranscriptDecoder;
  private readonly merger = createAgentChatMerger();
  private readonly cursor: TranscriptCursor = createTranscriptCursor();
  private readonly subscribers = new Map<number, ConversationSubscriber>();
  private seq = 0;
  private earliest?: number;
  private atHead = false;
  private opened = false;
  private workingUntil = 0;
  /** When a prompt first reached the Agent while no record was bound. */
  private unboundSendAt?: number;

  /** `transcriptPath` is absent while the Agent has not written its record. */
  constructor(
    private currentBinding: AgentChatBinding,
    private path: string | undefined,
    private status: AgentChatStatus,
    private herdrStatus: string,
    private readonly now: () => number = Date.now,
    private readonly overdueMs = RECORD_OVERDUE_MS,
  ) {
    this.decoder = decoderFor(currentBinding.provider);
    this.delivery = new DeliveryTracker(currentBinding.conversationId);
  }

  get binding(): AgentChatBinding {
    return this.currentBinding;
  }

  get transcriptPath(): string | undefined {
    return this.path;
  }

  /** False until the Agent's record has been found and verified. */
  get bound(): boolean {
    return this.path !== undefined;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  listSubscribers(): ConversationSubscriber[] {
    return [...this.subscribers.values()];
  }

  subscriberFor(clientId: number): ConversationSubscriber | undefined {
    return this.subscribers.get(clientId);
  }

  addSubscriber(subscriber: ConversationSubscriber): void {
    this.subscribers.set(subscriber.clientId, subscriber);
  }

  removeSubscriber(clientId: number): void {
    this.subscribers.delete(clientId);
    this.delivery.dropClient(clientId);
  }

  get messages(): AgentChatMessage[] {
    return this.merger.list;
  }

  get highestSeq(): number {
    return this.seq;
  }

  get earlierCursor(): number | undefined {
    return this.atHead ? undefined : this.earliest;
  }

  get currentStatus(): AgentChatStatus {
    return this.status;
  }

  capabilities(): AgentChatCapabilities {
    // `blocked` is Herdr's word for an Agent waiting on something in its own
    // terminal. Pasting a prompt into that would answer a prompt we cannot read,
    // so the composer is disabled and the reason is stated rather than guessed.
    const blocked = this.herdrStatus === 'blocked';
    // An unbound conversation still sends: the input channel is Herdr's and
    // does not depend on the record. Only once a prompt has gone unanswered by
    // one for a while does the view say that replies are elsewhere for now.
    const overdue = !this.bound && this.unboundSendAt !== undefined
      && this.now() - this.unboundSendAt >= this.overdueMs;
    const degraded = blocked
      ? '这个 Agent 正在终端里等待确认，请切到终端视图处理后再继续对话。'
      : overdue ? RECORD_OVERDUE : undefined;
    return externalSessionCapabilities({
      provider: this.binding.provider,
      history: true,
      send: !blocked,
      ...(degraded ? { degraded } : {}),
    });
  }

  /** A prompt may have reached the Agent before its record could be found. */
  noteUnboundSend(): void {
    if (!this.bound) this.unboundSendAt ??= this.now();
  }

  /** Record Herdr's latest state. Returns true when the client must be told. */
  applyHerdrStatus(herdrStatus: string): boolean {
    if (herdrStatus === 'working') this.workingUntil = this.now() + WORKING_LATCH_MS;
    const next = this.derivedStatus();
    if (next === this.status && herdrStatus === this.herdrStatus) return false;
    this.herdrStatus = herdrStatus;
    this.status = next;
    return true;
  }

  private derivedStatus(): AgentChatStatus {
    if (this.herdrStatus === 'working' || this.now() < this.workingUntil) return 'working';
    return this.merger.list.length > 0 ? 'ready' : 'empty';
  }

  /** Read the recent tail once, so a subscription opens without a full scan. */
  async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    if (this.path === undefined) {
      // Nothing is written yet, so the empty window already sits at the head.
      this.atHead = true;
      this.status = this.derivedStatus();
      return;
    }
    await this.readWindow(this.path);
  }

  /**
   * The Agent's record has been found and verified: read it, and confirm any
   * send it already carries.
   *
   * A prompt sent while unbound had no file to capture an offset in, so its
   * receipt can only be proven here, against records read for the first time.
   * Skipping this would show the message in the transcript while its receipt
   * waited out the whole window and ended `uncertain`.
   */
  async bind(binding: AgentChatBinding, transcriptPath: string): Promise<DeliveryOutcome[]> {
    this.currentBinding = binding;
    this.path = transcriptPath;
    this.decoder = decoderFor(binding.provider);
    this.opened = true;
    resetCursor(this.cursor);
    return this.readWindow(transcriptPath);
  }

  private async readWindow(path: string): Promise<DeliveryOutcome[]> {
    const size = await fileSize(path);
    const from = Math.max(0, size - HISTORY_WINDOW_BYTES);
    const page = await readTranscriptRange(path, from);
    const messages: AgentChatMessage[] = [];
    const receipts: DeliveryOutcome[] = [];
    for (const entry of page.lines) {
      const message = this.decodeOne(entry);
      if (message) messages.push(message);
      // Only a bind can have sends waiting here; an ordinary open or a rewind
      // starts with none, and re-reading every prompt for them is wasted work.
      if (this.delivery.size === 0) continue;
      const prompt = this.decoder.userPromptText(entry.line);
      if (!prompt) continue;
      // The offset proves nothing for a file found after the send, so the
      // record's own time has to: one written before the send is not it.
      const receipt = this.delivery.observe(entry.offset, prompt, message?.id ?? this.fallbackId(entry), message?.timestamp);
      if (receipt) receipts.push(receipt);
    }
    replaceAgentChatList(this.merger, boundAgentChatWindow(messages, HISTORY_WINDOW_MESSAGES));
    this.earliest = page.lines[0]?.offset ?? 0;
    this.atHead = page.atHead;
    this.cursor.offset = page.size;
    this.cursor.pendingStart = page.size;
    this.status = this.derivedStatus();
    return receipts;
  }

  /**
   * Read everything appended since the last pass. Returns the new messages and
   * any send receipts they confirm; a rewind reports itself so the caller can
   * push a fresh snapshot instead of appending to a list that no longer matches.
   */
  async poll(): Promise<{ appended: AgentChatMessage[]; receipts: DeliveryOutcome[]; rewound: boolean }> {
    if (this.path === undefined) {
      // Binding is the service's job; until then there is nothing to read,
      // though the Herdr status may still have moved.
      this.status = this.derivedStatus();
      return { appended: [], receipts: [], rewound: false };
    }
    const result = await readTranscriptSince(this.path, this.cursor);
    if (result.rewound) {
      // Offsets captured before the rewind address different bytes now, so no
      // pending send may be confirmed against the rebuilt file. Each one that
      // loses its proof reports `uncertain` rather than going quiet.
      const lost = this.delivery.resetForRewind();
      this.opened = false;
      resetCursor(this.cursor);
      await this.open();
      return { appended: [], receipts: lost, rewound: true };
    }
    const receipts: DeliveryOutcome[] = [];
    const appended: AgentChatMessage[] = [];
    for (const entry of result.lines) {
      const message = this.decodeOne(entry);
      if (message) appended.push(message);
      const prompt = this.decoder.userPromptText(entry.line);
      if (!prompt) continue;
      const receipt = this.delivery.observe(entry.offset, prompt, message?.id ?? this.fallbackId(entry));
      if (receipt) receipts.push(receipt);
    }
    if (appended.length > 0) {
      appendAgentChatMessages(this.merger, appended, HISTORY_WINDOW_MESSAGES);
      // New records are the Agent demonstrably producing output, so they extend
      // the same latch Herdr's own status feeds.
      this.workingUntil = this.now() + WORKING_LATCH_MS;
    }
    this.status = this.derivedStatus();
    return { appended, receipts, rewound: false };
  }

  /** One page of history older than `cursor`, for the client's scroll-up. */
  async loadEarlier(cursor: number): Promise<ConversationPage> {
    if (this.path === undefined) return { messages: [], atHead: true };
    const from = Math.max(0, cursor - HISTORY_WINDOW_BYTES);
    const page = await readTranscriptRange(this.path, from, cursor);
    const messages = this.decode(page.lines);
    const earliest = page.lines[0]?.offset ?? 0;
    if (from === 0) this.atHead = true;
    if (this.earliest === undefined || earliest < this.earliest) this.earliest = earliest;
    return {
      messages,
      ...(from > 0 ? { cursor: earliest } : {}),
      atHead: from === 0,
    };
  }

  /**
   * Current file size, captured before a write so a receipt can be proven.
   * With no file yet, everything the Agent will write comes after the send.
   */
  sendCursor(): Promise<number> {
    return this.path === undefined ? Promise.resolve(0) : fileSize(this.path);
  }

  private decode(lines: readonly TranscriptLine[]): AgentChatMessage[] {
    const messages: AgentChatMessage[] = [];
    for (const entry of lines) {
      const message = this.decodeOne(entry);
      if (message) messages.push(message);
    }
    return messages;
  }

  /**
   * `seq` is the record's byte offset. It is monotonic in file order, stable
   * across re-reads, and lets an earlier page sort before a live append without
   * the two read paths needing to share a counter.
   */
  private decodeOne(entry: TranscriptLine): AgentChatMessage | undefined {
    const decoded = this.decoder.decode(entry.line, this.fallbackId(entry));
    if (!decoded) return undefined;
    if (entry.offset > this.seq) this.seq = entry.offset;
    return { ...decoded, seq: entry.offset };
  }

  /** Offsets are stable in an append-only file, so this id survives re-reads. */
  private fallbackId(entry: TranscriptLine): string {
    return `${this.binding.provider}:${entry.offset}`;
  }
}

function resetCursor(cursor: TranscriptCursor): void {
  cursor.offset = 0;
  cursor.pendingStart = 0;
  cursor.pendingChunks.length = 0;
  cursor.pendingBytes = 0;
  cursor.droppingOversized = false;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
