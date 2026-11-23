import net from 'node:net';
import { HerdrTerminal } from './herdrTerminal.js';
import { HerdrScrollback } from './herdrScrollback.js';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { Viewer } from './sessionManager.js';
import {
  compactMobilePaneLines,
  parseMobileTranscript,
  type MobileTranscriptSnapshot,
} from './mobileTranscript.js';
import { resolveLocalAgentTranscriptLinks, type TranscriptLink } from './agentTranscriptLinks.js';

// Protocol 22 (Herdr 0.9.3) was checked against `herdr api schema`: snapshot,
// pane.read, pane.send_input, pane.close and events.wait keep every field used
// here. A newer protocol stays rejected until it is checked the same way.
const HERDR_PROTOCOLS = { min: 19, max: 22 };
const WAIT_TIMEOUT_MS = 1_500;
const LOCAL_TIMEOUT_GRACE_MS = 5_000;
const POLL_INTERVAL_MS = 1_000;
const REDRAW = '\x1b[2J\x1b[H';
const MOBILE_REDRAW = '\x1b[3J\x1b[2J\x1b[H';
const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

interface HerdrWorkspaceInfo {
  workspace_id: string;
  label: string;
}

interface HerdrPaneInfo {
  terminal_id?: string;
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  terminal_title_stripped?: string | null;
  title?: string | null;
  label?: string | null;
  agent?: string | null;
  display_agent?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  agent_status: string;
  revision: number;
  agent_session?: HerdrAgentSessionInfo | null;
}

interface HerdrAgentInfo {
  pane_id: string;
  name?: string;
  agent?: string;
  agent_status?: string;
  cwd?: string | null;
  foreground_cwd?: string | null;
  agent_session?: HerdrAgentSessionInfo | null;
}

interface HerdrAgentSessionInfo {
  agent?: string;
  kind?: string;
  source?: string;
  value?: string;
}

interface HerdrLayoutInfo {
  panes: Array<{ pane_id: string; rect: { width: number; height: number } }>;
}

interface HerdrSnapshot {
  version: string;
  protocol: number;
  workspaces: HerdrWorkspaceInfo[];
  panes: HerdrPaneInfo[];
  agents: HerdrAgentInfo[];
  layouts: HerdrLayoutInfo[];
}

