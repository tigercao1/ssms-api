import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
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
  UNVERIFIED_AUTH,
} from '../../test/helpers/documents-fakes';
import {
  seasonsProviders,
  seasonsRepo,
} from '../../test/helpers/seasons-fakes';
import { RecordingMailer } from '../../test/helpers/mailer-fakes';
import { pdfFixture, pdfOfSize } from '../../test/helpers/pdf-fixtures';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { DatabaseError, PG_FOREIGN_KEY_VIOLATION } from '../database/db-result';
import { MailerService } from '../mailer/mailer.service';
import { AdminDocumentAssignmentsController } from './admin-document-assignments.controller';
import { AdminDocumentTemplatesController } from './admin-document-templates.controller';
import { torontoToday } from './certification-validity';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import { DocumentAssignmentsService } from './document-assignments.service';
import { DocumentNotificationsService } from './document-notifications.service';
import { DocumentPublishingService } from './document-publishing.service';
import { DocumentSigningService } from './document-signing.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { DocumentTemplatesRepository } from './document-templates.repository';
import { DocumentTemplatesService } from './document-templates.service';
import type { TemplateFieldRow } from './documents.types';
import { MeDocumentsController } from './me-documents.controller';
import { MeDocumentsService } from './me-documents.service';
import { PdfWorkQueue } from './pdf-work-queue';
import { PrivateStorageClient } from './private-storage.client';
import { storageKeys } from './storage-keys';
import { sha256Hex } from './template-pdf';

const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const LETTER = { width: 612, height: 792, rotate: 0 as const, x: 0, y: 0 };

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function build(
  env: Record<string, string> = {},
  seasons = seasonsRepo('2025-26', '2026-27', '2027-28'),
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
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
        DocumentNotificationsService,
        { provide: MailerService, useValue: mailer.asService() },
      ],
    }),
  );
  return { app, storage, templates, assignments, subjects, audit, mailer };
}

const field = (
  overrides: Partial<TemplateFieldRow> = {},
): TemplateFieldRow => ({
  id: 'f_1',
  type: 'signature',
  page: 1,
  x: 72,
  y: 120,
  w: 180,
  h: 36,
  required: true,
  label_en: 'Signature',
  label_zh: '签名',
  prefill: null,
  ...overrides,
});

