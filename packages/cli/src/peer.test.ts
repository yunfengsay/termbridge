import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePeerBridgeTarget } from './peer.js';

test('native app tools use the owner-only host bridge without a terminal session', () => {
  const target = resolvePeerBridgeTarget('android.install_apk', {});
  assert.equal(target.session, 'app');
  assert.match(target.sock ?? '', /\.termbridge\/host\.sock$/);
});

test('selected phone photos use the same owner-only app bridge', () => {
  const target = resolvePeerBridgeTarget('phone.asset.read', {});
  assert.equal(target.session, 'app');
  assert.match(target.sock ?? '', /\.termbridge\/host\.sock$/);
  assert.equal(resolvePeerBridgeTarget('phone.photo.publish.commit', {}).session, 'app');
});

test('phone action status recovery uses the owner-only app bridge', () => {
  assert.equal(resolvePeerBridgeTarget('phone.action.status', {}).session, 'app');
});

test('desktop shell access still requires an injected session identity', () => {
  assert.deepEqual(resolvePeerBridgeTarget('exec', {}), { sock: undefined, session: undefined });
});

test('discovery works outside a terminal; Herdr desktop calls carry the exact pane identity', () => {
  assert.equal(resolvePeerBridgeTarget('peer.list', {}).session, 'app');
  assert.equal(resolvePeerBridgeTarget('exec', { HERDR_PANE_ID: 'wA:p1' }).session, 'herdr:wA:p1');
});

test('an injected session remains authoritative', () => {
  assert.deepEqual(
    resolvePeerBridgeTarget('info', { TB_BRIDGE_SOCK: '/tmp/bridge.sock', TB_SESSION: 'session-7' }),
    { sock: '/tmp/bridge.sock', session: 'session-7' },
  );
});
