import {
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH,
  ADMIN_ID,
  INSTRUCTOR_AUTH,
  startAdminApp,
} from '../../test/helpers/admin-http';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import {
  InMemoryInvitesRepository,
  InMemoryResendCooldownRepository,
} from '../../test/helpers/reminders-fakes';
import type { ActivationAuth } from '../activation/activation-auth';
import { ActivationService } from '../activation/activation.service';
import type { InviteRecipient } from '../activation/activation.types';
import { InviteDispatcher } from '../activation/invite-dispatcher';
import { hashInviteToken } from '../activation/invite-token';
import { AuditService } from '../audit/audit.service';
import { BIO_TRANSLATOR } from '../bio-translation/bio-translator.interface';
import { DocumentOnboardingService } from '../documents/document-onboarding.service';
import { InstructorsService } from '../instructors/instructors.service';
import { MailerService } from '../mailer/mailer.service';
import type { SendEmailRequest } from '../mailer/mailer.types';
import { GoLiveService } from '../shopify-sync/go-live.service';
import { AdminInstructorEmailController } from './admin-instructor-email.controller';
import { AdminInstructorEmailService } from './admin-instructor-email.service';
import { AdminRepository } from './admin.repository';
import { AdminService } from './admin.service';
import type {
  AdminInstructorRecord,
  AdminInstructorRow,
  AuthEmailUpdate,
  UserRole,
} from './admin.types';

const INSTRUCTOR_ID = '11111111-1111-4111-8111-111111111111';
const AUTH_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_AUTH_ID = '33333333-3333-4333-8333-333333333333';
const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const OLD = 'jane@example.com';
const NEW = 'jane.snow@example.org';
const OLD_TOKEN = 'O'.repeat(43);
const DAY_MS = 24 * 60 * 60 * 1000;

function makeRow(over: Partial<AdminInstructorRow> = {}): AdminInstructorRow {
  return {
    id: INSTRUCTOR_ID,
    auth_user_id: AUTH_ID,
    email: OLD,
    first_name: 'Jane',
    last_name: 'Doe',
    display_name_en: 'Jane',
    display_name_zh: null,
    bio_en: null,
    bio_zh: null,
    date_of_birth: null,
    profile_photo_url: null,
    min_student_age: 5,
    display_order: null,
    preferred_language: 'zh-CN',
    approval_status: 'pending',
    is_active: true,
    inserted_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

class InMemoryAuthRepository {
  readonly rows = new Map<string, AdminInstructorRow>();
  readonly users = new Map<string, { email: string; role: UserRole | null }>();
  readonly sessions = new Map<string, number>();
  readonly calls: string[] = [];
  updateResult: AuthEmailUpdate | null = null;
  revokeError: Error | null = null;

  findInstructorById(id: string): Promise<AdminInstructorRow | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row ? { ...row } : null);
  }

  getUserRole(authUserId: string) {
    const user = this.users.get(authUserId);
    return Promise.resolve(
      user ? { found: true, role: user.role } : { found: false, role: null },
    );
  }

  findAuthUserIdByEmail(email: string): Promise<string | null> {
    const match = [...this.users].find(
      ([, user]) => user.email.toLowerCase() === email,
    );
    return Promise.resolve(match?.[0] ?? null);
  }

  updateAuthEmail(authUserId: string, email: string): Promise<AuthEmailUpdate> {
    this.calls.push(`updateAuthEmail ${email}`);
    if (this.updateResult) {
      return Promise.resolve(this.updateResult);
    }
    const taken = [...this.users].some(
      ([id, user]) => id !== authUserId && user.email.toLowerCase() === email,
    );
    if (taken) {
      return Promise.reject(
        new InternalServerErrorException('Error updating user'),
      );
    }
    this.users.get(authUserId)!.email = email;
    for (const row of this.rows.values()) {
      if (row.auth_user_id === authUserId) {
        this.rows.set(row.id, { ...row, email });
      }
    }
    return Promise.resolve('updated');
  }

  revokeSessions(authUserId: string): Promise<number> {
    this.calls.push('revokeSessions');
    if (this.revokeError) {
      return Promise.reject(this.revokeError);
    }
    const count = this.sessions.get(authUserId) ?? 0;
    this.sessions.set(authUserId, 0);
    return Promise.resolve(count);
  }
}

