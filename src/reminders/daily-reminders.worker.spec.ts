import { type INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { InMemoryCertificationUploadsRepository } from '../../test/helpers/certification-fakes';
import {
  certificationUploadRow,
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
  InMemoryDocumentTemplatesRepository,
  startDocumentsApp,
} from '../../test/helpers/documents-fakes';
import { RecordingMailer } from '../../test/helpers/mailer-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import {
  InMemoryDailyReminderRunsRepository,
  InMemoryInvitesRepository,
} from '../../test/helpers/reminders-fakes';
import {
  seasonsProviders,
  seasonsRepo,
} from '../../test/helpers/seasons-fakes';
import { InviteDispatcher } from '../activation/invite-dispatcher';
import { InviteRemindersService } from '../activation/invite-reminders.service';
import { InvitesRepository } from '../activation/invites.repository';
import { RolesGuard } from '../admin/roles.guard';
import { AuditService } from '../audit/audit.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CertificationExpiryService } from '../documents/certification-expiry.service';
import { CertificationUploadsRepository } from '../documents/certification-uploads.repository';
import { addDays } from '../documents/certification-validity';
import { DocumentAssignmentsRepository } from '../documents/document-assignments.repository';
import { DocumentNotificationsService } from '../documents/document-notifications.service';
import { DocumentRemindersAuthGuard } from '../documents/document-reminders-auth.guard';
import { DocumentRemindersService } from '../documents/document-reminders.service';
import { DocumentSubjectsRepository } from '../documents/document-subjects.repository';
import { DocumentTemplatesRepository } from '../documents/document-templates.repository';
import { InternalDocumentsController } from '../documents/internal-documents.controller';
import { MailerService } from '../mailer/mailer.service';
import { SeasonsRepository } from '../seasons/seasons.repository';
import { DailyReminderRunsRepository } from './daily-reminder-runs.repository';
import {
  DailyRemindersWorker,
  REMINDERS_LEASE_SECONDS,
  REMINDERS_TICK_MS,
  remindersHour,
  remindersScheduleEnabled,
} from './daily-reminders.worker';

const TOKEN = 'reminders-secret-123';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TORONTO_8AM = new Date('2026-10-17T12:00:00Z');
const TORONTO_10_59 = new Date('2026-10-17T14:59:59Z');
const TORONTO_11AM = new Date('2026-10-17T15:00:00Z');
const ON = { REMINDERS_SCHEDULE_ENABLED: 'true' };

async function build(
  env: Record<string, string | undefined> = ON,
  runs = new InMemoryDailyReminderRunsRepository(),
  invites = new InMemoryInvitesRepository(),
) {
  const templates = new InMemoryDocumentTemplatesRepository();
  const assignments = new InMemoryDocumentAssignmentsRepository(templates);
  const subjects = new InMemoryDocumentSubjectsRepository();
  const uploads = new InMemoryCertificationUploadsRepository(subjects);
  const mailer = new RecordingMailer();
  const config = new ConfigService({
    DOCUMENT_REMINDERS_TOKEN: TOKEN,
    ...env,
  });
  const app: INestApplication<App> = await startDocumentsApp(
    Test.createTestingModule({
      controllers: [InternalDocumentsController],
      providers: [
        ...seasonsProviders(seasonsRepo('2026/27')),
        DocumentNotificationsService,
        DocumentRemindersService,
        CertificationExpiryService,
        DocumentRemindersAuthGuard,
        RolesGuard,
        { provide: SupabaseAuthGuard, useValue: { canActivate: () => false } },
        {
          provide: InviteDispatcher,
          inject: [InvitesRepository, MailerService],
          useFactory: (repo: InvitesRepository, m: MailerService) =>
            new InviteDispatcher(repo, m),
        },
        InviteRemindersService,
        DailyRemindersWorker,
        { provide: DailyReminderRunsRepository, useValue: runs },
        { provide: InvitesRepository, useValue: invites },
        { provide: CertificationUploadsRepository, useValue: uploads },
        { provide: DocumentTemplatesRepository, useValue: templates },
        { provide: DocumentAssignmentsRepository, useValue: assignments },
        { provide: DocumentSubjectsRepository, useValue: subjects },
        { provide: AuditService, useValue: recordingAudit() },
        { provide: MailerService, useValue: mailer.asService() },
        { provide: ConfigService, useValue: config },
      ],
    }),
  );
  app.get(InviteRemindersService).sleep = () => Promise.resolve();
  const template = templates.seed({ title_en: 'Agreement' });
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
  const seedDueDocument = () => {
    const instructor = subjects.seedInstructor({ email: 'zoe@example.com' });
    return assignments.seed({
      template_id: template.id,
      subject_id: instructor.id,
      assigned_at: ago(10),
    });
  };
  const seedExpiringCertification = () => {
    const lin = subjects.seedInstructor({ email: 'lin@example.com' });
    subjects.certifications.set(lin.id, [
      { org: 'csia', track: 'regular', level: 2 },
    ]);
    subjects.uploads.push(
      certificationUploadRow({
        instructor_id: lin.id,
        valid_until: addDays('2026-10-17', 10),
      }),
    );
  };
  const seedDueInvite = () =>
    invites.seed({
      email: 'avery@example.test',
      sent_at: ago(8),
      expires_at: new Date(Date.now() + 22 * DAY).toISOString(),
    });
  const seedAll = () => {
    seedDueDocument();
    seedExpiringCertification();
    return seedDueInvite();
  };
  return {
    app,
    worker: app.get(DailyRemindersWorker),
    runs,
    invites,
    mailer,
    assignments,
    certifications: app.get(CertificationExpiryService),
    documents: app.get(DocumentRemindersService),
    seasons: app.get(SeasonsRepository),
    seedDueDocument,
    seedExpiringCertification,
    seedDueInvite,
    seedAll,
    templatesSent: () => mailer.sent.map((m) => m.template).sort(),
  };
}

