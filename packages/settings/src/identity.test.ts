import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveMacHostId, resolveStableHostId } from './identity.js';

const macInterfaces = {
  utun0: [{ internal: false, mac: 'de:ad:be:ef:00:02' }],
  en0: [{ internal: false, mac: 'aa:bb:cc:dd:ee:ff' }],
  lo0: [{ internal: true, mac: '00:00:00:00:00:00' }],
};

test('derives an opaque stable host id from the primary physical MAC', () => {
  const first = deriveMacHostId(macInterfaces as never);
  const second = deriveMacHostId({ ...macInterfaces, bridge0: [{ internal: false, mac: 'de:ad:be:ef:00:03' }] } as never);
  assert.match(first ?? '', /^mac-[a-f0-9]{16}$/);
  assert.equal(second, first);
  assert.doesNotMatch(first ?? '', /aabbccddeeff/i);
});

test('persists the derived id and honors an explicit HOST_ID override', () => {
  const directory = mkdtempSync(join(tmpdir(), 'termbridge-host-id-'));
  const file = join(directory, 'host-id');
  try {
    const first = resolveStableHostId({}, macInterfaces as never, file);
    const afterAdapterChange = resolveStableHostId({}, { en0: [{ internal: false, mac: '11:22:33:44:55:66' }] } as never, file);
    assert.equal(afterAdapterChange, first);
    assert.equal(readFileSync(file, 'utf8').trim(), first);
    assert.equal(resolveStableHostId({ HOST_ID: 'office-mac' }, macInterfaces as never, file), 'office-mac');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