interface ApiResponse {
  id: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface HerdrSession {
  terminalId?: string;
  id: string;
  paneId: string;
  workspaceId: string;
  workspace: string;
  /** Herdr's user-facing Agent name, falling back to its workspace label. */
  name: string;
  command: string;
  cwd?: string;
  agent?: string;
  agentSessionId?: string;
  /**
   * Herdr's own session reference. `kind: 'path'` names the Agent's record file
   * directly, which is authoritative and saves deriving one from a store layout.
   */
  agentSessionRef?: HerdrAgentSessionInfo;
  status: string;
  completedAt?: number;
  cols: number;
  rows: number;
  createdAt: number;
  revision: number;
  viewers: HerdrViewer[];
  watching: boolean;
  lastScreen?: string;
  preview?: string;
  previewRevision?: number;
  context?: string;
  contextRevision?: number;
}

export type HerdrPresentation = 'terminal' | 'mobile';

export interface HerdrViewer extends Viewer {
  terminal?: HerdrTerminal;
  history?: HerdrScrollback;
  rows?: number;
  presentation: HerdrPresentation;
  mobilePatches?: boolean;
  mobileSnapshot?: MobileTranscriptSnapshot;
}

export interface HerdrScreens {
  terminal: Buffer;
  mobile?: Buffer;
  mobileTranscript?: MobileTranscriptSnapshot;
}

export interface HerdrInitialView {
  activate?: () => void;
  screen: Buffer;
  mobileTranscript?: MobileTranscriptSnapshot;
}

export interface HerdrBridgeOptions {
  onScrollError?: (session: HerdrSession, viewer: HerdrViewer) => void;
  onTerminalOutput?: (session: HerdrSession, viewer: HerdrViewer, data: Buffer) => void;
  onTerminalClose?: (session: HerdrSession, viewer: HerdrViewer, reason: string) => void;
  socketPath?: string;
  onOutput: (session: HerdrSession, screens: HerdrScreens) => void;
  onExit: (session: HerdrSession) => void;
  log?: (message: string) => void;
  resolveTranscriptLinks?: (session: HerdrSession) => Promise<TranscriptLink[]>;
}

function defaultSocketPath(): string {
  if (process.env.TB_HERDR_SOCKET) return process.env.TB_HERDR_SOCKET;
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  const config = process.env.HERDR_CONFIG_PATH || join(os.homedir(), '.config', 'herdr', 'config.toml');
  return join(dirname(config), 'herdr.sock');
}

/** Stable TB id for an existing Herdr pane. Herdr's pane id remains visible. */
export function herdrSessionId(paneId: string): string {
  return `herdr:${paneId}`;
}

const CLAUDE_TOOL_LINE = /^(?:Update|Read|Write|Edit|Bash|Glob|Grep|Search|Task|TodoWrite|WebFetch|WebSearch|EnterPlanMode|ExitPlanMode)\b/i;
const CODEX_EVENT_LINE = /^(?:Ran|Read|Searched|Explored|Edited|Updated Plan|Called|Used|Waiting|You have)\b/i;
const TERMINAL_CHROME = /^(?:[›❯]|[─━═]{8,}|\d+ tasks?\b|[◻✔✻✳⏵]|Jump to bottom\b|new task\?|gpt-[\w.-]+\b)/i;

function cleanPreviewLine(line: string): string {
  return line
    .replace(ANSI_ESCAPE, '')
    .replace(/^[\s│└├┌┐┘┬┴┼]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract the latest human-readable agent reply, excluding terminal and tool UI. */
export function extractPanePreview(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map(cleanPreviewLine);

  // Claude Code marks assistant prose with ⏺. Tool calls use the same marker,
  // so reject the public tool names and keep only conversational text.
  const claudeReplies = lines
    .map((line) => line.match(/^[⏺●]\s+(.+)$/)?.[1])
    .filter((line): line is string => typeof line === 'string' && !CLAUDE_TOOL_LINE.test(line));
  if (claudeReplies.length) return claudeReplies.at(-1);

  // Codex renders a final response as a bullet-led block. Keep the last such
  // block that is not a tool/event card, then return its final wrapped line.
  let finalBlock: string[] | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^•\s+(.+)$/);
    if (!match || CODEX_EVENT_LINE.test(match[1])) continue;
    const block = [match[1]];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (!line) continue;
      if (/^•\s+/.test(line) || TERMINAL_CHROME.test(line) || /^─\s*Worked for\b/i.test(line)) break;
      if (/^[+-]?\s*\d+\s/.test(line) || /^…\s*\+\d+ lines/.test(line)) continue;
      block.push(line.replace(/^[-*]\s+/, ''));
    }
    finalBlock = block;
  }
  return finalBlock?.filter(Boolean).at(-1);
}

/** Turn Herdr's linear ANSI read into an xterm redraw that wraps at phone width. */
export function renderMobilePaneText(text: string): Buffer {
  const body = compactMobilePaneLines(text).join('\r\n');
  return Buffer.from(MOBILE_REDRAW + body + '\x1b[0m', 'utf8');
}

export type TerminalInputPart = { text?: string; keys?: string[] };

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Paste one logical multi-line prompt, then submit it exactly once. */
export function pasteAndSubmit(text: string): Buffer {
  return Buffer.from(`${PASTE_START}${text}${PASTE_END}\r`, 'utf8');
}

function appendParts(out: TerminalInputPart[], parts: TerminalInputPart[]): void {
  for (const part of parts) {
    const previous = out.at(-1);
    if (part.text && previous?.text && !previous.keys && !part.keys) previous.text += part.text;
    else out.push(part);
  }
}

