/**
 * The DOM renderer for a conversation.
 *
 * Assistant prose is read as Markdown and built into elements here; every
 * Agent-authored string still lands in `textContent` and none of it is ever
 * handed to an HTML parser. A transcript is untrusted input — whatever the model
 * wrote and whatever a tool printed — so structure comes from the Markdown
 * token stream and the elements are ours.
 *
 * The document interface is narrowed to what this file uses, so the renderer can
 * be exercised without a browser.
 */

import type { AgentChatCapabilities, AgentChatMessage, AgentChatStatus } from '@termbridge/agent-chat';
import {
  appendAgentChatMessages,
  boundAgentChatWindow,
  createAgentChatMerger,
  mergeAgentChatMessages,
  replaceAgentChatList,
} from '@termbridge/agent-chat';
import {
  buildRows,
  capabilityNotice,
  deliveryChip,
  deliveryLabel,
  statusLabel,
  toolStateLabel,
  type TranscriptRow,
} from './model.js';
import { renderMarkdown } from './markdownView.js';
import { renderJson } from './jsonView.js';

/** The subset of the DOM this renderer needs. */
export interface ViewElement {
  textContent: string | null;
  className: string;
  hidden: boolean;
  readonly childNodes: { length: number };
  appendChild(child: ViewElement): ViewElement;
  setAttribute(name: string, value: string): void;
  replaceChildren(...children: ViewElement[]): void;
  addEventListener?(type: string, listener: () => void): void;
  open?: boolean;
  disabled?: boolean;
  getBoundingClientRect?(): { top: number; bottom: number };
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
}

export interface ViewDocument {
  createElement(tag: string): ViewElement;
}

export interface TranscriptViewOptions {
  document: ViewDocument;
  root: ViewElement;
  /** Asked when the user reaches for more history. */
  onLoadEarlier?: (cursor: number) => void;
  /** Messages kept in the live window; older ones stay behind `loadEarlier`. */
  windowLimit?: number;
}

/** A local send still waiting for its receipt, shown beside its own message. */
export interface PendingSend {
  /** The requestId the receipt will carry, so the row belongs to one send. */
  id: string;
  text: string;
  state: import('@termbridge/agent-chat').AgentChatDeliveryState;
  error?: string;
  /** The record the Host observed this request as, when it has said. */
  messageId?: string;
}

export interface TranscriptView {
  /** Re-apply the reader's follow intent after a size change. */
  reflow(): void;
  /**
   * The reader asked for history explicitly — from the shell's own menu, which
   * is how a page too short to scroll can still reach it.
   */
  revealHistory(): void;
  /**
   * The message the user just sent, with its receipt. Passing `undefined`
   * removes it — which is what the shell does once the Agent's own record
   * carries the message and the transcript shows it for real.
   */
  setPendingSend(pending: PendingSend | undefined): void;
  snapshot(input: {
    generation: number;
    status: AgentChatStatus;
    capabilities: AgentChatCapabilities;
    messages: readonly AgentChatMessage[];
    earlierCursor?: number;
    error?: string;
    /** True only from a shell that offers its own history entry. */
    historyMenu?: boolean;
  }): void;
  append(input: {
    generation: number;
    status: AgentChatStatus;
    capabilities: AgentChatCapabilities;
    messages: readonly AgentChatMessage[];
  }): void;
  prepend(input: { generation: number; messages: readonly AgentChatMessage[]; cursor?: number; atHead: boolean }): void;
  clear(): void;
  readonly generation: number;
  readonly rows: TranscriptRow[];
}

const DEFAULT_WINDOW = 400;

/** How close to the top counts as having reached the history. */
const TOP_SLACK_PX = 24;

