import pc from 'picocolors';
import Table from 'cli-table3';

export { pc };

const sym = { ok: '✔', err: '✖', info: 'ℹ', active: '●', idle: '○' };

/** One-line status helpers (go to stderr so they never pollute piped stdout). */
export const ok = (msg: string) => console.error(`${pc.green(sym.ok)} ${msg}`);
export const fail = (msg: string) => console.error(`${pc.red(sym.err)} ${pc.red(msg)}`);
export const info = (msg: string) => console.error(`${pc.cyan(sym.info)} ${msg}`);
export const muted = (msg: string) => console.error(pc.dim(msg));

const ROUND = {
  top: '─', 'top-mid': '┬', 'top-left': '╭', 'top-right': '╮',
  bottom: '─', 'bottom-mid': '┴', 'bottom-left': '╰', 'bottom-right': '╯',
  left: '│', 'left-mid': '├', mid: '─', 'mid-mid': '┼', right: '│', 'right-mid': '┤', middle: '│',
};

function table(head: string[]): InstanceType<typeof Table> {
  return new Table({
    head: head.map((h) => pc.dim(pc.bold(h))),
    style: { head: [], border: [] }, // we colour cells ourselves
    chars: ROUND,
  });
}

export interface SessionRow {
  sessionId: string;
  command: string; // display label (agent name / command)
  viewers: number;
  source?: 'pty' | 'herdr';
  paneId?: string;
  status?: string;
}

/** Rounded, coloured table for `tb ls`. `active` = someone is attached. */
export function renderSessions(sessions: SessionRow[]): string {
  const t = table(['#', 'session', 'source', 'id', 'viewers', 'status']);
  for (const s of sessions) {
    const n = s.source === 'herdr' ? (s.paneId || s.sessionId.replace(/^herdr:/, '')) : s.sessionId.replace(/^sess-/, '');
    const active = s.viewers > 0;
    const status = s.source === 'herdr'
      ? s.status || 'unknown'
      : active
        ? 'active'
        : 'idle';
    t.push([
      pc.bold(n),
      pc.cyan(s.command),
      s.source === 'herdr' ? pc.magenta('Herdr') : pc.dim('PTY'),
      pc.dim(s.sessionId),
      active ? String(s.viewers) : pc.dim('0'),
      status === 'working' || status === 'active'
        ? pc.green(`${sym.active} ${status}`)
        : pc.dim(`${sym.idle} ${status}`),
    ]);
  }
  return t.toString();
}

/** Table for `tb info` / `tb set` — agent name → the command it actually runs. */
export function renderAgents(agents: Record<string, string>): string {
  const t = table(['agent', 'runs']);
  const names = Object.keys(agents);
  if (names.length === 0) return pc.dim('  (no agents — add one:  tb set claude "proxy && claude")');
  for (const name of names) t.push([pc.cyan(name), agents[name]]);
  return t.toString();
}
