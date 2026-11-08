import { Logger } from '@nestjs/common';
import request from 'supertest';
import {
  ADMIN,
  type AdminApiTokenApp,
  DAY,
  MINUTE,
  OTHER_ADMIN,
  startAdminApiTokenApp,
} from '../../test/helpers/admin-api-token-app';
import { seedToken } from '../../test/helpers/admin-api-tokens-fakes';
import { newAdminApiTokenSecret } from './admin-api-token.secret';

const TARGET_USER = '9f2a0c3a-7d4e-4a5f-9cad-3e4f5a6b7c8d';

describe('SupabaseAuthGuard with an admin API token', () => {
  let ctx: AdminApiTokenApp;
  const http = () => request(ctx.app.getHttpServer());
  const bearer = (token: string) => `Bearer ${token}`;
  const listInstructors = (token: string) =>
    http().get('/admin/instructors').set('Authorization', bearer(token));
  const actions = () => ctx.audit.entries.map((entry) => entry.action);
  const lastFailure = () =>
    ctx.audit.entries
      .filter((e) => e.action === 'admin_api_token.auth_failure')
      .at(-1)?.metadata;
  const seed = (owner = ADMIN, expiresAt: string | null = null) =>
    seedToken(ctx.repo, owner, expiresAt);

  async function rotate(id: string, graceMinutes: number) {
    const secret = newAdminApiTokenSecret();
    await ctx.repo.rotate({
      tokenId: id,
      ownerUserId: ADMIN,
      tokenHash: secret.hash,
      tokenPrefix: secret.prefix,
      tokenLast4: secret.last4,
      keepExpiry: true,
      expiresAt: null,
      graceMinutes,
    });
    return secret.token;
  }

  beforeAll(async () => {
    ctx = await startAdminApiTokenApp();
  });

  afterAll(() => ctx.close());

  beforeEach(() => ctx.reset());

  describe('on admin endpoints', () => {
    it('lists instructors and exports the instructor CSV as the owner', async () => {
      const { id, token } = await seed();
      await listInstructors(token).expect(200, []);

      const csv = await http()
        .get('/admin/instructors/export.csv')
        .set('Authorization', bearer(token))
        .set('User-Agent', 'claude-code')
        .expect(200);

      expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(csv.text).toContain('Name,Email');
      expect(
        ctx.audit.entries.find((e) => e.action === 'instructor.export'),
      ).toMatchObject({
        actor: {
          userId: ADMIN,
          role: 'admin',
          userAgent: 'claude-code',
          via: 'api_token',
          tokenId: id,
        },
      });
    });

    it('records the first use once and last use at most once a minute', async () => {
      const { id, token } = await seed();
      const row = () => ctx.repo.rows.find((r) => r.id === id)!;

      await listInstructors(token).expect(200);
      await listInstructors(token).expect(200);
      ctx.clock.advance(30_000);
      await listInstructors(token).expect(200);

      expect(actions()).toEqual(['admin_api_token.first_use']);
      expect(ctx.audit.entries[0]).toMatchObject({
        targetId: id,
        actor: { userId: ADMIN, via: 'api_token', tokenId: id },
        metadata: { method: 'GET', path: '/admin/instructors' },
      });
      expect(row().last_used_at).toBe(
        new Date(ctx.clock.now() - 30_000).toISOString(),
      );

      ctx.clock.advance(31_000);
      await listInstructors(token).expect(200);

      expect(row().last_used_at).toBe(new Date(ctx.clock.now()).toISOString());
      expect(ctx.repo.writes.filter((w) => w.endsWith(id))).toEqual([
        `insert ${id}`,
        `first use ${id}`,
        `used ${id}`,
      ]);
    });

    it('answers 429 past 120 requests a minute for one token', async () => {
      const { token } = await seed();
      const other = await seed();

      for (let i = 0; i < 120; i++) {
        await listInstructors(token).expect(200);
      }
      await listInstructors(token).expect(429);
      await listInstructors(other.token).expect(200);

      ctx.clock.advance(MINUTE);
      await listInstructors(token).expect(200);
    });
  });

  describe('rejects', () => {
    it('an unknown or malformed token with 401, a throttled warning and no audit row', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const unknown = `ssms_pat_${'A'.repeat(43)}`;

      for (let i = 0; i < 4; i++) {
        await listInstructors(unknown).expect(401);
      }
      await listInstructors('ssms_pat_short').expect(401);

      expect(ctx.audit.entries).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('GET /admin/instructors');
      ctx.clock.advance(MINUTE);
      await listInstructors(unknown).expect(401);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1][0]).toContain('4 more');
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(
        /A{43}|ssms_pat_short/,
      );
      warn.mockRestore();
    });

    it('a revoked token at once', async () => {
      const { id, token } = await seed();
      await listInstructors(token).expect(200);

      await ctx.repo.revoke(id, ADMIN, new Date(ctx.clock.now()).toISOString());

      await listInstructors(token).expect(401);
      expect(ctx.audit.entries.at(-1)).toMatchObject({
        targetId: id,
        metadata: { reason: 'revoked' },
      });
    });

    it('a token once it expires', async () => {
      const { token } = await seed(
        ADMIN,
        new Date(ctx.clock.now() + DAY).toISOString(),
      );
      await listInstructors(token).expect(200);

      ctx.clock.advance(DAY);
      await listInstructors(token).expect(401);
      expect(lastFailure()).toMatchObject({ reason: 'expired' });
    });

    it('a rotated token once its grace period ends, and at once with no grace', async () => {
      const graced = await seed();
      const immediate = await seed();
      const successor = await rotate(graced.id, 10);
      await rotate(immediate.id, 0);

      await listInstructors(immediate.token).expect(401);
      await listInstructors(graced.token).expect(200);
      ctx.clock.advance(10 * MINUTE - 1);
      await listInstructors(graced.token).expect(200);
      ctx.clock.advance(1);
      await listInstructors(graced.token).expect(401);

      expect(lastFailure()).toMatchObject({ reason: 'revoked' });
      await listInstructors(successor).expect(200);
    });

    it('a token within 30 s of its owner losing the admin role', async () => {
      const { token } = await seed();
      await listInstructors(token).expect(200);

      ctx.users.get(ADMIN)!.app_metadata.role = 'instructor';
      await listInstructors(token).expect(200);
      ctx.clock.advance(30_000);
      await listInstructors(token).expect(401);

      expect(lastFailure()).toMatchObject({ reason: 'owner_not_admin' });
    });

    it('a token whose owner is banned or deleted', async () => {
      const banned = await seed();
      const gone = await seed(OTHER_ADMIN);
      ctx.users.get(ADMIN)!.banned_until = new Date(
        ctx.clock.now() + DAY,
      ).toISOString();
      ctx.users.delete(OTHER_ADMIN);
      ctx.clock.advance(30_000);

      await listInstructors(banned.token).expect(401);
      await listInstructors(gone.token).expect(401);
    });

    it('with 503, not 401, when the owner check fails', async () => {
      const { token } = await seed();
      ctx.clock.advance(30_000);
      ctx.owners.failing = true;

      await listInstructors(token).expect(503);
    });

    it('a token on a session-only route such as a role change', async () => {
      const { token } = await seed();

      await http()
        .patch(`/admin/users/${TARGET_USER}/role`)
        .set('Authorization', bearer(token))
        .send({ role: 'admin' })
        .expect(403);
      expect(ctx.setUserRole).not.toHaveBeenCalled();
      expect(lastFailure()).toMatchObject({ reason: 'session_only' });

      await http()
        .patch(`/admin/users/${TARGET_USER}/role`)
        .set('Authorization', ctx.sessionJwt())
        .send({ role: 'admin' })
        .expect(200);
      expect(ctx.setUserRole).toHaveBeenCalledWith(TARGET_USER, 'admin');
    });

    it('a token on the instructor sign-in email change', async () => {
      const { token } = await seed();
      const change = (authorization: string) =>
        http()
          .patch(`/admin/instructors/${TARGET_USER}/email`)
          .set('Authorization', authorization)
          .send({ email: 'new@example.com', expectedCurrentEmail: 'old@x.io' });

      await change(bearer(token)).expect(403);
      expect(ctx.changeInstructorEmail).not.toHaveBeenCalled();
      expect(lastFailure()).toMatchObject({ reason: 'session_only' });

      await change(ctx.sessionJwt()).expect(200);
      expect(ctx.changeInstructorEmail).toHaveBeenCalledTimes(1);
    });

    it('a token on the Google Calendar connect', async () => {
      const { token } = await seed();
      const connect = (authorization: string) =>
        http().get('/admin/google/connect').set('Authorization', authorization);

      await connect(bearer(token)).expect(403);
      expect(ctx.googleConnectUrl).not.toHaveBeenCalled();
      expect(lastFailure()).toMatchObject({ reason: 'session_only' });

      await connect(ctx.sessionJwt()).expect(200, {
        url: 'https://accounts.google.com/o/oauth2',
      });
      expect(ctx.googleConnectUrl).toHaveBeenCalledWith(ADMIN);
    });

    it('a token on a non-admin route', async () => {
      const { token } = await seed();

      await http()
        .get('/me/probe')
        .set('Authorization', bearer(token))
        .expect(403);
      expect(lastFailure()).toMatchObject({ reason: 'not_admin_route' });
      await http()
        .get('/me/probe')
        .set('Authorization', ctx.sessionJwt())
        .expect(200, { sub: ADMIN });
    });
  });

  it('keeps the session JWT path for every other bearer value', async () => {
    await http().get('/admin/instructors').expect(401);
    await http()
      .get('/admin/instructors')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
    await http()
      .get('/admin/instructors')
      .set('Authorization', ctx.sessionJwt())
      .expect(200);
    expect(ctx.ownerLookups).toEqual([]);
    expect(actions()).toEqual([]);
  });
});
