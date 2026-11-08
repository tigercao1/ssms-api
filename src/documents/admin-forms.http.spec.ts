import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  ADMIN_AUTH,
  INSTRUCTOR_AUTH,
  INSTRUCTOR_USER_ID,
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
  InMemoryDocumentTemplatesRepository,
  InMemoryPrivateStorage,
  startDocumentsApp,
} from '../../test/helpers/documents-fakes';
import { InMemoryFormAdminRepository } from '../../test/helpers/form-signing-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import {
  seasonsProviders,
  seasonsRepo,
} from '../../test/helpers/seasons-fakes';
import { AuditService } from '../audit/audit.service';
import {
  AdminFormsController,
  AdminSignaturesController,
} from './admin-forms.controller';
import { AdminFormsService } from './admin-forms.service';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { DocumentTemplatesRepository } from './document-templates.repository';
import { DocumentTemplatesService } from './document-templates.service';
import { FormAdminRepository } from './form-admin.repository';
import type {
  FormTemplate,
  Signer,
  SignatureLookupRow,
} from './form-templates.types';
import { MeDocumentsService } from './me-documents.service';
import { MeStudentSignaturesController } from './me-student-signatures.controller';
import { PdfWorkQueue } from './pdf-work-queue';
import { PrivateStorageClient } from './private-storage.client';
import { SignFormsThrottlerGuard } from './sign-forms-throttler.guard';
import { SignatureLookupsService } from './signature-lookups.service';

