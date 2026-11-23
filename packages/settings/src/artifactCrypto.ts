import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

const ARTIFACT_CRYPTO_INFO = Buffer.from('termbridge-artifact-v1', 'utf8');

export interface AndroidArtifactSender {
  senderPublicKey: string;
  salt: string;
  encrypt(receiverPublicKey: string, artifactId: string, offset: number, plaintext: Uint8Array): {
    iv: string;
    ciphertext: string;
    plainBytes: number;
  };
  decrypt(receiverPublicKey: string, artifactId: string, offset: number, plainBytes: number, iv: string, ciphertext: string): Buffer;
}

function artifactKey(privateKey: KeyObject, receiverPublicKey: string, salt: Buffer): Buffer {
  const peer = createPublicKey({
    key: Buffer.from(receiverPublicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const shared = diffieHellman({ privateKey, publicKey: peer });
  return Buffer.from(hkdfSync('sha256', shared, salt, ARTIFACT_CRYPTO_INFO, 32));
}

function chunkAad(artifactId: string, offset: number, plainBytes: number): Buffer {
  return Buffer.from(`termbridge-artifact-v1:${artifactId}:${offset}:${plainBytes}`, 'utf8');
}

export function createAndroidArtifactSender(): AndroidArtifactSender {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const salt = randomBytes(32);
  const senderPublicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

  return {
    senderPublicKey,
    salt: salt.toString('base64'),
    encrypt(receiverPublicKey, artifactId, offset, plaintext) {
      const data = Buffer.from(plaintext);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', artifactKey(pair.privateKey, receiverPublicKey, salt), iv);
      cipher.setAAD(chunkAad(artifactId, offset, data.length));
      const encrypted = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
      return {
        iv: iv.toString('base64'),
        ciphertext: encrypted.toString('base64'),
        plainBytes: data.length,
      };
    },
    decrypt(receiverPublicKey, artifactId, offset, plainBytes, iv, ciphertext) {
      const encrypted = Buffer.from(ciphertext, 'base64');
      if (encrypted.length < 16) throw new Error('short encrypted artifact chunk');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        artifactKey(pair.privateKey, receiverPublicKey, salt),
        Buffer.from(iv, 'base64'),
      );
      decipher.setAAD(chunkAad(artifactId, offset, plainBytes));
      decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
      const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
      if (plaintext.length !== plainBytes) throw new Error('artifact chunk length mismatch');
      return plaintext;
    },
  };
}

/** Test helper that mirrors Android's X.509 ECDH + HKDF + AES-GCM receiver. */
export function createAndroidArtifactTestReceiver(senderPublicKey: string, saltBase64: string): {
  receiverPublicKey: string;
  decrypt(artifactId: string, offset: number, plainBytes: number, iv: string, ciphertext: string): Buffer;
  encrypt(artifactId: string, offset: number, plaintext: Uint8Array): { iv: string; ciphertext: string; plainBytes: number };
} {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sender = createPublicKey({ key: Buffer.from(senderPublicKey, 'base64'), format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: sender });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(saltBase64, 'base64'), ARTIFACT_CRYPTO_INFO, 32));
  return {
    receiverPublicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    decrypt(artifactId, offset, plainBytes, iv, ciphertext) {
      const encrypted = Buffer.from(ciphertext, 'base64');
      if (encrypted.length < 16) throw new Error('short encrypted artifact chunk');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAAD(chunkAad(artifactId, offset, plainBytes));
      decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
      return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
    },
    encrypt(artifactId, offset, plaintext) {
      const data = Buffer.from(plaintext);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(chunkAad(artifactId, offset, data.length));
      const encrypted = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
      return { iv: iv.toString('base64'), ciphertext: encrypted.toString('base64'), plainBytes: data.length };
    },
  };
}
