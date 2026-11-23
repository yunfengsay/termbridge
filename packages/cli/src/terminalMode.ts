const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';
const SHOW_CURSOR = '\x1b[?25h';

function isHerdrSession(sessionId: string | undefined): boolean {
  return sessionId?.startsWith('herdr:') === true;
}

export function terminalEnterSequence(sessionId: string | undefined): string {
  return isHerdrSession(sessionId) ? '\x1b[?1049h' + ENABLE_BRACKETED_PASTE : '';
}

export function terminalOutputSuffix(sessionId: string | undefined): string {
  return ''; // The native stream owns cursor position and visibility.
}

export function terminalExitSequence(sessionId: string | undefined): string {
  return isHerdrSession(sessionId) ? DISABLE_BRACKETED_PASTE + SHOW_CURSOR + '\x1b[?1049l' : '';
}
