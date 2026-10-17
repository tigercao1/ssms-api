import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH as admin,
  INSTRUCTOR_AUTH,
  INSTRUCTOR_USER_ID,
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
  InMemoryDocumentTemplatesRepository,
  InMemoryPrivateStorage,
  startDocumentsApp,
  translationRow,
} from '../../test/helpers/documents-fakes';
import { RecordingMailer } from '../../test/helpers/mailer-fakes';
import { pdfFixture } from '../../test/helpers/pdf-fixtures';
import { pdftotext } from '../../test/helpers/pdf-render';
import { signaturePng } from '../../test/helpers/png-fixtures';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import {
  seasonsProviders,
  seasonsRepo,
} from '../../test/helpers/seasons-fakes';
import { AuditService } from '../audit/audit.service';
import { MailerService } from '../mailer/mailer.service';
import { AdminDocumentTemplatesController } from './admin-document-templates.controller';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import { DocumentAssignmentsService } from './document-assignments.service';
import { DocumentNotificationsService } from './document-notifications.service';
import {
  PUBLISH_TRANSLATION_NEEDS_FIELDS,
  DocumentPublishingService,
} from './document-publishing.service';
import {
  DocumentSigningService,
  LANGUAGE_UNAVAILABLE,
} from './document-signing.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { DocumentTemplatesRepository } from './document-templates.repository';
import {
  DocumentTemplatesService,
  SOURCE_LANGUAGE_CONFLICT,
  TEMPLATE_HAS_NO_SOURCE,
  TEMPLATE_LOCKED,
  TRANSLATION_NEEDS_SOURCE_LANGUAGE,
  TRANSLATION_NOT_FOUND,
  TRANSLATION_SAME_AS_SOURCE,
} from './document-templates.service';
import type { DocumentTemplateRow, TemplateFieldRow } from './documents.types';
import { MeDocumentsController } from './me-documents.controller';
import { MeDocumentsService } from './me-documents.service';
import { PdfWorkQueue } from './pdf-work-queue';
import { PrivateStorageClient } from './private-storage.client';
import { signingBodyParser } from './signing-body-parser';
import { storageKeys } from './storage-keys';
import {
  type NormalisedTemplatePdf,
  normaliseTemplatePdf,
  sha256Hex,
} from './template-pdf';

jest.setTimeout(30_000);

const SEASON = '2026/27';
const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const A4 = { width: 595, height: 842, rotate: 0 as const, x: 0, y: 0 };

const field = (
  id: string,
  overrides: Partial<TemplateFieldRow> = {},
): TemplateFieldRow => ({
  id,
  type: 'signature',
  page: 1,
  x: 72,
  y: 100,
  w: 180,
  h: 50,
  required: true,
  label_en: 'Signature',
  label_zh: '签名',
  prefill: null,
  ...overrides,
});

const apiField = (id: string) => ({
  id,
  type: 'signature',
  page: 1,
  x: 72,
  y: 100,
  w: 180,
  h: 50,
  required: true,
  labelEn: 'Signature',
  labelZh: '签名',
  prefill: null,
});

async function a4Pdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText(text, { x: 72, y: 760, size: 18, font });
  return doc.save();
}

async function build() {
  const storage = new InMemoryPrivateStorage();
  const templates = new InMemoryDocumentTemplatesRepository();
  const subjects = new InMemoryDocumentSubjectsRepository();
  const assignments = new InMemoryDocumentAssignmentsRepository(
    templates,
    subjects,
  );
  const audit = recordingAudit();
  const app = await startDocumentsApp(
    Test.createTestingModule({
      controllers: [AdminDocumentTemplatesController, MeDocumentsController],
      providers: [
        ...seasonsProviders(seasonsRepo('2025/26', SEASON)),
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
        { provide: ConfigService, useValue: { get: () => undefined } },
        DocumentNotificationsService,
        { provide: MailerService, useValue: new RecordingMailer().asService() },
      ],
    }),
    (app) => app.use(signingBodyParser),
  );
  const instructor = subjects.seedInstructor({
    auth_user_id: INSTRUCTOR_USER_ID,
    email: 'alice@example.com',
    display_name_en: 'Alice Wang',
  });
  const main: NormalisedTemplatePdf = await normaliseTemplatePdf(
    await pdfFixture('normal'),
  );
  const english: NormalisedTemplatePdf = await normaliseTemplatePdf(
    await a4Pdf('English version'),
  );
  return {
    app,
    storage,
    templates,
    assignments,
    subjects,
    audit,
    instructor,
    main,
    english,
  };
}

