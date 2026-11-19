import { Logger } from '@nestjs/common';
import { Strategy } from 'passport-jwt';
import request from 'supertest';
import {
  ADMIN,
  type AdminApiTokenApp,
  MINUTE,
  startAdminApiTokenApp,
} from '../../test/helpers/admin-api-token-app';
import { seedToken } from '../../test/helpers/admin-api-tokens-fakes';
import { DEFAULT_AUTH_FAIL_LIMIT } from './auth-failure-limiter';

const OFFICE = '198.51.100.20';
const ELSEWHERE = '203.0.113.9';
const UNKNOWN_TOKEN = `ssms_pat_${'A'.repeat(43)}`;

describe('SupabaseAuthGuard failed-authentication limit per client IP', () => {
  let ctx: AdminApiTokenApp;
  let warn: jest.SpyInstance;
  let tokenLookup: jest.SpyInstance;
  let jwtVerify: jest.SpyInstance;

  const probe = (ip: string | null, authorization?: string) => {
    const req = request(ctx.app.getHttpServer()).get('/admin/instructors');
    if (ip !== null) {
      req.set('Fly-Client-IP', ip);
    }
    if (authorization !== undefined) {
      req.set('Authorization', authorization);
    }
    return req;
  };

  async function exhaust(ip: string | null, authorization?: string) {
    for (let i = 0; i < DEFAULT_AUTH_FAIL_LIMIT; i++) {
      await probe(ip, authorization).expect(401);
    }
  }

  beforeAll(async () => {
    ctx = await startAdminApiTokenApp();
  });

  afterAll(() => ctx.close());

  beforeEach(() => {
    ctx.reset();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    tokenLookup = jest.spyOn(ctx.repo, 'findByHash');
    jwtVerify = jest.spyOn(Strategy, 'JwtVerifier' as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('answers 429 with Retry-After to missing or malformed credentials after the limit, without a token lookup or JWT verification', async () => {
    await exhaust(OFFICE);
    tokenLookup.mockClear();
    jwtVerify.mockClear();

    const blocked = await probe(OFFICE).expect(429);
    expect(blocked.headers['retry-after']).toBe('60');
    expect(blocked.body).toMatchObject({
      statusCode: 429,
      retryAfterSeconds: 60,
    });
    for (const authorization of [
      'Bearer not-a-jwt',
      'Basic dXNlcjpwYXNz',
      'Bearer ssms_pat_short',
      'Bearer',
    ]) {
      await probe(OFFICE, authorization).expect(429);
    }

    expect(tokenLookup).not.toHaveBeenCalled();
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('still verifies well-formed credentials from a blocked IP, so valid ones succeed', async () => {
    const { token } = await seedToken(ctx.repo, ADMIN, null);
    await exhaust(OFFICE, `Bearer ${UNKNOWN_TOKEN}`);
    await probe(OFFICE).expect(429);

    await probe(OFFICE, `Bearer ${token}`).expect(200);
    await probe(OFFICE, ctx.sessionJwt()).expect(200);
    await probe(OFFICE, `Bearer ${UNKNOWN_TOKEN}`).expect(401);
    await probe(OFFICE, 'Bearer aaa.bbb.ccc').expect(401);
    expect(jwtVerify).toHaveBeenCalled();
  });

  it('does not lift the block after a successful authentication from the same IP', async () => {
    const { token } = await seedToken(ctx.repo, ADMIN, null);
    await exhaust(OFFICE);

    await probe(OFFICE, `Bearer ${token}`).expect(200);
    await probe(OFFICE).expect(429);
  });

  it('leaves other IPs unaffected', async () => {
    await exhaust(OFFICE);

    await probe(ELSEWHERE).expect(401);
  });

  it('lifts the block once the window passes', async () => {
    await exhaust(OFFICE);
    ctx.clock.advance(30_000);
    const blocked = await probe(OFFICE).expect(429);
    expect(blocked.headers['retry-after']).toBe('30');

    ctx.clock.advance(30_000);
    await probe(OFFICE).expect(401);
  });

  it('keys on Fly-Client-IP, ignores X-Forwarded-For, and falls back to the socket address', async () => {
    await exhaust(OFFICE);

    await probe(OFFICE).set('X-Forwarded-For', ELSEWHERE).expect(429);
    await probe(ELSEWHERE).set('X-Forwarded-For', OFFICE).expect(401);
    await probe(null).expect(401);

    for (let i = 1; i < DEFAULT_AUTH_FAIL_LIMIT; i++) {
      await probe(null).set('X-Forwarded-For', `10.0.0.${i}`).expect(401);
    }
    await probe(null).expect(429);
  });

  it('logs one warning a minute with the IP and counts, never the credentials', async () => {
    await exhaust(OFFICE, 'Bearer not-a-jwt');
    await exhaust(ELSEWHERE, 'Bearer not-a-jwt');
    await probe(OFFICE).expect(429);

    const limitWarnings = () =>
      warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.startsWith('Failed-auth limit'));
    expect(limitWarnings()).toHaveLength(1);
    expect(limitWarnings()[0]).toMatch(
      new RegExp(
        `^Failed-auth limit reached for ${OFFICE}: 60 failures in 60s`,
      ),
    );

    ctx.clock.advance(MINUTE);
    await exhaust(OFFICE, 'Bearer not-a-jwt');
    expect(limitWarnings()[1]).toBe(
      `Failed-auth limit reached for ${OFFICE}: 60 failures in 60s (1 more since the last warning)`,
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('not-a-jwt');
  });
});
