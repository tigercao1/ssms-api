import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH as admin,
  ADMIN_USER_ID,
  certificationUploadRow,
  INSTRUCTOR_AUTH,
  INSTRUCTOR_USER_ID,
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
  InMemoryDocumentTemplatesRepository,
  InMemoryPrivateStorage,
  startDocumentsApp,
} from '../../test/helpers/documents-fakes';
import {
  seasonsProviders,
  seasonsRepo,
} from '../../test/helpers/seasons-fakes';
import {
  flushBackground,
  RecordingMailer,
} from '../../test/helpers/mailer-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { MailerService } from '../mailer/mailer.service';
import { AdminDocumentAssignmentsController } from './admin-document-assignments.controller';
import { AdminDocumentTemplatesController } from './admin-document-templates.controller';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import { DocumentAssignmentsService } from './document-assignments.service';
import { DocumentNotificationsService } from './document-notifications.service';
import { DocumentOnboardingService } from './document-onboarding.service';
import {
  AUDIENCE_NEEDS_LIVE,
  AUDIENCE_UNCHANGED,
  DocumentPublishingService,
  SEASON_REQUIRED,
} from './document-publishing.service';
import { DocumentSigningService } from './document-signing.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { DocumentTemplatesRepository } from './document-templates.repository';
import {
  DocumentTemplatesService,
  TEMPLATE_LOCKED,
} from './document-templates.service';
import type { DocumentTemplateRow, TemplateFieldRow } from './documents.types';
import { MeDocumentsController } from './me-documents.controller';
import {
  DEACTIVATED,
  MeDocumentsService,
  PENDING_APPROVAL,
  REJECTED,
} from './me-documents.service';
import { PdfWorkQueue } from './pdf-work-queue';
import { PrivateStorageClient } from './private-storage.client';

const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const LETTER = { width: 612, height: 792, rotate: 0 as const, x: 0, y: 0 };
const SEASON = '2026/27';
const FIELD: TemplateFieldRow = {
  id: 'f_1',
  type: 'signature',
  page: 1,
  x: 72,
  y: 120,
  w: 180,
  h: 36,
  required: true,
  label_en: 'Signature',
  label_zh: null,
  prefill: null,
};

async function build(
  env: Record<string, string> = {},
  seasons = seasonsRepo('2025/26', '2026/27', '2027/28'),
) {
  const storage = new InMemoryPrivateStorage();
  const templates = new InMemoryDocumentTemplatesRepository();
  const subjects = new InMemoryDocumentSubjectsRepository();
  const assignments = new InMemoryDocumentAssignmentsRepository(
    templates,
    subjects,
  );
  const audit = recordingAudit();
  const mailer = new RecordingMailer();
  const app = await startDocumentsApp(
    Test.createTestingModule({
      controllers: [
        AdminDocumentTemplatesController,
        AdminDocumentAssignmentsController,
        MeDocumentsController,
      ],
      providers: [
        ...seasonsProviders(seasons),
        DocumentTemplatesService,
        DocumentPublishingService,
        DocumentAssignmentsService,
        MeDocumentsService,
        DocumentSigningService,
        PdfWorkQueue,
        { provide: PrivateStorageClient, useValue: storage },
        { provide: DocumentTemplatesRepository, useValue: templates },
        { provide: DocumentAssignmentsRepository, useValue: assignments },
        { provide: DocumentSubjectsRepository, useValue: subjects },
        { provide: AuditService, useValue: audit },
        {
          provide: ConfigService,
          useValue: { get: (k: string) => env[k] },
        },
        DocumentNotificationsService,
        DocumentOnboardingService,
        { provide: MailerService, useValue: mailer.asService() },
      ],
    }),
  );
  return {
    app,
    storage,
    templates,
    assignments,
    subjects,
    audit,
    mailer,
    onboarding: app.get(DocumentOnboardingService),
  };
}

