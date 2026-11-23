import { Channel } from '@termbridge/protocol/automation-channel';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, chmod, utimes } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { type AutomationMessage } from '@termbridge/protocol';
import { killGroup } from './process.js';
export const fullPath = (path: string) => resolve(homedir(), path.replace(/^~(?=\/|$)/, homedir()));
export async function pull(channel: Channel, args: Record<string, unknown>) {
  const path = fullPath(String(args.path)); const info = await stat(path);
  if (info.isDirectory() && !args.recursive) throw new Error('directory requires -r');
  const child = args.recursive ? spawn('tar', ['-cf', '-', '-C', path, '.'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }) : undefined;
  const done = child ? new Promise<number | null>((res, rej) => { child.once('error', rej); child.once('close', res); child.stderr?.resume(); }) : undefined;
  const stream = child?.stdout || createReadStream(path, { highWaterMark: 65536 });
  const cancel = () => { stream.destroy(); if (child) killGroup(child); };
  channel.signal.addEventListener('abort', cancel, { once: true });
  const hash = createHash('sha256'); let bytes = 0;
  try {
    for await (const chunk of stream) { const b = Buffer.from(chunk); hash.update(b); bytes += b.length; await channel.data(b, 'file'); }
    if (done && await done !== 0) throw new Error('tar failed');
    return { sha256: hash.digest('hex'), bytes, mode: info.mode & 0o777, mtime: info.mtimeMs };
  } finally { channel.signal.removeEventListener('abort', cancel); cancel(); }
}
export async function push(channel: Channel, args: Record<string, unknown>) {
  const path = fullPath(String(args.path));
  if (args.mkdir) await mkdir(dirname(path), { recursive: true });
  if (args.recursive) { try { await stat(path); throw new Error('directory destination must not exist'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  const tmp = join(dirname(path), `.${basename(path)}.tb-${randomUUID()}`);
  const output = createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
  const hash = createHash('sha256'); let bytes = 0; let tail = Promise.resolve(); let eof: AutomationMessage | undefined;
  try {
    await new Promise<void>((resolveDone, reject) => {
      output.once('error', reject);
      channel.signal.addEventListener('abort', () => reject(new Error('upload cancelled')), { once: true });
      channel.on('message', m => {
        tail = tail.then(async () => {
          if (m.kind === 'data') {
            const b = Buffer.from(m.data || '', 'base64'); hash.update(b); bytes += b.length;
            await new Promise<void>((res, rej) => output.write(b, e => e ? rej(e) : res())); channel.send({ kind: 'ack', seq: m.seq });
          } else if (m.kind === 'eof') { eof = m; output.end(); await finished(output); resolveDone(); }
        }).catch(reject);
      });
      channel.send({ kind: 'ack', stream: 'ready' });
    });
    const sha256 = hash.digest('hex'); if (sha256 !== eof?.result?.sha256) throw new Error('sha256 mismatch');
    channel.signal.throwIfAborted();
    if (args.recursive) {
      const staging = tmp + '.dir'; await mkdir(staging, { mode: 0o700 });
      try {
        const tar = spawn('tar', ['-xpf', tmp, '-C', staging], { stdio: 'ignore' });
        const [code] = await once(tar, 'exit'); if (code) throw new Error('tar extraction failed');
        channel.signal.throwIfAborted(); await rename(staging, path);
      } finally { await rm(staging, { recursive: true, force: true }); }
    } else {
      if (typeof args.mode === 'number') await chmod(tmp, args.mode & 0o777);
      if (typeof args.mtime === 'number') await utimes(tmp, new Date(args.mtime), new Date(args.mtime));
      await rename(tmp, path);
    }
    return { bytes, sha256 };
  } finally { output.destroy(); await rm(tmp, { force: true }); }
}
