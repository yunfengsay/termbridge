/**
 * termbridge integration suite.
 *
 * Boots a real relay + host (as child processes) and drives them at the
 * protocol level (plus one pass through the real CLI binary), asserting the
 * core guarantees end-to-end:
 *   1. PTY round-trip            — bytes flow pty -> host -> relay -> client
 *   2. session persistence       — a session outlives the viewer that made it
 *   3. reattach + scrollback     — a new viewer re-attaches and sees history
 *   4. session listing           — host reports live sessions
 *   5. multi-viewer broadcast    — output fans out to every attached viewer
 *   6. CLI binary round-trip     — the shipped `termbridge` client works
 *   7. config set / get          — `tb set` persists an agent; `tb info` reads it
 *   8. middle settings           — resolveRelayUrl precedence (env > middle > local)
 *   9. relay password auth       — HMAC challenge: right secret works, wrong is rejected
 *  10. self-signed wss + pin     — relay serves wss; right fingerprint works, wrong is refused
 *  11. survives a wrong password — host reports it cleanly + keeps reconnecting (no crash)
 *  12. heartbeat ping/reap       — relay pings peers and reaps a half-open (silent) one
 *  13. built-in shell session    — `tb new` (no agent) opens a login+interactive shell
 *  14. tmux backend              — remain-on-exit keeps a session past its command; restart respawns
 *  15. reverse tool channel      — host's agent runs exec/fs on the attached client (gated by `tb expose`)
 *  16. agent input prefill       — `tb new` types a client-OS / tb peer hint into the agent's input box (no Enter)
 *  17. Herdr native API          — protocol and real TTY CLI input reach pane.send_input in order
 *  18. multi-host roster         — opted-in clients receive named online hosts and selected host
 *  18b. Host network policy      — app control persists on Host and survives a relay re-dial
 *  19. global Brain dispatch     — durable message routes once to an agent and remains attachable
 *  20. mobile Git review         — session cwd resolves to bounded diffs and project files
 *  21. conversation repositories — the Agent's own record names every repository it changed
 *
 * Run with `pnpm test`. Exits non-zero if any scenario fails.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createAndroidArtifactTestReceiver } from '@termbridge/settings';
import net from 'node:net';
import { readFileSync, realpathSync, writeFileSync, unlinkSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';
import {
  parseFrame,
  FrameType,
  encodeControl,
  framePtyIn,
  type ControlMessage,
  type BrainImageAttachment,
} from '@termbridge/protocol';
import { hmacHex, generateSelfSigned, normalizeFp } from '@termbridge/settings';
import { executeTool } from '../packages/cli/src/peerExecutor.js';

// Keep ephemeral integration relays away from the product defaults (7400/8001).
const PORT = process.env.TB_TEST_PORT || String(17400 + (process.pid % 1000));
if (!/^\d+$/.test(PORT) || Number(PORT) < 1024 || Number(PORT) > 63000) throw new Error('Invalid isolated test port');
const RELAY_URL = `ws://localhost:${PORT}`;
const BRAIN_PORT = Number(PORT) + 2000;
const BRAIN_BASE_URL = `http://127.0.0.1:${BRAIN_PORT}/compatible-mode/v1`;
const HOST_ID = 'test-host';
const TSX = './node_modules/.bin/tsx';
const PACKAGE_VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

// Isolated host config (never touches the user's ~/.termbridge/config.json).
const TB_CONFIG = `/tmp/tb-test-config-${process.pid}.json`;
const TB_BRAIN_STATE = `/tmp/tb-test-brain-${process.pid}.json`;
const TB_SCREEN_BRAIN_STATE = `/tmp/tb-test-screen-brain-${process.pid}.json`;
const TB_VOICE_LEARNING_DIR = mkdtempSync('/tmp/tb-learning-integration-');
const AGENT_MARKER = 'AGENT_MARKER_77';
writeFileSync(
  TB_CONFIG,
  JSON.stringify({ shell: 'bash', agents: { echoagent: `echo ${AGENT_MARKER}`, catagent: 'cat' } }),
);

// Isolated settings, set BEFORE any boot so every child (and this process)
// inherits it. Without this, a real ~/.termbridge/settings.json secret/middle/pin
// leaks in — the shared relay would then demand a password the bare test clients
// never send, and every session scenario would time out. (Scenario 8 still swaps
// in its own file to exercise resolveRelayUrl precedence.)
const SETTINGS_FILE = `/tmp/tb-test-settings-${process.pid}.json`;
writeFileSync(SETTINGS_FILE, '{}\n');
process.env.TB_SETTINGS = SETTINGS_FILE;
process.env.TB_PEER_ID_FILE = join(TB_VOICE_LEARNING_DIR, 'cli-peer-id');

// Pin the DIRECT backend explicitly for the whole suite. It's now also the default,
// but pinning keeps the exit-code scenarios robust regardless: tmux's remain-on-exit
// keeps a session alive past its command, which would hang every clean-exit assert.
// The tmux backend gets its own scenario (14) on an isolated `-L` socket.
process.env.TB_BACKEND = 'direct';
const TMUX_SOCK = `tbtest-${process.pid}`;

// Reverse tool channel (scenario 15): the host listens on this unix socket and
// injects the token into every session; the test drives it directly, as `tb peer`
// would from inside a session.
const BRIDGE_SOCK = `/tmp/tb-test-bridge-${process.pid}.sock`;
const BRIDGE_TOKEN = `test-bridge-token-${process.pid}`;
const HERDR_SOCK = `/tmp/tb-test-herdr-${process.pid}.sock`;
// Never let secondary test hosts discover the user's real Herdr. The primary
// host explicitly opts into the isolated fake socket below.
process.env.TB_HERDR = 'off';

let herdrRevision = 1;
let herdrInput = '';
let herdrInputTrace: Array<{ text?: string; keys?: string[] }> = [];
let herdrScreen = 'HERDR_READY';
let herdrClosed = false;
let herdrAgentStatus = 'idle';
// Opt-in pane identity for the conversation-repository scenario only.
let herdrPaneCwd: string | undefined;
let herdrAgentSession: Record<string, string> | undefined;
const herdrConnections = new Set<net.Socket>();
const fakeHerdr = net.createServer((connection) => {
  herdrConnections.add(connection);
  connection.on('close', () => {
    herdrConnections.delete(connection);
  });
  let input = '';
  connection.on('data', (chunk) => {
    input += chunk.toString('utf8');
    const newline = input.indexOf('\n');
    if (newline === -1) return;
    const request = JSON.parse(input.slice(0, newline)) as {
      id: string;
      method: string;
      params: { text?: string; keys?: string[] };
    };
    const reply = (result: Record<string, unknown>) =>
      connection.end(JSON.stringify({ id: request.id, result }) + '\n');
    if (request.method === 'session.snapshot') {
      const panes = herdrClosed ? [] : [{
        pane_id: 'wH:p1', terminal_id: 'term-test', workspace_id: 'wH', tab_id: 'wH:t1', focused: true,
        agent: 'codex', agent_status: herdrAgentStatus, revision: herdrRevision, terminal_title_stripped: 'fake Herdr Codex',
        ...(herdrPaneCwd ? { cwd: herdrPaneCwd } : {}),
        ...(herdrAgentSession ? { agent_session: herdrAgentSession } : {}),
      }];
      return reply({
        type: 'session_snapshot',
        snapshot: {
          version: '0.8.0', protocol: 19,
          workspaces: [{ workspace_id: 'wH', label: 'herdr-project' }],
          tabs: [{ tab_id: 'wH:t1', workspace_id: 'wH', number: 1, label: '1', focused: true, pane_count: 1, agent_status: 'idle' }],
          panes,
          agents: herdrClosed ? [] : [{ pane_id: 'wH:p1', name: 'remote_agent', agent: 'codex', agent_status: herdrAgentStatus }],
          layouts: [{
            workspace_id: 'wH', tab_id: 'wH:t1', focused_pane_id: 'wH:p1', zoomed: false,
            area: { x: 0, y: 0, width: 100, height: 32 }, splits: [],
            panes: [{ pane_id: 'wH:p1', focused: true, rect: { x: 0, y: 0, width: 100, height: 32 } }],
          }],
        },
      });
    }
    if (request.method === 'pane.read') {
      return reply({
        type: 'pane_read',
        read: {
          pane_id: 'wH:p1', workspace_id: 'wH', tab_id: 'wH:t1', source: 'visible', format: 'ansi',
          text: herdrScreen, revision: herdrRevision, truncated: false,
        },
      });
    }
    if (request.method === 'events.wait') {
      return connection.end(JSON.stringify({
        id: request.id,
        error: { code: 'unsupported_event_wait_match', message: 'events.wait currently supports pane agent status matches' },
      }) + '\n');
    }
    if (request.method === 'pane.send_input') {
      herdrInputTrace.push({ text: request.params.text, keys: request.params.keys });
      // A real TTY commonly emits one WebSocket frame per key. Delay text
      // responses so an unserialized Host lets a later Enter overtake them.
      if (request.params.text) {
        return setTimeout(() => {
          herdrInput += request.params.text;
          reply({ type: 'ok' });
        }, 30);
      }
      if (request.params.keys?.includes('enter')) {
        herdrScreen = `HERDR_ECHO:${herdrInput}`;
        herdrInput = '';
        herdrRevision += 1;
      }
      return reply({ type: 'ok' });
    }
    if (request.method === 'pane.close') {
      herdrClosed = true;
      return reply({ type: 'pane_closed', pane_id: 'wH:p1' });
    }
    reply({ type: 'ok' });
  });
});

const imageFixture = Buffer.from('encrypted selected image integration fixture');
const imageFixtureAsset = { assetId: 'integration-image', name: 'fixture.png', mime: 'image/png',
  size: imageFixture.length, sha256: createHash('sha256').update(imageFixture).digest('hex') };
let imageInferences = 0;
const silentInferences: Array<{ model?: string; thinking?: boolean; input: string }> = [];
const fakeBrain = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const payload = JSON.parse(body) as {
      model?: string;
      enable_thinking?: boolean;
      messages?: Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }> }>;
    };
    const messages = payload.messages || [];
    if (payload.model === 'qwen-vl-plus') {
      const body = JSON.stringify(messages);
      assert(body.includes(`data:image/png;base64,${imageFixture.toString('base64')}`), 'vision receives exact verified pixels');
      imageInferences++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'VERIFIED_IMAGE_DESCRIPTION' } }] }));
      return;
    }
    const contentText = (content: typeof messages[number]['content']): string => (
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((item) => item.text || '').join('')
          : ''
    );
    const currentUser = contentText([...messages].reverse().find((message) => message.role === 'user')?.content);
    if (currentUser.includes('SILENT_')) {
      silentInferences.push({ model: payload.model, thinking: payload.enable_thinking, input: currentUser });
      if (currentUser.includes('SILENT_CANCEL')) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.flushHeaders();
        return; // A real pending HTTP stream; cancellation must abort it.
      }
      if (currentUser.includes('SILENT_FAILURE')) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Synthetic provider unavailable' } }));
        return;
      }
    }
    const hasToolResult = messages.some((message) => message.role === 'tool');
    const screenQuestion = currentUser.includes('BRAIN_SCREEN_MARKER');
    const imageQuestion = currentUser.includes('BRAIN_IMAGE_MARKER') || screenQuestion;
    const toolCount = messages.filter(message => message.role === 'tool').length;
    const message = screenQuestion && toolCount < 2 ? {
      role: 'assistant', content: '', tool_calls: [{ id: `screen-step-${toolCount}`, type: 'function', function: {
        name: toolCount === 0 ? 'phone_action' : 'inspect_images',
        arguments: JSON.stringify(toolCount === 0 ? { action: 'screen.capture' } : { question: currentUser }),
      } }],
    } : currentUser.includes('BRAIN_DIRECT_MARKER')
      ? { role: 'assistant', content: 'BAILIAN_DIRECT_REPLY' }
      : hasToolResult
        ? { role: 'assistant', content: imageQuestion ? 'BAILIAN_IMAGE_REPLY' : 'BAILIAN_DISPATCHED_REPLY' }
        : {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'integration-dispatch',
              type: 'function',
              function: {
                name: imageQuestion ? 'inspect_images' : 'dispatch_agent',
                arguments: JSON.stringify(imageQuestion ? { question: currentUser } : { task: currentUser, agent: 'catagent' }),
              },
            }],
          };
    const model = payload.model || 'test-small-model';
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => JSON.stringify({
      id: `chatcmpl-${process.pid}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1_000),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if ('tool_calls' in message) {
      response.write(`data: ${chunk({ role: 'assistant', tool_calls: message.tool_calls })}\n\n`);
      response.write(`data: ${chunk({}, 'tool_calls')}\n\n`);
    } else {
      response.write(`data: ${chunk({ role: 'assistant', content: message.content })}\n\n`);
      response.write(`data: ${chunk({}, 'stop')}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
});

let asrSessions = 0;
let asrClosed = 0;
let asrHints = '';
let asrTranscript = '查看 Agent';
const fakeAsr = new WebSocketServer({ server: fakeBrain });
fakeAsr.on('connection', socket => {
  asrSessions++;
  socket.on('close', () => { asrClosed++; });
  socket.on('message', raw => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'session.update') {
      asrHints = event.session.input_audio_transcription.corpus.text;
      socket.send(JSON.stringify({ type: 'session.updated' }));
    } else if (event.type === 'input_audio_buffer.append') {
      socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.text', text: '查看 Agent' }));
    } else if (event.type === 'input_audio_buffer.commit') {
      socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: asrTranscript }));
    } else if (event.type === 'session.finish') {
      socket.send(JSON.stringify({ type: 'session.finished' }));
    }
  });
});

const children: ChildProcess[] = [];
const terminalChildren: Array<ReturnType<typeof pty.spawn>> = [];
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function boot(args: string[], env: Record<string, string>, label: string): ChildProcess {
  // Secondary test hosts must never unlink the deployed Host's default socket.
  const isolatedHost = args[0] === 'packages/host/src/index.ts'
    ? { TB_BRIDGE_SOCK: `/tmp/tb-test-${process.pid}-${label}.sock` } : {};
  const c = spawn(TSX, args, { env: { ...process.env, ...isolatedHost, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  (c as any).label = label;
  (c as any).out = '';
  (c as any).err = '';
  c.stdout!.on('data', (d) => ((c as any).out += d.toString()));
  c.stderr!.on('data', (d) => ((c as any).err += d.toString()));
  children.push(c);
  return c;
}

function waitStdout(child: ChildProcess, re: RegExp, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`[${(child as any).label}] timeout for ${re}\nstdout: ${(child as any).out}\nstderr: ${(child as any).err}`)),
      timeoutMs,
    );
    const check = () => {
      if (re.test((child as any).out)) {
        clearTimeout(t);
        child.stdout!.off('data', check);
        resolve();
      }
    };
    child.stdout!.on('data', check);
    child.on('exit', () => {
      if (re.test((child as any).out)) {
        clearTimeout(t);
        resolve();
      } else {
        clearTimeout(t);
        reject(new Error(`[${(child as any).label}] exited before matching ${re}\nstderr: ${(child as any).err}`));
      }
    });
  });
}

/** Resolve once the child's STDERR matches `re` (used to assert clean error output). */
function waitStderr(child: ChildProcess, re: RegExp, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`[${(child as any).label}] timeout for ${re} on stderr\nstderr: ${(child as any).err}`)),
      timeoutMs,
    );
    const check = () => {
      if (re.test((child as any).err)) {
        clearTimeout(t);
        child.stderr!.off('data', check);
        resolve();
      }
    };
    child.stderr!.on('data', check);
  });
}