export function createTranscriptView(options: TranscriptViewOptions): TranscriptView {
  const doc = options.document;
  const merger = createAgentChatMerger();
  const notice = element(doc, 'div', 'tb-notice');
  notice.hidden = true;
  const earlier = element(doc, 'button', 'tb-earlier');
  earlier.textContent = '加载更早的对话';
  earlier.hidden = true;
  const list = element(doc, 'div', 'tb-list');
  options.root.replaceChildren(notice, earlier, list);

  let generation = -1;
  let earlierCursor: number | undefined;
  let rows: TranscriptRow[] = [];
  let windowLimit = options.windowLimit ?? DEFAULT_WINDOW;
  let pendingSend: PendingSend | undefined;
  /**
   * Whether the reader is following the conversation.
   *
   * Kept as an intent rather than re-measured at render time: a keyboard
   * opening, a font change or a first layout at zero height all move the
   * numbers without the reader having done anything, and re-measuring then
   * strands them part-way up. Scrolling up clears it; scrolling back sets it.
   */
  let followBottom = true;
  /**
   * Whether the reader has actually gone looking for history.
   *
   * Being at offset zero is not the same as asking: a page with one short
   * message is at the top and cannot scroll, and parking a control there puts
   * it across the first thing anyone sees — and within reach of a mistaken tap.
   * The shell keeps an explicit entry in its menu, so history stays reachable
   * on a page that can never scroll.
   */
  let askedForHistory = false;
  /** Set from each snapshot; false for a shell with no menu of its own. */
  let shellHasHistoryMenu = false;
  let lastStatus: AgentChatStatus = 'loading';
  let lastCapabilities: AgentChatCapabilities | undefined;
  const maxWindow = Math.max(windowLimit, 4_000);
  const nodes = new Map<string, { signature: string; element: ViewElement }>();
  let rendered: ViewElement[] = [];

  function anchor(): { id: string; top: number } | undefined {
    const top = options.root.getBoundingClientRect?.().top;
    if (top === undefined) return;
    for (const row of rows) {
      const rect = nodes.get(row.id)?.element.getBoundingClientRect?.();
      if (rect && rect.bottom > top) return { id: row.id, top: rect.top };
    }
  }
  function restoreAnchor(saved: ReturnType<typeof anchor>): void {
    if (!saved || options.root.scrollTop === undefined) return;
    const top = nodes.get(saved.id)?.element.getBoundingClientRect?.().top;
    if (top !== undefined) options.root.scrollTop += top - saved.top;
  }
  function renderRows(error?: string): void {
    rows = buildRows(merger.list, { status: lastStatus, ...(pendingSend ? { pending: pendingSend } : {}) });
    const live = new Set(rows.map(row => row.id));
    for (const id of nodes.keys()) if (!live.has(id)) nodes.delete(id);
    const children = rows.map(row => {
      const signature = JSON.stringify(row);
      const prior = nodes.get(row.id);
      if (prior?.signature === signature) return prior.element;
      const node = renderRow(doc, row);
      node.setAttribute('data-row-id', row.id);
      if (row.kind === 'tool' && prior?.element.open) node.open = true;
      nodes.set(row.id, { signature, element: node });
      return node;
    });
    if (!children.length) {
      const empty = element(doc, 'div', 'tb-empty');
      empty.textContent = error ?? '';
      children.push(empty);
    }
    if (children.length !== rendered.length || children.some((node, i) => node !== rendered[i])) {
      list.replaceChildren(...children);
      rendered = children;
    }
  }

  earlier.addEventListener?.('click', () => {
    if (earlierCursor === undefined || merger.list.length >= maxWindow) return;
    options.onLoadEarlier?.(earlierCursor);
  });

  function updateEarlier(): void {
    // Offered where it is needed — at the top of the history the reader has
    // scrolled to — instead of occupying the first screen before they have read
    // anything. Nothing here fetches on its own.
    const atTop = (options.root.scrollTop ?? 0) <= TOP_SLACK_PX;
    // Waiting for the reader to scroll up is only safe where something else can
    // reach history. Where nothing can, being at the top is the ask.
    const wanted = shellHasHistoryMenu ? askedForHistory && atTop : atTop;
    earlier.hidden = earlierCursor === undefined || !wanted;
    earlier.disabled = merger.list.length >= maxWindow;
    earlier.textContent = earlier.disabled ? `已显示 ${maxWindow} 条记录，更早内容请在终端查看` : '加载更早的对话';
  }
  function render(status: AgentChatStatus, capabilities: AgentChatCapabilities, error?: string): void {
    lastStatus = status;
    lastCapabilities = capabilities;
    // Decide before the list changes: a user who scrolled up to read something
    // must not be yanked back down every time the Agent emits a row.
    const pinned = followBottom;
    const saved = pinned ? undefined : anchor();
    renderRows(error ?? statusLabel(status));
    const message = error ?? capabilityNotice(capabilities);
    notice.textContent = message ?? '';
    notice.hidden = !message;
    if (pinned) scrollToBottom(options.root);
    else restoreAnchor(saved);
    // After the scroll, so "am I at the top of the history" is asked of where
    // the reader actually ends up rather than where they were a moment ago.
    updateEarlier();
  }

  // The shell calls this when the box or its content changed size — a keyboard,
  // a rotation, a font scale, or the very first layout after being shown with
  // no height at all. It only honours an intent the reader already had.
  function reflow(): void {
    if (followBottom) scrollToBottom(options.root);
  }
  options.root.addEventListener?.('scroll', () => {
    const wasFollowing = followBottom;
    followBottom = isNearBottom(options.root);
    // Scrolling up off the end is the reader going back through the
    // conversation; that is when the inline control becomes useful.
    if (wasFollowing && !followBottom) askedForHistory = true;
    updateEarlier();
  });

  return {
    get generation() { return generation; },
    get rows() { return rows; },
    reflow,
    revealHistory() {
      askedForHistory = true;
      updateEarlier();
      if (earlierCursor !== undefined && merger.list.length < maxWindow) options.onLoadEarlier?.(earlierCursor);
    },
    setPendingSend(pending) {
      pendingSend = pending;
      if (generation < 0) return;
      render(lastStatus, lastCapabilities ?? { history: true, send: true, stop: false, attachments: false, approvals: false, questions: false, terminal: true });
    },
    snapshot(input) {
      generation = input.generation;
      // A conversation always opens on its latest turn, with no history control
      // standing between the reader and the newest message.
      followBottom = true;
      askedForHistory = false;
      shellHasHistoryMenu = input.historyMenu === true;
      nodes.clear();rendered = [];windowLimit = options.windowLimit ?? DEFAULT_WINDOW;
      // A shell that serializes an absent field as JSON null must not be read as
      // "there is more history"; only a real offset offers the earlier page.
      earlierCursor = offsetOrNone(input.earlierCursor);
      replaceAgentChatList(merger, boundAgentChatWindow(input.messages, options.windowLimit ?? DEFAULT_WINDOW));
      render(input.status, input.capabilities, input.error);
      // A conversation always opens on its latest turn, whatever the previous
      // view's scroll position was.
      scrollToBottom(options.root);
      updateEarlier();
    },
    append(input) {
      // A late event from a conversation the user already left must not be
      // written into the one they are looking at.
      if (input.generation !== generation) return;
      const previousFirst = merger.list[0];
      appendAgentChatMessages(merger, input.messages, windowLimit);
      if (previousFirst && merger.list[0]?.id !== previousFirst.id) earlierCursor = merger.list[0]?.seq;
      render(input.status, input.capabilities);
    },
    prepend(input) {
      if (input.generation !== generation) return;
      earlierCursor = input.atHead ? undefined : offsetOrNone(input.cursor);
      const saved = anchor();
      const merged = mergeAgentChatMessages(input.messages, merger.list);
      // Keep explicitly loaded history through subsequent live updates.
      windowLimit = maxWindow;
      const bounded = boundAgentChatWindow(merged, windowLimit);
      if (bounded.length !== merged.length) earlierCursor = bounded[0]?.seq;
      replaceAgentChatList(merger, bounded);
      renderRows();
      updateEarlier();
      restoreAnchor(saved);
    },
    clear() {
      generation = -1;
      earlierCursor = undefined;
      pendingSend = undefined;
      replaceAgentChatList(merger, []);
      rows = [];nodes.clear();rendered = [];
      list.replaceChildren();
      notice.hidden = true;
      earlier.hidden = true;
    },
  };
}

