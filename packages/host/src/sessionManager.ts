import ptyPkg from 'node-pty';
import type { IPty, IDisposable } from 'node-pty';
import type { SessionBackend, SpawnSpec } from './backend.js';

const { spawn } = ptyPkg;

/** Safe to send to clients: never includes argv, environment or private paths. */
export class TerminalSpawnError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const exhausted = /openpty|forkpty|posix_openpt|EMFILE|ENFILE|ENOSPC|ENXIO|Too many open files|Device not configured/i.test(detail);
    super(exhausted
      ? 'Cannot start terminal: 终端句柄耗尽 (PTY handles exhausted). Restart the Host to release terminal handles.'
      : 'Cannot start terminal: PTY launch failed. Check the command, working directory and Host log.');
    this.name = 'TerminalSpawnError';
  }
}

/** A viewer = one (clientId, sid) pair attached to a session. */
export interface Viewer {
  clientId: number;
  sid: number;
}

export interface Session {
  id: string;
  command: string;
  /** Working directory used to launch the session; review paths resolve from here. */
  cwd: string;
  /** The raw (command, args) to (re)spawn — used by `restart`, pre-backend-wrap. */
  spawnSpec: SpawnSpec;
  /** Display name shown in `ls` (agent preset name, or command basename). */
  label: string;
  pty: IPty;
  cols: number;
  rows: number;
  createdAt: number;
  /** Ring of recent output so re-attaching viewers see context (tmux-style). */
  scrollback: Buffer[];
  scrollbackBytes: number;
  viewers: Viewer[];
}

const SCROLLBACK_LIMIT = 512 * 1024; // 512 KB per session

export type OutputHandler = (session: Session, data: Buffer) => void;
export type ExitHandler = (session: Session, exitCode: number) => void;

/**
 * Owns all PTYs on this host. Sessions outlive the viewer that created them —
 * a session dies only when its process exits or someone kills it. Any number
 * of viewers can mirror the same session; input from any controller is written
 * to the shared PTY, output is broadcast to every viewer.
 *
 * What the pty actually runs is decided by the injected `SessionBackend`:
 * `direct` spawns the command (exit ends the session), `tmux` wraps it so the
 * session survives the command exiting and the host restarting.
 */
export class SessionManager {
  readonly sessions = new Map<string, Session>();
  private seq = 0;
  private closed = false;
  private readonly listeners = new Map<Session, IDisposable[]>();

  constructor(
    private readonly onOutput: OutputHandler,
    private readonly onExit: ExitHandler,
    private readonly backend: SessionBackend,
  ) {}

  create(opts: {
    command?: string;
    args?: string[];
    cwd?: string;
    cols: number;
    rows: number;
    label?: string;
    env?: Record<string, string>;
    durable?: boolean;
    onCreated?: (session: Session) => void;
  }): Session {
    if (this.closed) throw new Error('Session manager is closed');
    const id = `sess-${++this.seq}`;
    const command = opts.command || process.env.SHELL || 'bash';
    const spawnSpec: SpawnSpec = { command, args: opts.args ?? [] };
    // Reverse-tool-channel env: TB_SESSION ties a `tb peer` run inside this
    // session back to the right client; the host-global socket + token (set at
    // boot) authorise the call. Injected into the pty env AND handed to the
    // backend so tmux can carry them across with `-e`.
    const bridgeEnv: Record<string, string> = { TB_SESSION: id, ...opts.env };
    if (process.env.TB_BRIDGE_SOCK) bridgeEnv.TB_BRIDGE_SOCK = process.env.TB_BRIDGE_SOCK;
    if (process.env.TB_BRIDGE_TOKEN) bridgeEnv.TB_BRIDGE_TOKEN = process.env.TB_BRIDGE_TOKEN;
    // The backend may wrap the command (e.g. run it inside tmux); the pty spawns
    // the wrapped form, but we keep the raw spec around for `restart`.
    const wrapped = opts.durable === false ? spawnSpec : this.backend.wrap(id, spawnSpec, bridgeEnv);
    const cwd = opts.cwd || process.env.HOME || process.cwd();
    let pty: IPty;
    try {
      pty = spawn(wrapped.command, wrapped.args, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd,
        env: { ...(process.env as Record<string, string>), ...bridgeEnv },
      });
    } catch (error) {
      throw new TerminalSpawnError(error);
    }

