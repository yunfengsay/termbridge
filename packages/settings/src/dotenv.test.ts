import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadLocalEnv, parseDotEnv } from './dotenv.js';

test('parseDotEnv handles export, quotes, escapes, and inline comments', () => {
  const parsed = parseDotEnv(`
    # comment
    PLAIN=hello # trailing comment
    export EXPORTED=world
    SINGLE='keep # literal \\n'
    DOUBLE="line1\\nline2\\"ok\\""
    EMPTY=
    123INVALID=ignored
  `);
  assert.deepEqual(parsed, {
    PLAIN: 'hello',
    EXPORTED: 'world',
    SINGLE: 'keep # literal \\n',
    DOUBLE: 'line1\nline2"ok"',
    EMPTY: '',
  });
});

test('loadLocalEnv respects precedence: process.env > .env.local > .env > ~/.termbridge/.env', () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-dotenv-'));
  const cwd = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, '.termbridge'), { recursive: true });

  writeFileSync(join(home, '.termbridge', '.env'), 'A=home\nB=home\nC=home\nD=home\n');
  writeFileSync(join(cwd, '.env'), 'B=repo\nC=repo\nD=repo\n');
  writeFileSync(join(cwd, '.env.local'), 'C=local\nD=local\n');

  const env: NodeJS.ProcessEnv = { D: 'shell', EXPLICIT_EMPTY: '' };
  writeFileSync(join(cwd, '.env'), 'B=repo\nC=repo\nD=repo\nEXPLICIT_EMPTY=should-not-override\n');

  const loaded = loadLocalEnv({ cwd, home, env });
  assert.equal(loaded.length, 3);
  assert.equal(env.A, 'home');
  assert.equal(env.B, 'repo');
  assert.equal(env.C, 'local');
  assert.equal(env.D, 'shell');
  assert.equal(env.EXPLICIT_EMPTY, '');
});

test('loadLocalEnv skips automatically in isolated test environments unless explicitly enabled', () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-dotenv-isolated-'));
  const cwd = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, '.env'), 'TB_CLOUDFLARE_RELAY=wss://local.example.test\n');

  const isolatedEnv: NodeJS.ProcessEnv = { TB_SETTINGS: join(root, 'settings.json') };
  assert.deepEqual(loadLocalEnv({ cwd, home, env: isolatedEnv }), []);
  assert.equal(isolatedEnv.TB_CLOUDFLARE_RELAY, undefined);

  const disabledEnv: NodeJS.ProcessEnv = { TB_NO_DOTENV: '1' };
  assert.deepEqual(loadLocalEnv({ cwd, home, env: disabledEnv }), []);
  assert.equal(disabledEnv.TB_CLOUDFLARE_RELAY, undefined);

  const optedInEnv: NodeJS.ProcessEnv = { TB_SETTINGS: join(root, 'settings.json'), TB_LOAD_DOTENV: '1' };
  assert.equal(loadLocalEnv({ cwd, home, env: optedInEnv }).length, 1);
  assert.equal(optedInEnv.TB_CLOUDFLARE_RELAY, 'wss://local.example.test');
});
