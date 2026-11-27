import { execFile } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_FILE_BYTES = 256 * 1024;
const MAX_RANGED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 16_000;
const MAX_LIST_ENTRIES = 100;
const MAX_SEARCH_FILES = 1_500;
const MAX_SEARCH_MATCHES = 30;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const SKIPPED_DIRECTORIES = new Set(['.git', '.gradle', 'build', 'dist', 'node_modules', '.build', 'target', '__pycache__']);
const SENSITIVE_NAMES = [
  /^\.env(?:\.|$)/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^\.ssh$/i,
  /^credentials?(?:\.|$)/i,
  /^secrets?(?:\.|$)/i,
  /^id_(?:rsa|ed25519)$/i,
  /\.(?:jks|key|keystore|p12|pem)$/i,
];

export type WorkspaceFileAction = 'list' | 'read' | 'search' | 'git_status' | 'git_diff';

export interface WorkspaceFileOptions {
  startLine?: number;
  endLine?: number;
  query?: string;
  maxResults?: number;
}

/** A deliberately small, read-only filesystem boundary for Global Brain. */
export class WorkspaceFiles {
  constructor(
    private readonly projectsRoot = process.env.TB_BRAIN_FILES_ROOT || join(homedir(), 'code'),
    private readonly memoryPath = process.env.TB_BRAIN_MEMORY || join(homedir(), '.termbridge', 'memory.md'),
  ) {}

  async execute(
    action: WorkspaceFileAction,
    inputPath: string,
    options: WorkspaceFileOptions = {},
  ): Promise<Record<string, unknown>> {
    const path = cleanPath(inputPath);
    if (path === '@memory') {
      if (action !== 'read') throw new Error('@memory can only be read');
      return this.readText(await realpath(this.memoryPath), '@memory', options);
    }
    const target = await this.resolveProjectPath(path);
    if (action === 'list') return this.listDirectory(target, path);
    if (action === 'read') return this.readText(target, path, options);
    if (action === 'search') return this.searchDirectory(target, path, options);
    if (action === 'git_status') return this.gitStatus(target, path);
    if (action === 'git_diff') return this.gitDiff(target, path);
    throw new Error(`Unsupported workspace_files action: ${String(action)}`);
  }

