import { AttachInput } from './attachInput.js';
import { hostname } from 'node:os';
import { WebSocket } from 'ws';
import * as p from '@clack/prompts';
import {
  parseFrame,
  FrameType,
  encodeControl,
  framePtyIn,
  framePtyResize,
} from '@termbridge/protocol';
import {
  resolveRelayUrl,
  getMiddle,
  resolveSecret,
  hmacHex,
  relayWsOptions,
  resolvePin,
  fingerprintMatches,
} from '@termbridge/settings';
import { pc, ok, fail, muted, renderSessions, renderAgents } from './ui.js';
import { executeTool } from './peerExecutor.js';
import { desktopPeerRegistration, resolvePeerDeviceId } from './peerIdentity.js';
import {
  terminalEnterSequence,
  terminalExitSequence,
  terminalOutputSuffix,
} from './terminalMode.js';

// env RELAY_URL > configured middle (`tb middle set`) > local `tb surf` relay.
const relayUrl = () => resolveRelayUrl();
const NOT_RUNNING = 'cannot reach relay — is `tb surf` (or your middle) running?';
// Half-open detection: the relay pings every 30s. If nothing arrives for 70s the
// link is silently dead — drop it so the 3s reconnect loop can re-attach.
const HEARTBEAT_TIMEOUT_MS = 70_000;

/**
 * Answer the relay's auth_challenge (HMAC of the nonce, or an empty mac when no
 * password is configured), then send hello + the caller's first request. Adds a
 * dedicated 'message' listener; callers keep their own for the actual replies
 * (they switch on their expected `t` and ignore auth_challenge).
 */
export function handshake(ws: WebSocket, host: string, afterHello?: (ws: WebSocket) => void, wantsHosts = false): void {
  ws.on('message', (raw) => {
    const f = parseFrame(raw as Buffer);
    if (f.type === FrameType.Control && f.msg.t === 'auth_challenge') {
      ws.send(encodeControl({ t: 'auth_response', mac: hmacHex(resolveSecret(), f.msg.nonce) }));
      ws.send(encodeControl({ t: 'hello', role: 'client', hostId: host, ...(wantsHosts ? { wantsHosts: true } : {}) }));
      afterHello?.(ws);
    }
  });
}

/**
 * Open a relay socket, enforcing the pinned TLS fingerprint on `wss://` links —
 * a mismatch is fatal (don't dial into a possible MITM). `ws://` is unaffected.
 */
export function dial(onFatal?: (error: Error) => void): WebSocket {
  const url = relayUrl();
  const ws = new WebSocket(url, relayWsOptions(url));
  const pin = resolvePin();
  if (pin && /^wss:/i.test(url)) {
    ws.on('upgrade', (res) => {
      const fp = (res.socket as { getPeerCertificate?: () => { fingerprint256?: string } })?.getPeerCertificate?.()?.fingerprint256;
      if (!fingerprintMatches(fp, pin)) {
        try {
          ws.terminate();
        } catch {
          /* noop */
        }
        if (onFatal) { onFatal(new Error('TLS fingerprint mismatch')); return; }
        fail(`TLS fingerprint mismatch — refusing ${url} (check \`tb middle pin\`)`);
        process.exit(1);
      }
    });
  }
  return ws;
}

export interface AttachOpts {
  host: string; // '' = the only/default host
  agent?: string; // preset name (resolved on host)
  command?: string; // raw command (direct exec)
  args?: string[];
  sessionId?: string; // attach existing instead of creating
}

/**
 * Create-or-attach a session and hand the terminal over (raw passthrough).
 *
 * Reconnects every 3s if the relay/host drops — the same retry contract the
 * host and middle honour, so a flaky link or a middle restart self-heals. Once
 * we learn our `sessionId` we *re-attach* (not re-create) on every reconnect,
 * replaying scrollback. Fatal errors (ambiguous host, vanished session) exit.
 */
