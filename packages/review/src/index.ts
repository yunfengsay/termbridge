import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import parseDiff from 'parse-diff';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 80;
const MAX_LINES_TOTAL = 4_000;
const MAX_LINES_PER_FILE = 800;
const MAX_LINES_PER_SELECTED_FILE = 20_000;
const MAX_LINE_CHARS = 1_000;
const MAX_BRANCHES = 100;
const MAX_UNTRACKED_FILES = 40;
const MAX_UNTRACKED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PROJECT_FILES = 20_000;
const MAX_PROJECT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_REPOSITORIES = 12;
const MAX_REPOSITORY_FILES = 200;
const MAX_TOUCHED_PER_REPOSITORY = 500;
/** Distinct directories looked up per request; each costs one `git rev-parse`. */
const MAX_DIRECTORY_LOOKUPS = 256;
const MAX_COMMITTED_BYTES = 20 * 1024 * 1024;
const COMMITTED_CACHE_ENTRIES = 2;
const PRIVATE_NAME = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.termbridge|\.npmrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519))$|\.(?:pem|key|p12|pfx|keystore|jks)$/i;

/** Environment files, keys and credentials: their contents never leave the Host. */
export function isPrivateName(name: string): boolean {
  return PRIVATE_NAME.test(name);
}

/** A path with any private component, in either separator style. */
export function isPrivatePath(path: string): boolean {
  return path.split(/[\\/]/).some(isPrivateName);
}

export type ReviewMode = 'working' | 'branch' | 'files';
export type ReviewFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked' | 'unchanged';
export type ReviewLineKind = 'context' | 'add' | 'delete';

export interface ReviewLine {
  kind: ReviewLineKind;
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface ReviewHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ReviewLine[];
}

export interface ReviewFile {
  path: string;
  oldPath?: string;
  status: ReviewFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  /** A private file (see `isPrivatePath`): listed, but its contents are withheld. */
  private?: boolean;
  hunks: ReviewHunk[];
}

export interface ReviewSnapshot {
  repository: string;
  repositoryPath: string;
  branch: string;
  detached: boolean;
  mode: ReviewMode;
  baseBranch?: string;
  dirty: boolean;
  canSwitchBranch: boolean;
  branches: string[];
  files: ReviewFile[];
  changedFileCount: number;
  additions: number;
  deletions: number;
  truncated: boolean;
}

export type ReviewFileSummary = Omit<ReviewFile, 'hunks'>;

/** A repository a conversation touched, with its current uncommitted changes. */
export interface ReviewRepository {
  repository: string;
  repositoryPath: string;
  branch: string;
  detached: boolean;
  /** The session's own working directory is inside this repository. */
  current: boolean;
  files: ReviewFileSummary[];
  changedFileCount: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  /** Repository-relative files the conversation changed, whether or not they differ now. */
  touched: string[];
  touchedTruncated?: boolean;
  error?: string;
}

/** Where an absolute path sits: its repository root and the path inside it. */
export interface RepositoryLocation {
  root: string;
  relativePath: string;
}

export interface ReviewSnapshotOptions {
  mode?: ReviewMode;
  baseBranch?: string;
  /** A file path previously returned by this service, never an arbitrary host path. */
  path?: string;
}

