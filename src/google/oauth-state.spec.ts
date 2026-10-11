import { createHmac } from 'node:crypto';
import {
  OAUTH_STATE_TTL_MS,
  signOAuthState,
  verifyOAuthState,
} from './oauth-state';

const secret = 'client-secret';
const now = Date.parse('2026-10-11T12:00:00.000Z');
const admin = '7d0f8a1e-5b2c-4e3d-9a8b-1c2d3e4f5a6b';

describe('OAuth state', () => {
  it('carries the admin user id it was issued for', () => {
    const state = signOAuthState(admin, secret, now);
    expect(verifyOAuthState(state, secret, now + 1000)).toEqual({
      userId: admin,
    });
  });

  it('is unique per issue', () => {
    expect(signOAuthState(admin, secret, now)).not.toBe(
      signOAuthState(admin, secret, now),
    );
  });

  it('expires after ten minutes', () => {
    const state = signOAuthState(admin, secret, now);
    expect(
      verifyOAuthState(state, secret, now + OAUTH_STATE_TTL_MS - 1),
    ).toEqual({ userId: admin });
    expect(
      verifyOAuthState(state, secret, now + OAUTH_STATE_TTL_MS),
    ).toBeNull();
  });

  it('rejects a state signed with another secret', () => {
    const state = signOAuthState(admin, 'other', now);
    expect(verifyOAuthState(state, secret, now)).toBeNull();
  });

  it('rejects a payload swapped under a valid signature', () => {
    const [, signature] = signOAuthState(admin, secret, now).split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'attacker', exp: now + 60_000, n: 'x' }),
    ).toString('base64url');
    expect(verifyOAuthState(`${forged}.${signature}`, secret, now)).toBeNull();
  });

  it.each([undefined, '', 'abc', 'a.b.c', 'a.'])(
    'rejects malformed state %p',
    (state) => {
      expect(verifyOAuthState(state, secret, now)).toBeNull();
    },
  );

  it('rejects a correctly signed body that is not a valid payload', () => {
    const signed = (body: string) =>
      `${body}.${createHmac('sha256', secret).update(`google-oauth-state.${body}`).digest('base64url')}`;
    const notJson = Buffer.from('not json').toString('base64url');
    const noSub = Buffer.from(JSON.stringify({ exp: now + 1000 })).toString(
      'base64url',
    );
    expect(verifyOAuthState(signed(notJson), secret, now)).toBeNull();
    expect(verifyOAuthState(signed(noSub), secret, now)).toBeNull();
  });
});
