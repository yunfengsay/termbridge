import type { AgentChatCapabilities, AgentChatProvider } from './types.js';

/**
 * What an external, Herdr-owned session can actually offer.
 *
 * Sending works because Herdr already owns a verified input channel to the
 * pane. Images ride that same channel: the Host stores the bytes and the
 * message names the resulting path, which is exactly what the terminal composer
 * has always done, so the Agent reads them the same way — hence `attachments`
 * tracks `send` rather than being a separate promise.
 *
 * Everything still requiring a structured control channel — approvals, typed
 * questions, a real stop that is not a guessed keystroke — is off until an
 * adapter can do it for real. A client disables those controls; it never
 * simulates them with terminal keys.
 */
export function externalSessionCapabilities(options: {
  provider: AgentChatProvider;
  history: boolean;
  send: boolean;
  degraded?: string;
}): AgentChatCapabilities {
  return {
    history: options.history,
    send: options.send,
    stop: false,
    attachments: options.send,
    fileAttachments: options.send,
    approvals: false,
    questions: false,
    terminal: true,
    ...(options.degraded ? { degraded: options.degraded } : {}),
  };
}

/** The reason shown when no structured record backs a session. */
export const NO_STRUCTURED_HISTORY =
  '这个会话没有可读的结构化记录，对话模式不可用；请使用终端视图。';
