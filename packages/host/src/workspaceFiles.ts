import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TEXT_CHARS = 16_000;
const MAX_LIST_ENTRIES = 100;
const SKIPPED_DIRECTORIES = new Set(['.git', '.gradle', 'build', 'dist', 'node_modules']);
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

export type WorkspaceFileAction = 'list' | 'read';

/** A deliberately small, read-only filesystem boundary for the cloud Voice Brain. */
export class WorkspaceFiles {
  constructor(
    private readonly projectsRoot = process.env.TB_BRAIN_FILES_ROOT || join(homedir(), 'code'),
    private readonly memoryPath = process.env.TB_BRAIN_MEMORY || join(homedir(), '.termbridge', 'memory.md'),
  ) {}

  async execute(action: WorkspaceFileAction, inputPath: string): Promise<Record<string, unknown>> {
    const path = cleanPath(inputPath);
    if (path === '@memory') {
      if (action !== 'read') throw new Error('@memory can only be read');
      return this.readText(await realpath(this.memoryPath), '@memory');
    }
    const target = await this.resolveProjectPath(path);
    if (action === 'list') return this.listDirectory(target, path);
    return this.readText(target, path);
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

  private async readText(target: string, path: string): Promise<Record<string, unknown>> {
    const metadata = await stat(target);
    if (!metadata.isFile()) throw new Error('File path is not a regular file');
    if (metadata.size > MAX_FILE_BYTES) throw new Error('File is too large for Voice Brain');
    const data = await readFile(target);
    if (data.includes(0)) throw new Error('Binary files are not available to Voice Brain');
    const text = data.toString('utf8').replace(/\u0000/g, '');
    const replacementCount = [...text].filter((character) => character === '\uFFFD').length;
    if (replacementCount > Math.max(2, text.length / 100)) {
      throw new Error('Binary files are not available to Voice Brain');
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
