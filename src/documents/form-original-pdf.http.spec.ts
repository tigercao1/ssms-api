import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PDFDocument } from '@cantoo/pdf-lib';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  ADMIN_AUTH,
  INSTRUCTOR_AUTH,
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
  InMemoryDocumentTemplatesRepository,
  InMemoryPrivateStorage,
  startDocumentsApp,
} from '../../test/helpers/documents-fakes';
import {
  formVersion,
  InMemoryFormAdminRepository,
  InMemoryFormSigningRepository,
} from '../../test/helpers/form-signing-fakes';
import { RecordingMailer } from '../../test/helpers/mailer-fakes';
import {
  activeContentIn,
  annotationHeavyPdf,
  pdfFixture,
  pdfOfSize,
} from '../../test/helpers/pdf-fixtures';
import {
  inkIn,
  pdftotext,
  pixelRect,
  renderPage,
} from '../../test/helpers/pdf-render';
import { signaturePng } from '../../test/helpers/png-fixtures';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import {
  seasonsProviders,
  seasonsRepo,
} from '../../test/helpers/seasons-fakes';
import { AuditService } from '../audit/audit.service';
import { MailerService } from '../mailer/mailer.service';
import {
  AdminFormsController,
  AdminSignaturesController,
} from './admin-forms.controller';
import { AdminFormsService } from './admin-forms.service';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import { DocumentNotificationsService } from './document-notifications.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { DocumentTemplatesRepository } from './document-templates.repository';
import { DocumentTemplatesService } from './document-templates.service';
import type { PageGeometry } from './documents.types';
import { FormAdminRepository } from './form-admin.repository';
import { stampFormPdf } from './form-pdf';
import { FormSigningRepository } from './form-signing.repository';
import { FormSigningService } from './form-signing.service';
import type {
  FormPlacement,
  FormTemplate,
  FormVersionRow,
  PublicForm,
} from './form-templates.types';
import { MeDocumentsService } from './me-documents.service';
import { loadStampFonts } from './pdf-stamper';
import { PdfWorkQueue } from './pdf-work-queue';
import { PrivateStorageClient } from './private-storage.client';
import { SignFormsController } from './sign-forms.controller';
import { SignFormsThrottlerGuard } from './sign-forms-throttler.guard';
import { signingBodyParser } from './signing-body-parser';
import { SignatureLookupsService } from './signature-lookups.service';
import { storageKeys } from './storage-keys';
import { normaliseTemplatePdf, sha256Hex } from './template-pdf';

jest.setTimeout(60_000);

const LETTER: PageGeometry = {
  width: 612,
  height: 792,
  rotate: 0,
  x: 0,
  y: 0,
};
const PLACEMENTS: FormPlacement[] = [
  { key: 'participant_name', page: 1, x: 72, y: 600, w: 220, h: 24 },
  { key: 'email', page: 1, x: 72, y: 560, w: 220, h: 24 },
  { key: 'date', page: 2, x: 72, y: 500, w: 120, h: 24 },
  { key: 'participant_signature', page: 2, x: 72, y: 380, w: 200, h: 70 },
  { key: 'guardian_signature', page: 2, x: 320, y: 380, w: 200, h: 70 },
];
const png = (buffer = signaturePng()) =>
  `data:image/png;base64,${buffer.toString('base64')}`;

async function pagesPdf(count: number): Promise<Uint8Array> {
  return pdfOfSize(Array.from({ length: count }, () => [612, 792]));
}

