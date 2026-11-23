import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, lstat, unlink, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

type Target = 'relay' | 'host';
export interface ServeSpec {
  packageRoot: string;
  launch: (target: Target) => ChildProcess;
  version: () => string;
  directory?: string;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  failed?: (error: Error) => void;
  watchReplacement?: boolean;
  watchIntervalMs?: number;
}
export const serveDirectory = () => join(homedir(), '.termbridge/services/serve');

/** One parent owns its Relay and Host. Update talks to that parent rather than
 * killing processes discovered by name/PID. Existing environment stays in memory. */
export class ServeSupervisor {
  private children: ChildProcess[] = [];
  private closed = false;
  private replacing = false;
  private stopping?: Promise<void>;
  private draining?: Promise<void>;
  private server?: net.Server;
  private transition?: Promise<void>;
  private watcher?: ReturnType<typeof setInterval>;
  private generation = '';
  private readonly clients = new Set<net.Socket>();
  readonly directory: string;
  readonly socket: string;
  readonly record: string;
  constructor(private readonly spec: ServeSpec) {
    this.directory = resolve(spec.directory ?? serveDirectory());
    const id = `${process.pid}-${randomUUID().slice(0, 8)}`;
    this.socket = join(this.directory, `${id}.sock`); this.record = join(this.directory, `${id}.json`);
  }
  async start(): Promise<void> {
    if (this.transition || this.closed || this.server) throw new Error('serve already started or stopped');
    this.transition = this.startService();
    try { await this.transition; }
    catch (error) { await this.stop(); throw error; }
    finally { this.transition = undefined; }
  }
  private async startService(): Promise<void> {
    await this.startChildren();
    if (this.closed) throw new Error('serve stopped during startup');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.closed) throw new Error('serve stopped during startup');
    const server = net.createServer(socket => this.accept(socket)); this.server = server;
    server.listen(this.socket); await once(server, 'listening'); await chmod(this.socket, 0o600);
    server.on('error', error => { void this.stop().then(() => this.spec.failed?.(error)); });
    await this.saveRecord();
    this.generation = await this.readGeneration();
    if (!this.closed && this.spec.watchReplacement) {
      this.watcher = setInterval(() => { void this.checkReplacement(); }, this.spec.watchIntervalMs ?? 5000);
      this.watcher.unref();
    }
  }
  async restart(): Promise<void> {
    if (this.closed) throw new Error('serve is stopped');
    if (this.transition) return this.transition;
    this.replacing = true;
    const transition = (async () => {
      await this.stopChildren();
      if (this.closed) throw new Error('serve stopped during restart');
      await this.startChildren(); await this.saveRecord();
      this.generation = await this.readGeneration();
    })();
    this.transition = transition;
    try {
      await transition;
    } catch (error) { await this.stop(); throw error; }
    finally { this.transition = undefined; this.replacing = false; }
  }
  stop(): Promise<void> {
    this.closed = true;
    clearInterval(this.watcher);
    return this.stopping ??= (async () => {
      for (const socket of this.clients) socket.destroy();
      this.server?.close();
      await this.stopChildren();
      // The transition itself never calls stop. Drain its I/O before deleting
      // records, so a concurrent start/save cannot resurrect a stopped service.
      await this.transition?.catch(() => {});
      this.server?.close();
      await this.stopChildren();
      await Promise.all([this.record, this.socket].map(path => unlink(path).catch(() => {})));
    })();
  }
  private async startChildren(): Promise<void> {
    for (const target of ['relay', 'host'] as const) {
      if (this.closed) throw new Error('serve stopped');
      const child = this.spec.launch(target); this.children.push(child);
      child.once('exit', () => {
        if (!this.closed && !this.replacing && this.children.includes(child)) {
          const error = new Error(`${target} exited; serve stopped`);
          void this.stop().then(() => this.spec.failed?.(error));
        }
      });
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('error', error); child.off('exit', exit); };
        const message = (raw: unknown) => {
          if ((raw as { event?: string })?.event === (target === 'relay' ? 'listening' : 'ready')) { cleanup(); resolve(); }
        };
        const error = () => { cleanup(); reject(new Error(`${target} could not start`)); };
        const exit = () => { cleanup(); reject(new Error(`${target} exited before ready`)); };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`${target} startup timed out`)); }, this.spec.readyTimeoutMs ?? 30000);
        child.on('message', message); child.once('error', error); child.once('exit', exit);
      });
    }
  }
  private async stopChildren(): Promise<void> {
    if (this.draining) return this.draining;
    const children = this.children.splice(0);
    const drain = Promise.all(children.map(child => new Promise<void>(resolve => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => child.kill('SIGKILL'), this.spec.stopTimeoutMs ?? 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
    }))).then(() => {});
    this.draining = drain;
    try { await drain; } finally { if (this.draining === drain) this.draining = undefined; }
  }
  private async saveRecord(): Promise<void> {
    if (this.closed) return;
    await writeFile(this.record, JSON.stringify({ schema: 1, socket: this.socket, packageRoot: resolve(this.spec.packageRoot), version: this.spec.version() }) + '\n', { mode: 0o600 });
  }
  private async readGeneration(): Promise<string> {
    const info = await stat(join(this.spec.packageRoot, 'package.json'));
    return `${info.ino}:${info.mtimeMs}:${this.spec.version()}`;
  }
  private async checkReplacement(): Promise<void> {
    if (this.closed || this.transition) return;
    let generation: string;
    // App replacement may briefly remove the path. Wait for the complete new
    // bundle; a failed download never changes this generation.
    try { generation = await this.readGeneration(); } catch { return; }
    if (this.closed || this.transition || generation === this.generation) return;
    try { await this.restart(); }
    catch (error) { this.spec.failed?.(error as Error); }
  }
  private accept(socket: net.Socket): void {
    if (this.closed || this.clients.size >= 8) { socket.destroy(); return; }
    this.clients.add(socket); let input = '', handled = false;
    socket.setTimeout(65000, () => socket.destroy()); socket.on('error', () => {});
    socket.on('close', () => this.clients.delete(socket));
    socket.on('data', chunk => {
      if (handled) return;
      input += chunk.toString('utf8');
      if (input.length > 1024) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      handled = true;
      void (async () => {
        try {
          const request = JSON.parse(input.slice(0, input.indexOf('\n')));
          if (request.action !== 'status' && request.action !== 'reload') throw new Error('unsupported action');
          if (request.action === 'reload') await this.restart();
          socket.end(JSON.stringify({ ok: true, version: this.spec.version(), packageRoot: resolve(this.spec.packageRoot) }) + '\n');
        } catch (error) { socket.end(JSON.stringify({ ok: false, error: (error as Error).message }) + '\n'); }
      })();
    });
  }
}

