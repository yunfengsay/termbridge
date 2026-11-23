import { spawnSync } from 'node:child_process';

/**
 * A session's process is launched through a pluggable BACKEND. The backend
 * decides what the pty actually runs and whether a session outlives its command:
 *
 *  - `direct` — spawn the command directly (the original behaviour). When the
 *               command exits, the pty exits and the session is gone. No restore.
 *  - `tmux`   — run the command inside a tmux session on a DEDICATED server
 *               (`tmux -L <socket>`, isolated from the user's own tmux) with a
 *               global `remain-on-exit on`. When the command exits the pane is
 *               KEPT (a dead pane), so its output stays and the client isn't torn
 *               down; `tb restart` respawns it. The tmux session lives on its own
 *               server, so it survives the host process — and the whole machine —
 *               restarting.
 *
 * Chosen by env `TB_BACKEND` — **default `direct`** (feels like a normal local
 * terminal: native CJK/locale, no status bar, a clean exit). `tmux` is opt-in
 * for durable sessions; if requested but not installed we fall back to `direct`.
 * Replaceable: add a class implementing SessionBackend.
 */
export interface SpawnSpec {
  command: string;
  args: string[];
}

export interface SessionBackend {
  readonly name: 'tmux' | 'direct';
  /** Does a session survive its command exiting / the host restarting? */
  readonly durable: boolean;
  /** One-time setup at host boot (e.g. start the tmux keeper + global options). */
  init?(): void;
  /**
   * Transform a session's raw (command, args) into what the pty actually spawns.
   * `env` carries the reverse-tool-channel vars (TB_SESSION/SOCK/TOKEN); a
   * backend that runs the command in a detached context (tmux) must propagate
   * them itself (the pty's own env doesn't reach the tmux server's child).
   */
  wrap(key: string, spec: SpawnSpec, env?: Record<string, string>): SpawnSpec;
  /** Respawn a session's process in place. Returns false if unsupported. */
  restart?(key: string, spec: SpawnSpec): boolean;
  /** Tear down backend-side state when a session is killed. */
  cleanup?(key: string): void;
}

class DirectBackend implements SessionBackend {
  readonly name = 'direct' as const;
  readonly durable = false;
  wrap(_key: string, spec: SpawnSpec, _env?: Record<string, string>): SpawnSpec {
    return spec; // spawn the command as-is (the pty env already carries TB_SESSION/SOCK/TOKEN)
  }
}

const KEEPER = '__tb_keeper__';

class TmuxBackend implements SessionBackend {
  readonly name = 'tmux' as const;
  readonly durable = true;
  // A dedicated server keeps termbridge sessions in their own namespace, apart
  // from any tmux the user runs by hand. Override for isolation (the test suite).
  private readonly socket = process.env.TB_TMUX_SOCKET || 'termbridge';

  /** A UTF-8 locale (the user's, if already UTF-8, else en_US.UTF-8). tmux needs
   * one or it mis-measures wide/CJK glyphs and 中文 renders as blanks/boxes — the
   * LaunchAgent host runs in a bare C locale, which is exactly that bug. */
  private utf8(): string {
    const cur = process.env.LC_ALL || process.env.LANG || '';
    return /utf-?8/i.test(cur) ? cur : 'en_US.UTF-8';
  }

  private tmux(args: string[]) {
    const loc = this.utf8(); // the server (started by the first call) takes this locale
    return spawnSync('tmux', ['-L', this.socket, ...args], {
      encoding: 'utf8',
      env: { ...process.env, LANG: loc, LC_ALL: loc },
    });
  }

  /** tmux session name for our session id (`sess-N` → `tb-sess-N`; `-` is legal). */
  private tname(key: string): string {
    return `tb-${key}`;
  }

  /**
   * Keep the pane's PTY open for one short drain window after the child exits.
   * Without this, tmux can mark an instantly-exiting pane dead before consuming
   * its final output (notably on Linux), so clients see only the dead-pane
   * status. The wrapper preserves both argv boundaries and the child's status.
   */
  private drained(spec: SpawnSpec): string[] {
    return ['sh', '-c', '"$@"; rc=$?; sleep 0.05; exit "$rc"', 'sh', spec.command, ...spec.args];
  }

  init(): void {
    // A tmux server with zero sessions exits, which would drop our global option;
    // an immortal keeper session holds the server open (and keeps `tb-*` sessions
    // reachable across host restarts). Then set `remain-on-exit` GLOBALLY so every
    // new session inherits it the instant it's created — no per-session race that
    // could close a fast-exiting pane before we could set the option on it.
    this.tmux(['new-session', '-d', '-s', KEEPER, '--', 'sh', '-c', 'while :; do sleep 86400; done']);
    this.tmux(['set-option', '-g', 'remain-on-exit', 'on']);
    // Render like a normal modern terminal, not a managed tmux: a 256-color TERM,
    // truecolor passthrough, and NO status bar (this tmux is a transparent
    // transport, not something the user drives) — best-effort, ignore failures.
    this.tmux(['set-option', '-g', 'default-terminal', 'tmux-256color']);
    this.tmux(['set-option', '-ga', 'terminal-overrides', ',*:Tc']);
    this.tmux(['set-option', '-g', 'status', 'off']);
  }

  wrap(key: string, spec: SpawnSpec, env?: Record<string, string>): SpawnSpec {
    // The pty attaches to (creating if absent) the tmux session — this process IS
    // the terminal. remain-on-exit is inherited from the global set in init().
    // `-e KEY=VAL` puts the bridge vars into the tmux session's environment so a
    // `tb peer` run inside it can find the host socket (the tmux server's child
    // does NOT inherit our pty's env). Applied on creation; tmux ≥ 3.0.
    const eFlags: string[] = ['-e', `LANG=${this.utf8()}`]; // UTF-8 for the program too (CJK I/O)
    for (const [k, v] of Object.entries(env ?? {})) eFlags.push('-e', `${k}=${v}`);
    return {
      command: 'tmux',
      args: ['-L', this.socket, 'new-session', '-A', '-s', this.tname(key), ...eFlags, '--', ...this.drained(spec)],
    };
  }

  restart(key: string, spec: SpawnSpec): boolean {
    // -k kills the dead pane's remains, then respawns the same command in place.
    // Anyone attached sees it come back to life (same tmux session).
    const r = this.tmux(['respawn-pane', '-k', '-t', this.tname(key), '--', ...this.drained(spec)]);
    return r.status === 0;
  }

  cleanup(key: string): void {
    // Kill the tmux session for real (pty.kill alone only detaches our client).
    this.tmux(['kill-session', '-t', this.tname(key)]);
  }
}

export function hasTmux(): boolean {
  try {
    return spawnSync('tmux', ['-V']).status === 0;
  } catch {
    return false;
  }
}

/** Pick the backend from env. Default `direct`; `tmux` is opt-in (and degrades to
 * `direct` if tmux isn't installed). */
export function pickBackend(): SessionBackend {
  const want = (process.env.TB_BACKEND || 'direct').toLowerCase();
  if (want !== 'tmux') return new DirectBackend();
  if (hasTmux()) return new TmuxBackend();
  console.error(
    '[host] TB_BACKEND=tmux but tmux is not installed — using `direct` instead ' +
      '(a command exiting ends the session; no restore). Install tmux for durable sessions.',
  );
  return new DirectBackend();
}
