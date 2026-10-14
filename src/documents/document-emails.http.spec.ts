import {
  type CanActivate,
  type ExecutionContext,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { InMemoryCertificationUploadsRepository } from '../../test/helpers/certification-fakes';
import {
  ADMIN_AUTH as admin,
  certificationUploadRow,
  INSTRUCTOR_AUTH,
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
  InMemoryDocumentTemplatesRepository,
  startDocumentsApp,
  UNVERIFIED_AUTH,
} from '../../test/helpers/documents-fakes';
import {
  flushBackground,
  RecordingMailer,
} from '../../test/helpers/mailer-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { RolesGuard } from '../admin/roles.guard';
import { AuditService } from '../audit/audit.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { MailerService } from '../mailer/mailer.service';
import { AdminDocumentAssignmentsController } from './admin-document-assignments.controller';
import { AdminDocumentRemindersController } from './admin-document-reminders.controller';
import { CertificationExpiryService } from './certification-expiry.service';
import { CertificationUploadsRepository } from './certification-uploads.repository';
import { addDays, torontoToday } from './certification-validity';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import { DocumentAssignmentsService } from './document-assignments.service';
import { DocumentNotificationsService } from './document-notifications.service';
import { DocumentRemindersAuthGuard } from './document-reminders-auth.guard';
import { DocumentRemindersService } from './document-reminders.service';
import { DocumentSigningService } from './document-signing.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { DocumentTemplatesRepository } from './document-templates.repository';
import { InternalDocumentsController } from './internal-documents.controller';

const TOKEN = 'reminders-secret-123';
const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const DAY = 24 * 60 * 60 * 1000;

/** Stands in for the JWT guard the reminders guard falls back to. */
class FakeJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const who = /^Bearer jwt-(\w+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!who) {
      throw new UnauthorizedException();
    }
    (req as Request & { user: unknown }).user = {
      sub: who,
      app_metadata: who === 'admin' ? { role: 'admin' } : {},
    };
    return true;
  }
}

const daysAgo = (days: number) =>
  new Date(Date.now() - days * DAY).toISOString();

async function build(env: Record<string, string | undefined> = {}) {
  const templates = new InMemoryDocumentTemplatesRepository();
  const assignments = new InMemoryDocumentAssignmentsRepository(templates);
  const subjects = new InMemoryDocumentSubjectsRepository();
  const uploads = new InMemoryCertificationUploadsRepository(subjects);
  const audit = recordingAudit();
  const mailer = new RecordingMailer();
  const app = await startDocumentsApp(
    Test.createTestingModule({
      controllers: [
        AdminDocumentAssignmentsController,
        AdminDocumentRemindersController,
        InternalDocumentsController,
      ],
      providers: [
        DocumentAssignmentsService,
        DocumentNotificationsService,
        DocumentRemindersService,
        CertificationExpiryService,
        { provide: CertificationUploadsRepository, useValue: uploads },
        DocumentRemindersAuthGuard,
        { provide: DocumentSigningService, useValue: {} },
        { provide: SupabaseAuthGuard, useClass: FakeJwtGuard },
        RolesGuard,
        { provide: DocumentTemplatesRepository, useValue: templates },
        { provide: DocumentAssignmentsRepository, useValue: assignments },
        { provide: DocumentSubjectsRepository, useValue: subjects },
        { provide: AuditService, useValue: audit },
        { provide: MailerService, useValue: mailer.asService() },
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      ],
    }),
  );
  const template = templates.seed({
    source_key: 'templates/x/source.pdf',
    page_count: 1,
    title_en: 'Agreement',
  });
  return {
    app,
    templates,
    assignments,
    subjects,
    audit,
    mailer,
    template,
  };
}

