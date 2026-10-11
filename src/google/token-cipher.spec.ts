import { randomBytes } from 'node:crypto';
import { decryptToken, encryptToken, TokenDecryptError } from './token-cipher';

const key = randomBytes(32);
const secret = '1//0refresh-token-value';

describe('token cipher', () => {
  it('round-trips a refresh token without storing it in clear', () => {
    const encoded = encryptToken(secret, key);
    expect(encoded).not.toContain(secret);
    expect(encoded.split(':')).toHaveLength(4);
    expect(decryptToken(encoded, key)).toBe(secret);
  });

  it('uses a fresh IV for every write', () => {
    const a = encryptToken(secret, key);
    const b = encryptToken(secret, key);
    expect(a).not.toBe(b);
    expect(a.split(':')[1]).not.toBe(b.split(':')[1]);
  });

  it('rejects a tampered ciphertext or tag', () => {
    const [v, iv, tag, ct] = encryptToken(secret, key).split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 1;
    expect(() =>
      decryptToken([v, iv, tag, flipped.toString('base64')].join(':'), key),
    ).toThrow(TokenDecryptError);
    const badTag = Buffer.from(tag, 'base64');
    badTag[0] ^= 1;
    expect(() =>
      decryptToken([v, iv, badTag.toString('base64'), ct].join(':'), key),
    ).toThrow(TokenDecryptError);
  });

  it('rejects the wrong key', () => {
    expect(() =>
      decryptToken(encryptToken(secret, key), randomBytes(32)),
    ).toThrow(TokenDecryptError);
  });

  it.each(['', 'plain', 'v2:a:b:c', 'v1:a:b', 'v1:a:b:c:d'])(
    'rejects malformed input %p',
    (input) => {
      expect(() => decryptToken(input, key)).toThrow(TokenDecryptError);
    },
  );
});