describe('document language versions HTTP', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());
  const templatesUrl = '/admin/documents/templates';
  const translationUrl = (id: string, language: string) =>
    `${templatesUrl}/${id}/translations/${language}`;

  beforeEach(async () => {
    ctx = await build();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  function seedMain(
    overrides: Partial<DocumentTemplateRow> = {},
  ): DocumentTemplateRow {
    const key = `templates/main-${Math.random()}/source.pdf`;
    ctx.storage.seed(key, ctx.main.bytes);
    return ctx.templates.seed({
      title_en: 'Coach services agreement',
      title_zh: '教练服务协议',
      source_key: key,
      source_sha256: ctx.main.sha256,
      page_count: ctx.main.pageCount,
      pages: ctx.main.pages,
      fields: [field('sig_zh')],
      ...overrides,
    });
  }

  function seedBilingual(
    overrides: Partial<DocumentTemplateRow> = {},
  ): DocumentTemplateRow {
    const template = seedMain({ source_language: 'zh', ...overrides });
    const key = storageKeys.templateTranslationSource(template.id, 'en');
    ctx.storage.seed(key, ctx.english.bytes);
    const row = {
      ...template,
      translations: [
        translationRow({
          template_id: template.id,
          language: 'en',
          source_key: key,
          source_sha256: ctx.english.sha256,
          page_count: ctx.english.pageCount,
          pages: ctx.english.pages,
          fields: [
            field('sig_en', { x: 300, y: 400 }),
            field('date_en', {
              type: 'date',
              x: 300,
              y: 300,
              w: 100,
              h: 20,
              prefill: 'date_signed',
            }),
          ],
        }),
      ],
    };
    ctx.templates.rows.set(template.id, row);
    return row;
  }

  const completeAssignment = (templateId: string) =>
    ctx.assignments.seed({
      template_id: templateId,
      subject_id: ctx.subjects.seedInstructor().id,
      status: 'completed',
    });

  describe('unlabelled templates', () => {
    it('present without a language or versions and behave as before', async () => {
      const t = seedMain();
      const res = await http()
        .get(`${templatesUrl}/${t.id}`)
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toMatchObject({
        sourceLanguage: null,
        languages: [],
        translations: [],
        hasSource: true,
      });
      const list = await http()
        .get(templatesUrl)
        .set('Authorization', admin)
        .expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({ sourceLanguage: null, languages: [] }),
      ]);
      expect((list.body as object[])[0]).not.toHaveProperty('translations');
    });

    it('400 every version route until the main PDF has a language', async () => {
      const t = seedMain();
      const routes = [
        http()
          .post(`${translationUrl(t.id, 'en')}/source/upload-url`)
          .send({ contentLength: 100 }),
        http().post(`${translationUrl(t.id, 'en')}/source/confirm`),
        http()
          .put(`${translationUrl(t.id, 'en')}/fields`)
          .send({ fields: [] }),
        http().delete(translationUrl(t.id, 'en')),
      ];
      for (const route of routes) {
        const res = await route.set('Authorization', admin).expect(400);
        expect((res.body as { message: string }).message).toBe(
          TRANSLATION_NEEDS_SOURCE_LANGUAGE,
        );
      }
    });
  });

  describe('sourceLanguage', () => {
    it('is set on create and patch, audited, and validated', async () => {
      const created = await http()
        .post(templatesUrl)
        .set('Authorization', admin)
        .send({
          kind: 'sign',
          audience: 'instructor',
          titleEn: 'Agreement',
          required: true,
          sortOrder: 0,
          sourceLanguage: 'zh',
        })
        .expect(201);
      const id = (created.body as { id: string }).id;
      expect(created.body).toMatchObject({
        sourceLanguage: 'zh',
        languages: [],
        translations: [],
      });
      const patched = await http()
        .patch(`${templatesUrl}/${id}`)
        .set('Authorization', admin)
        .send({ sourceLanguage: 'en' })
        .expect(200);
      expect(patched.body).toMatchObject({ sourceLanguage: 'en' });
      expect(ctx.audit.entries.at(-1)).toMatchObject({
        action: 'document_template.update',
        metadata: {
          before: { source_language: 'zh' },
          after: { source_language: 'en' },
        },
      });
      await http()
        .patch(`${templatesUrl}/${id}`)
        .set('Authorization', admin)
        .send({ sourceLanguage: null })
        .expect(200);
      expect(ctx.templates.rows.get(id)?.source_language).toBeNull();
      await http()
        .patch(`${templatesUrl}/${id}`)
        .set('Authorization', admin)
        .send({ sourceLanguage: 'fr' })
        .expect(400);
    });

    it('cannot be cleared or moved onto an existing version', async () => {
      const t = seedBilingual();
      for (const sourceLanguage of [null, 'en']) {
        const res = await http()
          .patch(`${templatesUrl}/${t.id}`)
          .set('Authorization', admin)
          .send({ sourceLanguage })
          .expect(400);
        expect((res.body as { message: string }).message).toBe(
          SOURCE_LANGUAGE_CONFLICT,
        );
      }
      await http()
        .patch(`${templatesUrl}/${t.id}`)
        .set('Authorization', admin)
        .send({ sourceLanguage: 'zh', titleEn: 'Renamed' })
        .expect(200);
    });
  });

  describe('admin version routes', () => {
    it('presigns, confirms and presents the other language version', async () => {
      const t = seedMain({ source_language: 'zh' });
      const url = await http()
        .post(`${translationUrl(t.id, 'en')}/source/upload-url`)
        .set('Authorization', admin)
        .send({ contentLength: 1000 })
        .expect(200);
      const uploadKey = storageKeys.templateTranslationUpload(t.id, 'en');
      expect(url.body).toMatchObject({
        uploadUrl: `memory://PUT/${uploadKey}`,
      });
      ctx.storage.seed(uploadKey, await a4Pdf('English'));
      const res = await http()
        .post(`${translationUrl(t.id, 'en')}/source/confirm`)
        .set('Authorization', admin)
        .expect(200);
      const sourceKey = storageKeys.templateTranslationSource(t.id, 'en');
      const sha = sha256Hex(ctx.storage.objects.get(sourceKey)!.body);
      expect(res.body).toMatchObject({
        sourceLanguage: 'zh',
        languages: ['zh', 'en'],
        fieldsCleared: false,
        sourceSha256: ctx.main.sha256,
        translations: [
          {
            language: 'en',
            hasSource: true,
            sourceSha256: sha,
            pageCount: 1,
            pages: [A4],
            fields: [],
            sourceUrl: `memory://GET/${sourceKey}`,
          },
        ],
      });
      expect(ctx.storage.objects.has(uploadKey)).toBe(false);
      expect(ctx.templates.rows.get(t.id)?.source_key).toBe(t.source_key);
      expect(ctx.audit.entries.at(-1)).toMatchObject({
        action: 'document_template.translation_source_replace',
        targetId: t.id,
        metadata: {
          language: 'en',
          beforeSha256: null,
          afterSha256: sha,
          pageCount: 1,
          fieldsCleared: false,
        },
      });
      const list = await http()
        .get(templatesUrl)
        .set('Authorization', admin)
        .expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({
          sourceLanguage: 'zh',
          languages: ['zh', 'en'],
        }),
      ]);
    });

    it('400s a missing or invalid upload like the main version', async () => {
      const t = seedMain({ source_language: 'zh' });
      await http()
        .post(`${translationUrl(t.id, 'en')}/source/confirm`)
        .set('Authorization', admin)
        .expect(400);
      const uploadKey = storageKeys.templateTranslationUpload(t.id, 'en');
      ctx.storage.seed(uploadKey, await pdfFixture('xfa'));
      await http()
        .post(`${translationUrl(t.id, 'en')}/source/confirm`)
        .set('Authorization', admin)
        .expect(400);
      expect(ctx.storage.objects.has(uploadKey)).toBe(false);
      ctx.storage.seed(uploadKey, Buffer.from('nope'), 'text/plain');
      await http()
        .post(`${translationUrl(t.id, 'en')}/source/confirm`)
        .set('Authorization', admin)
        .expect(400);
      expect(ctx.templates.rows.get(t.id)?.translations).toEqual([]);
    });

    it('keeps fields on a same-layout replacement and clears them when the layout changes', async () => {
      const t = seedBilingual();
      const uploadKey = storageKeys.templateTranslationUpload(t.id, 'en');
      const confirm = () =>
        http()
          .post(`${translationUrl(t.id, 'en')}/source/confirm`)
          .set('Authorization', admin)
          .expect(200);
      ctx.storage.seed(uploadKey, await a4Pdf('English v2'));
      const kept = await confirm();
      expect(kept.body).toMatchObject({ fieldsCleared: false });
      expect(
        (kept.body as { translations: { fields: unknown[] }[] }).translations[0]
          .fields,
      ).toHaveLength(2);
      ctx.storage.seed(uploadKey, await pdfFixture('normal'));
      const cleared = await confirm();
      expect(cleared.body).toMatchObject({
        fieldsCleared: true,
        translations: [{ language: 'en', pageCount: 2, fields: [] }],
      });
      expect(ctx.audit.entries.at(-1)).toMatchObject({
        metadata: {
          language: 'en',
          beforeSha256: expect.any(String) as unknown,
          fieldsCleared: true,
          clearedFieldCount: 2,
        },
      });
      expect(ctx.templates.rows.get(t.id)?.fields).toEqual([field('sig_zh')]);
    });

    it('places fields against the version pages and audits the change', async () => {
      const t = seedBilingual();
      const res = await http()
        .put(`${translationUrl(t.id, 'en')}/fields`)
        .set('Authorization', admin)
        .send({ fields: [apiField('only_en')] })
        .expect(200);
      expect(res.body).toMatchObject({
        fields: [expect.objectContaining({ id: 'sig_zh' })],
        translations: [{ language: 'en', fields: [apiField('only_en')] }],
      });
      expect(ctx.audit.entries.at(-1)).toMatchObject({
        action: 'document_template.translation_fields_update',
        metadata: { language: 'en', beforeCount: 2, afterCount: 1 },
      });
      await http()
        .put(`${translationUrl(t.id, 'en')}/fields`)
        .set('Authorization', admin)
        .send({ fields: [{ ...apiField('off'), y: 830 }] })
        .expect(400);
      await http()
        .put(`${translationUrl(t.id, 'en')}/fields`)
        .set('Authorization', admin)
        .send({ fields: [{ ...apiField('two'), page: 2 }] })
        .expect(400);
    });

    it('400s fields before the version has a PDF', async () => {
      const t = seedMain({ source_language: 'zh' });
      const res = await http()
        .put(`${translationUrl(t.id, 'en')}/fields`)
        .set('Authorization', admin)
        .send({ fields: [] })
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        TEMPLATE_HAS_NO_SOURCE,
      );
    });

    it('removes a version, its files and audits it, then 404s', async () => {
      const t = seedBilingual();
      const res = await http()
        .delete(translationUrl(t.id, 'en'))
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toMatchObject({
        sourceLanguage: 'zh',
        languages: ['zh'],
        translations: [],
      });
      expect(ctx.storage.deleted).toEqual(
        expect.arrayContaining([
          storageKeys.templateTranslationSource(t.id, 'en'),
          storageKeys.templateTranslationUpload(t.id, 'en'),
        ]),
      );
      expect(ctx.audit.entries.at(-1)).toMatchObject({
        action: 'document_template.translation_remove',
        metadata: {
          language: 'en',
          sourceSha256: ctx.english.sha256,
          fieldCount: 2,
        },
      });
      const again = await http()
        .delete(translationUrl(t.id, 'en'))
        .set('Authorization', admin)
        .expect(404);
      expect((again.body as { message: string }).message).toBe(
        TRANSLATION_NOT_FOUND,
      );
    });

    it('400s the main language and unknown languages, 404s an unknown template', async () => {
      const t = seedBilingual();
      const same = await http()
        .post(`${translationUrl(t.id, 'zh')}/source/upload-url`)
        .set('Authorization', admin)
        .send({ contentLength: 100 })
        .expect(400);
      expect((same.body as { message: string }).message).toBe(
        TRANSLATION_SAME_AS_SOURCE,
      );
      await http()
        .delete(translationUrl(t.id, 'zh'))
        .set('Authorization', admin)
        .expect(400);
      await http()
        .put(`${translationUrl(t.id, 'fr')}/fields`)
        .set('Authorization', admin)
        .send({ fields: [] })
        .expect(400);
      await http()
        .post(`${translationUrl(t.id, 'en')}/source/upload-url`)
        .set('Authorization', admin)
        .send({ contentLength: 0 })
        .expect(400);
      await http()
        .delete(translationUrl(UNKNOWN_ID, 'en'))
        .set('Authorization', admin)
        .expect(404);
    });

    it('409s every version change once an assignment is completed', async () => {
      const t = seedBilingual();
      completeAssignment(t.id);
      const routes = [
        http()
          .post(`${translationUrl(t.id, 'en')}/source/upload-url`)
          .send({ contentLength: 100 }),
        http().post(`${translationUrl(t.id, 'en')}/source/confirm`),
        http()
          .put(`${translationUrl(t.id, 'en')}/fields`)
          .send({ fields: [] }),
        http().delete(translationUrl(t.id, 'en')),
      ];
      for (const route of routes) {
        const res = await route.set('Authorization', admin).expect(409);
        expect((res.body as { message: string }).message).toBe(TEMPLATE_LOCKED);
      }
      expect(ctx.templates.rows.get(t.id)?.translations).toHaveLength(1);
    });

    it('needs an admin', async () => {
      const t = seedBilingual();
      await http().delete(translationUrl(t.id, 'en')).expect(401);
      await http()
        .delete(translationUrl(t.id, 'en'))
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(403);
    });
  });

  describe('publish', () => {
    const publish = (id: string) =>
      http()
        .post(`${templatesUrl}/${id}/publish`)
        .set('Authorization', admin)
        .send({ assignTo: 'selected', season: SEASON });

    it('400s a sign document whose uploaded version has no fields', async () => {
      const t = seedBilingual({ status: 'draft' });
      ctx.templates.rows.set(t.id, {
        ...t,
        translations: [{ ...t.translations[0], fields: [] }],
      });
      const res = await publish(t.id).expect(400);
      expect((res.body as { message: string }).message).toBe(
        PUBLISH_TRANSLATION_NEEDS_FIELDS,
      );
    });

    it('publishes when the version has fields, or has no PDF yet, or the document is read only', async () => {
      const ready = seedBilingual({ status: 'draft' });
      await publish(ready.id).expect(200);
      const pending = seedMain({ status: 'draft', source_language: 'zh' });
      ctx.templates.rows.set(pending.id, {
        ...pending,
        translations: [
          translationRow({ template_id: pending.id, language: 'en' }),
        ],
      });
      await publish(pending.id).expect(200);
      const read = seedBilingual({ status: 'draft', kind: 'read', fields: [] });
      ctx.templates.rows.set(read.id, {
        ...read,
        translations: [{ ...read.translations[0], fields: [] }],
      });
      await publish(read.id).expect(200);
    });
  });

  describe('signer', () => {
    const open = (id: string, language?: string) =>
      http()
        .get(`/me/documents/${id}`)
        .query(language ? { language } : {})
        .set('Authorization', INSTRUCTOR_AUTH);
    const complete = (id: string, body: object) =>
      http()
        .post(`/me/documents/${id}/complete`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .send(body);
    const assign = (templateId: string) =>
      ctx.assignments.seed({
        template_id: templateId,
        subject_id: ctx.instructor.id,
        season: SEASON,
      });
    const PNG = signaturePng().toString('base64');
    const signWith = (ids: string[], language?: string | null) => ({
      consent: true,
      signerName: 'Alice Wang',
      signatures: Object.fromEntries(
        ids.map((id) => [id, { mode: 'drawn', png: PNG }]),
      ),
      ...(language === undefined ? {} : { language }),
    });

    it('opens the requested language version', async () => {
      const t = seedBilingual();
      const a = assign(t.id);
      const res = await open(a.id, 'en').expect(200);
      expect(res.body).toMatchObject({
        language: 'en',
        availableLanguages: ['zh', 'en'],
        sourceUrl: `memory://GET/${storageKeys.templateTranslationSource(t.id, 'en')}`,
        template: {
          id: t.id,
          titleZh: '教练服务协议',
          pageCount: 1,
          pages: [A4],
          fields: [
            expect.objectContaining({ id: 'sig_en' }),
            expect.objectContaining({ id: 'date_en' }),
          ],
        },
        assignment: { status: 'viewed', language: null },
      });
      const zh = await open(a.id, 'zh').expect(200);
      expect(zh.body).toMatchObject({
        language: 'zh',
        sourceUrl: `memory://GET/${t.source_key}`,
        template: { pageCount: 2, fields: [{ id: 'sig_zh' }] },
      });
      const plain = await open(a.id).expect(200);
      expect(plain.body).toMatchObject({ language: 'zh' });
    });

    it('falls back to the main version', async () => {
      const unlabelled = seedMain();
      const a = assign(unlabelled.id);
      const res = await open(a.id, 'en').expect(200);
      expect(res.body).toMatchObject({
        language: null,
        availableLanguages: [],
        sourceUrl: `memory://GET/${unlabelled.source_key}`,
        template: { pageCount: 2, fields: [{ id: 'sig_zh' }] },
      });
      const pending = seedMain({ source_language: 'zh', season: '2025/26' });
      ctx.templates.rows.set(pending.id, {
        ...pending,
        translations: [
          translationRow({ template_id: pending.id, language: 'en' }),
        ],
      });
      const b = ctx.assignments.seed({
        template_id: pending.id,
        subject_id: ctx.instructor.id,
        season: '2025/26',
      });
      const fallback = await open(b.id, 'en').expect(200);
      expect(fallback.body).toMatchObject({
        language: 'zh',
        availableLanguages: ['zh'],
      });
      await open(a.id, 'fr').expect(400);
    });

    it('stamps the chosen version and records its language and hash', async () => {
      const t = seedBilingual();
      const a = assign(t.id);
      await complete(a.id, signWith(['sig_zh'], 'en')).expect(400);
      const res = await complete(a.id, signWith(['sig_en'], 'en')).expect(200);
      expect(res.body).toMatchObject({
        assignment: {
          status: 'completed',
          language: 'en',
          templateSha256: ctx.english.sha256,
        },
      });
      const row = ctx.assignments.rows.get(a.id)!;
      expect(row).toMatchObject({
        language: 'en',
        template_sha256: ctx.english.sha256,
      });
      const signed = ctx.storage.objects.get(row.signed_key!)!.body;
      const doc = await PDFDocument.load(signed);
      expect(doc.getPageCount()).toBe(2);
      expect(doc.getPage(0).getSize()).toEqual({ width: 595, height: 842 });
      const text = await pdftotext(signed);
      expect(text).toContain('English version');
      expect(text).toContain(ctx.english.sha256);
    });

    it('signs the main version without a language', async () => {
      const t = seedBilingual();
      const a = assign(t.id);
      for (const language of [undefined, null]) {
        ctx.assignments.rows.set(a.id, {
          ...ctx.assignments.rows.get(a.id)!,
          status: 'viewed',
        });
        const res = await complete(a.id, signWith(['sig_zh'], language)).expect(
          200,
        );
        expect(res.body).toMatchObject({
          assignment: { language: 'zh', templateSha256: ctx.main.sha256 },
        });
      }
      const unlabelled = seedMain({ season: '2025/26' });
      const b = ctx.assignments.seed({
        template_id: unlabelled.id,
        subject_id: ctx.instructor.id,
        season: '2025/26',
      });
      const res = await complete(b.id, signWith(['sig_zh'])).expect(200);
      expect(res.body).toMatchObject({
        assignment: { language: null, templateSha256: ctx.main.sha256 },
      });
    });

    it('400s a language the document is not available in', async () => {
      const unlabelled = seedMain();
      const a = assign(unlabelled.id);
      const res = await complete(a.id, signWith(['sig_zh'], 'en')).expect(400);
      expect((res.body as { message: string }).message).toBe(
        LANGUAGE_UNAVAILABLE,
      );
      await complete(a.id, signWith(['sig_zh'], 'fr')).expect(400);
      const pending = seedMain({ source_language: 'zh', season: '2025/26' });
      ctx.templates.rows.set(pending.id, {
        ...pending,
        translations: [
          translationRow({ template_id: pending.id, language: 'en' }),
        ],
      });
      const b = ctx.assignments.seed({
        template_id: pending.id,
        subject_id: ctx.instructor.id,
        season: '2025/26',
      });
      await complete(b.id, signWith(['sig_zh'], 'en')).expect(400);
      expect(ctx.assignments.rows.get(a.id)?.status).toBe('assigned');
      expect(ctx.assignments.rows.get(b.id)?.status).toBe('assigned');
    });

    it('records the read version language and hash', async () => {
      const t = seedBilingual({ kind: 'read', fields: [] });
      const a = assign(t.id);
      const res = await complete(a.id, {
        acknowledged: true,
        language: 'en',
      }).expect(200);
      expect(res.body).toMatchObject({
        assignment: {
          status: 'completed',
          language: 'en',
          templateSha256: ctx.english.sha256,
        },
      });
    });

    it('lists the languages of each checklist document', async () => {
      const bilingual = seedBilingual({ sort_order: 1 });
      const single = seedMain({ sort_order: 2, source_language: 'zh' });
      const unlabelled = seedMain({ sort_order: 3 });
      for (const t of [bilingual, single, unlabelled]) {
        assign(t.id);
      }
      const res = await http()
        .get('/me/documents')
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200);
      const items = (
        res.body as { items: { type: string; templateId: string }[] }
      ).items.filter((item) => item.type === 'document');
      expect(items).toEqual([
        expect.objectContaining({
          templateId: bilingual.id,
          languages: ['zh', 'en'],
        }),
        expect.objectContaining({ templateId: single.id, languages: ['zh'] }),
        expect.objectContaining({ templateId: unlabelled.id, languages: [] }),
      ]);
    });

    it('lists languages on a pending instructor preview', async () => {
      ctx.subjects.instructors.set(ctx.instructor.id, {
        ...ctx.instructor,
        approval_status: 'pending',
      });
      const t = seedBilingual({ assign_to: 'all', season: SEASON });
      const res = await http()
        .get('/me/documents')
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200);
      expect(res.body).toMatchObject({
        locked: true,
        items: [
          expect.objectContaining({
            templateId: t.id,
            languages: ['zh', 'en'],
          }),
        ],
      });
    });
  });
});
