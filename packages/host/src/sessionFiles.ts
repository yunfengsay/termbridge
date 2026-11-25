import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, normalize, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { isPrivateName, isPrivatePath } from '@termbridge/review';

const execFileAsync = promisify(execFile);
const FILE_LOCATION_SUFFIX = /(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/i;
const SKIP_SEARCH_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.build', '.next', 'target', 'DerivedData', '.gradle', 'Pods', '.turbo', '.cache',
]);
const MAX_WALK_DEPTH = 12;
const MAX_WALK_ENTRIES = 15_000;

/** Strip trailing `:line[:col][-endLine[:endCol]]` or `#Lline[Ccol][-LendLine[CendCol]]` locators. */
export function stripFileLocationSuffix(rawPath: string): string {
  const stripped = rawPath.replace(FILE_LOCATION_SUFFIX, '');
  return stripped || rawPath;
}

export const FILE_CHUNK_BYTES = 128 * 1024;
export const FILE_MAX_BYTES = 20 * 1024 * 1024;
export interface SessionFileRequest { path: string; offset: number; version?: string }

/** The two Git operations a committed read needs, supplied by the review service. */
export interface CommittedFiles {
  locate(path: string): Promise<{ root: string; relativePath: string } | undefined>;
  committedFile(root: string, relativePath: string): Promise<{ id: string; data: Buffer }>;
}

export interface SessionFileOptions {
  /** Permit explicit non-hidden `~/` or absolute paths inside the user's home directory (excluding dotfiles, `Library`, and private files). */
  allowSafeHomePaths?: boolean;
  /** Overridable home directory for tests. */
  homeDir?: string;
}

const BLOCKED_HOME_TOP_DIRS = new Set(['library', 'applications']);

/** Explicit file clicks: bounded reads rooted in this session, never arbitrary shell/HTTP. */
export async function readSessionFile(cwd: string, request: SessionFileRequest,
  extraRoots = (process.env.TB_FILE_PREVIEW_ROOTS || '').split(delimiter).filter(Boolean),
  options: SessionFileOptions = {}) {
  const { path, offset } = request;
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > FILE_MAX_BYTES) throw new Error('Invalid file request');
  if (isPrivatePath(path)) throw new Error('Private configuration cannot be previewed');
  const { target, rootPath } = await resolveSessionPath(cwd, path, extraRoots, options);
  const before = await stat(target);
  if (!before.isFile()) throw new Error('Only regular files can be previewed');
  if (before.size > FILE_MAX_BYTES) throw new Error('File exceeds the 20 MiB preview limit');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat({ bigint: true });
    if (!metadata.isFile() || metadata.ino !== BigInt(before.ino) || metadata.dev !== BigInt(before.dev)) throw new Error('File changed; reopen its preview');
    const size = Number(metadata.size);
    const version = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
    if (size > FILE_MAX_BYTES || offset > size || (offset > 0 && !request.version) ||
        (request.version !== undefined && request.version !== version)) throw new Error('File changed; reopen its preview');
    const data = Buffer.alloc(Math.min(FILE_CHUNK_BYTES, size - offset));
    const { bytesRead } = await file.read(data, 0, data.length, offset);
    const after = await file.stat({ bigint: true });
    if (bytesRead !== data.length || after.size !== metadata.size || after.mtimeNs !== metadata.mtimeNs || after.ctimeNs !== metadata.ctimeNs) throw new Error('File changed; reopen its preview');
    return { name: basename(target), path: target, rootPath, size, version, offset, data, eof: offset + bytesRead === size };
  } finally { await file.close(); }
}

/**
 * The committed version of a file inside one of this session's roots, so a
 * changed or deleted file can be compared with what it was. The version names
 * the blob: if HEAD moves between chunks, the read restarts instead of mixing.
 */