describe('DailyRemindersWorker', () => {
  let ctx: Awaited<ReturnType<typeof build>> | undefined;
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;

  const summaries = () =>
    log.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('Daily reminders 20'));

  beforeEach(() => {
    jest.useFakeTimers({
      now: TORONTO_11AM,
      doNotFake: [
        'setTimeout',
        'clearTimeout',
        'setImmediate',
        'clearImmediate',
        'nextTick',
        'queueMicrotask',
      ],
    });
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });

  afterEach(async () => {
    await ctx?.app.close();
    ctx = undefined;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('configuration', () => {
    const config = (env: Record<string, string>) => new ConfigService(env);

    it.each([
      [{ NODE_ENV: 'production' }, true],
      [{}, false],
      [{ NODE_ENV: 'development' }, false],
      [{ NODE_ENV: 'production', REMINDERS_SCHEDULE_ENABLED: 'false' }, false],
      [{ NODE_ENV: 'production', REMINDERS_SCHEDULE_ENABLED: ' ' }, true],
      [{ REMINDERS_SCHEDULE_ENABLED: ' TRUE ' }, true],
      [{ REMINDERS_SCHEDULE_ENABLED: 'yes' }, false],
    ])('enabled for %j: %s', (env, expected) => {
      expect(remindersScheduleEnabled(config(env))).toBe(expected);
    });

    it.each([
      [undefined, 11],
      [' 6 ', 6],
      ['0', 0],
      ['23', 23],
      ['24', null],
      ['-1', null],
      ['10.5', null],
      ['noon', null],
    ])('REMINDERS_HOUR_TORONTO=%s gives %s', (raw, expected) => {
      expect(
        remindersHour(
          config(raw === undefined ? {} : { REMINDERS_HOUR_TORONTO: raw }),
        ),
      ).toBe(expected);
    });

    it.each([
      ['disabled', {}],
      ['given an invalid hour', { ...ON, REMINDERS_HOUR_TORONTO: '25' }],
    ])('never runs when %s', async (_name, env) => {
      ctx = await build(env);
      ctx.seedAll();
      expect(ctx.worker.scheduled()).toBe(false);
      await jest.advanceTimersByTimeAsync(2 * DAY);
      await expect(ctx.worker.tick()).resolves.toEqual({ outcome: 'off' });
      expect(ctx.runs.runs.size).toBe(0);
      expect(ctx.mailer.sent).toEqual([]);
    });
  });

  it('does not run before 11:00 Toronto, and runs at 11:00', async () => {
    jest.setSystemTime(TORONTO_10_59);
    ctx = await build();
    ctx.seedAll();

    await expect(ctx.worker.tick()).resolves.toEqual({ outcome: 'early' });
    expect(ctx.runs.runs.size).toBe(0);
    expect(ctx.mailer.sent).toEqual([]);

    jest.setSystemTime(TORONTO_11AM);
    await expect(ctx.worker.tick()).resolves.toMatchObject({
      outcome: 'ran',
      summary: { day: '2026-10-17' },
    });
    expect(ctx.templatesSent()).toEqual([
      'certification.expiring',
      'documents.reminder',
      'invite.reminder',
    ]);
  });

  it('honours REMINDERS_HOUR_TORONTO', async () => {
    jest.setSystemTime(TORONTO_8AM);
    ctx = await build({ ...ON, REMINDERS_HOUR_TORONTO: '9' });
    await expect(ctx.worker.tick()).resolves.toEqual({ outcome: 'early' });
    jest.setSystemTime(TORONTO_8AM.getTime() + HOUR);
    await expect(ctx.worker.tick()).resolves.toMatchObject({
      outcome: 'ran',
    });
  });

  it('runs once per Toronto day from its own timer, at or after 11:00', async () => {
    jest.setSystemTime(TORONTO_8AM);
    ctx = await build();
    ctx.seedAll();

    await jest.advanceTimersByTimeAsync(3 * DAY);

    expect([...ctx.runs.runs.keys()]).toEqual([
      '2026-10-17',
      '2026-10-18',
      '2026-10-19',
    ]);
    for (const run of ctx.runs.runs.values()) {
      expect(run).toMatchObject({ attempts: 1, token: null });
      expect(run.finished).not.toBeNull();
    }
    expect(summaries()).toHaveLength(3);
    expect(ctx.templatesSent()).toEqual([
      'certification.expiring',
      'documents.reminder',
      'invite.reminder',
    ]);
  });

  it('stops ticking on shutdown', async () => {
    ctx = await build();
    await ctx.app.close();
    await jest.advanceTimersByTimeAsync(REMINDERS_TICK_MS * 6);
    expect(ctx.runs.runs.size).toBe(0);
    ctx = undefined;
  });

  it('treats a second tick on the same day as a no-op', async () => {
    ctx = await build();
    ctx.seedAll();
    await expect(ctx.worker.tick()).resolves.toMatchObject({
      outcome: 'ran',
    });
    const sent = ctx.mailer.sent.length;

    ctx.seedDueDocument();
    jest.setSystemTime(TORONTO_11AM.getTime() + 8 * HOUR);
    await expect(ctx.worker.tick()).resolves.toEqual({ outcome: 'skipped' });

    expect(ctx.mailer.sent).toHaveLength(sent);
    expect(ctx.runs.runs.get('2026-10-17')?.attempts).toBe(1);
    expect(summaries()).toHaveLength(1);
  });

  it('does not run again after a restart on the same day', async () => {
    const runs = new InMemoryDailyReminderRunsRepository();
    const invites = new InMemoryInvitesRepository();
    ctx = await build(ON, runs, invites);
    ctx.seedAll();
    await ctx.worker.tick();
    await ctx.app.close();

    ctx = await build(ON, runs, invites);
    ctx.seedAll();
    await expect(ctx.worker.tick()).resolves.toEqual({ outcome: 'skipped' });
    expect(ctx.mailer.sent).toEqual([]);
  });

  it('shares one run between overlapping ticks', async () => {
    ctx = await build();
    ctx.seedAll();
    const [a, b] = await Promise.all([ctx.worker.tick(), ctx.worker.tick()]);
    expect(a).toBe(b);
    expect(ctx.mailer.sent).toHaveLength(3);
  });

  it('skips while the lock is held elsewhere', async () => {
    ctx = await build();
    ctx.seedAll();
    ctx.runs.heldElsewhere = true;

    await expect(ctx.worker.tick()).resolves.toEqual({ outcome: 'skipped' });
    expect(ctx.mailer.sent).toEqual([]);
  });

  it('skips while another machine holds the lease, and takes over once it lapses', async () => {
    ctx = await build();
    ctx.seedAll();
    ctx.runs.holdLease('2026-10-17', Date.now() + 10 * MINUTE);

    await expect(ctx.worker.tick()).resolves.toEqual({ outcome: 'skipped' });
    expect(ctx.mailer.sent).toEqual([]);

    jest.setSystemTime(TORONTO_11AM.getTime() + 10 * MINUTE);
    await expect(ctx.worker.tick()).resolves.toMatchObject({
      outcome: 'ran',
    });
    expect(ctx.mailer.sent).toHaveLength(3);
    expect(ctx.runs.runs.get('2026-10-17')?.attempts).toBe(2);
  });

  it('takes the lock for the Toronto day with a lease', async () => {
    ctx = await build();
    const tryStart = jest.spyOn(ctx.runs, 'tryStart');
    jest.setSystemTime(new Date('2026-10-18T03:30:00Z'));
    await ctx.worker.tick();
    expect(tryStart).toHaveBeenCalledWith(
      '2026-10-17',
      REMINDERS_LEASE_SECONDS,
    );
  });

  it('logs one summary line with the counts of each part and records them', async () => {
    ctx = await build();
    ctx.seedAll();
    await ctx.worker.tick();

    expect(summaries()).toEqual([
      'Daily reminders 2026-10-17: documents 1/1 due reminded in 1 email(s); ' +
        'certifications 1 expiring, 0 expired, 0 not sent; ' +
        'invites 2026/27: 1/1 due reminded, 0 failed, 0 skipped, 0 need review',
    ]);
    expect(ctx.runs.runs.get('2026-10-17')?.finished).toEqual({
      documents: { sent: 1, error: null },
      certifications: { sent: 1, error: null },
      invites: { sent: 1, error: null },
    });
  });

  it('reminds an invite once and never again on later days', async () => {
    ctx = await build();
    const invite = ctx.seedDueInvite();
    await ctx.worker.tick();
    for (let day = 1; day <= 10; day++) {
      jest.setSystemTime(TORONTO_11AM.getTime() + day * DAY);
      await expect(ctx.worker.tick()).resolves.toMatchObject({
        outcome: 'ran',
      });
    }
    expect(ctx.mailer.sentOf('invite.reminder').map((m) => m.to)).toEqual([
      invite.email,
    ]);
    expect(ctx.invites.rows.get(invite.id)?.reminded_at).toBe(
      TORONTO_11AM.toISOString(),
    );
  });

  it('skips expired, redeemed and activated invites', async () => {
    ctx = await build();
    const base = {
      sent_at: new Date(Date.now() - 8 * DAY).toISOString(),
      expires_at: new Date(Date.now() + 22 * DAY).toISOString(),
    };
    ctx.invites.seed({
      ...base,
      expires_at: new Date(Date.now() - MINUTE).toISOString(),
    });
    ctx.invites.seed({ ...base, redeemed_at: base.sent_at });
    ctx.invites.seed({ ...base, activated_at: base.sent_at });

    await expect(ctx.worker.tick()).resolves.toMatchObject({
      summary: {
        invites: {
          ok: true,
          result: { delivery: { candidates: 0, sent: 0 } },
        },
      },
    });
    expect(ctx.mailer.sentOf('invite.reminder')).toEqual([]);
  });

  it('skips invites when there is no current season', async () => {
    ctx = await build();
    ctx.seedDueInvite();
    const seasons = ctx.seasons as unknown as { rows: Map<string, unknown> };
    seasons.rows.clear();
    await ctx.worker.tick();
    expect(ctx.mailer.sentOf('invite.reminder')).toEqual([]);
    expect(summaries()[0]).toContain('invites skipped: no current season');
  });

  it.each([
    ['documents', 'remindOpenAssignments'],
    ['certifications', 'run'],
    ['invites', 'remind'],
  ] as const)(
    'still runs the other parts when %s fails, records the failure and runs the next day',
    async (failing) => {
      ctx = await build();
      ctx.seedAll();
      const target = {
        documents: [ctx.documents, 'remindOpenAssignments'],
        certifications: [ctx.certifications, 'run'],
        invites: [ctx.app.get(InviteRemindersService), 'remind'],
      }[failing] as [object, string];
      const spy = jest
        .spyOn(target[0] as Record<string, () => Promise<unknown>>, target[1])
        .mockRejectedValueOnce(new Error('db down'));

      await expect(ctx.worker.tick()).resolves.toMatchObject({
        outcome: 'ran',
        summary: { [failing]: { ok: false, error: 'db down' } },
      });
      const expected = {
        documents: 'documents.reminder',
        certifications: 'certification.expiring',
        invites: 'invite.reminder',
      };
      expect(ctx.templatesSent()).toEqual(
        Object.entries(expected)
          .filter(([part]) => part !== failing)
          .map(([, template]) => template)
          .sort(),
      );
      const finished = ctx.runs.runs.get('2026-10-17')?.finished;
      expect(finished?.[failing]).toEqual({ sent: null, error: 'db down' });
      expect(summaries()[0]).toContain(`${failing} FAILED (db down)`);

      jest.setSystemTime(TORONTO_11AM.getTime() + DAY);
      await expect(ctx.worker.tick()).resolves.toMatchObject({
        outcome: 'ran',
        summary: { [failing]: { ok: true } },
      });
      expect(spy).toHaveBeenCalledTimes(2);
    },
  );

  it('truncates long errors', async () => {
    ctx = await build();
    jest
      .spyOn(ctx.documents, 'remindOpenAssignments')
      .mockRejectedValueOnce('x'.repeat(5_000));
    await ctx.worker.tick();
    expect(
      ctx.runs.runs.get('2026-10-17')?.finished?.documents.error,
    ).toHaveLength(2_000);
  });

  it('logs failed and unfinished invite reminders by id', async () => {
    ctx = await build();
    const invite = ctx.seedDueInvite();
    const stuck = ctx.invites.seed({
      remind_claimed_at: new Date(Date.now() - DAY).toISOString(),
    });
    ctx.mailer.outcome = 'failed';
    jest
      .spyOn(ctx.mailer, 'send')
      .mockRejectedValueOnce(new Error('resend down'));

    await ctx.worker.tick();

    expect(warn).toHaveBeenCalledWith(
      `Invite reminder ${invite.id} failed: resend down`,
    );
    expect(warn).toHaveBeenCalledWith(
      `Invite reminders claimed but never marked reminded: ${stuck.id}`,
    );
    expect(ctx.invites.rows.get(invite.id)?.remind_claimed_at).toBeNull();
  });

  it('fails the tick without sending when the lock cannot be taken, and retries on the next tick', async () => {
    ctx = await build();
    ctx.seedAll();
    jest
      .spyOn(ctx.runs, 'tryStart')
      .mockRejectedValueOnce(new Error('db down'));

    await expect(ctx.worker.tick()).resolves.toEqual({
      outcome: 'failed',
      error: 'db down',
    });
    expect(ctx.mailer.sent).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      'Daily reminders could not start: db down',
    );

    await expect(ctx.worker.tick()).resolves.toMatchObject({
      outcome: 'ran',
    });
  });

  it('logs when the run cannot be recorded or lost its lease', async () => {
    ctx = await build();
    const finish = jest.spyOn(ctx.runs, 'finish');
    finish.mockRejectedValueOnce(new Error('db down'));
    await expect(ctx.worker.tick()).resolves.toMatchObject({
      outcome: 'ran',
    });
    expect(error).toHaveBeenCalledWith(
      'Could not record the daily reminders for 2026-10-17: db down',
    );

    finish.mockResolvedValueOnce(false);
    jest.setSystemTime(TORONTO_11AM.getTime() + DAY);
    await ctx.worker.tick();
    expect(warn).toHaveBeenCalledWith(
      'Daily reminders for 2026-10-18 finished after losing the lease',
    );
  });

  describe('with the manual POST /internal/documents/reminders', () => {
    const post = () =>
      request(ctx!.app.getHttpServer())
        .post('/internal/documents/reminders')
        .set('Authorization', `Bearer ${TOKEN}`);

    it('does not remind a document again after the scheduler ran today', async () => {
      ctx = await build();
      ctx.seedDueDocument();
      ctx.seedExpiringCertification();
      await ctx.worker.tick();

      jest.setSystemTime(TORONTO_11AM.getTime() + 4 * HOUR);
      const res = await post().expect(200);
      expect(res.body).toEqual({
        documents: { due: 0, reminded: 0, emails: 0 },
        certifications: { expiring: 0, expired: 0, failed: 0 },
      });
      expect(ctx.mailer.sentOf('documents.reminder')).toHaveLength(1);
      expect(ctx.mailer.sentOf('certification.expiring')).toHaveLength(1);
    });

    it('leaves nothing for the scheduler after a manual run earlier today', async () => {
      jest.setSystemTime(TORONTO_8AM);
      ctx = await build();
      const row = ctx.seedDueDocument();
      await post().expect(200);
      expect(ctx.assignments.rows.get(row.id)?.reminder_sent_at).toBe(
        TORONTO_8AM.toISOString(),
      );

      jest.setSystemTime(TORONTO_11AM);
      await expect(ctx.worker.tick()).resolves.toMatchObject({
        summary: {
          documents: { ok: true, result: { due: 0, reminded: 0 } },
        },
      });
      expect(ctx.mailer.sentOf('documents.reminder')).toHaveLength(1);
    });
  });
});