async function build({
  row = makeRow(),
  role = null,
}: { row?: AdminInstructorRow; role?: UserRole | null } = {}) {
  const repo = new InMemoryAuthRepository();
  repo.rows.set(row.id, row);
  repo.users.set(row.auth_user_id, { email: row.email, role });
  repo.users.set(OTHER_AUTH_ID, { email: 'Taken@Example.org', role: 'admin' });
  repo.users.set(ADMIN_ID, { email: 'admin@example.com', role: 'admin' });
  repo.sessions.set(row.auth_user_id, 2);

  const mails: SendEmailRequest[] = [];
  const mailer = {
    send: (req: SendEmailRequest) => {
      mails.push(req);
      return Promise.resolve('sent' as const);
    },
    portalLink: (path: string) => `https://portal.test${path}`,
  };
  const audit = recordingAudit();
  const invites = new InMemoryInvitesRepository();
  const auth: ActivationAuth = {
    findEmail: (id: string) =>
      Promise.resolve(repo.users.get(id)?.email ?? null),
    magicLinkTokenHash: (email: string) => Promise.resolve(`otp:${email}`),
  };
  const activation = new ActivationService(
    invites,
    auth,
    new InviteDispatcher(invites, mailer),
    { assignPublished: jest.fn() } as unknown as DocumentOnboardingService,
    new InMemoryResendCooldownRepository(),
    audit as unknown as AuditService,
  );

  const app = await startAdminApp(
    Test.createTestingModule({
      controllers: [AdminInstructorEmailController],
      providers: [
        AdminInstructorEmailService,
        AdminService,
        { provide: AdminRepository, useValue: repo },
        { provide: ActivationService, useValue: activation },
        { provide: AuditService, useValue: audit },
        { provide: MailerService, useValue: mailer },
        { provide: InstructorsService, useValue: {} },
        { provide: DocumentOnboardingService, useValue: {} },
        { provide: GoLiveService, useValue: {} },
        { provide: BIO_TRANSLATOR, useValue: {} },
      ],
    }),
  );
  return { app, repo, mails, audit, invites, activation };
}

function seedInvite(
  invites: InMemoryInvitesRepository,
  over: Partial<InviteRecipient> = {},
): InviteRecipient {
  return invites.seed({
    instructor_id: INSTRUCTOR_ID,
    auth_user_id: AUTH_ID,
    email: OLD,
    token_hash: hashInviteToken(OLD_TOKEN),
    sent_at: '2026-10-20T00:00:00Z',
    expires_at: '2026-11-19T00:00:00Z',
    display_name_en: 'Jane',
    preferred_language: 'zh-CN',
    ...over,
  });
}

function tokenOf(mail: SendEmailRequest): string {
  const vars = mail.vars as { activateUrl: string };
  return new URL(vars.activateUrl).searchParams.get('t')!;
}