    const session: Session = {
      id,
      command,
      cwd,
      spawnSpec,
      label: opts.label || command.split('/').pop() || command,
      pty,
      cols: opts.cols,
      rows: opts.rows,
      createdAt: Date.now(),
      scrollback: [],
      scrollbackBytes: 0,
      viewers: [],
    };
    this.sessions.set(session.id, session);

    const dataListener = pty.onData((d) => {
      if (!this.sessions.has(session.id)) return;
      const buf = Buffer.from(d, 'utf8');
      this.pushScrollback(session, buf);
      this.onOutput(session, buf);
    });
    const exitListener = pty.onExit(({ exitCode }) => this.finish(session, exitCode));
    this.listeners.set(session, [dataListener, exitListener]);

    // Synchronous association precedes any asynchronous process exit. If setup
    // throws, ownership still belongs here and the new PTY must be released.
    try { opts.onCreated?.(session); }
    catch (error) { this.kill(session); throw error; }

    return session;
  }

  private finish(s: Session, exitCode: number): void {
    if (this.sessions.get(s.id) !== s) return;
    this.sessions.delete(s.id); // retire before external callbacks can re-enter
    for (const listener of this.listeners.get(s) ?? []) listener.dispose();
    this.listeners.delete(s);
    try {
      // node-pty's Unix kill() only signals the child. On macOS an EIO can
      // emit onExit while the tty.ReadStream still owns /dev/ptmx. destroy()
      // closes that stream and its write queue; deleting the session cannot.
      (s.pty as IPty & { destroy?: () => void }).destroy?.();
    } finally {
      try { this.onExit(s, exitCode); }
      finally { s.viewers.length = 0; s.scrollback.length = 0; s.scrollbackBytes = 0; }
    }
  }

  private pushScrollback(s: Session, buf: Buffer): void {
    s.scrollback.push(buf);
    s.scrollbackBytes += buf.length;
    while (s.scrollbackBytes > SCROLLBACK_LIMIT && s.scrollback.length > 1) {
      s.scrollbackBytes -= s.scrollback.shift()!.length;
    }
  }

  getScrollback(s: Session): Buffer {
    return Buffer.concat(s.scrollback);
  }

  write(s: Session, data: Buffer): void {
    if (this.sessions.get(s.id) !== s) return;
    s.pty.write(data.toString('utf8'));
  }

  resize(s: Session, cols: number, rows: number): void {
    if (this.sessions.get(s.id) !== s) return;
    try {
      s.pty.resize(cols, rows);
      s.cols = cols;
      s.rows = rows;
    } catch {
      /* pty may already be gone */
    }
  }

  /** Respawn a session's command in place (backend-dependent). False if unsupported. */
  restart(s: Session): boolean {
    if (this.sessions.get(s.id) !== s) return false;
    return this.backend.restart?.(s.id, s.spawnSpec) ?? false;
  }

  kill(s: Session): void {
    if (this.sessions.get(s.id) !== s) return;
    try { this.backend.cleanup?.(s.id); }
    finally {
      try { s.pty.kill(process.platform === 'win32' ? undefined : 'SIGKILL'); }
      finally { this.finish(s, 137); }
    }
  }

  /** Host shutdown detaches tmux clients; durable backend sessions survive. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.sessions.values()) {
      try { s.pty.kill(); }
      catch { /* process may already have exited */ }
      try { this.finish(s, 129); }
      catch { /* one callback must not prevent releasing the other PTYs */ }
    }
  }

  addViewer(s: Session, clientId: number, sid: number): void {
    if (this.sessions.get(s.id) !== s) return;
    s.viewers.push({ clientId, sid });
  }

  removeViewersForClient(clientId: number): void {
    for (const s of this.sessions.values()) {
      s.viewers = s.viewers.filter((v) => v.clientId !== clientId);
    }
  }
}
