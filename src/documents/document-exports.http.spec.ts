import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { InMemoryDocumentExportsRepository } from '../../test/helpers/document-exports-fakes';
import {
  ADMIN_AUTH as admin,
  ADMIN_USER_ID,
  INSTRUCTOR_AUTH,
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
  InMemoryDocumentTemplatesRepository,
  InMemoryPrivateStorage,
  startDocumentsApp,
} from '../../test/helpers/documents-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { AdminDocumentExportsController } from './admin-document-exports.controller';
import { DocumentExportOwner } from './document-export-owner';
import { DocumentExportQueue } from './document-export-queue';
import { MAX_EXPORT_FILE_BYTES } from './document-export-zip';
import { DocumentExportsRepository } from './document-exports.repository';
import type {
  DocumentExport,
  TemplateAssignmentRow,
} from './document-exports.types';
import {
  DocumentExportsService,
  EXPORT_EXPIRED,
  EXPORT_FAILED,
  EXPORT_INTERRUPTED,
  EXPORT_INVALID_ASSIGNMENTS,
  EXPORT_NOT_READY,
  EXPORT_NOT_SIGN_TEMPLATE,
  EXPORT_NOTHING_COMPLETED,
  EXPORT_TOO_MANY,
} from './document-exports.service';
import { DocumentTemplatesRepository } from './document-templates.repository';
import type { DocumentAssignmentRow } from './documents.types';
import { PrivateStorageClient } from './private-storage.client';
import { storageKeys } from './storage-keys';

type Response = request.Response;
const rows = (res: Response) => res.body as TemplateAssignmentRow[];
const ids = (res: Response) => rows(res).map((r) => r.id);
const exportOf = (res: Response) => res.body as DocumentExport;
const message = (res: Response) => (res.body as { message: string }).message;

const OWNER_A = 'machine-a-1111aaaa';
const OWNER_B = 'machine-b-2222bbbb';
const MINUTE = 60 * 1000;
const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const SHA = 'ab'.repeat(32);

async function build(
  seed?: (exports: InMemoryDocumentExportsRepository) => void,
) {
  const storage = new InMemoryPrivateStorage();
  const templates = new InMemoryDocumentTemplatesRepository();
  const subjects = new InMemoryDocumentSubjectsRepository();
  const assignments = new InMemoryDocumentAssignmentsRepository(
    templates,
    subjects,
  );
  const exportsRepo = new InMemoryDocumentExportsRepository(
    assignments,
    subjects,
  );
  const audit = recordingAudit();
  const template = templates.seed({ title_en: 'Instructor agreement' });
  seed?.(exportsRepo);
  const app = await startDocumentsApp(
    Test.createTestingModule({
      controllers: [AdminDocumentExportsController],
      providers: [
        DocumentExportsService,
        DocumentExportQueue,
        { provide: DocumentExportsRepository, useValue: exportsRepo },
        { provide: DocumentTemplatesRepository, useValue: templates },
        { provide: PrivateStorageClient, useValue: storage },
        { provide: AuditService, useValue: audit },
        { provide: DocumentExportOwner, useValue: { id: OWNER_A } },
      ],
    }),
  );
  const queue = app.get(DocumentExportQueue);
  return {
    app,
    storage,
    templates,
    subjects,
    assignments,
    exportsRepo,
    audit,
    template,
    queue,
  };
}

