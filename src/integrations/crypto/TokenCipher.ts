import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ALGO = 'aes-256-gcm';

/**
 * AES-256-GCM at-rest encryption for OAuth tokens. Every provider's access
 * and refresh tokens are secrets that grant access to an org's meeting
 * platform account — they're never stored in plaintext.
 *
 * Key must be a base64-encoded 32-byte value, e.g. generated with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * and provided via INTEGRATIONS_ENCRYPTION_KEY. Rotate by re-encrypting
 * stored tokens with a new key — this class doesn't handle key rotation.
 */
export class TokenCipher {
  private key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) {
      throw new Error('INTEGRATIONS_ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded AES-256 key)');
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, ciphertext].map((b) => b.toString('base64')).join('.');
  }

  decrypt(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split('.');
    if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted token payload');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}
