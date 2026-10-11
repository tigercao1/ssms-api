import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { GoogleError } from './google.errors';

const ALGORITHM = 'aes-256-gcm';
const FORMAT_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from('google_connection.refresh_token');

export class TokenDecryptError extends GoogleError {
  constructor() {
    super('Stored Google token could not be decrypted');
  }
}

export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    FORMAT_VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptToken(encoded: string, key: Buffer): string {
  const [version, iv, tag, ciphertext, ...rest] = encoded.split(':');
  if (
    version !== FORMAT_VERSION ||
    !iv ||
    !tag ||
    ciphertext === undefined ||
    rest.length > 0
  ) {
    throw new TokenDecryptError();
  }
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(iv, 'base64'),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new TokenDecryptError();
  }
}