export interface ReviewAvailability {
  available: boolean;
  mode?: ReviewMode;
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function cleanPath(path: string | undefined): string | undefined {
  if (!path || path === '/dev/null') return undefined;
  return path.replace(/^(?:a|b)\//, '').replace(/^\.\//, '');
}

function displayText(content: string): string {
  const withoutMarker = /^[ +\-]/.test(content) ? content.slice(1) : content;
  return withoutMarker.replace(/\r$/, '').slice(0, MAX_LINE_CHARS);
}

function toReviewFile(file: parseDiff.File, untracked = false): ReviewFile {
  const from = cleanPath(file.from);
  const to = cleanPath(file.to);
  const renamed = Boolean(from && to && from !== to);
  const path = to || from || '(unknown file)';
  const status: ReviewFileStatus = untracked
    ? 'untracked'
    : file.new
      ? 'added'
      : file.deleted
        ? 'deleted'
        : renamed
          ? 'renamed'
          : 'modified';
  const binary = file.chunks.length === 0 && file.additions === 0 && file.deletions === 0;
  if (isPrivatePath(path) || (from !== undefined && isPrivatePath(from))) {
    return {
      path,
      oldPath: renamed ? from : undefined,
      status,
      additions: file.additions,
      deletions: file.deletions,
      binary,
      truncated: false,
      private: true,
      hunks: [],
    };
  }

  return {
    path,
    oldPath: renamed ? from : undefined,
    status,
    additions: file.additions,
    deletions: file.deletions,
    binary,
    truncated: false,
    hunks: file.chunks.map((chunk) => ({
      header: chunk.content.slice(0, 500),
      oldStart: chunk.oldStart,
      oldLines: chunk.oldLines,
      newStart: chunk.newStart,
      newLines: chunk.newLines,
      lines: chunk.changes.map((change): ReviewLine => {
        // parse-diff gives "\ No newline at end of file" the previous line's
        // kind and numbers; it belongs to no line of either version.
        if (change.content.startsWith('\\')) return { kind: 'context', text: change.content.slice(0, MAX_LINE_CHARS) };
        if (change.type === 'normal') {
          return {
            kind: 'context',
            oldLine: change.ln1,
            newLine: change.ln2,
            text: displayText(change.content),
          };
        }
        if (change.type === 'add') {
          return { kind: 'add', newLine: change.ln, text: displayText(change.content) };
        }
        return { kind: 'delete', oldLine: change.ln, text: displayText(change.content) };
      }),
    })),
  };
}

function limitFile(source: ReviewFile, maxLines: number): ReviewFile {
  let remainingLines = maxLines;
  let fileTruncated = source.truncated;
  const hunks: ReviewHunk[] = [];
  for (const hunk of source.hunks) {
    if (remainingLines <= 0) {
      fileTruncated = true;
      break;
    }
    const lines = hunk.lines.slice(0, remainingLines);
    if (lines.length < hunk.lines.length) fileTruncated = true;
    hunks.push({ ...hunk, lines });
    remainingLines -= lines.length;
    if (fileTruncated) break;
  }
  return { ...source, hunks, truncated: fileTruncated };
}

function limitFiles(input: ReviewFile[], selectedPath?: string): { files: ReviewFile[]; truncated: boolean } {
  const visible = input.slice(0, MAX_FILES);
  if (selectedPath) {
    let selectedFound = false;
    const files = visible.map((source) => {
      if (source.path === selectedPath) {
        selectedFound = true;
        return limitFile(source, MAX_LINES_PER_SELECTED_FILE);
      }
      const hasDetails = source.hunks.some((hunk) => hunk.lines.length > 0);
      return { ...source, hunks: [], truncated: source.truncated || hasDetails };
    });
    if (!selectedFound) throw new Error('Unknown changed file');
    return {
      files,
      truncated: input.length > MAX_FILES || files.some((file) => file.path !== selectedPath && file.truncated),
    };
  }

  let remainingLines = MAX_LINES_TOTAL;
  let truncated = input.length > MAX_FILES;
  const files: ReviewFile[] = [];

  for (const source of visible) {
    let fileLines = 0;
    let fileTruncated = source.truncated;
    const hunks: ReviewHunk[] = [];
    for (const hunk of source.hunks) {
      const allowed = Math.min(MAX_LINES_PER_FILE - fileLines, remainingLines);
      if (allowed <= 0) {
        fileTruncated = true;
        truncated = true;
        break;
      }
      const lines = hunk.lines.slice(0, allowed);
      if (lines.length < hunk.lines.length) {
        fileTruncated = true;
        truncated = true;
      }
      hunks.push({ ...hunk, lines });
      fileLines += lines.length;
      remainingLines -= lines.length;
      if (fileTruncated) break;
    }
    files.push({ ...source, hunks, truncated: fileTruncated });
  }
  return { files, truncated };
}

function isSafeRepositoryPath(path: string): boolean {
  return path.length > 0
    && path.length <= 1_024
    && !isAbsolute(path)
    && !path.split('/').includes('..');
}

function projectFile(path: string, untracked: boolean): ReviewFile {
  return {
    path,
    status: untracked ? 'untracked' : 'unchanged',
    additions: 0,
    deletions: 0,
    binary: false,
    truncated: false,
    hunks: [],
  };
}

export class GitReviewService {
  /** Cheap entry-point probe: no patch contents cross the wire until the user opens Review. */
  async availability(cwd: string): Promise<ReviewAvailability> {
    const root = (await this.git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
    if (!root) throw new Error('This session is not inside a Git repository');

    const status = (await this.git(root, ['status', '--porcelain=v1', '-z'])).stdout;
    if (status.length > 0) return { available: true, mode: 'working' };

    const branchResult = await this.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]);
    if (branchResult.exitCode !== 0) return { available: true, mode: 'files' };
    const branch = branchResult.stdout.trim();
    const branches = (await this.git(root, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      'refs/heads',
    ])).stdout.split('\n').map((value) => value.trim()).filter(Boolean).slice(0, MAX_BRANCHES);
    const baseBranch = this.resolveBaseBranch(undefined, branch, branches);
    if (!baseBranch || baseBranch === branch) return { available: true, mode: 'files' };

    const changed = await this.git(root, ['diff', '--quiet', `${baseBranch}...HEAD`, '--'], [0, 1]);
    return changed.exitCode === 1
      ? { available: true, mode: 'branch' }
      : { available: true, mode: 'files' };
  }