export async function reloadOwnedServes(packageRoot: string, directory = serveDirectory()): Promise<number> {
  directory = resolve(directory);
  let files: string[];
  try { files = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  let count = 0;
  for (const file of files.filter(name => /^\d+-[a-f0-9]{8}\.json$/.test(name))) {
    const path = join(directory, file);
    let info;
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.uid !== process.getuid?.() || metadata.size > 4096) continue;
      info = JSON.parse(await readFile(path, 'utf8'));
    } catch { continue; } // A concurrently exiting or incomplete record is not a service.
    if (info.schema !== 1 || info.packageRoot !== resolve(packageRoot) || typeof info.socket !== 'string' || dirname(info.socket) !== directory) continue;
    let socketMetadata;
    try { socketMetadata = await lstat(info.socket); } catch { continue; }
    if (!socketMetadata.isSocket() || socketMetadata.uid !== process.getuid?.()) continue;
    const outcome = await new Promise<boolean>((resolve, reject) => {
      const socket = net.createConnection(info.socket); let data = '', sent = false;
      socket.setTimeout(65000, () => { socket.destroy(); reject(new Error('serve reload timed out; inspect service state before retrying')); });
      socket.on('connect', () => { sent = true; socket.write('{"action":"reload"}\n'); });
      socket.on('data', chunk => {
        data += chunk.toString(); if (data.length > 8192) { socket.destroy(); reject(new Error('Invalid serve response')); return; }
        if (!data.includes('\n')) return;
        socket.end();
        try { const result = JSON.parse(data.split('\n')[0]); if (!result.ok) throw new Error(result.error); resolve(true); } catch (error) { reject(error); }
      });
      socket.on('error', error => { if (!sent && ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) resolve(false); else reject(error); });
      socket.on('close', () => { if (sent && !data.includes('\n')) reject(new Error('serve reload outcome unknown; not retried')); });
    });
    if (outcome) count++;
  }
  return count;
}
