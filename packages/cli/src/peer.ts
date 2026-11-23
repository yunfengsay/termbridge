import net from 'node:net';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { appControl } from './appControl.js';
import {
  createAndroidArtifactSender,
  describeAndroidArtifact,
  readAndroidArtifactChunks,
} from './androidArtifact.js';

/**
 * `tb peer …` — discover and address clients connected to this Host.
 *
 * Meant to be invoked by the agent from inside a tb session: it reaches the
 * host's peer bridge over a unix socket whose path + token were injected into the
 * session env (TB_BRIDGE_SOCK / TB_BRIDGE_TOKEN / TB_SESSION). The bridge forwards
 * the call to the selected device, which runs it locally (if it has opted in with
 * `tb expose`) and replies. stdout/stderr/exit are passed straight through, so
 * the agent uses it exactly like a local shell/file command.
 *
 *   tb peer list
 *   tb peer exec [--device ID] [--shell] [--cwd D] [--timeout MS] -- <argv…>
 *   tb peer read <path> [--max-bytes N]      tb peer write <path> [--from F] [--mkdirp]
 *   tb peer ls [path]   tb peer stat <path>  tb peer info
 *   tb peer logcat [--lines N] [--system]   tb peer apk install <file.apk>
 *   tb peer photo pull <action-id> <asset-id> <output> [--device <id>]
 *   tb peer photo publish <action-id> <edited-image...> [--device <id>]
 */
export interface PeerResult {
  ok: boolean;
  exit?: number;
  stdout?: string;
  stderr?: string;
  data?: unknown;
  error?: string;
}
export type PeerInvoker = (op: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<PeerResult>;

type AndroidPeerRetryAction = 'retry' | 'accepted' | 'fail';

const APP_DEVICE_OPS = new Set([
  'peer.list',
  'peer.topology',
  'termbridge.lan',
  'computer.tools',
  'computer.call',
  'info',
  'android.logcat',
  'artifact.begin',
  'artifact.chunk',
  'artifact.commit',
  'artifact.delete',
  'android.install_apk',
  'android.install_status',
  'phone.action',
  'phone.action.status',
  'phone.action.cancel',
  'phone.asset.read',
  'phone.asset.delete',
  'phone.photo.publish.begin',
  'phone.photo.publish.chunk',
  'phone.photo.publish.commit',
  'phone.photo.publish.abort',
]);

export function resolvePeerBridgeTarget(
  op: string,
  environment: NodeJS.ProcessEnv = process.env,
): { sock?: string; session?: string } {
  const herdrPane = environment.HERDR_PANE_ID;
  const herdrSession = herdrPane ? `herdr:${herdrPane}` : undefined;
  const appSession = APP_DEVICE_OPS.has(op) ? 'app' : undefined;
  return {
    sock: environment.TB_BRIDGE_SOCK ||
      (herdrSession || appSession ? join(homedir(), '.termbridge', 'host.sock') : undefined),
    session: environment.TB_SESSION || herdrSession || appSession,
  };
}

/** Keep large phone transfers alive across screen-off and short mobile-network gaps. */
export function androidPeerRetryAction(op: string, error: string, sawTransient: boolean): AndroidPeerRetryAction {
  if (sawTransient && op === 'artifact.chunk' && /artifact chunk offset mismatch/i.test(error)) return 'accepted';
  if (sawTransient && op === 'artifact.commit' && /artifact upload is not active/i.test(error)) return 'accepted';
  if (sawTransient && op === 'phone.photo.publish.chunk' && /edited photo chunk offset mismatch/i.test(error)) return 'accepted';
  if (sawTransient && op === 'phone.photo.publish.commit' && /edited photo upload is not active/i.test(error)) return 'accepted';
  if (
    /no client attached|tool timed out|client unresponsive|cannot reach host bridge|ECONNREFUSED|socket hang up|connection reset/i
      .test(error)
  ) return 'retry';
  return 'fail';
}

export async function callBridge(op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<PeerResult> {
  let { sock, session } = resolvePeerBridgeTarget(op);
  if (!process.env.TB_BRIDGE_SOCK && session && (!sock || !existsSync(sock))) {
    try {
      const bridge = await appControl({ action: 'bridge' }, { timeoutMs: 2000 });
      if (typeof bridge.socket === 'string' && bridge.socket.startsWith('/')) sock = bridge.socket;
    } catch { /* Keep the original explicit connection error. No guessed paths. */ }
  }
  const token = process.env.TB_BRIDGE_TOKEN || '';
  if (!sock || !session) {
    return Promise.resolve({
      ok: false,
      error: 'desktop peer tools must run inside a TermBridge session; native app tools also work from a local shell.',
    });
  }
  // Host validates a tokenless desktop request against its live Herdr registry.
  // The selected desktop independently checks tb expose for every operation.
  return new Promise((resolve) => {
    const conn = net.createConnection(sock);
    let buf = '';
    conn.on('connect', () => conn.write(JSON.stringify({ token, session, op, args, timeoutMs }) + '\n'));
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch {
        resolve({ ok: false, error: 'bad bridge response' });
      }
      conn.end();
    });
    conn.on('error', (e) => resolve({ ok: false, error: `cannot reach host bridge: ${(e as Error).message}` }));
  });
}