describe('PATCH /admin/instructors/:id/email', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const patch = (
    body: Record<string, unknown>,
    { id = INSTRUCTOR_ID, auth = ADMIN_AUTH } = {},
  ) =>
    request(ctx.app.getHttpServer())
      .patch(`/admin/instructors/${id}/email`)
      .set('Authorization', auth)
      .send(body);
  const change = (email = NEW, expectedCurrentEmail = OLD) =>
    patch({ email, expectedCurrentEmail });

  afterEach(async () => {
    await ctx.app.close();
  });

  it('needs an admin JWT', async () => {
    ctx = await build();
    await request(ctx.app.getHttpServer())
      .patch(`/admin/instructors/${INSTRUCTOR_ID}/email`)
      .send({ email: NEW, expectedCurrentEmail: OLD })
      .expect(401);
    await patch(
      { email: NEW, expectedCurrentEmail: OLD },
      { auth: INSTRUCTOR_AUTH },
    ).expect(403);
    expect(ctx.repo.calls).toEqual([]);
    expect(ctx.repo.users.get(AUTH_ID)?.email).toBe(OLD);
  });

  it.each([
    [{ email: 'not-an-email', expectedCurrentEmail: OLD }],
    [{ email: NEW }],
    [{ email: NEW, expectedCurrentEmail: '' }],
    [{ email: NEW, expectedCurrentEmail: OLD, revokeSessions: 'no' }],
    [{ email: NEW, expectedCurrentEmail: OLD, role: 'admin' }],
  ])('rejects an invalid body %j with 400', async (body) => {
    ctx = await build();
    await patch(body).expect(400);
    expect(ctx.repo.calls).toEqual([]);
  });

  it('rejects a malformed id with 400 and an unknown one with 404', async () => {
    ctx = await build();
    await patch(
      { email: NEW, expectedCurrentEmail: OLD },
      { id: 'nope' },
    ).expect(400);
    await patch(
      { email: NEW, expectedCurrentEmail: OLD },
      { id: UNKNOWN_ID },
    ).expect(404);
  });

  it('changes the sign-in email, signs the instructor out, notifies both addresses and audits masked addresses', async () => {
    ctx = await build();

    const res = await change(
      '  Jane.Snow@Example.ORG ',
      'JANE@example.com',
    ).expect(200);

    expect((res.body as AdminInstructorRecord).email).toBe(NEW);
    expect(ctx.repo.users.get(AUTH_ID)?.email).toBe(NEW);
    expect(ctx.repo.sessions.get(AUTH_ID)).toBe(0);
    expect(ctx.mails).toEqual([
      expect.objectContaining({
        template: 'email_changed.old_address',
        to: OLD,
        language: 'zh-CN',
        vars: { displayName: 'Jane', oldEmail: OLD, newEmail: NEW },
        mode: 'background',
        instructorId: INSTRUCTOR_ID,
        authUserId: AUTH_ID,
      }),
      expect.objectContaining({
        template: 'email_changed.new_address',
        to: NEW,
        vars: {
          displayName: 'Jane',
          newEmail: NEW,
          loginUrl: 'https://portal.test/login',
        },
      }),
    ]);
    expect(ctx.audit.entries).toEqual([
      {
        action: 'instructor.email_change',
        actor: { userId: ADMIN_ID, role: 'admin', userAgent: null },
        targetType: 'instructor',
        targetId: INSTRUCTOR_ID,
        metadata: {
          from: 'j***e@example.com',
          to: 'j***w@example.org',
          sessionsRevoked: 2,
          invitesMoved: 0,
          invitesReissued: 0,
        },
      },
    ]);
    expect(JSON.stringify(ctx.audit.entries)).not.toContain(NEW);
  });

  it('keeps sessions when asked to', async () => {
    ctx = await build();
    await patch({
      email: NEW,
      expectedCurrentEmail: OLD,
      revokeSessions: false,
    }).expect(200);
    expect(ctx.repo.calls).not.toContain('revokeSessions');
    expect(ctx.repo.sessions.get(AUTH_ID)).toBe(2);
    expect(ctx.audit.entries[0].metadata).toMatchObject({
      sessionsRevoked: null,
    });
  });

  it('re-issues a sent, unactivated invite to the new address so the old link stops working', async () => {
    ctx = await build();
    seedInvite(ctx.invites);
    await expect(ctx.activation.redeem(OLD_TOKEN)).resolves.toMatchObject({
      email: OLD,
    });

    await change().expect(200);

    await expect(ctx.activation.redeem(OLD_TOKEN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const invite = ctx.mails.find((m) => m.template === 'invite.season')!;
    expect(invite).toMatchObject({ to: NEW, mode: 'background' });
    await expect(ctx.activation.redeem(tokenOf(invite))).resolves.toEqual({
      email: NEW,
      tokenHash: `otp:${NEW}`,
    });
    const [stored] = ctx.invites.rows.values();
    expect(stored.email).toBe(NEW);
    expect(new Date(stored.expires_at!).getTime()).toBeGreaterThan(
      Date.now() + 29 * DAY_MS,
    );
    expect(ctx.audit.entries[0].metadata).toMatchObject({
      invitesMoved: 1,
      invitesReissued: 1,
    });
  });

  it('moves an unsent invite and kills the link of an activated one without emailing either', async () => {
    ctx = await build();
    const unsent = seedInvite(ctx.invites, {
      season: '2027/28',
      token_hash: null,
      sent_at: null,
      expires_at: null,
    });
    const activated = seedInvite(ctx.invites, {
      activated_at: '2026-10-21T00:00:00Z',
    });

    await change().expect(200);

    expect(ctx.invites.rows.get(unsent.id)).toMatchObject({
      email: NEW,
      token_hash: null,
    });
    expect(ctx.invites.rows.get(activated.id)).toMatchObject({
      email: NEW,
      expires_at: activated.expires_at,
    });
    expect(ctx.invites.rows.get(activated.id)?.token_hash).not.toBe(
      activated.token_hash,
    );
    await expect(ctx.activation.redeem(OLD_TOKEN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(ctx.mails.map((m) => m.template)).toEqual([
      'email_changed.old_address',
      'email_changed.new_address',
    ]);
  });

  it('returns 409 email_taken when another account holds the address in any case, changing nothing', async () => {
    ctx = await build();
    const res = await change('taken@EXAMPLE.org').expect(409);
    expect(res.body).toMatchObject({ code: 'email_taken' });
    expect(ctx.repo.calls).toEqual([]);
    expect(ctx.mails).toEqual([]);
    expect(ctx.audit.entries).toEqual([]);
  });

  it('maps a GoTrue email_exists answer to the same 409', async () => {
    ctx = await build();
    ctx.repo.updateResult = 'taken';
    const res = await change().expect(409);
    expect(res.body).toMatchObject({ code: 'email_taken' });
    expect(ctx.mails).toEqual([]);
    expect(ctx.audit.entries).toEqual([]);
  });

  it('passes other GoTrue failures through without notifying or auditing', async () => {
    ctx = await build();
    jest
      .spyOn(ctx.repo, 'updateAuthEmail')
      .mockRejectedValueOnce(new InternalServerErrorException('gotrue down'));
    await change().expect(500);
    ctx.repo.updateResult = 'invalid';
    await change().expect(400);
    expect(ctx.repo.calls).not.toContain('revokeSessions');
    expect(ctx.mails).toEqual([]);
    expect(ctx.audit.entries).toEqual([]);
  });

  it('returns 409 email_taken when GoTrue fails because the address was taken meanwhile', async () => {
    ctx = await build();
    jest.spyOn(ctx.repo, 'findAuthUserIdByEmail').mockResolvedValueOnce(null);
    const res = await change('taken@example.org').expect(409);
    expect(res.body).toMatchObject({ code: 'email_taken' });
    expect(ctx.repo.users.get(AUTH_ID)?.email).toBe(OLD);
  });

  it('returns 409 stale_email when the form saw an older address', async () => {
    ctx = await build();
    const res = await change(NEW, 'someone.else@example.com').expect(409);
    expect(res.body).toMatchObject({ code: 'stale_email' });
    expect(ctx.repo.calls).toEqual([]);
  });

  it('refuses a no-op with 400', async () => {
    ctx = await build();
    await change(OLD.toUpperCase(), OLD).expect(400);
    expect(ctx.repo.calls).toEqual([]);
    expect(ctx.audit.entries).toEqual([]);
  });

  it('refuses admin accounts and the caller themself with 403', async () => {
    ctx = await build({ role: 'admin' });
    const admin = await change().expect(403);
    expect(admin.body).toMatchObject({ code: 'admin_target' });
    await ctx.app.close();

    ctx = await build({ row: makeRow({ auth_user_id: ADMIN_ID }) });
    const self = await change().expect(403);
    expect(self.body).toMatchObject({ code: 'self_target' });
    expect(ctx.repo.calls).toEqual([]);
  });

  it('reports a failed sign-out as incomplete and finishes it on an identical retry', async () => {
    ctx = await build();
    seedInvite(ctx.invites);
    ctx.repo.revokeError = new InternalServerErrorException('rpc down');

    const first = await change().expect(500);
    expect(first.body).toMatchObject({
      code: 'email_change_incomplete',
      failed: ['sessions'],
    });
    expect(ctx.repo.users.get(AUTH_ID)?.email).toBe(NEW);
    expect(ctx.audit.entries[0].metadata).toMatchObject({
      sessionsRevoked: null,
      invitesMoved: 1,
      failed: ['sessions'],
    });
    const mailsAfterFirst = ctx.mails.length;

    ctx.repo.revokeError = null;
    const retry = await change().expect(200);

    expect((retry.body as AdminInstructorRecord).email).toBe(NEW);
    expect(ctx.repo.sessions.get(AUTH_ID)).toBe(0);
    expect(
      ctx.repo.calls.filter((c) => c.startsWith('updateAuthEmail')),
    ).toEqual([`updateAuthEmail ${NEW}`]);
    expect(ctx.mails).toHaveLength(mailsAfterFirst);
    expect(ctx.audit.entries[1].metadata).toEqual({
      resumed: true,
      to: 'j***w@example.org',
      sessionsRevoked: 2,
      invitesMoved: 0,
      invitesReissued: 0,
    });
  });

  it('keeps the old invite link dead while moving invites failed, and re-issues it on retry', async () => {
    ctx = await build();
    seedInvite(ctx.invites);
    jest
      .spyOn(ctx.invites, 'moveToEmail')
      .mockRejectedValueOnce(new Error('db down'));

    const first = await change().expect(500);
    expect(first.body).toMatchObject({ failed: ['invites'] });
    await expect(ctx.activation.redeem(OLD_TOKEN)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    await change().expect(200);

    const invite = ctx.mails.find((m) => m.template === 'invite.season')!;
    expect(invite.to).toBe(NEW);
    await expect(ctx.activation.redeem(tokenOf(invite))).resolves.toMatchObject(
      {
        email: NEW,
      },
    );
    expect(ctx.audit.entries[1].metadata).toMatchObject({
      resumed: true,
      invitesMoved: 1,
      invitesReissued: 1,
    });
  });
});