/** Split non-paste terminal input into Herdr's public `pane.send_input` shape. */
function decodeKeysAndText(input: string): TerminalInputPart[] {
  const out: TerminalInputPart[] = [];
  let text = '';
  let keys: string[] = [];

  const flushText = () => {
    if (text) out.push({ text });
    text = '';
  };
  const flushKeys = () => {
    if (keys.length) out.push({ keys });
    keys = [];
  };
  const pushText = (value: string) => {
    flushKeys();
    text += value;
  };
  const pushKey = (value: string) => {
    flushText();
    keys.push(value);
  };

  const escapeKeys: Array<[string, string]> = [
    ['\x1b[3~', 'delete'],
    ['\x1b[5~', 'pageup'],
    ['\x1b[6~', 'pagedown'],
    ['\x1b[2~', 'insert'],
    ['\x1b[Z', 'shift+tab'],
    ['\x1bOH', 'home'],
    ['\x1bOF', 'end'],
    ['\x1bOA', 'up'],
    ['\x1bOB', 'down'],
    ['\x1bOC', 'right'],
    ['\x1bOD', 'left'],
    ['\x1b[A', 'up'],
    ['\x1b[B', 'down'],
    ['\x1b[C', 'right'],
    ['\x1b[D', 'left'],
    ['\x1b[H', 'home'],
    ['\x1b[F', 'end'],
  ];

  for (let i = 0; i < input.length; ) {
    // Decode modified cursor keys before the generic Escape/Alt path. Otherwise
    // Shift+Left becomes Alt+[ followed by the literal text "1;2D" in the Agent.
    const cursor = input[i] === '\x1b' ? /^\x1b\[1;([2-8])([ABCDHF])/.exec(input.slice(i)) : null;
    if (cursor) {
      const mask = Number(cursor[1]) - 1;
      const modifiers = [mask & 4 ? 'ctrl' : '', mask & 2 ? 'alt' : '', mask & 1 ? 'shift' : ''].filter(Boolean);
      const names: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
      pushKey([...modifiers, names[cursor[2]]].join('+'));
      i += cursor[0].length;
      continue;
    }
    const matched = escapeKeys.find(([sequence]) => input.startsWith(sequence, i));
    if (matched) {
      pushKey(matched[1]);
      i += matched[0].length;
      continue;
    }

    const code = input.charCodeAt(i);
    if (code === 0x1b) {
      const next = input[i + 1];
      if (next && next.charCodeAt(0) >= 0x20 && next.charCodeAt(0) <= 0x7e) {
        pushKey(`alt+${next.toLowerCase()}`);
        i += 2;
      } else {
        pushKey('esc');
        i += 1;
      }
      continue;
    }
    if (code === 0x0d || code === 0x0a) {
      pushKey('enter');
      i += code === 0x0d && input.charCodeAt(i + 1) === 0x0a ? 2 : 1;
      continue;
    }
    if (code === 0x7f || code === 0x08) {
      pushKey('backspace');
      i += 1;
      continue;
    }
    if (code === 0x09) {
      pushKey('tab');
      i += 1;
      continue;
    }
    if (code >= 1 && code <= 26) {
      pushKey(`ctrl+${String.fromCharCode(96 + code)}`);
      i += 1;
      continue;
    }
    if (code === 0) {
      pushKey('ctrl+space');
      i += 1;
      continue;
    }

    const point = input.codePointAt(i)!;
    const char = String.fromCodePoint(point);
    pushText(char);
    i += char.length;
  }
  flushText();
  flushKeys();
  return out;
}

function markerPrefixAtEnd(value: string, marker: string): number {
  const longest = Math.min(value.length, marker.length - 1);
  // ESC and ESC+[ are complete user input in their own right. Waiting only
  // after ESC+[2 keeps standalone Escape responsive while still tolerating a
  // bracketed-paste marker split by stdin or WebSocket framing.
  for (let length = longest; length >= 3; length -= 1) {
    if (marker.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

/**
 * Stateful terminal decoder. Bracketed paste can span stdin/WebSocket frames,
 * so its newlines must remain text until the closing marker arrives. Outside a
 * paste, CR/LF continue to be logical Enter keys.
 */
export class TerminalInputDecoder {
  private readonly utf8 = new StringDecoder('utf8');
  private buffered = '';
  private pasting = false;

  decode(data: Buffer): TerminalInputPart[] {
    this.buffered += this.utf8.write(data);
    const out: TerminalInputPart[] = [];

    while (this.buffered) {
      const marker = this.pasting ? PASTE_END : PASTE_START;
      const markerIndex = this.buffered.indexOf(marker);
      if (markerIndex >= 0) {
        this.appendSegment(out, this.buffered.slice(0, markerIndex));
        this.buffered = this.buffered.slice(markerIndex + marker.length);
        this.pasting = !this.pasting;
        continue;
      }

      const pendingCursorLength = this.pasting ? 0 : (/\x1b\[1(?:;[2-8]?)?$/.exec(this.buffered)?.[0].length ?? 0);
      const heldMarkerLength = Math.max(markerPrefixAtEnd(this.buffered, marker), pendingCursorLength);
      let readyLength = this.buffered.length - heldMarkerLength;
      // A CR at the actual chunk boundary may be the first half of CRLF.
      if (this.pasting && heldMarkerLength === 0 && this.buffered.endsWith('\r')) readyLength -= 1;
      if (readyLength > 0) {
        this.appendSegment(out, this.buffered.slice(0, readyLength));
        this.buffered = this.buffered.slice(readyLength);
      }
      break;
    }

    return out;
  }

  private appendSegment(out: TerminalInputPart[], segment: string): void {
    if (!segment) return;
    if (this.pasting) appendParts(out, [{ text: segment.replace(/\r\n|\r/g, '\n') }]);
    else appendParts(out, decodeKeysAndText(segment));
  }
}

/** Decode one complete terminal input frame. Use TerminalInputDecoder for streams. */
export function decodeTerminalInput(data: Buffer): TerminalInputPart[] {
  return new TerminalInputDecoder().decode(data);
}

/** Direct adapter for Herdr's newline-delimited JSON Unix socket API. */
export class HerdrBridge {
  readonly sessions = new Map<string, HerdrSession>();
  readonly socketPath: string;
  private seq = 0;
  private announced = false;
  private outputMode: 'events' | 'poll' = 'events';
  private pollingAnnounced = false;
  private readonly inputTails = new Map<string, Promise<void>>();
  private readonly inputDecoders = new Map<string, TerminalInputDecoder>();
  private readonly resolveTranscriptLinks: (session: HerdrSession) => Promise<TranscriptLink[]>;

  constructor(private readonly opts: HerdrBridgeOptions) {
    this.socketPath = opts.socketPath || defaultSocketPath();
    this.resolveTranscriptLinks = opts.resolveTranscriptLinks ?? resolveLocalAgentTranscriptLinks;
  }

  get enabled(): boolean {
    return !/^(0|off|false)$/i.test(process.env.TB_HERDR || 'auto');
  }

  async init(): Promise<void> {
    if (!this.enabled) {
      this.opts.log?.('[host] Herdr discovery disabled (TB_HERDR=off)');
      return;
    }
    try {
      await this.refresh();
    } catch (error) {
      this.opts.log?.(`[host] Herdr not detected at ${this.socketPath}: ${(error as Error).message}`);
    }
  }

  /** Refresh all workspaces/panes from one authoritative Herdr snapshot. */
  async refresh(): Promise<HerdrSession[]> {
    if (!this.enabled || !existsSync(this.socketPath)) return [];
    const response = await this.request('session.snapshot', {});
    const snapshot = response.result?.snapshot as HerdrSnapshot | undefined;
    if (!snapshot) throw new Error('Herdr returned no session snapshot');
    if (!(snapshot.protocol >= HERDR_PROTOCOLS.min && snapshot.protocol <= HERDR_PROTOCOLS.max)) {
      throw new Error(`Herdr protocol ${snapshot.protocol} is not supported `
        + `(supported ${HERDR_PROTOCOLS.min}-${HERDR_PROTOCOLS.max}); update TermBridge`);
    }

    const workspaces = new Map(snapshot.workspaces.map((w) => [w.workspace_id, w]));
    const agents = new Map(snapshot.agents.map((a) => [a.pane_id, a]));
    const sizes = new Map<string, { cols: number; rows: number }>();
    for (const layout of snapshot.layouts) {
      for (const pane of layout.panes) sizes.set(pane.pane_id, { cols: pane.rect.width, rows: pane.rect.height });
    }

    const seen = new Set<string>();
    for (const pane of snapshot.panes) {
      const id = herdrSessionId(pane.pane_id);
      seen.add(id);
      const previous = this.sessions.get(id);
      const workspace = workspaces.get(pane.workspace_id)?.label || pane.workspace_id;
      const agentInfo = agents.get(pane.pane_id);
      const cwd = pane.foreground_cwd || agentInfo?.foreground_cwd || pane.cwd || agentInfo?.cwd || undefined;
      const explicitName = agentInfo?.name || pane.title || pane.label || undefined;
      const agent = pane.display_agent || pane.agent || agentInfo?.agent || undefined;
      const agentSession = agentInfo?.agent_session || pane.agent_session || undefined;
      const agentSessionId = agentSession?.value || undefined;
      const status = agentInfo?.agent_status || pane.agent_status || 'unknown';
      const terminal = pane.title || pane.label || pane.terminal_title_stripped || 'shell';
      const name = explicitName || workspace || terminal;
      const size = sizes.get(pane.pane_id) || { cols: 80, rows: 24 };
      const completedAt = status === 'done'
        ? previous?.status === 'done'
          ? previous.completedAt
          : previous
            ? Date.now()
            : undefined
        : undefined;
      const session: HerdrSession = previous || {
        id,
        paneId: pane.pane_id,
        workspaceId: pane.workspace_id,
        workspace,
        name,
        command: '',
        cwd,
        agentSessionId,
        status,
        cols: size.cols,
        rows: size.rows,
        createdAt: Date.now(),
        revision: pane.revision,
        viewers: [],
        watching: false,
      };
      // Attached viewers and the watcher both retain this object. Replacing it
      // here leaves the old watcher observing an orphan while the new session
      // inherits `watching: true` and never starts another one.
      session.paneId = pane.pane_id;
      session.workspaceId = pane.workspace_id;
      session.terminalId = pane.terminal_id;
      session.workspace = workspace;
      session.name = name;
      session.command = `${workspace} · ${explicitName || agent || terminal}`;
      session.cwd = cwd;
      session.agent = agent;
      session.agentSessionId = agentSessionId;
      session.agentSessionRef = agentSession ?? undefined;
      session.status = status;
      session.completedAt = completedAt;
      session.cols = size.cols;
      session.rows = size.rows;
      session.revision = Math.max(session.revision, pane.revision);
      this.sessions.set(id, session);
    }

    for (const [id, session] of this.sessions) {
      if (seen.has(id)) continue;
      this.sessions.delete(id);
      for (const viewer of session.viewers) viewer.terminal?.close();
      if (session.viewers.length) this.opts.onExit(session);
    }

    if (!this.announced) {
      this.announced = true;
      this.opts.log?.(
        `[host] Herdr ${snapshot.version} detected: ${snapshot.workspaces.length} workspaces, ${snapshot.panes.length} panes via ${this.socketPath}`,
      );
    }
    return [...this.sessions.values()];
  }

  async addViewer(
    session: HerdrSession,
    clientId: number,
    sid: number,
    presentation: HerdrPresentation = 'terminal',
    mobilePatches = false,
    nativeTerminal?: { cols: number; rows: number },
    rows = session.rows,
  ): Promise<HerdrInitialView> {
    if (nativeTerminal) {
      if (!session.terminalId || presentation === 'mobile') throw new Error('Herdr native terminal unavailable; update Herdr on the Host');
      if (session.viewers.some((v) => v.clientId === clientId && v.sid === sid)) throw new Error('already attached');
      const viewer: HerdrViewer = { clientId, sid, presentation };
      const terminal = new HerdrTerminal({
        terminalId: session.terminalId, socketPath: this.socketPath, ...nativeTerminal,
        onData: (data) => this.opts.onTerminalOutput?.(session, viewer, data),
        onClose: (reason) => {
          session.viewers = session.viewers.filter((v) => v !== viewer);
          this.opts.onTerminalClose?.(session, viewer, reason);
        },
      });
      viewer.terminal = terminal;
      session.viewers.push(viewer);
      try {
        const screen = await terminal.ready;
        return { screen, activate: () => terminal.activate() };
      } catch (error) {
        session.viewers = session.viewers.filter((v) => v !== viewer);
        terminal.close();
        throw error;
      }
    }
    const mobile = presentation === 'mobile' ? await this.readMobilePresentation(session) : undefined;
    const screen = mobile?.screen ?? await this.readScreen(session);
    const viewer: HerdrViewer = { clientId, sid, presentation };
    if (presentation === 'terminal') {
      viewer.rows = rows;
      const current = () => this.sessions.get(session.id) === session && session.viewers.includes(viewer);
      viewer.history = new HerdrScrollback({
        rows: () => viewer.rows ?? session.rows,
        readHistory: async lines => {
          const response = await this.request('pane.read', {
            pane_id: session.paneId, source: 'recent', format: 'text', strip_ansi: true, lines,
          });
          const read = response.result?.read as { text?: string } | undefined;
          if (typeof read?.text !== 'string') throw new Error('History unavailable');
          return read.text;
        },
        // A private viewer refresh must not consume the broadcast revision: other
        // viewers still need the next changed-screen notification.
        readLive: () => this.readScreen(session, false),
        output: data => { if (current()) this.opts.onTerminalOutput?.(session, viewer, data); },
        error: () => { if (current()) this.opts.onScrollError?.(session, viewer); },
      });
    }
    if (presentation === 'mobile' && mobilePatches && mobile) {
      viewer.mobilePatches = true;
      viewer.mobileSnapshot = mobile.transcript;
    }
    session.viewers.push(viewer);
    this.startWatching(session);
    return {
      screen,
      mobileTranscript: viewer.mobilePatches ? mobile?.transcript : undefined,
    };
  }

  async resyncMobileViewer(
    session: HerdrSession,
    clientId: number,
    sid: number,
  ): Promise<MobileTranscriptSnapshot | undefined> {
    const viewer = session.viewers.find((candidate) =>
      candidate.clientId === clientId && candidate.sid === sid && candidate.mobilePatches,
    );
    if (!viewer) return undefined;
    const mobile = await this.readMobilePresentation(session);
    viewer.mobileSnapshot = mobile.transcript;
    return mobile.transcript;
  }

  removeViewersForClient(clientId: number): void {
    for (const session of this.sessions.values()) {
      for (const viewer of session.viewers) if (viewer.clientId === clientId) {
        viewer.terminal?.close(); viewer.history?.close();
      }
      session.viewers = session.viewers.filter((viewer) => viewer.clientId !== clientId);
    }
    const marker = `\0client:${clientId}:`;
    for (const key of this.inputDecoders.keys()) {
      if (key.includes(marker)) this.inputDecoders.delete(key);
    }
  }

  writeViewer(session: HerdrSession, clientId: number, sid: number, data: Buffer): Promise<void> {
    const viewer = session.viewers.find((v) => v.clientId === clientId && v.sid === sid);
    if (!viewer) return Promise.resolve();
    if (viewer.terminal) { viewer.terminal.write(data); return Promise.resolve(); }
    viewer.history?.resume();
    return this.write(session, data, `client:${clientId}:${sid}`);
  }

  scrollViewer(session: HerdrSession, clientId: number, sid: number, direction: 'up' | 'down', lines: number): boolean {
    const viewer = session.viewers.find(v => v.clientId === clientId && v.sid === sid);
    if (!viewer || (!viewer.terminal && !viewer.history)) return false;
    if (viewer.terminal) viewer.terminal.scroll(direction, lines);
    else viewer.history?.scroll(direction, lines);
    return true;
  }

  resizeViewer(session: HerdrSession, clientId: number, sid: number, cols: number, rows: number): void {
    const viewer = session.viewers.find((v) => v.clientId === clientId && v.sid === sid);
    if (viewer) { viewer.rows = rows; viewer.terminal?.resize(cols, rows); }
  }

  write(session: HerdrSession, data: Buffer, inputSource = 'default'): Promise<void> {
    // Raw TTY input commonly arrives as one WebSocket frame per key. Keep all
    // requests for a pane ordered so a later Enter cannot overtake preceding
    // text while separate pane.send_input socket calls are still in flight.
    const previous = this.inputTails.get(session.id) || Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.writeNow(session, data, inputSource));
    this.inputTails.set(session.id, current);
    return current.finally(() => {
      if (this.inputTails.get(session.id) === current) this.inputTails.delete(session.id);
    });
  }

  /** Close a pane through Herdr itself, preserving Herdr as lifecycle owner. */
  async close(session: HerdrSession): Promise<void> {
    await this.request('pane.close', { pane_id: session.paneId });
    this.inputTails.delete(session.id);
    const prefix = `${session.id}\0`;
    for (const key of this.inputDecoders.keys()) {
      if (key.startsWith(prefix)) this.inputDecoders.delete(key);
    }
    if (this.sessions.delete(session.id)) this.opts.onExit(session);
  }

  private async writeNow(session: HerdrSession, data: Buffer, inputSource: string): Promise<void> {
    const decoderKey = `${session.id}\0${inputSource}`;
    let decoder = this.inputDecoders.get(decoderKey);
    if (!decoder) {
      decoder = new TerminalInputDecoder();
      this.inputDecoders.set(decoderKey, decoder);
    }
    for (const part of decoder.decode(data)) {
      await this.request('pane.send_input', { pane_id: session.paneId, ...part });
    }
  }

  async getPreview(session: HerdrSession): Promise<string | undefined> {
    if (session.previewRevision === session.revision) return session.preview;
    try {
      const response = await this.request('pane.read', {
        pane_id: session.paneId,
        // History reads can drive the application's own scrollback on alternate
        // screens. Background observation must never send implicit input.
        source: 'visible',
        format: 'text',
        strip_ansi: true,
      }, 2_000);
      const read = response.result?.read as { text?: string; revision?: number } | undefined;
      if (!read) return session.preview;
      session.preview = extractPanePreview(read.text || '');
      session.previewRevision = typeof read.revision === 'number' ? read.revision : session.revision;
      return session.preview;
    } catch {
      return session.preview;
    }
  }

  /** Capture the current viewport without driving the running Agent's UI. */
  async getContext(session: HerdrSession): Promise<string | undefined> {
    if (session.contextRevision === session.revision) return session.context;
    try {
      const response = await this.request('pane.read', {
        pane_id: session.paneId,
        source: 'visible',
        format: 'text',
        strip_ansi: true,
      }, 3_000);
      const read = response.result?.read as { text?: string; revision?: number } | undefined;
      if (!read) return session.context;
      const text = (read.text || '').trim();
      session.context = text.length <= 16_000 ? text : text.slice(text.length - 16_000);
      session.contextRevision = typeof read.revision === 'number' ? read.revision : session.revision;
      if (text) {
        session.preview = extractPanePreview(text) || session.preview;
        session.previewRevision = session.contextRevision;
      }
      return session.context;
    } catch {
      return session.context;
    }
  }

  private async readScreen(
    session: HerdrSession,
    cache = true,
  ): Promise<Buffer> {
    const response = await this.request('pane.read', {
      pane_id: session.paneId,
      source: 'visible',
      format: 'ansi',
      strip_ansi: false,
    });
    const read = response.result?.read as { text?: string; revision?: number } | undefined;
    if (!read) throw new Error(`Herdr returned no screen for ${session.paneId}`);
    if (cache && typeof read.revision === 'number') session.revision = Math.max(session.revision, read.revision);
    const text = read.text || '';
    if (cache) session.lastScreen = text;
    return Buffer.from(REDRAW + text, 'utf8');
  }

  private async readMobilePresentation(session: HerdrSession): Promise<{
    screen: Buffer;
    transcript: MobileTranscriptSnapshot;
  }> {
    const response = await this.request('pane.read', {
      pane_id: session.paneId,
      // Do not recover history by scrolling the desktop. Full conversation
      // history belongs to the provider-record-backed Agent Chat view.
      source: 'visible',
      format: 'ansi',
      strip_ansi: false,
    });
    const read = response.result?.read as { text?: string; revision?: number } | undefined;
    if (!read) throw new Error(`Herdr returned no mobile transcript for ${session.paneId}`);
    const revision = typeof read.revision === 'number' ? read.revision : session.revision;
    session.revision = Math.max(session.revision, revision);
    const text = read.text || '';
    const links = await this.resolveTranscriptLinks(session);
    return {
      screen: renderMobilePaneText(text),
      transcript: { revision, lines: parseMobileTranscript(text, links) },
    };
  }

  private async readScreens(session: HerdrSession, terminal?: Buffer): Promise<HerdrScreens> {
    const screens: HerdrScreens = { terminal: terminal || await this.readScreen(session) };
    if (session.viewers.some((viewer) => viewer.presentation === 'mobile')) {
      const mobile = await this.readMobilePresentation(session);
      screens.mobile = mobile.screen;
      screens.mobileTranscript = mobile.transcript;
    }
    return screens;
  }

  private async emitScreenIfChanged(session: HerdrSession): Promise<void> {
    const previousScreen = session.lastScreen;
    const previousRevision = session.revision;
    const screen = await this.readScreen(session);
    if (session.lastScreen === previousScreen && session.revision === previousRevision) return;
    this.opts.onOutput(session, await this.readScreens(session, screen));
  }

  private startWatching(session: HerdrSession): void {
    if (session.watching) return;
    session.watching = true;
    void this.watch(session);
  }

  private async watch(session: HerdrSession): Promise<void> {
    try {
      while (session.viewers.length > 0 && this.sessions.get(session.id) === session) {
        try {
          if (this.outputMode === 'poll') {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            await this.emitScreenIfChanged(session);
            continue;
          }
          await this.request(
            'events.wait',
            {
              match_event: { event: 'pane_output_changed', pane_id: session.paneId, min_revision: session.revision },
              timeout_ms: WAIT_TIMEOUT_MS,
            },
            WAIT_TIMEOUT_MS + LOCAL_TIMEOUT_GRACE_MS,
          );
          await this.emitScreenIfChanged(session);
        } catch (error) {
          if (/pane_not_found/i.test((error as Error).message)) {
            this.sessions.delete(session.id);
            this.opts.onExit(session);
            break;
          }
          if (/unsupported_event_wait_match/i.test((error as Error).message)) {
            this.outputMode = 'poll';
            if (!this.pollingAnnounced) {
              this.pollingAnnounced = true;
              this.opts.log?.('[host] Herdr output wait is unavailable; using attached-pane screen polling');
            }
            continue;
          }
          // Herdr reports wait timeouts as ordinary API errors. Use the timeout
          // as a low-frequency heartbeat so a missed event cannot freeze a
          // Working pane indefinitely.
          if (/timeout/i.test((error as Error).message)) {
            try {
              await this.emitScreenIfChanged(session);
            } catch (readError) {
              if (/pane_not_found/i.test((readError as Error).message)) {
                this.sessions.delete(session.id);
                this.opts.onExit(session);
                break;
              }
            }
            continue;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    } finally {
      session.watching = false;
      if (session.viewers.length > 0 && this.sessions.get(session.id) === session) this.startWatching(session);
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 5_000): Promise<ApiResponse> {
    const id = `tb-herdr-${process.pid}-${++this.seq}`;
    return new Promise<ApiResponse>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = '';
      let settled = false;
      const finish = (error?: Error, response?: ApiResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(response!);
      };
      const timer = setTimeout(() => finish(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
      socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as ApiResponse;
          if (response.id !== id) return finish(new Error(`unexpected Herdr response id ${response.id}`));
          if (response.error) return finish(new Error(`${response.error.code}: ${response.error.message}`));
          finish(undefined, response);
        } catch (error) {
          finish(error as Error);
        }
      });
      socket.on('error', (error) => finish(error));
      socket.on('close', () => {
        if (!settled) finish(new Error(`Herdr closed the socket during ${method}`));
      });
    });
  }
}