/** Minimal protocol-level test client (bare frames, like a browser/CLI viewer). */
function makeClient(
  host: string = HOST_ID,
  opts: { url?: string; secret?: string; pin?: string; wantsHosts?: boolean;
    tool?: (op: string, args: Record<string, unknown>) => ReturnType<typeof executeTool> } = {},
) {
  const url = opts.url ?? RELAY_URL;
  const isWss = /^wss:/i.test(url);
  const ws = new WebSocket(url, isWss ? { rejectUnauthorized: false } : {});
  const state = { output: '', sid: null as number | null, sessionId: null as string | null, exit: null as any, error: null as any };
  const controlHandlers = new Set<(m: ControlMessage) => void>();
  let readyRes!: () => void;
  const ready = new Promise<void>((res) => (readyRes = res));

  if (isWss && opts.pin) {
    ws.on('upgrade', (res: any) => {
      const fp = res.socket?.getPeerCertificate?.().fingerprint256;
      if (normalizeFp(fp || '') !== normalizeFp(opts.pin!)) {
        state.error = { t: 'error', message: 'fingerprint mismatch' };
        try {
          ws.terminate();
        } catch {
          /* noop */
        }
      }
    });
  }

  ws.on('message', (raw) => {
    const f = parseFrame(raw as Buffer);
    if (f.type === FrameType.PtyOut) state.output += f.data.toString();
    else if (f.type === FrameType.Control) {
      if (f.msg.t === 'auth_challenge') {
        // answer the HMAC challenge (empty mac if no secret), then hello
        ws.send(encodeControl({ t: 'auth_response', mac: hmacHex(opts.secret, f.msg.nonce) }));
        ws.send(encodeControl({ t: 'hello', role: 'client', hostId: host, wantsHosts: opts.wantsHosts }));
        readyRes();
        return;
      }
      if (f.msg.t === 'session_exit') state.exit = f.msg;
      if (f.msg.t === 'error') state.error = f.msg;
      if (f.msg.t === 'tool_request') {
        // Act as the client-side executor: run the tool locally via the REAL
        // executeTool (gated by `tb expose`) and reply — exactly what the shipped
        // client does. Lets scenario 15 exercise the whole reverse channel.
        const { id, op, args } = f.msg;
        (opts.tool ?? executeTool)(op, (args ?? {}) as Record<string, unknown>).then((res) => {
          ws.send(
            encodeControl({ t: 'tool_response', id, ok: res.ok, exit: res.exit, stdout: res.stdout, stderr: res.stderr, data: res.data, error: res.error }),
          );
        });
        return;
      }
      for (const h of [...controlHandlers]) h(f.msg);
    }
  });
  ws.on('error', () => {}); // surfaced via scenario timeouts

  function onControl<T extends ControlMessage['t']>(t: T, timeoutMs = 8000): Promise<Extract<ControlMessage, { t: T }>> {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        controlHandlers.delete(h);
        rej(new Error(`timeout waiting for control "${t}"`));
      }, timeoutMs);
      const h = (m: ControlMessage) => {
        if (m.t === t) {
          clearTimeout(timer);
          controlHandlers.delete(h);
          res(m as Extract<ControlMessage, { t: T }>);
        }
      };
      controlHandlers.add(h);
    });
  }

  return {
    state,
    ready,
    onControl,
    sendControl(message: ControlMessage) { ws.send(encodeControl(message)); },
    observeControl(handler: (message: ControlMessage) => void) {
      controlHandlers.add(handler);
      return () => controlHandlers.delete(handler);
    },
    async createSession(command?: string, args?: string[], cwd?: string) {
      const p = onControl('session_created');
      ws.send(encodeControl({ t: 'session_create', command, args, cwd, cols: 80, rows: 24 }));
      const m = await p;
      state.sid = m.sid;
      state.sessionId = m.sessionId;
      return m;
    },
    async createAgent(agent: string, clientPlatform?: string) {
      const p = onControl('session_created');
      ws.send(encodeControl({ t: 'session_create', agent, cols: 80, rows: 24, clientPlatform, clientName: 'TESTBOX' }));
      const m = await p;
      state.sid = m.sid;
      state.sessionId = m.sessionId;
      return m;
    },
    async configSet(name: string, command: string) {
      const p = onControl('config_info');
      ws.send(encodeControl({ t: 'config_set', name, command }));
      return await p;
    },
    async configGet() {
      const p = onControl('config_info');
      ws.send(encodeControl({ t: 'config_get' }));
      return await p;
    },
    async attach(sessionId: string) {
      const p = onControl('attach_ok');
      ws.send(encodeControl({ t: 'attach', sessionId, cols: 80, rows: 24 }));
      const m = await p;
      state.sid = m.sid;
      state.sessionId = sessionId;
      return m;
    },
    async list() {
      const p = onControl('session_list_result');
      ws.send(encodeControl({ t: 'session_list' }));
      return (await p).sessions;
    },
    async brainSnapshot() {
      const p = onControl('brain_snapshot_result');
      ws.send(encodeControl({ t: 'brain_snapshot' }));
      return await p;
    },
    async brainSend(requestId: string, text: string, agent?: string, imageAttachment?: BrainImageAttachment) {
      const accepted = onControl('brain_accepted');
      const p = onControl('brain_snapshot_result');
      ws.send(encodeControl({ t: 'brain_send', requestId, text, agent, imageAttachment, clientPlatform: 'test' }));
      const acknowledgement = await accepted;
      assert(acknowledgement.requestId === requestId, 'Brain acknowledgement must match the request');
      return await p;
    },
    async brainNew() {
      const p = onControl('brain_snapshot_result');
      ws.send(encodeControl({ t: 'brain_new' }));
      return await p;
    },
    async brainClear() {
      const p = onControl('brain_snapshot_result');
      ws.send(encodeControl({ t: 'brain_clear' }));
      return await p;
    },
    async brainHistory(conversationId: string) {
      const p = onControl('brain_history_result');
      ws.send(encodeControl({ t: 'brain_history', conversationId }));
      return await p;
    },
    async brainRestore(conversationId: string) {
      const p = onControl('brain_snapshot_result');
      ws.send(encodeControl({ t: 'brain_restore', conversationId }));
      return await p;
    },
    async reviewSnapshot(sessionId: string, mode: 'working' | 'branch' | 'files' = 'working', baseBranch?: string, path?: string) {
      const requestId = `review-${process.pid}-${Date.now()}`;
      const p = onControl('review_snapshot_result');
      ws.send(encodeControl({ t: 'review_snapshot', requestId, sessionId, mode, baseBranch, path }));
      const result = await p;
      assert(result.requestId === requestId, 'Git review response must match the request');
      return result;
    },
    async reviewRepositories(sessionId: string) {
      const requestId = `review-repositories-${process.pid}-${Date.now()}`;
      const p = onControl('review_repositories_result');
      ws.send(encodeControl({ t: 'review_repositories', requestId, sessionId }));
      const result = await p;
      assert(result.requestId === requestId, 'repository list response must match the request');
      return result;
    },
    async reviewSnapshotIn(sessionId: string, repository: string, path?: string) {
      const requestId = `review-in-${process.pid}-${Date.now()}`;
      const p = onControl('review_snapshot_result');
      ws.send(encodeControl({ t: 'review_snapshot', requestId, sessionId, mode: 'working', repository, path }));
      const result = await p;
      assert(result.requestId === requestId, 'Git review response must match the request');
      return result;
    },
    async fileRead(sessionId: string, path: string, revision?: 'HEAD') {
      const requestId = `file-${process.pid}-${Date.now()}`;
      const p = onControl('session_file_result');
      ws.send(encodeControl({ t: 'session_file_read', requestId, sessionId, path, offset: 0, ...(revision ? { revision } : {}) }));
      const result = await p;
      assert(result.requestId === requestId, 'file response must match the request');
      return result;
    },
    async reviewProbe(sessionId: string) {
      const requestId = `review-probe-${process.pid}-${Date.now()}`;
      const p = onControl('review_probe_result');
      ws.send(encodeControl({ t: 'review_probe', requestId, sessionId }));
      const result = await p;
      assert(result.requestId === requestId, 'Git review probe response must match the request');
      return result;
    },
    async networkPolicyGet() {
      const requestId = `network-get-${process.pid}-${Date.now()}`;
      const p = onControl('network_policy_result');
      ws.send(encodeControl({ t: 'network_policy_get', requestId }));
      const result = await p;
      assert(result.requestId === requestId, 'network policy response must match the request');
      return result;
    },
    async networkPolicySet(policy: 'system' | 'direct') {
      const requestId = `network-set-${process.pid}-${Date.now()}`;
      const p = onControl('network_policy_result');
      ws.send(encodeControl({ t: 'network_policy_set', requestId, policy }));
      const result = await p;
      assert(result.requestId === requestId, 'network policy response must match the request');
      return result;
    },
    input(str: string) {
      ws.send(framePtyIn(state.sid!, Buffer.from(str, 'utf8')));
    },
    kill(sessionId: string) {
      ws.send(encodeControl({ t: 'kill', sessionId }));
    },
    restart(sessionId: string) {
      ws.send(encodeControl({ t: 'session_restart', sessionId }));
    },
    close() {
      ws.close();
    },
  };
}

