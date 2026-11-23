import { constants } from 'node:fs';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { isPrivateName, isPrivatePath } from '@termbridge/review';

export const FILE_CHUNK_BYTES = 128 * 1024;
export const FILE_MAX_BYTES = 20 * 1024 * 1024;
export interface SessionFileRequest { path: string; offset: number; version?: string }

/** The two Git operations a committed read needs, supplied by the review service. */
export interface CommittedFiles {
  locate(path: string): Promise<{ root: string; relativePath: string } | undefined>;
  committedFile(root: string, relativePath: string): Promise<{ id: string; data: Buffer }>;
}

/** Explicit file clicks: bounded reads rooted in this session, never arbitrary shell/HTTP. */
export async function readSessionFile(cwd: string, request: SessionFileRequest,
  extraRoots = (process.env.TB_FILE_PREVIEW_ROOTS || '').split(delimiter).filter(Boolean)) {
  const { path, offset } = request;
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > FILE_MAX_BYTES) throw new Error('Invalid file request');
  if (isPrivatePath(path)) throw new Error('Private configuration cannot be previewed');
  const { target, rootPath } = await resolveSessionPath(cwd, path, extraRoots);
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
  const { path, offset } = request;
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > FILE_MAX_BYTES) throw new Error('Invalid file request');
  if (isPrivatePath(path)) throw new Error('Private configuration cannot be previewed');
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

async function resolveSessionPath(cwd: string, path: string, extraRoots: string[]) {
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Invalid file path');
  if (isPrivatePath(path)) throw new Error('Private configuration cannot be previewed');
  const roots = await Promise.all([cwd, ...extraRoots].map(root => realpath(root)));
  const target = await realpath(path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(roots[0], path));
  const rootPath = roots.find(root => {
    const local = relative(root, target);
    return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
  });
  if (!rootPath) throw new Error('File is outside this session workspace');
  if (target.split(sep).some(isPrivateName)) throw new Error('Private configuration cannot be previewed');
  return { target, rootPath };
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
