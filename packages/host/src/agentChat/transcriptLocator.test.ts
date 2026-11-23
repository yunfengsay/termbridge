import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectSlug, codexDaysOf, isLocated, locateTranscript, type LocateResult } from './transcriptLocator.js';

const pendingOf = (result: LocateResult) => (isLocated(result) ? undefined : result.pending);

// Synthetic transcripts only; no real conversation content is checked in.
const claudeRecords = (sessionId: string) => [
  JSON.stringify({ type: 'mode', mode: 'normal', sessionId }),
  JSON.stringify({ type: 'user', uuid: 'u1', sessionId, message: { role: 'user', content: '你好' } }),
].join('\n') + '\n';

const codexRecords = (sessionId: string) => [
  JSON.stringify({ timestamp: '2026-09-14T00:00:00.000Z', type: 'session_meta', payload: { session_id: sessionId, cwd: '/w' } }),
].join('\n') + '\n';

async function claudeHome(sessionId: string, cwd: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'tb-chat-home-'));
  const dir = join(home, '.claude', 'projects', claudeProjectSlug(cwd));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${sessionId}.jsonl`), claudeRecords(sessionId));
  return home;
}

test('Herdr’s own path reference wins, and a mismatched file is refused', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tb-chat-ref-'));
  try {
    const path = join(home, 'named.jsonl');
    await writeFile(path, claudeRecords('11111111-1111-4111-8111-111111111111'));
    const ok = await locateTranscript({
      provider: 'claude', providerSessionId: '11111111-1111-4111-8111-111111111111',
      sessionRef: { kind: 'path', value: path }, home,
    });
    assert.equal(isLocated(ok) && ok.path, path);

    const wrong = await locateTranscript({
      provider: 'claude', providerSessionId: '22222222-2222-4222-8222-222222222222',
      sessionRef: { kind: 'path', value: path }, home,
    });
    assert.equal(isLocated(wrong), false);
    assert.match((wrong as { reason: string }).reason, /不一致/);
    // A contradiction is final; waiting would not make that file this session's.
    assert.equal(pendingOf(wrong), undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a record that is not written yet is pending, not refused', async () => {
  const sessionId = '12121212-1212-4121-8121-121212121212';
  const home = await mkdtemp(join(tmpdir(), 'tb-chat-unwritten-'));
  try {
    // Named by Herdr but not created: an Agent writes its record lazily.
    const named = join(home, 'named.jsonl');
    const absent = await locateTranscript({ provider: 'claude', providerSessionId: sessionId, sessionRef: { kind: 'path', value: named }, home });
    assert.equal(pendingOf(absent), true);

    // Created but caught before its first record is complete.
    await writeFile(named, '');
    assert.equal(pendingOf(await locateTranscript({ provider: 'claude', providerSessionId: sessionId, sessionRef: { kind: 'path', value: named }, home })), true);
    await writeFile(named, claudeRecords(sessionId).slice(0, 20));
    assert.equal(pendingOf(await locateTranscript({ provider: 'claude', providerSessionId: sessionId, sessionRef: { kind: 'path', value: named }, home })), true);
    // And found the moment it is.
    await writeFile(named, claudeRecords(sessionId));
    const written = await locateTranscript({ provider: 'claude', providerSessionId: sessionId, sessionRef: { kind: 'path', value: named }, home });
    assert.equal(isLocated(written) && written.path, named);

    // Derived paths behave the same for both providers.
    for (const provider of ['claude', 'codex'] as const) {
      const derived = await locateTranscript({ provider, providerSessionId: '34343434-3434-4343-8343-343434343434', cwd: '/w', home });
      assert.equal(pendingOf(derived), true);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a derived Claude path is accepted only when the file claims the same session', async () => {
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const home = await claudeHome(sessionId, '/Users/tester/code/demo');
  try {
    const found = await locateTranscript({
      provider: 'claude', providerSessionId: sessionId,
      sessionRef: { kind: 'id', value: sessionId }, cwd: '/Users/tester/code/demo', home,
    });
    assert.equal(isLocated(found), true);

    // A same-named file whose records belong to another session is not it.
    const impostorDir = join(home, '.claude', 'projects', 'other');
    await mkdir(impostorDir, { recursive: true });
    const otherId = '44444444-4444-4444-8444-444444444444';
    await writeFile(join(impostorDir, `${otherId}.jsonl`), claudeRecords('55555555-5555-4555-8555-555555555555'));
    const refused = await locateTranscript({ provider: 'claude', providerSessionId: otherId, home });
    assert.equal(isLocated(refused), false);
    assert.equal(pendingOf(refused), undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a newer unrelated transcript is never substituted for a missing one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tb-chat-guess-'));
  try {
    const dir = join(home, '.codex', 'sessions', '2026', '09', '14');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'rollout-2026-09-14T10-00-00-01a00000-0000-7000-8000-000000000001.jsonl'),
      codexRecords('01a00000-0000-7000-8000-000000000001'));
    const missing = await locateTranscript({
      provider: 'codex', providerSessionId: '01a00000-0000-7000-8000-000000000002', home,
    });
    assert.equal(isLocated(missing), false);
    assert.match((missing as { reason: string }).reason, /没有找到/);

    const found = await locateTranscript({
      provider: 'codex', providerSessionId: '01a00000-0000-7000-8000-000000000001', home,
    });
    assert.equal(isLocated(found), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a time-ordered Codex id is found under its own day, beyond the walk’s reach', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tb-chat-v7-'));
  try {
    // A v7 id carries its creation time in its first 48 bits.
    const created = new Date(2026, 7, 3, 11, 14, 25);
    const hex = created.getTime().toString(16).padStart(12, '0');
    const sessionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000042`;
    assert.deepEqual(codexDaysOf(sessionId)[0], ['2026', '08', '03']);
    assert.deepEqual(codexDaysOf('33333333-3333-4333-8333-333333333333'), []);

    // A month of later sessions puts that day past the walk's bound, which is
    // exactly where a resumed session from weeks ago lives.
    for (let day = 10; day <= 31; day += 1) {
      await mkdir(join(home, '.codex', 'sessions', '2026', '08', String(day)), { recursive: true });
    }
    const dir = join(home, '.codex', 'sessions', '2026', '08', '03');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `rollout-2026-08-03T11-14-25-${sessionId}.jsonl`);
    await writeFile(path, codexRecords(sessionId));
    const found = await locateTranscript({ provider: 'codex', providerSessionId: sessionId, home });
    assert.equal(isLocated(found) && found.path, path);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an absent or unsafe session identity is refused before any filesystem walk', async () => {
  for (const providerSessionId of ['', '../../etc/passwd', 'not-an-id']) {
    const result = await locateTranscript({ provider: 'claude', providerSessionId, home: '/nonexistent' });
    assert.equal(isLocated(result), false);
    // An identity that cannot be one never becomes one by waiting.
    assert.equal(pendingOf(result), undefined);
  }
  const missingHome = await locateTranscript({
    provider: 'claude', providerSessionId: '66666666-6666-4666-8666-666666666666', home: '/nonexistent',
  });
  assert.equal(isLocated(missingHome), false);
});