function renderRow(doc: ViewDocument, row: TranscriptRow): ViewElement {
  if (row.kind === 'status') {
    const node = element(doc, 'div', 'tb-row tb-status');
    node.textContent = row.text;
    return node;
  }
  if (row.kind === 'working') {
    const node = element(doc, 'div', 'tb-row tb-working');
    // No text by design; the label is what a screen reader announces.
    node.setAttribute('role', 'status');
    node.setAttribute('aria-label', 'Agent 正在处理');
    for (const index of [0, 1, 2]) {
      const dot = element(doc, 'span', 'tb-working-dot');
      dot.setAttribute('data-index', String(index));
      node.appendChild(dot);
    }
    return node;
  }
  if (row.kind === 'pending') {
    // The user's own words, with the receipt for this one send attached to
    // them. Nothing about it is written into the shared status strip.
    const node = element(doc, 'div', 'tb-row tb-user tb-pending');
    node.setAttribute('data-state', row.state);
    const body = element(doc, 'div', 'tb-prose');
    body.textContent = row.text;
    node.appendChild(body);
    const receipt = element(doc, 'div', 'tb-receipt');
    const chip = element(doc, 'span', 'tb-receipt-chip');
    chip.textContent = deliveryChip(row.state);
    receipt.appendChild(chip);
    const detail = element(doc, 'span', 'tb-receipt-detail');
    detail.textContent = row.error ?? deliveryLabel(row.state);
    receipt.appendChild(detail);
    node.appendChild(receipt);
    return node;
  }
  if (row.kind === 'prose') {
    const node = element(doc, 'div', `tb-row tb-${row.role}`);
    const body = element(doc, 'div', 'tb-prose');
    if (row.role === 'assistant') {
      // Assistant text is Markdown by contract. A user's own prompt is shown as
      // typed: they did not ask for their asterisks to become emphasis.
      for (const child of renderMarkdown(doc, row.text)) body.appendChild(child);
    } else {
      body.textContent = row.text;
    }
    node.appendChild(body);
    return node;
  }
  if (row.kind === 'image') {
    const node = element(doc, 'div', `tb-row tb-${row.role}`);
    const chip = element(doc, 'div', 'tb-image');
    if (row.url) {
      const image = element(doc, 'img');
      image.setAttribute('src', row.url);
      image.setAttribute('alt', row.alt ?? row.name ?? '图片');
      chip.appendChild(image);
    } else {
      chip.textContent = row.name ? `图片 · ${row.name}` : '图片';
    }
    node.appendChild(chip);
    return node;
  }
  const node = element(doc, 'details', 'tb-row tb-tool');
  // The state is reported, never inferred: a call the provider never answered
  // is "执行中" only while this conversation is working, and "状态未知" after.
  node.setAttribute('data-state', row.state);
  const summary = element(doc, 'summary');
  const name = element(doc, 'span', 'tb-tool-name');
  name.textContent = row.name;
  const detail = element(doc, 'span', 'tb-tool-summary');
  detail.textContent = row.summary;
  const state = element(doc, 'span', 'tb-tool-state');
  // Running is shown as motion, not as a word — the spinner already says it and
  // the label is what a screen reader reads. Finished states stay as text,
  // because "完成" and "失败" are the outcome, not an animation.
  state.setAttribute('aria-label', toolStateLabel(row.state));
  state.textContent = row.state === 'running' ? '' : toolStateLabel(row.state);
  summary.appendChild(name);
  summary.appendChild(detail);
  summary.appendChild(state);
  node.appendChild(summary);

  const body = element(doc, 'div', 'tb-tool-body');
  if (row.input) body.appendChild(labelledJson(doc, '输入', row.input));
  if (row.output !== undefined) body.appendChild(labelled(doc, row.state === 'failed' ? '错误输出' : '输出', row.output));
  if (row.state === 'unknown' && row.output === undefined) {
    const note = element(doc, 'div', 'tb-pre-label');
    note.textContent = '这次调用没有记录结果，无法判断是否完成。请在终端查看。';
    body.appendChild(note);
  }
  if (row.truncated) {
    const cut = element(doc, 'div', 'tb-pre-label');
    cut.textContent = '内容过长，已截断显示。完整内容请在终端查看。';
    body.appendChild(cut);
  }
  node.appendChild(body);
  return node;
}

