/** Shared WebCrypto implementation for the bundled viewer and Host. No private key crosses the relay. */
import type { webcrypto } from 'node:crypto';
type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;
// Cloudflare ambient types rename ECDH's public member; the browser/Node API is standard WebCrypto.
const desktopCrypto = crypto as unknown as webcrypto.Crypto;
export interface DesktopOpen {
  t: 'desktop_open'; id: string; hostId: string; deviceId: string; publicKey: string; nonce: string; proof: string;
}
export interface DesktopReady {
  t: 'desktop_ready'; id: string; publicKey: string; salt: string; proof: string;
}
export interface DesktopPacket { t: 'desktop_data'; id: string; sequence: number; data: string }
const utf8 = new TextEncoder();
const context = 'termbridge-desktop-v1';
export function desktopBase64(bytes: Uint8Array): string {
  let result = ''; for (let start = 0; start < bytes.length; start += 8192) result += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(result);
}
export function desktopBytes(value: string, max = 256 * 1024): Uint8Array<ArrayBuffer> {
  if (value.length > Math.ceil(max / 3) * 4) throw new Error('Desktop packet too large');
  return Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
}
function random(size: number): string { return desktopBase64(desktopCrypto.getRandomValues(new Uint8Array(size))); }
async function proofKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 1 || secret.length > 256) throw new Error('Desktop requires a configured connection password');
  return desktopCrypto.subtle.importKey('raw', utf8.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function openTranscript(open: DesktopOpen): Uint8Array<ArrayBuffer> {
  return utf8.encode(JSON.stringify([context, 'open', open.hostId, open.deviceId, open.id, open.publicKey, open.nonce]));
}
function readyTranscript(open: DesktopOpen, ready: DesktopReady): Uint8Array<ArrayBuffer> {
  return utf8.encode(JSON.stringify([context, 'ready', open.hostId, open.deviceId, open.id, open.publicKey, open.nonce, ready.publicKey, ready.salt]));
}
async function keyPair(): Promise<CryptoKeyPair> {
  return desktopCrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}
async function publicKey(pair: CryptoKeyPair): Promise<string> { return desktopBase64(new Uint8Array(await desktopCrypto.subtle.exportKey('raw', pair.publicKey))); }

export async function openDesktop(secret: string, hostId: string, deviceId = ''): Promise<{ open: DesktopOpen; finish: (ready: DesktopReady) => Promise<DesktopCipher> }> {
  const pair = await keyPair(), auth = await proofKey(secret);
  const open: DesktopOpen = { t: 'desktop_open', hostId, deviceId, id: random(18), publicKey: await publicKey(pair), nonce: random(32), proof: '' };
  open.proof = desktopBase64(new Uint8Array(await desktopCrypto.subtle.sign('HMAC', auth, openTranscript(open))));
  return { open, async finish(ready) {
    if (ready.id !== open.id || !await desktopCrypto.subtle.verify('HMAC', auth, desktopBytes(ready.proof, 32), readyTranscript(open, ready))) throw new Error('Desktop Host authentication failed');
    return deriveCipher(pair.privateKey, ready.publicKey, ready.salt, open, 'client');
  } };
}

export async function acceptDesktop(secret: string, hostId: string, open: DesktopOpen): Promise<{ ready: DesktopReady; cipher: DesktopCipher }> {
  if (open.hostId !== hostId || typeof open.deviceId !== 'string' || open.deviceId.length > 128 || desktopBytes(open.nonce, 32).length !== 32 || desktopBytes(open.id, 18).length !== 18) throw new Error('Invalid desktop session identity');
  const auth = await proofKey(secret);
  if (!await desktopCrypto.subtle.verify('HMAC', auth, desktopBytes(open.proof, 32), openTranscript(open))) throw new Error('Desktop client authentication failed');
  const pair = await keyPair();
  const ready: DesktopReady = { t: 'desktop_ready', id: open.id, publicKey: await publicKey(pair), salt: random(32), proof: '' };
  ready.proof = desktopBase64(new Uint8Array(await desktopCrypto.subtle.sign('HMAC', auth, readyTranscript(open, ready))));
  return { ready, cipher: await deriveCipher(pair.privateKey, open.publicKey, ready.salt, open, 'host') };
}

async function deriveCipher(privateKey: CryptoKey, peer: string, salt: string, open: DesktopOpen, side: 'host' | 'client'): Promise<DesktopCipher> {
  const peerKey = await desktopCrypto.subtle.importKey('raw', desktopBytes(peer, 65), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await desktopCrypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, privateKey, 256);
  const material = await desktopCrypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = (direction: string) => desktopCrypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: desktopBytes(salt, 32), info: utf8.encode(JSON.stringify([context, open.hostId, open.id, direction])) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const [host, client] = await Promise.all([key('host'), key('client')]);
  return new DesktopCipher(open.id, side, side === 'host' ? host : client, side === 'host' ? client : host);
}

export class DesktopCipher {
  private sent = 0;
  private received = 0;
  private closed = false;
  private sending = false;
  private receiving = false;
  constructor(readonly id: string, private readonly side: 'host' | 'client', private readonly sendKey: CryptoKey, private readonly receiveKey: CryptoKey) {}
  private nonce(sequence: number): Uint8Array<ArrayBuffer> { const bytes = new Uint8Array(12); new DataView(bytes.buffer).setUint32(8, sequence); return bytes; }
  private aad(side: string, sequence: number): Uint8Array<ArrayBuffer> { return utf8.encode(JSON.stringify([context, this.id, side, sequence])); }
  async seal(bytes: Uint8Array): Promise<DesktopPacket> {
    if (this.closed || this.sending || bytes.length > 64 * 1024 || this.sent >= 0xffffffff) throw new Error('Desktop send lifecycle or size violation');
    this.sending = true;
    const sequence = ++this.sent;
    try {
      const encrypted = await desktopCrypto.subtle.encrypt({ name: 'AES-GCM', iv: this.nonce(sequence), additionalData: this.aad(this.side, sequence) }, this.sendKey, new Uint8Array(bytes));
      if (this.closed) throw new Error('Desktop session closed');
      return { t: 'desktop_data', id: this.id, sequence, data: desktopBase64(new Uint8Array(encrypted)) };
    } catch (error) { this.close(); throw error; }
    finally { this.sending = false; }
  }
  async open(packet: DesktopPacket): Promise<Uint8Array<ArrayBuffer>> {
    if (this.closed || this.receiving || packet.id !== this.id || !Number.isInteger(packet.sequence) || packet.sequence !== this.received + 1) throw new Error('Desktop replay or session mismatch');
    this.receiving = true;
    try {
      const bytes = await desktopCrypto.subtle.decrypt({ name: 'AES-GCM', iv: this.nonce(packet.sequence), additionalData: this.aad(this.side === 'host' ? 'client' : 'host', packet.sequence) }, this.receiveKey, desktopBytes(packet.data, 64 * 1024 + 16));
      if (this.closed) throw new Error('Desktop session closed');
      this.received = packet.sequence; return new Uint8Array(bytes);
    } catch (error) { this.close(); throw error; }
    finally { this.receiving = false; }
  }
  close(): void { this.closed = true; }
}
