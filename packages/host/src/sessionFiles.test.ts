import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitReviewService } from '@termbridge/review';
import { readSessionFile, readSessionRevision, listSessionDirectory, stripFileLocationSuffix, FILE_CHUNK_BYTES, FILE_MAX_BYTES } from './sessionFiles.js';

test('file preview streams exact chunks and rejects changed files, escapes and credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tb-preview-'));
  try {
    const cwd = join(root, 'workspace'); await mkdir(cwd);
    const bytes = Buffer.alloc(FILE_CHUNK_BYTES + 17, 73); const path = join(cwd, '中文 image.png');
    await writeFile(path, bytes);
    const first = await readSessionFile(cwd, { path, offset: 0 }, []);
    const last = await readSessionFile(cwd, { path: '中文 image.png', offset: first.data.length, version: first.version }, []);
    assert.equal(first.eof, false); assert.equal(last.eof, true);
    assert.deepEqual(Buffer.concat([first.data, last.data]), bytes);
    await assert.rejects(readSessionFile(cwd, { path, offset: 1 }, []), /changed/);
    await writeFile(path, 'changed');
    await assert.rejects(readSessionFile(cwd, { path, offset: 0, version: first.version }, []), /changed/);
    await writeFile(join(root, 'outside.txt'), 'outside');
    await symlink(join(root, 'outside.txt'), join(cwd, 'escape.txt'));
    for (const path of ['../outside.txt', 'escape.txt']) await assert.rejects(readSessionFile(cwd, { path, offset: 0 }, []), /outside/);
    await writeFile(join(cwd, '.env'), 'secret');
    await symlink(join(cwd, '.env'), join(cwd, 'innocent.txt'));
    for (const path of ['.env', 'innocent.txt']) await assert.rejects(readSessionFile(cwd, { path, offset: 0 }, []), /Private/);
    await assert.rejects(readSessionFile(cwd, { path: '.', offset: 0 }, []), /regular/);
    await writeFile(join(cwd, 'huge.txt'), Buffer.alloc(FILE_MAX_BYTES + 1));
    await assert.rejects(readSessionFile(cwd, { path: 'huge.txt', offset: 0 }, []), /limit/);
    const listing = await listSessionDirectory(cwd, '.', []);
    assert.equal(listing.entries.some(entry => entry.name === '.env' || entry.name === 'escape.txt'), false);
    assert.equal(listing.entries.some(entry => entry.name === '中文 image.png'), true);
    await assert.rejects(listSessionDirectory(cwd, '..', []), /outside/);
    await writeFile(join(cwd, 'empty.txt'), '');
    assert.equal((await readSessionFile(cwd, { path: 'empty.txt', offset: 0 }, [])).eof, true);
    assert.equal((await readSessionFile(cwd, { path: '../outside.txt', offset: 0 }, [root])).data.toString(), 'outside');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('committed versions stream from HEAD, also for deleted files, and restart when HEAD moves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tb-preview-head-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  const cwd = join(root, 'repo');
  try {
    await mkdir(join(cwd, 'art'), { recursive: true });
    git('init', '-b', 'main'); git('config', 'user.email', 't@t.local'); git('config', 'user.name', 'T');
    const original = Buffer.alloc(FILE_CHUNK_BYTES + 9, 7); original[0] = 0x89;
    await writeFile(join(cwd, 'art', 'logo.png'), original);
    await writeFile(join(cwd, 'gone.txt'), 'was here\n');
    git('add', '.'); git('commit', '-m', 'base');
    await writeFile(join(cwd, 'art', 'logo.png'), 'replaced');
    await rm(join(cwd, 'gone.txt'));

    const review = new GitReviewService();
    const first = await readSessionRevision(cwd, { path: 'art/logo.png', offset: 0 }, review, []);
    const last = await readSessionRevision(cwd, { path: join(cwd, 'art', 'logo.png'), offset: first.data.length, version: first.version }, review, []);
    assert.equal(first.eof, false); assert.equal(last.eof, true);
    assert.deepEqual(Buffer.concat([first.data, last.data]), original, 'the committed bytes, not the working copy');
    assert.match(first.version, /^HEAD:[0-9a-f]{40,64}$/);
    assert.equal((await readSessionRevision(cwd, { path: 'gone.txt', offset: 0 }, review, [])).data.toString(), 'was here\n');
    await writeFile(join(root, 'outside.txt'), 'x');
    await assert.rejects(readSessionRevision(cwd, { path: '../outside.txt', offset: 0 }, review, []), /not inside a Git repository|outside/);
    await assert.rejects(readSessionRevision(cwd, { path: '.env', offset: 0 }, review, []), /Private/);
    git('commit', '-am', 'moved on');
    await assert.rejects(readSessionRevision(cwd, { path: 'art/logo.png', offset: first.data.length, version: first.version }, review, []), /changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file preview strips line/range locators and resolves shortened relative paths inside workspace', async () => {
  assert.equal(stripFileLocationSuffix('timeline.css:42'), 'timeline.css');
  assert.equal(stripFileLocationSuffix('timeline.css:42:5-68:12'), 'timeline.css');
  assert.equal(stripFileLocationSuffix('/repo/a.ts:10-20'), '/repo/a.ts');
  assert.equal(stripFileLocationSuffix('design-system/timeline.css#L12-L34'), 'design-system/timeline.css');

  const root = await mkdtemp(join(tmpdir(), 'tb-preview-loc-'));
  try {
    const cwd = join(root, 'workspace');
    await mkdir(join(cwd, 'design-system', 'app', 'features', 'timeline'), { recursive: true });
    await writeFile(join(cwd, 'design-system', 'app', 'features', 'timeline', 'timeline.css'), '.timeline { color: red; }\n');
    await writeFile(join(cwd, '.env'), 'SECRET=1\n');

    const byRange = await readSessionFile(cwd, { path: 'design-system/app/features/timeline/timeline.css:1-10', offset: 0 }, []);
    assert.equal(byRange.name, 'timeline.css');
    assert.equal(byRange.data.toString(), '.timeline { color: red; }\n');

    const byBasename = await readSessionFile(cwd, { path: 'timeline.css:1:4', offset: 0 }, []);
    assert.equal(byBasename.name, 'timeline.css');
    assert.equal(byBasename.data.toString(), '.timeline { color: red; }\n');

    const byShortRel = await readSessionFile(cwd, { path: 'features/timeline/timeline.css#L1-L2', offset: 0 }, []);
    assert.equal(byShortRel.name, 'timeline.css');

    await assert.rejects(readSessionFile(cwd, { path: '.env:1', offset: 0 }, []), /Private/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('safe home path preview allows explicit non-hidden home files while blocking dotfiles, Library, private files and escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tb-preview-home-'));
  try {
    const home = join(root, 'home');
    const cwd = join(home, 'code', 'app');
    await mkdir(cwd, { recursive: true });
    await mkdir(join(home, 'canvas-private', 'artifacts'), { recursive: true });
    await mkdir(join(home, '.ssh'), { recursive: true });
    await mkdir(join(home, '.config', 'app'), { recursive: true });
    await mkdir(join(home, 'Library', 'Keychains'), { recursive: true });

    const artifact = join(home, 'canvas-private', 'artifacts', 'tdesktop-phase2-qa.png');
    await writeFile(artifact, 'PNGDATA');
    await writeFile(join(home, 'canvas-private', 'secrets.json'), '{}');
    await writeFile(join(home, 'canvas-private', 'dev.key'), 'KEY');
    await writeFile(join(home, '.ssh', 'id_rsa'), 'PRIVATE');
    await writeFile(join(home, '.config', 'app', 'token.json'), '{}');
    await writeFile(join(home, 'Library', 'Keychains', 'login.keychain'), 'KC');
    await writeFile(join(home, 'sibling.txt'), 'sibling');
    await writeFile(join(root, 'etc-like.txt'), 'outside-home');
    await symlink(join(home, 'sibling.txt'), join(cwd, 'escape.txt'));

    const opts = { allowSafeHomePaths: true, homeDir: home };
    const fromTilde = await readSessionFile(cwd, { path: '~/canvas-private/artifacts/tdesktop-phase2-qa.png', offset: 0 }, [], opts);
    assert.equal(fromTilde.name, 'tdesktop-phase2-qa.png');
    assert.equal(fromTilde.data.toString(), 'PNGDATA');

    const fromAbs = await readSessionFile(cwd, { path: artifact, offset: 0 }, [], opts);
    assert.equal(fromAbs.data.toString(), 'PNGDATA');

    // Relative traversal and symlink escapes must still be rejected.
    await assert.rejects(readSessionFile(cwd, { path: '../../sibling.txt', offset: 0 }, [], opts), /outside/);
    await assert.rejects(readSessionFile(cwd, { path: 'escape.txt', offset: 0 }, [], opts), /outside/);

    // Dotfiles, Library, private files, and paths outside home must remain blocked.
    await assert.rejects(readSessionFile(cwd, { path: '~/.ssh/id_rsa', offset: 0 }, [], opts), /Private|outside/);
    await assert.rejects(readSessionFile(cwd, { path: '~/.config/app/token.json', offset: 0 }, [], opts), /outside/);
    await assert.rejects(readSessionFile(cwd, { path: '~/Library/Keychains/login.keychain', offset: 0 }, [], opts), /outside/);
    await assert.rejects(readSessionFile(cwd, { path: '~/canvas-private/secrets.json', offset: 0 }, [], opts), /Private/);
    await assert.rejects(readSessionFile(cwd, { path: '~/canvas-private/dev.key', offset: 0 }, [], opts), /Private/);
    await assert.rejects(readSessionFile(cwd, { path: join(root, 'etc-like.txt'), offset: 0 }, [], opts), /outside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
