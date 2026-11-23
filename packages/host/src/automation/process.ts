import { Channel } from '@termbridge/protocol/automation-channel';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants, homedir } from 'node:os';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { type AutomationMessage } from '@termbridge/protocol';

export function killGroup(child: { pid?: number }, signal: NodeJS.Signals = 'SIGKILL') {
  if (!child.pid) return;
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch { /* already gone */ }
}
let environment: Promise<NodeJS.ProcessEnv> | undefined;
export function loginEnvironment(shell: string) {
  return environment ??= new Promise<NodeJS.ProcessEnv>((resolve, reject) => {
    const child = spawn(shell, ['-lc', 'env -0'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    const chunks: Buffer[] = []; child.stdout.on('data', b => chunks.push(b)); child.stderr.resume();
    child.on('error', reject); child.on('close', code => {
      if (code) return reject(new Error('could not load host login environment'));
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const item of Buffer.concat(chunks).toString().split('\0')) { const i = item.indexOf('='); if (i > 0 && /^[A-Za-z_][A-Za-z_0-9]*$/.test(item.slice(0, i))) env[item.slice(0, i)] = item.slice(i + 1); }
      delete env.DASHSCOPE_API_KEY; delete env.VOLCENGINE_S2S_API_KEY; delete env.VOLCENGINE_S2S_ACCESS_TOKEN;
      resolve(env);
    });
  });
}
export async function startCommand(args: Record<string, unknown>, shell: string): Promise<ChildProcessWithoutNullStreams> {
  const argv = args.argv as string[];
  if (args.timeout !== undefined && (!Number.isFinite(Number(args.timeout)) || Number(args.timeout) <= 0)) throw new Error('timeout must be a positive number');
  if (args.env && (typeof args.env !== 'object' || Object.entries(args.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(k) || typeof v !== 'string' || v.includes('\0')))) throw new Error('invalid environment override');
  if (!Array.isArray(argv) || !argv.length || argv.some(v => typeof v !== 'string' || v.includes('\0'))) throw new Error('argv must contain a command');
  const env = { ...await loginEnvironment(shell), ...(args.env as Record<string, string> || {}) };
  const child = spawn(argv[0], argv.slice(1), { cwd: typeof args.cwd === 'string' ? args.cwd : homedir(), env, detached: process.platform !== 'win32', stdio: 'pipe' });
  await once(child, 'spawn'); return child;
}
export async function pipeOutput(source: Readable, channel: Channel, stream: string) {
  for await (const chunk of source) await channel.data(Buffer.from(chunk), stream);
}
export function receiveInput(channel: Channel, target: Writable, onEof?: (m: AutomationMessage) => void) {
  let tail = Promise.resolve();
  const listener = (m: AutomationMessage) => {
    if (m.kind !== 'data' && m.kind !== 'eof') return;
    tail = tail.then(async () => {
      if (m.kind === 'eof') { target.end(); onEof?.(m); return; }
      const data = Buffer.from(m.data || '', 'base64');
      await new Promise<void>((resolve, reject) => target.write(data, e => e ? reject(e) : resolve()));
      channel.send({ kind: 'ack', seq: m.seq });
    }).catch(() => channel.abort());
  };
  channel.on('message', listener); return () => channel.off('message', listener);
}
export async function execute(channel: Channel, args: Record<string, unknown>, shell: string) {
  const started = Date.now();
  const child = await startCommand(args, shell);
  const stopped = new Promise<{ exitCode: number; signal: string | null }>(resolve => child.once('close', (code, signal) => resolve({ exitCode: signal ? 128 + (constants.signals[signal] || 0) : code ?? 1, signal })));
  const cancel = () => killGroup(child);
  channel.signal.addEventListener('abort', cancel, { once: true }); if (channel.signal.aborted) cancel();
  const timeout = Number(args.timeout || 0); const timer = timeout > 0 ? setTimeout(cancel, timeout * 1000) : undefined;
  child.stdin.on('error', () => {});
  const removeInput = receiveInput(channel, child.stdin);
  channel.send({ kind: 'ack', stream: 'ready' });
  if (!args.stdin) child.stdin.end();
  try {
    await Promise.all([pipeOutput(child.stdout, channel, 'stdout'), pipeOutput(child.stderr, channel, 'stderr')]);
    return { ...await stopped, durationMs: Date.now() - started };
  } finally { if (timer) clearTimeout(timer); removeInput(); channel.signal.removeEventListener('abort', cancel); killGroup(child); }
}
