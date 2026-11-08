import { createHash } from 'node:crypto';
import request from 'supertest';
import {
  ADMIN,
  type AdminApiTokenApp,
  DAY,
  MINUTE,
  OTHER_ADMIN,
  startAdminApiTokenApp,
} from '../../test/helpers/admin-api-token-app';
import type { AdminApiTokenSummary } from './admin-api-tokens.types';

const TOKEN_SHAPE = /^ssms_pat_[A-Za-z0-9_-]{43}$/;

interface Issued {
  id: string;
  token: string;
  expiresAt: string | null;
}

describe('/admin/api-tokens', () => {
  let ctx: AdminApiTokenApp;
  const http = () => request(ctx.app.getHttpServer());
  const bearer = (token: string) => `Bearer ${token}`;
  const listInstructors = (token: string) =>
    http().get('/admin/instructors').set('Authorization', bearer(token));
  const iso = (offset = 0) => new Date(ctx.clock.now() + offset).toISOString();

  async function issue(
    body: Record<string, unknown> = { name: 'laptop', expiresAt: null },
    owner = ADMIN,
  ): Promise<Issued> {
    const res = await http()
      .post('/admin/api-tokens')
      .set('Authorization', ctx.sessionJwt(owner))
      .send(body)
      .expect(201);
    return res.body as Issued;
  }

  async function listed(owner = ADMIN): Promise<AdminApiTokenSummary[]> {
    const res = await http()
      .get('/admin/api-tokens')
      .set('Authorization', ctx.sessionJwt(owner))
      .expect(200);
    return res.body as AdminApiTokenSummary[];
  }

  const rotate = (id: string, body: object = {}) =>
    http()
      .post(`/admin/api-tokens/${id}/rotate`)
      .set('Authorization', ctx.sessionJwt())
      .send(body);

  beforeAll(async () => {
    ctx = await startAdminApiTokenApp();
  });

  afterAll(() => ctx.close());

  beforeEach(() => ctx.reset());

  describe('POST', () => {
    it('returns the secret once and stores only its SHA-256 hash', async () => {
      const created = await issue({
        name: '  laptop  ',
        expiresAt: iso(90 * DAY),
      });

      expect(created.token).toMatch(TOKEN_SHAPE);
      expect(created).toEqual({
        id: created.id,
        name: 'laptop',
        token: created.token,
        prefix: created.token.slice(0, 13),
        last4: created.token.slice(-4),
        createdAt: iso(),
        expiresAt: iso(90 * DAY),
      });
      const stored = ctx.repo.rows.find((row) => row.id === created.id)!;
      expect(stored.token_hash).toBe(
        createHash('sha256').update(created.token).digest('hex'),
      );
      const secretPart = created.token.slice(9);
      expect(JSON.stringify(ctx.repo.rows)).not.toContain(secretPart);
      const list = await listed();
      expect(JSON.stringify(list)).not.toContain(secretPart);
      expect(list).toContainEqual({
        id: created.id,
        name: 'laptop',
        prefix: created.token.slice(0, 13),
        last4: created.token.slice(-4),
        createdAt: iso(),
        expiresAt: iso(90 * DAY),
        lastUsedAt: null,
        revokedAt: null,
        status: 'active',
      });
      await listInstructors(created.token).expect(200);
    });

    it('writes a created audit row without the secret', async () => {
      const created = await issue();

      expect(ctx.audit.entries).toEqual([
        {
          action: 'admin_api_token.create',
          actor: { userId: ADMIN, role: 'admin', userAgent: null },
          targetType: 'admin_api_token',
          targetId: created.id,
          metadata: {
            name: 'laptop',
            prefix: created.token.slice(0, 13),
            last4: created.token.slice(-4),
            expiresAt: null,
          },
        },
      ]);
      expect(JSON.stringify(ctx.audit.entries)).not.toContain(
        created.token.slice(9),
      );
    });

    it.each([
      ['a past expiry', { name: 'x', expiresAt: '2020-01-01T00:00:00Z' }],
      [
        'an expiry beyond 3 years',
        { name: 'x', expiresAt: '2099-01-01T00:00:00Z' },
      ],
      ['a missing expiry', { name: 'x' }],
      ['a blank name', { name: '  ', expiresAt: null }],
      ['a non-date expiry', { name: 'x', expiresAt: 'soon' }],
    ])('refuses %s with 400', async (_label, body) => {
      await http()
        .post('/admin/api-tokens')
        .set('Authorization', ctx.sessionJwt())
        .send(body)
        .expect(400);
      expect(ctx.audit.entries).toEqual([]);
    });
  });

  describe('GET', () => {
    it('lists only the caller’s own tokens with their status', async () => {
      const mine = await issue();
      const theirs = await issue(undefined, OTHER_ADMIN);
      const expiring = await issue({ name: 'short', expiresAt: iso(DAY) });
      ctx.clock.advance(DAY);

      const list = await listed();
      expect(list.map((t) => t.id)).not.toContain(theirs.id);
      expect(
        Object.fromEntries(list.map((t) => [t.id, t.status])),
      ).toMatchObject({ [mine.id]: 'active', [expiring.id]: 'expired' });
    });
  });

  describe('DELETE', () => {
    it('revokes at once, audits it, and answers 204 again for a repeat', async () => {
      const { id, token } = await issue();
      await listInstructors(token).expect(200);

      await http()
        .delete(`/admin/api-tokens/${id}`)
        .set('Authorization', ctx.sessionJwt())
        .expect(204);
      await listInstructors(token).expect(401);
      await http()
        .delete(`/admin/api-tokens/${id}`)
        .set('Authorization', ctx.sessionJwt())
        .expect(204);

      expect(
        ctx.audit.entries.filter((e) => e.action === 'admin_api_token.revoke'),
      ).toEqual([
        {
          action: 'admin_api_token.revoke',
          actor: { userId: ADMIN, role: 'admin', userAgent: null },
          targetType: 'admin_api_token',
          targetId: id,
        },
      ]);
      expect((await listed()).find((t) => t.id === id)).toMatchObject({
        status: 'revoked',
        revokedAt: iso(),
      });
    });

    it('answers 404 for another admin’s token and leaves it working', async () => {
      const theirs = await issue(undefined, OTHER_ADMIN);

      await http()
        .delete(`/admin/api-tokens/${theirs.id}`)
        .set('Authorization', ctx.sessionJwt())
        .expect(404);
      await listInstructors(theirs.token).expect(200);
    });
  });

  describe('POST :id/rotate', () => {
    it('issues a new secret once, keeps the expiry setting, and keeps the old one working for the grace period', async () => {
      const old = await issue({ name: 'ci', expiresAt: iso(90 * DAY) });
      ctx.clock.advance(10 * DAY);

      const res = await rotate(old.id).expect(201);
      const rotated = res.body as Issued;

      expect(rotated.token).toMatch(TOKEN_SHAPE);
      expect(rotated.token).not.toBe(old.token);
      expect(rotated.expiresAt).toBe(iso(90 * DAY));
      expect((await listed()).find((t) => t.id === old.id)!.status).toBe(
        'rotating',
      );

      await listInstructors(old.token).expect(200);
      await listInstructors(rotated.token).expect(200);
      ctx.clock.advance(10 * MINUTE);
      await listInstructors(old.token).expect(401);
      await listInstructors(rotated.token).expect(200);

      expect(
        ctx.audit.entries.find((e) => e.action === 'admin_api_token.rotate'),
      ).toEqual({
        action: 'admin_api_token.rotate',
        actor: { userId: ADMIN, role: 'admin', userAgent: null },
        targetType: 'admin_api_token',
        targetId: old.id,
        metadata: {
          replacedBy: rotated.id,
          graceMinutes: 10,
          prefix: rotated.token.slice(0, 13),
          last4: rotated.token.slice(-4),
          expiresAt: rotated.expiresAt,
        },
      });
      expect(JSON.stringify(ctx.audit.entries)).not.toContain(
        rotated.token.slice(9),
      );
    });

    it('with no grace stops the old token at once and can change the expiry', async () => {
      const old = await issue();

      const res = await rotate(old.id, {
        graceMinutes: 0,
        expiresAt: iso(30 * DAY),
      }).expect(201);

      expect((res.body as Issued).expiresAt).toBe(iso(30 * DAY));
      await listInstructors(old.token).expect(401);
    });

    it('refuses a second rotation, another admin’s token, and a grace over a day', async () => {
      const mine = await issue();
      const theirs = await issue(undefined, OTHER_ADMIN);

      await rotate(mine.id, { graceMinutes: 1441 }).expect(400);
      await rotate(theirs.id).expect(404);
      await rotate(mine.id).expect(201);
      await rotate(mine.id).expect(404);
    });
  });

  it('never lets a token create, list, rotate or revoke tokens', async () => {
    const { id, token } = await issue();
    ctx.audit.entries.length = 0;
    const stored = ctx.repo.rows.length;
    const auth = bearer(token);

    await http()
      .post('/admin/api-tokens')
      .set('Authorization', auth)
      .send({ name: 'escalate', expiresAt: null })
      .expect(403);
    await http()
      .get('/admin/api-tokens')
      .set('Authorization', auth)
      .expect(403);
    await http()
      .post(`/admin/api-tokens/${id}/rotate`)
      .set('Authorization', auth)
      .send({})
      .expect(403);
    await http()
      .delete(`/admin/api-tokens/${id}`)
      .set('Authorization', auth)
      .expect(403);

    expect(ctx.repo.rows).toHaveLength(stored);
    expect(ctx.repo.rows.find((r) => r.id === id)).toMatchObject({
      revoked_at: null,
      replaced_by: null,
    });
    expect(
      ctx.audit.entries
        .filter((e) => e.action === 'admin_api_token.auth_failure')
        .map((e) => e.metadata?.reason),
    ).toEqual(['session_only', 'session_only', 'session_only', 'session_only']);
  });
});
