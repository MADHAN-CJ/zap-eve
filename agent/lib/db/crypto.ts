import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Secret protection:
 *
 *  - encryptSecret()/decryptSecret(): AES-256-GCM with a key derived from
 *    CREDS_ENCRYPTION_KEY. Only broker_connections.credential_enc holds
 *    ciphertext; decryption happens solely inside per-tool credential
 *    resolution and the broker API routes — never in the model context.
 *  - otpHash(): HMAC-SHA256 of `code:email` with CREDS_HASH_PEPPER, so raw
 *    login codes are never stored.
 *
 * Both secrets are required, must differ, and should each be a long random
 * string (`openssl rand -hex 32`). Rotating CREDS_ENCRYPTION_KEY invalidates
 * stored broker credentials (users must reconnect Dhan) — pin it per
 * environment and never regenerate.
 */

const ENC_VERSION = 'v1';

function requireSecret(name: 'CREDS_ENCRYPTION_KEY' | 'CREDS_HASH_PEPPER'): string {
  const value = process.env[name];
  if (!value || value.length < 16) {
    throw new Error(`${name} must be set to a random secret of at least 16 characters.`);
  }
  return value;
}

/** 32-byte AES key derived from the configured secret (accepts any-length secret). */
function encryptionKey(): Buffer {
  return createHash('sha256').update(requireSecret('CREDS_ENCRYPTION_KEY')).digest();
}

/** HMAC for one-time login codes: hash(code, email) is what `otps.code_hash` stores. */
export function otpHash(code: string, email: string): string {
  return createHmac('sha256', requireSecret('CREDS_HASH_PEPPER'))
    .update(`${code}:${email.toLowerCase()}`)
    .digest('hex');
}

/** Encrypt a secret for at-rest storage: `v1:<iv>:<ciphertext>:<tag>` (base64). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_VERSION, iv.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join(':');
}

/** Decrypt a stored secret. Throws on tampering or a rotated encryption key. */
export function decryptSecret(stored: string): string {
  const [version, ivB64, ctB64, tagB64] = stored.split(':');
  if (version !== ENC_VERSION || !ivB64 || !ctB64 || !tagB64) {
    throw new Error('Unrecognized credential ciphertext format.');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
