import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { ControlMessageSchema } from '@termbridge/protocol';
import { desktopPeerRegistration, resolvePeerDeviceId } from './peerIdentity.js';

test('CLI device identity is persistent, private, random and separate from Host identity', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-peer-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'peer-id');
  const id = resolvePeerDeviceId(file);
  assert.match(id, /^cli-[0-9a-f-]{36}$/);
  assert.equal(resolvePeerDeviceId(file), id);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.notEqual(resolvePeerDeviceId(join(dir, 'other-peer')), id);
  assert.equal(ControlMessageSchema.safeParse(desktopPeerRegistration(id)).success, true);
  writeFileSync(file, 'invalid-identity');
  assert.throws(() => resolvePeerDeviceId(file), /Invalid CLI peer-id/);
  assert.equal(readFileSync(file, 'utf8'), 'invalid-identity');
});

test('simultaneous CLI first starts use one fully written installation identity', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-peer-race-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = `import { resolvePeerDeviceId } from ${JSON.stringify(new URL('./peerIdentity.ts', import.meta.url).href)}; console.log(resolvePeerDeviceId(process.argv[1]));`;
  const ids = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, join(dir, 'peer-id')]);
    let out = ''; let err = '';
    child.stdout.on('data', (data) => out += data);
    child.stderr.on('data', (data) => err += data);
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err)));
  })));
  assert.equal(new Set(ids).size, 1);
  assert.match(ids[0], /^cli-[0-9a-f-]{36}$/);
});