export async function readSessionRevision(cwd: string, request: SessionFileRequest, git: CommittedFiles,
  extraRoots = (process.env.TB_FILE_PREVIEW_ROOTS || '').split(delimiter).filter(Boolean)) {
  const { path: rawPath, offset } = request;
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 4096 || /[\x00-\x1f\x7f]/.test(rawPath) ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > FILE_MAX_BYTES) throw new Error('Invalid file request');
  const path = stripFileLocationSuffix(rawPath);
  if (isPrivatePath(rawPath) || isPrivatePath(path)) throw new Error('Private configuration cannot be previewed');
  const roots = await Promise.all([cwd, ...extraRoots].map(root => realpath(root)));
  // A deleted file has no real path of its own; the repository lookup resolves its parents.
  const absolute = normalize(path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(roots[0], path));
  const location = await git.locate(absolute);
  if (!location) throw new Error('File is not inside a Git repository');
  const target = join(location.root, ...location.relativePath.split('/'));
  const rootPath = roots.find(root => {
    const local = relative(root, target);
    return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
  });
  if (!rootPath) throw new Error('File is outside this session workspace');
  if (isPrivatePath(location.relativePath)) throw new Error('Private configuration cannot be previewed');
  const blob = await git.committedFile(location.root, location.relativePath);
  const size = blob.data.length;
  const version = `HEAD:${blob.id}`;
  if (size > FILE_MAX_BYTES) throw new Error('File exceeds the 20 MiB preview limit');
  if (offset > size || (offset > 0 && !request.version) ||
      (request.version !== undefined && request.version !== version)) throw new Error('File changed; reopen its preview');
  const data = Buffer.from(blob.data.subarray(offset, Math.min(size, offset + FILE_CHUNK_BYTES)));
  return { name: basename(target), path: target, rootPath, size, version, offset, data, eof: offset + data.length === size };
}

function expandHome(value: string, homeDir = homedir()): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return resolve(homeDir, value.slice(2));
  return value;
}

