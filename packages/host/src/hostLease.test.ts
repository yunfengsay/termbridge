import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireHostLease, hostLeasePath } from './hostLease.js';

test('lease paths isolate different Host identities sharing a test environment', () => {
  assert.notEqual(hostLeasePath('/tmp/host.sock', 'host-a'), hostLeasePath('/tmp/host.sock', 'host-b'));
  assert.equal(hostLeasePath('/tmp/host.sock', 'host-a'), hostLeasePath('/tmp/host.sock', 'host-a'));
});

test('host lease blocks a second live owner and releases only its own file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'termbridge-host-lease-'));
  const path = join(dir, 'host.sock.pid');
  try {
    const lease = acquireHostLease(path, 111, (pid) => pid === 111);
    assert.equal(readFileSync(path, 'utf8'), '111\n');
    assert.throws(() => acquireHostLease(path, 222, (pid) => pid === 111), /already running.*111/);
    lease.release();
    const next = acquireHostLease(path, 222, () => false);
    next.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host lease replaces a stale owner but preserves a newer owner on release', () => {
  const dir = mkdtempSync(join(tmpdir(), 'termbridge-host-lease-'));
  const path = join(dir, 'host.sock.pid');
  try {
    writeFileSync(path, '333\n');
    const lease = acquireHostLease(path, 444, () => false);
    writeFileSync(path, '555\n');
    lease.release();
    assert.equal(readFileSync(path, 'utf8'), '555\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