describe('form templates and signature lookups', () => {
  let app: INestApplication<App>;
  let repo: InMemoryFormAdminRepository;
  let subjects: InMemoryDocumentSubjectsRepository;
  let audit: ReturnType<typeof recordingAudit>;

  beforeEach(async () => {
    repo = new InMemoryFormAdminRepository();
    subjects = new InMemoryDocumentSubjectsRepository();
    audit = recordingAudit();
    app = await startDocumentsApp(
      Test.createTestingModule({
        controllers: [
          AdminFormsController,
          AdminSignaturesController,
          MeStudentSignaturesController,
        ],
        providers: [
          ...seasonsProviders(seasonsRepo('2026/27')),
          AdminFormsService,
          DocumentTemplatesService,
          PdfWorkQueue,
          SignFormsThrottlerGuard,
          SignatureLookupsService,
          MeDocumentsService,
          { provide: PrivateStorageClient, useClass: InMemoryPrivateStorage },
          { provide: FormAdminRepository, useValue: repo },
          { provide: DocumentSubjectsRepository, useValue: subjects },
          {
            provide: DocumentTemplatesRepository,
            useClass: InMemoryDocumentTemplatesRepository,
          },
          {
            provide: DocumentAssignmentsRepository,
            useValue: new InMemoryDocumentAssignmentsRepository(
              new InMemoryDocumentTemplatesRepository(),
            ),
          },
          { provide: AuditService, useValue: audit },
          { provide: ConfigService, useValue: { get: () => undefined } },
        ],
      }),
    );
  });

  afterEach(() => app.close());

  const as = (auth: string) => ({
    get: (path: string) =>
      request(app.getHttpServer()).get(path).set('authorization', auth),
    post: (path: string, body: object = {}) =>
      request(app.getHttpServer())
        .post(path)
        .set('authorization', auth)
        .send(body),
    put: (path: string, body: object) =>
      request(app.getHttpServer())
        .put(path)
        .set('authorization', auth)
        .send(body),
    patch: (path: string, body: object) =>
      request(app.getHttpServer())
        .patch(path)
        .set('authorization', auth)
        .send(body),
  });
  const admin = as(ADMIN_AUTH);

  const createForm = async () =>
    (
      await admin
        .post('/admin/documents/forms', {
          slug: 'lesson-waiver',
          titleEn: 'Lesson waiver',
          titleZh: '课程免责声明',
        })
        .expect(201)
    ).body as FormTemplate;

  describe('admin form templates', () => {
    it('is admin only', async () => {
      await request(app.getHttpServer())
        .get('/admin/documents/forms')
        .expect(401);
      await as(INSTRUCTOR_AUTH).get('/admin/documents/forms').expect(403);
      await as(INSTRUCTOR_AUTH)
        .post('/admin/documents/forms', { slug: 'x', titleEn: 'X' })
        .expect(403);
      await as(INSTRUCTOR_AUTH).get('/admin/signatures?q=mia').expect(403);
    });

    it('creates a form with a unique link name and offers the default waiver fields', async () => {
      const form = await createForm();

      expect(form).toMatchObject({
        slug: 'lesson-waiver',
        titleEn: 'Lesson waiver',
        languages: {
          en: { published: null, draft: null },
          zh: { published: null, draft: null },
        },
      });
      expect(form.defaultFields.zh.map((f) => f.key)).toEqual([
        'participant_name',
        'email',
        'date',
        'id_number',
        'initials',
        'participant_signature',
        'guardian_name',
        'guardian_signature',
        'witness_name',
        'witness_signature',
      ]);
      await admin
        .post('/admin/documents/forms', { slug: 'lesson-waiver', titleEn: 'B' })
        .expect(409);
      await admin
        .post('/admin/documents/forms', { slug: 'Bad Slug', titleEn: 'B' })
        .expect(400);
      expect(audit.entries[0]).toMatchObject({
        action: 'document_template.create',
        targetId: form.id,
      });
    });

    it('saves a draft per language and publishes it, keeping the live version until the next publish', async () => {
      const { id } = await createForm();
      const draft = { title: 'Lesson waiver', bodyMarkdown: '# Risks v1' };

      let form = (
        await admin.put(`/admin/documents/forms/${id}/versions/en`, draft)
      ).body as FormTemplate;
      expect(form.languages.en.draft).toMatchObject({
        version: 1,
        bodyMarkdown: '# Risks v1',
        publishedAt: null,
      });
      expect(form.languages.en.draft!.fields).toHaveLength(10);
      expect(form.languages.zh.draft).toBeNull();

      form = (
        await admin
          .post(`/admin/documents/forms/${id}/versions/en/publish`)
          .expect(200)
      ).body as FormTemplate;
      expect(form.languages.en).toMatchObject({
        published: { version: 1 },
        draft: null,
      });

      await admin
        .put(`/admin/documents/forms/${id}/versions/en`, {
          ...draft,
          bodyMarkdown: '# Risks v2',
        })
        .expect(200);
      form = (
        await admin
          .put(`/admin/documents/forms/${id}/versions/en`, {
            ...draft,
            bodyMarkdown: '# Risks v2, edited',
          })
          .expect(200)
      ).body as FormTemplate;
      expect(form.languages.en).toMatchObject({
        published: { version: 1, bodyMarkdown: '# Risks v1' },
        draft: { version: 2, bodyMarkdown: '# Risks v2, edited' },
      });

      form = (
        await admin.post(`/admin/documents/forms/${id}/versions/en/publish`)
      ).body as FormTemplate;
      expect(form.languages.en.published).toMatchObject({ version: 2 });
      expect(audit.entries.map((e) => e.action)).toEqual([
        'document_template.create',
        'document_template.form_draft_save',
        'document_template.publish',
        'document_template.form_draft_save',
        'document_template.form_draft_save',
        'document_template.publish',
      ]);
    });

    it('400s publishing a language with no draft', async () => {
      const { id } = await createForm();

      await admin
        .post(`/admin/documents/forms/${id}/versions/zh/publish`)
        .expect(400);
    });

    it.each([
      [
        'no email field',
        [
          {
            key: 'participant_name',
            type: 'text',
            label: 'Name',
            required: true,
          },
          { key: 'sig', type: 'signature', label: 'Sign', required: true },
        ],
      ],
      [
        'no required signature',
        [
          {
            key: 'participant_name',
            type: 'text',
            label: 'Name',
            required: true,
          },
          { key: 'email', type: 'email', label: 'Email', required: true },
        ],
      ],
      [
        'a duplicate key',
        [
          {
            key: 'participant_name',
            type: 'text',
            label: 'Name',
            required: true,
          },
          { key: 'email', type: 'email', label: 'Email', required: true },
          { key: 'sig', type: 'signature', label: 'Sign', required: true },
          { key: 'sig', type: 'signature', label: 'Again', required: true },
        ],
      ],
      [
        'an unknown field type',
        [{ key: 'age', type: 'number', label: 'Age', required: true }],
      ],
    ])('rejects a field list with %s', async (_case, fields) => {
      const { id } = await createForm();

      await admin
        .put(`/admin/documents/forms/${id}/versions/en`, {
          title: 'T',
          bodyMarkdown: 'Body',
          fields,
        })
        .expect(400);
    });

    it('edits titles, lists forms with their live versions, and 404s an unknown form', async () => {
      const { id } = await createForm();
      await admin.put(`/admin/documents/forms/${id}/versions/zh`, {
        title: '课程免责声明',
        bodyMarkdown: '风险',
      });
      await admin.post(`/admin/documents/forms/${id}/versions/zh/publish`);

      await admin
        .patch(`/admin/documents/forms/${id}`, { titleEn: 'Ski waiver' })
        .expect(200);
      const list = await admin.get('/admin/documents/forms').expect(200);

      expect(list.body).toEqual([
        expect.objectContaining({
          id,
          titleEn: 'Ski waiver',
          publishedVersions: { en: null, zh: 1 },
          hasDraft: { en: false, zh: false },
        }),
      ]);
      await admin.get(`/admin/documents/forms/${randomUUID()}`).expect(404);
    });
  });

  describe('GET /admin/signatures', () => {
    const row = (
      overrides: Partial<SignatureLookupRow>,
    ): SignatureLookupRow => ({
      subject_type: 'customer',
      subject_id: 'c1',
      name: 'Mia Chen',
      email: 'mia@example.com',
      assignment_id: null,
      template_id: null,
      title_en: null,
      title_zh: null,
      kind: null,
      language: null,
      form_version: null,
      signed_at: null,
      has_signed_copy: null,
      ...overrides,
    });

    it('groups each instructor and customer with what they signed and when', async () => {
      repo.lookupRows = [
        row({
          subject_type: 'instructor',
          subject_id: 'i1',
          name: 'Mia Instructor',
          assignment_id: 'a1',
          template_id: 't1',
          title_en: 'Instructor agreement',
          kind: 'sign',
          signed_at: '2026-10-01T00:00:00Z',
          has_signed_copy: true,
        }),
        row({
          assignment_id: 'a2',
          template_id: 't2',
          title_en: 'Lesson waiver',
          kind: 'form',
          language: 'zh',
          form_version: 3,
          signed_at: '2026-11-02T00:00:00Z',
          has_signed_copy: true,
        }),
        row({
          assignment_id: 'a3',
          template_id: 't2',
          title_en: 'Lesson waiver',
          kind: 'form',
          language: 'en',
          form_version: 2,
          signed_at: '2026-10-02T00:00:00Z',
          has_signed_copy: true,
        }),
        row({ subject_id: 'c2', name: 'Mia Chen', email: 'other@example.com' }),
      ];

      const res = await admin.get('/admin/signatures?q=%20mia%20').expect(200);

      expect(repo.lookupCalls).toEqual([{ query: 'mia', limit: 25 }]);
      const signers = res.body as Signer[];
      expect(signers.map((s) => [s.subjectType, s.subjectId])).toEqual([
        ['instructor', 'i1'],
        ['customer', 'c1'],
        ['customer', 'c2'],
      ]);
      expect(signers[1].signatures).toEqual([
        expect.objectContaining({
          assignmentId: 'a2',
          kind: 'form',
          formVersion: 3,
          signedAt: '2026-11-02T00:00:00Z',
        }),
        expect.objectContaining({ assignmentId: 'a3' }),
      ]);
      expect(signers[2].signatures).toEqual([]);
    });

    it('needs at least two characters', async () => {
      await admin.get('/admin/signatures?q=m').expect(400);
      await admin.get('/admin/signatures').expect(400);
    });
  });

  describe('GET /me/students/signatures', () => {
    it("asks for the caller's own students and returns only name, signed and date", async () => {
      const me = subjects.seedInstructor({ auth_user_id: INSTRUCTOR_USER_ID });
      subjects.seedInstructor();
      repo.studentRows = [
        { name: 'Leo Chen', signed_at: '2026-11-02T00:00:00Z' },
        { name: 'Ada Wu', signed_at: null },
      ];

      const res = await as(INSTRUCTOR_AUTH)
        .get('/me/students/signatures?q=chen')
        .expect(200);

      expect(repo.studentCalls).toEqual([
        { instructorId: me.id, query: 'chen', limit: 100 },
      ]);
      expect(res.body).toEqual([
        { name: 'Leo Chen', signed: true, signedAt: '2026-11-02T00:00:00Z' },
        { name: 'Ada Wu', signed: false, signedAt: null },
      ]);
    });

    it('refuses callers who are not approved, active instructors', async () => {
      await as(INSTRUCTOR_AUTH).get('/me/students/signatures').expect(404);
      subjects.seedInstructor({
        auth_user_id: INSTRUCTOR_USER_ID,
        approval_status: 'pending',
      });
      await as(INSTRUCTOR_AUTH).get('/me/students/signatures').expect(403);
      expect(repo.studentCalls).toHaveLength(0);
    });
  });
});