async function resolveSessionPath(cwd: string, rawPath: string, extraRoots: string[], options: SessionFileOptions = {}) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 4096 || /[\x00-\x1f\x7f]/.test(rawPath)) throw new Error('Invalid file path');
  const cleanPath = stripFileLocationSuffix(rawPath);
  if (isPrivatePath(rawPath) || isPrivatePath(cleanPath)) throw new Error('Private configuration cannot be previewed');
  const homeDir = options.homeDir ?? homedir();
  const primaryRoot = await realpath(expandHome(cwd, homeDir));
  const resolvedExtras = (await Promise.all(
    extraRoots.map(async root => {
      try { return await realpath(expandHome(root, homeDir)); } catch { return undefined; }
    }),
  )).filter((root): root is string => Boolean(root));
  const roots = [primaryRoot, ...resolvedExtras];

  const candidatePaths = cleanPath === rawPath ? [rawPath] : [rawPath, cleanPath];
  let target: string | undefined;
  let lastError: unknown;

  for (const candidate of candidatePaths) {
    if (candidate.startsWith('~/') || isAbsolute(candidate)) {
      const resolved = candidate.startsWith('~/') ? resolve(homeDir, candidate.slice(2)) : resolve(candidate);
      try {
        target = await realpath(resolved);
        break;
      } catch (error) {
        lastError = error;
      }
      continue;
    }
    for (const root of roots) {
      try {
        target = await realpath(resolve(root, candidate));
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (target) break;
  }

  // Fallback for shortened relative links emitted by Agents (e.g. `timeline.css:42` or `features/timeline/timeline.css`).
  if (!target && isNotFoundError(lastError) && isSafeRelativeSuffixQuery(cleanPath)) {
    const matched = await findByRelativeSuffix(roots, cleanPath);
    if (matched) target = matched;
  }

  if (!target) throw lastError ?? new Error('File cannot be read');

  let rootPath = roots.find(root => {
    const local = relative(root, target);
    return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
  });
  if (!rootPath && options.allowSafeHomePaths && (cleanPath.startsWith('~/') || isAbsolute(cleanPath))) {
    const homeReal = await realpath(homeDir).catch(() => undefined);
    if (homeReal && isSafeHomeTarget(homeReal, target)) {
      rootPath = homeReal;
    }
  }
  if (!rootPath) throw new Error('File is outside this session workspace');
  if (target.split(sep).some(isPrivateName)) throw new Error('Private configuration cannot be previewed');
  return { target, rootPath };
}

function isSafeHomeTarget(homeReal: string, targetReal: string): boolean {
  const local = relative(homeReal, targetReal);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return false;
  const segments = local.split(sep).filter(Boolean);
  if (segments.length === 0) return false;
  if (BLOCKED_HOME_TOP_DIRS.has(segments[0]!.toLowerCase())) return false;
  for (const segment of segments) {
    if (segment.startsWith('.')) return false;
    if (isPrivateName(segment)) return false;
  }
  return true;
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}

function isSafeRelativeSuffixQuery(value: string): boolean {
  if (!value || isAbsolute(value) || value.startsWith('~/')) return false;
  const normalized = posix.normalize(value.replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    return false;
  }
  return true;
}

async function findByRelativeSuffix(roots: string[], query: string): Promise<string | undefined> {
  const normalizedQuery = posix.normalize(query.replace(/^\.\//, ''));
  const suffix = `/${normalizedQuery}`;

  for (const root of roots) {
    const candidates = await collectRelativeFilesInRoot(root, normalizedQuery, suffix);
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    for (const rel of candidates) {
      if (isPrivatePath(rel)) continue;
      try {
        const real = await realpath(join(root, ...rel.split('/')));
        const local = relative(root, real);
        if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) continue;
        if (real.split(sep).some(isPrivateName)) continue;
        if ((await stat(real)).isFile()) return real;
      } catch {
        // Skip unreadable or vanished candidates.
      }
    }
  }
  return undefined;
}

async function collectRelativeFilesInRoot(root: string, normalizedQuery: string, suffix: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { timeout: 1500, maxBuffer: 8 * 1024 * 1024 },
    );
    const matches: string[] = [];
    for (const entry of stdout.split('\0')) {
      if (!entry) continue;
      if (entry === normalizedQuery || entry.endsWith(suffix)) {
        matches.push(entry);
      }
    }
    return matches;
  } catch {
    return walkRelativeFilesInRoot(root, normalizedQuery, suffix);
  }
}

async function walkRelativeFilesInRoot(root: string, normalizedQuery: string, suffix: string): Promise<string[]> {
  const matches: string[] = [];
  let visited = 0;

  async function walk(dir: string, relDir: string, depth: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH || visited >= MAX_WALK_ENTRIES) return;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      return;
    }
    for await (const entry of handle) {
      if (++visited > MAX_WALK_ENTRIES) break;
      if (entry.isSymbolicLink() || isPrivateName(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_SEARCH_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name), rel, depth + 1);
      } else if (entry.isFile()) {
        if (rel === normalizedQuery || rel.endsWith(suffix)) {
          matches.push(rel);
        }
      }
    }
  }

  await walk(root, '', 0);
  return matches;
}

export async function listSessionDirectory(cwd: string, path: string,
  extraRoots = (process.env.TB_FILE_PREVIEW_ROOTS || '').split(delimiter).filter(Boolean)) {
  const { target, rootPath } = await resolveSessionPath(cwd, path, extraRoots);
  if (!(await stat(target)).isDirectory()) throw new Error('Not a directory');
  const entries: { name: string; directory: boolean }[] = [];
  // Do not materialize an unbounded directory just to return its first page.
  for await (const entry of await opendir(target)) {
    if (isPrivateName(entry.name) || entry.name === '.git' || entry.isSymbolicLink() ||
        (!entry.isFile() && !entry.isDirectory())) continue;
    entries.push({ name: entry.name, directory: entry.isDirectory() });
    if (entries.length > 1000) break;
  }
  entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return { path: target, rootPath, truncated: entries.length > 1000,
    entries: entries.slice(0, 1000) };
}