describe('document publishing HTTP', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());

  afterEach(async () => {
    await ctx.app.close();
  });

  function draft(overrides: Partial<DocumentTemplateRow> = {}) {
    return ctx.templates.seed({
      status: 'draft',
      assign_to: null,
      season: null,
      source_key: 'templates/x/source.pdf',
      page_count: 1,
      pages: [LETTER],
      fields: [FIELD],
      ...overrides,
    });
  }

  const publish = (id: string, body: object) =>
    http()
      .post(`/admin/documents/templates/${id}/publish`)
      .set('Authorization', admin)
      .send(body);
  const retire = (id: string) =>
    http()
      .post(`/admin/documents/templates/${id}/retire`)
      .set('Authorization', admin);
  const changeAudience = (id: string, body: object) =>
    http()
      .post(`/admin/documents/templates/${id}/audience`)
      .set('Authorization', admin)
      .send(body);
  const preview = (id: string, season?: string) =>
    http()
      .get(`/admin/documents/templates/${id}/publish-preview`)
      .query(season ? { season } : {})
      .set('Authorization', admin);

  describe('auth', () => {
    beforeEach(async () => {
      ctx = await build({ CURRENT_SEASON: SEASON });
    });

    const routes: [string, (r: ReturnType<typeof http>) => request.Test][] = [
      [
        'GET publish-preview',
        (r) =>
          r.get(`/admin/documents/templates/${UNKNOWN_ID}/publish-preview`),
      ],
      [
        'POST publish',
        (r) =>
          r
            .post(`/admin/documents/templates/${UNKNOWN_ID}/publish`)
            .send({ assignTo: 'all' }),
      ],
      [
        'POST audience',
        (r) =>
          r
            .post(`/admin/documents/templates/${UNKNOWN_ID}/audience`)
            .send({ assignTo: 'all' }),
      ],
      [
        'POST retire',
        (r) => r.post(`/admin/documents/templates/${UNKNOWN_ID}/retire`),
      ],
    ];

    it.each(routes)('%s → 401 without a token', async (_name, send) => {
      await send(http()).expect(401);
    });

    it.each(routes)('%s → 403 for a non-admin', async (_name, send) => {
      await send(http()).set('Authorization', INSTRUCTOR_AUTH).expect(403);
    });

    it.each(routes)('%s → 404 for an unknown template', async (_name, send) => {
      await send(http()).set('Authorization', admin).expect(404);
    });
  });

  describe('state machine', () => {
    beforeEach(async () => {
      ctx = await build({ CURRENT_SEASON: SEASON });
    });

    it('goes draft → live → retired → live, and refuses the other moves', async () => {
      const t = draft();
      await retire(t.id).expect(409);

      const live = await publish(t.id, { assignTo: 'selected' }).expect(200);
      expect(live.body).toEqual({
        template: expect.objectContaining({
          id: t.id,
          status: 'live',
          assignTo: 'selected',
          season: SEASON,
          publishedAt: expect.any(String) as string,
          hasCompletedAssignments: false,
        }) as object,
        created: 0,
        skipped: 0,
      });
      expect(ctx.templates.rows.get(t.id)).toMatchObject({
        status: 'live',
        published_by: ADMIN_USER_ID,
      });
      await publish(t.id, { assignTo: 'selected' }).expect(409);

      const retired = await retire(t.id).expect(200);
      expect(retired.body).toMatchObject({ status: 'retired' });
      expect(ctx.templates.rows.get(t.id)).toMatchObject({
        status: 'retired',
      });
      await retire(t.id).expect(409);

      await publish(t.id, { assignTo: 'selected', season: '2027/28' }).expect(
        200,
      );
      expect(ctx.templates.rows.get(t.id)).toMatchObject({
        status: 'live',
        season: '2027/28',
      });

      expect(
        ctx.audit.entries.map((e) => [e.action, e.targetId, e.metadata]),
      ).toEqual([
        [
          'document_template.publish',
          t.id,
          {
            from: 'draft',
            assignTo: 'selected',
            season: SEASON,
            created: 0,
            skipped: 0,
          },
        ],
        [
          'document_template.retire',
          t.id,
          { from: 'live', assignTo: 'selected', season: SEASON },
        ],
        [
          'document_template.publish',
          t.id,
          {
            from: 'retired',
            assignTo: 'selected',
            season: '2027/28',
            created: 0,
            skipped: 0,
          },
        ],
      ]);
    });

    it('needs a PDF, a field for sign documents, and an instructor audience for all', async () => {
      const noPdf = draft({ source_key: null, page_count: null, pages: [] });
      await publish(noPdf.id, { assignTo: 'selected' }).expect(400);
      const noFields = draft({ fields: [] });
      await publish(noFields.id, { assignTo: 'selected' }).expect(400);
      const read = draft({ kind: 'read', fields: [] });
      await publish(read.id, { assignTo: 'selected' }).expect(200);
      const waiver = draft({ audience: 'customer' });
      await publish(waiver.id, { assignTo: 'all' }).expect(400);
      expect(ctx.templates.rows.get(noPdf.id)?.status).toBe('draft');
      expect(ctx.templates.rows.get(noFields.id)?.status).toBe('draft');
      expect(ctx.templates.rows.get(waiver.id)?.status).toBe('draft');
    });

    it('validates the body', async () => {
      const t = draft();
      await publish(t.id, {}).expect(400);
      await publish(t.id, { assignTo: 'everyone' }).expect(400);
      await publish(t.id, { assignTo: 'all', season: '' }).expect(400);
      await publish(t.id, { assignTo: 'all', season: 'x'.repeat(21) }).expect(
        400,
      );
      await publish(t.id, { assignTo: 'all', extra: true }).expect(400);
      expect(ctx.templates.rows.get(t.id)?.status).toBe('draft');
    });

    it('needs a season when no season is set up', async () => {
      await ctx.app.close();
      ctx = await build({}, seasonsRepo());
      const t = draft();
      await publish(t.id, { assignTo: 'all' }).expect(400, {
        statusCode: 400,
        message: SEASON_REQUIRED,
        error: 'Bad Request',
      });
      await preview(t.id).expect(400);
    });

    it('defaults to the current season and 400s an unknown one', async () => {
      await ctx.app.close();
      ctx = await build();
      const t = draft();
      await preview(t.id, '2026-27').expect(400, {
        statusCode: 400,
        message: 'Unknown season',
        error: 'Bad Request',
      });
      await publish(t.id, { assignTo: 'all', season: '2026-27' }).expect(400, {
        statusCode: 400,
        message: 'Unknown season',
        error: 'Bad Request',
      });
      expect(ctx.templates.rows.get(t.id)?.status).toBe('draft');
      const res = await publish(t.id, { assignTo: 'all' }).expect(200);
      expect(
        (res.body as { template: { season: string } }).template.season,
      ).toBe('2026/27');
    });

    it('409s when a concurrent publish already won', async () => {
      const t = draft();
      jest
        .spyOn(ctx.templates, 'updateIfStatus')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      await publish(t.id, { assignTo: 'all' }).expect(409);
      ctx.templates.rows.set(t.id, { ...t, status: 'live' });
      jest.spyOn(ctx.templates, 'findById').mockResolvedValueOnce(t);
      await retire(t.id).expect(409);
      expect(ctx.assignments.rows.size).toBe(0);
    });
  });

  describe('publishing to all instructors', () => {
    beforeEach(async () => {
      ctx = await build({ CURRENT_SEASON: SEASON });
    });

    function instructors() {
      const a = ctx.subjects.seedInstructor({ email: 'a@example.com' });
      const b = ctx.subjects.seedInstructor({ email: 'b@example.com' });
      const inactive = ctx.subjects.seedInstructor({
        email: 'inactive@example.com',
        is_active: false,
      });
      const pending = ctx.subjects.seedInstructor({
        email: 'pending@example.com',
        approval_status: 'pending',
      });
      const pending2 = ctx.subjects.seedInstructor({
        email: 'pending2@example.com',
        approval_status: 'pending',
      });
      const rejected = ctx.subjects.seedInstructor({
        email: 'rejected@example.com',
        approval_status: 'rejected',
      });
      return { a, b, inactive, pending, pending2, rejected };
    }

    it('previews the counts for the season', async () => {
      const { a } = instructors();
      const t = draft();
      ctx.assignments.seed({
        template_id: t.id,
        subject_id: a.id,
        season: SEASON,
      });
      ctx.assignments.seed({
        template_id: t.id,
        subject_id: a.id,
        season: '2025/26',
        status: 'archived',
      });
      await preview(t.id).expect(200, {
        season: SEASON,
        approvedCount: 2,
        pendingCount: 2,
        alreadyAssignedCount: 1,
      });
      await preview(t.id, '2025/26').expect(200, {
        season: '2025/26',
        approvedCount: 2,
        pendingCount: 2,
        alreadyAssignedCount: 0,
      });
      await http()
        .get(`/admin/documents/templates/${t.id}/publish-preview`)
        .query({ season: '' })
        .set('Authorization', admin)
        .expect(400);
      expect(ctx.assignments.rows.size).toBe(2);
    });

    it('assigns approved active instructors only and emails each once', async () => {
      const { a, b } = instructors();
      const t = draft({ title_en: 'Code of conduct' });
      const res = await publish(t.id, { assignTo: 'all' }).expect(200);
      expect(res.body).toMatchObject({ created: 2, skipped: 0 });
      expect(
        [...ctx.assignments.rows.values()].map((r) => [
          r.template_id,
          r.subject_id,
          r.season,
        ]),
      ).toEqual([
        [t.id, a.id, SEASON],
        [t.id, b.id, SEASON],
      ]);
      await flushBackground();
      expect(ctx.mailer.sent.map((m) => [m.template, m.to])).toEqual([
        ['documents.assigned', 'a@example.com'],
        ['documents.assigned', 'b@example.com'],
      ]);
      expect(ctx.mailer.sent[0].metadata).toEqual({
        templateIds: [t.id],
        season: SEASON,
        approved: false,
      });
    });

    it('skips instructors who already hold it', async () => {
      const { a } = instructors();
      const t = draft();
      ctx.assignments.seed({
        template_id: t.id,
        subject_id: a.id,
        season: SEASON,
      });
      const res = await publish(t.id, { assignTo: 'all' }).expect(200);
      expect(res.body).toMatchObject({ created: 1, skipped: 1 });
      await flushBackground();
      expect(ctx.mailer.sent.map((m) => m.to)).toEqual(['b@example.com']);
    });

    it('re-publishing after retire creates no duplicates and sends no repeat email', async () => {
      instructors();
      const t = draft();
      await publish(t.id, { assignTo: 'all' }).expect(200);
      await flushBackground();
      await retire(t.id).expect(200);
      expect(ctx.assignments.rows.size).toBe(2);
      const again = await publish(t.id, { assignTo: 'all' }).expect(200);
      expect(again.body).toMatchObject({ created: 0, skipped: 2 });
      await flushBackground();
      expect(ctx.assignments.rows.size).toBe(2);
      expect(ctx.mailer.sent).toHaveLength(2);
    });

    it('selected assigns nobody and emails nobody', async () => {
      instructors();
      const t = draft();
      await publish(t.id, { assignTo: 'selected' }).expect(200);
      await flushBackground();
      expect(ctx.assignments.rows.size).toBe(0);
      expect(ctx.mailer.sent).toHaveLength(0);
    });

    it('selected with instructorIds assigns and emails exactly those instructors', async () => {
      const { a, pending } = instructors();
      const t = draft({ title_en: 'Safety policy' });
      ctx.assignments.seed({
        template_id: t.id,
        subject_id: a.id,
        season: SEASON,
      });
      const res = await publish(t.id, {
        assignTo: 'selected',
        instructorIds: [a.id, pending.id, pending.id],
      }).expect(200);
      expect(res.body).toMatchObject({
        created: 1,
        skipped: 1,
        template: { status: 'live', assignTo: 'selected', assignedCount: 2 },
      });
      expect(
        [...ctx.assignments.rows.values()].map((r) => r.subject_id),
      ).toEqual([a.id, pending.id]);
      await flushBackground();
      expect(ctx.mailer.sent.map((m) => [m.template, m.to])).toEqual([
        ['documents.assigned', 'pending@example.com'],
      ]);
      expect(ctx.audit.entries.at(-1)?.metadata).toMatchObject({
        assignTo: 'selected',
        created: 1,
        skipped: 1,
      });
    });

    it('selected with an empty instructorIds assigns nobody', async () => {
      instructors();
      const t = draft();
      await publish(t.id, { assignTo: 'selected', instructorIds: [] })
        .expect(200)
        .expect((res) => {
          expect(res.body).toMatchObject({ created: 0, skipped: 0 });
        });
      expect(ctx.assignments.rows.size).toBe(0);
    });

    it('rejects instructorIds with all, unknown ids, bad uuids and customer documents without publishing', async () => {
      const { a } = instructors();
      const t = draft();
      await publish(t.id, { assignTo: 'all', instructorIds: [a.id] }).expect(
        400,
      );
      await publish(t.id, { assignTo: 'all', instructorIds: [] }).expect(400);
      await publish(t.id, {
        assignTo: 'selected',
        instructorIds: [a.id, UNKNOWN_ID],
      })
        .expect(400)
        .expect((res) => {
          expect((res.body as { message: string }).message).toContain(
            UNKNOWN_ID,
          );
        });
      await publish(t.id, {
        assignTo: 'selected',
        instructorIds: ['not-a-uuid'],
      }).expect(400);
      await publish(t.id, { assignTo: 'selected', instructorIds: a.id }).expect(
        400,
      );
      const waiver = draft({ audience: 'customer' });
      await publish(waiver.id, {
        assignTo: 'selected',
        instructorIds: [a.id],
      }).expect(400);
      expect(ctx.templates.rows.get(t.id)?.status).toBe('draft');
      expect(ctx.templates.rows.get(waiver.id)?.status).toBe('draft');
      expect(ctx.assignments.rows.size).toBe(0);
      await flushBackground();
      expect(ctx.mailer.sent).toHaveLength(0);
    });

    it('limits manual Assign to live templates', async () => {
      const { a } = instructors();
      const t = draft();
      const assign = () =>
        http()
          .post('/admin/documents/assignments')
          .set('Authorization', admin)
          .send({ templateId: t.id, season: SEASON, instructorIds: [a.id] });
      await assign().expect(400);
      await publish(t.id, { assignTo: 'selected' }).expect(200);
      await assign().expect(201);
      await retire(t.id).expect(200);
      ctx.assignments.rows.clear();
      await assign().expect(400);
      expect(ctx.assignments.rows.size).toBe(0);
    });
  });

  describe('changing the audience of a live document', () => {
    beforeEach(async () => {
      ctx = await build({ CURRENT_SEASON: SEASON });
    });

    function live(overrides: Partial<DocumentTemplateRow> = {}) {
      return draft({ status: 'live', season: SEASON, ...overrides });
    }

    it('selected → all assigns approved active instructors who lack it, emails them, and audits', async () => {
      const a = ctx.subjects.seedInstructor({ email: 'a@example.com' });
      const b = ctx.subjects.seedInstructor({ email: 'b@example.com' });
      const pending = ctx.subjects.seedInstructor({
        email: 'pending@example.com',
        approval_status: 'pending',
      });
      ctx.subjects.seedInstructor({
        email: 'inactive@example.com',
        is_active: false,
      });
      const t = live({ assign_to: 'selected', title_en: 'Safety policy' });
      ctx.assignments.seed({
        template_id: t.id,
        subject_id: a.id,
        season: SEASON,
      });
      ctx.assignments.seed({
        template_id: t.id,
        subject_id: pending.id,
        season: SEASON,
      });

      await preview(t.id, SEASON).expect(200, {
        season: SEASON,
        approvedCount: 2,
        pendingCount: 1,
        alreadyAssignedCount: 1,
      });
      const res = await changeAudience(t.id, { assignTo: 'all' }).expect(200);
      expect(res.body).toMatchObject({
        created: 1,
        skipped: 1,
        template: { status: 'live', assignTo: 'all', season: SEASON },
      });
      expect(ctx.templates.rows.get(t.id)).toMatchObject({
        status: 'live',
        assign_to: 'all',
        season: SEASON,
        updated_by: ADMIN_USER_ID,
      });
      expect(
        [...ctx.assignments.rows.values()].map((r) => r.subject_id),
      ).toEqual([a.id, pending.id, b.id]);
      await flushBackground();
      expect(ctx.mailer.sent.map((m) => [m.template, m.to])).toEqual([
        ['documents.assigned', 'b@example.com'],
      ]);
      expect(
        ctx.audit.entries.map((e) => [e.action, e.targetId, e.metadata]),
      ).toEqual([
        [
          'document_template.audience_change',
          t.id,
          {
            from: 'selected',
            assignTo: 'all',
            season: SEASON,
            created: 1,
            skipped: 1,
          },
        ],
      ]);
    });

    it('all → selected keeps every assignment and assigns and emails nobody', async () => {
      const a = ctx.subjects.seedInstructor({ email: 'a@example.com' });
      ctx.subjects.seedInstructor({ email: 'b@example.com' });
      const t = live({ assign_to: 'all' });
      ctx.assignments.seed({
        template_id: t.id,
        subject_id: a.id,
        season: SEASON,
      });
      const res = await changeAudience(t.id, { assignTo: 'selected' }).expect(
        200,
      );
      expect(res.body).toMatchObject({
        created: 0,
        skipped: 0,
        template: { assignTo: 'selected', assignedCount: 1 },
      });
      expect(ctx.templates.rows.get(t.id)?.assign_to).toBe('selected');
      expect(
        [...ctx.assignments.rows.values()].map((r) => [r.subject_id, r.status]),
      ).toEqual([[a.id, 'assigned']]);
      await flushBackground();
      expect(ctx.mailer.sent).toHaveLength(0);
      expect(ctx.audit.entries.at(-1)).toMatchObject({
        action: 'document_template.audience_change',
        metadata: { from: 'all', assignTo: 'selected', created: 0 },
      });
    });

    it('auto-assigns on approval only while the audience is all', async () => {
      const t = live({ assign_to: 'selected' });
      const first = ctx.subjects.seedInstructor();
      await ctx.onboarding.assignPublished(first.id);
      expect(ctx.assignments.rows.size).toBe(0);

      await changeAudience(t.id, { assignTo: 'all' }).expect(200);
      const second = ctx.subjects.seedInstructor();
      await ctx.onboarding.assignPublished(second.id);
      expect(
        [...ctx.assignments.rows.values()].map((r) => r.subject_id),
      ).toEqual([first.id, second.id]);

      await changeAudience(t.id, { assignTo: 'selected' }).expect(200);
      const third = ctx.subjects.seedInstructor();
      await ctx.onboarding.assignPublished(third.id);
      expect(
        [...ctx.assignments.rows.values()].map((r) => r.subject_id),
      ).toEqual([first.id, second.id]);
    });

    it('switching back to all assigns only who is still missing', async () => {
      ctx.subjects.seedInstructor({ email: 'a@example.com' });
      const t = live({ assign_to: 'selected' });
      await changeAudience(t.id, { assignTo: 'all' }).expect(200);
      await changeAudience(t.id, { assignTo: 'selected' }).expect(200);
      ctx.subjects.seedInstructor({ email: 'b@example.com' });
      const again = await changeAudience(t.id, { assignTo: 'all' }).expect(200);
      expect(again.body).toMatchObject({ created: 1, skipped: 1 });
      await flushBackground();
      expect(ctx.mailer.sent.map((m) => m.to)).toEqual([
        'a@example.com',
        'b@example.com',
      ]);
      expect(ctx.assignments.rows.size).toBe(2);
    });

    it('refuses a draft or retired document, the same audience, and all on a customer document', async () => {
      const a = ctx.subjects.seedInstructor();
      const d = draft();
      const retired = live({ status: 'retired', assign_to: 'selected' });
      for (const t of [d, retired]) {
        const res = await changeAudience(t.id, { assignTo: 'all' }).expect(409);
        expect((res.body as { message: string }).message).toBe(
          AUDIENCE_NEEDS_LIVE,
        );
      }
      const same = live({ assign_to: 'all' });
      await changeAudience(same.id, { assignTo: 'all' })
        .expect(409)
        .expect((res) => {
          expect((res.body as { message: string }).message).toBe(
            AUDIENCE_UNCHANGED,
          );
        });
      const waiver = live({ audience: 'customer', assign_to: 'selected' });
      await changeAudience(waiver.id, { assignTo: 'all' }).expect(400);
      expect(ctx.templates.rows.get(d.id)).toMatchObject({
        status: 'draft',
        assign_to: null,
      });
      expect(ctx.templates.rows.get(retired.id)?.assign_to).toBe('selected');
      expect(ctx.templates.rows.get(waiver.id)?.assign_to).toBe('selected');
      expect(
        [...ctx.assignments.rows.values()].filter((r) => r.subject_id === a.id),
      ).toHaveLength(0);
      expect(ctx.audit.entries).toHaveLength(0);
      await flushBackground();
      expect(ctx.mailer.sent).toHaveLength(0);
    });

    it('validates the body', async () => {
      const t = live({ assign_to: 'selected' });
      await changeAudience(t.id, {}).expect(400);
      await changeAudience(t.id, { assignTo: 'everyone' }).expect(400);
      await changeAudience(t.id, { assignTo: 'all', season: SEASON }).expect(
        400,
      );
      expect(ctx.templates.rows.get(t.id)?.assign_to).toBe('selected');
    });

    it('409s when the document was retired concurrently', async () => {
      ctx.subjects.seedInstructor();
      const t = live({ assign_to: 'selected' });
      jest.spyOn(ctx.templates, 'updateIfStatus').mockResolvedValueOnce(null);
      await changeAudience(t.id, { assignTo: 'all' }).expect(409);
      expect(ctx.assignments.rows.size).toBe(0);
      expect(ctx.audit.entries).toHaveLength(0);
    });

    it('falls back to CURRENT_SEASON when a live document has no season', async () => {
      ctx.subjects.seedInstructor();
      const t = live({ assign_to: 'selected', season: null });
      const res = await changeAudience(t.id, { assignTo: 'all' }).expect(200);
      expect(res.body).toMatchObject({
        created: 1,
        template: { season: SEASON },
      });
      expect([...ctx.assignments.rows.values()][0]?.season).toBe(SEASON);
    });
  });

  describe('lock once completed', () => {
    beforeEach(async () => {
      ctx = await build({ CURRENT_SEASON: SEASON });
    });

    it('409s source and field changes once an assignment is completed, but allows metadata', async () => {
      const t = ctx.templates.seed({
        source_key: 'k',
        page_count: 1,
        pages: [LETTER],
        fields: [FIELD],
      });
      const i = ctx.subjects.seedInstructor();
      ctx.assignments.seed({ template_id: t.id, subject_id: i.id });
      const uploadUrl = () =>
        http()
          .post(`/admin/documents/templates/${t.id}/source/upload-url`)
          .set('Authorization', admin)
          .send({ contentLength: 1000 });
      const confirm = () =>
        http()
          .post(`/admin/documents/templates/${t.id}/source/confirm`)
          .set('Authorization', admin);
      const putFields = () =>
        http()
          .put(`/admin/documents/templates/${t.id}/fields`)
          .set('Authorization', admin)
          .send({ fields: [] });

      await uploadUrl().expect(200);
      await putFields().expect(200);
      const list = await http()
        .get('/admin/documents/templates')
        .set('Authorization', admin)
        .expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({ id: t.id, hasCompletedAssignments: false }),
      ]);

      ctx.assignments.seed({
        template_id: t.id,
        subject_id: ctx.subjects.seedInstructor().id,
        status: 'completed',
      });
      for (const send of [uploadUrl, confirm, putFields]) {
        const res = await send().expect(409);
        expect((res.body as { message: string }).message).toBe(TEMPLATE_LOCKED);
      }
      expect(ctx.storage.presigned.filter((p) => p.op === 'PUT')).toHaveLength(
        1,
      );
      await http()
        .patch(`/admin/documents/templates/${t.id}`)
        .set('Authorization', admin)
        .send({ titleEn: 'Renamed', required: false, sortOrder: 3 })
        .expect(200);
      const one = await http()
        .get(`/admin/documents/templates/${t.id}`)
        .set('Authorization', admin)
        .expect(200);
      expect(one.body).toMatchObject({
        titleEn: 'Renamed',
        hasCompletedAssignments: true,
      });
      const listed = await http()
        .get('/admin/documents/templates')
        .set('Authorization', admin)
        .expect(200);
      expect(listed.body).toEqual([
        expect.objectContaining({ id: t.id, hasCompletedAssignments: true }),
      ]);
    });
  });

  describe('pending instructor', () => {
    async function setup(approval = 'pending') {
      ctx = await build({ CURRENT_SEASON: SEASON });
      const me = ctx.subjects.seedInstructor({
        auth_user_id: INSTRUCTOR_USER_ID,
        approval_status: approval,
      });
      ctx.subjects.certifications.set(me.id, [
        { org: 'csia', track: 'regular', level: 2 },
      ]);
      const published = {
        source_key: 'k',
        status: 'live' as const,
        assign_to: 'all' as const,
        season: SEASON,
      };
      const conduct = ctx.templates.seed({
        ...published,
        title_en: 'Code of conduct',
        title_zh: '行为准则',
        sort_order: 2,
      });
      const msl = ctx.templates.seed({
        ...published,
        title_en: 'MSL guidelines',
        kind: 'read',
        required: false,
        sort_order: 1,
      });
      ctx.templates.seed({
        ...published,
        title_en: 'Selected',
        assign_to: 'selected',
      });
      ctx.templates.seed({
        ...published,
        title_en: 'Last season',
        season: '2025/26',
      });
      ctx.templates.seed({ ...published, title_en: 'Draft', status: 'draft' });
      ctx.templates.seed({
        ...published,
        title_en: 'Retired',
        status: 'retired',
      });
      return { me, conduct, msl };
    }

    const get = () =>
      http().get('/me/documents').set('Authorization', INSTRUCTOR_AUTH);

    it('a pending instructor gets a locked preview and no rows are written', async () => {
      const { me, conduct, msl } = await setup();
      ctx.subjects.uploads.push(
        certificationUploadRow({
          instructor_id: me.id,
          review_status: 'pending',
        }),
      );
      const res = await get().expect(200);
      expect(res.body).toEqual({
        season: SEASON,
        locked: true,
        lockReason: 'pending_approval',
        items: [
          {
            type: 'document',
            assignmentId: null,
            templateId: msl.id,
            kind: 'read',
            titleEn: 'MSL guidelines',
            titleZh: null,
            descriptionEn: null,
            descriptionZh: null,
            required: false,
            status: null,
            season: SEASON,
            assignedAt: null,
            viewedAt: null,
            completedAt: null,
            dueAt: null,
          },
          expect.objectContaining({
            type: 'document',
            assignmentId: null,
            templateId: conduct.id,
            titleZh: '行为准则',
            required: true,
            status: null,
          }),
          {
            type: 'certification',
            org: 'csia',
            track: 'regular',
            level: 2,
            uploadId: null,
            reviewStatus: 'pending',
            reviewNote: null,
            validUntil: '2027-10-31',
            state: 'pending',
          },
        ],
      });
      expect(ctx.assignments.rows.size).toBe(0);
      expect(ctx.mailer.sent).toHaveLength(0);
    });

    it('a rejected instructor gets a locked checklist with no items and 403 rejected on open and complete', async () => {
      const { me, conduct } = await setup('rejected');
      ctx.subjects.uploads.push(
        certificationUploadRow({ instructor_id: me.id }),
      );
      await get().expect(200, {
        season: SEASON,
        locked: true,
        lockReason: 'rejected',
        items: [],
      });
      const row = ctx.assignments.seed({
        template_id: conduct.id,
        subject_id: me.id,
        season: SEASON,
      });
      const expected = { message: REJECTED, reason: 'rejected' };
      await http()
        .get(`/me/documents/${row.id}`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(403, expected);
      await http()
        .post(`/me/documents/${row.id}/complete`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .send({ consent: true, values: {} })
        .expect(403, expected);
      expect(ctx.assignments.rows.get(row.id)?.status).toBe('assigned');
      expect(ctx.mailer.sent).toHaveLength(0);
    });

    it.each(['approved', 'pending', 'rejected'])(
      'a deactivated %s instructor gets a locked checklist with no items and 403 deactivated on open and complete',
      async (approval) => {
        const { me, conduct } = await setup(approval);
        ctx.subjects.instructors.set(me.id, { ...me, is_active: false });
        ctx.subjects.uploads.push(
          certificationUploadRow({ instructor_id: me.id }),
        );
        await get().expect(200, {
          season: SEASON,
          locked: true,
          lockReason: 'deactivated',
          items: [],
        });
        const row = ctx.assignments.seed({
          template_id: conduct.id,
          subject_id: me.id,
          season: SEASON,
        });
        const expected = { message: DEACTIVATED, reason: 'deactivated' };
        await http()
          .get(`/me/documents/${row.id}`)
          .set('Authorization', INSTRUCTOR_AUTH)
          .expect(403, expected);
        await http()
          .post(`/me/documents/${row.id}/complete`)
          .set('Authorization', INSTRUCTOR_AUTH)
          .send({ consent: true, values: {} })
          .expect(403, expected);
        expect(ctx.assignments.rows.get(row.id)?.status).toBe('assigned');
        expect(ctx.mailer.sent).toHaveLength(0);
      },
    );

    it('previews every live all template of the current season, and nothing when none is published', async () => {
      ctx = await build();
      ctx.subjects.seedInstructor({
        auth_user_id: INSTRUCTOR_USER_ID,
        approval_status: 'pending',
      });
      await get().expect(200, {
        season: '2026/27',
        locked: true,
        lockReason: 'pending_approval',
        items: [],
      });
      ctx.templates.seed({
        source_key: 'k',
        status: 'live',
        assign_to: 'all',
        season: '2026/27',
      });
      const res = await get().expect(200);
      expect((res.body as { items: unknown[] }).items).toHaveLength(1);
    });

    it('403s pending_approval on open, complete and stays open for an approved instructor', async () => {
      const { me, conduct } = await setup();
      const row = ctx.assignments.seed({
        template_id: conduct.id,
        subject_id: me.id,
        season: SEASON,
      });
      const open = await http()
        .get(`/me/documents/${row.id}`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(403);
      expect(open.body).toEqual({
        message: PENDING_APPROVAL,
        reason: 'pending_approval',
      });
      const complete = await http()
        .post(`/me/documents/${row.id}/complete`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .send({ consent: true, values: {} })
        .expect(403);
      expect(complete.body).toEqual({
        message: PENDING_APPROVAL,
        reason: 'pending_approval',
      });
      expect(ctx.assignments.rows.get(row.id)?.status).toBe('assigned');

      ctx.subjects.instructors.set(me.id, {
        ...me,
        approval_status: 'approved',
      });
      await http()
        .get(`/me/documents/${row.id}`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200);
      const unlocked = await get().expect(200);
      expect(unlocked.body).toMatchObject({
        locked: false,
        lockReason: null,
        items: [
          expect.objectContaining({ assignmentId: row.id, status: 'viewed' }),
          expect.objectContaining({ type: 'certification' }),
        ],
      });
    });
  });
});
