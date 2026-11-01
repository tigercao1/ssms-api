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
import type { AuditEntry } from '../audit/audit.types';
import { BIO_TRANSLATOR } from '../bio-translation/bio-translator.interface';
import { DocumentOnboardingService } from '../documents/document-onboarding.service';
import { InstructorsService } from '../instructors/instructors.service';
import { MailerService, redactEmail } from '../mailer/mailer.service';
import type { SendEmailRequest } from '../mailer/mailer.types';
import { GoLiveService } from '../shopify-sync/go-live.service';
import { AdminInstructorEmailController } from './admin-instructor-email.controller';
import { AdminInstructorEmailService } from './admin-instructor-email.service';
import { AdminRepository } from './admin.repository';
import { AdminService } from './admin.service';
import type {
  AdminInstructorRecord,
  AdminInstructorRow,
  AuditRecord,
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

class TimedAudit {
  readonly entries: AuditEntry[] = [];
  private readonly times = new Map<AuditEntry, number>();

  record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    this.times.set(entry, Date.now());
    return Promise.resolve();
  }

  listed(action: string, targetId: string): AuditRecord[] {
    return this.entries
      .filter((e) => e.action === action && e.targetId === targetId)
      .reverse()
      .map((e) => ({
        metadata: e.metadata ?? {},
        insertedAt: new Date(this.times.get(e)!).toISOString(),
      }));
  }

  age(ms: number): void {
    for (const [entry, time] of this.times) {
      this.times.set(entry, time - ms);
    }
  }

  changes(status?: string): Record<string, unknown>[] {
    return this.entries
      .filter((e) => e.action === 'instructor.email_change')
      .map((e) => e.metadata ?? {})
      .filter((m) => status === undefined || m.status === status);
  }
}

class InMemoryAuthRepository {
  readonly rows = new Map<string, AdminInstructorRow>();
  readonly users = new Map<string, { email: string; role: UserRole | null }>();
  readonly sessions = new Map<string, number>();
  readonly calls: string[] = [];
  updateResult: AuthEmailUpdate | null = null;
  revokeError: Error | null = null;
  auditError: Error | null = null;

  constructor(private readonly audit: TimedAudit) {}

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