function waitOutput(client: ReturnType<typeof makeClient>, re: RegExp, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (re.test(client.state.output)) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timeout for ${re}; last output: ${JSON.stringify(client.state.output.slice(-160))}`));
      }
    }, 20);
  });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Drive the host's peer bridge over its unix socket, exactly as `tb peer` does. */
function callBridge(sock: string, token: string, session: string, op: string, args: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock);
    let buf = '';
    const t = setTimeout(() => {
      conn.destroy();
      reject(new Error('bridge call timeout'));
    }, 8000);
    conn.on('connect', () => conn.write(JSON.stringify({ token, session, op, args }) + '\n'));
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(t);
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch (e) {
        reject(e);
      }
      conn.end();
    });
    conn.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

const BASH = ['--norc', '--noprofile', '-i'];
const results: { name: string; ok: boolean; err?: string }[] = [];

async function scenario(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: (e as Error).message });
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${(e as Error).message}`);
  }
}

function cleanup() {
  for (const terminal of terminalChildren) {
    try {
      terminal.kill();
    } catch {
      /* noop */
    }
  }
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* noop */
    }
  }
  rmSync(TB_VOICE_LEARNING_DIR, { recursive: true, force: true });
  for (const connection of herdrConnections) connection.destroy();
  fakeHerdr.close();
  fakeBrain.close();
  for (const f of [TB_CONFIG, TB_BRAIN_STATE, TB_SCREEN_BRAIN_STATE, SETTINGS_FILE, BRIDGE_SOCK, HERDR_SOCK]) {
    try {
      unlinkSync(f);
    } catch {
      /* noop */
    }
  }
  try {
    rmSync(`/tmp/tb-test-peer-${process.pid}`, { recursive: true, force: true }); // scenario 15's exposed root
    rmSync(`/tmp/tb-test-review-${process.pid}`, { recursive: true, force: true });
  } catch {
    /* noop */
  }
  try {
    spawnSync('tmux', ['-L', TMUX_SOCK, 'kill-server']); // tear down scenario 14's isolated tmux server
  } catch {
    /* noop */
  }
}