describe('documents HTTP', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());

  afterEach(async () => {
    await ctx.app.close();
  });

  describe('auth', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const adminRoutes: [
      string,
      (r: ReturnType<typeof http>) => request.Test,
    ][] = [
      ['GET templates', (r) => r.get('/admin/documents/templates')],
      ['POST template', (r) => r.post('/admin/documents/templates').send({})],
      [
        'GET template',
        (r) => r.get(`/admin/documents/templates/${UNKNOWN_ID}`),
      ],
      [
        'PATCH template',
        (r) => r.patch(`/admin/documents/templates/${UNKNOWN_ID}`).send({}),
      ],
      [
        'DELETE template',
        (r) => r.delete(`/admin/documents/templates/${UNKNOWN_ID}`),
      ],
      [
        'POST source upload-url',
        (r) =>
          r
            .post(`/admin/documents/templates/${UNKNOWN_ID}/source/upload-url`)
            .send({ contentLength: 10 }),
      ],
      [
        'POST source confirm',
        (r) =>
          r.post(`/admin/documents/templates/${UNKNOWN_ID}/source/confirm`),
      ],
      [
        'PUT fields',
        (r) =>
          r
            .put(`/admin/documents/templates/${UNKNOWN_ID}/fields`)
            .send({ fields: [] }),
      ],
      [
        'POST assignments',
        (r) => r.post('/admin/documents/assignments').send({}),
      ],
      [
        'POST archive',
        (r) => r.post(`/admin/documents/assignments/${UNKNOWN_ID}/archive`),
      ],
      [
        'GET instructor documents',
        (r) => r.get(`/admin/instructors/${UNKNOWN_ID}/documents`),
      ],
    ];

    it.each(adminRoutes)('%s → 401 without a token', async (_name, send) => {
      await send(http()).expect(401);
    });

    it.each(adminRoutes)('%s → 403 for a non-admin', async (_name, send) => {
      await send(http()).set('Authorization', INSTRUCTOR_AUTH).expect(403);
    });

    it('GET /me/documents → 401 without a token', async () => {
      await http().get('/me/documents').expect(401);
    });

    it('GET /me/documents → 403 with an unverified email', async () => {
      await http()
        .get('/me/documents')
        .set('Authorization', UNVERIFIED_AUTH)
        .expect(403);
    });

    it('GET /me/documents → 404 without an instructor row', async () => {
      await http().get('/me/documents').set('Authorization', admin).expect(404);
    });
  });

  describe('templates', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const create = (body: object) =>
      http()
        .post('/admin/documents/templates')
        .set('Authorization', admin)
        .send(body);

    it('creates a template and audits it', async () => {
      const res = await create({
        kind: 'sign',
        audience: 'instructor',
        titleEn: ' Instructor agreement ',
        titleZh: '教练协议',
        required: true,
        sortOrder: 2,
      }).expect(201);
      expect(res.body).toMatchObject({
        kind: 'sign',
        audience: 'instructor',
        titleEn: 'Instructor agreement',
        titleZh: '教练协议',
        descriptionEn: null,
        required: true,
        status: 'draft',
        assignTo: null,
        season: null,
        publishedAt: null,
        hasCompletedAssignments: false,
        sortOrder: 2,
        hasSource: false,
        pageCount: null,
        pages: [],
        fields: [],
        sourceUrl: null,
        updatedBy: ADMIN_USER_ID,
      });
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: 'document_template.create',
          targetType: 'document_template',
          targetId: (res.body as { id: string }).id,
        }),
      ]);
      expect(res.body).not.toHaveProperty('isActive');
    });

    it('rejects invalid bodies', async () => {
      await create({
        kind: 'sign',
        audience: 'instructor',
        titleEn: 'x',
      }).expect(400);
      await create({
        kind: 'countersign',
        audience: 'instructor',
        titleEn: 'x',
        required: true,
        sortOrder: 0,
      }).expect(400);
      await create({
        kind: 'read',
        audience: 'instructor',
        titleEn: '   ',
        required: true,
        sortOrder: 0,
      }).expect(400);
    });

    it('lists summaries in sort order', async () => {
      ctx.templates.seed({ title_en: 'B', sort_order: 1 });
      ctx.templates.seed({
        title_en: 'A',
        sort_order: 1,
        fields: [field()],
        source_key: 'k',
        page_count: 1,
      });
      ctx.templates.seed({ title_en: 'Z', sort_order: 0 });
      const res = await http()
        .get('/admin/documents/templates')
        .set('Authorization', admin)
        .expect(200);
      const body = res.body as {
        titleEn: string;
        fieldCount: number;
        hasSource: boolean;
      }[];
      expect(body.map((t) => t.titleEn)).toEqual(['Z', 'A', 'B']);
      expect(body[1]).toMatchObject({ fieldCount: 1, hasSource: true });
      expect(body[1]).not.toHaveProperty('fields');
    });

    it('counts assignments for the season and approved instructors in one grouped query', async () => {
      ctx.subjects.seedInstructor();
      ctx.subjects.seedInstructor();
      ctx.subjects.seedInstructor({ approval_status: 'pending' });
      ctx.subjects.seedInstructor({ is_active: false });
      const live = ctx.templates.seed({
        title_en: 'Live',
        assign_to: 'all',
        season: '2026/27',
      });
      const retired = ctx.templates.seed({
        title_en: 'Retired',
        status: 'retired',
        season: '2025/26',
      });
      const draft = ctx.templates.seed({
        title_en: 'Draft',
        status: 'draft',
        assign_to: null,
        season: null,
      });
      const seasonless = ctx.templates.seed({
        title_en: 'Seasonless',
        status: 'retired',
        season: null,
      });
      const assign = (
        templateId: string,
        season: string | null,
        status: 'assigned' | 'viewed' | 'completed' | 'archived',
      ) =>
        ctx.assignments.seed({
          template_id: templateId,
          subject_id: randomUUID(),
          season,
          status,
        });
      assign(live.id, '2026/27', 'assigned');
      assign(live.id, '2026/27', 'viewed');
      assign(live.id, '2026/27', 'completed');
      assign(live.id, '2026/27', 'archived');
      assign(live.id, '2025/26', 'completed');
      assign(retired.id, '2025/26', 'completed');
      assign(draft.id, '2026/27', 'assigned');
      assign(seasonless.id, null, 'completed');

      const res = await http()
        .get('/admin/documents/templates')
        .set('Authorization', admin)
        .expect(200);
      const byTitle = Object.fromEntries(
        (res.body as { titleEn: string }[]).map((t) => [t.titleEn, t]),
      );
      expect(byTitle.Live).toMatchObject({
        assignedCount: 3,
        completedCount: 1,
        approvedCount: 2,
        hasCompletedAssignments: true,
      });
      expect(byTitle.Retired).toMatchObject({
        assignedCount: 1,
        completedCount: 1,
        approvedCount: 2,
        hasCompletedAssignments: true,
      });
      expect(byTitle.Draft).toMatchObject({
        assignedCount: 0,
        completedCount: 0,
        approvedCount: 0,
        hasCompletedAssignments: false,
      });
      expect(byTitle.Seasonless).toMatchObject({
        assignedCount: 0,
        completedCount: 0,
        approvedCount: 0,
        hasCompletedAssignments: true,
      });
      expect(ctx.assignments.templateStatsCalls).toEqual([
        expect.arrayContaining([live.id, retired.id, draft.id, seasonless.id]),
      ]);

      const one = await http()
        .get(`/admin/documents/templates/${live.id}`)
        .set('Authorization', admin)
        .expect(200);
      expect(one.body).toMatchObject({
        assignedCount: 3,
        completedCount: 1,
        approvedCount: 2,
      });
    });

    it('counts approved assignments only for instructors who are approved and active now', async () => {
      const approved = [
        ctx.subjects.seedInstructor(),
        ctx.subjects.seedInstructor(),
        ctx.subjects.seedInstructor(),
        ctx.subjects.seedInstructor(),
      ];
      const deactivated = ctx.subjects.seedInstructor({ is_active: false });
      const pending = ctx.subjects.seedInstructor({
        approval_status: 'pending',
      });
      const t = ctx.templates.seed({ assign_to: 'all', season: '2026/27' });
      for (const [i, instructor] of approved.entries()) {
        ctx.assignments.seed({
          template_id: t.id,
          subject_id: instructor.id,
          season: '2026/27',
          status: i === 0 ? 'completed' : 'assigned',
        });
      }
      ctx.assignments.seed({
        template_id: t.id,
        subject_id: deactivated.id,
        season: '2026/27',
        status: 'completed',
      });
      ctx.assignments.seed({
        template_id: t.id,
        subject_id: pending.id,
        season: '2026/27',
      });
      ctx.assignments.seed({
        template_id: t.id,
        subject_id: approved[1].id,
        season: '2025/26',
      });
      const expected = {
        assignedCount: 6,
        completedCount: 2,
        approvedAssignedCount: 4,
        approvedCompletedCount: 1,
        approvedCount: 4,
      };
      const list = await http()
        .get('/admin/documents/templates')
        .set('Authorization', admin)
        .expect(200);
      expect((list.body as unknown[])[0]).toMatchObject(expected);
      const one = await http()
        .get(`/admin/documents/templates/${t.id}`)
        .set('Authorization', admin)
        .expect(200);
      expect(one.body).toMatchObject(expected);
    });

    it('gets a template with a presigned source URL and camelCase fields', async () => {
      const t = ctx.templates.seed({
        source_key: storageKeys.templateSource('x'),
        page_count: 1,
        pages: [LETTER],
        fields: [field({ prefill: 'full_name' })],
      });
      const res = await http()
        .get(`/admin/documents/templates/${t.id}`)
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toMatchObject({
        sourceUrl: 'memory://GET/templates/x/source.pdf',
        pages: [LETTER],
        fields: [
          {
            id: 'f_1',
            type: 'signature',
            labelEn: 'Signature',
            labelZh: '签名',
            prefill: 'full_name',
          },
        ],
      });
      await http()
        .get(`/admin/documents/templates/${UNKNOWN_ID}`)
        .set('Authorization', admin)
        .expect(404);
      await http()
        .get('/admin/documents/templates/not-a-uuid')
        .set('Authorization', admin)
        .expect(400);
    });

    it('patches metadata, clears optional text with null, and audits the diff', async () => {
      const t = ctx.templates.seed({ title_zh: '旧' });
      const res = await http()
        .patch(`/admin/documents/templates/${t.id}`)
        .set('Authorization', admin)
        .send({ titleZh: null, sortOrder: 5 })
        .expect(200);
      expect(res.body).toMatchObject({
        titleZh: null,
        status: 'live',
        sortOrder: 5,
      });
      expect(ctx.audit.entries[0]).toMatchObject({
        action: 'document_template.update',
        metadata: {
          before: { title_zh: '旧', sort_order: 0 },
          after: { title_zh: null, sort_order: 5 },
        },
      });
      await http()
        .patch(`/admin/documents/templates/${t.id}`)
        .set('Authorization', admin)
        .send({ isActive: 'no' })
        .expect(400);
      await http()
        .patch(`/admin/documents/templates/${t.id}`)
        .set('Authorization', admin)
        .send({ status: 'retired' })
        .expect(400);
      expect(ctx.templates.rows.get(t.id)).toMatchObject({
        status: 'live',
      });
      await http()
        .patch(`/admin/documents/templates/${t.id}`)
        .set('Authorization', admin)
        .send({})
        .expect(400);
      await http()
        .patch(`/admin/documents/templates/${t.id}`)
        .set('Authorization', admin)
        .send({ kind: 'read' })
        .expect(400);
      await http()
        .patch(`/admin/documents/templates/${UNKNOWN_ID}`)
        .set('Authorization', admin)
        .send({ required: false })
        .expect(404);
    });

    it('rejects isActive in a patch and omits it from responses', async () => {
      const live = ctx.templates.seed();
      const draft = ctx.templates.seed({ status: 'draft' });
      await http()
        .patch(`/admin/documents/templates/${live.id}`)
        .set('Authorization', admin)
        .send({ isActive: false })
        .expect(400);
      await http()
        .patch(`/admin/documents/templates/${draft.id}`)
        .set('Authorization', admin)
        .send({ isActive: true, sortOrder: 7 })
        .expect(400);
      expect(ctx.templates.rows.get(live.id)).toMatchObject({ status: 'live' });
      expect(ctx.templates.rows.get(draft.id)).toMatchObject({
        status: 'draft',
        sort_order: 0,
      });
      expect(ctx.audit.entries).toEqual([]);
      const one = await http()
        .get(`/admin/documents/templates/${live.id}`)
        .set('Authorization', admin)
        .expect(200);
      expect(one.body).not.toHaveProperty('isActive');
      const list = await http()
        .get('/admin/documents/templates')
        .set('Authorization', admin)
        .expect(200);
      for (const summary of list.body as object[]) {
        expect(summary).not.toHaveProperty('isActive');
      }
    });

    it('presigns a source upload up to 20 MB', async () => {
      const t = ctx.templates.seed();
      const res = await http()
        .post(`/admin/documents/templates/${t.id}/source/upload-url`)
        .set('Authorization', admin)
        .send({ contentLength: 2048 })
        .expect(200);
      expect(res.body).toEqual({
        uploadUrl: `memory://PUT/templates/${t.id}/upload.pdf`,
        expiresAt: '2026-10-13T00:10:00.000Z',
      });
      expect(ctx.storage.presigned[0]).toEqual({
        op: 'PUT',
        key: storageKeys.templateUpload(t.id),
        input: { contentType: 'application/pdf', contentLength: 2048 },
      });
      await http()
        .post(`/admin/documents/templates/${t.id}/source/upload-url`)
        .set('Authorization', admin)
        .send({ contentLength: 20 * 1024 * 1024 + 1 })
        .expect(400);
      await http()
        .post(`/admin/documents/templates/${UNKNOWN_ID}/source/upload-url`)
        .set('Authorization', admin)
        .send({ contentLength: 10 })
        .expect(404);
    });

    describe('source confirm', () => {
      const confirm = (id: string) =>
        http()
          .post(`/admin/documents/templates/${id}/source/confirm`)
          .set('Authorization', admin);

      async function upload(fixture: Parameters<typeof pdfFixture>[0]) {
        const t = ctx.templates.seed();
        ctx.storage.seed(
          storageKeys.templateUpload(t.id),
          await pdfFixture(fixture),
        );
        return t;
      }

      it('normalises a PDF, stores it as the source and records its layout', async () => {
        const t = await upload('normal');
        const res = await confirm(t.id).expect(200);
        const stored = ctx.storage.objects.get(
          storageKeys.templateSource(t.id),
        );
        expect(stored?.contentType).toBe('application/pdf');
        const sha = sha256Hex(stored!.body);
        expect(res.body).toMatchObject({
          hasSource: true,
          pageCount: 2,
          pages: [LETTER, LETTER],
          sourceSha256: sha,
          sourceUrl: `memory://GET/templates/${t.id}/source.pdf`,
          fieldsCleared: false,
        });
        expect(ctx.storage.objects.has(storageKeys.templateUpload(t.id))).toBe(
          false,
        );
        expect(ctx.templates.rows.get(t.id)).toMatchObject({
          source_key: storageKeys.templateSource(t.id),
          source_sha256: sha,
          page_count: 2,
        });
        expect(ctx.audit.entries).toEqual([
          expect.objectContaining({
            action: 'document_template.source_replace',
            metadata: expect.objectContaining({
              beforeSha256: null,
              afterSha256: sha,
              pageCount: 2,
              fieldsCleared: false,
            }) as unknown,
          }),
        ]);
      });

      it('accepts an owner-only encrypted PDF and stores it decrypted', async () => {
        const t = await upload('ownerEncrypted');
        await confirm(t.id).expect(200);
        const stored = ctx.storage.objects.get(
          storageKeys.templateSource(t.id),
        );
        expect((await PDFDocument.load(stored!.body)).isEncrypted).toBe(false);
      });

      it('rejects a PDF that needs a user password and discards the upload', async () => {
        const t = await upload('userPassword');
        const res = await confirm(t.id).expect(400);
        expect((res.body as { message: string }).message).toMatch(/password/);
        expect(ctx.storage.deleted).toContain(storageKeys.templateUpload(t.id));
        expect(ctx.templates.rows.get(t.id)?.source_key).toBeNull();
        expect(ctx.audit.entries).toEqual([]);
      });

      it('rejects XFA forms', async () => {
        const t = await upload('xfa');
        const res = await confirm(t.id).expect(400);
        expect((res.body as { message: string }).message).toMatch(/XFA/);
      });

      it('flattens AcroForms', async () => {
        const t = await upload('acroForm');
        await confirm(t.id).expect(200);
        const stored = ctx.storage.objects.get(
          storageKeys.templateSource(t.id),
        );
        const doc = await PDFDocument.load(stored!.body);
        expect(doc.getForm().getFields()).toHaveLength(0);
      });

      it('records rotation and the offset CropBox', async () => {
        const rotated = await upload('rotated');
        const offset = await upload('offsetCropBox');
        const r1 = await confirm(rotated.id).expect(200);
        const r2 = await confirm(offset.id).expect(200);
        expect((r1.body as { pages: unknown }).pages).toEqual([
          { ...LETTER, rotate: 90 },
        ]);
        expect((r2.body as { pages: unknown }).pages).toEqual([
          { width: 540, height: 700, rotate: 0, x: 36, y: 48 },
        ]);
      });

      it('rejects a missing upload, a non-PDF content type and an oversize file', async () => {
        const t = ctx.templates.seed();
        expect(
          ((await confirm(t.id).expect(400)).body as { message: string })
            .message,
        ).toMatch(/No uploaded PDF/);
        ctx.storage.seed(
          storageKeys.templateUpload(t.id),
          await pdfFixture('normal'),
          'image/png',
        );
        expect(
          ((await confirm(t.id).expect(400)).body as { message: string })
            .message,
        ).toMatch(/application\/pdf/);
        ctx.storage.seed(
          storageKeys.templateUpload(t.id),
          Buffer.alloc(20 * 1024 * 1024 + 1),
        );
        expect(
          ((await confirm(t.id).expect(400)).body as { message: string })
            .message,
        ).toMatch(/larger than 20 MB/);
        ctx.storage.seed(
          storageKeys.templateUpload(t.id),
          Buffer.from('%PDF-1.7 garbage'),
          'application/pdf; charset=binary',
        );
        await confirm(t.id).expect(400);
        await confirm(UNKNOWN_ID).expect(404);
      });

      it('keeps placed fields when the page layout is unchanged', async () => {
        const t = ctx.templates.seed({
          source_key: storageKeys.templateSource('old'),
          source_sha256: 'b'.repeat(64),
          page_count: 2,
          pages: [LETTER, LETTER],
          fields: [field()],
        });
        ctx.storage.seed(
          storageKeys.templateUpload(t.id),
          await pdfFixture('normal'),
        );
        const res = await confirm(t.id).expect(200);
        expect(res.body).toMatchObject({ fieldsCleared: false, fieldCount: 1 });
      });

      it('clears placed fields and says so when the layout changed', async () => {
        const t = ctx.templates.seed({
          source_key: storageKeys.templateSource('old'),
          page_count: 1,
          pages: [LETTER],
          fields: [field(), field({ id: 'f_2' })],
        });
        ctx.storage.seed(
          storageKeys.templateUpload(t.id),
          await pdfOfSize([[595, 842]]),
        );
        const res = await confirm(t.id).expect(200);
        expect(res.body).toMatchObject({
          fieldsCleared: true,
          fieldCount: 0,
          fields: [],
        });
        expect(ctx.audit.entries[0].metadata).toMatchObject({
          fieldsCleared: true,
          clearedFieldCount: 2,
        });
      });
    });

    describe('fields', () => {
      const put = (id: string, fields: unknown[]) =>
        http()
          .put(`/admin/documents/templates/${id}/fields`)
          .set('Authorization', admin)
          .send({ fields });

      const apiField = {
        id: 'f_1',
        type: 'full_name',
        page: 2,
        x: 72,
        y: 100,
        w: 200,
        h: 24,
        required: true,
        labelEn: 'Full name',
        prefill: 'full_name',
      };

      it('stores fields and returns them', async () => {
        const t = ctx.templates.seed({
          page_count: 2,
          pages: [LETTER, LETTER],
          source_key: 'k',
        });
        const res = await put(t.id, [apiField]).expect(200);
        expect((res.body as { fields: unknown }).fields).toEqual([
          { ...apiField, labelZh: null },
        ]);
        expect(ctx.templates.rows.get(t.id)?.fields).toEqual([
          {
            id: 'f_1',
            type: 'full_name',
            page: 2,
            x: 72,
            y: 100,
            w: 200,
            h: 24,
            required: true,
            label_en: 'Full name',
            label_zh: null,
            prefill: 'full_name',
          },
        ]);
        expect(ctx.audit.entries[0]).toMatchObject({
          action: 'document_template.fields_update',
          metadata: { beforeCount: 0, afterCount: 1 },
        });
      });

      it('rejects fields before a source, duplicate ids, missing pages and bad shapes', async () => {
        const noSource = ctx.templates.seed();
        await put(noSource.id, [apiField]).expect(400);
        const t = ctx.templates.seed({
          page_count: 1,
          pages: [LETTER],
          source_key: 'k',
        });
        await put(t.id, [
          { ...apiField, page: 1 },
          { ...apiField, page: 1 },
        ]).expect(400);
        const offPage = await put(t.id, [apiField]).expect(400);
        expect((offPage.body as { message: string }).message).toMatch(
          /page 2, but the PDF has 1/,
        );
        await put(t.id, [{ ...apiField, page: 1, type: 'stamp' }]).expect(400);
        await put(t.id, [{ ...apiField, page: 1, w: 0 }]).expect(400);
        await put(t.id, [{ ...apiField, page: 1, labelEn: '' }]).expect(400);
        const outside = await put(t.id, [
          { ...apiField, page: 1, x: 500, w: 200 },
        ]).expect(400);
        expect((outside.body as { message: string }).message).toMatch(
          /outside page 1/,
        );
        await put(UNKNOWN_ID, []).expect(404);
      });
    });

    describe('delete', () => {
      const remove = (id: string) =>
        http()
          .delete(`/admin/documents/templates/${id}`)
          .set('Authorization', admin);

      const seedFiles = (id: string) => {
        for (const key of storageKeys.templateObjects(id)) {
          ctx.storage.seed(key, Buffer.from('%PDF'));
        }
      };

      it.each(['draft', 'live', 'retired'] as const)(
        'deletes a %s template, its open assignments and its files, and audits it',
        async (status) => {
          const t = ctx.templates.seed({
            status,
            title_en: 'Test waiver',
            title_zh: '测试',
            ...(status === 'draft'
              ? {}
              : { assign_to: 'all', season: '2026-27' }),
          });
          const other = ctx.templates.seed();
          const instructor = ctx.subjects.seedInstructor();
          ctx.assignments.seed({
            template_id: t.id,
            subject_id: instructor.id,
          });
          ctx.assignments.seed({
            template_id: t.id,
            subject_id: ctx.subjects.seedInstructor().id,
            status: 'viewed',
          });
          ctx.assignments.seed({
            template_id: t.id,
            subject_id: instructor.id,
            status: 'archived',
            season: '2025-26',
          });
          const kept = ctx.assignments.seed({
            template_id: other.id,
            subject_id: instructor.id,
          });
          seedFiles(t.id);
          seedFiles(other.id);

          const res = await remove(t.id).expect(204);

          expect(res.body).toEqual({});
          expect(ctx.templates.rows.has(t.id)).toBe(false);
          expect([...ctx.assignments.rows.keys()]).toEqual([kept.id]);
          expect(
            [...ctx.storage.objects.keys()].filter((k) => k.includes(t.id)),
          ).toEqual([]);
          expect(ctx.storage.objects.size).toBe(
            storageKeys.templateObjects(other.id).length,
          );
          expect(ctx.audit.entries).toEqual([
            expect.objectContaining({
              action: 'document_template.delete',
              targetType: 'document_template',
              targetId: t.id,
              metadata: {
                titleEn: 'Test waiver',
                titleZh: '测试',
                status,
                removedAssignments: 3,
              },
            }),
          ]);
          const me = await http()
            .get(`/admin/instructors/${instructor.id}/documents`)
            .set('Authorization', admin)
            .expect(200);
          expect(
            (me.body as { assignments: { id: string }[] }).assignments,
          ).toEqual([expect.objectContaining({ id: kept.id })]);
        },
      );

      it('refuses with 409 once someone has completed it, even if later archived', async () => {
        const completed = ctx.templates.seed({ status: 'retired' });
        const archived = ctx.templates.seed({ status: 'retired' });
        const instructor = ctx.subjects.seedInstructor();
        const open = ctx.assignments.seed({
          template_id: completed.id,
          subject_id: ctx.subjects.seedInstructor().id,
        });
        ctx.assignments.seed({
          template_id: completed.id,
          subject_id: instructor.id,
          status: 'completed',
          completed_at: '2026-10-01T00:00:00Z',
        });
        ctx.assignments.seed({
          template_id: archived.id,
          subject_id: instructor.id,
          status: 'archived',
          completed_at: '2026-10-01T00:00:00Z',
        });
        seedFiles(completed.id);

        for (const t of [completed, archived]) {
          const res = await remove(t.id).expect(409);
          expect((res.body as { message: string }).message).toBe(
            'Someone has completed this document, so it cannot be deleted. Retire it instead.',
          );
          expect(ctx.templates.rows.has(t.id)).toBe(true);
        }
        expect(ctx.assignments.rows.has(open.id)).toBe(true);
        expect(ctx.storage.deleted).toEqual([]);
        expect(ctx.audit.entries).toEqual([]);
      });

      it('refuses with 409 when a completion lands during the delete', async () => {
        const t = ctx.templates.seed();
        seedFiles(t.id);
        jest
          .spyOn(ctx.templates, 'deleteUnlessCompleted')
          .mockRejectedValue(
            new DatabaseError(
              'delete document template',
              PG_FOREIGN_KEY_VIOLATION,
              'still referenced from table "document_assignments"',
            ),
          );
        await remove(t.id).expect(409);
        expect(ctx.storage.deleted).toEqual([]);
        expect(ctx.audit.entries).toEqual([]);
      });

      it('returns 404 for an unknown or concurrently deleted template', async () => {
        await remove(UNKNOWN_ID).expect(404);
        const t = ctx.templates.seed();
        jest
          .spyOn(ctx.templates, 'deleteUnlessCompleted')
          .mockRejectedValue(
            new DatabaseError('delete document template', 'P0002', 'gone'),
          );
        await remove(t.id).expect(404);
        await http()
          .delete('/admin/documents/templates/not-a-uuid')
          .set('Authorization', admin)
          .expect(400);
        expect(ctx.audit.entries).toEqual([]);
      });

      it('keeps the files when the database delete fails', async () => {
        const t = ctx.templates.seed();
        seedFiles(t.id);
        jest
          .spyOn(ctx.templates, 'deleteUnlessCompleted')
          .mockRejectedValue(new Error('connection reset'));
        await remove(t.id).expect(500);
        expect(ctx.storage.deleted).toEqual([]);
        expect(ctx.audit.entries).toEqual([]);
      });

      it('still deletes when removing its files fails', async () => {
        const t = ctx.templates.seed();
        const warn = jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);
        jest
          .spyOn(ctx.storage, 'delete')
          .mockRejectedValue(new Error('bucket unavailable'));
        await remove(t.id).expect(204);
        expect(ctx.templates.rows.has(t.id)).toBe(false);
        expect(ctx.audit.entries).toHaveLength(1);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('bucket unavailable'),
        );
        warn.mockRestore();
      });
    });
  });

  describe('assignments', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const assign = (body: object) =>
      http()
        .post('/admin/documents/assignments')
        .set('Authorization', admin)
        .send(body);

    function assignable() {
      return ctx.templates.seed({
        source_key: 'templates/x/source.pdf',
        page_count: 1,
      });
    }

    it('assigns explicit instructors idempotently', async () => {
      const t = assignable();
      const a = ctx.subjects.seedInstructor();
      const b = ctx.subjects.seedInstructor({ approval_status: 'pending' });
      const body = {
        templateId: t.id,
        season: '2026-27',
        instructorIds: [a.id, b.id, a.id],
      };
      await assign(body).expect(201, { created: 2, skipped: 0 });
      await assign(body).expect(201, { created: 0, skipped: 2 });
      expect(ctx.assignments.rows.size).toBe(2);
      expect(ctx.audit.entries[0]).toMatchObject({
        action: 'document_assignment.create',
        targetType: 'document_template',
        targetId: t.id,
        metadata: { season: '2026-27', created: 2, skipped: 0, requested: 2 },
      });
    });

    it('assigns every active approved instructor', async () => {
      const t = assignable();
      const active = ctx.subjects.seedInstructor();
      ctx.subjects.seedInstructor({ is_active: false });
      ctx.subjects.seedInstructor({ approval_status: 'rejected' });
      await assign({
        templateId: t.id,
        season: '2026-27',
        allActiveInstructors: true,
      }).expect(201, { created: 1, skipped: 0 });
      expect([...ctx.assignments.rows.values()][0]).toMatchObject({
        subject_type: 'instructor',
        subject_id: active.id,
        season: '2026-27',
        status: 'assigned',
      });
    });

    it('treats another season and archived assignments as new', async () => {
      const t = assignable();
      const a = ctx.subjects.seedInstructor();
      ctx.assignments.seed({
        template_id: t.id,
        subject_id: a.id,
        season: '2025-26',
      });
      ctx.assignments.seed({
        template_id: t.id,
        subject_id: a.id,
        season: '2026-27',
        status: 'archived',
      });
      await assign({
        templateId: t.id,
        season: '2026-27',
        instructorIds: [a.id],
      }).expect(201, { created: 1, skipped: 0 });
    });

    it('falls back to row-by-row inserts when a concurrent request won', async () => {
      const t = assignable();
      const a = ctx.subjects.seedInstructor();
      const b = ctx.subjects.seedInstructor();
      ctx.assignments.seed({ template_id: t.id, subject_id: a.id });
      jest
        .spyOn(ctx.assignments, 'findOpenSubjectIds')
        .mockResolvedValueOnce(new Set());
      await assign({
        templateId: t.id,
        season: '2026-27',
        instructorIds: [a.id, b.id],
      }).expect(201, { created: 1, skipped: 1 });
    });

    it('validates the target and the template', async () => {
      const t = assignable();
      const a = ctx.subjects.seedInstructor();
      await assign({ templateId: t.id, season: '2026-27' }).expect(400);
      await assign({
        templateId: t.id,
        season: '2026-27',
        instructorIds: [a.id],
        allActiveInstructors: true,
      }).expect(400);
      await assign({
        templateId: t.id,
        season: '2026-27',
        allActiveInstructors: false,
      }).expect(400);
      await assign({
        templateId: t.id,
        season: '2026-27',
        instructorIds: [],
      }).expect(400);
      const unknown = await assign({
        templateId: t.id,
        season: '2026-27',
        instructorIds: [a.id, UNKNOWN_ID],
      }).expect(400);
      expect((unknown.body as { message: string }).message).toContain(
        UNKNOWN_ID,
      );
      await assign({
        templateId: t.id,
        season: '2031/32',
        instructorIds: [a.id],
      }).expect(400, {
        statusCode: 400,
        message: 'Unknown season',
        error: 'Bad Request',
      });
      expect(ctx.assignments.rows.size).toBe(0);
      await assign({
        templateId: UNKNOWN_ID,
        season: '2026-27',
        allActiveInstructors: true,
      }).expect(404);
      for (const overrides of [
        { status: 'draft' as const },
        { status: 'retired' as const },
        { source_key: null },
        { audience: 'customer' as const },
      ]) {
        const bad = ctx.templates.seed({
          source_key: 'k',
          ...overrides,
        });
        await assign({
          templateId: bad.id,
          season: '2026-27',
          allActiveInstructors: true,
        }).expect(400);
      }
      expect(ctx.assignments.rows.size).toBe(0);
    });

    it('archives an assignment once and audits it', async () => {
      const t = assignable();
      const a = ctx.subjects.seedInstructor();
      const row = ctx.assignments.seed({ template_id: t.id, subject_id: a.id });
      const archive = () =>
        http()
          .post(`/admin/documents/assignments/${row.id}/archive`)
          .set('Authorization', admin);
      const res = await archive().expect(200);
      expect(res.body).toMatchObject({ id: row.id, status: 'archived' });
      await archive().expect(200);
      expect(ctx.audit.entries).toHaveLength(1);
      expect(ctx.audit.entries[0]).toMatchObject({
        action: 'document_assignment.archive',
        targetType: 'document_assignment',
        targetId: row.id,
        metadata: { previousStatus: 'assigned', subjectId: a.id },
      });
      await http()
        .post(`/admin/documents/assignments/${UNKNOWN_ID}/archive`)
        .set('Authorization', admin)
        .expect(404);
    });

    it("lists an instructor's assignments and certification uploads", async () => {
      const t = assignable();
      const a = ctx.subjects.seedInstructor();
      const row = ctx.assignments.seed({
        template_id: t.id,
        subject_id: a.id,
        status: 'completed',
        signed_key: 'k',
        signed_sha256: 'c'.repeat(64),
      });
      const old = certificationUploadRow({ instructor_id: a.id });
      const latest = certificationUploadRow({
        instructor_id: a.id,
        review_status: 'pending',
      });
      ctx.subjects.uploads.push(old, latest);
      const res = await http()
        .get(`/admin/instructors/${a.id}/documents`)
        .set('Authorization', admin)
        .expect(200);
      const body = res.body as {
        assignments: Record<string, unknown>[];
        certificationUploads: Record<string, unknown>[];
      };
      expect(body.assignments).toEqual([
        expect.objectContaining({
          id: row.id,
          status: 'completed',
          hasSignedCopy: true,
          signedSha256: 'c'.repeat(64),
          template: {
            id: t.id,
            kind: 'sign',
            titleEn: 'Instructor agreement',
            titleZh: null,
            required: true,
          },
        }),
      ]);
      expect(body.assignments[0]).not.toHaveProperty('signedKey');
      expect(body.certificationUploads).toEqual([
        expect.objectContaining({
          id: latest.id,
          current: true,
          state: 'pending',
        }),
        expect.objectContaining({ id: old.id, current: false, state: 'valid' }),
      ]);
      await http()
        .get(`/admin/instructors/${UNKNOWN_ID}/documents`)
        .set('Authorization', admin)
        .expect(404);
    });
  });

  describe('GET /me/documents', () => {
    const today = torontoToday();

    async function setup(
      env: Record<string, string> = {},
      seasons?: ReturnType<typeof seasonsRepo>,
    ) {
      ctx = await build(env, seasons);
      const me = ctx.subjects.seedInstructor({
        auth_user_id: INSTRUCTOR_USER_ID,
      });
      const agreement = ctx.templates.seed({
        title_en: 'Agreement',
        sort_order: 2,
        source_key: 'k',
      });
      const handbook = ctx.templates.seed({
        title_en: 'Handbook',
        kind: 'read',
        sort_order: 1,
        source_key: 'k',
      });
      return { me, agreement, handbook };
    }

    const get = () =>
      http().get('/me/documents').set('Authorization', INSTRUCTOR_AUTH);

    it("lists the current season's documents and one item per certification", async () => {
      const { me, agreement, handbook } = await setup();
      const signed = ctx.assignments.seed({
        template_id: agreement.id,
        subject_id: me.id,
        status: 'completed',
      });
      const toRead = ctx.assignments.seed({
        template_id: handbook.id,
        subject_id: me.id,
      });
      ctx.assignments.seed({
        template_id: handbook.id,
        subject_id: me.id,
        season: '2025-26',
        status: 'completed',
      });
      ctx.assignments.seed({
        template_id: agreement.id,
        subject_id: me.id,
        season: '2026-27',
        status: 'archived',
      });
      ctx.subjects.certifications.set(me.id, [
        { org: 'casi', track: 'regular', level: 2 },
        { org: 'csia', track: 'park', level: 1 },
        { org: 'csia', track: 'regular', level: 3 },
      ]);
      ctx.subjects.uploads.push(
        certificationUploadRow({
          instructor_id: me.id,
          org: 'csia',
          track: 'regular',
          valid_until: addDays(today, -400),
        }),
        certificationUploadRow({
          instructor_id: me.id,
          org: 'csia',
          track: 'regular',
          valid_until: addDays(today, 10),
        }),
        certificationUploadRow({
          instructor_id: me.id,
          org: 'casi',
          track: 'regular',
          valid_until: addDays(today, -1),
        }),
      );
      const res = await get().expect(200);
      const body = res.body as {
        season: string;
        items: Record<string, unknown>[];
      };
      expect(body.season).toBe('2026-27');
      expect(body.items).toEqual([
        expect.objectContaining({
          type: 'document',
          assignmentId: toRead.id,
          kind: 'read',
          titleEn: 'Handbook',
          status: 'assigned',
        }),
        expect.objectContaining({
          type: 'document',
          assignmentId: signed.id,
          kind: 'sign',
          status: 'completed',
        }),
        expect.objectContaining({
          type: 'certification',
          org: 'casi',
          track: 'regular',
          level: 2,
          state: 'expired',
          reviewStatus: 'approved',
        }),
        {
          type: 'certification',
          org: 'csia',
          track: 'park',
          level: 1,
          uploadId: null,
          reviewStatus: null,
          reviewNote: null,
          validUntil: null,
          state: 'missing',
        },
        expect.objectContaining({
          type: 'certification',
          org: 'csia',
          track: 'regular',
          level: 3,
          state: 'expiring',
          validUntil: addDays(today, 10),
        }),
      ]);
    });

    it('is complete once every required document is completed and every certification is satisfied', async () => {
      const { me, agreement, handbook } = await setup();
      const optional = ctx.templates.seed({ required: false, source_key: 'k' });
      ctx.assignments.seed({
        template_id: agreement.id,
        subject_id: me.id,
        status: 'completed',
      });
      const toRead = ctx.assignments.seed({
        template_id: handbook.id,
        subject_id: me.id,
      });
      ctx.assignments.seed({ template_id: optional.id, subject_id: me.id });
      ctx.assignments.seed({
        template_id: handbook.id,
        subject_id: me.id,
        season: '2025-26',
      });
      ctx.assignments.seed({
        template_id: agreement.id,
        subject_id: me.id,
        status: 'archived',
      });
      ctx.subjects.certifications.set(me.id, [
        { org: 'casi', track: 'regular', level: 2 },
        { org: 'csia', track: 'park', level: 1 },
        { org: 'csia', track: 'regular', level: 3 },
      ]);
      ctx.subjects.uploads.push(
        certificationUploadRow({
          instructor_id: me.id,
          org: 'casi',
          track: 'regular',
          review_status: 'pending',
        }),
        certificationUploadRow({
          instructor_id: me.id,
          org: 'csia',
          track: 'park',
          valid_until: addDays(today, 10),
        }),
        certificationUploadRow({
          instructor_id: me.id,
          org: 'csia',
          track: 'regular',
          valid_until: addDays(today, 400),
        }),
      );
      await expect(get().expect(200)).resolves.toMatchObject({
        body: { locked: false, complete: false },
      });
      ctx.assignments.rows.set(toRead.id, {
        ...ctx.assignments.rows.get(toRead.id)!,
        status: 'completed',
      });
      await expect(get().expect(200)).resolves.toMatchObject({
        body: { locked: false, complete: true },
      });
    });

    it.each([
      ['missing', []],
      ['expired', [{ valid_until: addDays(today, -1) }]],
      ['rejected', [{ review_status: 'rejected' as const }]],
    ])(
      'is not complete while a certification is %s',
      async (_name, uploads) => {
        const { me } = await setup();
        ctx.subjects.certifications.set(me.id, [
          { org: 'csia', track: 'regular', level: 3 },
        ]);
        for (const upload of uploads) {
          ctx.subjects.uploads.push(
            certificationUploadRow({ instructor_id: me.id, ...upload }),
          );
        }
        await expect(get().expect(200)).resolves.toMatchObject({
          body: { locked: false, complete: false },
        });
      },
    );

    it('uses CURRENT_SEASON when set', async () => {
      const { me, agreement } = await setup({ CURRENT_SEASON: '2027-28' });
      ctx.assignments.seed({ template_id: agreement.id, subject_id: me.id });
      const res = await get().expect(200);
      expect(res.body).toEqual({
        season: '2027-28',
        locked: false,
        lockReason: null,
        complete: true,
        items: [],
      });
    });

    it('ignores a CURRENT_SEASON that is not a known season', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      await setup({ CURRENT_SEASON: '2099-00' });
      await get().expect(200, {
        season: '2026-27',
        locked: false,
        lockReason: null,
        complete: true,
        items: [],
      });
      expect(warn).toHaveBeenCalledWith(
        "CURRENT_SEASON '2099-00' is not a known season; ignoring it",
      );
      warn.mockRestore();
    });

    it('returns a null season and no items when no season is set up', async () => {
      await setup({}, seasonsRepo());
      await get().expect(200, {
        season: null,
        locked: false,
        lockReason: null,
        complete: true,
        items: [],
      });
    });
  });
});