  private async resolveProjectPath(path: string): Promise<string> {
    if (isAbsolute(path)) throw new Error('File path must be relative to the configured project root');
    assertNotSensitive(path);
    const root = await realpath(this.projectsRoot);
    const target = await realpath(resolve(root, path));
    const fromRoot = relative(root, target);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error('File path is outside the configured project root');
    }
    return target;
  }

  private async listDirectory(target: string, path: string): Promise<Record<string, unknown>> {
    if (!(await stat(target)).isDirectory()) throw new Error('File path is not a directory');
    const all = (await readdir(target, { withFileTypes: true }))
      .filter((entry) => !isSensitiveName(entry.name))
      .filter((entry) => !(entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)))
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
    return {
      ok: true,
      action: 'list',
      path,
      entries: all.slice(0, MAX_LIST_ENTRIES).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      })),
      truncated: all.length > MAX_LIST_ENTRIES,
    };
  }

  private async readText(
    target: string,
    path: string,
    options: WorkspaceFileOptions = {},
  ): Promise<Record<string, unknown>> {
    const metadata = await stat(target);
    if (!metadata.isFile()) throw new Error('File path is not a regular file');
    const ranged = options.startLine !== undefined || options.endLine !== undefined;
    const limit = ranged ? MAX_RANGED_FILE_BYTES : MAX_FILE_BYTES;
    if (metadata.size > limit) throw new Error('File is too large for Voice Brain');
    const data = await readFile(target);
    if (data.includes(0)) throw new Error('Binary files are not available to Voice Brain');
    const text = data.toString('utf8').replace(/\u0000/g, '');
    const replacementCount = [...text].filter((character) => character === '\uFFFD').length;
    if (replacementCount > Math.max(2, text.length / 100)) {
      throw new Error('Binary files are not available to Voice Brain');
    }

    if (ranged) {
      const lines = text.split('\n');
      const start = Math.max(1, Math.floor(options.startLine ?? 1));
      const end = Math.min(lines.length, Math.max(start, Math.floor(options.endLine ?? start + 199)));
      const sliced = lines.slice(start - 1, end).join('\n');
      const clipped = sliced.slice(0, MAX_TEXT_CHARS);
      return {
        ok: true,
        action: 'read',
        path,
        name: basename(target),
        startLine: start,
        endLine: end,
        totalLines: lines.length,
        text: clipped,
        truncated: clipped.length < sliced.length || end < lines.length,
        size: metadata.size,
      };
    }

    return {
      ok: true,
      action: 'read',
      path,
      name: basename(target),
      text: text.slice(0, MAX_TEXT_CHARS),
      truncated: text.length > MAX_TEXT_CHARS,
      size: metadata.size,
    };
  }

  private async searchDirectory(
    target: string,
    basePath: string,
    options: WorkspaceFileOptions,
  ): Promise<Record<string, unknown>> {
    const rawQuery = typeof options.query === 'string' ? options.query.trim() : '';
    if (!rawQuery) throw new Error('query is required for workspace_files search');
    if (rawQuery.length > 200) throw new Error('Search query is too long');
    const needle = rawQuery.toLowerCase();
    const maxResults = Math.max(1, Math.min(MAX_SEARCH_MATCHES, Math.floor(options.maxResults ?? 20)));
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let scannedFiles = 0;
    let truncated = false;
    const root = await realpath(this.projectsRoot);

    const scanFile = async (filePath: string) => {
      if (matches.length >= maxResults) { truncated = true; return; }
      if (scannedFiles >= MAX_SEARCH_FILES) { truncated = true; return; }
      scannedFiles += 1;
      try {
        const meta = await stat(filePath);
        if (!meta.isFile() || meta.size > MAX_SEARCH_FILE_BYTES) return;
        const data = await readFile(filePath);
        if (data.includes(0)) return;
        const content = data.toString('utf8');
        if (!content.toLowerCase().includes(needle)) return;
        const relPath = relative(root, filePath).split(sep).join('/');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i]!.toLowerCase().includes(needle)) {
            matches.push({ path: relPath, line: i + 1, text: lines[i]!.trim().slice(0, 240) });
            if (matches.length >= maxResults) { truncated = true; return; }
          }
        }
      } catch {
        // Skip unreadable files.
      }
    };

    const walk = async (dir: string): Promise<void> => {
      if (matches.length >= maxResults || scannedFiles >= MAX_SEARCH_FILES) { truncated = true; return; }
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (matches.length >= maxResults || scannedFiles >= MAX_SEARCH_FILES) { truncated = true; return; }
        if (isSensitiveName(entry.name)) continue;
        if (entry.isSymbolicLink()) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
          await walk(full);
        } else if (entry.isFile()) {
          await scanFile(full);
        }
      }
    };

    const targetMeta = await stat(target);
    if (targetMeta.isFile()) await scanFile(target);
    else if (targetMeta.isDirectory()) await walk(target);
    else throw new Error('File path is not searchable');

    return {
      ok: true,
      action: 'search',
      path: basePath,
      query: rawQuery,
      scannedFiles,
      count: matches.length,
      matches,
      truncated,
    };
  }

  private async gitStatus(target: string, path: string): Promise<Record<string, unknown>> {
    const cwd = (await stat(target)).isDirectory() ? target : dirname(target);
    const { stdout } = await execFileAsync('git', ['status', '--short', '--branch'], {
      cwd, timeout: 8_000, maxBuffer: 512 * 1024,
    });
    const safeLines = stdout.split('\n').filter((line) => !lineContainsSensitivePath(line));
    const text = safeLines.join('\n').trim();
    return {
      ok: true,
      action: 'git_status',
      path,
      text: text.slice(0, MAX_TEXT_CHARS),
      truncated: text.length > MAX_TEXT_CHARS,
    };
  }

  private async gitDiff(target: string, path: string): Promise<Record<string, unknown>> {
    const meta = await stat(target);
    const cwd = meta.isDirectory() ? target : dirname(target);
    const targetArg = meta.isFile() ? ['--', basename(target)] : [];
    const { stdout: statOut } = await execFileAsync('git', ['diff', '--stat', ...targetArg], {
      cwd, timeout: 8_000, maxBuffer: 512 * 1024,
    });
    const { stdout: diffOut } = await execFileAsync('git', ['diff', '--unified=2', ...targetArg], {
      cwd, timeout: 8_000, maxBuffer: 1024 * 1024,
    });
    const filteredDiff = filterSensitiveDiff(diffOut);
    const combined = [statOut.trim(), filteredDiff.trim()].filter(Boolean).join('\n\n');
    return {
      ok: true,
      action: 'git_diff',
      path,
      text: combined.slice(0, MAX_TEXT_CHARS),
      truncated: combined.length > MAX_TEXT_CHARS,
    };
  }
}

function dirname(filePath: string): string {
  const index = filePath.lastIndexOf(sep);
  return index > 0 ? filePath.slice(0, index) : sep;
}

function lineContainsSensitivePath(line: string): boolean {
  const parts = line.trim().split(/\s+/);
  return parts.some((token) => token.split(/[\\/]+/).some(isSensitiveName));
}

function filterSensitiveDiff(diff: string): string {
  if (!diff) return '';
  const chunks = diff.split(/(?=^diff --git )/m);
  return chunks.filter((chunk) => {
    const firstLine = chunk.split('\n', 1)[0] ?? '';
    return !lineContainsSensitivePath(firstLine);
  }).join('');
}

function cleanPath(value: string): string {
  const path = typeof value === 'string' ? value.trim() : '';
  if (!path) throw new Error('path is required');
  if (path.length > 512 || path.includes('\u0000')) throw new Error('Invalid file path');
  return path;
}

function assertNotSensitive(path: string): void {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.some(isSensitiveName)) throw new Error('Sensitive files are not available to Voice Brain');
}

function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAMES.some((pattern) => pattern.test(name));
}