  async snapshot(cwd: string, options: ReviewSnapshotOptions = {}): Promise<ReviewSnapshot> {
    const root = (await this.git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
    if (!root) throw new Error('This session is not inside a Git repository');

    const branchResult = await this.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]);
    const detached = branchResult.exitCode !== 0;
    const branch = detached
      ? (await this.git(root, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
      : branchResult.stdout.trim();
    const branches = (await this.git(root, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      'refs/heads',
    ])).stdout.split('\n').map((value) => value.trim()).filter(Boolean).slice(0, MAX_BRANCHES);
    const status = (await this.git(root, ['status', '--porcelain=v1', '-z'])).stdout;
    const dirty = status.length > 0;
    const mode = options.mode ?? 'working';
    const baseBranch = mode === 'branch' ? this.resolveBaseBranch(options.baseBranch, branch, branches) : undefined;
    const hasHead = (await this.git(root, ['rev-parse', '--verify', 'HEAD'], [0, 128])).exitCode === 0;

    if (mode === 'files') {
      return this.projectSnapshot(root, {
        branch,
        detached,
        branches,
        dirty,
        path: options.path,
      });
    }

    const { files: parsedFiles, truncated: sourceTruncated } = await this.changedFiles(root, mode, baseBranch, hasHead);
    const additions = parsedFiles.reduce((sum, file) => sum + file.additions, 0);
    const deletions = parsedFiles.reduce((sum, file) => sum + file.deletions, 0);
    const limited = limitFiles(parsedFiles, options.path);
    return {
      repository: basename(root),
      repositoryPath: root,
      branch,
      detached,
      mode,
      baseBranch,
      dirty,
      canSwitchBranch: !dirty && !detached,
      branches,
      files: limited.files,
      changedFileCount: parsedFiles.length,
      additions,
      deletions,
      truncated: sourceTruncated || limited.truncated,
    };
  }