  findAuthEmail(authUserId: string): Promise<string | null> {
    return Promise.resolve(this.users.get(authUserId)?.email ?? null);
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

  claimInstructorEmail(
    id: string,
    fromEmail: string,
    toEmail: string,
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (row?.email !== fromEmail) {
      return Promise.resolve(false);
    }
    this.rows.set(id, { ...row, email: toEmail });
    return Promise.resolve(true);
  }

  recordAudit(entry: AuditEntry): Promise<void> {
    if (this.auditError) {
      return Promise.reject(this.auditError);
    }
    return this.audit.record(entry);
  }

  listAuditEntries(
    action: string,
    targetId: string,
    limit: number,
  ): Promise<AuditRecord[]> {
    return Promise.resolve(this.audit.listed(action, targetId).slice(0, limit));
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
  const audit = new TimedAudit();
  const repo = new InMemoryAuthRepository(audit);
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
  return { app, repo, mails, mailer, audit, invites, activation };
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

function meetInPairs<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  let arrived = 0;
  let open!: () => void;
  const both = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async (...args: A) => {
    arrived += 1;
    if (arrived === 2) {
      open();
    }
    await both;
    return fn(...args);
  };
}

type Ctx = Awaited<ReturnType<typeof build>>;

interface Crash {
  part: 'repo' | 'audit' | 'activation';
  method: string;
  when: 'before' | 'after';
  call?: number;
}

const LONG_AGO_MS = 60 * 60 * 1000;

function startDyingChange(ctx: Ctx, crash: Crash): Promise<void> {
  let died!: () => void;
  const dead = new Promise<void>((resolve) => {
    died = resolve;
  });
  const never = new Promise<never>(() => undefined);
  let gone = false;
  let calls = 0;
  const wrap = <T extends object>(part: Crash['part'], target: T): T =>
    new Proxy(target, {
      get(obj, prop, receiver) {
        const value: unknown = Reflect.get(obj, prop, receiver);
        if (typeof value !== 'function') {
          return value;
        }
        return async (...args: unknown[]) => {
          if (gone) {
            return never;
          }
          const hit =
            part === crash.part &&
            prop === crash.method &&
            ++calls === (crash.call ?? 1);
          if (hit && crash.when === 'before') {
            gone = true;
            died();
            return never;
          }
          const result: unknown = await (
            value as (...a: unknown[]) => Promise<unknown>
          ).apply(obj, args);
          if (hit) {
            gone = true;
            died();
            return never;
          }
          return result;
        };
      },
    });
  const service = new AdminInstructorEmailService(
    wrap('repo', ctx.repo) as unknown as AdminRepository,
    ctx.app.get(AdminService),
    wrap('activation', ctx.activation),
    wrap('audit', ctx.audit) as unknown as AuditService,
    ctx.mailer as unknown as MailerService,
  );
  service
    .changeEmail(
      INSTRUCTOR_ID,
      { email: NEW, expectedCurrentEmail: OLD },
      { userId: ADMIN_ID, role: 'admin', userAgent: null },
    )
    .catch(() => undefined);
  return dead;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let n = 0; n < 200 && !check(); n++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(check()).toBe(true);
}

describe('PATCH /admin/instructors/:id/email', () => {
  let ctx: Ctx;
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
    [{ email: NEW, expectedCurrentEmail: OLD, revokeSessions: false }],
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
    const attempt = {
      changeId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      changeKey: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      from: 'j***e@example.com',
      to: 'j***w@example.org',
    };
    expect(ctx.audit.entries).toEqual([
      {
        action: 'instructor.email_change',
        actor: { userId: ADMIN_ID, role: 'admin', userAgent: null },
        targetType: 'instructor',
        targetId: INSTRUCTOR_ID,
        metadata: { ...attempt, status: 'started' },
      },
      {
        action: 'instructor.email_change',
        actor: { userId: ADMIN_ID, role: 'admin', userAgent: null },
        targetType: 'instructor',
        targetId: INSTRUCTOR_ID,
        metadata: {
          ...attempt,
          status: 'completed',
          sessionsRevoked: 2,
          invitesMoved: 0,
          invitesReissued: 0,
        },
      },
    ]);
    const [started, completed] = ctx.audit.changes();
    expect(completed.changeId).toBe(started.changeId);
    expect(JSON.stringify(ctx.audit.entries)).not.toContain(NEW);
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
    expect(ctx.audit.changes('completed')).toEqual([
      expect.objectContaining({ invitesMoved: 1, invitesReissued: 1 }),
    ]);
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

  it("re-sends only the newest invite and kills an older season's link without extending it", async () => {
    ctx = await build();
    const older = seedInvite(ctx.invites, {
      season: '2025/26',
      created_at: '2025-09-01T00:00:00.000Z',
      expires_at: '2025-10-01T00:00:00Z',
    });
    const newest = seedInvite(ctx.invites, {
      token_hash: hashInviteToken('N'.repeat(43)),
      created_at: '2026-09-01T00:00:00.000Z',
    });

    await change().expect(200);

    const invites = ctx.mails.filter((m) => m.template === 'invite.season');
    expect(invites).toHaveLength(1);
    expect(invites[0].metadata).toMatchObject({ inviteId: newest.id });
    expect(ctx.invites.rows.get(older.id)).toMatchObject({
      email: NEW,
      expires_at: older.expires_at,
    });
    expect(ctx.invites.rows.get(older.id)?.token_hash).not.toBe(
      older.token_hash,
    );
    expect(ctx.audit.changes('completed')).toEqual([
      expect.objectContaining({ invitesMoved: 2, invitesReissued: 1 }),
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
    expect(ctx.audit.changes().map((m) => m.status)).toEqual([
      'started',
      'aborted',
    ]);
  });

  it('passes other GoTrue failures through without notifying, and audits the attempt as aborted', async () => {
    ctx = await build();
    jest
      .spyOn(ctx.repo, 'updateAuthEmail')
      .mockRejectedValueOnce(new InternalServerErrorException('gotrue down'));
    await change().expect(500);
    ctx.repo.updateResult = 'invalid';
    await change().expect(400);
    expect(ctx.repo.calls).not.toContain('revokeSessions');
    expect(ctx.mails).toEqual([]);
    expect(ctx.audit.changes().map((m) => [m.status, m.claimRestored])).toEqual(
      [
        ['started', undefined],
        ['aborted', true],
        ['started', undefined],
        ['aborted', true],
      ],
    );
  });

  it('carries on as a change when GoTrue answers with an error but applied it', async () => {
    ctx = await build();
    const { repo } = ctx;
    jest
      .spyOn(repo, 'updateAuthEmail')
      .mockImplementationOnce((authUserId: string, email: string) => {
        repo.users.get(authUserId)!.email = email;
        repo.rows.set(INSTRUCTOR_ID, {
          ...repo.rows.get(INSTRUCTOR_ID)!,
          email,
        });
        return Promise.reject(
          new InternalServerErrorException('gateway timeout'),
        );
      });

    const res = await change().expect(200);

    expect((res.body as AdminInstructorRecord).email).toBe(NEW);
    expect(ctx.repo.sessions.get(AUTH_ID)).toBe(0);
    expect(ctx.mails.map((m) => m.template)).toEqual([
      'email_changed.old_address',
      'email_changed.new_address',
    ]);
    expect(ctx.audit.changes('completed')).toEqual([
      expect.objectContaining({
        from: 'j***e@example.com',
        sessionsRevoked: 2,
      }),
    ]);
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
    const [incomplete] = ctx.audit.changes('incomplete');
    expect(incomplete).toMatchObject({
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
    expect(ctx.audit.changes().slice(2)).toEqual([
      {
        changeId: expect.any(String) as unknown,
        changeKey: incomplete.changeKey,
        status: 'started',
        from: 'j***e@example.com',
        to: 'j***w@example.org',
        resumed: true,
      },
      {
        changeId: expect.any(String) as unknown,
        changeKey: incomplete.changeKey,
        status: 'completed',
        from: 'j***e@example.com',
        to: 'j***w@example.org',
        resumed: true,
        sessionsRevoked: 2,
        invitesMoved: 0,
        invitesReissued: 0,
      },
    ]);
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
    expect(ctx.audit.changes('completed')).toEqual([
      expect.objectContaining({
        resumed: true,
        invitesMoved: 1,
        invitesReissued: 1,
      }),
    ]);
  });

  describe('when two requests read the same address at once', () => {
    beforeEach(async () => {
      ctx = await build();
      seedInvite(ctx.invites);
      const find = ctx.repo.findAuthUserIdByEmail.bind(
        ctx.repo,
      ) as InMemoryAuthRepository['findAuthUserIdByEmail'];
      jest
        .spyOn(ctx.repo, 'findAuthUserIdByEmail')
        .mockImplementation(meetInPairs(find));
    });

    it('lets one change to a different address through and refuses the other with 409 stale_email', async () => {
      const A = 'race-a@example.org';
      const B = 'race-b@example.org';
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => {
        answer = resolve;
      });
      const update = ctx.repo.updateAuthEmail.bind(
        ctx.repo,
      ) as InMemoryAuthRepository['updateAuthEmail'];
      jest
        .spyOn(ctx.repo, 'updateAuthEmail')
        .mockImplementationOnce(async (authUserId: string, email: string) => {
          await answered;
          return update(authUserId, email);
        });

      const responses = await Promise.all(
        [change(A), change(B)].map((req) =>
          req.then((res) => {
            answer();
            return res;
          }),
        ),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = (
        responses.find((r) => r.status === 200)!.body as AdminInstructorRecord
      ).email;
      expect(responses.find((r) => r.status === 409)!.body).toMatchObject({
        code: 'stale_email',
      });
      expect(ctx.repo.users.get(AUTH_ID)?.email).toBe(winner);
      expect(ctx.repo.rows.get(INSTRUCTOR_ID)?.email).toBe(winner);
      expect([...ctx.invites.rows.values()].map((i) => i.email)).toEqual([
        winner,
      ]);
      expect(ctx.repo.calls).toEqual([
        `updateAuthEmail ${winner}`,
        'revokeSessions',
      ]);
      expect(ctx.mails.map((m) => [m.template, m.to]).sort()).toEqual([
        ['email_changed.new_address', winner],
        ['email_changed.old_address', OLD],
        ['invite.season', winner],
      ]);
      expect(ctx.audit.changes('completed')).toEqual([
        expect.objectContaining({
          to: redactEmail(winner),
          invitesReissued: 1,
        }),
      ]);
      expect(ctx.audit.changes('stale')).toEqual([
        expect.objectContaining({ to: redactEmail(winner === A ? B : A) }),
      ]);
    });

    it('applies the same change sent twice only once, and refuses a later repeat', async () => {
      const responses = await Promise.all([change(), change()]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(responses.find((r) => r.status === 409)!.body).toMatchObject({
        code: 'stale_email',
      });
      ctx.repo.sessions.set(AUTH_ID, 1);
      const repeat = await change().expect(409);
      expect(repeat.body).toMatchObject({ code: 'stale_email' });
      expect(ctx.repo.sessions.get(AUTH_ID)).toBe(1);
      expect(ctx.repo.calls).toEqual([
        `updateAuthEmail ${NEW}`,
        'revokeSessions',
      ]);
      expect(ctx.mails.map((m) => m.template).sort()).toEqual([
        'email_changed.new_address',
        'email_changed.old_address',
        'invite.season',
      ]);
      expect(ctx.audit.changes().map((m) => m.status)).toEqual(
        expect.arrayContaining(['started', 'started', 'stale', 'completed']),
      );
      expect(ctx.audit.changes()).toHaveLength(4);
    });
  });

  it('refuses with 409 stale_email to repeat a change the expected address did not start', async () => {
    ctx = await build({ row: makeRow({ email: NEW }) });

    const res = await change(NEW, 'someone.else@example.com').expect(409);

    expect(res.body).toMatchObject({ code: 'stale_email' });
    expect(ctx.repo.calls).toEqual([]);
    expect(ctx.repo.sessions.get(AUTH_ID)).toBe(2);
    expect(ctx.audit.entries).toEqual([]);
  });

  it('finishes an incomplete change only for the address it started from', async () => {
    ctx = await build();
    ctx.repo.revokeError = new InternalServerErrorException('rpc down');
    await change().expect(500);
    ctx.repo.revokeError = null;
    const callsAfterFirst = [...ctx.repo.calls];

    for (const bogus of ['someone.else@example.com', 'joe@example.com']) {
      const res = await change(NEW, bogus).expect(409);
      expect(res.body).toMatchObject({ code: 'stale_email' });
    }
    expect(ctx.repo.calls).toEqual(callsAfterFirst);
    expect(ctx.repo.sessions.get(AUTH_ID)).toBe(2);
    expect(ctx.audit.changes()).toHaveLength(2);

    await change().expect(200);
    expect(ctx.repo.sessions.get(AUTH_ID)).toBe(0);
    await change().expect(409);
    expect(ctx.audit.changes().map((m) => m.status)).toEqual([
      'started',
      'incomplete',
      'started',
      'completed',
    ]);
  });

  it('puts the instructor email back when GoTrue refuses or fails the change', async () => {
    ctx = await build();
    ctx.repo.updateResult = 'taken';
    await change().expect(409);
    expect(ctx.repo.rows.get(INSTRUCTOR_ID)?.email).toBe(OLD);

    ctx.repo.updateResult = null;
    jest
      .spyOn(ctx.repo, 'updateAuthEmail')
      .mockRejectedValueOnce(new InternalServerErrorException('gotrue down'));
    await change().expect(500);
    expect(ctx.repo.rows.get(INSTRUCTOR_ID)?.email).toBe(OLD);

    await change().expect(200);
    expect(ctx.repo.users.get(AUTH_ID)?.email).toBe(NEW);
  });

  describe('when the API process died part way through a change', () => {
    async function expectFinished(notices: number) {
      expect(ctx.repo.users.get(AUTH_ID)?.email).toBe(NEW);
      expect(ctx.repo.rows.get(INSTRUCTOR_ID)?.email).toBe(NEW);
      expect([...ctx.invites.rows.values()].map((i) => i.email)).toEqual([NEW]);
      expect(ctx.repo.sessions.get(AUTH_ID)).toBe(0);
      expect(ctx.audit.changes('completed')).toHaveLength(1);
      const sent = (template: string) =>
        ctx.mails.filter((m) => m.template === template);
      expect(sent('email_changed.old_address').map((m) => m.to)).toEqual(
        Array<string>(notices).fill(OLD),
      );
      expect(sent('email_changed.new_address').map((m) => m.to)).toEqual(
        Array<string>(notices).fill(NEW),
      );
      const [invite] = sent('invite.season');
      expect(sent('invite.season')).toHaveLength(1);
      await expect(ctx.activation.redeem(OLD_TOKEN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        ctx.activation.redeem(tokenOf(invite)),
      ).resolves.toMatchObject({ email: NEW });
    }

    beforeEach(async () => {
      ctx = await build();
      seedInvite(ctx.invites);
    });

    it.each<[string, Crash, { gotrueFails?: boolean; notices?: number }]>([
      [
        'after writing the intent, before the claim',
        { part: 'repo', method: 'recordAudit', when: 'after' },
        {},
      ],
      [
        'after the claim, before GoTrue',
        { part: 'repo', method: 'claimInstructorEmail', when: 'after' },
        {},
      ],
      [
        'after GoTrue, before signing out',
        { part: 'repo', method: 'updateAuthEmail', when: 'after' },
        {},
      ],
      [
        'after GoTrue failed, before putting the claim back',
        {
          part: 'repo',
          method: 'claimInstructorEmail',
          when: 'before',
          call: 2,
        },
        { gotrueFails: true },
      ],
      [
        'after putting the claim back, before auditing it',
        {
          part: 'repo',
          method: 'claimInstructorEmail',
          when: 'after',
          call: 2,
        },
        { gotrueFails: true },
      ],
      [
        'after signing out, before moving invites',
        { part: 'repo', method: 'revokeSessions', when: 'after' },
        {},
      ],
      [
        'after moving invites and notifying, before the closing audit row',
        { part: 'audit', method: 'record', when: 'before' },
        { notices: 2 },
      ],
    ])(
      'finishes the change on an identical retry when it died %s',
      async (_, crash, { gotrueFails, notices = 1 }) => {
        if (gotrueFails) {
          jest
            .spyOn(ctx.repo, 'updateAuthEmail')
            .mockRejectedValueOnce(
              new InternalServerErrorException('gotrue down'),
            );
        }
        await startDyingChange(ctx, crash);
        ctx.audit.age(LONG_AGO_MS);

        const res = await change().expect(200);

        expect((res.body as AdminInstructorRecord).email).toBe(NEW);
        await expectFinished(notices);
      },
    );

    it('waits out a change that may still be in flight, then finishes it', async () => {
      await startDyingChange(ctx, {
        part: 'repo',
        method: 'claimInstructorEmail',
        when: 'after',
      });
      const reads = jest.spyOn(ctx.repo, 'listAuditEntries');

      const retry = change().then((res) => res);
      await waitFor(() => reads.mock.calls.length > 0);
      expect(ctx.repo.calls).toEqual([]);
      ctx.audit.age(LONG_AGO_MS);

      expect((await retry).status).toBe(200);
      await expectFinished(1);
    });

    it('lets a new change from the address shown win over the dead one, and refuses the dead one afterwards', async () => {
      const THIRD = 'jane.third@example.org';
      await startDyingChange(ctx, {
        part: 'repo',
        method: 'claimInstructorEmail',
        when: 'after',
      });

      await change(THIRD, NEW).expect(200);

      expect(ctx.repo.users.get(AUTH_ID)?.email).toBe(THIRD);
      expect(ctx.repo.rows.get(INSTRUCTOR_ID)?.email).toBe(THIRD);
      expect([...ctx.invites.rows.values()].map((i) => i.email)).toEqual([
        THIRD,
      ]);
      expect(ctx.repo.sessions.get(AUTH_ID)).toBe(0);
      expect(
        ctx.mails
          .filter((m) => m.template.startsWith('email_changed'))
          .map((m) => [m.template, m.to]),
      ).toEqual([
        ['email_changed.old_address', OLD],
        ['email_changed.new_address', THIRD],
      ]);

      ctx.audit.age(LONG_AGO_MS);
      const stale = await change().expect(409);
      expect(stale.body).toMatchObject({ code: 'stale_email' });
      expect(ctx.repo.users.get(AUTH_ID)?.email).toBe(THIRD);
    });
  });

  it('refuses a duplicate that arrives while the same change is still running, once it finishes', async () => {
    ctx = await build();
    seedInvite(ctx.invites);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = ctx.repo.updateAuthEmail.bind(
      ctx.repo,
    ) as InMemoryAuthRepository['updateAuthEmail'];
    jest
      .spyOn(ctx.repo, 'updateAuthEmail')
      .mockImplementationOnce(async (authUserId: string, email: string) => {
        await held;
        return update(authUserId, email);
      });
    const reads = jest.spyOn(ctx.repo, 'listAuditEntries');

    const first = change().then((res) => res);
    await waitFor(() => ctx.repo.rows.get(INSTRUCTOR_ID)?.email === NEW);
    const second = change().then((res) => res);
    await waitFor(() => reads.mock.calls.length > 0);
    release();

    expect((await first).status).toBe(200);
    const duplicate = await second;
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({ code: 'stale_email' });
    expect(ctx.mails.map((m) => m.template).sort()).toEqual([
      'email_changed.new_address',
      'email_changed.old_address',
      'invite.season',
    ]);
    expect(ctx.audit.changes().map((m) => m.status)).toEqual([
      'started',
      'completed',
    ]);
  });

  it('changes nothing when the intent cannot be written first', async () => {
    ctx = await build();
    ctx.repo.auditError = new InternalServerErrorException('audit down');

    await change().expect(500);

    expect(ctx.repo.rows.get(INSTRUCTOR_ID)?.email).toBe(OLD);
    expect(ctx.repo.users.get(AUTH_ID)?.email).toBe(OLD);
    expect(ctx.repo.calls).toEqual([]);
    expect(ctx.mails).toEqual([]);
  });
});
