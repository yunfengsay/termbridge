/**
 * Per-machine, node-only settings (NOT wire protocol).
 *
 * The "middle" is just *which relay each machine dials*. Pointing a client and a
 * Mac mini at the same middle relay (your own VPS) is how they meet across
 * networks without port-forwarding. There is deliberately no new protocol
 * message for this — it's local config, stored in `~/.termbridge/settings.json`.
 *
 * Kept out of `@termbridge/protocol` on purpose: protocol must stay
 * browser-safe (P1 web client) and this module touches `node:fs`.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import selfsigned from 'selfsigned';
import type { HomeAssistantSettings } from './homeAssistant.js';

export * from './identity.js';
export * from './artifactCrypto.js';
export * from './homeAssistant.js';

/** Default port the middle relay listens on (`tb middle serve`). */
export const MIDDLE_PORT = 8001;
/** Upgrade header used only by the hosted, per-room Cloudflare relay. */
export const CLOUD_ROOM_KEY_HEADER = 'X-Termbridge-Room-Key';

/** How much the reverse tool channel may touch this machine's files. */
export type FsMode = 'off' | 'ro' | 'rw';

/**
 * Outbound routing for Termbridge's relay connection on this machine.
 *
 * `system` preserves the existing behaviour and honours proxy environment
 * variables. `direct` deliberately ignores those application-level proxies.
 * A packet-level OS VPN can still route the resulting socket; Termbridge does
 * not pretend it can reconfigure an unrelated VPN client.
 */
export type NetworkPolicy = 'system' | 'direct';

/**
 * Consent for the reverse tool channel (`tb peer …` from the host's agent). OFF
 * by default — nothing runs here until the user opts in with `tb expose on`. fs
 * ops are confined to `root`; `exec` is full shell access (NOT sandboxed by
 * `root`), so it has its own on/off.
 */
export interface ExposeSettings {
  enabled: boolean;
  root: string; // absolute dir; fs.* ops are confined here
  fs: FsMode;
  exec: boolean;
}

export interface Settings {
  /** Opt-in, per-entity read policy. Credential stays in the Host environment. */
  homeAssistant?: HomeAssistantSettings;
  /** Middle relay address: `ip`, `ip:port`, `host`, or a full `ws(s)://…` URL. */
  middle?: string;
  /** Shared password for relay auth (HMAC key). Long/high-entropy is ideal. */
  secret?: string;
  /** Pinned SHA-256 fingerprint of the relay's self-signed cert (normalised hex). */
  tlsPin?: string;
  /** Reverse-tool-channel consent (default: disabled). */
  expose?: ExposeSettings;
  /** Relay routing policy for the local Host and local `tb` client commands. */
  networkPolicy?: NetworkPolicy;
  /** Host-only cloud voice credentials. Never serialized onto the wire. */
  voice?: {
    volcengine?: {
      /** Current Speech SaaS console credential used by Realtime Voice 3.0. */
      apiKey?: string;
      /** Legacy O2.0 credentials retained for backwards compatibility. */
      appId?: string;
      accessToken?: string;
    };
  };
}

export function settingsPath(): string {
  return process.env.TB_SETTINGS || join(homedir(), '.termbridge', 'settings.json');
}

export function loadSettings(): Settings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Settings) : {};
  } catch {
    return {}; // missing / unreadable / malformed → empty
  }
}

export function saveSettings(s: Settings): void {
  const file = settingsPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  try {
    chmodSync(file, 0o600); // it can hold the shared secret — owner-only
  } catch {
    /* best-effort (e.g. non-POSIX) */
  }
}

export interface VolcengineVoiceCredentials {
  apiKey?: string;
  appId?: string;
  accessToken?: string;
}

export function getVolcengineVoiceCredentials(): VolcengineVoiceCredentials | undefined {
  const value = loadSettings().voice?.volcengine;
  const apiKey = value?.apiKey?.trim();
  const appId = value?.appId?.trim();
  const accessToken = value?.accessToken?.trim();
  if (apiKey) return { apiKey, ...(appId && accessToken ? { appId, accessToken } : {}) };
  return appId && accessToken ? { appId, accessToken } : undefined;
}

export function setVolcengineVoiceCredentials(
  credentials: VolcengineVoiceCredentials | undefined,
): void {
  const settings = loadSettings();
  const apiKey = credentials?.apiKey?.trim();
  const appId = credentials?.appId?.trim();
  const accessToken = credentials?.accessToken?.trim();
  if (apiKey || (appId && accessToken)) {
    settings.voice = {
      ...settings.voice,
      volcengine: {
        ...(apiKey ? { apiKey } : {}),
        ...(appId && accessToken ? { appId, accessToken } : {}),
      },
    };
  } else if (settings.voice) {
    delete settings.voice.volcengine;
    if (Object.keys(settings.voice).length === 0) delete settings.voice;
  }
  saveSettings(settings);
}

