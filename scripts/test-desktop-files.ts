/** Isolated real Relay/Host file streaming; optionally drives the macOS browser UI. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { encodeControl, parseFrame, type ControlMessage } from '../packages/protocol/src/index.js';
import { hmacHex } from '../packages/settings/src/index.js';

const root = await mkdtemp(join(tmpdir(), 'tb-desktop-files-'));
const children: ChildProcess[] = [];
let client: WebSocket | undefined;
let herdrFixture: { close(): void } | undefined;
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR,
  TB_CONFIG: join(root, 'config.json'), TB_SETTINGS: join(root, 'settings.json'),
  TB_CONTEXT_STATE: join(root, 'context.json'), TB_BRAIN_STATE: join(root, 'brain.json'),
  TB_BRAIN_MEMORY: join(root, 'memory.md'), TB_VOICE_LEARNING_DIR: join(root, 'learning'),
  TB_BRIDGE_SOCK: join(root, 'bridge.sock'), TB_BRIDGE_TOKEN: 'disposable-desktop-test',
  TB_HERDR_SOCKET: join(root, 'herdr.sock'), TB_BACKEND: 'direct', TB_SECRET: 'desktop-test-secret',
  HOST_ID: 'desktop-file-test', HOST_NAME: 'Desktop file fixture',
};
const RED_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAYAAAAGCAIAAABvrngfAAAAEUlEQVR4nGO4o6GBhhhoKwQAfvkqMfvTi9EAAAAASUVORK5CYII=', 'base64');
const BLUE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAYAAAAGCAIAAABvrngfAAAAEUlEQVR4nGPQiLqDhhhoKwQA3TAxOVNLRicAAAAASUVORK5CYII=', 'base64');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
async function repository(path: string, files: Record<string, string | Buffer>) {
  for (const [name, data] of Object.entries(files)) {
    await mkdir(join(path, name, '..'), { recursive: true }); await writeFile(join(path, name), data);
  }
  git(path, 'init', '-b', 'main'); git(path, 'config', 'user.email', 'files@termbridge.local'); git(path, 'config', 'user.name', 'Files');
  git(path, 'add', '.'); git(path, 'commit', '-m', 'base');
}
/** A Herdr pane whose Agent record names files in two repositories. */
function fakeHerdr(cwd: string, record: string) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk; const end = input.indexOf('\n'); if (end < 0) return;
      const request = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
      const reply = (result: unknown) => socket.end(JSON.stringify({ id: request.id, result }) + '\n');
      if (request.method === 'session.snapshot') return reply({ type: 'session_snapshot', snapshot: {
        version: 'fixture', protocol: 22, workspaces: [{ workspace_id: 'wD', label: 'project' }],
        panes: [{ pane_id: 'wD:p1', workspace_id: 'wD', tab_id: 'wD:t1', agent: 'codex', agent_status: 'idle', revision: 1, cwd,
          agent_session: { agent: 'codex', kind: 'path', value: record } }],
        agents: [], layouts: [{ panes: [{ pane_id: 'wD:p1', rect: { width: 100, height: 30 } }] }],
      } });
      if (request.method === 'pane.read') return reply({ read: { text: 'fixture', revision: 1 } });
      if (request.method === 'events.wait') return socket.end(JSON.stringify({ id: request.id, error: { code: 'unsupported_event_wait_match', message: 'polling' } }) + '\n');
      reply({ type: 'ok' });
    });
  });
  return { server, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}