describe('form versions with an original PDF', () => {
  let app: INestApplication<App>;
  let adminRepo: InMemoryFormAdminRepository;
  let forms: InMemoryFormSigningRepository;
  let storage: InMemoryPrivateStorage;
  let mailer: RecordingMailer;
  let audit: ReturnType<typeof recordingAudit>;
  let ipCounter = 0;

  beforeEach(async () => {
    adminRepo = new InMemoryFormAdminRepository();
    forms = new InMemoryFormSigningRepository();
    storage = new InMemoryPrivateStorage();
    mailer = new RecordingMailer();
    audit = recordingAudit();
    const templates = new InMemoryDocumentTemplatesRepository();
    app = await startDocumentsApp(
      Test.createTestingModule({
        controllers: [
          AdminFormsController,
          AdminSignaturesController,
          SignFormsController,
        ],
        providers: [
          ...seasonsProviders(seasonsRepo('2026/27')),
          AdminFormsService,
          DocumentTemplatesService,
          FormSigningService,
          SignatureLookupsService,
          MeDocumentsService,
          DocumentNotificationsService,
          PdfWorkQueue,
          SignFormsThrottlerGuard,
          { provide: FormAdminRepository, useValue: adminRepo },
          { provide: FormSigningRepository, useValue: forms },
          { provide: PrivateStorageClient, useValue: storage },
          { provide: MailerService, useValue: mailer.asService() },
          { provide: AuditService, useValue: audit },
          { provide: ConfigService, useValue: { get: () => undefined } },
          {
            provide: DocumentSubjectsRepository,
            useValue: new InMemoryDocumentSubjectsRepository(),
          },
          { provide: DocumentTemplatesRepository, useValue: templates },
          {
            provide: DocumentAssignmentsRepository,
            useValue: new InMemoryDocumentAssignmentsRepository(templates),
          },
        ],
      }),
      (a) => a.use(signingBodyParser),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    return app.close();
  });

  const as = (auth: string) => {
    const call = (method: 'get' | 'post' | 'put' | 'patch' | 'delete') => {
      return (path: string, body?: object) => {
        const req = request(app.getHttpServer())
          [method](path)
          .set('authorization', auth)
          .set('fly-client-ip', '198.51.100.1');
        return body ? req.send(body) : req;
      };
    };
    return {
      get: call('get'),
      post: call('post'),
      put: call('put'),
      patch: call('patch'),
      delete: call('delete'),
    };
  };
  const admin = as(ADMIN_AUTH);
  const nextIp = () => `203.0.113.${++ipCounter % 250}`;

  const draftOf = (id: string) =>
    adminRepo.forms.get(id)!.versions.find((v) => !v.published_at)!;

  const draftForm = async () => {
    const { id } = (
      await admin
        .post('/admin/documents/forms', {
          slug: 'boat-rental',
          titleEn: 'Boat rental',
        })
        .expect(201)
    ).body as FormTemplate;
    await admin
      .put(`/admin/documents/forms/${id}/versions/en`, {
        title: 'Boat rental agreement',
        bodyMarkdown: 'Read the attached agreement.',
      })
      .expect(200);
    return id;
  };
  const uploadPdf = async (
    id: string,
    bytes: Uint8Array,
    status = 200,
  ): Promise<
    FormTemplate & { placementsCleared: boolean; message: string }
  > => {
    const version = draftOf(id).version;
    const res = await admin
      .post(`/admin/documents/forms/${id}/versions/en/source/upload-url`, {
        contentLength: bytes.byteLength,
      })
      .expect(200);
    expect(res.body).toEqual({
      uploadUrl: `memory://PUT/${storageKeys.formUpload(id, 'en', version)}`,
      expiresAt: expect.any(String) as unknown,
    });
    storage.seed(storageKeys.formUpload(id, 'en', version), bytes);
    return (
      await admin
        .post(`/admin/documents/forms/${id}/versions/en/source/confirm`)
        .expect(status)
    ).body as FormTemplate & { placementsCleared: boolean; message: string };
  };

  describe('admin', () => {
    it('is admin only', async () => {
      const id = randomUUID();
      const instructor = as(INSTRUCTOR_AUTH);
      const base = `/admin/documents/forms/${id}/versions/en`;
      await instructor
        .post(`${base}/source/upload-url`, { contentLength: 10 })
        .expect(403);
      await instructor.post(`${base}/source/confirm`).expect(403);
      await instructor.delete(`${base}/source`).expect(403);
      await instructor
        .put(`${base}/placements`, { placements: [] })
        .expect(403);
      await instructor
        .patch(`/admin/documents/forms/${id}`, { emailCopy: false })
        .expect(403);
      await instructor
        .get('/admin/signatures/check?email=mia@example.com')
        .expect(403);
      await request(app.getHttpServer())
        .get('/admin/signatures/check?email=mia@example.com')
        .expect(401);
      expect(adminRepo.checkCalls).toEqual([]);
    });

    it('uploads an original PDF for a draft, places its fields and publishes only when every required field is placed', async () => {
      const id = await draftForm();

      const confirmed = await uploadPdf(id, await pdfFixture('normal'));

      const sourceKey = draftOf(id).source_key!;
      expect(sourceKey).toMatch(
        new RegExp(
          `^${storageKeys.formVersion(id, 'en', 1)}source-[0-9a-f-]{36}\\.pdf$`,
        ),
      );
      const stored = storage.objects.get(sourceKey)!;
      expect(confirmed.placementsCleared).toBe(false);
      expect(confirmed.languages.en.draft).toMatchObject({
        originalPdf: {
          sha256: sha256Hex(stored.body),
          sizeBytes: stored.body.length,
          pageCount: 2,
          pages: [LETTER, LETTER],
          url: `memory://GET/${sourceKey}`,
          urlExpiresAt: expect.any(String) as unknown,
        },
        placements: [],
      });
      expect(storage.objects.has(storageKeys.formUpload(id, 'en', 1))).toBe(
        false,
      );

      const blocked = await admin
        .post(`/admin/documents/forms/${id}/versions/en/publish`)
        .expect(400);
      expect((blocked.body as { message: string }).message).toBe(
        'Place these required fields on the PDF before publishing: participant_name, email, date, participant_signature',
      );

      for (const [placement, message] of [
        [{ ...PLACEMENTS[0], key: 'nickname' }, /nickname is not a field/],
        [{ ...PLACEMENTS[0], page: 3 }, /the PDF has 2 page/],
        [{ ...PLACEMENTS[0], x: 500 }, /outside page 1/],
      ] as const) {
        const res = await admin
          .put(`/admin/documents/forms/${id}/versions/en/placements`, {
            placements: [placement],
          })
          .expect(400);
        expect((res.body as { message: string }).message).toMatch(message);
      }

      const placed = (
        await admin
          .put(`/admin/documents/forms/${id}/versions/en/placements`, {
            placements: PLACEMENTS,
          })
          .expect(200)
      ).body as FormTemplate;
      expect(placed.languages.en.draft!.placements).toEqual(PLACEMENTS);

      const published = (
        await admin
          .post(`/admin/documents/forms/${id}/versions/en/publish`)
          .expect(200)
      ).body as FormTemplate;
      expect(published.languages.en.published).toMatchObject({
        version: 1,
        originalPdf: { pageCount: 2 },
        placements: PLACEMENTS,
      });
      expect(audit.entries.map((e) => e.action)).toEqual([
        'document_template.create',
        'document_template.form_draft_save',
        'document_template.source_replace',
        'document_template.form_placements_update',
        'document_template.publish',
      ]);
    });

    it('carries the PDF into the next draft, and removing it there keeps the published copy', async () => {
      const id = await draftForm();
      await uploadPdf(id, await pdfFixture('normal'));
      await admin
        .put(`/admin/documents/forms/${id}/versions/en/placements`, {
          placements: PLACEMENTS,
        })
        .expect(200);
      await admin
        .post(`/admin/documents/forms/${id}/versions/en/publish`)
        .expect(200);

      const next = (
        await admin
          .put(`/admin/documents/forms/${id}/versions/en`, {
            title: 'Boat rental agreement',
            bodyMarkdown: 'Read the attached agreement, v2.',
          })
          .expect(200)
      ).body as FormTemplate;
      expect(next.languages.en.draft).toMatchObject({
        version: 2,
        originalPdf: { pageCount: 2 },
        placements: PLACEMENTS,
      });

      const removed = (
        await admin
          .delete(`/admin/documents/forms/${id}/versions/en/source`)
          .expect(200)
      ).body as FormTemplate;
      expect(removed.languages.en.draft).toMatchObject({
        originalPdf: null,
        placements: [],
      });
      expect(removed.languages.en.published!.originalPdf).not.toBeNull();
      expect(
        storage.objects.has(
          removed.languages.en.published!.originalPdf!.url.replace(
            'memory://GET/',
            '',
          ),
        ),
      ).toBe(true);
      await admin
        .delete(`/admin/documents/forms/${id}/versions/en/source`)
        .expect(404);
      await admin
        .put(`/admin/documents/forms/${id}/versions/en/placements`, {
          placements: PLACEMENTS,
        })
        .expect(400);
      await admin
        .post(`/admin/documents/forms/${id}/versions/en/publish`)
        .expect(200);
    });

    it('clears placements when a replacement PDF has a different page layout', async () => {
      const id = await draftForm();
      await uploadPdf(id, await pdfFixture('normal'));
      await admin
        .put(`/admin/documents/forms/${id}/versions/en/placements`, {
          placements: PLACEMENTS,
        })
        .expect(200);

      const same = await uploadPdf(id, await pagesPdf(2));
      expect(same.placementsCleared).toBe(false);
      expect(same.languages.en.draft!.placements).toEqual(PLACEMENTS);

      const replaced = await uploadPdf(id, await pagesPdf(3));
      expect(replaced.placementsCleared).toBe(true);
      expect(replaced.languages.en.draft).toMatchObject({
        originalPdf: { pageCount: 3 },
        placements: [],
      });
    });

    it('refuses an upload with no draft, an oversized or non-PDF file and more than 30 pages', async () => {
      const { id } = (
        await admin
          .post('/admin/documents/forms', { slug: 'empty', titleEn: 'Empty' })
          .expect(201)
      ).body as FormTemplate;
      await admin
        .post(`/admin/documents/forms/${id}/versions/en/source/upload-url`, {
          contentLength: 1000,
        })
        .expect(400);

      const draftId = await draftForm();
      await admin
        .post(
          `/admin/documents/forms/${draftId}/versions/en/source/upload-url`,
          { contentLength: 10 * 1024 * 1024 + 1 },
        )
        .expect(400);
      const notPdf = await uploadPdf(draftId, Buffer.from('hello'), 400);
      expect(notPdf.message).toBe('The file is not a readable PDF');
      const tooLong = await uploadPdf(draftId, await pagesPdf(31), 400);
      expect(tooLong.message).toBe('The PDF has more than 30 pages');
      expect(
        storage.objects.has(storageKeys.formUpload(draftId, 'en', 1)),
      ).toBe(false);
      expect(storage.objects.size).toBe(0);
    });

    it('keeps the published original and its hash when a replacement confirmation finishes after publishing', async () => {
      const id = await draftForm();
      await uploadPdf(id, await pdfFixture('normal'));
      await admin
        .put(`/admin/documents/forms/${id}/versions/en/placements`, {
          placements: PLACEMENTS,
        })
        .expect(200);
      const before = structuredClone(draftOf(id));
      jest
        .spyOn(storage, 'put')
        .mockImplementationOnce(async (key, body, contentType) => {
          await admin
            .post(`/admin/documents/forms/${id}/versions/en/publish`)
            .expect(200);
          storage.seed(key, body, contentType);
        });

      const stale = await uploadPdf(id, await pagesPdf(2), 409);

      expect(stale.message).toBe(
        'This form was changed by someone else; reload it and try again',
      );
      const [published] = adminRepo.forms.get(id)!.versions;
      expect(published).toMatchObject({
        published_at: expect.any(String) as unknown,
        source_key: before.source_key,
        source_sha256: before.source_sha256,
        placements: PLACEMENTS,
      });
      expect(sha256Hex(storage.objects.get(published.source_key!)!.body)).toBe(
        published.source_sha256,
      );
      expect(
        [...storage.objects.keys()].filter((key) => key.includes('/source-')),
      ).toEqual([published.source_key]);
    });

    it('refuses to publish a draft whose PDF changed after its placements were checked', async () => {
      const id = await draftForm();
      await uploadPdf(id, await pdfFixture('normal'));
      await admin
        .put(`/admin/documents/forms/${id}/versions/en/placements`, {
          placements: PLACEMENTS,
        })
        .expect(200);
      const publishDraft = adminRepo.publishDraft.bind(
        adminRepo,
      ) as typeof adminRepo.publishDraft;
      jest
        .spyOn(adminRepo, 'publishDraft')
        .mockImplementationOnce(async (...args) => {
          const replaced = await uploadPdf(id, await pagesPdf(3));
          expect(replaced.placementsCleared).toBe(true);
          return publishDraft(...args);
        });

      await admin
        .post(`/admin/documents/forms/${id}/versions/en/publish`)
        .expect(409);

      const draft = draftOf(id);
      expect(draft).toMatchObject({ page_count: 3, placements: [] });
      expect(sha256Hex(storage.objects.get(draft.source_key!)!.body)).toBe(
        draft.source_sha256,
      );
      await admin
        .post(`/admin/documents/forms/${id}/versions/en/publish`)
        .expect(400);
    });

    it('stores a replacement after publishing as a new object of the next draft, leaving the published original as recorded', async () => {
      const id = await draftForm();
      await uploadPdf(id, await pdfFixture('normal'));
      await admin
        .put(`/admin/documents/forms/${id}/versions/en/placements`, {
          placements: PLACEMENTS,
        })
        .expect(200);
      await admin
        .post(`/admin/documents/forms/${id}/versions/en/publish`)
        .expect(200);
      const published = structuredClone(adminRepo.forms.get(id)!.versions[0]);
      const publishedBytes = storage.objects.get(published.source_key!)!.body;
      await admin
        .put(`/admin/documents/forms/${id}/versions/en`, {
          title: 'Boat rental agreement',
          bodyMarkdown: 'Read the attached agreement, v2.',
        })
        .expect(200);

      const replaced = await uploadPdf(id, await pagesPdf(2));
      const replacedAgain = await uploadPdf(id, await pagesPdf(2));

      const draft = draftOf(id);
      expect(draft.version).toBe(2);
      expect(
        draft.source_key!.startsWith(storageKeys.formVersion(id, 'en', 2)),
      ).toBe(true);
      expect(replaced.languages.en.draft!.placements).toEqual(PLACEMENTS);
      expect(replacedAgain.languages.en.published).toMatchObject({
        version: 1,
        originalPdf: { sha256: published.source_sha256 },
      });
      expect(adminRepo.forms.get(id)!.versions[0]).toEqual(published);
      expect(
        storage.objects.get(published.source_key!)!.body.equals(publishedBytes),
      ).toBe(true);
      expect(sha256Hex(publishedBytes)).toBe(published.source_sha256);
      expect(
        [...storage.objects.keys()].filter((key) => key.includes('/source-')),
      ).toEqual([published.source_key, draft.source_key]);
    });

    it('strips annotations, page and document actions, scripts and attached files from the stored original and the signed copy', async () => {
      const input = await pdfFixture('activeContent');
      expect(await activeContentIn(input)).toContain('JS');
      const id = await draftForm();

      await uploadPdf(id, input);
      await admin
        .put(`/admin/documents/forms/${id}/versions/en/placements`, {
          placements: PLACEMENTS,
        })
        .expect(200);
      await admin
        .post(`/admin/documents/forms/${id}/versions/en/publish`)
        .expect(200);

      const [published] = adminRepo.forms.get(id)!.versions;
      const original = storage.objects.get(published.source_key!)!.body;
      expect(await activeContentIn(original)).toEqual([]);
      expect(await pdftotext(original)).toContain('Alice Example');
      forms.seedForm('active-content', [
        formVersion(id, 'en', 1, { ...published }),
      ]);
      await request(app.getHttpServer())
        .post('/sign/forms/active-content/complete')
        .set('fly-client-ip', nextIp())
        .send({
          lang: 'en',
          version: 1,
          consent: true,
          answers: {
            participant_name: 'Mia Chen',
            email: 'mia@example.com',
            date: '2026-12-20',
          },
          signatures: { participant_signature: png() },
        })
        .expect(201);
      const signed = storage.objects.get(forms.signed[0].signed_key!)!.body;
      expect(await activeContentIn(signed)).toEqual([]);
      expect((await pdftotext(signed)).split('\f')[0]).toContain('Mia Chen');
    });

    it('refuses a PDF too complex to normalise within the worker limits with a 422 and keeps working', async () => {
      const id = await draftForm();

      const refused = await uploadPdf(id, annotationHeavyPdf(60_000), 422);

      expect(refused.message).toBe(
        'This PDF is too complex to process; print it to a new PDF and upload that',
      );
      expect(storage.objects.size).toBe(0);
      const accepted = await uploadPdf(id, await pdfFixture('normal'));
      expect(accepted.languages.en.draft!.originalPdf!.pageCount).toBe(2);
    });

    it('lists per language whether the published version has an original PDF, and when the form last changed', async () => {
      const id = await draftForm();
      await uploadPdf(id, await pdfFixture('normal'));
      const draftOnly = await admin.get('/admin/documents/forms').expect(200);
      await admin
        .put(`/admin/documents/forms/${id}/versions/en/placements`, {
          placements: PLACEMENTS,
        })
        .expect(200);
      await admin
        .post(`/admin/documents/forms/${id}/versions/en/publish`)
        .expect(200);

      const list = await admin.get('/admin/documents/forms').expect(200);

      const form = adminRepo.forms.get(id)!;
      expect(draftOnly.body).toEqual([
        expect.objectContaining({ hasOriginalPdf: { en: false, zh: false } }),
      ]);
      expect(list.body).toEqual([
        expect.objectContaining({
          id,
          publishedVersions: { en: 1, zh: null },
          hasDraft: { en: false, zh: false },
          hasOriginalPdf: { en: true, zh: false },
          updatedAt: form.updated_at,
          lastChangedAt: form.versions[0].updated_at,
        }),
      ]);
      expect(Date.parse(form.versions[0].updated_at)).toBeGreaterThan(
        Date.parse(form.updated_at),
      );
    });

    it('turns the emailed copy off and on per form, on by default', async () => {
      const id = await draftForm();
      expect(
        ((await admin.get(`/admin/documents/forms/${id}`)).body as FormTemplate)
          .emailCopy,
      ).toBe(true);

      const off = (
        await admin
          .patch(`/admin/documents/forms/${id}`, { emailCopy: false })
          .expect(200)
      ).body as FormTemplate;

      expect(off.emailCopy).toBe(false);
      const list = await admin.get('/admin/documents/forms').expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({ id, emailCopy: false }),
      ]);
      await admin
        .patch(`/admin/documents/forms/${id}`, { emailCopy: 'no' })
        .expect(400);
    });
  });

  describe('GET /admin/signatures/check', () => {
    it('answers for the exact lower-cased email with only signed, date and titles', async () => {
      adminRepo.checkRows.set('mia.chen@example.com', [
        { title_en: 'Lesson waiver', signed_at: '2026-11-02T00:00:00Z' },
        { title_en: 'Boat rental', signed_at: '2026-10-01T00:00:00Z' },
      ]);

      const hit = await admin
        .get('/admin/signatures/check?email=%20Mia.Chen@Example.com%20')
        .expect(200);
      const miss = await admin
        .get('/admin/signatures/check?email=mia@example.com')
        .expect(200);

      expect(adminRepo.checkCalls).toEqual([
        'mia.chen@example.com',
        'mia@example.com',
      ]);
      expect(hit.body).toEqual({
        signed: true,
        signedAt: '2026-11-02T00:00:00Z',
        templateTitles: ['Lesson waiver', 'Boat rental'],
      });
      expect(miss.body).toEqual({
        signed: false,
        signedAt: null,
        templateTitles: [],
      });
    });

    it('needs one valid email', async () => {
      await admin.get('/admin/signatures/check').expect(400);
      await admin.get('/admin/signatures/check?email=mia').expect(400);
      await admin.get('/admin/signatures/check?email=mia@').expect(400);
      expect(adminRepo.checkCalls).toEqual([]);
    });

    it('429s the 61st check a minute', async () => {
      for (let i = 0; i < 60; i += 1) {
        await admin
          .get('/admin/signatures/check?email=a@example.com')
          .expect(200);
      }
      await admin
        .get('/admin/signatures/check?email=a@example.com')
        .expect(429);
    });
  });

  describe('public signing', () => {
    const TEMPLATE_ID = randomUUID();
    let source: Uint8Array;
    let sourceSha256: string;

    const pdfVersion = (
      language: 'en' | 'zh',
      version: number,
      overrides: Partial<FormVersionRow> = {},
    ) =>
      formVersion(TEMPLATE_ID, language, version, {
        source_key: storageKeys.formSource(
          TEMPLATE_ID,
          language,
          version,
          'seed',
        ),
        source_sha256: sourceSha256,
        source_size_bytes: source.byteLength,
        page_count: 2,
        pages: [LETTER, LETTER],
        placements: PLACEMENTS,
        ...overrides,
      });

    beforeEach(async () => {
      ({ bytes: source, sha256: sourceSha256 } = await normaliseTemplatePdf(
        await pdfFixture('normal'),
      ));
      storage.seed(
        storageKeys.formSource(TEMPLATE_ID, 'en', 1, 'seed'),
        source,
      );
      forms.seedForm('boat-rental', [pdfVersion('en', 1)]);
      forms.seedForm('waiver', [formVersion(randomUUID(), 'en', 1)]);
    });

    const complete = (slug: string, overrides: Record<string, unknown> = {}) =>
      request(app.getHttpServer())
        .post(`/sign/forms/${slug}/complete`)
        .set('fly-client-ip', nextIp())
        .send({
          lang: 'en',
          version: 1,
          consent: true,
          answers: {
            participant_name: 'Mia Chen',
            email: 'Mia@Example.com',
            date: '2026-12-20',
          },
          signatures: { participant_signature: png() },
          ...overrides,
        });

    it('says whether the served version has an original PDF and whether a copy is emailed', async () => {
      const withPdf = (
        await request(app.getHttpServer())
          .get('/sign/forms/boat-rental?lang=zh')
          .expect(200)
      ).body as PublicForm;
      const without = (
        await request(app.getHttpServer()).get('/sign/forms/waiver').expect(200)
      ).body as PublicForm;

      expect(withPdf).toMatchObject({
        lang: 'en',
        hasOriginalPdf: true,
        emailCopy: true,
      });
      expect(without).toMatchObject({ hasOriginalPdf: false, emailCopy: true });
    });

    it('redirects to a short-lived URL of the newest published original, and 404s without one', async () => {
      const res = await request(app.getHttpServer())
        .get('/sign/forms/boat-rental/original?lang=zh')
        .expect(302);

      expect(res.headers.location).toBe(
        `memory://GET/${storageKeys.formSource(TEMPLATE_ID, 'en', 1, 'seed')}`,
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect(storage.presigned.at(-1)).toMatchObject({
        op: 'GET',
        input: {
          contentDisposition: 'inline; filename="boat-rental-en-v1.pdf"',
        },
      });
      await request(app.getHttpServer())
        .get('/sign/forms/waiver/original')
        .expect(404);
      await request(app.getHttpServer())
        .get('/sign/forms/unknown/original')
        .expect(404);
    });

    it('stamps the answers and drawn signature onto the original PDF at their places and appends the audit page', async () => {
      const res = await complete('boat-rental').expect(201);

      expect(res.body).toEqual({ status: 'signed', emailed: true });
      const [signed] = forms.signed;
      expect(signed.template_sha256).toBe(sourceSha256);
      const stored = storage.objects.get(signed.signed_key!)!.body;
      expect(sha256Hex(stored)).toBe(signed.signed_sha256);
      expect((await PDFDocument.load(stored)).getPageCount()).toBe(3);
      const text = (await pdftotext(stored)).split('\f');
      expect(text[0]).toContain('Page 1');
      expect(text[0]).toContain('Mia Chen');
      expect(text[0]).toContain('mia@example.com');
      expect(text[1]).toContain('2026-12-20');
      expect(text.join(' ')).not.toContain('Read the attached agreement');
      expect(text[2]).toContain('Signature record / 签署记录');
      expect(text[2]).toContain(sourceSha256);
      expect(text[2]).toContain(signed.id);

      const page2 = await renderPage(stored, 2);
      const ink = (placement: FormPlacement) =>
        inkIn(page2, pixelRect(placement, LETTER));
      expect(ink(PLACEMENTS[3])).toBeGreaterThan(100);
      expect(ink(PLACEMENTS[4])).toBe(0);
      const [email] = mailer.sentOf('documents.completed');
      expect(email.attachments![0].content.equals(stored)).toBe(true);
    });

    it('does not email the copy when the form has it turned off, and still keeps the signature', async () => {
      forms.forms.find((f) => f.slug === 'boat-rental')!.emailCopy = false;

      const res = await complete('boat-rental').expect(201);

      expect(res.body).toEqual({ status: 'signed', emailed: false });
      expect(forms.signed).toHaveLength(1);
      expect(mailer.sent).toHaveLength(0);
      expect(forms.copyEmailClaims).toHaveLength(0);
      const form = await request(app.getHttpServer())
        .get('/sign/forms/boat-rental')
        .expect(200);
      expect((form.body as PublicForm).emailCopy).toBe(false);
    });

    it('still requires the email answer when the copy is off', async () => {
      forms.forms.find((f) => f.slug === 'boat-rental')!.emailCopy = false;

      await complete('boat-rental', {
        answers: { participant_name: 'Mia Chen', date: '2026-12-20' },
      }).expect(400);
      expect(forms.signed).toHaveLength(0);
    });

    it('renders the waiver text as before when the version has no original PDF', async () => {
      await complete('waiver').expect(201);

      const stored = storage.objects.get(forms.signed[0].signed_key!)!.body;
      const text = (await pdftotext(stored)).replace(/\s+/g, ' ');
      expect(text).toContain('I accept the risks of skiing.');
      expect(text).not.toContain('Page 1');
      expect(forms.signed[0].template_sha256).toBe(
        forms.forms[1].versions[0].body_sha256,
      );
    });

    it('fails without storing a signature when the stored original differs from its recorded hash', async () => {
      storage.seed(
        storageKeys.formSource(TEMPLATE_ID, 'en', 1, 'seed'),
        await pagesPdf(2),
      );

      await complete('boat-rental').expect(500);

      expect(forms.signed).toHaveLength(0);
      expect(storage.objects.size).toBe(1);
    });

    it('fails without storing a signature when stamping the original outgrows the worker limits, and signs the next form', async () => {
      const heavy = annotationHeavyPdf(60_000);
      const key = storageKeys.formSource(TEMPLATE_ID, 'zh', 1, 'heavy');
      storage.seed(key, heavy);
      forms.seedForm('heavy', [
        pdfVersion('zh', 1, {
          source_key: key,
          source_sha256: sha256Hex(heavy),
          page_count: 1,
          pages: [LETTER],
          placements: [],
        }),
      ]);

      await complete('heavy', { lang: 'zh' }).expect(500);

      expect(forms.signed).toHaveLength(0);
      await complete('boat-rental').expect(201);
      expect(forms.signed).toHaveLength(1);
    });

    it('fails without storing a signature when the original PDF is missing from storage', async () => {
      storage.objects.clear();

      await complete('boat-rental').expect(500);

      expect(forms.signed).toHaveLength(0);
      expect(storage.objects.size).toBe(0);
    });
  });
});

