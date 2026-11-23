import { Channel } from '@termbridge/protocol/automation-channel';
import { Command } from 'commander';
import { randomUUID, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, rename, rm, mkdir, chmod, utimes } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { isUtf8 } from 'node:buffer';
import { type AutomationMessage } from '@termbridge/protocol';
import { connectAutomation, type Transport } from './automationTransport.js';

type Options = Record<string, any>;
async function request(host: string, op: string, args: Options, output: (b: Buffer, stream: string) => Promise<void>, input?: (c: Channel) => Promise<void>) {
  let transport: Transport | undefined; let channel: Channel;
  let settle: (r: Options) => void; let fail: (e: Error) => void;
  const result = new Promise<Options>((resolve, reject) => { settle = resolve; fail = reject; });
  // Attach a rejection handler before connection startup can asynchronously fail.
  void result.catch(() => {});
  channel = new Channel(randomUUID(), m => transport!.send(m));
  let tail = Promise.resolve();
  channel.on('message', (m: AutomationMessage) => {
    if (m.kind === 'ack' && m.stream === 'ready') { if (input) void input(channel).catch(fail); return; }
    tail = tail.then(async () => {
      if (m.kind === 'data') { await output(Buffer.from(m.data || '', 'base64'), m.stream || 'stdout'); channel.send({ kind: 'ack', seq: m.seq }); }
      else if (m.kind === 'result') { if (m.error) fail(new Error(m.error)); else settle(m.result || {}); }
    }).catch(fail);
  });
  const cancel = () => fail(new Error('interrupted'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    transport = await connectAutomation(host, m => channel.receive(m), e => fail(e));
    channel.send({ kind: 'request', op, args: { ...args, clientName: hostname() } });
    return await result;
  } finally {
    if (transport) { try { channel.send({ kind: 'cancel' }); } catch { /* disconnected */ } transport.close(); }
    channel.abort(); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); process.stdin.pause();
  }
}
const write = (target: NodeJS.WritableStream, b: Buffer) => new Promise<void>((resolve, reject) => target.write(b, e => e ? reject(e) : resolve()));
async function exec(host: string, argv: string[], options: Options) {
  const env: Record<string, string> = {};
  for (const entry of options.env || []) { const i = entry.indexOf('='); if (i < 1) throw new Error('--env requires K=V'); env[entry.slice(0, i)] = entry.slice(i + 1); }
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  const result = await request(host, 'exec', { argv, cwd: options.cwd, env, timeout: options.timeout, stdin: !!options.stdin, login: !!options.login }, async (b, stream) => {
    if (options.json) (stream === 'stderr' ? stderr : stdout).push(b);
    else await write(stream === 'stderr' ? process.stderr : process.stdout, b);
  }, options.stdin ? async c => { for await (const b of process.stdin) await c.data(Buffer.from(b), 'stdin'); c.send({ kind: 'eof' }); } : undefined);
  if (options.json) {
    const out = Buffer.concat(stdout), err = Buffer.concat(stderr); const encoding = isUtf8(out) && isUtf8(err) ? 'utf8' : 'base64';
    console.log(JSON.stringify({ ...result, stdout: out.toString(encoding), stderr: err.toString(encoding), encoding }));
  }
  process.exitCode = result.exitCode;
}
async function pull(host: string, remote: string, local: string | undefined, options: Options) {
  const path = local ? resolve(local) : undefined;
  const temp = path ? join(dirname(path), `.${basename(path)}.tb-${randomUUID()}`) : undefined;
  const output = temp ? createWriteStream(temp, { flags: 'wx', mode: 0o600 }) : process.stdout;
  let outputError: Error | undefined; output.on('error', e => { outputError = e; });
  const hash = createHash('sha256'); let bytes = 0;
  try {
    if (options.recursive && path) { try { await stat(path); throw new Error('directory destination must not exist'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
    const result = await request(host, local ? 'pull' : 'cat', { path: remote, recursive: !!options.recursive }, async b => { if (outputError) throw outputError; hash.update(b); bytes += b.length; await write(output, b); });
    if (temp) { (output as ReturnType<typeof createWriteStream>).end(); await finished(output as ReturnType<typeof createWriteStream>); }
    if (result.sha256 !== hash.digest('hex') || result.bytes !== bytes) throw new Error('sha256 or length mismatch');
    if (path && temp) {
      if (options.recursive) {
        const staging = temp + '.dir'; await mkdir(staging, { mode: 0o700 });
        try {
          const tar = spawn('tar', ['-xpf', temp, '-C', staging], { stdio: 'ignore' }); const [code] = await once(tar, 'exit'); if (code) throw new Error('tar extraction failed');
          await rename(staging, path);
        } finally { await rm(staging, { force: true, recursive: true }); }
      } else { await chmod(temp, result.mode); await utimes(temp, new Date(result.mtime), new Date(result.mtime)); await rename(temp, path); }
    }
  } finally { if (temp) { (output as ReturnType<typeof createWriteStream>).destroy(); await rm(temp, { force: true }); } }
}
async function push(host: string, local: string, remote: string, options: Options) {
  const path = resolve(local); const info = await stat(path);
  if (info.isDirectory() && !options.recursive) throw new Error('directory requires -r');
  const child = options.recursive ? spawn('tar', ['-cf', '-', '-C', path, '.'], { stdio: ['ignore', 'pipe', 'pipe'] }) : undefined;
  const tarDone = child ? new Promise<number | null>((res, rej) => { child.once('error', rej); child.once('close', res); child.stderr?.resume(); }) : undefined;
  const source = child?.stdout || createReadStream(path, { highWaterMark: 65536 });
  let sha256 = ''; let bytes = 0;
  try {
    const result = await request(host, 'push', { path: remote, recursive: !!options.recursive, mkdir: !!options.mkdir, mode: info.mode & 0o777, mtime: info.mtimeMs }, async () => {}, async c => {
      const hash = createHash('sha256');
      for await (const chunk of source) { const b = Buffer.from(chunk); hash.update(b); bytes += b.length; await c.data(b, 'file'); }
      if (tarDone && await tarDone !== 0) throw new Error('tar failed');
      sha256 = hash.digest('hex'); c.send({ kind: 'eof', result: { sha256, bytes } });
    });
    if (result.sha256 !== sha256 || result.bytes !== bytes) throw new Error('sha256 or length mismatch');
  } finally { source.destroy(); child?.kill(); }
}
export function registerAutomation(program: Command) {
  const host = (c: Command) => c.optsWithGlobals().host || process.env.TB_HOST || '';
  const safe = (fn: (...a: any[]) => Promise<void>) => async (...a: any[]) => { try { await fn(...a); } catch (e) { console.error(`tb: ${(e as Error).message}`); process.exitCode = 255; } };
  program.command('exec <argv...>').description('execute on the host without a PTY')
    .option('--cwd <directory>').option('--env <K=V>', 'environment override', (v, a: string[]) => [...a, v], [])
    .option('--timeout <seconds>').option('--login', 'use the host login environment (default)').option('--json').option('--stdin')
    .action(safe(async (argv, opts, c) => exec(host(c), argv, opts)));
  program.command('pull <remote> <local>').option('-r, --recursive').action(safe(async (r, l, o, c) => pull(host(c), r, l, o)));
  program.command('push <local> <remote>').option('-r, --recursive').option('--mkdir').action(safe(async (l, r, o, c) => push(host(c), l, r, o)));
  program.command('cat <remote>').action(safe(async (r, _o, c) => pull(host(c), r, undefined, {})));
  program.command('audit').option('--tail <count>', 'number of records', '50').action(safe(async (o, c) => {
    await request(host(c), 'audit', { tail: o.tail }, async b => write(process.stdout, b));
  }));
}
