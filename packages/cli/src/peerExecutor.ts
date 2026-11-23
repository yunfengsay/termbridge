import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { resolve, relative, isAbsolute, join, dirname } from 'node:path';
import { getExpose, peerAuditPath, type ExposeSettings } from '@termbridge/settings';

/**
 * The reverse tool channel, CLIENT side. When the host's agent runs `tb peer …`,
 * the host forwards a `tool_request` to whichever client is attached; THIS code
 * (running inside that client's `tb` attach process) executes it on the local
 * machine and replies. Works on macOS, Linux, and Windows (PowerShell) — it uses
 * only `child_process` + `node:fs`, never node-pty, so it ships in the pty-free
 * client bundle.
 *
 * Everything here is gated by `tb expose` (OFF by default). fs.* ops are confined
 * to the exposed root; `exec` is full shell access (root does NOT sandbox it).
 */
export interface ToolResult {
  ok: boolean;
  exit?: number;
  stdout?: string;
  stderr?: string;
  data?: unknown;
  error?: string;
}

const MAX_OUT = 1024 * 1024; // cap exec output / file reads at 1 MiB per response

function audit(line: string): void {
  try {
    appendFileSync(peerAuditPath(), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* best-effort */
  }
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/** Resolve `p` against the exposed root and refuse anything that escapes it. */
function safePath(root: string, p: string): string {
  const abs = resolve(root, expandTilde(p)); // an absolute `p` overrides root; re-confined below
  const rel = relative(root, abs);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`path escapes the exposed root: ${root}`);
  }
  return abs;
}

function platformShell(): { bin: string; flag: string } {
  if (process.platform === 'win32') return { bin: 'powershell.exe', flag: '-Command' };
  return { bin: process.env.SHELL || 'bash', flag: '-c' };
}

function runExec(args: Record<string, unknown>, ex: ExposeSettings): Promise<ToolResult> {
  return new Promise((done) => {
    const argv: string[] = Array.isArray(args.argv) ? (args.argv as unknown[]).map(String) : [];
    if (argv.length === 0) return done({ ok: false, error: 'exec: empty argv' });
    const timeoutMs = Math.max(1000, Number(args.timeoutMs) || 60_000);
    const cwd = args.cwd ? resolve(ex.root, expandTilde(String(args.cwd))) : ex.root;

    let bin: string;
    let spawnArgs: string[];
    if (args.shell) {
      const sh = platformShell(); // run the joined argv as one shell command (pipes, globs, &&)
      bin = sh.bin;
      spawnArgs = [sh.flag, argv.join(' ')];
    } else {
      bin = argv[0];
      spawnArgs = argv.slice(1);
    }

    let child: ChildProcess;
    try {
      child = spawn(bin, spawnArgs, { cwd, env: process.env, windowsHide: true });
    } catch (e) {
      return done({ ok: false, error: `spawn failed: ${(e as Error).message}` });
    }
    let out = '';
    let err = '';
    let killed = false;
    const to = setTimeout(() => {
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* noop */
      }
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      if (out.length < MAX_OUT) out += d.toString('utf8');
    });
    child.stderr?.on('data', (d) => {
      if (err.length < MAX_OUT) err += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(to);
      done({ ok: false, error: `exec error: ${(e as Error).message}` });
    });
    child.on('close', (code) => {
      clearTimeout(to);
      done({
        ok: true,
        exit: killed ? 124 : code ?? 0,
        stdout: out.slice(0, MAX_OUT),
        stderr: (killed ? `${err}\n[killed: timed out after ${timeoutMs}ms]` : err).slice(0, MAX_OUT),
      });
    });
  });
}

function denyFs(): ToolResult {
  return { ok: false, error: 'file access is disabled on this client (tb expose on --fs ro|rw)' };
}

/** Execute one tool op locally, honouring this machine's `tb expose` consent. */
export async function executeTool(op: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const ex = getExpose();

  // `info` is always answerable (it reveals only the consent state, no data).
  if (op === 'info') {
    return { ok: true, data: { platform: process.platform, hostname: hostname(), exposed: ex.enabled, root: ex.root, fs: ex.fs, exec: ex.exec } };
  }
  if (!ex.enabled) {
    audit(`DENY ${op} (exposure off)`);
    return { ok: false, error: 'peer tools are not exposed on this client — the user must run `tb expose on` here' };
  }

  try {
    switch (op) {
      case 'exec': {
        if (!ex.exec) {
          audit('DENY exec (exec disabled)');
          return { ok: false, error: 'exec is disabled on this client (tb expose on --exec on)' };
        }
        const r = await runExec(args, ex);
        const cmd = Array.isArray(args.argv) ? (args.argv as unknown[]).map(String).join(' ') : '';
        audit(`exec ${cmd.slice(0, 200)} -> ${r.ok ? `exit ${r.exit}` : `ERR ${r.error}`}`);
        return r;
      }
      case 'fs.read': {
        if (ex.fs === 'off') return denyFs();
        const abs = safePath(ex.root, String(args.path ?? ''));
        const max = Math.min(MAX_OUT, Number(args.maxBytes) || MAX_OUT);
        const full = await readFile(abs);
        const truncated = full.length > max;
        const buf = truncated ? full.subarray(0, max) : full;
        const binary = buf.includes(0);
        audit(`fs.read ${abs} -> ${buf.length}B${truncated ? ' (truncated)' : ''}`);
        return {
          ok: true,
          data: { content: binary ? buf.toString('base64') : buf.toString('utf8'), encoding: binary ? 'base64' : 'utf8', bytes: full.length, truncated },
        };
      }
      case 'fs.write': {
        if (ex.fs !== 'rw') return { ok: false, error: 'file writes are disabled on this client (tb expose on --fs rw)' };
        const abs = safePath(ex.root, String(args.path ?? ''));
        const enc: BufferEncoding = args.encoding === 'base64' ? 'base64' : 'utf8';
        const data = Buffer.from(String(args.content ?? ''), enc);
        if (args.mkdirp) await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, data);
        audit(`fs.write ${abs} -> ${data.length}B`);
        return { ok: true, data: { bytes: data.length, path: abs } };
      }
      case 'fs.ls': {
        if (ex.fs === 'off') return denyFs();
        const abs = safePath(ex.root, String(args.path ?? '.'));
        const ents = await readdir(abs, { withFileTypes: true });
        const entries = await Promise.all(
          ents.map(async (e) => {
            let size = 0;
            let mtime = 0;
            try {
              const st = await stat(join(abs, e.name));
              size = st.size;
              mtime = st.mtimeMs;
            } catch {
              /* dangling symlink / perms */
            }
            return { name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size, mtime };
          }),
        );
        audit(`fs.ls ${abs} -> ${entries.length}`);
        return { ok: true, data: { path: abs, entries } };
      }
      case 'fs.stat': {
        if (ex.fs === 'off') return denyFs();
        const abs = safePath(ex.root, String(args.path ?? ''));
        const st = await stat(abs);
        return { ok: true, data: { path: abs, type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.size, mtime: st.mtimeMs, mode: st.mode } };
      }
      default:
        return { ok: false, error: `unknown tool op: ${op}` };
    }
  } catch (e) {
    audit(`ERR ${op}: ${(e as Error).message}`);
    return { ok: false, error: (e as Error).message };
  }
}