async function boot(entry: string, match: RegExp) {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve(entry)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timeout: ${entry}`)), 15000);
    let output = '';
    child.stdout!.on('data', b => { output += b; if (match.test(output)) { clearTimeout(timer); resolve(); } });
    child.stderr!.on('data', () => {});
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Startup exit ${entry}: ${code}`)); });
  });
}
try {
  await writeFile(env.TB_CONFIG!, JSON.stringify({ shell: '/bin/sh', agents: {} }));
  await writeFile(env.TB_SETTINGS!, '{}');
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve()));
  env.PORT = String(port); env.RELAY_URL = `ws://127.0.0.1:${port}`;
  const workspace = join(root, 'project'); await mkdir(join(workspace, 'reports'), { recursive: true });
  const body = '# Remote preview\n' + 'file chunk content\n'.repeat(18000);
  await repository(workspace, {
    'reports/large.md': body, 'reports/second.txt': 'Second remote file',
    'src/app.ts': 'export function greet(name: string) {\n  return `hello ${name}`;\n}\n', 'art/logo.png': RED_PNG,
  });
  // Uncommitted work in the session's own repository: code, a picture, a new note.
  await writeFile(join(workspace, 'src', 'app.ts'), 'export function greet(name: string) {\n  // A changed line\n  return `hi ${name}`;\n}\n');
  await writeFile(join(workspace, 'art', 'logo.png'), BLUE_PNG);
  await mkdir(join(workspace, 'notes')); await writeFile(join(workspace, 'notes', 'new.md'), '# New note\n');
  await writeFile(join(workspace, 'reports', 'chart.png'), RED_PNG);
  await writeFile(join(workspace, '.env'), 'never-return-this');
  // A second repository the conversation changed: one file still dirty, one already committed.
  const other = join(root, 'other');
  await repository(other, { 'README.md': 'Other repository\n' });
  await writeFile(join(other, 'README.md'), 'Other repository, edited by the Agent\n');
  await mkdir(join(other, 'docs')); await writeFile(join(other, 'docs', 'done.md'), 'Committed by the Agent\n');
  git(other, 'add', 'docs/done.md'); git(other, 'commit', '-m', 'agent commit');
  const record = join(root, 'rollout.jsonl');
  await writeFile(record, [
    { type: 'session_meta', payload: { id: '88888888-8888-4888-8888-888888888888', cwd: workspace } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', status: 'completed', changes: {
      [join(workspace, 'src', 'app.ts')]: { type: 'update', unified_diff: '' },
      [join(other, 'README.md')]: { type: 'update', unified_diff: '' },
      [join(other, 'docs', 'done.md')]: { type: 'add', content: '' },
    } } } },
  ].map((value) => JSON.stringify(value)).join('\n') + '\n');
  const herdr = fakeHerdr(workspace, record);
  herdrFixture = herdr;
  herdr.server.listen(env.TB_HERDR_SOCKET); await once(herdr.server, 'listening');
  await boot('packages/relay/src/index.ts', /listening/);
  await boot('packages/host/src/index.ts', /online as id=desktop-file-test/);
  client = new WebSocket(env.RELAY_URL);
  const messages: ControlMessage[] = [];
  client.on('message', raw => {
    const frame = parseFrame(raw as Buffer); if (frame.type !== 0) return;
    if (frame.msg.t === 'auth_challenge') {
      client!.send(encodeControl({ t: 'auth_response', mac: hmacHex(env.TB_SECRET, frame.msg.nonce) }));
      client!.send(encodeControl({ t: 'hello', role: 'client', hostId: env.HOST_ID!, wantsHosts: true }));
    } else messages.push(frame.msg);
  });
  async function wait(type: string, id?: string): Promise<any> {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const i = messages.findIndex(m => m.t === type && (id == null || ('requestId' in m && m.requestId === id)));
      if (i >= 0) return messages.splice(i, 1)[0];
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out: ${type}`);
  }
  await wait('host_list_result');
  client.send(encodeControl({ t: 'session_create', command: '/bin/cat', cwd: workspace, cols: 80, rows: 24 }));
  const { sessionId } = await wait('session_created');
  let offset = 0, version: string | undefined;
  const chunks: Buffer[] = [];
  while (true) {
    const requestId = `chunk-${offset}`;
    client.send(encodeControl({ t: 'session_file_read', requestId, sessionId, path: 'reports/large.md', offset, version }));
    const chunk = await wait('session_file_result', requestId);
    assert.equal(chunk.error, undefined); assert.equal(chunk.offset, offset);
    assert(chunk.data instanceof Uint8Array); assert(chunk.data.length <= 128 * 1024);
    if (version) assert.equal(chunk.version, version); else version = chunk.version;
    chunks.push(chunk.data); offset += chunk.data.length;
    if (chunk.eof) { assert.equal(offset, chunk.size); break; }
  }
  assert.equal(Buffer.concat(chunks).toString(), body);
  client.send(encodeControl({ t: 'session_directory_list', requestId: 'tree', sessionId, path: '.' }));
  const tree = await wait('session_directory_result', 'tree');
  assert.deepEqual(tree.entries.map((entry: { name: string }) => entry.name), ['art', 'notes', 'reports', 'src']);
  for (const path of ['.env', '../settings.json']) {
    client.send(encodeControl({ t: 'session_file_read', requestId: 'deny', sessionId, path, offset: 0 }));
    const denied = await wait('session_file_result', 'deny'); assert(denied.error); assert.equal(denied.data, undefined);
  }
  console.log('PASS: real Relay/Host chunks, directory tree, scope and sensitive-file denial');
  client.send(encodeControl({ t: 'review_repositories', requestId: 'repos', sessionId: 'herdr:wD:p1' }));
  const listed = await wait('review_repositories_result', 'repos');
  assert.equal(listed.error, undefined, listed.error);
  assert.deepEqual(listed.repositories.map((repo: { repository: string }) => repo.repository), ['project', 'other']);
  console.log('PASS: the conversation lists its own repository and the one its record changed');
  // A private file is listed as changed, but neither the overview nor its own diff carries its contents.
  for (const path of [undefined, '.env']) {
    const requestId = `private-${path ?? 'overview'}`;
    client.send(encodeControl({ t: 'review_snapshot', requestId, sessionId: 'herdr:wD:p1', mode: 'working',
      repository: listed.repositories[0].repositoryPath, ...(path ? { path } : {}) }));
    const reply = await wait('review_snapshot_result', requestId);
    assert.equal(reply.error, undefined, reply.error);
    const secret = reply.snapshot.files.find((file: { path: string }) => file.path === '.env');
    assert.deepEqual([secret?.private, secret?.hunks.length], [true, 0]);
    assert(!JSON.stringify(reply).includes('never-return-this'), 'private contents stay on the Host');
  }
  console.log('PASS: private files are listed without their contents');
  if (process.argv.includes('--ui')) {
    const ui = spawn('swift', ['test', '--package-path', 'macos/TermBridgeControlCenter', '--filter', 'TerminalFilePreviewTests/testRealHost'], {
      env: { ...process.env, TB_FILE_PREVIEW_TEST_RELAY: env.RELAY_URL, TB_FILE_PREVIEW_TEST_SESSION: sessionId,
        TB_FILE_PREVIEW_TEST_WORKSPACE: workspace, TB_FILE_PREVIEW_TEST_CHANGES_SESSION: 'herdr:wD:p1' }, stdio: 'inherit',
    });
    children.push(ui);
    const [code] = await once(ui, 'exit'); assert.equal(code, 0, 'macOS browser acceptance');
  }
  client.send(encodeControl({ t: 'kill', sessionId }));
} finally {
  client?.close();
  herdrFixture?.close();
  for (const child of children.reverse()) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null) return;
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }));
  await rm(root, { recursive: true, force: true });
}