/** Set (or, with undefined/empty, clear) the middle and persist. Returns the new settings. */
export function setMiddle(value: string | undefined): Settings {
  const s = loadSettings();
  if (value && value.trim()) s.middle = value.trim();
  else delete s.middle;
  saveSettings(s);
  return s;
}

export function getMiddle(): string | undefined {
  return loadSettings().middle;
}

/**
 * Normalise a middle value into a WebSocket URL.
 *   `ws://x` / `wss://x` → unchanged
 *   `1.2.3.4`            → `ws://1.2.3.4:8001`
 *   `1.2.3.4:9000`       → `ws://1.2.3.4:9000`
 *   `host.example`       → `ws://host.example:8001`
 */
export function middleToUrl(v: string): string {
  const s = v.trim();
  if (/^wss?:\/\//i.test(s)) return s;
  return /:\d+$/.test(s) ? `ws://${s}` : `ws://${s}:${MIDDLE_PORT}`;
}

/**
 * The relay URL a host/client should dial, by precedence:
 *   1. env `RELAY_URL`        (explicit override / tests / `tb surf` child)
 *   2. configured middle      (`tb middle set <ip>`)
 *   3. localDefault           (the local `tb surf` relay)
 */
export function resolveRelayUrl(localDefault = 'ws://localhost:7400'): string {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  const m = getMiddle();
  return m ? middleToUrl(m) : localDefault;
}

export function getNetworkPolicy(): NetworkPolicy {
  return loadSettings().networkPolicy === 'direct' ? 'direct' : 'system';
}

export function setNetworkPolicy(policy: NetworkPolicy): Settings {
  if (policy !== 'system' && policy !== 'direct') {
    throw new Error(`Unknown network policy ${String(policy)}`);
  }
  const settings = loadSettings();
  if (policy === 'system') delete settings.networkPolicy;
  else settings.networkPolicy = policy;
  saveSettings(settings);
  return settings;
}

/** Whether the current shell/service environment supplies a proxy for `url`. */
export function hasProxyForUrl(url: string): boolean {
  return !!systemProxyForUrl(url);
}

function systemProxyForUrl(url: string): string {
  return getProxyForUrl(url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:'));
}

// ─── auth (optional shared-password, HMAC challenge-response) ────────────────
//
// The password is a symmetric secret known to the relay and every peer. The
// relay sends a random nonce; the peer answers HMAC-SHA256(secret, nonce). The
// secret never travels over the wire, so this holds even on plaintext `ws://`.
// It authenticates *who may connect* — for confidentiality of the traffic
// itself, run the relay behind `wss://` (TLS). Crypto is Node's `crypto`
// (OpenSSL) — no hand-rolled primitives.

export function setSecret(value: string | undefined): Settings {
  const s = loadSettings();
  if (value && value.length) s.secret = value;
  else delete s.secret;
  saveSettings(s);
  return s;
}

export function getSecret(): string | undefined {
  return loadSettings().secret;
}

/** The active secret: env `TB_SECRET` (handy for the VPS relay) wins over settings. */
export function resolveSecret(): string | undefined {
  return process.env.TB_SECRET || getSecret();
}

/** A fresh 256-bit challenge nonce (hex). */
export function makeNonce(): string {
  return randomBytes(32).toString('hex');
}

/** HMAC-SHA256(secret, nonce) as hex; `''` when there is no secret. */
export function hmacHex(secret: string | undefined, nonce: string): string {
  if (!secret) return '';
  return createHmac('sha256', secret).update(nonce).digest('hex');
}

/** Constant-time check that `mac` proves knowledge of `secret` for `nonce`. */
export function verifyMac(secret: string, nonce: string, mac: string): boolean {
  const expected = Buffer.from(hmacHex(secret, nonce), 'hex');
  const got = Buffer.from(mac || '', 'hex');
  return expected.length > 0 && expected.length === got.length && timingSafeEqual(expected, got);
}

// ─── self-signed wss (no domain / no public CA) + fingerprint pinning ────────
//
// On a bare-IP relay you can't get a public cert. `tb middle cert` makes a
// self-signed cert (the IP goes in the SAN) and prints its SHA-256 fingerprint;
// every peer pins that fingerprint. TLS encrypts the traffic; the pin
// authenticates the exact cert (MITM-proof) with no CA. Cert/key live in
// ~/.termbridge/tls (or env TB_TLS_CERT / TB_TLS_KEY).

export function tlsDir(): string {
  return join(dirname(settingsPath()), 'tls');
}

export function serverTlsPaths(): { cert: string; key: string } {
  return {
    cert: process.env.TB_TLS_CERT || join(tlsDir(), 'cert.pem'),
    key: process.env.TB_TLS_KEY || join(tlsDir(), 'key.pem'),
  };
}

/** The relay's cert+key if both exist — presence flips the relay to wss. */
export function loadServerTls(): { cert: Buffer; key: Buffer } | null {
  const { cert, key } = serverTlsPaths();
  try {
    if (existsSync(cert) && existsSync(key)) return { cert: readFileSync(cert), key: readFileSync(key) };
  } catch {
    /* unreadable → treat as no TLS */
  }
  return null;
}

/** SHA-256 fingerprint of a PEM cert, e.g. "AB:CD:…". */
export function fingerprintOf(certPem: string | Buffer): string {
  return new X509Certificate(certPem).fingerprint256;
}

/** Generate + persist a self-signed cert whose SAN covers `hosts` (+ localhost). */
export function generateSelfSigned(hosts: string[], paths = serverTlsPaths()): { fingerprint: string; certPath: string; keyPath: string } {
  const dns = new Set<string>(['localhost']);
  const ips = new Set<string>(['127.0.0.1']);
  for (const h of hosts) (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? ips : dns).add(h);
  const altNames = [
    ...[...dns].map((value) => ({ type: 2, value })), // DNS
    ...[...ips].map((ip) => ({ type: 7, ip })), // IP
  ];
  type Pems = { private: string; public: string; cert: string; fingerprint: string };
  const gen = (selfsigned as unknown as { generate(a: unknown, o: unknown): Pems }).generate;
  const pems = gen([{ name: 'commonName', value: 'termbridge-relay' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  const { cert, key } = paths;
  mkdirSync(dirname(cert), { recursive: true });
  writeFileSync(cert, pems.cert);
  writeFileSync(key, pems.private);
  try {
    chmodSync(key, 0o600);
  } catch {
    /* best-effort */
  }
  return { fingerprint: fingerprintOf(pems.cert), certPath: cert, keyPath: key };
}

export function normalizeFp(s: string): string {
  return s.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

export function getPin(): string | undefined {
  return loadSettings().tlsPin;
}

export function setPin(value: string | undefined): Settings {
  const s = loadSettings();
  const n = value && normalizeFp(value);
  if (n) s.tlsPin = n;
  else delete s.tlsPin;
  saveSettings(s);
  return s;
}

/** The active pin: env `TB_TLS_PIN` wins over settings. */
export function resolvePin(): string | undefined {
  const env = process.env.TB_TLS_PIN;
  return env ? normalizeFp(env) : getPin();
}

export function fingerprintMatches(peerFp: string | undefined, pinned: string | undefined): boolean {
  if (!peerFp || !pinned) return false;
  return normalizeFp(peerFp) === normalizeFp(pinned);
}

/**
 * `ws` client options for a relay URL. A self-signed `wss://` with a pin: let
 * TLS accept the cert (`rejectUnauthorized:false`) and verify the fingerprint
 * ourselves on 'upgrade' — that check *is* the pin. Plain ws / real-CA wss →
 * defaults (system trust store).
 */
export function isCloudRoomUrl(url: string): boolean {
  try {
    return /^\/r\/[a-f0-9]{64}$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function relayWsOptions(url: string): {
  rejectUnauthorized?: boolean;
  headers?: Record<string, string>;
  agent?: HttpsProxyAgent<string>;
} {
  const options: {
    rejectUnauthorized?: boolean;
    headers?: Record<string, string>;
    agent?: HttpsProxyAgent<string>;
  } = {};
  if (/^wss:/i.test(url) && resolvePin()) options.rejectUnauthorized = false;
  const secret = resolveSecret();
  if (secret && isCloudRoomUrl(url)) options.headers = { [CLOUD_ROOM_KEY_HEADER]: secret };
  const proxyUrl = getNetworkPolicy() === 'direct' ? '' : systemProxyForUrl(url);
  if (proxyUrl) options.agent = new HttpsProxyAgent(proxyUrl);
  return options;
}

// ─── reverse tool channel: client-side consent ──────────────────────────────
//
// The host's agent can run tools (shell, file ops) on the machine of the client
// attached to its session — but only if that client opts in. Stored locally
// (never on the wire); the client's executor reads it on every request.

/** Current exposure, with safe defaults filled in (disabled, home root, rw, exec on). */
export function getExpose(): ExposeSettings {
  const e = loadSettings().expose;
  return {
    enabled: !!e?.enabled,
    root: e?.root || homedir(),
    fs: e?.fs ?? 'rw',
    exec: e?.exec ?? true,
  };
}

/** Merge a patch into the exposure settings and persist. Returns the result. */
export function setExpose(patch: Partial<ExposeSettings>): ExposeSettings {
  const s = loadSettings();
  const next = { ...getExpose(), ...patch };
  s.expose = next;
  saveSettings(s);
  return next;
}

/** Append-only audit log of every peer tool call handled on this machine. */
export function peerAuditPath(): string {
  return join(dirname(settingsPath()), 'peer-audit.log');
}

export { acquireHostLease, hostLeasePath, type HostLease } from './hostLease.js';