describe('stampFormPdf memory', () => {
  it('stamps a 10 MB, 30-page original with three 1000 × 600 signatures within the VM memory budget', async () => {
    const doc = await PDFDocument.create();
    const side = Math.floor(Math.sqrt((10 * 1024 * 1024) / 30 / 3)) - 1;
    for (let i = 0; i < 30; i += 1) {
      const page = doc.addPage([612, 792]);
      const image = doc.context.register(
        doc.context.stream(randomBytes(side * side * 3), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: side,
          Height: side,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
        }),
      );
      page.node.newXObject('Im', image);
    }
    const { bytes: source } = await normaliseTemplatePdf(
      await doc.save({ useObjectStreams: false }),
    );
    expect(source.byteLength).toBeLessThanOrEqual(10 * 1024 * 1024);
    const signature = signaturePng(1000, 600);
    const fields = formVersion(randomUUID(), 'en', 1).fields;
    await loadStampFonts();
    global.gc?.();
    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);

    const { bytes } = await stampFormPdf({
      source,
      fields,
      placements: [
        ...PLACEMENTS.slice(0, 4),
        { ...PLACEMENTS[4], page: 30 },
        { key: 'witness_signature', page: 30, x: 72, y: 100, w: 200, h: 70 },
      ],
      values: { participant_name: 'Mia Chen', email: 'mia@example.com' },
      signatures: {
        participant_signature: signature,
        guardian_signature: signature,
        witness_signature: signature,
      },
      audit: {
        titleEn: 'Boat rental',
        titleZh: null,
        templateSha256: 'a'.repeat(64),
        assignmentId: randomUUID(),
        signerName: 'Mia Chen',
        signerEmail: 'mia@example.com',
        consentEn: 'I agree',
        consentZh: '我同意',
        ip: null,
        userAgent: null,
        viewedAt: null,
        signedAt: '2026-11-08T00:00:00Z',
      },
    });

    clearInterval(sampler);
    peak = Math.max(peak, process.memoryUsage().rss);
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    console.log(
      `stampFormPdf ${mb(source.byteLength)} MB / 30 pages + 3 signatures: output ${mb(bytes.byteLength)} MB, ` +
        `RSS before ${mb(before)} MB, sampled peak ${mb(peak)} MB (+${mb(peak - before)} MB)`,
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(31);
    expect(peak - before).toBeLessThan(200 * 1024 * 1024);
  });
});