/**
 * Tool arguments, formatted when they are JSON and left alone when they are not.
 *
 * The copy target keeps the original string either way: a reader who copies an
 * argument must get what the Agent sent, not our re-indentation of it.
 */
function labelledJson(doc: ViewDocument, label: string, text: string): ViewElement {
  const rendered = renderJson(text);
  if (!rendered.tokens) return labelled(doc, label, text);
  const wrapper = element(doc, 'div');
  const caption = element(doc, 'div', 'tb-pre-label');
  caption.textContent = label;
  const pre = element(doc, 'pre', 'tb-pre tb-json');
  pre.setAttribute('data-copy', rendered.copyText);
  for (const token of rendered.tokens) {
    const span = element(doc, 'span', `tb-json-${token.type}`);
    span.textContent = token.text;
    pre.appendChild(span);
  }
  wrapper.appendChild(caption);
  wrapper.appendChild(pre);
  return wrapper;
}

function labelled(doc: ViewDocument, label: string, text: string): ViewElement {
  const wrapper = element(doc, 'div');
  const caption = element(doc, 'div', 'tb-pre-label');
  caption.textContent = label;
  const pre = element(doc, 'pre', 'tb-pre');
  pre.textContent = text;
  wrapper.appendChild(caption);
  wrapper.appendChild(pre);
  return wrapper;
}

function element(doc: ViewDocument, tag: string, className = ''): ViewElement {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

function offsetOrNone(value: number | undefined | null): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Within one screen of the end counts as following along. */
const PIN_SLACK_PX = 48;

export function isNearBottom(root: ViewElement): boolean {
  const { scrollTop, scrollHeight, clientHeight } = root;
  if (typeof scrollTop !== 'number' || typeof scrollHeight !== 'number' || typeof clientHeight !== 'number') {
    return true;
  }
  return scrollHeight - clientHeight - scrollTop <= PIN_SLACK_PX;
}

function scrollToBottom(root: ViewElement): void {
  if (typeof root.scrollHeight !== 'number') return;
  // Clamped the way a browser clamps it, so a page with nothing to scroll ends
  // at zero rather than at a position it could never actually hold.
  const limit = typeof root.clientHeight === 'number' ? Math.max(0, root.scrollHeight - root.clientHeight) : root.scrollHeight;
  root.scrollTop = limit;
}
