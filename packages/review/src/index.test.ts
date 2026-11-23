import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitReviewService } from './index.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'termbridge-review-'));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'review-test@termbridge.local');
  git(cwd, 'config', 'user.name', 'Termbridge Review Test');
  writeFileSync(join(cwd, 'tracked.txt'), 'one\ntwo\n');
  git(cwd, 'add', 'tracked.txt');
  git(cwd, 'commit', '-m', 'base');
  return cwd;
}

test('working review includes tracked and untracked files as structured lines', async () => {
  const cwd = repository();
  try {
    writeFileSync(join(cwd, 'tracked.txt'), 'one\nchanged\n');
    writeFileSync(join(cwd, 'new file.txt'), 'hello\nmobile review\n');

    const snapshot = await new GitReviewService().snapshot(cwd, { mode: 'working' });

    assert.equal(snapshot.repositoryPath, realpathSync(cwd));
    assert.equal(snapshot.branch, 'main');
    assert.equal(snapshot.dirty, true);
    assert.equal(snapshot.canSwitchBranch, false);
    assert.deepEqual(snapshot.files.map((file) => file.status).sort(), ['modified', 'untracked']);
    assert.ok(snapshot.files.some((file) => file.hunks.some((hunk) => hunk.lines.some((line) => line.text === 'mobile review'))));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a selected file keeps ten thousand lines beyond the repository preview caps', async () => {
  const cwd = repository();
  try {
    writeFileSync(join(cwd, 'a-large.txt'), '');
    writeFileSync(join(cwd, 'z-selected.txt'), '');
    git(cwd, 'add', 'a-large.txt', 'z-selected.txt');
    git(cwd, 'commit', '-m', 'large review base');
    writeFileSync(join(cwd, 'a-large.txt'), Array.from({ length: 4_100 }, (_, i) => `large ${i}`).join('\n') + '\n');
    writeFileSync(join(cwd, 'z-selected.txt'), Array.from({ length: 10_000 }, (_, i) => `selected ${i}`).join('\n') + '\n');

    const service = new GitReviewService();
    const repositoryPreview = await service.snapshot(cwd, { mode: 'working' });
    const previewFile = repositoryPreview.files.find((file) => file.path === 'z-selected.txt');
    assert.equal(previewFile?.hunks.flatMap((hunk) => hunk.lines).length, 800);
    assert.equal(previewFile?.truncated, true);

    const selectedPreview = await service.snapshot(cwd, { mode: 'working', path: 'z-selected.txt' });
    const selectedFile = selectedPreview.files.find((file) => file.path === 'z-selected.txt');
    assert.equal(selectedFile?.additions, 10_000);
    assert.equal(selectedFile?.hunks.flatMap((hunk) => hunk.lines).length, 10_000);
    assert.equal(selectedFile?.truncated, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('availability prefers working changes without building a snapshot', async () => {
  const cwd = repository();
  try {
    writeFileSync(join(cwd, 'tracked.txt'), 'dirty\n');
    assert.deepEqual(await new GitReviewService().availability(cwd), { available: true, mode: 'working' });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('availability exposes committed branch changes and keeps clean repositories browsable', async () => {
  const cwd = repository();
  try {
    const service = new GitReviewService();
    git(cwd, 'branch', 'feature/other');
    assert.deepEqual(await service.availability(cwd), { available: true, mode: 'files' });
    git(cwd, 'switch', 'feature/other');
    writeFileSync(join(cwd, 'tracked.txt'), 'branch change\n');
    git(cwd, 'add', 'tracked.txt');
    git(cwd, 'commit', '-m', 'feature');
    assert.deepEqual(await service.availability(cwd), { available: true, mode: 'branch' });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('project files mode lists tracked and untracked code then loads only the selected file', async () => {
  const cwd = repository();
  try {
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'main.ts'), "export const answer = 42;\nconsole.log(answer);\n");
    writeFileSync(join(cwd, 'notes.md'), '# Local notes\n');
    writeFileSync(join(cwd, '.gitignore'), 'ignored.log\n');
    writeFileSync(join(cwd, 'ignored.log'), 'do not expose\n');
    git(cwd, 'add', 'src/main.ts', '.gitignore');
    git(cwd, 'commit', '-m', 'project tree');

    const service = new GitReviewService();
    const tree = await service.snapshot(cwd, { mode: 'files' });
    assert.deepEqual(tree.files.map((file) => file.path), ['.gitignore', 'notes.md', 'src/main.ts', 'tracked.txt']);
    assert.ok(tree.files.every((file) => file.hunks.length === 0));
    assert.equal(tree.files.find((file) => file.path === 'notes.md')?.status, 'untracked');

    const selected = await service.snapshot(cwd, { mode: 'files', path: 'src/main.ts' });
    const source = selected.files.find((file) => file.path === 'src/main.ts');
    assert.deepEqual(source?.hunks[0].lines.map((line) => [line.oldLine, line.text]), [
      [1, 'export const answer = 42;'],
      [2, 'console.log(answer);'],
    ]);
    assert.equal(selected.mode, 'files');
    assert.equal(selected.additions, 0);
    assert.equal(selected.deletions, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('project files mode rejects unknown paths and does not follow repository symlinks', async () => {
  const cwd = repository();
  const outside = mkdtempSync(join(tmpdir(), 'termbridge-review-outside-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'outside repository\n');
    symlinkSync(join(outside, 'secret.txt'), join(cwd, 'linked.txt'));
    git(cwd, 'add', 'linked.txt');
    git(cwd, 'commit', '-m', 'tracked symlink');

    const service = new GitReviewService();
    await assert.rejects(
      () => service.snapshot(cwd, { mode: 'files', path: '../secret.txt' }),
      /Unknown project file/,
    );
    const linked = await service.snapshot(cwd, { mode: 'files', path: 'linked.txt' });
    const file = linked.files.find((entry) => entry.path === 'linked.txt');
    assert.equal(file?.binary, true);
    assert.equal(file?.hunks.length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('branch review compares HEAD with a selected local base', async () => {
  const cwd = repository();
  try {
    git(cwd, 'switch', '-c', 'feature/mobile-review');
    writeFileSync(join(cwd, 'tracked.txt'), 'one\nbranch change\n');
    git(cwd, 'add', 'tracked.txt');
    git(cwd, 'commit', '-m', 'feature');

    const snapshot = await new GitReviewService().snapshot(cwd, {
      mode: 'branch',
      baseBranch: 'main',
    });

    assert.equal(snapshot.baseBranch, 'main');
    assert.equal(snapshot.branch, 'feature/mobile-review');
    assert.equal(snapshot.files.length, 1);
    assert.ok(snapshot.files[0].additions > 0);
    assert.ok(snapshot.files[0].deletions > 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('branch switching accepts only a clean known local branch', async () => {
  const cwd = repository();
  try {
    git(cwd, 'branch', 'other');
    const service = new GitReviewService();
    assert.equal(await service.switchBranch(cwd, 'other'), 'other');
    writeFileSync(join(cwd, 'tracked.txt'), 'dirty\n');
    await assert.rejects(() => service.switchBranch(cwd, 'main'), /Commit or stash/);
    await assert.rejects(() => service.switchBranch(cwd, '--detach'), /Unknown local branch/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the default branch comparison is empty on the default branch', async () => {
  const cwd = repository();
  try {
    git(cwd, 'branch', 'feature/other');
    const snapshot = await new GitReviewService().snapshot(cwd, { mode: 'branch' });
    assert.equal(snapshot.baseBranch, 'main');
    assert.equal(snapshot.files.length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a conversation lists its own repository first, then each repository it touched', async () => {
  const main = repository();
  const other = repository();
  const outside = mkdtempSync(join(tmpdir(), 'termbridge-review-outside-'));
  try {
    mkdirSync(join(main, 'src', 'deep'), { recursive: true });
    writeFileSync(join(main, 'tracked.txt'), 'one\nchanged\n');
    writeFileSync(join(other, 'tracked.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(other, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    git(other, 'add', 'image.png');
    git(other, 'commit', '-m', 'image');
    writeFileSync(join(other, 'committed.txt'), 'already committed\n');
    git(other, 'add', 'committed.txt');
    git(other, 'commit', '-m', 'agent commit');

    const repositories = await new GitReviewService().repositories(join(main, 'src', 'deep'), [
      join(other, 'tracked.txt'),
      join(other, 'committed.txt'),
      join(other, 'gone', 'deleted-with-its-directory.txt'),
      join(outside, 'not-a-repository.txt'),
      'relative/path.txt',
    ]);

    assert.deepEqual(repositories.map((repo) => repo.repositoryPath), [realpathSync(main), realpathSync(other)]);
    const [own, touched] = repositories;
    assert.equal(own.current, true);
    assert.deepEqual(own.touched, []);
    assert.deepEqual(own.files.map((file) => [file.path, file.status]), [['tracked.txt', 'modified']]);
    assert.equal('hunks' in own.files[0], false, 'a repository list carries no patches');
    assert.equal(touched.current, false);
    assert.equal(touched.branch, 'main');
    assert.deepEqual(touched.touched, ['committed.txt', 'gone/deleted-with-its-directory.txt', 'tracked.txt']);
    assert.deepEqual(touched.files.map((file) => file.path), ['tracked.txt']);
    assert.equal(touched.additions, 1);
  } finally {
    for (const path of [main, other, outside]) rmSync(path, { recursive: true, force: true });
  }
});

test('committed contents come from HEAD, so a changed or deleted image can be compared', async () => {
  const cwd = repository();
  try {
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255]);
    writeFileSync(join(cwd, 'logo.png'), original);
    git(cwd, 'add', 'logo.png');
    git(cwd, 'commit', '-m', 'logo');
    writeFileSync(join(cwd, 'logo.png'), Buffer.from('replaced'));
    rmSync(join(cwd, 'tracked.txt'));

    const service = new GitReviewService();
    const location = await service.locate(join(cwd, 'logo.png'));
    assert.deepEqual(location, { root: realpathSync(cwd), relativePath: 'logo.png' });
    const committed = await service.committedFile(location!.root, location!.relativePath);
    assert.deepEqual(committed.data, original, 'binary bytes survive unchanged');
    assert.match(committed.id, /^[0-9a-f]{40,64}$/);
    assert.deepEqual((await service.committedFile(location!.root, 'tracked.txt')).data, Buffer.from('one\ntwo\n'));

    writeFileSync(join(cwd, 'untracked.txt'), 'new\n');
    await assert.rejects(service.committedFile(location!.root, 'untracked.txt'), /not in the last commit/);
    await assert.rejects(service.committedFile(location!.root, '../escape.txt'), /Invalid repository path/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('private files are listed with their counts but their contents never leave the Host', async () => {
  const cwd = repository();
  try {
    mkdirSync(join(cwd, 'config'));
    writeFileSync(join(cwd, 'config', 'secrets.json'), '{"token":"committed-secret"}\n');
    git(cwd, 'add', 'config/secrets.json');
    git(cwd, 'commit', '-m', 'add secrets');
    writeFileSync(join(cwd, 'config', 'secrets.json'), '{"token":"changed-secret"}\n');
    writeFileSync(join(cwd, '.env'), 'API_KEY=untracked-secret\n');
    writeFileSync(join(cwd, 'server.pem'), '-----BEGIN PRIVATE KEY-----\n');

    const service = new GitReviewService();
    const snapshot = await service.snapshot(cwd, { mode: 'working' });
    const wire = JSON.stringify(snapshot);
    for (const secret of ['committed-secret', 'changed-secret', 'untracked-secret', 'BEGIN PRIVATE KEY']) {
      assert.ok(!wire.includes(secret), `${secret} stays on the Host`);
    }
    const tracked = snapshot.files.find((file) => file.path === 'config/secrets.json');
    assert.deepEqual([tracked?.private, tracked?.additions, tracked?.deletions, tracked?.hunks.length], [true, 1, 1, 0]);
    const untracked = snapshot.files.filter((file) => file.private && file.status === 'untracked').map((file) => file.path).sort();
    assert.deepEqual(untracked, ['.env', 'server.pem']);
    const selected = await service.snapshot(cwd, { mode: 'working', path: 'config/secrets.json' });
    assert.ok(!JSON.stringify(selected).includes('secret"'));
    const project = await service.snapshot(cwd, { mode: 'files', path: 'config/secrets.json' });
    assert.ok(!JSON.stringify(project).includes('committed-secret'));
    assert.equal(project.files.find((file) => file.path === 'config/secrets.json')?.private, true);
    await assert.rejects(service.committedFile(realpathSync(cwd), 'config/secrets.json'), /Private configuration/);
    // A tracked directory replaced by a link to a private one: Git still lists
    // the old path, and reading it must not reach the private file behind it.
    mkdirSync(join(cwd, 'cfg'));
    writeFileSync(join(cwd, 'cfg', 'notes.txt'), 'public\n');
    git(cwd, 'add', 'cfg/notes.txt');
    git(cwd, 'commit', '-m', 'add notes');
    rmSync(join(cwd, 'cfg'), { recursive: true });
    mkdirSync(join(cwd, '.ssh'));
    writeFileSync(join(cwd, '.ssh', 'notes.txt'), 'linked-secret\n');
    symlinkSync('.ssh', join(cwd, 'cfg'));
    const opened = await service.snapshot(cwd, { mode: 'files', path: 'cfg/notes.txt' });
    assert.ok(!JSON.stringify(opened).includes('linked-secret'));
    assert.equal(opened.files.find((file) => file.path === 'cfg/notes.txt')?.private, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('"No newline at end of file" is a marker with no line numbers', async () => {
  const cwd = repository();
  try {
    writeFileSync(join(cwd, 'tracked.txt'), 'one\ntwo');
    const snapshot = await new GitReviewService().snapshot(cwd, { mode: 'working' });
    const lines = snapshot.files[0].hunks.flatMap((hunk) => hunk.lines);
    assert.deepEqual(lines.map((line) => [line.kind, line.oldLine, line.newLine, line.text]), [
      ['context', 1, 1, 'one'],
      ['delete', 2, undefined, 'two'],
      ['add', undefined, 2, 'two'],
      ['context', undefined, undefined, '\\ No newline at end of file'],
    ]);
    assert.deepEqual([snapshot.files[0].additions, snapshot.files[0].deletions], [1, 1]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
