import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  getNetworkPolicy,
  getVolcengineVoiceCredentials,
  hasProxyForUrl,
  relayWsOptions,
  setNetworkPolicy,
  setVolcengineVoiceCredentials,
} from './index.js';

test('network policy is persisted and direct ignores application proxy variables', () => {
  const directory = mkdtempSync(join(tmpdir(), 'termbridge-network-policy-'));
  const previous = {
    settings: process.env.TB_SETTINGS,
    httpsProxy: process.env.HTTPS_PROXY,
    httpsProxyLower: process.env.https_proxy,
    noProxy: process.env.NO_PROXY,
    noProxyLower: process.env.no_proxy,
  };
  process.env.TB_SETTINGS = join(directory, 'settings.json');
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
  delete process.env.https_proxy;
  process.env.NO_PROXY = '';
  delete process.env.no_proxy;

  try {
    assert.equal(getNetworkPolicy(), 'system');
    assert.equal(hasProxyForUrl('wss://relay.example/r/test'), true);
    assert.ok(relayWsOptions('wss://relay.example/r/test').agent);

    setNetworkPolicy('direct');
    assert.equal(getNetworkPolicy(), 'direct');
    assert.equal(relayWsOptions('wss://relay.example/r/test').agent, undefined);

    setNetworkPolicy('system');
    assert.equal(getNetworkPolicy(), 'system');
    assert.ok(relayWsOptions('wss://relay.example/r/test').agent);
  } finally {
    restoreEnv('TB_SETTINGS', previous.settings);
    restoreEnv('HTTPS_PROXY', previous.httpsProxy);
    restoreEnv('https_proxy', previous.httpsProxyLower);
    restoreEnv('NO_PROXY', previous.noProxy);
    restoreEnv('no_proxy', previous.noProxyLower);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('host-only Volcengine voice credentials persist in the owner settings file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'termbridge-voice-credentials-'));
  const previous = process.env.TB_SETTINGS;
  process.env.TB_SETTINGS = join(directory, 'settings.json');
  try {
    assert.equal(getVolcengineVoiceCredentials(), undefined);
    setVolcengineVoiceCredentials({
      apiKey: 'speech-api-key',
      appId: 'app-id',
      accessToken: 'private-token',
    });
    assert.deepEqual(getVolcengineVoiceCredentials(), {
      apiKey: 'speech-api-key',
      appId: 'app-id',
      accessToken: 'private-token',
    });
    setVolcengineVoiceCredentials(undefined);
    assert.equal(getVolcengineVoiceCredentials(), undefined);
  } finally {
    restoreEnv('TB_SETTINGS', previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}
