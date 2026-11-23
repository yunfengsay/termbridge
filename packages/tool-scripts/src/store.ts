import { constants, openSync, closeSync, fstatSync, readFileSync, mkdirSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_SCRIPT_BYTES, parseScript, scriptDigest, type ToolScript } from './schema.js';

export class ToolScriptStore {
  constructor(readonly directory = process.env.TB_TOOL_SCRIPTS_DIR || join(homedir(), '.termbridge', 'tool-scripts')) {}
  private path(id: string, approval = false): string {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(id)) throw new Error('Invalid script id');
    return join(this.directory, `${id}${approval ? '.approval' : ''}.json`);
  }
  private read(path: string): unknown {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) throw new Error('Invalid script file');
      return JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
  }
  private write(path: string, data: unknown): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const tmp = join(this.directory, `.write-${randomUUID()}`);
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  }
  get(id: string): { script: ToolScript; digest: string; enabled: boolean } {
    const script = parseScript(this.read(this.path(id)));
    if (script.id !== id) throw new Error('Script id mismatch');
    const digest = scriptDigest(script);
    let approved: unknown;
    try { approved = this.read(this.path(id, true)); } catch { /* Missing/invalid approval fails closed. */ }
    return { script, digest, enabled: !!approved && typeof approved === 'object' &&
      'digest' in approved && approved.digest === digest };
  }
  save(value: unknown): { id: string; digest: string; status: 'needs_review' } {
    const script = parseScript(value);
    // Explicit save invalidates approval even when bytes happen to be unchanged.
    this.write(this.path(script.id, true), { digest: null });
    this.write(this.path(script.id), script);
    return { id: script.id, digest: scriptDigest(script), status: 'needs_review' };
  }
  approve(id: string, digest: string): void {
    const entry = this.get(id);
    if (entry.digest !== digest) throw new Error('Digest changed; review the current script');
    this.write(this.path(id, true), { digest, approvedAt: new Date().toISOString() });
  }
  disable(id: string): void { this.get(id); this.write(this.path(id, true), { digest: null }); }
  list() {
    let files: string[];
    try { files = readdirSync(this.directory); } catch { return []; }
    return files.filter(f => /^[a-z][a-z0-9_-]{0,47}\.json$/.test(f)).sort().slice(0, 128).flatMap(f => {
      try {
        const { script, digest, enabled } = this.get(f.slice(0, -5));
        return [{ id: script.id, version: script.version, description: script.description, inputs: script.inputs, digest, enabled }];
      } catch { return []; }
    });
  }
}