describe('document exports HTTP', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(async () => {
    await ctx.queue.idle();
    await ctx.app.close();
    jest.restoreAllMocks();
  });

  function instructor(
    first: string | null,
    last: string | null,
    email: string,
  ) {
    return ctx.subjects.seedInstructor({
      first_name: first,
      last_name: last,
      email,
    });
  }

  function completed(
    first: string | null,
    last: string | null,
    completedAt: string,
    overrides: Partial<DocumentAssignmentRow> = {},
    body: Buffer | null = Buffer.from(`%PDF-${last ?? first}-${completedAt}`),
  ): DocumentAssignmentRow {
    const who = instructor(
      first,
      last,
      `${(first ?? last ?? 'x').toLowerCase()}@example.com`,
    );
    const row = ctx.assignments.seed({
      template_id: ctx.template.id,
      subject_id: who.id,
      status: 'completed',
      completed_at: completedAt,
      signer_name: [first, last].filter(Boolean).join(' '),
      signer_email: who.email,
      signed_sha256: SHA,
      ...overrides,
    });
    const key =
      overrides.signed_key === undefined
        ? storageKeys.instructorDocument(who.id, row.id)
        : overrides.signed_key;
    ctx.assignments.rows.set(row.id, {
      ...ctx.assignments.rows.get(row.id)!,
      signed_key: key,
    });
    if (key && body) {
      ctx.storage.seed(key, body);
    }
    return { ...row, signed_key: key };
  }

  function open(
    first: string,
    last: string,
    status: 'assigned' | 'viewed' = 'assigned',
  ): DocumentAssignmentRow {
    const who = instructor(first, last, `${first.toLowerCase()}@example.com`);
    return ctx.assignments.seed({
      template_id: ctx.template.id,
      subject_id: who.id,
      status,
    });
  }

  async function runExport(body: object = {}) {
    const res = await http()
      .post(`/admin/documents/templates/${ctx.template.id}/exports`)
      .set('Authorization', admin)
      .send(body)
      .expect(202);
    await ctx.queue.idle();
    return exportOf(res);
  }

  function unzip(id: string) {
    const object = ctx.storage.objects.get(storageKeys.documentExport(id));
    expect(object?.contentType).toBe('application/zip');
    const dir = mkdtempSync(join(tmpdir(), 'export-'));
    const file = join(dir, 'export.zip');
    writeFileSync(file, object!.body);
    try {
      return {
        test: execFileSync('unzip', ['-t', file], { encoding: 'utf8' }),
        names: execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' })
          .trim()
          .split('\n'),
        verbose: execFileSync('unzip', ['-Zv', file], { encoding: 'utf8' }),
        read: (name: string) =>
          execFileSync('unzip', ['-p', file, name], { encoding: 'utf8' }),
      };
    } finally {
      setImmediate(() => rmSync(dir, { recursive: true, force: true }));
    }
  }

  describe('auth', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const routes: [string, (r: ReturnType<typeof http>) => request.Test][] = [
      [
        'GET template assignments',
        (r) => r.get(`/admin/documents/templates/${UNKNOWN_ID}/assignments`),
      ],
      [
        'POST template export',
        (r) =>
          r.post(`/admin/documents/templates/${UNKNOWN_ID}/exports`).send({}),
      ],
      [
        'GET template exports',
        (r) => r.get(`/admin/documents/templates/${UNKNOWN_ID}/exports`),
      ],
      ['GET export', (r) => r.get(`/admin/documents/exports/${UNKNOWN_ID}`)],
      [
        'GET export url',
        (r) => r.get(`/admin/documents/exports/${UNKNOWN_ID}/url`),
      ],
    ];

    it.each(routes)('%s → 401 without a token', async (_name, send) => {
      await send(http()).expect(401);
    });

    it.each(routes)('%s → 403 for a non-admin', async (_name, send) => {
      await send(http()).set('Authorization', INSTRUCTOR_AUTH).expect(403);
    });

    it.each(routes)(
      '%s → 404 for an admin and an unknown id',
      async (_name, send) => {
        await send(http()).set('Authorization', admin).expect(404);
      },
    );
  });

  describe('GET /admin/documents/templates/:id/assignments', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const list = (query: Record<string, string | number> = {}) =>
      http()
        .get(`/admin/documents/templates/${ctx.template.id}/assignments`)
        .query(query)
        .set('Authorization', admin);

    it('lists completed (newest first) then open by last name, excluding archived', async () => {
      const zed = open('Ann', 'Zed', 'viewed');
      const alpha = open('Bob', 'Alpha');
      const early = completed('Cy', 'Early', '2026-10-02T15:00:00Z');
      const late = completed('Di', 'Late', '2026-10-05T15:00:00Z');
      const archived = open('Ed', 'Gone');
      ctx.assignments.rows.set(archived.id, {
        ...ctx.assignments.rows.get(archived.id)!,
        status: 'archived',
      });
      const other = ctx.templates.seed();
      ctx.assignments.seed({
        template_id: other.id,
        subject_id: instructor('Fay', 'Other', 'fay@example.com').id,
      });

      const res = await list().expect(200);

      expect(res.headers['x-total-count']).toBe('4');
      expect(ids(res)).toEqual([late.id, early.id, alpha.id, zed.id]);
      expect(rows(res)[0]).toEqual({
        id: late.id,
        status: 'completed',
        season: '2026-27',
        instructor: {
          id: late.subject_id,
          firstName: 'Di',
          lastName: 'Late',
          email: 'di@example.com',
        },
        signerName: 'Di Late',
        signerEmail: 'di@example.com',
        assignedAt: late.assigned_at,
        viewedAt: null,
        completedAt: '2026-10-05T15:00:00Z',
        signedSha256: SHA,
        hasSignedCopy: true,
      });
      expect(rows(res)[2]).toMatchObject({
        status: 'assigned',
        signedSha256: null,
        hasSignedCopy: false,
        completedAt: null,
      });
    });

    it('filters by season, status and a name or email search', async () => {
      const ann = completed('Ann', 'Wong', '2026-10-02T15:00:00Z');
      completed('Bea', 'Lee', '2026-10-03T15:00:00Z', { season: '2025-26' });
      const cy = open('Cy', 'Wong');

      const season = await list({ season: '2026-27' }).expect(200);
      expect(season.headers['x-total-count']).toBe('2');

      const done = await list({ status: 'completed', season: '2026-27' });
      expect(ids(done)).toEqual([ann.id]);

      const pending = await list({ status: 'open' });
      expect(ids(pending)).toEqual([cy.id]);

      const wong = await list({ q: 'wong' });
      expect(wong.headers['x-total-count']).toBe('2');
      const email = await list({ q: 'ann@example' });
      expect(ids(email)).toEqual([ann.id]);
      const both = await list({ q: 'cy wong' });
      expect(ids(both)).toEqual([cy.id]);
      const wildcard = await list({ q: '%' });
      expect(wildcard.headers['x-total-count']).toBe('0');
    });

    it('pages with page and limit, defaulting to 50, and reports the total past the end', async () => {
      for (let i = 0; i < 55; i += 1) {
        open(`P${i}`, `L${String(i).padStart(2, '0')}`);
      }

      const first = await list().expect(200);
      expect(first.body).toHaveLength(50);
      expect(first.headers['x-total-count']).toBe('55');

      const second = await list({ page: 2, limit: 20 }).expect(200);
      expect(second.body).toHaveLength(20);
      expect(rows(second)[0].instructor.lastName).toBe('L20');

      const past = await list({ page: 9, limit: 20 }).expect(200);
      expect(past.body).toEqual([]);
      expect(past.headers['x-total-count']).toBe('55');
    });

    it('with hasSignedCopy=true lists and counts only rows with a signed copy', async () => {
      const signed = completed('Ann', 'Wong', '2026-10-02T15:00:00Z');
      completed('No', 'Copy', '2026-10-03T15:00:00Z', { signed_key: null });
      open('Cy', 'Open');

      const res = await list({
        status: 'completed',
        hasSignedCopy: 'true',
        limit: 1,
      }).expect(200);
      expect(res.headers['x-total-count']).toBe('1');
      expect(ids(res)).toEqual([signed.id]);

      const all = await list({ status: 'completed', hasSignedCopy: 'false' });
      expect(all.headers['x-total-count']).toBe('2');
    });

    it('reports a zero total for a template with no assignments', async () => {
      const res = await list({ page: 1 }).expect(200);
      expect(res.body).toEqual([]);
      expect(res.headers['x-total-count']).toBe('0');
    });

    it.each([
      [{ limit: 101 }],
      [{ limit: 0 }],
      [{ page: 0 }],
      [{ status: 'archived' }],
      [{ season: '' }],
      [{ hasSignedCopy: 'yes' }],
    ])('rejects %j with 400', async (query) => {
      await list(query).expect(400);
    });

    it('400s a non-uuid template id', async () => {
      await http()
        .get('/admin/documents/templates/not-a-uuid/assignments')
        .set('Authorization', admin)
        .expect(400);
    });
  });

  describe('POST /admin/documents/templates/:id/exports', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const create = (body: object, templateId = ctx.template.id) =>
      http()
        .post(`/admin/documents/templates/${templateId}/exports`)
        .set('Authorization', admin)
        .set('User-Agent', 'jest')
        .send(body);

    it('accepts an export of all completed copies for a season, audits it and builds it in the background', async () => {
      completed('Ann', 'Wong', '2026-10-02T15:00:00Z');
      completed('Bea', 'Lee', '2026-10-03T15:00:00Z');
      completed('Old', 'Season', '2025-10-03T15:00:00Z', { season: '2025-26' });
      open('Cy', 'Open');

      const res = await create({ season: '2026-27' }).expect(202);

      expect(res.body).toEqual({
        id: expect.any(String) as unknown,
        templateId: ctx.template.id,
        season: '2026-27',
        selectedCount: null,
        status: 'queued',
        fileCount: null,
        skippedCount: null,
        sizeBytes: null,
        error: null,
        requestedAt: expect.any(String) as unknown,
        finishedAt: null,
        expiresAt: null,
      });
      expect(ctx.exportsRepo.rows.get(exportOf(res).id)?.requested_by).toBe(
        ADMIN_USER_ID,
      );
      expect(ctx.audit.entries).toEqual([
        {
          action: 'document_export.create',
          actor: { userId: ADMIN_USER_ID, role: 'admin', userAgent: 'jest' },
          targetType: 'document_export',
          targetId: exportOf(res).id,
          metadata: {
            templateId: ctx.template.id,
            season: '2026-27',
            selectedCount: null,
            matchedCount: 2,
          },
        },
      ]);

      await ctx.queue.idle();
      const done = await http()
        .get(`/admin/documents/exports/${exportOf(res).id}`)
        .set('Authorization', admin)
        .expect(200);
      expect(done.body).toMatchObject({
        status: 'ready',
        fileCount: 2,
        skippedCount: 0,
        sizeBytes: ctx.storage.objects.get(
          storageKeys.documentExport(exportOf(res).id),
        )?.body.length,
        error: null,
      });
      expect(
        Date.parse(exportOf(done).expiresAt ?? '') -
          Date.parse(exportOf(done).finishedAt ?? ''),
      ).toBe(24 * 60 * 60 * 1000);
    });

    it('exports a selection of completed copies', async () => {
      const ann = completed('Ann', 'Wong', '2026-10-02T15:00:00Z');
      completed('Bea', 'Lee', '2026-10-03T15:00:00Z');

      const res = await create({ assignmentIds: [ann.id, ann.id] }).expect(202);
      expect(exportOf(res).selectedCount).toBe(1);
      await ctx.queue.idle();

      const zip = unzip(exportOf(res).id);
      expect(zip.names).toEqual([
        'Instructor agreement/Wong, Ann - 2026-10-02.pdf',
        'manifest.csv',
      ]);
    });

    it('400s a read template', async () => {
      const read = ctx.templates.seed({ kind: 'read' });
      const res = await create({}, read.id).expect(400);
      expect(message(res)).toBe(EXPORT_NOT_SIGN_TEMPLATE);
    });

    it('400s when nothing completed with a signed copy matches', async () => {
      open('Cy', 'Open');
      completed('Old', 'Season', '2025-10-03T15:00:00Z', { season: '2025-26' });
      const noCopy = completed('No', 'Copy', '2026-10-03T15:00:00Z', {
        signed_key: null,
      });
      const listed = await http()
        .get(`/admin/documents/templates/${ctx.template.id}/assignments`)
        .query({ season: '2026-27', status: 'completed' })
        .set('Authorization', admin)
        .expect(200);
      expect(rows(listed)).toEqual([
        expect.objectContaining({ id: noCopy.id, hasSignedCopy: false }),
      ]);
      const res = await create({ season: '2026-27' }).expect(400);
      expect(message(res)).toBe(EXPORT_NOTHING_COMPLETED);
      expect(ctx.exportsRepo.rows.size).toBe(0);
      expect(ctx.audit.entries).toEqual([]);
    });

    it('400s more than 1,000 completed matches', async () => {
      for (let i = 0; i < 1001; i += 1) {
        completed(`F${i}`, `L${i}`, '2026-10-02T15:00:00Z', {}, null);
      }
      const res = await create({}).expect(400);
      expect(message(res)).toBe(EXPORT_TOO_MANY);
    });

    it('does not count completed rows without a signed copy towards the 1,000 cap', async () => {
      for (let i = 0; i < 1000; i += 1) {
        completed(`F${i}`, `L${i}`, '2026-10-02T15:00:00Z', {}, null);
      }
      completed('No', 'Copy', '2026-10-02T15:00:00Z', { signed_key: null });
      await create({}).expect(202);
      expect(ctx.audit.entries[0].metadata).toMatchObject({
        matchedCount: 1000,
      });
    });

    it('400s ids that are not completed copies of this template', async () => {
      const ann = completed('Ann', 'Wong', '2026-10-02T15:00:00Z');
      const pending = open('Cy', 'Open');
      const other = ctx.templates.seed();
      const foreign = ctx.assignments.seed({
        template_id: other.id,
        subject_id: instructor('Fay', 'Other', 'f@example.com').id,
        status: 'completed',
      });
      const noCopy = completed('No', 'Copy', '2026-10-01T15:00:00Z', {
        signed_key: null,
      });
      for (const ids of [
        [ann.id, pending.id],
        [foreign.id],
        [UNKNOWN_ID],
        [noCopy.id],
      ]) {
        const res = await create({ assignmentIds: ids }).expect(400);
        expect(message(res)).toBe(EXPORT_INVALID_ASSIGNMENTS);
      }
    });

    it('intersects selected ids with the season when one is given', async () => {
      const ann = completed('Ann', 'Wong', '2026-10-02T15:00:00Z');
      const old = completed('Old', 'Season', '2025-10-03T15:00:00Z', {
        season: '2025-26',
      });

      const res = await create({
        season: '2025-26',
        assignmentIds: [ann.id, old.id],
      }).expect(400);
      expect(message(res)).toBe(EXPORT_INVALID_ASSIGNMENTS);

      const ok = await create({
        season: '2025-26',
        assignmentIds: [old.id],
      }).expect(202);
      await ctx.queue.idle();
      expect(unzip(exportOf(ok).id).names).toEqual([
        'Instructor agreement (2025-26)/Season, Old - 2025-10-03.pdf',
        'manifest.csv',
      ]);
    });

    it.each([
      [{ assignmentIds: [] }],
      [{ assignmentIds: ['nope'] }],
      [{ assignmentIds: 'x' }],
      [{ season: '' }],
      [{ extra: true }],
    ])('rejects %j with 400', async (body) => {
      await create(body).expect(400);
    });

    it('rejects more than 1,000 ids with 400', async () => {
      const ids = Array.from(
        { length: 1001 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
      await create({ assignmentIds: ids }).expect(400);
    });
  });

  describe('the ZIP', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('stores one folder of named PDFs plus a manifest, uncompressed, and passes unzip -t', async () => {
      const ann = completed('Ann', 'Wong', '2026-10-02T03:30:00Z');
      const twin = completed('Ann', 'Wong', '2026-10-01T23:30:00Z', {
        signer_name: '=HYPERLINK("x")',
      });
      const odd = completed('A/B', 'C:D*', '2026-09-30T15:00:00Z');
      const missing = completed(
        'Mia',
        'Missing',
        '2026-09-29T15:00:00Z',
        {},
        null,
      );
      const noKey = completed('Nok', 'Nokey', '2026-09-28T15:00:00Z', {
        signed_key: null,
      });
      const huge = completed(
        'Hugh',
        'Huge',
        '2026-09-27T15:00:00Z',
        {},
        Buffer.alloc(MAX_EXPORT_FILE_BYTES + 1),
      );

      const { id } = await runExport({ season: '2026-27' });
      const zip = unzip(id);

      expect(zip.test).toContain('No errors detected');
      const folder = 'Instructor agreement (2026-27)';
      expect(zip.names).toEqual([
        `${folder}/Wong, Ann - 2026-10-01.pdf`,
        `${folder}/Wong, Ann - 2026-10-01 (2).pdf`,
        `${folder}/C D, A B - 2026-09-30.pdf`,
        'manifest.csv',
      ]);
      expect(zip.verbose).not.toMatch(/compression method:\s+deflated/);
      expect(zip.verbose).toMatch(/compression method:\s+none \(stored\)/);
      expect(zip.read(`${folder}/Wong, Ann - 2026-10-01.pdf`)).toBe(
        `%PDF-Wong-${ann.completed_at}`,
      );
      expect(zip.read(`${folder}/Wong, Ann - 2026-10-01 (2).pdf`)).toBe(
        `%PDF-Wong-${twin.completed_at}`,
      );

      const manifest = zip.read('manifest.csv').split('\r\n');
      expect(manifest[0]).toBe(
        'instructor name,email,signer name,signed at,season,assignment id,sha256,file name,note',
      );
      expect(manifest[1]).toBe(
        `Ann Wong,ann@example.com,Ann Wong,2026-10-02T03:30:00.000Z,2026-27,${ann.id},${SHA},"${folder}/Wong, Ann - 2026-10-01.pdf",`,
      );
      expect(manifest[2]).toContain(`"'=HYPERLINK(""x"")"`);
      expect(manifest[3]).toContain(odd.id);
      expect(manifest[4]).toBe(
        `Mia Missing,mia@example.com,Mia Missing,2026-09-29T15:00:00.000Z,2026-27,${missing.id},${SHA},,skipped: missing`,
      );
      expect(manifest[5]).toContain(`${huge.id},${SHA},,skipped: too large`);
      expect(manifest[6]).toBe('');
      expect(manifest.join('\n')).not.toContain(noKey.id);

      expect(ctx.exportsRepo.rows.get(id)).toMatchObject({
        status: 'ready',
        file_count: 3,
        skipped_count: 2,
        zip_key: storageKeys.documentExport(id),
      });
    });

    it('marks the export failed when reading a copy fails', async () => {
      completed('Ann', 'Wong', '2026-10-02T15:00:00Z');
      jest
        .spyOn(ctx.storage, 'getStream')
        .mockRejectedValueOnce(new Error('R2 exploded'));

      const { id } = await runExport();

      expect(ctx.exportsRepo.rows.get(id)).toMatchObject({
        status: 'failed',
        error: EXPORT_FAILED,
        finished_at: expect.any(String) as unknown,
      });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('R2 exploded'),
      );
    });

    it('marks the export failed when a copy stream errors mid-way', async () => {
      completed('Ann', 'Wong', '2026-10-02T15:00:00Z');
      completed('Bea', 'Lee', '2026-10-01T15:00:00Z');
      jest.spyOn(ctx.storage, 'getStream').mockImplementationOnce(() =>
        Promise.resolve(
          new Readable({
            read() {
              this.destroy(new Error('socket reset'));
            },
          }),
        ),
      );

      const { id } = await runExport();

      expect(ctx.exportsRepo.rows.get(id)?.status).toBe('failed');
      expect(ctx.storage.objects.has(storageKeys.documentExport(id))).toBe(
        false,
      );
    });

    it('marks the export failed when the upload fails', async () => {
      completed('Ann', 'Wong', '2026-10-02T15:00:00Z');
      jest
        .spyOn(ctx.storage, 'uploadStream')
        .mockImplementationOnce(async (_key, body) => {
          body.resume();
          await new Promise((r) => setImmediate(r));
          throw new Error('multipart refused');
        });

      const { id } = await runExport();

      expect(ctx.exportsRepo.rows.get(id)?.status).toBe('failed');
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('multipart refused'),
      );
    });

    it('fails the export when its template was deleted before it ran', async () => {
      completed('Ann', 'Wong', '2026-10-02T15:00:00Z');
      const enqueue = jest
        .spyOn(ctx.queue, 'enqueue')
        .mockImplementation(() => undefined);
      const res = await http()
        .post(`/admin/documents/templates/${ctx.template.id}/exports`)
        .set('Authorization', admin)
        .send({})
        .expect(202);
      ctx.templates.rows.delete(ctx.template.id);
      enqueue.mockRestore();
      await ctx.app.get(DocumentExportsService).run(exportOf(res).id);
      expect(ctx.exportsRepo.rows.get(exportOf(res).id)?.status).toBe('failed');
    });

    it('deletes the ZIP when the export stopped running before it finished', async () => {
      completed('Ann', 'Wong', '2026-10-02T15:00:00Z');
      const enqueue = jest
        .spyOn(ctx.queue, 'enqueue')
        .mockImplementation(() => undefined);
      const res = await http()
        .post(`/admin/documents/templates/${ctx.template.id}/exports`)
        .set('Authorization', admin)
        .send({})
        .expect(202);
      enqueue.mockRestore();
      const upload = ctx.storage.uploadStream.bind(ctx.storage) as (
        key: string,
        body: Readable,
        type: string,
      ) => Promise<number>;
      jest
        .spyOn(ctx.storage, 'uploadStream')
        .mockImplementationOnce(async (key, body, type) => {
          const size = await upload(key, body, type);
          await ctx.exportsRepo.failStale(
            new Date(Date.now() + MINUTE).toISOString(),
            EXPORT_INTERRUPTED,
            new Date().toISOString(),
          );
          return size;
        });

      await ctx.app.get(DocumentExportsService).run(exportOf(res).id);

      expect(ctx.exportsRepo.rows.get(exportOf(res).id)?.status).toBe('failed');
      expect(ctx.storage.deleted).toEqual([
        storageKeys.documentExport(exportOf(res).id),
      ]);
    });

    it('runs one export at a time; the next waits as queued', async () => {
      completed('Ann', 'Wong', '2026-10-02T15:00:00Z');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const getStream = ctx.storage.getStream.bind(ctx.storage) as (
        key: string,
        max: number,
      ) => Promise<Readable | null>;
      jest
        .spyOn(ctx.storage, 'getStream')
        .mockImplementation(async (key, max) => {
          await gate;
          return getStream(key, max);
        });
      const create = () =>
        http()
          .post(`/admin/documents/templates/${ctx.template.id}/exports`)
          .set('Authorization', admin)
          .send({})
          .expect(202);

      const first = exportOf(await create()).id;
      const second = exportOf(await create()).id;
      await new Promise((r) => setImmediate(r));

      expect(ctx.exportsRepo.rows.get(first)?.status).toBe('running');
      expect(ctx.exportsRepo.rows.get(second)?.status).toBe('queued');
      expect(ctx.queue.size).toBe(2);
      release();
      await ctx.queue.idle();
      expect(ctx.exportsRepo.rows.get(first)?.status).toBe('ready');
      expect(ctx.exportsRepo.rows.get(second)?.status).toBe('ready');
      expect(ctx.queue.size).toBe(0);
    });

    it('does not run an export that is no longer queued', async () => {
      const row = ctx.exportsRepo.seed({
        template_id: ctx.template.id,
        status: 'failed',
      });
      await ctx.app.get(DocumentExportsService).run(row.id);
      expect(ctx.exportsRepo.rows.get(row.id)?.status).toBe('failed');
    });
  });

  describe('GET exports', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('lists a template’s latest 10 exports, newest first', async () => {
      const seeded = Array.from(
        { length: 12 },
        () =>
          ctx.exportsRepo.seed({
            template_id: ctx.template.id,
            status: 'failed',
          }).id,
      );
      ctx.exportsRepo.seed({ template_id: ctx.templates.seed().id });

      const res = await http()
        .get(`/admin/documents/templates/${ctx.template.id}/exports`)
        .set('Authorization', admin)
        .expect(200);

      expect(ids(res)).toEqual(seeded.reverse().slice(0, 10));
    });

    it('returns one export with its selected count', async () => {
      const row = ctx.exportsRepo.seed({
        template_id: ctx.template.id,
        season: '2026-27',
        assignment_ids: [UNKNOWN_ID, ADMIN_USER_ID],
        status: 'ready',
        file_count: 2,
        skipped_count: 0,
        size_bytes: '1234' as unknown as number,
        finished_at: '2026-10-10T00:00:00.000Z',
        expires_at: '2026-10-11T00:00:00.000Z',
      });

      const res = await http()
        .get(`/admin/documents/exports/${row.id}`)
        .set('Authorization', admin)
        .expect(200);

      expect(res.body).toEqual({
        id: row.id,
        templateId: ctx.template.id,
        season: '2026-27',
        selectedCount: 2,
        status: 'ready',
        fileCount: 2,
        skippedCount: 0,
        sizeBytes: 1234,
        error: null,
        requestedAt: row.inserted_at,
        finishedAt: '2026-10-10T00:00:00.000Z',
        expiresAt: '2026-10-11T00:00:00.000Z',
      });
    });
  });

  describe('GET /admin/documents/exports/:exportId/url', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const url = (id: string) =>
      http()
        .get(`/admin/documents/exports/${id}/url`)
        .set('Authorization', admin)
        .set('User-Agent', 'jest');

    it('presigns a 5-minute attachment download of a ready export and audits it', async () => {
      completed('Ann', 'Wong', '2026-10-02T15:00:00Z');
      const { id } = await runExport({ season: '2026-27' });
      ctx.audit.entries.length = 0;

      const res = await url(id).expect(200);

      const size = ctx.storage.objects.get(storageKeys.documentExport(id))?.body
        .length;
      expect(res.body).toEqual({
        url: `memory://GET/exports/${id}.zip`,
        expiresAt: expect.any(String) as unknown,
        sizeBytes: size,
      });
      expect(ctx.storage.presigned.at(-1)).toEqual({
        op: 'GET',
        key: `exports/${id}.zip`,
        input: {
          contentDisposition:
            'attachment; filename="instructor-agreement-2026-27-signed.zip"',
        },
      });
      expect(ctx.audit.entries).toEqual([
        {
          action: 'document_export.download',
          actor: { userId: ADMIN_USER_ID, role: 'admin', userAgent: 'jest' },
          targetType: 'document_export',
          targetId: id,
          metadata: {
            templateId: ctx.template.id,
            season: '2026-27',
            fileCount: 1,
            sizeBytes: size,
          },
        },
      ]);
    });

    it('names a download without a season by the template only', async () => {
      const row = ctx.exportsRepo.seed({
        template_id: ctx.template.id,
        status: 'ready',
        zip_key: 'exports/x.zip',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      await url(row.id).expect(200);
      expect(ctx.storage.presigned.at(-1)?.input).toEqual({
        contentDisposition:
          'attachment; filename="instructor-agreement-signed.zip"',
      });
    });

    it.each(['queued', 'running', 'failed'] as const)(
      '409s a %s export',
      async (status) => {
        const row = ctx.exportsRepo.seed({
          template_id: ctx.template.id,
          status,
        });
        const res = await url(row.id).expect(409);
        expect(message(res)).toBe(EXPORT_NOT_READY);
      },
    );

    it('410s an expired export, and a ready one past expires_at', async () => {
      const expired = ctx.exportsRepo.seed({
        template_id: ctx.template.id,
        status: 'expired',
        zip_key: 'exports/a.zip',
      });
      const stale = ctx.exportsRepo.seed({
        template_id: ctx.template.id,
        status: 'ready',
        zip_key: 'exports/b.zip',
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });
      for (const row of [expired, stale]) {
        const res = await url(row.id).expect(410);
        expect(message(res)).toBe(EXPORT_EXPIRED);
      }
      expect(ctx.audit.entries).toEqual([]);
    });
  });

  describe('recovery of abandoned exports', () => {
    const minutesAgo = (n: number) =>
      new Date(Date.now() - n * MINUTE).toISOString();

    function otherProcess(): DocumentExportsService {
      return new DocumentExportsService(
        ctx.exportsRepo,
        ctx.templates,
        ctx.storage,
        new DocumentExportQueue(),
        ctx.audit as unknown as AuditService,
        { id: OWNER_B },
      );
    }

    it('fails queued and running exports with a stale heartbeat on boot, and leaves fresh ones alone', async () => {
      const ids: Record<string, string> = {};
      ctx = await build((exportsRepo) => {
        const seed = (
          name: string,
          status: 'queued' | 'running' | 'ready',
          at: string,
        ) => {
          ids[name] = exportsRepo.seed({
            template_id: UNKNOWN_ID,
            owner_id: 'machine-dead-0000dead',
            status,
            heartbeat_at: at,
          }).id;
        };
        seed('staleQueued', 'queued', minutesAgo(3));
        seed('staleRunning', 'running', minutesAgo(2.5));
        seed('freshRunning', 'running', minutesAgo(1));
        seed('ready', 'ready', minutesAgo(60));
      });

      expect(ctx.exportsRepo.rows.get(ids.staleQueued)).toMatchObject({
        status: 'failed',
        error: EXPORT_INTERRUPTED,
        finished_at: expect.any(String) as unknown,
      });
      expect(ctx.exportsRepo.rows.get(ids.staleRunning)?.status).toBe('failed');
      expect(ctx.exportsRepo.rows.get(ids.freshRunning)?.status).toBe(
        'running',
      );
      expect(ctx.exportsRepo.rows.get(ids.ready)?.status).toBe('ready');
    });

    it('a second process booting does not fail the first one’s running and queued exports', async () => {
      ctx = await build();
      completed('Ann', 'Wong', '2026-10-02T15:00:00Z');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const getStream = ctx.storage.getStream.bind(ctx.storage) as (
        key: string,
        max: number,
      ) => Promise<Readable | null>;
      jest
        .spyOn(ctx.storage, 'getStream')
        .mockImplementation(async (key, max) => {
          await gate;
          return getStream(key, max);
        });
      const create = () =>
        http()
          .post(`/admin/documents/templates/${ctx.template.id}/exports`)
          .set('Authorization', admin)
          .send({})
          .expect(202);
      const running = exportOf(await create()).id;
      const queued = exportOf(await create()).id;
      await new Promise((r) => setImmediate(r));
      expect(ctx.exportsRepo.rows.get(running)).toMatchObject({
        status: 'running',
        owner_id: OWNER_A,
      });
      expect(ctx.exportsRepo.rows.get(queued)).toMatchObject({
        status: 'queued',
        owner_id: OWNER_A,
      });

      const b = otherProcess();
      await b.onApplicationBootstrap();
      b.onModuleDestroy();
      const a = ctx.app.get(DocumentExportsService);
      await a.heartbeat(new Date(Date.now() + 1.5 * MINUTE));
      await b.recoverStale(new Date(Date.now() + 3 * MINUTE));

      expect(ctx.exportsRepo.rows.get(running)?.status).toBe('running');
      expect(ctx.exportsRepo.rows.get(queued)?.status).toBe('queued');
      release();
      await ctx.queue.idle();
      expect(ctx.exportsRepo.rows.get(running)?.status).toBe('ready');
      expect(ctx.exportsRepo.rows.get(queued)?.status).toBe('ready');
      expect(ctx.storage.deleted).toEqual([]);
    });

    it('another process fails a dead owner’s exports once its heartbeat is over 2 minutes old', async () => {
      ctx = await build();
      const row = ctx.exportsRepo.seed({
        template_id: ctx.template.id,
        owner_id: OWNER_A,
        status: 'running',
        heartbeat_at: new Date().toISOString(),
      });
      const b = otherProcess();

      await b.recoverStale(new Date(Date.now() + 1.9 * MINUTE));
      expect(ctx.exportsRepo.rows.get(row.id)?.status).toBe('running');
      await b.recoverStale(new Date(Date.now() + 2.1 * MINUTE));
      expect(ctx.exportsRepo.rows.get(row.id)).toMatchObject({
        status: 'failed',
        error: EXPORT_INTERRUPTED,
      });
    });

    it('heartbeats only this process’s queued and running exports', async () => {
      ctx = await build();
      const old = minutesAgo(1);
      const seed = (owner: string, status: 'queued' | 'running' | 'ready') =>
        ctx.exportsRepo.seed({
          template_id: ctx.template.id,
          owner_id: owner,
          status,
          heartbeat_at: old,
        }).id;
      const mineQueued = seed(OWNER_A, 'queued');
      const mineRunning = seed(OWNER_A, 'running');
      const mineReady = seed(OWNER_A, 'ready');
      const theirs = seed(OWNER_B, 'running');
      const at = new Date();

      await ctx.app.get(DocumentExportsService).heartbeat(at);

      const beat = (id: string) => ctx.exportsRepo.rows.get(id)?.heartbeat_at;
      expect(beat(mineQueued)).toBe(at.toISOString());
      expect(beat(mineRunning)).toBe(at.toISOString());
      expect(beat(mineReady)).toBe(old);
      expect(beat(theirs)).toBe(old);
    });

    it('does not let another process finish or claim an export it does not own', async () => {
      ctx = await build();
      completed('Ann', 'Wong', '2026-10-02T15:00:00Z');
      const row = ctx.exportsRepo.seed({
        template_id: ctx.template.id,
        owner_id: OWNER_B,
        status: 'queued',
      });
      await ctx.app.get(DocumentExportsService).run(row.id);
      expect(ctx.exportsRepo.rows.get(row.id)?.status).toBe('queued');
    });

    it('logs and carries on when recovery or a heartbeat fails', async () => {
      ctx = await build((exportsRepo) => {
        jest
          .spyOn(exportsRepo, 'failStale')
          .mockRejectedValueOnce(new Error('db down'));
        jest
          .spyOn(exportsRepo, 'heartbeat')
          .mockRejectedValueOnce(new Error('heartbeat down'));
      });
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('db down'));
      await ctx.app.get(DocumentExportsService).heartbeat();
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('heartbeat down'),
      );
    });
  });
});
