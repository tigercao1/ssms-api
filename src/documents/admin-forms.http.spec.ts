import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  ADMIN_AUTH,
  ADMIN_USER_ID,
  INSTRUCTOR_AUTH,
  INSTRUCTOR_USER_ID,
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
  InMemoryDocumentTemplatesRepository,
  InMemoryPrivateStorage,
  startDocumentsApp,
} from '../../test/helpers/documents-fakes';
import { InMemoryCustomersRepository } from '../../test/helpers/customers-fakes';
import { fakeDate } from '../../test/helpers/fake-date';
import { InMemoryFormAdminRepository } from '../../test/helpers/form-signing-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import {
  seasonsProviders,
  seasonsRepo,
} from '../../test/helpers/seasons-fakes';
import { AuditService } from '../audit/audit.service';
import {
  type CustomerRow,
  CustomersRepository,
} from '../customers/customers.repository';
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
import {
  LINK_CUSTOMER_NOT_FOUND,
  SIGNATURE_NOT_FOUND,
  SIGNATURE_NOT_LINKABLE,
  SignatureLookupsService,
} from './signature-lookups.service';

function customerRow(overrides: Partial<CustomerRow>): CustomerRow {
  return {
    id: randomUUID(),
    shopify_customer_id: null,
    first_name: null,
    last_name: null,
    email: null,
    phone: null,
    shopify_updated_at: null,
    shopify_deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('form templates and signature lookups', () => {
  let app: INestApplication<App>;
  let repo: InMemoryFormAdminRepository;
  let customers: InMemoryCustomersRepository;
  let subjects: InMemoryDocumentSubjectsRepository;
  let audit: ReturnType<typeof recordingAudit>;

  beforeEach(async () => {
    repo = new InMemoryFormAdminRepository();
    customers = new InMemoryCustomersRepository();
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
          { provide: CustomersRepository, useValue: customers },
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

  afterEach(() => {
    jest.useRealTimers();
    return app.close();
  });

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
      await as(INSTRUCTOR_AUTH)
        .post(`/admin/signatures/${randomUUID()}/link`, {
          customerId: randomUUID(),
        })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/admin/signatures/${randomUUID()}/link`)
        .send({ customerId: randomUUID() })
        .expect(401);
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

  describe('expectedUpdatedAt', () => {
    const CHANGED =
      'This form was changed by someone else; reload it and try again';
    const draftPath = (id: string) =>
      `/admin/documents/forms/${id}/versions/en`;
    const text = (bodyMarkdown: string, expectedUpdatedAt?: string) => ({
      title: 'Lesson waiver',
      bodyMarkdown,
      ...(expectedUpdatedAt !== undefined && { expectedUpdatedAt }),
    });
    const saveDraft = async (
      id: string,
      bodyMarkdown: string,
      expectedUpdatedAt?: string,
    ) =>
      (
        (
          await admin
            .put(draftPath(id), text(bodyMarkdown, expectedUpdatedAt))
            .expect(200)
        ).body as FormTemplate
      ).languages.en.draft!;
    const storedDraft = (id: string) =>
      repo.forms.get(id)!.versions.find((v) => !v.published_at);

    it('409s a draft save from a stale revision and leaves the draft untouched', async () => {
      const { id } = await createForm();
      const opened = await saveDraft(id, '# v1');
      await saveDraft(id, '# v2 by someone else', opened.updatedAt);
      const before = structuredClone(storedDraft(id));
      const auditCount = audit.entries.length;

      const res = await admin
        .put(draftPath(id), text('# v3 from a stale tab', opened.updatedAt))
        .expect(409);

      expect((res.body as { message: string }).message).toBe(CHANGED);
      expect(storedDraft(id)).toEqual(before);
      expect(audit.entries).toHaveLength(auditCount);
    });

    it('chains draft saves with each returned updatedAt', async () => {
      const { id } = await createForm();
      const first = await saveDraft(id, '# v1');

      const second = await saveDraft(id, '# v2', first.updatedAt);
      const third = await saveDraft(id, '# v3', second.updatedAt);

      expect(second.updatedAt).not.toBe(first.updatedAt);
      expect(third.updatedAt).not.toBe(second.updatedAt);
      expect(third).toMatchObject({
        version: 1,
        bodyMarkdown: '# v3',
        updatedAt: storedDraft(id)!.updated_at,
      });
    });

    it('saves over a newer draft as before when expectedUpdatedAt is absent', async () => {
      const { id } = await createForm();
      const first = await saveDraft(id, '# v1');
      await saveDraft(id, '# v2', first.updatedAt);

      const last = await saveDraft(id, '# v3 without a revision');

      expect(last).toMatchObject({
        version: 1,
        bodyMarkdown: '# v3 without a revision',
      });
    });

    describe('expectedUpdatedAt: null (expects no draft yet)', () => {
      const publishedOnly = async () => {
        const { id } = await createForm();
        await saveDraft(id, '# published');
        await admin.post(`${draftPath(id)}/publish`).expect(200);
        return id;
      };
      const firstDraft = (bodyMarkdown: string) => ({
        ...text(bodyMarkdown),
        expectedUpdatedAt: null,
      });

      it('creates the first draft and returns its updatedAt', async () => {
        const id = await publishedOnly();

        const form = (
          await admin.put(draftPath(id), firstDraft('# v2')).expect(200)
        ).body as FormTemplate;

        expect(form.languages.en.draft).toMatchObject({
          version: 2,
          bodyMarkdown: '# v2',
          updatedAt: storedDraft(id)!.updated_at,
        });
      });

      it('409s when a draft already exists and leaves it untouched', async () => {
        const id = await publishedOnly();
        await saveDraft(id, '# v2 by someone else');
        const before = structuredClone(storedDraft(id));
        const auditCount = audit.entries.length;
        const updateDraft = jest.spyOn(repo, 'updateDraft');

        const res = await admin
          .put(draftPath(id), firstDraft('# v2 from a stale tab'))
          .expect(409);

        expect((res.body as { message: string }).message).toBe(CHANGED);
        expect(updateDraft).not.toHaveBeenCalled();
        expect(storedDraft(id)).toEqual(before);
        expect(audit.entries).toHaveLength(auditCount);
      });

      it('409s when another draft is created between loading and inserting', async () => {
        const id = await publishedOnly();
        const loadedBeforeTheOtherSave = await repo.findById(id);
        await saveDraft(id, '# v2 by someone else');
        jest
          .spyOn(repo, 'findById')
          .mockResolvedValueOnce(loadedBeforeTheOtherSave);

        const res = await admin
          .put(draftPath(id), firstDraft('# v2 from a stale tab'))
          .expect(409);

        expect((res.body as { message: string }).message).toBe(CHANGED);
        expect(storedDraft(id)).toMatchObject({
          body_markdown: '# v2 by someone else',
        });
      });

      it('lets only one of two concurrent first saves through', async () => {
        const id = await publishedOnly();

        const results = await Promise.all([
          admin.put(draftPath(id), firstDraft('# from A')),
          admin.put(draftPath(id), firstDraft('# from B')),
        ]);

        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        const winner = results.find((r) => r.status === 200)!;
        expect(storedDraft(id)!.body_markdown).toBe(
          (winner.body as FormTemplate).languages.en.draft!.bodyMarkdown,
        );
      });
    });

    it('409s a draft save expecting a draft that was published meanwhile, without starting a new draft', async () => {
      const { id } = await createForm();
      const opened = await saveDraft(id, '# v1');
      await admin.post(`${draftPath(id)}/publish`).expect(200);

      await admin
        .put(draftPath(id), text('# v2', opened.updatedAt))
        .expect(409);

      expect(storedDraft(id)).toBeUndefined();
    });

    it('400s an expectedUpdatedAt that is not an ISO timestamp', async () => {
      const { id } = await createForm();

      await admin.put(draftPath(id), text('# v1', 'yesterday')).expect(400);
      await admin
        .post(`${draftPath(id)}/publish`, { expectedUpdatedAt: 'yesterday' })
        .expect(400);
    });

    it('publishes only the revision the caller saw', async () => {
      const { id } = await createForm();
      const opened = await saveDraft(id, '# v1');
      const newer = await saveDraft(id, '# v2', opened.updatedAt);

      const res = await admin
        .post(`${draftPath(id)}/publish`, {
          expectedUpdatedAt: opened.updatedAt,
        })
        .expect(409);
      expect((res.body as { message: string }).message).toBe(CHANGED);
      expect(storedDraft(id)).toMatchObject({ body_markdown: '# v2' });

      const form = (
        await admin
          .post(`${draftPath(id)}/publish`, {
            expectedUpdatedAt: newer.updatedAt,
          })
          .expect(200)
      ).body as FormTemplate;
      expect(form.languages.en.published).toMatchObject({
        bodyMarkdown: '# v2',
        updatedAt: expect.any(String) as unknown,
      });
    });

    it('409s a title edit from a stale revision and chains edits with the returned updatedAt', async () => {
      const { id, updatedAt } = await createForm();
      const edited = (
        await admin
          .patch(`/admin/documents/forms/${id}`, {
            titleEn: 'Ski waiver',
            expectedUpdatedAt: updatedAt,
          })
          .expect(200)
      ).body as FormTemplate;
      expect(edited.updatedAt).not.toBe(updatedAt);

      const res = await admin
        .patch(`/admin/documents/forms/${id}`, {
          emailCopy: false,
          expectedUpdatedAt: updatedAt,
        })
        .expect(409);
      expect((res.body as { message: string }).message).toBe(CHANGED);
      expect(repo.forms.get(id)).toMatchObject({
        title_en: 'Ski waiver',
        email_copy: true,
      });

      await admin
        .patch(`/admin/documents/forms/${id}`, {
          emailCopy: false,
          expectedUpdatedAt: edited.updatedAt,
        })
        .expect(200);
      await admin
        .patch(`/admin/documents/forms/${randomUUID()}`, {
          titleEn: 'X',
          expectedUpdatedAt: updatedAt,
        })
        .expect(404);
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
      fakeDate('2026-11-09T15:00:00.000Z');
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

    it('marks each signature valid this waiver year or not and gives customers their waiver status', async () => {
      fakeDate('2026-11-09T15:00:00.000Z');
      repo.lookupRows = [
        row({
          subject_type: 'instructor',
          subject_id: 'i1',
          assignment_id: 'a1',
          template_id: 't1',
          kind: 'sign',
          signed_at: '2026-06-30T12:00:00Z',
        }),
        row({
          assignment_id: 'a2',
          template_id: 't2',
          kind: 'form',
          signed_at: '2026-07-01T04:00:00Z',
        }),
        row({
          assignment_id: 'a3',
          template_id: 't2',
          kind: 'form',
          signed_at: '2026-07-01T03:59:00Z',
        }),
        row({ subject_id: 'c2', email: 'other@example.com' }),
      ];
      customers.rows.push(
        customerRow({ id: 'c1', email: 'mia@example.com' }),
        customerRow({ id: 'c2', email: 'other@example.com' }),
      );
      customers.signatures = [
        {
          subjectId: 'c1',
          signerEmail: 'mia@example.com',
          signedAt: '2026-07-01T04:00:00Z',
        },
        {
          subjectId: 'elsewhere',
          signerEmail: 'other@example.com',
          signedAt: '2025-09-01T12:00:00Z',
        },
      ];

      const signers = (await admin.get('/admin/signatures?q=mia').expect(200))
        .body as Signer[];

      expect(customers.latestSignatureCalls).toEqual([['c1', 'c2']]);
      expect(
        signers.map((s) => ({
          customerId: s.customerId,
          waiver: s.waiver,
          valid: s.signatures.map((x) => [x.assignmentId, x.validThisYear]),
        })),
      ).toEqual([
        { customerId: null, waiver: null, valid: [['a1', false]] },
        {
          customerId: 'c1',
          waiver: {
            status: 'signed',
            signedAt: '2026-07-01T04:00:00Z',
            year: '2026/27',
          },
          valid: [
            ['a2', true],
            ['a3', false],
          ],
        },
        {
          customerId: 'c2',
          waiver: {
            status: 'expired',
            signedAt: '2025-09-01T12:00:00Z',
            year: '2026/27',
          },
          valid: [],
        },
      ]);
    });

    it('needs at least two characters', async () => {
      await admin.get('/admin/signatures?q=m').expect(400);
      await admin.get('/admin/signatures').expect(400);
    });
  });

  describe('GET /me/students/signatures', () => {
    it("asks for the caller's own students and returns only name, signed, status and date", async () => {
      fakeDate('2026-11-09T15:00:00.000Z');
      const me = subjects.seedInstructor({ auth_user_id: INSTRUCTOR_USER_ID });
      subjects.seedInstructor();
      repo.studentRows = [
        { name: 'Leo Chen', signed_at: '2026-11-02T00:00:00Z' },
        { name: 'Max Chen', signed_at: '2026-06-30T23:00:00Z' },
        { name: 'Ada Wu', signed_at: null },
      ];

      const res = await as(INSTRUCTOR_AUTH)
        .get('/me/students/signatures?q=chen')
        .expect(200);

      expect(repo.studentCalls).toEqual([
        { instructorId: me.id, query: 'chen', limit: 100 },
      ]);
      expect(res.body).toEqual([
        {
          name: 'Leo Chen',
          signed: true,
          status: 'signed',
          signedAt: '2026-11-02T00:00:00Z',
        },
        {
          name: 'Max Chen',
          signed: false,
          status: 'expired',
          signedAt: '2026-06-30T23:00:00Z',
        },
        { name: 'Ada Wu', signed: false, status: 'none', signedAt: null },
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

  describe('POST /admin/signatures/:assignmentId/link', () => {
    const assignmentId = randomUUID();
    const fromId = randomUUID();
    const toId = randomUUID();

    beforeEach(() => {
      fakeDate('2026-11-09T15:00:00.000Z');
      customers.rows.push(
        customerRow({ id: fromId, email: 'mia.other@example.com' }),
        customerRow({
          id: toId,
          first_name: 'Mia',
          last_name: 'Chen',
          email: 'mia@example.com',
        }),
      );
      repo.signatureSubjects.set(assignmentId, {
        subject_type: 'customer',
        subject_id: fromId,
        status: 'completed',
      });
      repo.signedDocuments.set(assignmentId, {
        assignment_id: assignmentId,
        template_id: 't1',
        title_en: 'Lesson waiver',
        title_zh: null,
        kind: 'form',
        language: 'en',
        form_version: 2,
        signed_at: '2026-11-01T12:00:00Z',
        has_signed_copy: true,
      });
      customers.signatures = [
        {
          subjectId: fromId,
          signerEmail: 'mia.other@example.com',
          signedAt: '2026-11-01T12:00:00Z',
        },
      ];
      repo.onRelink = (from, to) => {
        customers.signatures = customers.signatures.map((sig) =>
          sig.subjectId === from ? { ...sig, subjectId: to } : sig,
        );
      };
    });

    const link = (id: string, customerId: string) =>
      admin.post(`/admin/signatures/${id}/link`, { customerId });

    it('files the signature under the chosen customer, audits it and returns that person', async () => {
      const signer = (await link(assignmentId, toId).expect(200))
        .body as Signer;

      expect(repo.signatureSubjects.get(assignmentId)?.subject_id).toBe(toId);
      expect(signer).toEqual({
        subjectType: 'customer',
        subjectId: toId,
        customerId: toId,
        name: 'Mia Chen',
        email: 'mia@example.com',
        waiver: {
          status: 'signed',
          signedAt: '2026-11-01T12:00:00Z',
          year: '2026/27',
        },
        signatures: [
          {
            assignmentId,
            templateId: 't1',
            titleEn: 'Lesson waiver',
            titleZh: null,
            kind: 'form',
            language: 'en',
            formVersion: 2,
            signedAt: '2026-11-01T12:00:00Z',
            hasSignedCopy: true,
            validThisYear: true,
          },
        ],
      });
      expect(audit.entries).toEqual([
        expect.objectContaining({
          action: 'document_assignment.link_customer',
          actor: expect.objectContaining({
            userId: ADMIN_USER_ID,
            role: 'admin',
          }) as unknown,
          targetType: 'document_assignment',
          targetId: assignmentId,
          metadata: { fromCustomerId: fromId, toCustomerId: toId },
        }),
      ]);
    });

    it('answers the person without writing or auditing when it is already filed there', async () => {
      await link(assignmentId, fromId).expect(200);
      expect(repo.signatureSubjects.get(assignmentId)?.subject_id).toBe(fromId);
      expect(audit.entries).toEqual([]);
    });

    it('refuses instructor and unfinished signatures, unknown ids and bad bodies', async () => {
      const instructorDoc = randomUUID();
      const pending = randomUUID();
      repo.signatureSubjects.set(instructorDoc, {
        subject_type: 'instructor',
        subject_id: randomUUID(),
        status: 'completed',
      });
      repo.signatureSubjects.set(pending, {
        subject_type: 'customer',
        subject_id: fromId,
        status: 'assigned',
      });

      const message = async (res: Promise<request.Response>) =>
        ((await res).body as { message: unknown }).message;
      expect(await message(link(instructorDoc, toId).expect(400))).toBe(
        SIGNATURE_NOT_LINKABLE,
      );
      expect(await message(link(pending, toId).expect(400))).toBe(
        SIGNATURE_NOT_LINKABLE,
      );
      expect(await message(link(randomUUID(), toId).expect(404))).toBe(
        SIGNATURE_NOT_FOUND,
      );
      expect(await message(link(assignmentId, randomUUID()).expect(404))).toBe(
        LINK_CUSTOMER_NOT_FOUND,
      );
      await link('not-a-uuid', toId).expect(400);
      await link(assignmentId, 'not-a-uuid').expect(400);
      await admin
        .post(`/admin/signatures/${assignmentId}/link`, {
          customerId: toId,
          extra: true,
        })
        .expect(400);
      expect(repo.signatureSubjects.get(assignmentId)?.subject_id).toBe(fromId);
      expect(audit.entries).toEqual([]);
    });

    it('409s when the signature moved between reading and writing', async () => {
      jest.spyOn(repo, 'relinkCustomerSignature').mockResolvedValueOnce(false);
      await link(assignmentId, toId).expect(409);
      expect(audit.entries).toEqual([]);
    });
  });
});
