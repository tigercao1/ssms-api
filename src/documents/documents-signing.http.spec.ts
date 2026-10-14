import { PDFDocument } from '@cantoo/pdf-lib';
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
  UNVERIFIED_AUTH,
} from '../../test/helpers/documents-fakes';
import { pdfFixture } from '../../test/helpers/pdf-fixtures';
import {
  inkIn,
  pdffonts,
  pdftotext,
  pixelRect,
  renderPage,
} from '../../test/helpers/pdf-render';
import { signaturePng } from '../../test/helpers/png-fixtures';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { AdminDocumentAssignmentsController } from './admin-document-assignments.controller';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import { DocumentAssignmentsService } from './document-assignments.service';
import {
  DocumentCompletedHandler,
  type SignedDocument,
} from './document-completed.handler';
import {
  DocumentSigningService,
  SIGNING_CONSENT,
  torontoDate,
} from './document-signing.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { DocumentTemplatesRepository } from './document-templates.repository';
import type { TemplateFieldRow } from './documents.types';
import { MeDocumentsController } from './me-documents.controller';
import { MeDocumentsService } from './me-documents.service';
import { PdfWorkQueue } from './pdf-work-queue';
import { PrivateStorageClient } from './private-storage.client';
import {
  SIGNING_BODY_TOO_LARGE,
  signingBodyParser,
} from './signing-body-parser';
import { storageKeys } from './storage-keys';
import { normaliseTemplatePdf, sha256Hex } from './template-pdf';

jest.setTimeout(30_000);

const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';

const field = (
  id: string,
  type: TemplateFieldRow['type'],
  rect: Pick<TemplateFieldRow, 'x' | 'y' | 'w' | 'h'>,
  overrides: Partial<TemplateFieldRow> = {},
): TemplateFieldRow => ({
  id,
  type,
  page: 1,
  ...rect,
  required: true,
  label_en: id,
  label_zh: null,
  prefill: null,
  ...overrides,
});

const FIELDS: TemplateFieldRow[] = [
  field('sig', 'signature', { x: 72, y: 100, w: 180, h: 50 }),
  field('ini', 'initials', { x: 300, y: 100, w: 60, h: 40 }),
  field('name', 'full_name', { x: 72, y: 200, w: 240, h: 24 }),
  field(
    'when',
    'date',
    { x: 340, y: 200, w: 100, h: 20 },
    { prefill: 'date_signed' },
  ),
  field('agree', 'checkbox', { x: 72, y: 260, w: 18, h: 18 }),
  field('note', 'text', { x: 72, y: 300, w: 240, h: 20 }, { required: false }),
];

class RecordingCompletedHandler extends DocumentCompletedHandler {
  readonly calls: SignedDocument[] = [];
  fail = false;

  documentCompleted(document: SignedDocument): Promise<void> {
    this.calls.push(document);
    return this.fail
      ? Promise.reject(new Error('mailer down'))
      : Promise.resolve();
  }
}

