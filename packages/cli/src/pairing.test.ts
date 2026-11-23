import assert from 'node:assert/strict';
import test from 'node:test';
import {
  officialConnectionCode,
  officialPairing,
  pairingCode,
  pairingUri,
  parsePairing,
  roomIdForSecret,
  validatePairingSecret,
} from './pairing.js';

const SECRET = 'MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3BxcnN0dXY';
const PIN = 'b'.repeat(64);
const HOSTED_RELAY = 'wss://relay.example.test';

test('official pairing derives a stable isolated room when hosted relay is configured', () => {
  const payload = officialPairing(SECRET, HOSTED_RELAY);
  assert.match(payload.relayUrl, new RegExp(`^${HOSTED_RELAY.replace(/\./g, '\\.')}/r/${roomIdForSecret(SECRET)}$`));
  assert.deepEqual(parsePairing(pairingCode(SECRET), HOSTED_RELAY), payload);
  assert.throws(() => officialPairing(SECRET, undefined), /No hosted Cloudflare relay is configured/);
  assert.throws(() => parsePairing(pairingCode(SECRET), undefined), /No hosted Cloudflare relay is configured/);
});

test('pairing QR payload round-trips relay and secret', () => {
  const payload = { ...officialPairing(SECRET, HOSTED_RELAY), hostId: 'mac-1234', hostName: 'Home Mac', tlsPin: PIN };
  assert.deepEqual(parsePairing(pairingUri(payload)), payload);
});

test('pairing rejects insecure relays and malformed keys', () => {
  assert.throws(() => parsePairing('termbridge://pair?v=1&relay=ws%3A%2F%2Flocalhost&secret=short'), /secure|256-bit/);
  assert.throws(() => parsePairing('tb1_short', HOSTED_RELAY), /valid Termbridge key/);
  assert.throws(
    () =>
      parsePairing(
        `termbridge://pair?v=1&relay=wss%3A%2F%2Frelay.example&secret=${SECRET}&pin=deadbeef`,
      ),
    /fingerprint/,
  );
});

test('compact connection codes are only emitted for the matching configured hosted room', () => {
  const official = officialPairing(SECRET, HOSTED_RELAY);
  assert.equal(officialConnectionCode(official, HOSTED_RELAY), pairingCode(SECRET));
  assert.equal(officialConnectionCode(official, undefined), undefined);
  assert.equal(
    officialConnectionCode({
      relayUrl: 'wss://relay.example:8001',
      secret: SECRET,
      tlsPin: PIN,
    }, HOSTED_RELAY),
    undefined,
  );
});

test('shared pairing secrets use one cross-platform length policy', () => {
  assert.throws(() => validatePairingSecret(''), /1 to 256/);
  assert.doesNotThrow(() => validatePairingSecret('2468'));
  assert.doesNotThrow(() => validatePairingSecret('a'));
  assert.doesNotThrow(() => validatePairingSecret('a'.repeat(256)));
  assert.throws(() => validatePairingSecret('a'.repeat(257)), /1 to 256/);
});

test('custom pairing preserves explicit transport without inferring it from an IP', () => {
  for (const mode of ['relay', 'direct'] as const) {
    const payload = { relayUrl: 'wss://203.0.113.8:8001', secret: '2468', mode };
    assert.deepEqual(parsePairing(pairingUri(payload)), payload);
  }
  assert.throws(() => parsePairing('termbridge://pair?v=1&relay=wss%3A%2F%2Frelay.example&secret=2468&mode=unknown'), /mode/);
});

test('password-only LAN pairing round trips without a certificate', () => {
  const payload = { relayUrl: 'ws://30.20.30.40:7400', secret: '2468', hostId: 'mac-lan', mode: 'direct' as const };
  const code = pairingUri(payload);
  assert.deepEqual(parsePairing(code), payload);
  assert.equal(new URL(code).searchParams.has('pin'), false);
  for (const mode of [undefined, 'relay'] as const) {
    assert.throws(() => pairingUri({ ...payload, mode }), /secure/);
  }
  assert.throws(() => pairingUri({ ...payload, tlsPin: PIN }), /fingerprint/);
});