export function runAttach(opts: AttachOpts): void {
  const peerRegistration = desktopPeerRegistration(resolvePeerDeviceId());
  const cols = () => process.stdout.columns ?? 80;
  const rows = () => process.stdout.rows ?? 24;
  let ws: WebSocket;
  let sid: number | null = null;
  let sessionId = opts.sessionId; // once known, reconnect re-attaches to it
  const input = new AttachInput();
  let nativeTerminal = false;
  let promptOutput: Buffer[] = [];
  let promptBytes = 0;
  let rawApplied = false;
  let stdinWired = false; // wire stdin → ws exactly once
  let everAttached = false;
  let closing = false; // user/process-initiated quit — suppress reconnect
  let terminalModeApplied = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let hbTimer: ReturnType<typeof setTimeout> | null = null;

  /** Reset the half-open watchdog; relay pings (and any data) keep it at bay. */
  function petHeartbeat(): void {
    if (hbTimer) clearTimeout(hbTimer);
    hbTimer = setTimeout(() => {
      try {
        ws.terminate(); // → 'close' → retry()
      } catch {
        /* noop */
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  function connect(): void {
    if (hbTimer) clearTimeout(hbTimer);
    ws = dial();
    const connection = ws;
    ws.on('open', petHeartbeat);
    ws.on('ping', petHeartbeat);

    handshake(ws, opts.host, (ws) => {
      // Re-register on every relay connection, independently of its session.
      ws.send(encodeControl(peerRegistration));
      if (sessionId) {
        ws.send(encodeControl({ t: 'attach', sessionId, cols: cols(), rows: rows(), nativeTerminal: sessionId.startsWith('herdr:') }));
      } else {
        ws.send(
          encodeControl({
            t: 'session_create',
            agent: opts.agent,
            command: opts.command,
            args: opts.args,
            cols: cols(),
            rows: rows(),
            clientPlatform: process.platform, // lets the host tell the agent which machine drives it
            clientName: hostname(),
          }),
        );
      }
    });

    ws.on('message', (raw) => {
      petHeartbeat(); // any traffic proves the link is alive
      const parsed = parseFrame(raw as Buffer);
      if (parsed.type === FrameType.PtyOut) {
        if (sid == null || parsed.sid !== sid) return;
        if (input.confirming) {
          if (!nativeTerminal) {
            promptOutput.push(parsed.data);
            promptBytes += parsed.data.length;
            if (promptBytes > 8 * 1024 * 1024) cancelPrompt();
          }
          return;
        }
        process.stdout.write(parsed.data);
        const suffix = process.stdout.isTTY ? terminalOutputSuffix(sessionId) : '';
        if (suffix) process.stdout.write(suffix);
        return;
      }
      if (parsed.type !== FrameType.Control) return;

      const msg = parsed.msg;
      switch (msg.t) {
        case 'session_created':
        case 'attach_ok':
          if (msg.t === 'attach_ok' && msg.sessionId.startsWith('herdr:') && msg.nativeTerminal !== true) {
            fail('Herdr native terminal requires an updated TB Host (0.1.24 or later).');
            shutdown(1);
            return;
          }
          nativeTerminal = msg.t === 'attach_ok' && msg.nativeTerminal === true;
          sid = msg.sid;
          sessionId = msg.sessionId; // remember across reconnects
          if (!everAttached) {
            everAttached = true;
            ok(`${pc.bold(opts.agent ?? msg.sessionId)} ${pc.dim('attached · Ctrl-C interrupts · Ctrl-] connection menu')}`);
          } else {
            muted('\n— reconnected —');
          }
          startTerminal();
          break;
        case 'session_exit':
          restoreTty();
          muted(`\n— exited (${msg.exitCode}) —`);
          shutdown(msg.exitCode ?? 0);
          break;
        case 'error':
          // Ambiguous host or a session that no longer exists is terminal;
          // anything else (host not online yet) is worth retrying.
          if (/multiple hosts|no session|Herdr native terminal|^Cannot start terminal:/i.test(msg.message)) {
            restoreTty();
            fail(msg.message);
            shutdown(1);
          } else {
            try {
              ws.close();
            } catch {
              /* noop */
            }
            retry(msg.message);
          }
          break;
        case 'tool_request': {
          // The host's agent wants to run a tool on THIS machine. Execute it
          // locally (gated by `tb expose`, OFF by default) and reply. Async, so
          // it never blocks the terminal stream the user is watching.
          const { id, op, args } = msg;
          const requestingSocket = connection;
          executeTool(op, (args ?? {}) as Record<string, unknown>).then((r) => {
            // A result belongs to the original connection, never its replacement.
            if (requestingSocket.readyState === WebSocket.OPEN) {
              requestingSocket.send(
                encodeControl({ t: 'tool_response', id, ok: r.ok, exit: r.exit, stdout: r.stdout, stderr: r.stderr, data: r.data, error: r.error }),
              );
            }
          }).catch((error) => {
            if (requestingSocket.readyState === WebSocket.OPEN) {
              requestingSocket.send(encodeControl({ t: 'tool_response', id, ok: false, error: String((error as Error).message) }));
            }
          });
          break;
        }
        default:
          break;
      }
    });

    ws.on('close', () => {
      if (hbTimer) clearTimeout(hbTimer);
      retry(everAttached ? 'disconnected' : NOT_RUNNING);
    });
    ws.on('error', () => {
      /* 'close' always follows; it schedules the retry */
    });
  }

  /** Schedule a single reconnect; drops to cooked mode so Ctrl-C can quit while waiting. */
  function retry(why: string): void {
    if (closing || retryTimer) return;
    sid = null;
    if (!input.confirming) muted(`\n— ${why}; reconnecting in 3s (Ctrl-] or Ctrl-C for connection menu) —`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, 3000);
  }

  function startTerminal(): void {
    enterRaw();
    const sequence = everAttached && process.stdout.isTTY ? terminalEnterSequence(sessionId) : '';
    if (sequence && !terminalModeApplied) {
      process.stdout.write(sequence);
      terminalModeApplied = true;
    }
    if (stdinWired) return; // closures below read the live `ws`/`sid`
    stdinWired = true;
    process.stdin.resume();
    process.stdin.on('data', handleInput);
    process.stdout.on('resize', () => {
      if (sid != null && ws.readyState === WebSocket.OPEN) ws.send(framePtyResize(sid, cols(), rows()));
    });
  }
  function handleInput(data: Buffer): void {
    const connected = sid != null && ws?.readyState === WebSocket.OPEN;
    for (const event of input.feed(data, connected)) {
      if (event.type === 'input' && sid != null) ws.send(framePtyIn(sid, event.data));
      else if (event.type === 'prompt') {
        if (process.stdout.isTTY) process.stdout.write(`\x1b7\x1b[${rows()};1H\x1b[2K\x1b[0m\x1b[?25h`);
        process.stdout.write('TB: [d] detach (session keeps running), [Enter/c] continue: ');
      } else if (event.type === 'cancel') cancelPrompt();
      else if (event.type === 'detach') {
        restoreTty();
        muted('\n— detached; session kept running —');
        shutdown(0);
      }
    }
  }
  function cancelPrompt(): void {
    input.confirming = false;
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K\x1b8');
    for (const data of promptOutput) process.stdout.write(data);
    promptOutput = [];
    promptBytes = 0;
    // Herdr's resize contract repaints even at the same size, restoring the
    // exact cursor and screen hidden by the local connection menu.
    if (sid != null && ws.readyState === WebSocket.OPEN) ws.send(framePtyResize(sid, cols(), rows()));
  }
  function enterRaw(): void {
    if (!rawApplied && process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      rawApplied = true;
    }
  }
  function restoreTty(): void {
    if (terminalModeApplied) {
      process.stdout.write(terminalExitSequence(sessionId));
      terminalModeApplied = false;
    }
    if (rawApplied && process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      rawApplied = false;
    }
  }
  function shutdown(code: number): void {
    closing = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (hbTimer) clearTimeout(hbTimer);
    restoreTty();
    try {
      ws.close();
    } catch {
      /* noop */
    }
    process.exit(code);
  }

  process.on('SIGINT', () => handleInput(Buffer.from([3])));
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGHUP', () => shutdown(0));
  startTerminal(); // keep Ctrl-C under the same contract even while connecting
  connect();
}

/** Print the host's sessions as a table with short numbers + active markers. */
export function runList(host: string): void {
  const ws = dial();
  const spin = process.stdout.isTTY ? p.spinner() : null;
  spin?.start('loading sessions');
  let settled = false;

  handshake(ws, host, (ws) => ws.send(encodeControl({ t: 'session_list' })));
  ws.on('message', (raw) => {
    const f = parseFrame(raw as Buffer);
    if (f.type !== FrameType.Control) return;
    if (f.msg.t === 'session_list_result') {
      settled = true;
      const ss = f.msg.sessions;
      spin?.stop(pc.dim(`${ss.length} session${ss.length === 1 ? '' : 's'}`));
      if (ss.length === 0) {
        console.log(pc.dim('no sessions.  ') + 'start one:  ' + pc.cyan('tb new claude'));
      } else {
        console.log(renderSessions(ss));
        console.log(
          pc.dim('  attach ') + pc.cyan('tb <#|id>') +
            pc.dim('   ·   kill owned PTY ') + pc.cyan('tb kill <#>'),
        );
      }
      finish(0);
    } else if (f.msg.t === 'error') {
      settled = true;
      spin?.stop('');
      fail(f.msg.message);
      finish(1);
    }
  });
  ws.on('error', (e) => {
    spin?.stop('');
    fail((e as Error).message ? `${(e as Error).message}` : NOT_RUNNING);
    process.exit(1);
  });
  ws.on('close', () => {
    if (!settled) process.exit(1);
  });
  function finish(code: number) {
    try {
      ws.close();
    } catch {
      /* noop */
    }
    process.exit(code);
  }
}

/** Kill a session by id. */
export function runKill(host: string, sessionId: string): void {
  if (sessionId.startsWith('herdr:')) {
    fail(`${sessionId} is owned by Herdr; termbridge will not close it`);
    process.exit(1);
  }
  const ws = dial();
  handshake(ws, host, (ws) => {
    ws.send(encodeControl({ t: 'kill', sessionId }));
    ok(`killed ${pc.dim(sessionId)}`);
    setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      process.exit(0);
    }, 150);
  });
  ws.on('error', (e) => {
    fail((e as Error).message ? `${(e as Error).message}` : NOT_RUNNING);
    process.exit(1);
  });
}

/** `tb restart <#|id>` — respawn a dead session's command in place (tmux backend). */
export function runRestart(host: string, sessionId: string): void {
  const ws = dial();
  let settled = false;
  const finish = (code: number) => {
    settled = true;
    try {
      ws.close();
    } catch {
      /* noop */
    }
    process.exit(code);
  };
  handshake(ws, host, (ws) => ws.send(encodeControl({ t: 'session_restart', sessionId })));
  ws.on('message', (raw) => {
    const f = parseFrame(raw as Buffer);
    if (f.type === FrameType.Control && f.msg.t === 'error') {
      fail(f.msg.message);
      finish(1);
    }
  });
  ws.on('error', (e) => {
    fail((e as Error).message ? `${(e as Error).message}` : NOT_RUNNING);
    process.exit(1);
  });
  // The host stays silent on success; if no error arrives shortly, assume it worked.
  setTimeout(() => {
    if (settled) return;
    ok(`restarted ${pc.dim(sessionId)} ${pc.dim('— attach to watch:')} ${pc.cyan('tb ' + sessionId.replace(/^sess-/, ''))}`);
    finish(0);
  }, 300);
}

/** Shared connect → send → await config_info → render → exit. */
function configRequest(
  host: string,
  send: (ws: WebSocket) => void,
  onInfo: (info: { hostId: string; hostName: string; shell: string; agents: Record<string, string>; backend?: string }) => void,
): void {
  const ws = dial();
  let settled = false;
  handshake(ws, host, send);
  ws.on('message', (raw) => {
    const f = parseFrame(raw as Buffer);
    if (f.type !== FrameType.Control) return;
    if (f.msg.t === 'config_info') {
      settled = true;
      onInfo(f.msg);
      finish(0);
    } else if (f.msg.t === 'error') {
      settled = true;
      fail(f.msg.message);
      finish(1);
    }
  });
  ws.on('error', () => {
    fail(NOT_RUNNING);
    process.exit(1);
  });
  ws.on('close', () => {
    if (!settled) process.exit(1);
  });
  function finish(code: number) {
    try {
      ws.close();
    } catch {
      /* noop */
    }
    process.exit(code);
  }
}

/** `tb info` — show the host, shell, and what each agent actually runs. */
export function runInfo(host: string): void {
  configRequest(
    host,
    (ws) => ws.send(encodeControl({ t: 'config_get' })),
    (info) => {
      const mid = getMiddle();
      const url = relayUrl();
      const auth = resolveSecret() ? pc.green('on') : pc.dim('off');
      const tls = /^wss:/i.test(url)
        ? pc.dim('   tls ') + (resolvePin() ? pc.green('pinned') : pc.yellow('wss but UNPINNED'))
        : '';
      const beStr = info.backend
        ? pc.dim('   backend ') + (info.backend === 'tmux' ? pc.green('tmux') : pc.dim(info.backend))
        : '';
      console.log(
        pc.bold(pc.cyan('  host ')) + info.hostName + pc.dim(` (${info.hostId})`) + pc.dim('   shell ') + info.shell + beStr,
      );
      console.log(
        pc.dim('  relay ') +
          url +
          pc.dim('   middle ') +
          (mid ? pc.cyan(mid) : pc.dim('(none — local)')) +
          pc.dim('   auth ') +
          auth +
          tls,
      );
      console.log(renderAgents(info.agents));
      console.log(
        pc.dim('  set ') + pc.cyan('tb set <name> "<command>"') + pc.dim('   ·   middle ') + pc.cyan('tb middle set <ip>'),
      );
    },
  );
}

/** `tb set <name> "<command>"` — define/replace an agent preset on the host. */
export function runSet(host: string, name: string, command: string): void {
  configRequest(
    host,
    (ws) => ws.send(encodeControl({ t: 'config_set', name, command })),
    (info) => {
      ok(`${pc.bold(name)} ${pc.dim('→')} ${command}`);
      console.log(renderAgents(info.agents));
      console.log(pc.dim('  run:  ') + pc.cyan(`tb new ${name}`));
    },
  );
}

/** `tb rm <name>` — delete an agent preset on the host. */
export function runRemove(host: string, name: string): void {
  configRequest(
    host,
    (ws) => ws.send(encodeControl({ t: 'config_remove', name })),
    (info) => {
      ok(`removed ${pc.bold(name)}`);
      console.log(renderAgents(info.agents));
    },
  );
}

/** One-shot fetch of the host's configured agent names (for the picker). */
function fetchAgents(host: string): Promise<string[]> {
  return new Promise((resolve) => {
    const ws = dial();
    let done = false;
    const finish = (names: string[]) => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve(names);
    };
    handshake(ws, host, (ws) => ws.send(encodeControl({ t: 'agents' })));
    ws.on('message', (raw) => {
      const f = parseFrame(raw as Buffer);
      if (f.type === FrameType.Control && f.msg.t === 'agents_result') finish(f.msg.names);
      else if (f.type === FrameType.Control && f.msg.t === 'error') finish([]);
    });
    ws.on('error', () => finish([]));
  });
}

/** Interactive `tb new` (no agent given): pick from the host's presets. */
export async function runNew(host: string): Promise<void> {
  if (!process.stdout.isTTY) {
    fail('usage: tb new <agent>   |   tb new -- <command...>');
    process.exit(1);
  }
  const agents = await fetchAgents(host);
  if (agents.length === 0) {
    fail('no agents configured. add some to ~/.termbridge/config.json, or:  tb new -- <command...>');
    process.exit(1);
  }
  const choice = await p.select({
    message: 'new session',
    options: agents.map((a) => ({ value: a, label: a })),
  });
  if (p.isCancel(choice)) {
    p.cancel('cancelled');
    process.exit(0);
  }
  runAttach({ host, agent: choice as string });
}