async function androidPeerCall(
  invoke: typeof callBridge,
  op: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  reconnectWindowMs = 10 * 60_000,
): Promise<PeerResult> {
  const deadline = Date.now() + reconnectWindowMs;
  let sawTransient = false;
  let waiting = false;
  while (true) {
    const result = await invoke(op, args, timeoutMs);
    if (result.ok) {
      if (waiting) process.stderr.write(`Phone reconnected; ${op.startsWith('artifact.') ? 'APK upload' : 'device transfer'} resumed.\n`);
      return result;
    }
    const error = result.error || `${op} failed`;
    const action = androidPeerRetryAction(op, error, sawTransient);
    if (action === 'accepted') return { ok: true };
    if (action === 'fail' || Date.now() >= deadline) return result;
    sawTransient = true;
    if (!waiting) {
      process.stderr.write(`Phone disconnected; waiting up to 10 minutes to resume this ${op.startsWith('artifact.') ? 'APK upload' : 'device transfer'}…\n`);
      waiting = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function die(msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function describePhoneImage(path: string): {
  id: string; name: string; size: number; sha256: string; mime: string;
} {
  const stats = statSync(path);
  if (!stats.isFile() || stats.size <= 0) throw new Error(`not a non-empty image file: ${path}`);
  if (stats.size > 40 * 1024 * 1024) throw new Error(`edited image exceeds 40 MiB: ${path}`);
  const extension = basename(path).split('.').pop()?.toLowerCase();
  const mime = extension === 'png' ? 'image/png'
    : extension === 'webp' ? 'image/webp'
      : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
        : undefined;
  if (!mime) throw new Error(`edited image must be JPEG, PNG, or WebP: ${path}`);
  const hash = createHash('sha256');
  for (const chunk of readAndroidArtifactChunks(path)) hash.update(chunk.data);
  return {
    id: randomUUID(),
    name: basename(path).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 120) || `edited.${extension}`,
    size: stats.size,
    sha256: hash.digest('hex'),
    mime,
  };
}

/**
 * The instruction block injected into the host's AI agents so they KNOW the
 * reverse channel exists and when to use it. Written to be a no-op for a normal
 * local session (where `tb peer info` errors) — so it's safe in global agent
 * config. `tb peer prompt` prints it; `tb peer setup` installs it.
 */
const PEER_PROMPT = `## termbridge — the user may be on a remote machine
One Host can have several computers and phones. Run tb peer list to discover stable device IDs. Pass --device ID before the -- separator to select the intended computer in info, exec and filesystem commands. Never infer the target from connection order; missing or ambiguous devices must not fall back silently.
You might be running inside a **termbridge** session, driven from the user's own machine (a laptop or Windows PC) over a relay. When so, you can operate THAT machine — not just this host — with the \`tb peer\` CLI:
- \`tb peer info\` — is a client attached, and its OS? (\`darwin\`→bash, \`win32\`→PowerShell). If it errors with "must run inside a termbridge session" or "no client attached", you are local — ignore this section.
- \`tb peer exec -- <argv…>\`  (add \`--shell\` for pipes/globs/redirects) — run a command on the user's machine
- \`tb peer read <path>\` · \`tb peer write <path>\` · \`tb peer ls [path]\` · \`tb peer stat <path>\` — their files
- Android peers expose a deliberately narrow native tool set instead of a shell: \`tb peer logcat\`, \`tb peer apk install <file.apk>\`, \`tb peer photo pull <action-id> <asset-id> <output>\`, and \`tb peer photo publish <action-id> <edited-image...>\`. Photo access is limited to assets the user explicitly selected in Android's system picker; pull every listed asset, edit it, then publish all outputs in one command. These commands also work directly inside an identified Herdr pane. APK and photo bytes are encrypted end to end; APK installation still requires Android's system confirmation.
Reach for these whenever the user means THEIR machine or phone ("my files", "on my laptop", "install this APK"). Your built-in tools act on the host you run on; \`tb peer\` acts on the user's attached device. Desktop access is gated by \`tb expose\`; Android never exposes arbitrary shell execution.`;

const MARK_START = '<!-- termbridge:peer:start -->';
const MARK_END = '<!-- termbridge:peer:end -->';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Idempotently install/remove the managed block in an agent instruction file. */
function applyBlock(file: string, remove: boolean): 'installed' | 'updated' | 'removed' | 'unchanged' {
  let cur = '';
  try {
    cur = readFileSync(file, 'utf8');
  } catch {
    /* missing → treat as empty */
  }
  const re = new RegExp(`\\n*${escapeRe(MARK_START)}[\\s\\S]*?${escapeRe(MARK_END)}\\n*`);
  const had = re.test(cur);
  let next: string;
  if (remove) {
    if (!had) return 'unchanged';
    next = (cur.replace(re, '\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n').replace(/^\n+/, '');
  } else {
    const block = `${MARK_START}\n${PEER_PROMPT}\n${MARK_END}`;
    next = had ? cur.replace(re, `\n\n${block}\n`) : (cur.trim() ? cur.trimEnd() + '\n\n' : '') + block + '\n';
  }
  if (next === cur) return 'unchanged';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  return remove ? 'removed' : had ? 'updated' : 'installed';
}

/** `tb peer setup` — teach the host's AI agents about `tb peer` (one-time, on the host). */
function runSetup(remove: boolean, only: { claude: boolean; codex: boolean }): never {
  const home = homedir();
  const targets = [
    { name: 'Claude Code', file: join(home, '.claude', 'CLAUDE.md'), dir: join(home, '.claude'), pick: only.claude },
    { name: 'codex', file: join(home, '.codex', 'AGENTS.md'), dir: join(home, '.codex'), pick: only.codex },
  ];
  const explicit = only.claude || only.codex;
  const chosen = targets.filter((t) => (explicit ? t.pick : existsSync(t.dir)));
  if (chosen.length === 0) {
    process.stderr.write(
      'no agent config found (~/.claude or ~/.codex). Either install one, force a target\n' +
        '(tb peer setup --claude / --codex), or wire it in by hand:\n' +
        '  <your-agent-launch> --append-system-prompt "$(tb peer prompt)"\n',
    );
    process.exit(1);
  }
  for (const t of chosen) {
    const status = applyBlock(t.file, remove);
    process.stdout.write(`${status === 'unchanged' ? '·' : '✔'} ${t.name.padEnd(11)} ${status.padEnd(9)} ${t.file}\n`);
  }
  process.stdout.write(
    remove ? 'done — agents will no longer be told about tb peer.\n' : 'done — new agent sessions on this host now know to use tb peer.\n',
  );
  process.exit(0);
}

interface Parsed {
  flags: Record<string, string | boolean | undefined>;
  positional: string[];
  dashed: string[]; // everything after `--`
}
function parseArgs(rest: string[]): Parsed {
  const flags: Record<string, string | boolean | undefined> = {};
  const positional: string[] = [];
  let dashed: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      dashed = rest.slice(i + 1);
      break;
    }
    if (a === '--shell' || a === '-s') flags.shell = true;
    else if (a === '--system') flags.system = true;
    else if (a === '--mkdirp') flags.mkdirp = true;
    else if (a === '--remove' || a === '--uninstall') flags.remove = true;
    else if (a === '--claude') flags.claude = true;
    else if (a === '--codex') flags.codex = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--device') {
      const device = rest[++i];
      if (!device || device.startsWith('--')) die('--device requires an exact ID from tb peer list');
      flags.device = device;
    }
    else if (a === '--cwd') flags.cwd = rest[++i];
    else if (a === '--timeout') flags.timeout = rest[++i];
    else if (a === '--max-bytes') flags.maxBytes = rest[++i];
    else if (a === '--from') flags.from = rest[++i];
    else if (a === '--lines') flags.lines = rest[++i];
    else if (a === '--level') flags.level = rest[++i];
    else positional.push(a);
  }
  return { flags, positional, dashed };
}

export async function runPeer(rest: string[], invoke: PeerInvoker = callBridge): Promise<void> {
  const callBridge = invoke;
  const callAndroidPeerResilient = (op: string, args: Record<string, unknown>, timeoutMs: number, reconnectWindowMs?: number) =>
    androidPeerCall(invoke, op, args, timeoutMs, reconnectWindowMs);
  const sub = rest[0];
  const { flags, positional, dashed } = parseArgs(rest.slice(1));

  switch (sub) {
    case 'topology': {
      const result = await callBridge('peer.topology', {});
      if (!result.ok) die(result.error || 'topology unavailable');
      process.stdout.write(JSON.stringify(result.data, null, 2) + '\n');
      return;
    }
    case 'list': {
      const result = await callBridge('peer.list', {});
      if (!result.ok) die(result.error || 'peer discovery failed');
      process.stdout.write(JSON.stringify(result.data, null, 2) + '\n');
      process.exit(0);
      break;
    }
    case 'computer': {
      const [action, name, json] = positional;
      if (!['tools', 'call'].includes(action ?? '') || positional.length > 3) {
        die('usage: tb peer computer tools [--device ID] | tb peer computer call <tool> [JSON] [--device ID]');
      }
      let parameters: Record<string, unknown> = {};
      if (action === 'call') {
        if (!name || (json && Buffer.byteLength(json) > 65_536)) die('computer call requires a tool name and bounded JSON object');
        try { parameters = JSON.parse(json || '{}'); } catch { die('computer arguments must be valid JSON'); }
        if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) die('computer arguments must be a JSON object');
      }
      const result = await callBridge(`computer.${action}`, {
        deviceId: flags.device, ...(action === 'call' ? { name, arguments: parameters } : {}),
      }, 35_000);
      if (!result.ok) die(result.error || 'computer operation failed');
      // Screenshots are larger than a pipe buffer. Flush before the forced exit
      // so callers receive complete MCP JSON and base64 image data.
      const output = result.stdout ? result.stdout + '\n' : JSON.stringify(result.data, null, 2) + '\n';
      await new Promise<void>((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
      process.exit(result.exit ?? 0);
      break;
    }
    case 'exec': {
      const argv = dashed.length ? dashed : positional;
      if (argv.length === 0) die('usage: tb peer exec [--shell] [--cwd D] [--timeout MS] -- <argv…>');
      const timeoutMs = flags.timeout ? Number(flags.timeout) : undefined;
      const r = await callBridge('exec', { argv, shell: !!flags.shell, cwd: flags.cwd, timeoutMs, deviceId: flags.device }, timeoutMs);
      if (!r.ok) die(r.error || 'exec failed');
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      process.exit(r.exit ?? 0);
      break;
    }
    case 'read': {
      const path = positional[0];
      if (!path) die('usage: tb peer read <path> [--max-bytes N]');
      const r = await callBridge('fs.read', { path, maxBytes: flags.maxBytes ? Number(flags.maxBytes) : undefined, deviceId: flags.device });
      if (!r.ok) die(r.error || 'read failed');
      const d = r.data as { content: string; encoding: string; truncated: boolean };
      process.stdout.write(d.encoding === 'base64' ? Buffer.from(d.content, 'base64') : Buffer.from(d.content, 'utf8'));
      if (d.truncated) process.stderr.write('\n[truncated — pass --max-bytes to read more]\n');
      process.exit(0);
      break;
    }
    case 'write': {
      const path = positional[0];
      if (!path) die('usage: tb peer write <path> [--from FILE] [--mkdirp]   (else reads stdin)');
      let content: Buffer;
      try {
        content = flags.from ? readFileSync(String(flags.from)) : readFileSync(0); // fd 0 = stdin
      } catch (e) {
        die(`cannot read input: ${(e as Error).message}`);
      }
      const r = await callBridge('fs.write', { path, content: content.toString('base64'), encoding: 'base64', mkdirp: !!flags.mkdirp, deviceId: flags.device });
      if (!r.ok) die(r.error || 'write failed');
      process.stderr.write(`wrote ${(r.data as { bytes: number }).bytes}B → ${path}\n`);
      process.exit(0);
      break;
    }
    case 'ls': {
      const r = await callBridge('fs.ls', { path: positional[0] ?? '.', deviceId: flags.device });
      if (!r.ok) die(r.error || 'ls failed');
      for (const e of (r.data as { entries: Array<{ name: string; type: string; size: number }> }).entries) {
        process.stdout.write(`${e.type === 'dir' ? 'd' : e.type === 'file' ? '-' : '?'} ${String(e.size).padStart(10)}  ${e.name}\n`);
      }
      process.exit(0);
      break;
    }
    case 'stat': {
      const path = positional[0];
      if (!path) die('usage: tb peer stat <path>');
      const r = await callBridge('fs.stat', { path, deviceId: flags.device });
      if (!r.ok) die(r.error || 'stat failed');
      process.stdout.write(JSON.stringify(r.data, null, 2) + '\n');
      process.exit(0);
      break;
    }
    case 'info': {
      const r = await callBridge('info', { deviceId: flags.device });
      if (!r.ok) die(r.error || 'info failed');
      process.stdout.write(JSON.stringify(r.data, null, 2) + '\n');
      process.exit(0);
      break;
    }
    case 'logcat': {
      const lines = Math.max(1, Math.min(2_000, Number(flags.lines) || 200));
      const level = String(flags.level || 'V').toUpperCase();
      if (!['V', 'D', 'I', 'W', 'E', 'F'].includes(level)) {
        die('usage: tb peer logcat [--lines 1..2000] [--level V|D|I|W|E|F] [--system]');
      }
      const r = await callBridge('android.logcat', {
        lines,
        level,
        scope: flags.system ? 'system' : 'app',
        deviceId: flags.device,
      }, 15_000);
      if (!r.ok) die(r.error || 'logcat failed');
      const data = r.data as { text?: string; scope?: string; truncated?: boolean };
      if (data.text) process.stdout.write(data.text);
      if (data.truncated) process.stderr.write('\n[logcat output truncated]\n');
      process.exit(0);
      break;
    }
    case 'apk': {
      const action = positional[0];
      if (action === 'install') {
        const path = positional[1];
        if (!path) die('usage: tb peer apk install <file.apk>');
        let descriptor: ReturnType<typeof describeAndroidArtifact>;
        try {
          descriptor = describeAndroidArtifact(path);
        } catch (error) {
          die(`cannot prepare APK: ${(error as Error).message}`);
        }
        const sender = createAndroidArtifactSender();
        const begun = await callAndroidPeerResilient('artifact.begin', {
          ...descriptor,
          deviceId: flags.device,
          senderPublicKey: sender.senderPublicKey,
          salt: sender.salt,
        }, 15_000);
        if (!begun.ok) die(begun.error || 'phone refused APK upload');
        const receiverPublicKey = (begun.data as { receiverPublicKey?: string }).receiverPublicKey;
        if (!receiverPublicKey) die('phone returned no artifact encryption key');

        let lastPercent = -1;
        try {
          for (const chunk of readAndroidArtifactChunks(path)) {
            const encrypted = sender.encrypt(receiverPublicKey, descriptor.id, chunk.offset, chunk.data);
            const uploaded = await callAndroidPeerResilient('artifact.chunk', {
              id: descriptor.id,
              offset: chunk.offset,
              ...encrypted,
              deviceId: flags.device,
            }, 30_000);
            if (!uploaded.ok) throw new Error(uploaded.error || `upload failed at byte ${chunk.offset}`);
            const percent = Math.floor(((chunk.offset + chunk.data.length) * 100) / descriptor.size);
            if (percent === 100 || percent >= lastPercent + 10) {
              process.stderr.write(`APK upload ${percent}%\n`);
              lastPercent = percent;
            }
          }
          const committed = await callAndroidPeerResilient('artifact.commit', { id: descriptor.id, deviceId: flags.device }, 30_000);
          if (!committed.ok) throw new Error(committed.error || 'APK verification failed');
        } catch (error) {
          await callBridge('artifact.delete', { id: descriptor.id, deviceId: flags.device }, 5_000).catch(() => undefined);
          die((error as Error).message);
        }

        const installed = await callBridge('android.install_apk', { artifactId: descriptor.id, deviceId: flags.device }, 20_000);
        if (!installed.ok) die(installed.error || 'APK install request failed');
        const installData = (installed.data as Record<string, unknown> | undefined) ?? {};
        process.stdout.write(JSON.stringify({
          artifactId: descriptor.id,
          sha256: descriptor.sha256,
          ...installData,
        }, null, 2) + '\n');
        process.exit(installData.status === 'permission_required' ? 2 : 0);
        break;
      }
      if (action === 'retry') {
        const artifactId = positional[1];
        if (!artifactId) die('usage: tb peer apk retry <artifact-id>');
        const r = await callBridge('android.install_apk', { artifactId, deviceId: flags.device }, 20_000);
        if (!r.ok) die(r.error || 'APK install retry failed');
        const data = (r.data as Record<string, unknown> | undefined) ?? {};
        process.stdout.write(JSON.stringify({ artifactId, ...data }, null, 2) + '\n');
        process.exit(data.status === 'permission_required' ? 2 : 0);
        break;
      }
      if (action === 'status') {
        const artifactId = positional[1];
        if (!artifactId) die('usage: tb peer apk status <artifact-id>');
        const r = await callBridge('android.install_status', { artifactId, deviceId: flags.device });
        if (!r.ok) die(r.error || 'cannot read install status');
        process.stdout.write(JSON.stringify(r.data, null, 2) + '\n');
        process.exit(0);
        break;
      }
      if (action === 'delete' || action === 'remove') {
        const artifactId = positional[1];
        if (!artifactId) die('usage: tb peer apk delete <artifact-id>');
        const r = await callBridge('artifact.delete', { id: artifactId, deviceId: flags.device });
        if (!r.ok) die(r.error || 'cannot delete APK artifact');
        process.stdout.write(JSON.stringify(r.data, null, 2) + '\n');
        process.exit(0);
        break;
      }
      die('usage: tb peer apk <install FILE.apk|retry ID|status ID|delete ID>');
      break;
    }
    case 'photo': {
      const action = positional[0];
      if (action === 'pull') {
        const actionId = positional[1];
        const assetId = positional[2];
        const output = positional[3];
        if (!actionId || !assetId || !output) {
          die('usage: tb peer photo pull <action-id> <asset-id> <output> [--device <id>] [--force]');
        }
        if (existsSync(output) && !flags.force) die(`refusing to overwrite ${output}; pass --force`);
        mkdirSync(dirname(output), { recursive: true });
        const partial = `${output}.termbridge-part`;
        if (existsSync(partial)) unlinkSync(partial);
        const descriptor = openSync(partial, 'wx');
        const digest = createHash('sha256');
        const crypto = createAndroidArtifactSender();
        let offset = 0;
        let expectedSize: number | undefined;
        let expectedHash = '';
        try {
          while (true) {
            const response = await callAndroidPeerResilient('phone.asset.read', {
              actionId,
              assetId,
              offset,
              length: 96 * 1024,
              deviceId: flags.device,
              clientPublicKey: crypto.senderPublicKey,
              salt: crypto.salt,
            }, 20_000);
            if (!response.ok) throw new Error(response.error || 'selected photo read failed');
            const data = response.data as Record<string, unknown>;
            if (data.encrypted !== true || typeof data.phonePublicKey !== 'string' ||
                typeof data.iv !== 'string' || typeof data.ciphertext !== 'string' || typeof data.plainBytes !== 'number') {
              throw new Error('phone returned an invalid photo chunk');
            }
            const chunk = crypto.decrypt(
              data.phonePublicKey,
              assetId,
              offset,
              data.plainBytes,
              data.iv,
              data.ciphertext,
            );
            if (chunk.length > 96 * 1024) throw new Error('phone returned an oversized photo chunk');
            writeSync(descriptor, chunk);
            digest.update(chunk);
            offset += chunk.length;
            expectedSize = typeof data.size === 'number' ? data.size : expectedSize;
            expectedHash = typeof data.sha256 === 'string' ? data.sha256 : expectedHash;
            const nextOffset = typeof data.nextOffset === 'number' ? data.nextOffset : offset;
            if (nextOffset !== offset) throw new Error('phone returned a discontinuous photo chunk');
            if (data.eof === true) break;
            if (chunk.length === 0) throw new Error('phone returned an empty non-final photo chunk');
          }
        } catch (error) {
          closeSync(descriptor);
          unlinkSync(partial);
          die((error as Error).message);
        }
        closeSync(descriptor);
        if (expectedSize !== undefined && offset !== expectedSize) {
          unlinkSync(partial);
          die(`selected photo size mismatch: expected ${expectedSize}, received ${offset}`);
        }
        const actualHash = digest.digest('hex');
        if (expectedHash && actualHash !== expectedHash) {
          unlinkSync(partial);
          die('selected photo SHA-256 verification failed');
        }
        if (existsSync(output)) unlinkSync(output);
        renameSync(partial, output);
        process.stdout.write(JSON.stringify({ actionId, assetId, output, size: offset, sha256: actualHash }, null, 2) + '\n');
        process.exit(0);
        break;
      }
      if (action === 'publish') {
        const actionId = positional[1];
        const paths = positional.slice(2);
        if (!actionId || paths.length === 0 || paths.length > 20) {
          die('usage: tb peer photo publish <action-id> <edited-image...> [--device <id>]');
        }
        const outputs: Record<string, unknown>[] = [];
        for (const [index, path] of paths.entries()) {
          let image: ReturnType<typeof describePhoneImage>;
          try {
            image = describePhoneImage(path);
          } catch (error) {
            die((error as Error).message);
          }
          const crypto = createAndroidArtifactSender();
          const begun = await callAndroidPeerResilient('phone.photo.publish.begin', {
            ...image,
            actionId,
            index,
            total: paths.length,
            senderPublicKey: crypto.senderPublicKey,
            salt: crypto.salt,
            deviceId: flags.device,
          }, 20_000);
          if (!begun.ok) die(begun.error || 'phone refused the edited photo');
          const receiverPublicKey = (begun.data as { receiverPublicKey?: string }).receiverPublicKey;
          if (!receiverPublicKey) die('phone returned no photo encryption key');
          try {
            for (const chunk of readAndroidArtifactChunks(path)) {
              const uploaded = await callAndroidPeerResilient('phone.photo.publish.chunk', {
                id: image.id,
                offset: chunk.offset,
                ...crypto.encrypt(receiverPublicKey, image.id, chunk.offset, chunk.data),
                deviceId: flags.device,
              }, 30_000);
              if (!uploaded.ok) throw new Error(uploaded.error || `edited photo upload failed at ${chunk.offset}`);
            }
            const committed = await callAndroidPeerResilient(
              'phone.photo.publish.commit', { id: image.id, deviceId: flags.device }, 30_000,
            );
            if (!committed.ok) throw new Error(committed.error || 'phone could not publish the edited photo');
            outputs.push((committed.data as Record<string, unknown> | undefined) ?? { id: image.id });
          } catch (error) {
            await callBridge('phone.photo.publish.abort', { id: image.id, deviceId: flags.device }, 5_000)
              .catch(() => undefined);
            die((error as Error).message);
          }
        }
        process.stdout.write(JSON.stringify({ actionId, outputs }, null, 2) + '\n');
        process.exit(0);
        break;
      }
      if (action === 'delete') {
        const actionId = positional[1];
        if (!actionId) die('usage: tb peer photo delete <action-id> [--device <id>]');
        const response = await callBridge('phone.asset.delete', { actionId, deviceId: flags.device });
        if (!response.ok) die(response.error || 'selected photo cleanup failed');
        process.stdout.write(JSON.stringify(response.data, null, 2) + '\n');
        process.exit(0);
        break;
      }
      die('usage: tb peer photo <pull ACTION_ID ASSET_ID OUTPUT|publish ACTION_ID FILE...|delete ACTION_ID>');
      break;
    }
    case 'prompt':
      // Emit the agent-facing instruction text (for manual --append-system-prompt wiring).
      process.stdout.write(PEER_PROMPT + '\n');
      process.exit(0);
      break;
    case 'setup':
      // Install (or --remove) that text into the host's agent config so sessions know.
      runSetup(!!flags.remove, { claude: !!flags.claude, codex: !!flags.codex });
      break;
    default:
      die("usage: tb peer <list|exec|read|write|ls|stat|info|computer|logcat|apk|photo|prompt|setup> [--device ID] — run on a connected peer");
  }
}
