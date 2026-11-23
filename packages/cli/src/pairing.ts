import { createHash, randomBytes } from 'node:crypto';

export const PAIRING_CODE_PREFIX = 'tb1_';
export const HOSTED_CLOUDFLARE_RELAY_ENV = 'TB_CLOUDFLARE_RELAY';

export interface PairingPayload {
  relayUrl: string;
  secret: string;
  hostId?: string;
  hostName?: string;
  tlsPin?: string;
  mode?: 'relay' | 'direct';
}

export function hostedCloudflareRelay(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[HOSTED_CLOUDFLARE_RELAY_ENV]?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${HOSTED_CLOUDFLARE_RELAY_ENV} must be a valid wss:// relay URL`);
  }
  if (parsed.protocol !== 'wss:' || !parsed.hostname) {
    throw new Error(`${HOSTED_CLOUDFLARE_RELAY_ENV} must use wss://`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

function requireHostedRelay(relayBase = hostedCloudflareRelay()): string {
  if (!relayBase) {
    throw new Error(
      'No hosted Cloudflare relay is configured. Deploy your own with "tb cloudflare deploy", ' +
        'configure a relay with "tb middle set <url>" + "tb secret set", ' +
        `or set ${HOSTED_CLOUDFLARE_RELAY_ENV}=wss://<your-worker>.workers.dev.`,
    );
  }
  return relayBase.replace(/\/+$/, '');
}

function validOfficialSecret(secret: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return false;
  return Buffer.from(secret, 'base64url').byteLength === 32;
}

export function roomIdForSecret(secret: string): string {
  if (!validOfficialSecret(secret)) throw new Error('The pairing code is not a valid Termbridge key');
  return createHash('sha256').update(secret).digest('hex');
}

export function officialPairing(
  secret = randomBytes(32).toString('base64url'),
  relayBase = hostedCloudflareRelay(),
): PairingPayload {
  const base = requireHostedRelay(relayBase);
  return {
    relayUrl: `${base}/r/${roomIdForSecret(secret)}`,
    secret,
  };
}

export function pairingCode(secret: string): string {
  roomIdForSecret(secret);
  return `${PAIRING_CODE_PREFIX}${secret}`;
}

export function validatePairingSecret(secret: string): void {
  if (secret.length < 1 || secret.length > 256) {
    throw new Error('The pairing key must contain 1 to 256 characters');
  }
}

export function officialConnectionCode(
  payload: PairingPayload,
  relayBase = hostedCloudflareRelay(),
): string | undefined {
  if (!relayBase) return undefined;
  try {
    const expected = new URL(officialPairing(payload.secret, relayBase).relayUrl).toString();
    const actual = new URL(payload.relayUrl).toString();
    return actual === expected ? pairingCode(payload.secret) : undefined;
  } catch {
    return undefined;
  }
}

export function pairingUri(payload: PairingPayload): string {
  validatePairingPayload(payload);
  const uri = new URL('termbridge://pair');
  uri.searchParams.set('v', '1');
  uri.searchParams.set('relay', payload.relayUrl);
  uri.searchParams.set('secret', payload.secret);
  if (payload.hostId) uri.searchParams.set('host', payload.hostId);
  if (payload.hostName) uri.searchParams.set('name', payload.hostName);
  if (payload.tlsPin) uri.searchParams.set('pin', payload.tlsPin.toLowerCase());
  if (payload.mode) uri.searchParams.set('mode', payload.mode);
  return uri.toString();
}

export function parsePairing(value: string, relayBase = hostedCloudflareRelay()): PairingPayload {
  const trimmed = value.trim();
  if (trimmed.startsWith(PAIRING_CODE_PREFIX)) {
    return officialPairing(trimmed.slice(PAIRING_CODE_PREFIX.length), relayBase);
  }

  let uri: URL;
  try {
    uri = new URL(trimmed);
  } catch {
    throw new Error('Expected a tb1_ connection code or termbridge://pair QR payload');
  }
  if (uri.protocol !== 'termbridge:' || uri.hostname !== 'pair' || uri.searchParams.get('v') !== '1') {
    throw new Error('Unsupported Termbridge pairing payload');
  }
  const payload: PairingPayload = {
    relayUrl: uri.searchParams.get('relay') || '',
    secret: uri.searchParams.get('secret') || '',
  };
  const hostId = uri.searchParams.get('host');
  const hostName = uri.searchParams.get('name');
  const tlsPin = uri.searchParams.get('pin');
  const mode = uri.searchParams.get('mode');
  if (mode !== null && mode !== 'relay' && mode !== 'direct') throw new Error('Invalid connection mode');
  if (mode) payload.mode = mode;
  if (hostId) payload.hostId = hostId;
  if (hostName) payload.hostName = hostName;
  if (tlsPin) payload.tlsPin = tlsPin.toLowerCase();
  validatePairingPayload(payload);
  return payload;
}

function validatePairingPayload(payload: PairingPayload): void {
  let relay: URL;
  try {
    relay = new URL(payload.relayUrl);
  } catch {
    throw new Error('The pairing relay URL is invalid');
  }
  const plainDirect = relay.protocol === 'ws:' && payload.mode === 'direct';
  if ((!plainDirect && relay.protocol !== 'wss:') || !relay.hostname) {
    throw new Error('Pairing requires a secure wss:// relay or explicit ws:// LAN direct mode');
  }
  if (plainDirect && payload.tlsPin) throw new Error('A ws:// LAN connection cannot have a TLS fingerprint');
  validatePairingSecret(payload.secret);
  if (payload.mode !== undefined && payload.mode !== 'relay' && payload.mode !== 'direct') throw new Error('Invalid connection mode');
  if (payload.hostId && !/^[a-zA-Z0-9._:-]{1,128}$/.test(payload.hostId)) {
    throw new Error('The pairing host id is invalid');
  }
  if (payload.hostName && payload.hostName.length > 128) throw new Error('The pairing host name is too long');
  if (payload.tlsPin && !/^[a-fA-F0-9]{64}$/.test(payload.tlsPin)) {
    throw new Error('The pairing TLS fingerprint must contain exactly 64 hexadecimal characters');
  }
}