  /** The full change set: tracked changes in `range`, plus untracked files in working mode. */
  private async changedFiles(
    root: string,
    mode: ReviewMode,
    baseBranch: string | undefined,
    hasHead: boolean,
  ): Promise<{ files: ReviewFile[]; truncated: boolean }> {
    let patch = '';
    if (hasHead) {
      const range = mode === 'branch' ? `${baseBranch}...HEAD` : 'HEAD';
      patch = (await this.git(root, [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--find-renames',
        '--unified=3',
        range,
        '--',
      ])).stdout;
    }

    const files = parseDiff(patch).map((file) => toReviewFile(file));
    let truncated = false;
    if (mode === 'working') {
      const untracked = (await this.git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout
        .split('\0')
        .filter(Boolean);
      if (untracked.length > MAX_UNTRACKED_FILES) truncated = true;
      for (const path of untracked.slice(0, MAX_UNTRACKED_FILES)) {
        if (isPrivatePath(path)) {
          // Never read: an untracked private file has no committed side to compare anyway.
          files.push({
            path,
            status: 'untracked',
            additions: 0,
            deletions: 0,
            binary: false,
            truncated: false,
            private: true,
            hunks: [],
          });
          continue;
        }
        const info = await lstat(join(root, path));
        if (!info.isFile() || info.size > MAX_UNTRACKED_FILE_BYTES) {
          files.push({
            path,
            status: 'untracked',
            additions: 0,
            deletions: 0,
            binary: !info.isFile(),
            truncated: true,
            hunks: [],
          });
          truncated = true;
          continue;
        }
        const result = await this.git(root, [
          'diff',
          '--no-index',
          '--no-color',
          '--no-ext-diff',
          '--unified=3',
          '--',
          '/dev/null',
          path,
        ], [0, 1]);
        const parsed = parseDiff(result.stdout);
        if (parsed.length) files.push(...parsed.map((file) => toReviewFile(file, true)));
        else {
          files.push({
            path,
            status: 'untracked',
            additions: 0,
            deletions: 0,
            binary: true,
            truncated: false,
            hunks: [],
          });
        }
      }
    }
    return { files, truncated };
  }

  /**
   * Every repository a conversation is associated with: the one holding its
   * working directory first, then each holding a file it changed. Each comes
   * with its current uncommitted changes and the touched files inside it.
   * Paths that are not inside any repository are dropped.
   */
  async repositories(cwd: string | undefined, touchedPaths: readonly string[]): Promise<ReviewRepository[]> {
    const ordered = await this.group(cwd, touchedPaths);
    return Promise.all(ordered.map(async ([root, entry]) => {
      const touched = [...entry.touched].sort();
      const base = {
        repository: basename(root),
        repositoryPath: root,
        current: entry.current,
        touched,
        ...(entry.touchedTruncated ? { touchedTruncated: true } : {}),
      };
      try {
        return { ...base, ...(await this.summary(root)) };
      } catch (error) {
        return {
          ...base,
          branch: '?',
          detached: false,
          files: [],
          changedFileCount: 0,
          additions: 0,
          deletions: 0,
          truncated: false,
          error: (error as Error).message.slice(0, 1_000),
        };
      }
    }));
  }

  /** Only the repository roots, in the same order, without computing any changes. */
  async repositoryRoots(cwd: string | undefined, touchedPaths: readonly string[]): Promise<string[]> {
    return (await this.group(cwd, touchedPaths)).map(([root]) => root);
  }

  private async group(cwd: string | undefined, touchedPaths: readonly string[]) {
    const lookup = this.lookup();
    const found = new Map<string, { current: boolean; touched: Set<string>; touchedTruncated: boolean }>();
    if (cwd) {
      const location = await lookup(cwd, true);
      if (location) found.set(location.root, { current: true, touched: new Set(), touchedTruncated: false });
    }
    for (const path of touchedPaths) {
      const location = await lookup(path, false);
      if (!location) continue;
      let entry = found.get(location.root);
      if (!entry) {
        if (found.size >= MAX_REPOSITORIES) continue;
        entry = { current: false, touched: new Set(), touchedTruncated: false };
        found.set(location.root, entry);
      }
      if (entry.touched.size < MAX_TOUCHED_PER_REPOSITORY) entry.touched.add(location.relativePath);
      else entry.touchedTruncated = true;
    }
    return [...found.entries()].sort(([leftRoot, left], [rightRoot, right]) =>
      Number(right.current) - Number(left.current)
      || right.touched.size - left.touched.size
      || basename(leftRoot).localeCompare(basename(rightRoot))
      || leftRoot.localeCompare(rightRoot));
  }

  /** A repository's current uncommitted changes, listed without their patches. */
  private async summary(root: string): Promise<Omit<ReviewRepository, 'repository' | 'repositoryPath' | 'current' | 'touched'>> {
    const branchResult = await this.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]);
    const detached = branchResult.exitCode !== 0;
    const branch = detached
      ? (await this.git(root, ['rev-parse', '--short', 'HEAD'], [0, 128])).stdout.trim() || 'HEAD'
      : branchResult.stdout.trim();
    const hasHead = (await this.git(root, ['rev-parse', '--verify', 'HEAD'], [0, 128])).exitCode === 0;
    const { files, truncated } = await this.changedFiles(root, 'working', undefined, hasHead);
    return {
      branch,
      detached,
      files: files.slice(0, MAX_REPOSITORY_FILES).map(({ hunks: _hunks, ...file }) => file),
      changedFileCount: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      truncated: truncated || files.length > MAX_REPOSITORY_FILES,
    };
  }

  /** The repository holding `path` and the path inside it, or undefined outside Git. */
  async locate(path: string): Promise<RepositoryLocation | undefined> {
    return this.lookup()(path, false);
  }

  /**
   * One lookup per request. A deleted file is found through its nearest
   * existing ancestor, and every directory costs at most one `git rev-parse`.
   */
  private lookup(): (path: string, directory: boolean) => Promise<RepositoryLocation | undefined> {
    const roots = new Map<string, string | null>();
    return async (path, directory) => {
      if (!isAbsolute(path) || path.includes('\0') || path.length > 4_096) return undefined;
      let existing = normalize(directory ? path : dirname(path));
      const rest: string[] = directory ? [] : [basename(path)];
      for (let depth = 0; ; depth += 1) {
        const info = await lstat(existing).catch(() => undefined);
        if (info?.isDirectory()) break;
        const parent = dirname(existing);
        if (parent === existing || depth > 64) return undefined;
        rest.unshift(basename(existing));
        existing = parent;
      }
      let root = roots.get(existing);
      if (root === undefined) {
        if (roots.size >= MAX_DIRECTORY_LOOKUPS) return undefined;
        const result = await this.git(existing, ['rev-parse', '--show-toplevel'], [0, 128]);
        root = result.exitCode === 0 ? result.stdout.trim() || null : null;
        roots.set(existing, root);
      }
      if (!root) return undefined;
      // Git reports the real top-level path; measure from the real directory too.
      const inside = relative(root, join(await realpath(existing), ...rest));
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
      return { root, relativePath: inside.split(sep).join('/') };
    };
  }

  private committedCache: Array<{ key: string; data: Buffer }> = [];

  /** A file as committed at HEAD, named by its blob id so a moved HEAD is noticed. */
  async committedFile(root: string, relativePath: string): Promise<{ id: string; data: Buffer }> {
    if (!isSafeRepositoryPath(relativePath)) throw new Error('Invalid repository path');
    if (isPrivatePath(relativePath)) throw new Error('Private configuration cannot be previewed');
    const resolved = await this.git(root, ['rev-parse', '--verify', '--quiet', `HEAD:${relativePath}`], [0, 1, 128]);
    const id = resolved.stdout.trim();
    if (resolved.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(id)) throw new Error('This file is not in the last commit');
    const key = `${root}\0${id}`;
    const cached = this.committedCache.find((entry) => entry.key === key);
    if (cached) return { id, data: cached.data };
    if ((await this.git(root, ['cat-file', '-t', id])).stdout.trim() !== 'blob') throw new Error('Only files can be previewed');
    const size = Number((await this.git(root, ['cat-file', '-s', id])).stdout.trim());
    if (!Number.isSafeInteger(size) || size > MAX_COMMITTED_BYTES) throw new Error('File exceeds the 20 MiB preview limit');
    const data = await this.gitBytes(root, ['cat-file', 'blob', id], MAX_COMMITTED_BYTES + 1);
    this.committedCache = [{ key, data }, ...this.committedCache].slice(0, COMMITTED_CACHE_ENTRIES);
    return { id, data };
  }

  private async projectSnapshot(
    root: string,
    repository: {
      branch: string;
      detached: boolean;
      branches: string[];
      dirty: boolean;
      path?: string;
    },
  ): Promise<ReviewSnapshot> {
    const allPaths = (await this.git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).stdout
      .split('\0')
      .filter(Boolean);
    const untracked = new Set(
      (await this.git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout
        .split('\0')
        .filter(Boolean),
    );
    const safePaths = allPaths.filter(isSafeRepositoryPath).sort();
    const visiblePaths = safePaths.slice(0, MAX_PROJECT_FILES);
    const selectedPath = repository.path;
    if (selectedPath && !visiblePaths.includes(selectedPath)) throw new Error('Unknown project file');

    const files = visiblePaths.map((path) => projectFile(path, untracked.has(path)));
    if (selectedPath) {
      const index = visiblePaths.indexOf(selectedPath);
      files[index] = await this.readProjectFile(root, files[index]);
    }

    return {
      repository: basename(root),
      repositoryPath: root,
      branch: repository.branch,
      detached: repository.detached,
      mode: 'files',
      dirty: repository.dirty,
      canSwitchBranch: !repository.dirty && !repository.detached,
      branches: repository.branches,
      files,
      changedFileCount: safePaths.length,
      additions: 0,
      deletions: 0,
      truncated: safePaths.length !== allPaths.length || safePaths.length > MAX_PROJECT_FILES,
    };
  }

  private async readProjectFile(root: string, source: ReviewFile): Promise<ReviewFile> {
    if (isPrivatePath(source.path)) return { ...source, private: true };
    const absolutePath = join(root, source.path);
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) return { ...source, binary: true };

    const [resolvedRoot, resolved] = await Promise.all([realpath(root), realpath(absolutePath)]);
    const resolvedRelative = relative(resolvedRoot, resolved);
    if (!resolvedRelative || resolvedRelative.startsWith('..') || isAbsolute(resolvedRelative)) {
      throw new Error('Project file resolves outside the repository');
    }
    // A linked directory can lead a harmless name to a private file.
    if (isPrivatePath(resolvedRelative)) return { ...source, private: true };
    if (info.size > MAX_PROJECT_FILE_BYTES) return { ...source, truncated: true };

    const content = await readFile(resolved);
    if (content.includes(0)) return { ...source, binary: true };
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      return { ...source, binary: true };
    }

    const sourceLines = text.replace(/\r\n?/g, '\n').split('\n');
    if (sourceLines.at(-1) === '') sourceLines.pop();
    const lines = sourceLines.slice(0, MAX_LINES_PER_SELECTED_FILE);
    const lineWasShortened = lines.some((line) => line.length > MAX_LINE_CHARS);
    return {
      ...source,
      truncated: sourceLines.length > lines.length || lineWasShortened,
      hunks: [{
        header: '',
        oldStart: 1,
        oldLines: lines.length,
        newStart: 1,
        newLines: lines.length,
        lines: lines.map((line, index) => ({
          kind: 'context',
          oldLine: index + 1,
          newLine: index + 1,
          text: line.slice(0, MAX_LINE_CHARS),
        })),
      }],
    };
  }

  async switchBranch(cwd: string, branch: string): Promise<string> {
    const root = (await this.git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
    const branches = (await this.git(root, [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads',
    ])).stdout.split('\n').map((value) => value.trim()).filter(Boolean);
    if (!branches.includes(branch) || branch.startsWith('-')) throw new Error('Unknown local branch');
    const dirty = (await this.git(root, ['status', '--porcelain=v1', '-z'])).stdout.length > 0;
    if (dirty) throw new Error('Commit or stash working changes before switching branches');
    await this.git(root, ['switch', '--no-guess', branch]);
    return branch;
  }

  private resolveBaseBranch(requested: string | undefined, current: string, branches: string[]): string {
    if (requested) {
      if (!branches.includes(requested)) throw new Error('Unknown local base branch');
      return requested;
    }
    return branches.find((name) => name !== current && (name === 'main' || name === 'master'))
      ?? current;
  }

  private async gitBytes(cwd: string, args: string[], maxBuffer: number): Promise<Buffer> {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'buffer',
      maxBuffer,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return result.stdout;
  }

  private async git(cwd: string, args: string[], allowedExitCodes = [0]): Promise<GitResult> {
    try {
      const result = await execFileAsync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      const exitCode = typeof failure.code === 'number' ? failure.code : -1;
      if (allowedExitCodes.includes(exitCode)) {
        return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode };
      }
      const detail = (failure.stderr || failure.message).trim().split('\n').at(-1);
      throw new Error(detail || 'Git command failed');
    }
  }
}