describe('documents emails and reminders HTTP', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());

  let errorLog: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(async () => {
    await ctx.app.close();
    jest.restoreAllMocks();
  });

  describe('POST /admin/documents/assignments emails', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('emails each newly assigned instructor once, and nobody on a repeat', async () => {
      const a = ctx.subjects.seedInstructor({ email: 'a@example.com' });
      const b = ctx.subjects.seedInstructor({
        email: 'b@example.com',
        preferred_language: 'zh-CN',
      });
      ctx.assignments.seed({
        template_id: ctx.template.id,
        subject_id: b.id,
        season: '2026-27',
      });
      const body = {
        templateId: ctx.template.id,
        season: '2026-27',
        instructorIds: [a.id, b.id],
      };
      await http()
        .post('/admin/documents/assignments')
        .set('Authorization', admin)
        .send(body)
        .expect(201, { created: 1, skipped: 1 });
      await flushBackground();
      expect(ctx.mailer.sent).toEqual([
        expect.objectContaining({
          template: 'documents.assigned',
          to: 'a@example.com',
          metadata: { templateIds: [ctx.template.id], season: '2026-27' },
        }),
      ]);

      await http()
        .post('/admin/documents/assignments')
        .set('Authorization', admin)
        .send(body)
        .expect(201, { created: 0, skipped: 2 });
      await flushBackground();
      expect(ctx.mailer.sent).toHaveLength(1);
    });

    it('does not fail the request when an email lookup fails', async () => {
      const a = ctx.subjects.seedInstructor();
      jest
        .spyOn(ctx.subjects, 'findInstructor')
        .mockRejectedValueOnce(new Error('db down'));
      await http()
        .post('/admin/documents/assignments')
        .set('Authorization', admin)
        .send({
          templateId: ctx.template.id,
          season: '2026-27',
          instructorIds: [a.id],
        })
        .expect(201, { created: 1, skipped: 0 });
      await flushBackground();
      expect(ctx.mailer.sent).toHaveLength(0);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('db down'));
    });
  });

  describe('POST /admin/documents/assignments/:id/remind', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const remind = (id: string, auth = admin) =>
      http()
        .post(`/admin/documents/assignments/${id}/remind`)
        .set('Authorization', auth);

    it('401 without a token, 403 for non-admins', async () => {
      await http()
        .post(`/admin/documents/assignments/${UNKNOWN_ID}/remind`)
        .expect(401);
      await remind(UNKNOWN_ID, INSTRUCTOR_AUTH).expect(403);
      await remind(UNKNOWN_ID, UNVERIFIED_AUTH).expect(403);
    });

    it('202, audits, emails the instructor and stamps reminder_sent_at', async () => {
      const a = ctx.subjects.seedInstructor();
      const row = ctx.assignments.seed({
        template_id: ctx.template.id,
        subject_id: a.id,
        status: 'viewed',
      });
      const res = await remind(row.id).expect(202);
      expect(res.body).toEqual({});
      await flushBackground();
      expect(ctx.mailer.sent).toEqual([
        expect.objectContaining({
          template: 'documents.reminder',
          to: a.email,
          metadata: { assignmentIds: [row.id] },
        }),
      ]);
      expect(ctx.mailer.sent[0]).not.toHaveProperty('idempotencyKey');
      expect(ctx.assignments.rows.get(row.id)?.reminder_sent_at).toEqual(
        expect.any(String),
      );
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: 'document_assignment.remind',
          targetType: 'document_assignment',
          targetId: row.id,
          actor: expect.objectContaining({ role: 'admin' }) as unknown,
          metadata: expect.objectContaining({
            subjectId: a.id,
            previousReminderAt: null,
          }) as unknown,
        }),
      ]);
    });

    it('does not stamp reminder_sent_at when the email was not sent', async () => {
      const a = ctx.subjects.seedInstructor();
      const row = ctx.assignments.seed({
        template_id: ctx.template.id,
        subject_id: a.id,
      });
      ctx.mailer.outcome = 'failed';
      await remind(row.id).expect(202);
      await flushBackground();
      expect(ctx.assignments.rows.get(row.id)?.reminder_sent_at).toBeNull();
    });

    it('404 unknown, 409 closed, 400 customer, 400 bad id', async () => {
      const a = ctx.subjects.seedInstructor();
      await remind(UNKNOWN_ID).expect(404);
      await remind('not-a-uuid').expect(400);
      for (const status of ['completed', 'archived'] as const) {
        const row = ctx.assignments.seed({
          template_id: ctx.template.id,
          subject_id: a.id,
          status,
        });
        await remind(row.id).expect(409);
      }
      const customer = ctx.assignments.seed({
        template_id: ctx.template.id,
        subject_id: a.id,
        subject_type: 'customer',
      });
      await remind(customer.id).expect(400);
      const orphan = ctx.assignments.seed({
        template_id: ctx.template.id,
        subject_id: UNKNOWN_ID,
      });
      await remind(orphan.id).expect(404);
      await flushBackground();
      expect(ctx.mailer.sent).toHaveLength(0);
      expect(ctx.audit.entries).toHaveLength(0);
    });
  });

  describe('POST /internal/documents/reminders', () => {
    const run = (authorization?: string) => {
      const req = http().post('/internal/documents/reminders');
      return authorization ? req.set('Authorization', authorization) : req;
    };

    describe('auth', () => {
      it('accepts the bearer secret and an admin JWT', async () => {
        ctx = await build({ DOCUMENT_REMINDERS_TOKEN: TOKEN });
        const res = await run(`Bearer ${TOKEN}`).expect(200);
        expect(res.body).toEqual({
          documents: { due: 0, reminded: 0, emails: 0 },
          certifications: { expiring: 0, expired: 0, failed: 0 },
        });
        await run(admin).expect(200);
      });

      it('rejects a non-admin JWT with 403', async () => {
        ctx = await build({ DOCUMENT_REMINDERS_TOKEN: TOKEN });
        await run(INSTRUCTOR_AUTH).expect(403);
      });

      it.each([
        undefined,
        `Bearer ${TOKEN}x`,
        `Basic ${TOKEN}`,
        'Bearer short',
      ])('rejects %s with 401', async (authorization) => {
        ctx = await build({ DOCUMENT_REMINDERS_TOKEN: TOKEN });
        await run(authorization).expect(401);
      });

      it.each([undefined, '', '   '])(
        'is disabled (404) when DOCUMENT_REMINDERS_TOKEN is %j, even for admins',
        async (token) => {
          ctx = await build({ DOCUMENT_REMINDERS_TOKEN: token });
          await run(admin).expect(404);
          await run(`Bearer ${TOKEN}`).expect(404);
        },
      );
    });

    describe('selection', () => {
      beforeEach(async () => {
        ctx = await build({ DOCUMENT_REMINDERS_TOKEN: TOKEN });
      });

      it('reminds open assignments over 7 days old and not reminded in 7 days, once per instructor', async () => {
        const { template, templates, assignments, subjects } = ctx;
        const other = templates.seed({ title_en: 'Policy' });
        const retired = templates.seed({ is_active: false });
        const zoe = subjects.seedInstructor({ email: 'zoe@example.com' });
        const max = subjects.seedInstructor({ email: 'max@example.com' });
        const gone = subjects.seedInstructor({ is_active: false });
        const seed = (
          subjectId: string,
          overrides: Parameters<typeof assignments.seed>[0] extends infer P
            ? Partial<P>
            : never,
          templateId = template.id,
        ) =>
          assignments.seed({
            template_id: templateId,
            subject_id: subjectId,
            ...overrides,
          });
        const due = [
          seed(zoe.id, { assigned_at: daysAgo(10) }),
          seed(zoe.id, { assigned_at: daysAgo(8), status: 'viewed' }, other.id),
          seed(max.id, {
            assigned_at: daysAgo(30),
            reminder_sent_at: daysAgo(7.5),
          }),
        ];
        const notDue = [
          seed(max.id, { assigned_at: daysAgo(3) }, other.id),
          seed(zoe.id, {
            assigned_at: daysAgo(30),
            reminder_sent_at: daysAgo(2),
            season: '2025-26',
          }),
          seed(zoe.id, { assigned_at: daysAgo(30), status: 'completed' }),
          seed(max.id, {
            assigned_at: daysAgo(30),
            status: 'archived',
            season: '2025-26',
          }),
          seed(max.id, { assigned_at: daysAgo(30) }, retired.id),
          seed(gone.id, { assigned_at: daysAgo(30) }),
          seed(zoe.id, {
            assigned_at: daysAgo(30),
            subject_type: 'customer',
            season: '2024-25',
          }),
        ];

        const res = await run(`Bearer ${TOKEN}`).expect(200);

        expect(res.body).toEqual({
          documents: { due: 4, reminded: 3, emails: 2 },
          certifications: { expiring: 0, expired: 0, failed: 0 },
        });
        expect(
          ctx.mailer.sent.map((m) => [m.template, m.to, m.metadata]),
        ).toEqual([
          [
            'documents.reminder',
            'max@example.com',
            { assignmentIds: [due[2].id] },
          ],
          [
            'documents.reminder',
            'zoe@example.com',
            { assignmentIds: [due[0].id, due[1].id] },
          ],
        ]);
        const today = torontoToday();
        expect(ctx.mailer.sent[1].idempotencyKey).toBe(
          `documents.reminder/${zoe.id}/${today}`,
        );
        for (const row of due) {
          expect(
            Date.parse(assignments.rows.get(row.id)?.reminder_sent_at ?? ''),
          ).toBeGreaterThan(Date.now() - 60_000);
        }
        for (const row of notDue) {
          expect(assignments.rows.get(row.id)?.reminder_sent_at).toBe(
            row.reminder_sent_at,
          );
        }

        const again = await run(`Bearer ${TOKEN}`).expect(200);
        expect(again.body).toEqual({
          documents: { due: 1, reminded: 0, emails: 0 },
          certifications: { expiring: 0, expired: 0, failed: 0 },
        });
        expect(ctx.mailer.sent).toHaveLength(2);
      });

      it('leaves assignments due when their email fails or the instructor lookup throws', async () => {
        const a = ctx.subjects.seedInstructor();
        const b = ctx.subjects.seedInstructor();
        const rowA = ctx.assignments.seed({
          template_id: ctx.template.id,
          subject_id: a.id,
          assigned_at: daysAgo(9),
        });
        const rowB = ctx.assignments.seed({
          template_id: ctx.template.id,
          subject_id: b.id,
          assigned_at: daysAgo(8),
        });
        ctx.mailer.outcome = 'failed';
        jest
          .spyOn(ctx.subjects, 'findInstructor')
          .mockImplementationOnce(() => Promise.reject(new Error('db down')));

        const res = await run(`Bearer ${TOKEN}`).expect(200);

        expect(res.body).toEqual({
          documents: { due: 2, reminded: 0, emails: 0 },
          certifications: { expiring: 0, expired: 0, failed: 0 },
        });
        expect(ctx.mailer.sent).toHaveLength(1);
        expect(ctx.assignments.rows.get(rowA.id)?.reminder_sent_at).toBeNull();
        expect(ctx.assignments.rows.get(rowB.id)?.reminder_sent_at).toBeNull();
        expect(errorLog).toHaveBeenCalledWith(
          expect.stringContaining('db down'),
        );
      });

      it('emails certification expiry from the same daily run, once per stage', async () => {
        const { subjects } = ctx;
        const today = torontoToday();
        const lin = subjects.seedInstructor({ email: 'lin@example.com' });
        subjects.certifications.set(lin.id, [
          { org: 'csia', track: 'regular', level: 2 },
          { org: 'casi', track: 'park', level: 1 },
        ]);
        const expiring = certificationUploadRow({
          instructor_id: lin.id,
          valid_until: addDays(today, 10),
        });
        const expired = certificationUploadRow({
          instructor_id: lin.id,
          org: 'casi',
          track: 'park',
          valid_until: addDays(today, -2),
        });
        subjects.uploads.push(expiring, expired);

        const res = await run(`Bearer ${TOKEN}`).expect(200);

        expect(res.body).toEqual({
          documents: { due: 0, reminded: 0, emails: 0 },
          certifications: { expiring: 1, expired: 1, failed: 0 },
        });
        expect(
          ctx.mailer.sent.map((m) => [m.template, m.to, m.idempotencyKey]),
        ).toEqual([
          [
            'certification.expired',
            'lin@example.com',
            `certification.expired:${expired.id}:${expired.valid_until}`,
          ],
          [
            'certification.expiring',
            'lin@example.com',
            `certification.expiring:${expiring.id}:${expiring.valid_until}`,
          ],
        ]);

        const again = await run(`Bearer ${TOKEN}`).expect(200);
        expect(again.body).toEqual({
          documents: { due: 0, reminded: 0, emails: 0 },
          certifications: { expiring: 0, expired: 0, failed: 0 },
        });
        expect(ctx.mailer.sent).toHaveLength(2);
      });

      it('runs the certification job for the Toronto date of the given time', async () => {
        const lin = ctx.subjects.seedInstructor();
        ctx.subjects.certifications.set(lin.id, [
          { org: 'csia', track: 'regular', level: 2 },
        ]);
        ctx.subjects.uploads.push(
          certificationUploadRow({
            instructor_id: lin.id,
            valid_until: '2031-02-01',
          }),
        );
        const reminders = ctx.app.get(DocumentRemindersService);

        await expect(
          reminders.run(new Date('2031-01-02T04:59:59Z')),
        ).resolves.toMatchObject({
          certifications: { expiring: 0, expired: 0, failed: 0 },
        });
        await expect(
          reminders.run(new Date('2031-01-02T05:00:00Z')),
        ).resolves.toMatchObject({
          certifications: { expiring: 1, expired: 0, failed: 0 },
        });
        expect(ctx.mailer.sentOf('certification.expiring')).toHaveLength(1);
      });

      it('sends expiring at 22:00 Toronto on the last valid day and expired after Toronto midnight', async () => {
        const lin = ctx.subjects.seedInstructor();
        ctx.subjects.certifications.set(lin.id, [
          { org: 'csia', track: 'regular', level: 2 },
        ]);
        ctx.subjects.uploads.push(
          certificationUploadRow({
            instructor_id: lin.id,
            valid_until: '2026-10-13',
          }),
        );
        const reminders = ctx.app.get(DocumentRemindersService);

        await expect(
          reminders.run(new Date('2026-10-14T02:00:00Z')),
        ).resolves.toMatchObject({
          certifications: { expiring: 1, expired: 0, failed: 0 },
        });
        await expect(
          reminders.run(new Date('2026-10-14T03:59:59Z')),
        ).resolves.toMatchObject({
          certifications: { expiring: 0, expired: 0, failed: 0 },
        });
        await expect(
          reminders.run(new Date('2026-10-14T04:00:00Z')),
        ).resolves.toMatchObject({
          certifications: { expiring: 0, expired: 1, failed: 0 },
        });
        expect(ctx.mailer.sent.map((m) => m.template)).toEqual([
          'certification.expiring',
          'certification.expired',
        ]);
      });

      it('follows Toronto midnight across the DST change on 2026-11-01', async () => {
        const lin = ctx.subjects.seedInstructor();
        ctx.subjects.certifications.set(lin.id, [
          { org: 'csia', track: 'regular', level: 2 },
        ]);
        ctx.subjects.uploads.push(
          certificationUploadRow({
            instructor_id: lin.id,
            valid_until: '2026-11-01',
            expiry_reminder_sent_at: '2026-10-25T14:00:00Z',
          }),
        );
        const reminders = ctx.app.get(DocumentRemindersService);

        await expect(
          reminders.run(new Date('2026-11-02T04:59:59Z')),
        ).resolves.toMatchObject({
          certifications: { expiring: 0, expired: 0, failed: 0 },
        });
        await expect(
          reminders.run(new Date('2026-11-02T05:00:00Z')),
        ).resolves.toMatchObject({
          certifications: { expiring: 0, expired: 1, failed: 0 },
        });
      });
    });
  });
});
