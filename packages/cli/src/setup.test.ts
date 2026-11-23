import test from 'node:test';
import assert from 'node:assert/strict';
import { setupLAN, type SetupDependencies } from './setup.js';

test('join checks destination, provisions exact relay, and never returns the password', async () => {
  const calls: unknown[] = [];
  const deps: SetupDependencies = { local: async () => { throw Error('unexpected local mutation'); },
    remote: async (device, request) => {
      calls.push([device, request]);
      if (request.action === 'relay.ensure') return { address: '192.168.1.2', port: 7400, password: 'fixture-secret' };
      return { status: 'ready', hostId: 'host-a', password: 'fixture-secret' };
    } };
  const result = await setupLAN('join', { device: 'mac-b', relayDevice: 'mini-a' }, deps);
  assert.deepEqual(calls, [['mac-b', { action: 'status' }], ['mini-a', { action: 'relay.ensure', address: undefined, port: undefined }],
    ['mac-b', { action: 'sharing.join', address: '192.168.1.2', port: 7400, password: 'fixture-secret' }]]);
  assert.equal(result.hostId, 'host-a'); assert.doesNotMatch(JSON.stringify(result), /secret|password/);
});
test('unreachable destination never configures relay and existing service errors are propagated', async () => {
  const calls: string[] = [];
  const deps: SetupDependencies = { local: async () => ({}), remote: async device => { calls.push(device); throw Error('permission denied'); } };
  await assert.rejects(setupLAN('join', { device: 'mac-b', relayDevice: 'mini-a' }, deps), /permission denied/);
  assert.deepEqual(calls, ['mac-b']);
  await assert.rejects(setupLAN('connect', { device: 'mac-b', relayDevice: 'mini-a' }, deps), /本机/);
});
test('connect persists CLI configuration only after App accepts; status output is whitelisted', async () => {
  let saved = false;
  const deps: SetupDependencies = { local: async request => request.action === 'status' ? { relay: 'ready', password: 'hidden' } : { status: 'configured' },
    remote: async () => { throw Error('unused'); }, saveConnection: endpoint => { assert.equal(endpoint.password, 'fixture'); saved = true; } };
  assert.doesNotMatch(JSON.stringify(await setupLAN('status', {}, deps)), /hidden|password/);
  assert.equal((await setupLAN('connect', { address: '192.168.1.2', password: 'fixture' }, deps)).status, 'configured');
  assert.equal(saved, true);
  deps.saveConnection = () => { throw Error('disk full'); };
  await assert.rejects(setupLAN('connect', { address: '192.168.1.2', password: 'fixture' }, deps), /App 连接已保存/);
});
