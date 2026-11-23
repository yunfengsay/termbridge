import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MAX_BUFFER = 8 * 1024 * 1024;

function executable(): string {
  if (process.env.TB_HERDR_BIN) return process.env.TB_HERDR_BIN;
  if (process.env.HERDR_BIN_PATH) return process.env.HERDR_BIN_PATH;
  return [join(homedir(), '.local/bin/herdr'), '/opt/homebrew/bin/herdr', '/usr/local/bin/herdr']
    .find(existsSync) ?? 'herdr';
}

/** One leased native controller. Closing it never closes the external terminal. */
export class HerdrTerminal {
  readonly ready: Promise<Buffer>;
  private child: ChildProcessWithoutNullStreams;
  private resolve!: (screen: Buffer) => void;
  private reject!: (error: Error) => void;
  private first = true;
  private active = false;
  private closed = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private line = '';
  private stderr = '';
  private timer: ReturnType<typeof setTimeout>;
  private cols: number;
  private rows: number;

  constructor(options: {
    terminalId: string; socketPath: string; cols: number; rows: number;
    onData: (data: Buffer) => void; onClose: (reason: string) => void;
  }) {
    this.ready = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.onData = options.onData;
    this.onClose = options.onClose;
    this.cols = size(options.cols, 80);
    this.rows = size(options.rows, 24);
    // HERDR_SOCKET_PATH is Herdr's documented API/client socket pairing contract.
    // Never inherit a different session or use --takeover to steal another client.
    const env: NodeJS.ProcessEnv = { ...process.env, HERDR_SOCKET_PATH: options.socketPath };
    delete env.HERDR_SESSION;
    this.child = spawn(executable(), ['terminal', 'session', 'control', options.terminalId,
      '--cols', String(this.cols), '--rows', String(this.rows)],
    { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.timer = setTimeout(() => this.finish('native terminal startup timed out'), 10_000);
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      if (this.closed) return;
      this.line += chunk;
      if (this.line.length > MAX_BUFFER) { this.finish('native terminal frame too large'); return; }
      let end: number;
      while (!this.closed && (end = this.line.indexOf('\n')) >= 0) {
        const line = this.line.slice(0, end);
        this.line = this.line.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.type === 'terminal.closed') {
            this.finish(String(frame.reason ?? 'native terminal closed'));
          } else if (frame.type === 'terminal.frame' && frame.encoding === 'ansi' && typeof frame.bytes === 'string') {
            const data = Buffer.from(frame.bytes, 'base64');
            if (this.first) {
              this.first = false;
              clearTimeout(this.timer);
              this.resolve(data);
            } else if (this.active) this.onData(data);
            else {
              this.pendingBytes += data.length;
              if (this.pendingBytes > MAX_BUFFER) this.finish('native terminal output overflow');
              else this.pending.push(data);
            }
          } else this.finish('unsupported native terminal stream');
        } catch { this.finish('invalid native terminal stream'); }
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (data: string) => { this.stderr = (this.stderr + data).slice(-2048); });
    this.child.on('error', (error) => this.finish(error.message));
    this.child.stdin.on('error', (error) => this.finish(error.message));
    this.child.on('close', (code) => this.finish(this.stderr.trim() || `native terminal stream ended (${code})`));
  }

  private onData: (data: Buffer) => void;
  private onClose: (reason: string) => void;

  /** Flush only after attach_ok and the initial screen have been sent. */
  activate(): void {
    if (this.closed) return;
    this.active = true;
    for (const data of this.pending) this.onData(data);
    this.pending = [];
    this.pendingBytes = 0;
  }

  write(data: Buffer): void { this.send({ type: 'terminal.input', bytes: data.toString('base64') }); }
  scroll(direction: 'up' | 'down', lines: number): void {
    if (!['up', 'down'].includes(direction) || !Number.isSafeInteger(lines) || lines < 1 || lines > 100) return;
    // Herdr defaults missing coordinates to (0,0), which is Codex's fixed
    // header, not its scrollable transcript. Use the current viewport center,
    // as Herdr's own explicit alternate-screen history reader does.
    // Its mouse-report route emits ONE event per command and ignores `lines`;
    // one-line commands also retain the correct total for host scrollback.
    const column = Math.floor((this.cols - 1) / 2);
    const row = Math.floor((this.rows - 1) / 2);
    for (let n = 0; n < lines; n++) {
      this.send({ type: 'terminal.scroll', source: 'wheel', direction, lines: 1, column, row });
    }
  }
  resize(cols: number, rows: number): void {
    this.cols = size(cols, 80);
    this.rows = size(rows, 24);
    this.send({ type: 'terminal.resize', cols: this.cols, rows: this.rows });
  }
  private send(command: object): void {
    if (this.closed) return;
    if (this.child.stdin.writableLength > MAX_BUFFER) { this.finish('native terminal input overflow'); return; }
    this.child.stdin.write(JSON.stringify(command) + '\n');
  }
  close(): void { this.finish('detached', false); }

  private finish(reason: string, notify = true): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.pending = [];
    this.line = '';
    this.child.stdin.end(JSON.stringify({ type: 'terminal.release' }) + '\n');
    // Only our controller subprocess is terminated if graceful release stalls.
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 1500);
    kill.unref();
    this.child.once('close', () => clearTimeout(kill));
    if (this.first) this.reject(new Error(reason));
    else if (notify) this.onClose(reason);
  }
}

function size(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(65535, Math.floor(value))) : fallback;
}