async function build({ handler = true } = {}) {
  const storage = new InMemoryPrivateStorage();
  const templates = new InMemoryDocumentTemplatesRepository();
  const assignments = new InMemoryDocumentAssignmentsRepository(templates);
  const subjects = new InMemoryDocumentSubjectsRepository();
  const completed = new RecordingCompletedHandler();
  const app = await startDocumentsApp(
    Test.createTestingModule({
      controllers: [MeDocumentsController, AdminDocumentAssignmentsController],
      providers: [
        DocumentSigningService,
        DocumentAssignmentsService,
        MeDocumentsService,
        PdfWorkQueue,
        { provide: PrivateStorageClient, useValue: storage },
        { provide: DocumentTemplatesRepository, useValue: templates },
        { provide: DocumentAssignmentsRepository, useValue: assignments },
        { provide: DocumentSubjectsRepository, useValue: subjects },
        { provide: AuditService, useValue: recordingAudit() },
        { provide: ConfigService, useValue: { get: () => undefined } },
        ...(handler
          ? [{ provide: DocumentCompletedHandler, useValue: completed }]
          : []),
      ],
    }),
    (app) => app.use(signingBodyParser),
  );
  const instructor = subjects.seedInstructor({
    auth_user_id: INSTRUCTOR_USER_ID,
    email: 'alice@example.com',
    display_name_en: 'Alice Wang',
  });
  const source = await normaliseTemplatePdf(await pdfFixture('normal'));
  const sourceKey = 'templates/t/source.pdf';
  storage.seed(sourceKey, source.bytes);
  const signTemplate = templates.seed({
    kind: 'sign',
    title_en: 'Instructor agreement',
    title_zh: '教练协议',
    source_key: sourceKey,
    source_sha256: source.sha256,
    page_count: source.pageCount,
    pages: source.pages,
    fields: FIELDS,
  });
  const readTemplate = templates.seed({
    kind: 'read',
    title_en: 'Safety handbook',
    source_key: sourceKey,
    source_sha256: source.sha256,
    page_count: source.pageCount,
    pages: source.pages,
  });
  const signAssignment = assignments.seed({
    template_id: signTemplate.id,
    subject_id: instructor.id,
  });
  const readAssignment = assignments.seed({
    template_id: readTemplate.id,
    subject_id: instructor.id,
  });
  return {
    app,
    storage,
    templates,
    assignments,
    subjects,
    completed,
    instructor,
    source,
    signTemplate,
    signAssignment,
    readAssignment,
  };
}

const PNG = signaturePng().toString('base64');
const validSign = {
  consent: true,
  signerName: '王小明 Alice Wang',
  values: { agree: true, note: '已存档 on file' },
  signatures: {
    sig: { mode: 'drawn', png: PNG },
    ini: { mode: 'typed', text: 'AW' },
  },
};

describe('torontoDate', () => {
  it('uses the America/Toronto calendar date', () => {
    expect(torontoDate(new Date('2026-10-13T03:30:00Z'))).toBe('2026-10-12');
    expect(torontoDate(new Date('2026-10-13T04:30:00Z'))).toBe('2026-10-13');
    expect(torontoDate(new Date('2027-01-15T04:59:00Z'))).toBe('2027-01-14');
  });
});

