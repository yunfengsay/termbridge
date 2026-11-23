// Single real relay + host + CLI acceptance. Does not use the user's settings, Host, Herdr, or credentials.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, stat, chmod, utimes, readdir } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
const root = await mkdtemp('/tmp/tb-auto-');
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(r => probe.close(r));
const env = { PATH: process.env.PATH, HOME: root, SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TMPDIR: root,
  HOST_ID: 'automation-acceptance', RELAY_URL: `ws://127.0.0.1:${port}`, PORT: String(port), TB_RELAY_NO_TLS: '1',
  TB_CONFIG: join(root, 'config.json'), TB_SETTINGS: join(root, 'settings.json'), TB_HOST_STATE_DIR: join(root, 'state'),
  TB_AUTOMATION_DIR: join(root, 'state'), TB_CONTROL_DIR: join(root, 'control'), TB_BRIDGE_SOCK: join(root, 'host.sock'), TB_HERDR: 'off', TB_BACKEND: 'direct' };
await writeFile(env.TB_CONFIG, JSON.stringify({ shell: '/bin/zsh', agents: {} })); await writeFile(env.TB_SETTINGS, '{}');
// Use TLS and a synthetic, per-run HMAC secret; never read user credentials.
env.TB_TLS_CERT = join(root, 'cert.pem'); env.TB_TLS_KEY = join(root, 'key.pem');
assert.equal(spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', env.TB_TLS_KEY, '-out', env.TB_TLS_CERT, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' }).status, 0);
env.TB_TLS_PIN = new X509Certificate(await readFile(env.TB_TLS_CERT)).fingerprint256;
env.TB_SECRET = randomBytes(32).toString('hex'); env.RELAY_URL = `wss://127.0.0.1:${port}`; delete env.TB_RELAY_NO_TLS;
const cli = resolve('dist/cli.js');
const children = [];
function start(file, args = [], extra = {}) { const c = spawn(process.execPath, [file, ...args], { env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(c); return c; }
function service(name) { const c = start(resolve(`dist/${name}.js`)); const log = createWriteStream(join(root, name + '.log')); c.stdout.pipe(log); c.stderr.pipe(log); return c; }
const relay = service('relay'), host = service('host');
async function run(args, options = {}) {
  const c = start(cli, args, options.env); const out = [], err = []; let size = 0;
  c.stdout.on('data', b => { size += b.length; if (!options.count) out.push(b); }); c.stderr.on('data', b => err.push(b));
  c.stdin.end(options.input); const timer = setTimeout(() => c.kill('SIGKILL'), options.timeout || 120000);
  const [code, signal] = await once(c, 'close'); clearTimeout(timer);
  return { code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err), size };
}
async function ok(args, options) { const r = await run(args, options); assert.equal(r.code, 0, `${args[0]}: ${r.stderr}`); return r; }
const sha = async path => { const h = createHash('sha256'); for await (const b of createReadStream(path)) h.update(b); return h.digest('hex'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await sleep(50); } throw new Error('condition timed out'); }
const report = { root };
try {
  await waitFor(() => existsSync(env.TB_BRIDGE_SOCK)); await sleep(500);
  assert.equal((await run(['exec', '--', '/usr/bin/true'], { env: { TB_TLS_PIN: '00'.repeat(32), TB_NO_CONTROL: '1' } })).code, 255);
  assert.equal((await run(['exec', '--', '/usr/bin/true'], { env: { TB_SECRET: 'synthetic-wrong-secret', TB_NO_CONTROL: '1' } })).code, 255);
  for (const code of [0, 1, 42]) assert.equal((await run(['exec', '--', '/bin/sh', '-c', `exit ${code}`])).code, code);
  assert.equal((await run(['exec', '--', '/bin/sh', '-c', 'kill -TERM $$'])).code, 143);
  const split = await ok(['exec', '--', '/bin/sh', '-c', 'printf out; printf err >&2']); assert.equal(String(split.stdout), 'out'); assert.equal(String(split.stderr), 'err');
  const bytes = await ok(['exec', '--', process.execPath, '-e', 'process.stdout.write(Buffer.alloc(50*1024*1024,7))'], { count: true }); assert.equal(bytes.size, 50 * 1024 * 1024);
  assert.equal(String((await ok(['exec', '--stdin', '--', '/bin/bash', '-s'], { input: 'printf stdin-ok\n' })).stdout), 'stdin-ok');
  const json = JSON.parse((await ok(['exec', '--json', '--', process.execPath, '-e', 'process.stdout.write(Buffer.from([0,255,1]));process.stderr.write("err")'])).stdout);
  assert.equal(json.encoding, 'base64'); assert.equal(json.stdout, 'AP8B'); assert.equal(json.stderr, 'ZXJy');
  const pidPath = join(root, 'grandchild.pid');
  const timed = await run(['exec', '--timeout', '0.5', '--', '/bin/sh', '-c', `sleep 90 & echo $! > '${pidPath}'; wait`]); assert.equal(timed.code, 137);
  const pid = Number(await readFile(pidPath, 'utf8')); await waitFor(() => spawnSync('/bin/ps', ['-p', String(pid), '-o', 'stat=']).status !== 0);
  const disconnectPath = join(root, 'disconnect.pid');
  const dc = start(cli, ['exec', '--', '/bin/sh', '-c', `sleep 90 & echo $! > '${disconnectPath}'; wait`]); dc.stdout.resume(); dc.stderr.resume();
  await waitFor(() => existsSync(disconnectPath)); dc.kill('SIGKILL'); const dp = Number(await readFile(disconnectPath, 'utf8')); await waitFor(() => spawnSync('/bin/ps', ['-p', String(dp)]).status !== 0);
  const countPty = () => (spawnSync('/usr/sbin/lsof', ['-nP', '/dev/ptmx'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean).slice(1).length;
  const before = countPty(); for (let n = 0; n < 200; n++) await ok(['exec', '--', '/usr/bin/true']); const after = countPty(); assert.equal(after, before); report.pty = { before, after, executions: 200 };
  for (const [label, mode] of [['direct100Ms', '1'], ['reused100Ms', '0']]) { const start = Date.now(); for (let n = 0; n < 100; n++) await ok(['exec', '--', '/usr/bin/true'], { env: { TB_NO_CONTROL: mode } }); report[label] = Date.now() - start; }
  const source = join(root, 'random.bin'); const sink = createWriteStream(source); for (let n = 0; n < 200; n++) if (!sink.write(randomBytes(1024 * 1024))) await once(sink, 'drain'); sink.end(); await once(sink, 'close');
  const fileStart = Date.now(); await ok(['push', source, join(root, 'remote.bin')]); await ok(['pull', join(root, 'remote.bin'), join(root, 'returned.bin')]);
  const digest = await sha(source); assert.equal(await sha(join(root, 'returned.bin')), digest); report.transfer = { bytes: 200 * 1024 * 1024, sha256: digest, roundTripMs: Date.now() - fileStart };
  const small = join(root, 'small'); await writeFile(small, Buffer.from([0, 255, 4])); assert.deepEqual((await ok(['cat', small])).stdout, await readFile(small));
  const dir = join(root, 'tree'); await mkdir(join(dir, 'sub'), { recursive: true }); await writeFile(join(dir, 'sub', 'x'), 'tree'); await chmod(join(dir, 'sub', 'x'), 0o751); await utimes(join(dir, 'sub', 'x'), 1000000000, 1000000000);
  await ok(['push', '-r', dir, join(root, 'remote-tree')]); await ok(['pull', '-r', join(root, 'remote-tree'), join(root, 'returned-tree')]); const info = await stat(join(root, 'returned-tree', 'sub', 'x')); assert.equal(info.mode & 0o777, 0o751); assert.equal(info.mtimeMs, 1000000000000);
  const partial = join(root, 'partial.bin'); const interrupted = start(cli, ['push', source, partial]); interrupted.stdout.resume(); interrupted.stderr.resume();
  await waitFor(async () => (await readdir(root)).some(x => x.startsWith('.partial.bin.tb-'))); interrupted.kill('SIGKILL'); await sleep(500); assert.equal(existsSync(partial), false); assert.equal((await readdir(root)).some(x => x.startsWith('.partial.bin.tb-')), false);
  const control = await readdir(env.TB_CONTROL_DIR); assert.equal((await stat(env.TB_CONTROL_DIR)).mode & 0o777, 0o700); for (const f of control) assert.equal((await stat(join(env.TB_CONTROL_DIR, f))).mode & 0o777, 0o600);
  const audit = String((await ok(['audit', '--tail', '10'])).stdout).trim().split('\n').map(JSON.parse); assert(audit.some(x => x.op === 'push')); assert(audit.some(x => x.op === 'pull')); assert(audit.every(x => !('env' in x) && !('stdout' in x)));
  await ok(['ls']); const legacy = await ok(['new', '--', '/bin/echo', 'legacy-ok']); assert(String(legacy.stdout).includes('legacy-ok'));
  if (process.env.TB_AUTOMATION_OLD_PACKAGE) {
    const old = start(join(process.env.TB_AUTOMATION_OLD_PACKAGE, 'dist/host.js'), [], { HOST_ID: 'old-acceptance', TB_BRIDGE_SOCK: join(root, 'old.sock'), TB_HOST_STATE_DIR: join(root, 'old-state') }); old.stdout.resume(); old.stderr.resume();
    await waitFor(() => existsSync(join(root, 'old.sock'))); await sleep(500);
    const rejected = await run(['exec', '-H', 'old-acceptance', '--', '/usr/bin/true']); assert.equal(rejected.code, 255); assert.match(String(rejected.stderr), /0.1.37.*upgrade host/); old.kill('SIGTERM');
    report.oldHost = '0.1.37 rejected before execution';
  }
  host.kill('SIGTERM'); await once(host, 'close');
  await writeFile(env.TB_CONFIG, JSON.stringify({ shell: '/bin/zsh', remoteAutomation: false }));
  const disabled = service('host'); await sleep(1000);
  assert.equal((await run(['exec', '--', '/usr/bin/true'], { env: { TB_NO_CONTROL: '1' } })).code, 255);
  await ok(['ls']); disabled.kill('SIGTERM');
  report.passed = ['TLS-pin-rejection', 'HMAC-rejection', 'host-disable-switch', 'exit-status', 'signals', 'split-streams', '50MiB-output', 'stdin-EOF', 'binary-JSON', 'timeout-tree', 'disconnect-tree', 'no-PTY-leak', '200MiB-sha256', 'tar-mode-mtime', 'interrupted-upload-atomic', 'control-permissions', 'audit', 'legacy-ls-new'];
  await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { for (const c of children) if (c.exitCode === null) c.kill('SIGTERM'); }