async function main() {
  await new Promise<void>((resolve, reject) => {
    fakeHerdr.once('error', reject);
    fakeHerdr.listen(HERDR_SOCK, resolve);
  });
  await new Promise<void>((resolve, reject) => {
    fakeBrain.once('error', reject);
    fakeBrain.listen(BRAIN_PORT, '127.0.0.1', resolve);
  });
  console.log(`booting relay + host on ${RELAY_URL} ...`);
  const relay = boot(['packages/relay/src/index.ts'], { PORT }, 'relay');
  await waitStdout(relay, /listening/);
  const host = boot(
    ['packages/host/src/index.ts'],
    {
      RELAY_URL, HOST_ID, TB_CONFIG, TB_BRIDGE_SOCK: BRIDGE_SOCK, TB_BRIDGE_TOKEN: BRIDGE_TOKEN,
      TB_BRAIN_STATE, TB_VOICE_LEARNING_DIR, TB_BRAIN_PROVIDER: 'bailian', TB_BRAIN_MODEL: 'test-small-model',
      DASHSCOPE_API_KEY: 'integration-test-key', DASHSCOPE_BASE_URL: BRAIN_BASE_URL,
      TB_VOICE_REALTIME_URL: `ws://127.0.0.1:${BRAIN_PORT}/realtime`,
      TB_PREFILL_DELAY_MS: '200', TB_HERDR: 'auto', TB_HERDR_SOCKET: HERDR_SOCK,
      TB_HERDR_BIN: join(process.cwd(), 'scripts/fixtures/herdr-terminal.mjs'),
      TB_NATIVE_TEST_TRACE: `/tmp/tb-native-integration-${process.pid}.jsonl`,
    },
    'host',
  );
  await waitStdout(host, new RegExp(`online as id=${HOST_ID}`));
  console.log('running scenarios:\n');

  await scenario('voice control: real Relay + Host train, receipt, revoke, stale replay and JSON-safe rejection', async () => {
    const c = makeClient(HOST_ID);
    await c.ready;
    try {
      const input = { t: 'voice_learning_sync' as const, requestId: randomUUID(), revision: 1, enabled: true, contextConsent: true,
        samples: [{ id: randomUUID(), group: randomUUID(), at: Date.now(),
          features: [0.9, 0.5, 0.8, 0, 1, 1] as [number, number, number, number, number, number],
          head: 'addressed' as const, label: 1 as const, source: 'human' as const, text: 'isolated integration speech', context: 'fixture only' }] };
      let receipt = c.onControl('voice_learning_result'); c.sendControl(input);
      assert((await receipt).status === 'failed', 'unregistered callers cannot train');
      c.sendControl({ t: 'peer_register', deviceId: 'learning-fixture-phone', platform: 'android',
        name: 'Learning fixture', role: 'manager', capabilities: ['voice.personalization'] });
      assert((await c.brainSnapshot()).voiceLearning === 2, 'Host advertises context learning capability');
      receipt = c.onControl('voice_learning_result'); c.sendControl(input);
      const completed = await receipt;
      assert(completed.status === 'completed' && completed.model!.addressed[0] > 0, 'real Host returns trained shadow model');
      assert(completed.assist?.mode === 'context-assist' && completed.assist.examples === 1, 'real worker returns context training receipt');
      receipt = c.onControl('voice_learning_result'); c.sendControl({ ...input, revision: 2, enabled: false, samples: [] });
      assert((await receipt).status === 'revoked', 'deletion is explicitly acknowledged');
      const path = join(TB_VOICE_LEARNING_DIR, createHash('sha256').update('learning-fixture-phone').digest('hex') + '.json');
      const state = JSON.parse(readFileSync(path, 'utf8'));
      assert(state.samples.length === 0 && !state.result.model, 'Host erased samples and weights');
      receipt = c.onControl('voice_learning_result'); c.sendControl(input);
      assert((await receipt).status === 'stale', 'old connection cannot restore withdrawn consent');
      const malformed = JSON.parse(JSON.stringify(input)); malformed.revision = 2n ** 60n;
      receipt = c.onControl('voice_learning_result'); c.sendControl(malformed);
      const failed = await receipt;
      assert(failed.status === 'failed' && Number.isSafeInteger(failed.revision), 'invalid BigInt gets JSON-safe failure receipt');
      JSON.stringify(failed);
    } finally { c.close(); }
  });

  await scenario('0. Commander CLI: version, help, and argument errors', async () => {
    const run = (args: string[]) => spawnSync(TSX, ['packages/cli/src/index.ts', ...args], {
      env: process.env,
      encoding: 'utf8',
    });
    const longVersion = run(['--version']);
    const shortVersion = run(['-V']);
    assert(longVersion.status === 0 && longVersion.stdout.trim() === PACKAGE_VERSION, '--version prints the package version');
    assert(shortVersion.status === 0 && shortVersion.stdout.trim() === PACKAGE_VERSION, '-V prints the package version');

    const rootHelp = run(['--help']);
    assert(rootHelp.status === 0 && /Usage: tb/.test(rootHelp.stdout), '--help prints Commander usage');
    assert(/-V, --version/.test(rootHelp.stdout) && /help \[command\]/.test(rootHelp.stdout), 'root help lists standard options');
    assert(/\binit\b/.test(rootHelp.stdout) && /\bcloudflare\b/.test(rootHelp.stdout), 'root help lists init and Cloudflare relay commands');

    const attachHelp = run(['help', 'attach']);
    assert(attachHelp.status === 0 && /tb attach \[options\] <session>/.test(attachHelp.stdout), 'help attach prints command help');
    const middleHelp = run(['middle', '--help']);
    assert(middleHelp.status === 0 && /set <address>/.test(middleHelp.stdout), 'nested command help lists middle operations');

    const unknown = run(['--not-a-real-option']);
    assert(unknown.status !== 0 && /unknown option/.test(unknown.stderr), 'unknown options fail with a Commander error');
    const missing = run(['attach']);
    assert(missing.status !== 0 && /missing required argument/.test(missing.stderr), 'missing arguments fail with a Commander error');
  });

  await scenario('1. PTY round-trip', async () => {
    const c = makeClient();
    await c.ready;
    await c.createSession('echo', ['RT_MARKER']);
    await waitOutput(c, /RT_MARKER/);
    await waitOutput(c, /RT_MARKER/); // already there
    await delay(200);
    assert(c.state.exit && c.state.exit.exitCode === 0, 'echo session should exit cleanly');
    c.close();
  });

  await scenario('2+3+4. persistence + reattach + scrollback + list', async () => {
    const a = makeClient();
    await a.ready;
    await a.createSession('bash', BASH);
    const sessionId = a.state.sessionId!;
    a.input('echo PERSIST_MARKER\n');
    await waitOutput(a, /PERSIST_MARKER/);
    a.close(); // detach — session must survive

    await delay(300);
    const b = makeClient();
    await b.ready;
    const sessions = await b.list();
    assert(sessions.some((s) => s.sessionId === sessionId), `list should still contain ${sessionId}`);
    await b.attach(sessionId);
    await waitOutput(b, /PERSIST_MARKER/); // replayed from scrollback
    b.kill(sessionId);
    b.close();
  });

  await scenario('5b. agent preset + default-host routing', async () => {
    const c = makeClient(''); // '' = the only/default host (relay resolves it)
    await c.ready;
    await c.createAgent('echoagent'); // resolved via TB_CONFIG to `bash -ic "echo AGENT_MARKER_77"`
    await waitOutput(c, new RegExp(AGENT_MARKER));
    c.close();
  });

  await scenario('5. multi-viewer broadcast', async () => {
    const a = makeClient();
    await a.ready;
    await a.createSession('bash', BASH);
    const sessionId = a.state.sessionId!;
    const b = makeClient();
    await b.ready;
    await b.attach(sessionId);
    await delay(100);
    a.input('echo BROADCAST_MARKER\n');
    await waitOutput(a, /BROADCAST_MARKER/);
    await waitOutput(b, /BROADCAST_MARKER/);
    a.kill(sessionId);
    a.close();
    b.close();
  });

  await scenario('6. CLI binary: `tb new -- echo` (default host)', async () => {
    const cli = boot(['packages/cli/src/index.ts', 'new', '--', 'echo', 'CLI_MARKER'], { RELAY_URL }, 'cli');
    await waitStdout(cli, /CLI_MARKER/);
  });

  await scenario('7. config set / get (tb set / tb info) + run', async () => {
    const c = makeClient('');
    await c.ready;
    const after = await c.configSet('myagent', 'echo CONFIG_MARKER_88');
    assert(after.agents.myagent === 'echo CONFIG_MARKER_88', 'config_set should return updated agents');
    const got = await c.configGet();
    assert(got.agents.myagent === 'echo CONFIG_MARKER_88', 'config_get should reflect the set');
    await c.createAgent('myagent'); // newly-set agent must be runnable
    await waitOutput(c, /CONFIG_MARKER_88/);
    c.close();
  });

  await scenario('8. middle settings: resolveRelayUrl precedence', async () => {
    const { setMiddle, getMiddle, middleToUrl, resolveRelayUrl } = await import('@termbridge/settings');
    const TB_SETTINGS = `/tmp/tb-test-settings-${process.pid}.json`;
    const savedSettings = process.env.TB_SETTINGS;
    const savedRelay = process.env.RELAY_URL;
    process.env.TB_SETTINGS = TB_SETTINGS; // isolated — never touch ~/.termbridge/settings.json
    delete process.env.RELAY_URL;
    try {
      setMiddle(undefined); // clean slate
      assert(getMiddle() === undefined, 'no middle initially');
      assert(resolveRelayUrl() === 'ws://localhost:7400', 'no middle → local relay');

      assert(middleToUrl('1.2.3.4') === 'ws://1.2.3.4:8001', 'bare ip → :8001');
      assert(middleToUrl('1.2.3.4:9000') === 'ws://1.2.3.4:9000', 'ip:port preserved');
      assert(middleToUrl('wss://r.example') === 'wss://r.example', 'ws(s):// preserved');

      setMiddle('203.0.113.10');
      assert(getMiddle() === '203.0.113.10', 'middle persisted to disk');
      assert(resolveRelayUrl() === 'ws://203.0.113.10:8001', 'middle resolves to :8001');

      process.env.RELAY_URL = 'ws://override:1234';
      assert(resolveRelayUrl() === 'ws://override:1234', 'env RELAY_URL wins over middle');
      delete process.env.RELAY_URL;

      setMiddle(undefined);
      assert(getMiddle() === undefined, 'middle cleared');
      assert(resolveRelayUrl() === 'ws://localhost:7400', 'cleared → local relay again');
    } finally {
      if (savedSettings === undefined) delete process.env.TB_SETTINGS;
      else process.env.TB_SETTINGS = savedSettings;
      if (savedRelay === undefined) delete process.env.RELAY_URL;
      else process.env.RELAY_URL = savedRelay;
      try {
        unlinkSync(TB_SETTINGS);
      } catch {
        /* noop */
      }
    }
  });

  await scenario('9. relay password auth (HMAC challenge-response)', async () => {
    const PORT2 = String(Number(PORT) + 1);
    const URL2 = `ws://localhost:${PORT2}`;
    const PW = 'correct-horse-battery-staple-a-very-long-passphrase-9f3a2b';
    const relay2 = boot(['packages/relay/src/index.ts'], { PORT: PORT2, TB_SECRET: PW }, 'relay2');
    await waitStdout(relay2, /password REQUIRED/);
    const host2 = boot(
      ['packages/host/src/index.ts'],
      { RELAY_URL: URL2, HOST_ID: 'auth-host', TB_CONFIG, TB_SECRET: PW },
      'host2',
    );
    await waitStdout(host2, /online as id=auth-host/);

    // correct password → session works end-to-end
    const good = makeClient('auth-host', { url: URL2, secret: PW });
    await good.ready;
    await good.createSession('echo', ['AUTH_OK_MARKER']);
    await waitOutput(good, /AUTH_OK_MARKER/);
    good.close();

    // wrong password → rejected with an auth error (never reaches the host)
    const bad = makeClient('auth-host', { url: URL2, secret: 'the-wrong-password' });
    const errP = bad.onControl('error'); // register before ready to avoid a race
    await bad.ready;
    const err = await errP;
    assert(/authentication failed/i.test(err.message), `wrong password should be rejected, got: ${err.message}`);
    bad.close();
  });

  await scenario('10. self-signed wss + fingerprint pin', async () => {
    const PORT3 = String(Number(PORT) + 2);
    const URL3 = `wss://localhost:${PORT3}`;
    const dir = `/tmp/tb-tls-${process.pid}`;
    const certPath = `${dir}/cert.pem`;
    const keyPath = `${dir}/key.pem`;
    // generate the cert at the temp paths (env-scoped so we don't touch ~/.termbridge)
    const savedCert = process.env.TB_TLS_CERT;
    const savedKey = process.env.TB_TLS_KEY;
    process.env.TB_TLS_CERT = certPath;
    process.env.TB_TLS_KEY = keyPath;
    let fingerprint: string;
    try {
      fingerprint = generateSelfSigned(['localhost']).fingerprint;
    } finally {
      if (savedCert === undefined) delete process.env.TB_TLS_CERT;
      else process.env.TB_TLS_CERT = savedCert;
      if (savedKey === undefined) delete process.env.TB_TLS_KEY;
      else process.env.TB_TLS_KEY = savedKey;
    }

    const relay3 = boot(['packages/relay/src/index.ts'], { PORT: PORT3, TB_TLS_CERT: certPath, TB_TLS_KEY: keyPath }, 'relay3');
    await waitStdout(relay3, /wss:\/\/0\.0\.0\.0/);
    const host3 = boot(
      ['packages/host/src/index.ts'],
      { RELAY_URL: URL3, HOST_ID: 'tls-host', TB_CONFIG, TB_TLS_PIN: fingerprint },
      'host3',
    );
    await waitStdout(host3, /online as id=tls-host/);

    // correct pin → session works end-to-end over wss
    const good = makeClient('tls-host', { url: URL3, pin: fingerprint });
    await good.ready;
    await good.createSession('echo', ['TLS_OK_MARKER']);
    await waitOutput(good, /TLS_OK_MARKER/);
    good.close();

    // wrong pin → terminated on TLS upgrade, never establishes a session
    const bad = makeClient('tls-host', { url: URL3, pin: 'deadbeef'.repeat(8) });
    await delay(800);
    assert(bad.state.sessionId === null, 'wrong fingerprint must not establish a session');
    assert(bad.state.error && /fingerprint/i.test(bad.state.error.message), 'wrong pin should surface a fingerprint error');
    bad.close();
  });

  await scenario('11. host survives a wrong password (no crash)', async () => {
    // Regression: a wrong host secret makes the relay send a BARE `error` while
    // the host has already switched to enveloped mode. The host must report it
    // cleanly and keep reconnecting — NOT decodeEnvelope it and die with
    // "unknown frame type" (the 4-byte-strip trap).
    const PORT4 = String(Number(PORT) + 3);
    const URL4 = `ws://localhost:${PORT4}`;
    const relay4 = boot(['packages/relay/src/index.ts'], { PORT: PORT4, TB_SECRET: 'the-real-relay-password' }, 'relay4');
    await waitStdout(relay4, /password REQUIRED/);
    const host4 = boot(
      ['packages/host/src/index.ts'],
      { RELAY_URL: URL4, HOST_ID: 'badpw-host', TB_CONFIG, TB_SECRET: 'a-DIFFERENT-wrong-password' },
      'host4',
    );
    await waitStderr(host4, /relay refused/); // clean message, not a stack trace
    await delay(500);
    assert(host4.exitCode === null && host4.signalCode === null, 'host must stay alive (reconnecting) after a wrong password');
    assert(!/unknown frame type/.test((host4 as any).err), 'host must not hit the 4-byte-strip parse crash');
  });

  await scenario('12. heartbeat: relay pings peers + reaps a silent one', async () => {
    // The fix for "no host online": a half-open host (TCP silently dead) used to
    // linger as a zombie in the relay's table forever. Now the relay pings every
    // peer and terminates any that stops ponging. Tiny interval so this runs in
    // ~1s instead of 30s.
    const PORT5 = String(Number(PORT) + 4);
    const URL5 = `ws://localhost:${PORT5}`;
    const relay5 = boot(['packages/relay/src/index.ts'], { PORT: PORT5, TB_HEARTBEAT_MS: '150' }, 'relay5');
    await waitStdout(relay5, /listening/);

    // A raw peer that registers as a host and then stays connected. After hello
    // we STOP parsing: the relay's next frame is an enveloped host_register_ok
    // (leading zero bytes) which is not a bare frame — feeding it to parseFrame
    // would throw inside the 'message' emit and crash the harness.
    const ws = new WebSocket(URL5);
    let pinged = false;
    ws.on('ping', () => (pinged = true));
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('heartbeat peer never connected')), 4000);
      const onMsg = (raw: Buffer) => {
        const f = parseFrame(raw);
        if (f.type === FrameType.Control && f.msg.t === 'auth_challenge') {
          ws.send(encodeControl({ t: 'auth_response', mac: hmacHex(undefined, f.msg.nonce) }));
          ws.send(encodeControl({ t: 'hello', role: 'host', hostId: 'hb-host', name: 'hb' }));
          ws.off('message', onMsg);
          clearTimeout(t);
          res();
        }
      };
      ws.on('message', onMsg);
      ws.on('error', rej);
    });
    await waitStdout(relay5, /host registered: hb-host/);

    // Part A: the relay must ping us within a couple of intervals (NAT keepalive).
    await new Promise<void>((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (pinged) {
          clearInterval(iv);
          res();
        } else if (Date.now() - t0 > 2000) {
          clearInterval(iv);
          rej(new Error('relay never sent a heartbeat ping'));
        }
      }, 20);
    });

    // Part B: go silent — pausing the socket stops ws from reading frames, so it
    // never auto-pongs. The relay must notice and reap us as a half-open zombie.
    ws.pause();
    await waitStdout(relay5, /host gone: hb-host/, 4000);
    try {
      ws.terminate();
    } catch {
      /* noop */
    }
  });

  await scenario('13. built-in `shell` session (the tb new default)', async () => {
    // `tb new` with no agent opens a plain login+interactive shell — a fresh
    // remote terminal. Resolved host-side as the built-in `shell` (no config).
    const c = makeClient(''); // default host
    await c.ready;
    await c.createAgent('shell');
    await delay(300); // let the login shell finish sourcing rc/profile
    c.input('echo SHELL_OK_MARKER\n');
    await waitOutput(c, /SHELL_OK_MARKER/, 12000);
    c.kill(c.state.sessionId!);
    c.close();
  });

  await scenario('14. tmux backend: survives its command exiting + restart respawns', async () => {
    if (spawnSync('tmux', ['-V']).status !== 0) {
      console.log('        (tmux not installed — skipped)');
      return; // counts as a pass; tmux-less CI just skips this one
    }
    const PORT6 = String(Number(PORT) + 5);
    const URL6 = `ws://localhost:${PORT6}`;
    const relay6 = boot(['packages/relay/src/index.ts'], { PORT: PORT6 }, 'relay6');
    await waitStdout(relay6, /listening/);
    const host6 = boot(
      ['packages/host/src/index.ts'],
      { RELAY_URL: URL6, HOST_ID: 'tmux-host', TB_CONFIG, TB_BACKEND: 'tmux', TB_TMUX_SOCKET: TMUX_SOCK },
      'host6',
    );
    await waitStdout(host6, /online as id=tmux-host/);
    assert(/backend: tmux/.test((host6 as any).out), 'host must report the tmux backend (not a silent degrade to direct)');

    const c = makeClient('tmux-host', { url: URL6 });
    await c.ready;
    // a command that prints then exits; remain-on-exit must keep the session alive
    await c.createSession('bash', ['-c', 'echo TMUX_ALIVE_MARKER; exit 7']);
    await waitOutput(c, /TMUX_ALIVE_MARKER/);
    await delay(1000);
    assert(c.state.exit === null, 'remain-on-exit: a command exiting must NOT end the session (no session_exit)');

    // restart respawns the same command in the dead pane → the marker prints again
    const sid = c.state.sessionId!;
    const before = (c.state.output.match(/TMUX_ALIVE_MARKER/g) || []).length;
    c.restart(sid);
    await delay(1500);
    const after = (c.state.output.match(/TMUX_ALIVE_MARKER/g) || []).length;
    assert(after > before, `restart must respawn the command (marker count ${before} → ${after})`);
    c.kill(sid);
    c.close();
  });

  await scenario('15. reverse tool channel: peer exec + fs, gated by `tb expose`', async () => {
    const { setExpose } = await import('@termbridge/settings');
    const { mkdirSync } = await import('node:fs');
    const root = `/tmp/tb-test-peer-${process.pid}`;
    mkdirSync(root, { recursive: true });
    // This harness process IS the "client" machine here — its executeTool reads
    // exposure from the same isolated TB_SETTINGS. Open it up, scoped to `root`.
    setExpose({ enabled: true, root, fs: 'rw', exec: true });

    const c = makeClient(''); // default host; this client doubles as the executor
    await c.ready;
    c.sendControl({ t: 'peer_register', deviceId: 'reverse-tool-test-desktop', platform: 'darwin', name: 'Test CLI', role: 'manager',
      capabilities: ['peer.desktop', 'peer.exec', 'peer.fs'] });
    await c.createSession('bash', BASH); // a live session ⇒ this client is its viewer
    const session = c.state.sessionId!;
    await delay(200);

    // exec: the host's "agent" runs a command on the attached client's machine
    const ex = await callBridge(BRIDGE_SOCK, BRIDGE_TOKEN, session, 'exec', { argv: ['echo', 'PEER_EXEC_OK'] });
    assert(ex.ok && /PEER_EXEC_OK/.test(ex.stdout || ''), `peer exec should run on the client: ${JSON.stringify(ex)}`);
    assert(ex.exit === 0, `peer exec exit code should pass through, got ${ex.exit}`);

    // fs.write → fs.read round-trip, confined to root
    const w = await callBridge(BRIDGE_SOCK, BRIDGE_TOKEN, session, 'fs.write', {
      path: 'note.txt',
      content: Buffer.from('FS_RW_OK').toString('base64'),
      encoding: 'base64',
    });
    assert(w.ok, `peer fs.write should succeed: ${JSON.stringify(w)}`);
    const r = await callBridge(BRIDGE_SOCK, BRIDGE_TOKEN, session, 'fs.read', { path: 'note.txt' });
    assert(r.ok && r.data?.content === 'FS_RW_OK', `peer fs.read should return what was written: ${JSON.stringify(r)}`);

    // path confinement: a path escaping the exposed root is refused
    const esc = await callBridge(BRIDGE_SOCK, BRIDGE_TOKEN, session, 'fs.read', { path: '../../../../etc/hosts' });
    assert(!esc.ok && /escape/i.test(esc.error || ''), `path escape must be refused: ${JSON.stringify(esc)}`);

    // host-side gate: a wrong token is forbidden before it ever reaches the client
    const forb = await callBridge(BRIDGE_SOCK, 'WRONG-TOKEN', session, 'exec', { argv: ['echo', 'NOPE'] });
    assert(!forb.ok && /forbidden/i.test(forb.error || ''), `bad token must be forbidden: ${JSON.stringify(forb)}`);

    // client-side gate: with expose OFF, even a valid token + session is refused
    setExpose({ enabled: false });
    const off = await callBridge(BRIDGE_SOCK, BRIDGE_TOKEN, session, 'exec', { argv: ['echo', 'NOPE'] });
    assert(!off.ok && /not exposed/i.test(off.error || ''), `exec must be denied when expose is off: ${JSON.stringify(off)}`);

    c.kill(session);
    c.close();
  });

  await scenario('15b. one Host, two real CLI peers and a phone: discover, select, reconnect and revoke', async () => {
    const owner = makeClient();
    const phone = makeClient(HOST_ID, { tool: async () => ({ ok: true, data: { platform: 'android' } }) });
    const cliProcesses: ChildProcess[] = [];
    try {
      await owner.ready;
      await owner.createSession('bash', BASH);
      const session = owner.state.sessionId!;
      function startCli(label: string, identity: string) {
        const settings = join(TB_VOICE_LEARNING_DIR, `peer-${label}.json`);
        writeFileSync(settings, JSON.stringify({ expose: { enabled: true, fs: 'ro', exec: true, root: TB_VOICE_LEARNING_DIR } }));
        const cli = boot(['packages/cli/src/index.ts', 'attach', session], {
          RELAY_URL, TB_SETTINGS: settings, TB_PEER_ID_FILE: join(TB_VOICE_LEARNING_DIR, identity),
          TB_PEER_TEST_LABEL: label,
        }, `peer-${label}`);
        cliProcesses.push(cli);
        return cli;
      }
      const roster = async () => {
        const result = await callBridge(BRIDGE_SOCK, '', 'app', 'peer.list', {});
        assert(result.ok, `discovery failed: ${JSON.stringify(result)}`);
        return result.data as Array<{ deviceId: string; connections: number; capabilities: string[]; attachedToSession: boolean }>;
      };
      async function waitRoster(check: (peers: Awaited<ReturnType<typeof roster>>) => boolean) {
        for (let i = 0; i < 80; i++) {
          const peers = await roster();
          if (check(peers)) return peers;
          await delay(50);
        }
        throw new Error('peer registration/disconnect did not converge');
      }
      const run = (deviceId?: string, bridgeSession = session) => callBridge(BRIDGE_SOCK,
        bridgeSession.startsWith('herdr:') ? '' : BRIDGE_TOKEN, bridgeSession, 'exec', {
          deviceId, argv: [process.execPath, '-e', 'process.stdout.write(process.env.TB_PEER_TEST_LABEL)'],
        });
      startCli('laptop', 'laptop-id');
      await waitRoster((peers) => peers.some((peer) => peer.capabilities.includes('peer.desktop')));
      const laptopId = readFileSync(join(TB_VOICE_LEARNING_DIR, 'laptop-id'), 'utf8').trim();
      await phone.ready;
      phone.sendControl({ t: 'peer_register', deviceId: 'peer-test-samsung', platform: 'android',
        name: 'Synthetic Samsung', role: 'manager', capabilities: ['phone.actions.status'] });
      await phone.attach(session); // Last viewer is deliberately the phone.
      assert((await run()).stdout === 'laptop', 'the phone must not steal implicit desktop exec');
      assert((await callBridge(BRIDGE_SOCK, BRIDGE_TOKEN, session, 'info', {})).data?.platform === process.platform,
        'info must select the associated CLI, not the phone');
      assert((await callBridge(BRIDGE_SOCK, BRIDGE_TOKEN, session, 'info', { deviceId: 'peer-test-samsung' })).data?.platform === 'android',
        'explicit info must still select the phone');

      startCli('office', 'office-id');
      await waitRoster((peers) => peers.filter((peer) => peer.capabilities.includes('peer.desktop')).length === 2);
      const officeId = readFileSync(join(TB_VOICE_LEARNING_DIR, 'office-id'), 'utf8').trim();
      assert(!(await run()).ok, 'multiple desktops must not silently select the last one');
      assert((await run(laptopId)).stdout === 'laptop', 'explicit laptop selection');
      assert((await run(officeId)).stdout === 'office', 'explicit office selection');
      assert((await run(officeId, 'herdr:wH:p1')).stdout === 'office', 'known Herdr pane can reach a Host-wide CLI peer');
      assert(!(await run('missing-device')).ok, 'missing device must not fall back');

      const duplicate = startCli('laptop-reconnect', 'laptop-id');
      await waitRoster((peers) => peers.find((peer) => peer.deviceId === laptopId)?.connections === 2);
      assert((await run(laptopId)).stdout === 'laptop-reconnect', 'same physical ID uses its new executor connection');
      duplicate.kill('SIGTERM');
      await waitRoster((peers) => peers.find((peer) => peer.deviceId === laptopId)?.connections === 1);
      assert((await run(laptopId)).stdout === 'laptop', 'closing one CLI leaves another connection on that computer reachable');
      writeFileSync(join(TB_VOICE_LEARNING_DIR, 'peer-laptop.json'), JSON.stringify({ expose: { enabled: false } }));
      const denied = await run(laptopId);
      assert(!denied.ok && /not exposed/.test(denied.error), 'revocation is rechecked by the actual CLI without reconnect');
      assert((await run(officeId)).stdout === 'office', 'revoking laptop must not affect the office peer');
      console.log('        real CLI peer loop: phone last, 2 devices, stable reconnect, live consent revocation passed');
    } finally {
      for (const cli of cliProcesses) cli.kill('SIGTERM');
      if (owner.state.sessionId) owner.kill(owner.state.sessionId);
      owner.close(); phone.close();
    }
  });

  await scenario('16. agent input prefill (client OS → tb peer hint, no Enter)', async () => {
    const { buildPrefill } = await import('../packages/host/src/clientContext.js');
    // pure: the prefill line names the client OS + tb peer
    assert(/Windows/.test(buildPrefill('win32')) && /tb peer/.test(buildPrefill('win32')), 'win32 prefill names Windows + tb peer');
    assert(/Mac/.test(buildPrefill('darwin')), 'darwin → Mac');

    // end-to-end: host types the prefill into the agent's input box AFTER startup;
    // the pty echoes it back so the viewer sees it, and there is NO newline (so it
    // is not submitted) — the `cat` session keeps running.
    const c = makeClient('');
    await c.ready;
    await c.createAgent('catagent', 'win32'); // TB_CONFIG: catagent = `cat` (the tty echoes typed input)
    await waitOutput(c, /tb peer/, 6000);
    assert(c.state.exit === null, 'prefill must NOT submit (no Enter) — the session stays alive');
    c.kill(c.state.sessionId!);
    c.close();
  });

  await scenario('17. Herdr native API: discover + attach + input + output', async () => {
    const c = makeClient('');
    await c.ready;
    const sessions = await c.list();
    const session = sessions.find((item) => item.sessionId === 'herdr:wH:p1');
    assert(session?.source === 'herdr', `Herdr pane should appear in session_list: ${JSON.stringify(session)}`);
    assert(
      session.workspace === 'herdr-project' && session.name === 'remote_agent' && session.agent === 'codex',
      'Herdr user-facing name and Agent type should cross the wire separately',
    );
    assert(session.status === 'idle' && session.cols === 100 && session.rows === 32, 'Herdr status and geometry should cross the wire');

    await c.attach(session.sessionId);
    await waitOutput(c, /HERDR_READY/);
    c.input('hello from TB\r');
    await waitOutput(c, /HERDR_ECHO:hello from TB/, 8000);

    c.close();
  });

  await scenario('17b. CLI native stream: cursor, paste, Ctrl-C, resize and confirmed detach', async () => {
    const env = Object.fromEntries(
      Object.entries({ ...process.env, RELAY_URL, TB_HOST: '' }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    const terminal = pty.spawn(TSX, ['packages/cli/src/index.ts', 'herdr:wH:p1'], {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      env,
      name: 'xterm-256color',
    });
    terminalChildren.push(terminal);
    let output = '';
    terminal.onData((data) => {
      output += data;
    });
    const waitTerminal = async (pattern: RegExp, timeoutMs = 8000) => {
      const started = Date.now();
      while (!pattern.test(output)) {
        if (Date.now() - started > timeoutMs) {
          throw new Error(
            `timeout for ${pattern}; last output: ${JSON.stringify(output.slice(-240))}; `
            + `Herdr input: ${JSON.stringify(herdrInput)}; trace: ${JSON.stringify(herdrInputTrace)}`,
          );
        }
        await delay(20);
      }
    };

    await waitTerminal(/NATIVE_READY/);
    assert(/\x1b\[6;8H\x1b\[\?25l/.test(output), 'native hidden cursor must survive unchanged');
    const tracePath = `/tmp/tb-native-integration-${process.pid}.jsonl`;
    const readInput = () => Buffer.concat(readFileSync(tracePath, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line)).filter(r => r.type === 'terminal.input').map(r => Buffer.from(r.bytes, 'base64')));
    const paste = '\x1b[200~中文 first\r\nsecond\x1b[201~';
    terminal.write(paste);
    terminal.write('\r\x03');
    for (let n = 0; n < 100 && !readInput().includes(Buffer.from(paste + '\r\x03')); n++) await delay(20);
    assert(readInput().includes(Buffer.from(paste + '\r\x03')), 'native input must preserve paste, Enter and Ctrl-C bytes');
    terminal.resize(93, 29);
    await waitTerminal(/NATIVE_SIZE:93x29/);
    terminal.write('\x1d');
    await waitTerminal(/session keeps running/);
    terminal.write('\r');
    await waitTerminal(/NATIVE_SIZE:93x29/);
    terminal.write('still attached');
    for (let n = 0; n < 100 && !readInput().includes('still attached'); n++) await delay(20);
    assert(readInput().includes('still attached'), 'cancel keeps input connected');
    output = '';
    terminal.write('\x1d');
    await waitTerminal(/session keeps running/);
    terminal.write('d');
    await waitTerminal(/detached; session kept running/);
    assert(!herdrClosed, 'detach must preserve the Herdr terminal');
    rmSync(tracePath, { force: true });
  });

  await scenario('17c. Herdr pane delete: client kill closes the pane through Herdr', async () => {
    const c = makeClient('');
    await c.ready;
    await c.attach('herdr:wH:p1');
    const exited = c.onControl('session_exit');
    c.kill('herdr:wH:p1');
    const result = await exited;
    assert(result.sessionId === 'herdr:wH:p1', 'Herdr close should notify the attached client');
    assert(herdrClosed, 'Host should call pane.close on the Herdr API');
    c.close();
  });

  await scenario('18. multi-host roster + selected host', async () => {
    const officeHostId = 'office-mini';
    const office = boot(
      ['packages/host/src/index.ts'],
      {
        RELAY_URL,
        HOST_ID: officeHostId,
        HOST_NAME: 'Office Mac mini',
        TB_CONFIG,
        TB_HERDR: 'off',
        TB_BRIDGE_SOCK: `/tmp/tb-test-office-${process.pid}.sock`,
        TB_BRIDGE_TOKEN: `office-token-${process.pid}`,
      },
      'office-host',
    );
    await waitStdout(office, new RegExp(`online as id=${officeHostId}`));

    const c = makeClient(officeHostId, { wantsHosts: true });
    const roster = c.onControl('host_list_result');
    await c.ready;
    const result = await roster;
    assert(result.selectedHostId === officeHostId, `selected host should be ${officeHostId}`);
    assert(result.hosts.some((item) => item.hostId === HOST_ID), 'roster should include the first Mac');
    assert(
      result.hosts.some((item) => item.hostId === officeHostId && item.name === 'Office Mac mini'),
      'roster should include the named office Mac',
    );
    c.close();
  });

  await scenario('18b. Host network policy persists and controls the next relay dial', async () => {
    const first = makeClient(HOST_ID);
    await first.ready;
    const changed = await first.networkPolicySet('direct');
    assert(changed.policy === 'direct' && changed.changed, 'Host should acknowledge a changed direct policy');
    assert(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).networkPolicy === 'direct', 'Host must persist the policy locally');
    first.close();

    await delay(4_000);
    const second = makeClient(HOST_ID);
    await second.ready;
    const persisted = await second.networkPolicyGet();
    assert(persisted.policy === 'direct' && !persisted.changed, 'reconnected Host should report its persisted policy');
    const restored = await second.networkPolicySet('system');
    assert(restored.policy === 'system' && restored.changed, 'test cleanup should restore the default policy');
    second.close();
    await delay(4_000);
  });

  await scenario('18c. background subscription stops snapshots and polling, resumes on demand', async () => {
    const previouslyClosed = herdrClosed;
    herdrClosed = false;
    herdrAgentStatus = 'working';
    const monitor = makeClient(HOST_ID);
    const foreground = makeClient(HOST_ID);
    const received: ControlMessage[] = [];
    const unobserve = monitor.observeControl((message) => received.push(message));
    try {
      await Promise.all([monitor.ready, foreground.ready]);
      const ack = monitor.onControl('client_stream_policy_result');
      const baseline = monitor.onControl('session_list_result');
      monitor.sendControl({ t: 'client_stream_policy', background: true, notifications: true });
      assert((await ack).background, 'Host acknowledges background mode');
      assert((await baseline).sessions.every((s) => !s.preview), 'baseline must omit terminal previews');
      received.length = 0;
      await foreground.brainNew();
      monitor.sendControl({ t: 'brain_snapshot' });
      monitor.sendControl({ t: 'session_list' });
      // Force two unchanged context refreshes without waiting for the periodic timer.
      await foreground.list();
      await foreground.list();
      await delay(200);
      assert(!received.some((m) => m.t === 'brain_snapshot_result'), 'background receives no Brain broadcast or requested snapshot');
      assert(!received.some((m) => m.t === 'session_list_result'), 'unchanged state generates no notification traffic');
      const completed = monitor.onControl('session_list_result');
      herdrAgentStatus = 'done';
      await foreground.list();
      const completedAgent = (await completed).sessions.find((s) => s.sessionId === 'herdr:wH:p1');
      assert(completedAgent?.status === 'done' && Boolean(completedAgent.completedAt),
        'working-to-done notification crosses the real Host/relay without phone polling');
      const requestId = `traffic-watch-${process.pid}`;
      const reply = await monitor.brainSend(requestId, 'BRAIN_DIRECT_MARKER');
      assert(reply.messages.length === 1 && reply.messages[0].id === `${requestId}-brain`,
        'explicit background requests receive only their own answer');
      assert(!reply.history && !reply.toolCatalog, 'background answer must not carry global history/catalog');
      const resumed = monitor.onControl('client_stream_policy_result');
      monitor.sendControl({ t: 'client_stream_policy', background: false, notifications: true });
      assert(!(await resumed).background, 'Host acknowledges restored real-time mode');
      await monitor.brainSnapshot();
      await monitor.list();
    } finally {
      herdrClosed = previouslyClosed;
      herdrAgentStatus = 'idle';
      unobserve(); monitor.close(); foreground.close();
    }
  });

  await scenario('19. global Brain: Bailian conversation and explicit, idempotent worker dispatch', async () => {
    // Scenario 18 deliberately leaves a second host online, so address the
    // primary host explicitly rather than relying on single-host selection.
    const c = makeClient(HOST_ID);
    await c.ready;
    const directRequestId = `brain-direct-${process.pid}`;
    await c.brainSend(directRequestId, 'BRAIN_DIRECT_MARKER');
    let direct = await c.brainSnapshot();
    const directDeadline = Date.now() + 6_000;
    while (!direct.messages.some((item) => item.id === `${directRequestId}-brain`) && Date.now() < directDeadline) {
      await delay(50);
      direct = await c.brainSnapshot();
    }
    assert(
      direct.messages.some((item) => item.id === `${directRequestId}-brain` && item.text === 'BAILIAN_DIRECT_REPLY'),
      'ordinary Global text must be answered by Bailian',
    );
    assert(
      !direct.tasks.some((item) => item.requestId.startsWith(directRequestId)),
      'ordinary Global text must not start a local worker',
    );
    assert(
      direct.routeDecisions?.some((decision) => (
        decision.requestId === directRequestId && decision.action === 'answer' && decision.outcome === 'accepted'
      )),
      'ordinary Global text must record its direct-answer Route Decision',
    );
    const archivedDirect = await c.brainNew();
    assert(archivedDirect.messages.length === 0, 'new Global conversation must start with an empty timeline');
    assert(archivedDirect.history?.length === 1, 'new Global conversation must archive the previous timeline');
    const directHistory = await c.brainHistory(archivedDirect.history![0].id);
    assert(
      directHistory.conversation.messages.some((item) => item.id === directRequestId),
      'Global History must return the archived conversation by stable id',
    );
    const restoredDirect = await c.brainRestore(archivedDirect.history![0].id);
    assert(
      restoredDirect.messages.some((item) => item.id === directRequestId),
      'restoring Global History must make the archived timeline current again',
    );
    assert(restoredDirect.history?.length === 0, 'restoring into an empty Global conversation must remove that archive');
    await c.brainNew();

    const requestId = `brain-request-${process.pid}`;
    const prompt = 'BRAIN_DISPATCH_MARKER';
    let first = await c.brainSend(requestId, prompt, 'catagent').catch((error) => {
      throw new Error(
        `initial Brain send failed: ${(error as Error).message}; host stdout: ${(host as any).out}; host stderr: ${(host as any).err}`,
      );
    });
    let task = first.tasks.find((item) => item.requestId.startsWith(`${requestId}-tool-`));
    const dispatchDeadline = Date.now() + 6_000;
    while ((!task || task.status === 'queued') && Date.now() < dispatchDeadline) {
      await delay(50);
      first = await c.brainSnapshot();
      task = first.tasks.find((item) => item.requestId.startsWith(`${requestId}-tool-`));
    }
    assert(task?.agent === 'catagent', `Brain should honor the selected route: ${JSON.stringify(task)}`);
    assert(task.status === 'dispatched' && task.sessionId, 'Brain should expose its live agent session');
    assert(
      first.routeDecisions?.some((decision) => (
        decision.requestId === requestId && decision.action === 'dispatch_agent'
        && decision.outcome === 'accepted' && decision.targetAgentId === 'catagent'
      )),
      'worker delegation must record its accepted Route Decision',
    );
    const runEventTypes = first.runEvents
      ?.filter((event) => event.runId === task.taskId)
      .map((event) => event.type);
    assert(
      JSON.stringify(runEventTypes) === JSON.stringify(['queued', 'dispatched']),
      `worker delegation must expose ordered authoritative Run Events: ${JSON.stringify(runEventTypes)}`,
    );
    assert(first.messages.some((item) => item.id === requestId && item.text === prompt), 'Brain should persist the user message once');
    assert(first.messages.filter((item) => item.text === prompt).length === 1, 'tool dispatch must not duplicate the Global user turn');

    await delay(500);
    await c.attach(task.sessionId);
    await waitOutput(c, /BRAIN_DISPATCH_MARKER/, 6000);

    const retried = await c.brainSend(requestId, prompt, 'catagent').catch((error) => {
      throw new Error(`idempotent Brain retry failed: ${(error as Error).message}; host stderr: ${(host as any).err}`);
    });
    assert(
      retried.tasks.filter((item) => item.requestId.startsWith(`${requestId}-tool-`)).length === 1,
      'retrying the same Brain request must not create a second run',
    );
    const durable = await c.brainSnapshot().catch((error) => {
      throw new Error(`durable Brain snapshot failed: ${(error as Error).message}; host stderr: ${(host as any).err}`);
    });
    assert(durable.tasks.some((item) => item.taskId === task.taskId), 'Brain snapshot should retain the task');
    c.kill(task.sessionId);
    let finished = await c.brainSnapshot();
    const finishDeadline = Date.now() + 6_000;
    while (finished.tasks.some((item) => item.taskId === task.taskId && item.status === 'dispatched')
      && Date.now() < finishDeadline) {
      await delay(50);
      finished = await c.brainSnapshot();
    }
    assert(
      !finished.tasks.some((item) => item.taskId === task.taskId && item.status === 'dispatched'),
      'Brain task must finish before clearing all conversation history',
    );
    const archivedTask = await c.brainNew();
    assert(archivedTask.history?.length === 2, 'each non-empty Global conversation must receive one archive');
    const cleared = await c.brainClear();
    assert(
      cleared.messages.length === 0 && cleared.tasks.length === 0 && cleared.history?.length === 0,
      'clearing Global must remove both the current timeline and every archived conversation',
    );
    c.close();
  });

  await scenario('19d. dictation streams text, stops without dispatch, and closes the ASR socket', async () => {
    const c = makeClient(HOST_ID);
    await c.ready;
    try {
      const before = await c.brainSnapshot();
      assert(before.dictation, 'Host declares the complete ASR lifecycle');
      const id = `dictation-${process.pid}`;
      const partial = c.onControl('brain_transcribe_result');
      c.sendControl({ t: 'brain_transcribe_start', requestId: id, hints: ['Agent', '提交任务'] });
      c.sendControl({ t: 'brain_transcribe_audio', requestId: id, data: Uint8Array.from([1, 0, 2, 0]) });
      assert((await partial).final === false, 'live text before submission');
      const sentence = c.onControl('brain_transcribe_result');
      c.sendControl({ t: 'brain_transcribe_commit', requestId: id });
      assert((await sentence).final === true, 'VAD commit only closes a sentence');
      const finished = c.onControl('brain_transcribe_result');
      c.sendControl({ t: 'brain_transcribe_finish', requestId: id });
      assert((await finished).finished === true, 'explicit finish acknowledges final drain');
      const after = await c.brainSnapshot();
      assert(after.messages.length === before.messages.length && after.tasks.length === before.tasks.length,
        'ASR never invokes Brain or dispatches a worker');
      assert(asrHints === 'Agent、提交任务', 'configured hints reach ASR');
      const sessions = asrSessions;
      c.sendControl({ t: 'brain_transcribe_start', requestId: `${id}-cancel` });
      const deadline = Date.now() + 5000;
      while (asrSessions === sessions && Date.now() < deadline) await delay(20);
      c.sendControl({ t: 'brain_transcribe_cancel', requestId: `${id}-cancel` });
      while (asrClosed < asrSessions && Date.now() < deadline) await delay(20);
      assert(asrSessions > sessions && asrClosed === asrSessions, 'cancel releases all ASR sockets');
    } finally { c.close(); }
  });

  await scenario('19sc. silent call uses ASR and DeepSeek, replies as text, preserves history, and listens again', async () => {
    const c = makeClient(HOST_ID);
    await c.ready;
    const events: ControlMessage[] = [];
    c.observeControl(event => events.push(event));
    try {
      assert((await c.brainSnapshot()).silentCall, 'Host declares the silent call lane');
      const id = `silent-call-${process.pid}`;
      const ready = c.onControl('brain_voice_ready');
      c.sendControl({ t: 'brain_voice_start', requestId: id, mode: 'call', workflow: 'silent',
        modelTier: 'advanced', sendKeyword: '发送', outputMode: 'text' });
      await ready;
      c.sendControl({ t: 'brain_voice_presentation', requestId: id, presentation: 'overlay' });
      c.sendControl({ t: 'brain_voice_presentation', requestId: id, presentation: 'overlay' });
      const floating = await c.brainSnapshot();
      assert(floating.systemReminders?.filter(r => r.requestId === id).length === 1, 'one durable reminder per transition');
      assert(!floating.messages.some(m => m.text.includes('phone-presentation')), 'reminder is not a chat bubble');
      c.sendControl({ t: 'brain_voice_presentation', requestId: id, presentation: 'foreground' });
      const snapshotsBeforeTurns = events.filter(event => event.t === 'brain_snapshot_result').length;
      for (let turn = 1; turn <= 2; turn++) {
        asrTranscript = `SILENT_CALL_${turn} BRAIN_DIRECT_MARKER`;
        const answer = c.onControl('brain_voice_text');
        c.sendControl({ t: 'brain_voice_input_audio', requestId: id, data: Uint8Array.from([1, 0, 2, 0]) });
        c.sendControl({ t: 'brain_voice_commit', requestId: id });
        const result = await answer;
        assert(result.text === 'BAILIAN_DIRECT_REPLY' && result.final, 'text reply without a realtime response');
        const inference = silentInferences.find(item => item.input.includes(`SILENT_CALL_${turn}`));
        assert(inference?.model === 'deepseek-v4.1-flash' && inference.thinking === false, 'voice execution uses DeepSeek, thinking off');
      }
      assert(events.filter(event => event.t === 'brain_snapshot_result').length === snapshotsBeforeTurns,
        'live text/audio must not compete with unsolicited full-history broadcasts');
      const snapshot = await c.brainSnapshot();
      assert(snapshot.messages.some(message => message.text.includes('SILENT_CALL_2')), 'user speech persists');
      assert(snapshot.messages.some(message => message.text === 'BAILIAN_DIRECT_REPLY'), 'answer persists');
      assert(!events.some(event => event.t === 'brain_voice_output_audio'), 'silent call never emits playback');
      const stopped = c.onControl('brain_voice_stopped');
      c.sendControl({ t: 'brain_voice_stop', requestId: id });
      await stopped;
    } finally { asrTranscript = '查看 Agent'; c.close(); }
  });

  await scenario('19s. silent DeepSeek routing, worker progress, background completion and mid-stream cancellation', async () => {
    const c = makeClient(HOST_ID);
    const monitor = makeClient(HOST_ID);
    await Promise.all([c.ready, monitor.ready]);
    const events: ControlMessage[] = [];
    c.observeControl(event => events.push(event));
    monitor.sendControl({ t: 'peer_register', deviceId: 'silent-test-phone', platform: 'android',
      name: 'Silent test phone', role: 'manager', capabilities: [] });
    const capabilities = await c.brainSnapshot();
    assert(capabilities.workflows?.includes('silent'), 'Host must advertise the new workflow');
    try {
      for (const tier of ['advanced', 'deep'] as const) {
        const id = `silent-${tier}-${process.pid}`;
        const result = c.onControl('brain_text_result');
        const backgroundResult = monitor.onControl('brain_text_result');
        c.sendControl({ t: 'brain_send', requestId: id, text: `SILENT_${tier} BRAIN_DISPATCH_MARKER`,
          workflow: 'silent', modelTier: tier });
        assert((await result).status === 'completed', 'silent workflow must return completed');
        assert((await backgroundResult).requestId === id, 'background phone must receive completion');
        const snapshot = await c.brainSnapshot();
        assert(snapshot.executionEvents?.some(event => event.requestId === id && event.workflow === 'silent'
          && event.phase === 'fork_completed' && event.model === 'deepseek-v4.1-flash'), 'durable execution progress');
        const job = snapshot.tasks.find(task => task.requestId.startsWith(`${id}-tool-`));
        assert(job?.sessionId, 'silent execution must dispatch a real isolated worker');
        const inference = silentInferences.find(item => item.input.includes(`SILENT_${tier}`));
        assert(inference?.model === 'deepseek-v4.1-flash' && inference.thinking === false, 'both tiers must explicitly disable thinking');
        c.kill(job.sessionId);
      }
      const id = `silent-cancel-${process.pid}`;
      const cancelled = c.onControl('brain_text_result');
      const origin = makeClient(HOST_ID);
      await origin.ready;
      origin.sendControl({ t: 'brain_send', requestId: id, text: 'SILENT_CANCEL', workflow: 'silent' });
      const deadline = Date.now() + 5000;
      while (!silentInferences.some(item => item.input === 'SILENT_CANCEL') && Date.now() < deadline) await delay(20);
      assert(silentInferences.some(item => item.input === 'SILENT_CANCEL'), 'cancel only after inference actually starts');
      origin.close();
      const reconnect = await c.brainSnapshot();
      assert(reconnect.executionEvents?.some(event => event.requestId === id && event.workflow === 'silent'),
        'progress survives the initiating client disconnect');
      await c.brainSend(id, 'SILENT_CANCEL'); // Rejoin stable request without repeating inference.
      assert(silentInferences.filter(item => item.input === 'SILENT_CANCEL').length === 1, 'rejoin must not replay work');
      const cancelAck = c.onControl('brain_cancel_result');
      c.sendControl({ t: 'brain_cancel', requestId: id });
      assert((await cancelAck).cancelled, 'stable request ID must acknowledge cancellation');
      assert((await cancelled).status === 'cancelled', 'cancel must have a terminal receipt');
      const snapshot = await c.brainSnapshot();
      assert(snapshot.executionEvents?.some(event => event.requestId === id && event.phase === 'fork_cancelled'), 'cancelled persists in history');
      const failure = c.onControl('brain_text_result');
      c.sendControl({ t: 'brain_send', requestId: `silent-failure-${process.pid}`, text: 'SILENT_FAILURE', workflow: 'silent' });
      assert((await failure).status === 'failed', 'provider failure must terminalize instead of opening voice or retrying workers');
      assert(!events.some(event => event.t.startsWith('brain_voice_')), 'silent jobs never open realtime voice');
    } finally { c.close(); monitor.close(); }
  });

  await scenario('19screen. capture approval → completed receipt → encrypted pixels → vision → History', async () => {
    const screenHostId = 'screen-fixture-host';
    const screenHost = boot(['packages/host/src/index.ts'], {
      RELAY_URL, HOST_ID: screenHostId, TB_CONFIG, TB_HERDR: 'off', TB_BRAIN_STATE: TB_SCREEN_BRAIN_STATE,
      TB_BRAIN_PROVIDER: 'bailian', TB_BRAIN_MODEL: 'test-small-model',
      DASHSCOPE_API_KEY: 'integration-test-key', DASHSCOPE_BASE_URL: BRAIN_BASE_URL,
    }, 'screen-host');
    await waitStdout(screenHost, new RegExp(`online as id=${screenHostId}`));
    const deviceId = 'integration-screen-phone';
    let captureId = '';
    let statusReads = 0;
    let pixelReads = 0;
    const before = imageInferences;
    const c = makeClient(screenHostId, { tool: async (op, args) => {
      if (op === 'phone.action') {
        assert(args.action === 'screen.capture', 'exact allowlisted screen action');
        captureId = String(args.actionId);
        return { ok: true, data: { actionId: captureId, state: 'awaiting_user' } };
      }
      if (op === 'phone.action.status') {
        assert(args.actionId === captureId, 'poll original action ID');
        statusReads++;
        return { ok: true, data: { actionId: captureId, state: 'completed', imageAttachment: {
          actionId: 'screen-image-batch', deviceId, assets: [imageFixtureAsset],
        } } };
      }
      assert(op === 'phone.asset.read' && statusReads > 0, 'pixels only after completion');
      assert(args.actionId === 'screen-image-batch' && args.deviceId === deviceId, 'new capture, not old image');
      pixelReads++;
      const crypto = createAndroidArtifactTestReceiver(String(args.clientPublicKey), String(args.salt));
      return { ok: true, data: { ...imageFixtureAsset, encrypted: true, phonePublicKey: crypto.receiverPublicKey,
        ...crypto.encrypt(imageFixtureAsset.assetId, 0, imageFixture), nextOffset: BigInt(imageFixture.length), eof: true } };
    } });
    try {
      await c.ready;
      c.sendControl({ t: 'peer_register', deviceId, platform: 'android', name: 'Synthetic capture phone', role: 'manager',
        capabilities: ['phone.action', 'phone.asset.read'] });
      c.sendControl({ t: 'brain_voice_presentation', requestId: 'not-an-active-call', presentation: 'overlay' });
      const requestId = `screen-integration-${process.pid}`;
      let snapshot = await c.brainSend(requestId, 'BRAIN_SCREEN_MARKER 这个屏幕上的图是什么？');
      const deadline = Date.now() + 10_000;
      while (!snapshot.messages.some(m => m.id === `${requestId}-brain`) && Date.now() < deadline) {
        await delay(50); snapshot = await c.brainSnapshot();
      }
      assert(statusReads === 1 && pixelReads === 1 && imageInferences === before + 1, 'capture → receipt → vision exactly once');
      assert(snapshot.messages.some(m => m.id === `${requestId}-brain` && m.text === 'BAILIAN_IMAGE_REPLY'), 'answer reaches History');
      assert(!snapshot.systemReminders?.some(r => r.requestId === 'not-an-active-call'), 'reject stale/unowned presentation');
    } finally { c.close(); screenHost.kill(); }
  });

  await scenario('19b. attached image: Global → tool → encrypted phone Peer → vision → History', async () => {
    let reads = 0;
    const initialInferences = imageInferences;
    const deviceId = 'integration-phone-001';
    const c = makeClient(HOST_ID, { tool: async (op, args) => {
      assert(op === 'phone.asset.read', 'inspection must only use the selected-asset reader');
      assert(args.deviceId === deviceId && args.actionId === 'integration-images', 'exact selected phone batch');
      assert(args.assetId === imageFixtureAsset.assetId, 'exact selected image');
      reads++;
      const crypto = createAndroidArtifactTestReceiver(String(args.clientPublicKey), String(args.salt));
      return { ok: true, data: { ...imageFixtureAsset, encrypted: true, phonePublicKey: crypto.receiverPublicKey,
        ...crypto.encrypt(imageFixtureAsset.assetId, 0, imageFixture), nextOffset: BigInt(imageFixture.length), eof: true } };
    } });
    try {
      await c.ready;
      c.sendControl({ t: 'peer_register', deviceId, platform: 'android', name: 'Synthetic phone', role: 'manager', capabilities: ['phone.asset.read'] });
      const requestId = `image-integration-${process.pid}`;
      let snapshot = await c.brainSend(requestId, 'BRAIN_IMAGE_MARKER 这是什么？', undefined,
        { actionId: 'integration-images', deviceId, assets: [imageFixtureAsset] }).catch(error => {
          throw new Error(`${String(error)}; state=${JSON.stringify(c.state.error)}; Host stderr=${(host as any).err}`);
        });
      const deadline = Date.now() + 8_000;
      while (!snapshot.messages.some(m => m.id === `${requestId}-brain`) && Date.now() < deadline) {
        await delay(50); snapshot = await c.brainSnapshot();
      }
      assert(reads === 1 && imageInferences === initialInferences + 1, 'one encrypted read and one vision inference, no worker');
      assert(snapshot.messages.some(m => m.text === 'BAILIAN_IMAGE_REPLY'), 'image answer returns to Global');
      const result = snapshot.toolResults?.find(t => t.requestId === requestId && t.toolName === 'inspect_images');
      assert(JSON.stringify(result).includes('VERIFIED_IMAGE_DESCRIPTION'), 'verified description persisted in tool card');
      assert(!JSON.stringify(snapshot).includes(imageFixture.toString('base64')), 'History never persists image pixels');
      assert(!snapshot.tasks.some(t => t.requestId.startsWith(requestId)), 'simple image question does not dispatch a worker');
      await c.brainClear();
    } finally { c.close(); }
  });

  await scenario('20. mobile Git review: session cwd → diff and project files', async () => {
    const repository = `/tmp/tb-test-review-${process.pid}`;
    const { mkdirSync } = await import('node:fs');
    mkdirSync(repository, { recursive: true });
    const runGit = (...args: string[]) => spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    assert(runGit('init', '-b', 'main').status === 0, 'review fixture Git init should succeed');
    runGit('config', 'user.email', 'integration@termbridge.local');
    runGit('config', 'user.name', 'Termbridge Integration');
    writeFileSync(join(repository, 'tracked.txt'), 'before\n');
    runGit('add', 'tracked.txt');
    assert(runGit('commit', '-m', 'base').status === 0, 'review fixture commit should succeed');
    writeFileSync(join(repository, 'tracked.txt'), 'after\n');
    writeFileSync(join(repository, 'untracked.txt'), 'new from phone\n');

    const c = makeClient(HOST_ID);
    await c.ready;
    await c.createSession('bash', BASH, repository);
    const probe = await c.reviewProbe(c.state.sessionId!);
    assert(probe.available && probe.mode === 'working', 'review probe should expose a dirty repository without patch contents');
    const result = await c.reviewSnapshot(c.state.sessionId!);
    assert(!result.error && result.snapshot, `review should return a snapshot: ${result.error}`);
    assert(result.snapshot.repositoryPath === realpathSync(repository), 'review must resolve the session cwd instead of a client path');
    assert(result.snapshot.dirty && result.snapshot.branch === 'main', 'review should report the live branch and dirty state');
    assert(
      result.snapshot.files.some((file) => file.path === 'tracked.txt' && file.status === 'modified')
        && result.snapshot.files.some((file) => file.path === 'untracked.txt' && file.status === 'untracked'),
      'review should include tracked and untracked changes',
    );
    const project = await c.reviewSnapshot(c.state.sessionId!, 'files');
    assert(
      project.snapshot?.mode === 'files'
        && project.snapshot.files.some((file) => file.path === 'tracked.txt' && file.hunks.length === 0)
        && project.snapshot.files.some((file) => file.path === 'untracked.txt'),
      'project mode should return tracked and unignored untracked paths without eager file content',
    );
    const source = await c.reviewSnapshot(c.state.sessionId!, 'files', undefined, 'tracked.txt');
    assert(
      source.snapshot?.files.find((file) => file.path === 'tracked.txt')?.hunks[0]?.lines[0]?.text === 'after',
      'selecting a known project path should load its source with line metadata',
    );
    runGit('add', 'tracked.txt', 'untracked.txt');
    assert(runGit('commit', '-m', 'clean').status === 0, 'review fixture clean commit should succeed');
    const cleanProbe = await c.reviewProbe(c.state.sessionId!);
    assert(cleanProbe.available && cleanProbe.mode === 'files', 'clean repositories should keep the project browser entry');
    c.kill(c.state.sessionId!);
    c.close();
  });

  await scenario('21. conversation repositories: the Agent record names every repository it changed', async () => {
    const root = mkdtempSync(join('/tmp', `tb-test-conversation-${process.pid}-`));
    const { mkdirSync } = await import('node:fs');
    const own = join(root, 'own'), other = join(root, 'other'), unrelated = join(root, 'unrelated');
    for (const repository of [own, other, unrelated]) {
      mkdirSync(join(repository, 'art'), { recursive: true });
      const runGit = (...args: string[]) => spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
      assert(runGit('init', '-b', 'main').status === 0, 'conversation fixture Git init should succeed');
      runGit('config', 'user.email', 'integration@termbridge.local');
      runGit('config', 'user.name', 'Termbridge Integration');
      writeFileSync(join(repository, 'README.md'), 'before\n');
      writeFileSync(join(repository, 'art', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]));
      runGit('add', '.');
      assert(runGit('commit', '-m', 'base').status === 0, 'conversation fixture commit should succeed');
    }
    writeFileSync(join(other, 'README.md'), 'after\n');
    writeFileSync(join(other, 'art', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 2]));
    writeFileSync(join(unrelated, 'README.md'), 'never mentioned\n');
    const record = join(root, 'rollout.jsonl');
    writeFileSync(record, [
      { type: 'session_meta', payload: { id: '77777777-7777-4777-8777-777777777777', cwd: own } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', status: 'completed', changes: {
        [join(other, 'README.md')]: { type: 'update', unified_diff: '' },
        [join(other, 'art', 'logo.png')]: { type: 'update', unified_diff: '' },
      } } } },
    ].map((value) => JSON.stringify(value)).join('\n') + '\n');

    const reopened = herdrClosed;
    herdrClosed = false;
    herdrPaneCwd = own;
    herdrAgentSession = { agent: 'codex', kind: 'path', value: record };
    const c = makeClient(HOST_ID);
    try {
      await c.ready;
      const sessionId = 'herdr:wH:p1';
      const listed = await c.reviewRepositories(sessionId);
      assert(!listed.error && listed.repositories, `repositories should be listed: ${listed.error}`);
      const paths = listed.repositories.map((repository) => repository.repositoryPath);
      assert(paths.length === 2 && paths[0] === realpathSync(own) && paths[1] === realpathSync(other),
        `the session's own repository comes first, then the one its record changed: ${JSON.stringify(paths)}`);
      const changed = listed.repositories[1];
      assert(listed.repositories[0].current && !changed.current, 'only the cwd repository is current');
      assert(JSON.stringify(changed.touched) === JSON.stringify(['README.md', 'art/logo.png']),
        `touched files are repository-relative: ${JSON.stringify(changed.touched)}`);
      assert(changed.files.some((file) => file.path === 'art/logo.png' && file.binary), 'a changed image is listed as binary');
      assert(!paths.includes(realpathSync(unrelated)), 'a repository the conversation never touched is not listed');

      const snapshot = await c.reviewSnapshotIn(sessionId, changed.repositoryPath, 'README.md');
      assert(snapshot.snapshot?.repositoryPath === changed.repositoryPath
        && snapshot.snapshot.files.find((file) => file.path === 'README.md')?.hunks.length === 1,
        `a listed repository can be reviewed by its path: ${snapshot.error}`);
      const refused = await c.reviewSnapshotIn(sessionId, realpathSync(unrelated));
      assert(refused.error === 'Unknown repository for this conversation' && !refused.snapshot,
        'an unlisted repository path is refused');

      const current = await c.fileRead(sessionId, join(other, 'art', 'logo.png'));
      assert(!current.error && Buffer.from(current.data).at(-1) === 2,
        `a touched repository outside the cwd is readable: ${current.error}`);
      const committed = await c.fileRead(sessionId, join(other, 'art', 'logo.png'), 'HEAD');
      assert(!committed.error && Buffer.from(committed.data).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]))
        && String(committed.version).startsWith('HEAD:'), `HEAD returns the committed image: ${committed.error}`);
      const outside = await c.fileRead(sessionId, join(unrelated, 'README.md'));
      assert(outside.error && !outside.data, 'files in unrelated repositories stay unreadable');
    } finally {
      c.close();
      herdrPaneCwd = undefined;
      herdrAgentSession = undefined;
      herdrClosed = reopened;
      rmSync(root, { recursive: true, force: true });
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '─'.repeat(48));
  if (failed.length === 0) {
    console.log(`\x1b[32mALL PASS\x1b[0m  (${results.length} scenarios)`);
  } else {
    console.log(`\x1b[31mFAILED\x1b[0m  ${failed.length}/${results.length}: ${failed.map((f) => f.name).join(', ')}`);
  }
  cleanup();
  process.exit(failed.length === 0 ? 0 : 1);
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

main().catch((e) => {
  console.error('\x1b[31mharness error\x1b[0m:', e.message);
  cleanup();
  process.exit(1);
});
