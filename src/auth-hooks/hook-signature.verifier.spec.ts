import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { HookSignatureVerifier } from './hook-signature.verifier';

const SECRET_B64 = randomBytes(32).toString('base64');
const SECRET = `v1,whsec_${SECRET_B64}`;
const BODY = JSON.stringify({ user: { id: 'u1' }, email_data: {} });

function verifier(secret: string | undefined): HookSignatureVerifier {
  return new HookSignatureVerifier({
    get: (key: string) =>
      key === 'SEND_EMAIL_HOOK_SECRET' ? secret : undefined,
  } as unknown as ConfigService);
}

function signedHeaders(
  body: string,
  secretB64 = SECRET_B64,
  at: Date = new Date(),
): Record<string, string> {
  const id = 'msg_test';
  return {
    'webhook-id': id,
    'webhook-timestamp': String(Math.floor(at.getTime() / 1000)),
    'webhook-signature': new Webhook(secretB64).sign(id, at, body),
  };
}

describe('HookSignatureVerifier', () => {
  it('returns the parsed body for a valid signature over the raw bytes', () => {
    const v = verifier(SECRET);
    expect(v.isConfigured()).toBe(true);
    expect(v.verify(Buffer.from(BODY), signedHeaders(BODY))).toEqual(
      JSON.parse(BODY),
    );
  });

  it('rejects a signature made with another secret', () => {
    const other = randomBytes(32).toString('base64');
    expect(() =>
      verifier(SECRET).verify(Buffer.from(BODY), signedHeaders(BODY, other)),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a body that differs from the signed one', () => {
    const headers = signedHeaders(BODY);
    expect(() =>
      verifier(SECRET).verify(Buffer.from(`${BODY} `), headers),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a stale timestamp (older than 5 minutes)', () => {
    const stale = new Date(Date.now() - 6 * 60 * 1000);
    expect(() =>
      verifier(SECRET).verify(
        Buffer.from(BODY),
        signedHeaders(BODY, SECRET_B64, stale),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a request without signature headers', () => {
    expect(() => verifier(SECRET).verify(Buffer.from(BODY), {})).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts any of several |-separated secrets (rotation)', () => {
    const old = randomBytes(32).toString('base64');
    const v = verifier(`v1,whsec_${old} | ${SECRET}`);
    expect(v.verify(Buffer.from(BODY), signedHeaders(BODY))).toEqual(
      JSON.parse(BODY),
    );
    expect(v.verify(Buffer.from(BODY), signedHeaders(BODY, old))).toEqual(
      JSON.parse(BODY),
    );
  });

  it('joins repeated signature headers', () => {
    const headers = signedHeaders(BODY);
    const v = verifier(SECRET);
    expect(
      v.verify(Buffer.from(BODY), {
        ...headers,
        'webhook-signature': ['v1,bm9wZQ==', headers['webhook-signature']],
      }),
    ).toEqual(JSON.parse(BODY));
  });

  it.each([undefined, '', '   '])(
    'refuses every call with 503 when the secret is %p',
    (secret) => {
      const v = verifier(secret);
      expect(v.isConfigured()).toBe(false);
      expect(() => v.verify(Buffer.from(BODY), signedHeaders(BODY))).toThrow(
        ServiceUnavailableException,
      );
    },
  );

  it('treats a malformed secret as unconfigured', () => {
    const v = verifier('v1,whsec_%%%not-base64%%%');
    expect(v.isConfigured()).toBe(false);
  });
});