describe('documents signing HTTP', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());
  const complete = (id: string, body: object, auth = INSTRUCTOR_AUTH) =>
    http()
      .post(`/me/documents/${id}/complete`)
      .set('Authorization', auth)
      .send(body);

  afterEach(async () => {
    await ctx.app.close();
  });

  describe('auth', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const meRoutes: [string, (r: ReturnType<typeof http>) => request.Test][] = [
      ['GET document', (r) => r.get(`/me/documents/${UNKNOWN_ID}`)],
      [
        'POST complete',
        (r) => r.post(`/me/documents/${UNKNOWN_ID}/complete`).send({}),
      ],
      [
        'GET signed-url',
        (r) => r.get(`/me/documents/${UNKNOWN_ID}/signed-url`),
      ],
    ];

    it.each(meRoutes)(
      '%s: 401 without a token, 403 unverified, 404 without an instructor row',
      async (_name, call) => {
        await call(http()).expect(401);
        await call(http()).set('Authorization', UNVERIFIED_AUTH).expect(403);
        const noProfile = await call(http())
          .set('Authorization', admin)
          .expect(404);
        expect((noProfile.body as { message: string }).message).toBe(
          'Instructor profile not found',
        );
      },
    );

    it('admin signed-url: 401 without a token, 403 for a non-admin', async () => {
      const url = `/admin/documents/assignments/${UNKNOWN_ID}/signed-url`;
      await http().get(url).expect(401);
      await http().get(url).set('Authorization', INSTRUCTOR_AUTH).expect(403);
      await http().get(url).set('Authorization', admin).expect(404);
    });

    it('rejects non-uuid ids', async () => {
      await http()
        .get('/me/documents/nope')
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(400);
      await http()
        .get('/admin/documents/assignments/nope/signed-url')
        .set('Authorization', admin)
        .expect(400);
    });
  });

  describe('GET /me/documents/:assignmentId', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const open = (id: string) =>
      http().get(`/me/documents/${id}`).set('Authorization', INSTRUCTOR_AUTH);

    it('returns the template to render and marks the assignment viewed once', async () => {
      const res = await open(ctx.signAssignment.id).expect(200);
      const body = res.body as {
        assignment: {
          status: string;
          viewedAt: string;
          hasSignedCopy: boolean;
        };
        template: Record<string, unknown>;
        sourceUrl: string;
      };
      expect(body.assignment).toMatchObject({
        status: 'viewed',
        hasSignedCopy: false,
      });
      expect(body.template).toEqual({
        id: ctx.signTemplate.id,
        kind: 'sign',
        titleEn: 'Instructor agreement',
        titleZh: '教练协议',
        descriptionEn: null,
        descriptionZh: null,
        pageCount: 2,
        pages: ctx.source.pages,
        fields: expect.arrayContaining([
          {
            id: 'when',
            type: 'date',
            page: 1,
            x: 340,
            y: 200,
            w: 100,
            h: 20,
            required: true,
            labelEn: 'when',
            labelZh: null,
            prefill: 'date_signed',
          },
        ]) as unknown,
      });
      expect(body.sourceUrl).toBe('memory://GET/templates/t/source.pdf');
      expect(res.body).toHaveProperty('consentText', {
        en: SIGNING_CONSENT.en,
        zh: SIGNING_CONSENT.zh,
      });
      expect(body.assignment).not.toHaveProperty('signerIp');
      const viewedAt = body.assignment.viewedAt;
      const again = await open(ctx.signAssignment.id).expect(200);
      expect(
        (again.body as { assignment: { viewedAt: string } }).assignment
          .viewedAt,
      ).toBe(viewedAt);
    });

    it('404s for another instructor, an archived assignment, an unknown id or a missing template', async () => {
      const other = ctx.subjects.seedInstructor();
      const theirs = ctx.assignments.seed({
        template_id: ctx.signTemplate.id,
        subject_id: other.id,
        season: '2025-26',
      });
      await open(theirs.id).expect(404);
      const archived = ctx.assignments.seed({
        template_id: ctx.signTemplate.id,
        subject_id: ctx.instructor.id,
        season: '2024-25',
        status: 'archived',
      });
      await open(archived.id).expect(404);
      await open(UNKNOWN_ID).expect(404);
      const orphan = ctx.assignments.seed({
        template_id: UNKNOWN_ID,
        subject_id: ctx.instructor.id,
      });
      await open(orphan.id).expect(404);
    });

    it('does not reset a completed assignment and returns a null source URL without a source', async () => {
      const t = ctx.templates.seed({ kind: 'read' });
      const done = ctx.assignments.seed({
        template_id: t.id,
        subject_id: ctx.instructor.id,
        status: 'completed',
      });
      const res = await open(done.id).expect(200);
      expect(res.body).toMatchObject({
        assignment: { status: 'completed', viewedAt: null },
        sourceUrl: null,
      });
    });
  });

  describe('POST /me/documents/:assignmentId/complete (read)', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('requires the acknowledgement, records evidence, then 409s', async () => {
      await complete(ctx.readAssignment.id, {}).expect(400);
      await complete(ctx.readAssignment.id, { acknowledged: false }).expect(
        400,
      );
      const res = await complete(ctx.readAssignment.id, { acknowledged: true })
        .set('Fly-Client-IP', '198.51.100.4')
        .set('User-Agent', 'Reader/1.0')
        .expect(200);
      expect(res.body).toEqual({
        assignment: expect.objectContaining({
          status: 'completed',
          signerName: 'Alice Wang',
          signerEmail: 'alice@example.com',
          templateSha256: ctx.source.sha256,
          hasSignedCopy: false,
        }) as unknown,
      });
      const row = ctx.assignments.rows.get(ctx.readAssignment.id)!;
      expect(row).toMatchObject({
        signer_ip: '198.51.100.4',
        signer_user_agent: 'Reader/1.0',
        signed_key: null,
      });
      expect(row.consent_at).toBe(row.completed_at);
      expect(row.viewed_at).toBe(row.completed_at);
      expect(ctx.completed.calls).toHaveLength(0);
      await complete(ctx.readAssignment.id, { acknowledged: true }).expect(409);
    });

    it('rejects unknown body keys', async () => {
      await complete(ctx.readAssignment.id, {
        acknowledged: true,
        extra: 1,
      }).expect(400);
    });
  });

  describe('POST /me/documents/:assignmentId/complete (sign)', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('stamps, stores and records the signed copy, hands it to the completed handler, then 409s', async () => {
      await http()
        .get(`/me/documents/${ctx.signAssignment.id}`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200);
      const res = await complete(ctx.signAssignment.id, validSign)
        .set('Fly-Client-IP', '203.0.113.7')
        .set('User-Agent', 'Signer/2.0')
        .expect(200);
      const key = storageKeys.instructorDocument(
        ctx.instructor.id,
        ctx.signAssignment.id,
      );
      const stored = ctx.storage.objects.get(key)!;
      expect(stored.contentType).toBe('application/pdf');
      const sha256 = sha256Hex(stored.body);
      expect(res.body).toEqual({
        assignment: expect.objectContaining({
          status: 'completed',
          signerName: '王小明 Alice Wang',
          signerEmail: 'alice@example.com',
          templateSha256: ctx.source.sha256,
          signedSha256: sha256,
          hasSignedCopy: true,
        }) as unknown,
        signedUrl: `memory://GET/${key}`,
      });
      expect(ctx.storage.presigned.at(-1)).toEqual({
        op: 'GET',
        key,
        input: { filename: 'Instructor agreement.pdf' },
      });
      const row = ctx.assignments.rows.get(ctx.signAssignment.id)!;
      expect(row).toMatchObject({
        signed_key: key,
        signed_sha256: sha256,
        template_sha256: ctx.source.sha256,
        signer_ip: '203.0.113.7',
        signer_user_agent: 'Signer/2.0',
        field_values: {
          agree: true,
          note: '已存档 on file',
          name: '王小明 Alice Wang',
          when: torontoDate(new Date(row.completed_at!)),
        },
      });
      expect(row.viewed_at).not.toBe(row.completed_at);

      expect(ctx.completed.calls).toHaveLength(1);
      const handed = ctx.completed.calls[0];
      expect(handed.sha256).toBe(sha256);
      expect(Buffer.compare(handed.pdf, stored.body)).toBe(0);
      expect(handed.assignment).toMatchObject({
        id: ctx.signAssignment.id,
        status: 'completed',
        signer_email: 'alice@example.com',
      });
      expect(handed.template.id).toBe(ctx.signTemplate.id);

      const doc = await PDFDocument.load(stored.body);
      expect(doc.getPageCount()).toBe(3);
      const page = await renderPage(stored.body, 1);
      for (const f of FIELDS.filter((f) => f.id !== 'note')) {
        expect({
          id: f.id,
          ink: inkIn(page, pixelRect(f, ctx.source.pages[0])) > 15,
        }).toEqual({ id: f.id, ink: true });
      }
      expect((await pdffonts(stored.body)).stderr).toBe('');
      const text = await pdftotext(stored.body);
      expect(text).toContain(ctx.source.sha256);
      expect(text).toContain(ctx.signAssignment.id);
      expect(text).toContain('203.0.113.7');
      expect(text).toContain(SIGNING_CONSENT.zh);

      await complete(ctx.signAssignment.id, validSign).expect(409);
      expect(ctx.completed.calls).toHaveLength(1);
    });

    it('lets one of two interleaved service calls win without re-stamping', async () => {
      const service = ctx.app.get(DocumentSigningService);
      const put = jest.spyOn(ctx.storage, 'put');
      const evidence = { ip: null, userAgent: null };
      const results = await Promise.allSettled([
        service.complete(
          INSTRUCTOR_USER_ID,
          ctx.signAssignment.id,
          validSign,
          evidence,
        ),
        service.complete(
          INSTRUCTOR_USER_ID,
          ctx.signAssignment.id,
          validSign,
          evidence,
        ),
        service.complete(
          INSTRUCTOR_USER_ID,
          ctx.readAssignment.id,
          { acknowledged: true },
          evidence,
        ),
        service.complete(
          INSTRUCTOR_USER_ID,
          ctx.readAssignment.id,
          { acknowledged: true },
          evidence,
        ),
      ]);
      expect(results.map((r) => r.status)).toEqual([
        'fulfilled',
        'rejected',
        'fulfilled',
        'rejected',
      ]);
      expect(put).toHaveBeenCalledTimes(1);
      expect(ctx.completed.calls).toHaveLength(1);
    });

    it('surfaces storage failures as errors', async () => {
      jest
        .spyOn(ctx.storage, 'getBuffer')
        .mockRejectedValueOnce(new Error('R2 down'));
      await complete(ctx.signAssignment.id, validSign).expect(500);
      expect(ctx.assignments.rows.get(ctx.signAssignment.id)!.status).toBe(
        'assigned',
      );
    });

    it('lets exactly one of two concurrent completions win', async () => {
      const [a, b] = await Promise.all([
        complete(ctx.signAssignment.id, validSign),
        complete(ctx.signAssignment.id, validSign),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(ctx.completed.calls).toHaveLength(1);
    });

    it.each<[string, object, RegExp]>([
      ['no consent', { ...validSign, consent: false }, /Agree to sign/],
      ['no signer name', { ...validSign, signerName: ' ' }, /full legal name/],
      [
        'a missing required signature',
        { ...validSign, signatures: { ini: { mode: 'typed', text: 'AW' } } },
        /Signature sig \(sig\) is required/,
      ],
      [
        'an unticked required checkbox',
        { ...validSign, values: {} },
        /must be ticked/,
      ],
      [
        'a non-PNG signature',
        {
          ...validSign,
          signatures: {
            ...validSign.signatures,
            sig: {
              mode: 'drawn',
              png: Buffer.from('not a png').toString('base64'),
            },
          },
        },
        /not a PNG/,
      ],
    ])('400s on %s and stores nothing', async (_name, body, message) => {
      const res = await complete(ctx.signAssignment.id, body).expect(400);
      expect((res.body as { message: string }).message).toMatch(message);
      expect(
        ctx.storage.objects.has(
          storageKeys.instructorDocument(
            ctx.instructor.id,
            ctx.signAssignment.id,
          ),
        ),
      ).toBe(false);
      expect(ctx.assignments.rows.get(ctx.signAssignment.id)!.status).toBe(
        'assigned',
      );
    });

    it('accepts a signature PNG just under 200 KB and 400s just over it', async () => {
      const big = signaturePng(400, 160, { noise: true });
      expect(big.length).toBeGreaterThan(200 * 1024);
      const res = await complete(ctx.signAssignment.id, {
        ...validSign,
        signatures: {
          ...validSign.signatures,
          sig: { mode: 'drawn', png: big.toString('base64') },
        },
      }).expect(400);
      expect((res.body as { message: string }).message).toMatch(
        /larger than 200 KB/,
      );
      const underLimit = signaturePng(300, 170, { noise: true });
      expect(underLimit.length).toBeGreaterThan(150 * 1024);
      expect(underLimit.length).toBeLessThanOrEqual(200 * 1024);
      await complete(ctx.signAssignment.id, {
        ...validSign,
        signatures: {
          ...validSign.signatures,
          sig: { mode: 'drawn', png: underLimit.toString('base64') },
        },
      }).expect(200);
    });

    it('413s on bodies over the signing limit and 400s on malformed JSON', async () => {
      const res = await complete(ctx.signAssignment.id, {
        ...validSign,
        values: { ...validSign.values, note: 'x'.repeat(5 * 1024 * 1024) },
      }).expect(413);
      expect((res.body as { message: string }).message).toBe(
        SIGNING_BODY_TOO_LARGE,
      );
      await http()
        .post(`/me/documents/${ctx.signAssignment.id}/complete`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .set('Content-Type', 'application/json')
        .send('{"consent":')
        .expect(400);
    });

    it('leaves other routes on the default body limit', async () => {
      await http()
        .post(`/me/documents/${ctx.signAssignment.id}/other`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .send({ note: 'x'.repeat(200 * 1024) })
        .expect(413);
    });

    it('still completes when the completed handler fails', async () => {
      ctx.completed.fail = true;
      await complete(ctx.signAssignment.id, validSign).expect(200);
      expect(ctx.completed.calls).toHaveLength(1);
    });

    it('400s when the template PDF is missing from storage or the template has none', async () => {
      ctx.storage.objects.delete('templates/t/source.pdf');
      const res = await complete(ctx.signAssignment.id, validSign).expect(400);
      expect((res.body as { message: string }).message).toMatch(
        /not available/,
      );
      ctx.templates.rows.set(ctx.signTemplate.id, {
        ...ctx.signTemplate,
        source_key: null,
      });
      await complete(ctx.signAssignment.id, validSign).expect(400);
    });

    it('400s when the template PDF is over the size cap', async () => {
      ctx.storage.seed(
        'templates/t/source.pdf',
        Buffer.alloc(21 * 1024 * 1024),
      );
      await complete(ctx.signAssignment.id, validSign).expect(400);
    });

    it('records the hash of the bytes actually signed when the stored source changed', async () => {
      const other = await normaliseTemplatePdf(await pdfFixture('normal'));
      const doc = await PDFDocument.load(other.bytes);
      doc.setTitle('changed');
      const changed = await doc.save();
      ctx.storage.seed('templates/t/source.pdf', changed);
      await complete(ctx.signAssignment.id, validSign).expect(200);
      expect(
        ctx.assignments.rows.get(ctx.signAssignment.id)!.template_sha256,
      ).toBe(sha256Hex(changed));
    });
  });

  describe('without a completed handler', () => {
    beforeEach(async () => {
      ctx = await build({ handler: false });
    });

    it('completes a sign document', async () => {
      await complete(ctx.signAssignment.id, validSign).expect(200);
    });
  });

  describe('signed-url', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('serves the signed copy to its instructor and to admins, with its SHA-256', async () => {
      const mine = `/me/documents/${ctx.signAssignment.id}/signed-url`;
      const adminUrl = `/admin/documents/assignments/${ctx.signAssignment.id}/signed-url`;
      await http().get(mine).set('Authorization', INSTRUCTOR_AUTH).expect(404);
      await http().get(adminUrl).set('Authorization', admin).expect(404);
      await complete(ctx.signAssignment.id, validSign).expect(200);
      const row = ctx.assignments.rows.get(ctx.signAssignment.id)!;
      const expected = {
        url: `memory://GET/${row.signed_key}`,
        expiresAt: '2026-10-13T00:05:00.000Z',
        sha256: row.signed_sha256,
      };
      await http()
        .get(mine)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200, expected);
      await http()
        .get(adminUrl)
        .set('Authorization', admin)
        .expect(200, expected);
      ctx.assignments.rows.set(row.id, { ...row, status: 'archived' });
      await http()
        .get(mine)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200, expected);
    });

    it("404s for another instructor's copy", async () => {
      const other = ctx.subjects.seedInstructor();
      const theirs = ctx.assignments.seed({
        template_id: ctx.signTemplate.id,
        subject_id: other.id,
        status: 'completed',
        signed_key: 'subjects/instructor/x/documents/y.pdf',
        signed_sha256: 'c'.repeat(64),
      });
      await http()
        .get(`/me/documents/${theirs.id}/signed-url`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(404);
      await http()
        .get(`/admin/documents/assignments/${theirs.id}/signed-url`)
        .set('Authorization', admin)
        .expect(200);
    });

    it('names the download safely when the title has unsafe characters', async () => {
      const t = ctx.templates.seed({ title_en: 'a/b:c' });
      const a = ctx.assignments.seed({
        template_id: t.id,
        subject_id: ctx.instructor.id,
        signed_key: 'k.pdf',
      });
      await http()
        .get(`/admin/documents/assignments/${a.id}/signed-url`)
        .set('Authorization', admin)
        .expect(200);
      expect(ctx.storage.presigned.at(-1)?.input).toEqual({
        filename: 'a b c.pdf',
      });
      const untitled = ctx.templates.seed({ title_en: '///' });
      const b = ctx.assignments.seed({
        template_id: untitled.id,
        subject_id: ctx.instructor.id,
        signed_key: 'k2.pdf',
      });
      await http()
        .get(`/admin/documents/assignments/${b.id}/signed-url`)
        .set('Authorization', admin)
        .expect(200);
      expect(ctx.storage.presigned.at(-1)?.input).toEqual({
        filename: 'document.pdf',
      });
    });
  });
});
