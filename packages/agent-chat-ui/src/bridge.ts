/**
 * The message contract between a native shell and this conversation surface.
 *
 * The shell owns the network, the composer, the clipboard and every system
 * permission; the surface owns only what the transcript looks like. Keeping
 * that split explicit is what lets the same page sit inside WinUI 3 today and a
 * different native shell later without either side growing the other's job.
 */

import type {
  AgentChatCapabilities,
  AgentChatDeliveryState,
  AgentChatMessage,
  AgentChatStatus,
} from '@termbridge/agent-chat';

/** Shell → surface. */
export type ShellMessage =
  | {
    op: 'snapshot';
    generation: number;
    status: AgentChatStatus;
    capabilities: AgentChatCapabilities;
    messages: AgentChatMessage[];
    earlierCursor?: number;
    error?: string;
    /**
     * Whether this shell offers its own way back through history.
     *
     * Only a shell that says so gets the tidier behaviour where the inline
     * control waits until the reader scrolls up. A shell without a menu keeps a
     * compact inline entry, because on a page too short to scroll that is the
     * only way back — and silently removing it would strand the history.
     */
    historyMenu?: boolean;
  }
  | {
    op: 'append';
    generation: number;
    status: AgentChatStatus;
    capabilities: AgentChatCapabilities;
    messages: AgentChatMessage[];
  }
  | { op: 'earlier'; generation: number; messages: AgentChatMessage[]; cursor?: number; atHead: boolean }
  | { op: 'theme'; theme: 'light' | 'dark' | 'system' }
  /**
   * The send the native composer is waiting on, so its receipt is drawn next to
   * the words it belongs to. Omitting `state` removes the row, which is what a
   * shell does once the Agent's own record carries the message.
   */
  | { op: 'pending'; id: string; text: string; state?: AgentChatDeliveryState; error?: string; messageId?: string }
  /** The reader asked for history from the shell's menu. */
  | { op: 'load-earlier' }
  | { op: 'clear' };

/** Surface → shell. */
export type SurfaceMessage =
  | { op: 'ready' }
  | { op: 'earlier'; generation: number; cursor: number }
  | { op: 'copy'; data: string }
  | { op: 'open'; url: string }
  /** The surface asks the shell to show this session's terminal instead. */
  | { op: 'terminal' };

/** Narrow an untrusted `postMessage` payload to a shell message. */
export function readShellMessage(value: unknown): ShellMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const op = (value as { op?: unknown }).op;
  if (op === 'snapshot' || op === 'append' || op === 'earlier' || op === 'theme' || op === 'pending'
    || op === 'load-earlier' || op === 'clear') {
    return value as ShellMessage;
  }
  return undefined;
}
