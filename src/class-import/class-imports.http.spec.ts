import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH as admin,
  ADMIN_ID,
  INSTRUCTOR_AUTH,
  startAdminApp,
} from '../../test/helpers/admin-http';
import {
  ANNA_ID,
  BEN_ID,
  GROUP_2H_ID,
  importCsv,
  InMemoryClassImportsRepository,
  MEI_ID,
  PRIVATE_2H_ID,
} from '../../test/helpers/class-import-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { TOTAL_COUNT_HEADER } from '../config/cors';
import { DatabaseError } from '../database/db-result';
import type {
  ClassImportDetail,
  CommitResult,
  EventMapResult,
} from './class-import.types';
import { MAX_IMPORT_ROWS } from './class-import-csv';
import {
  ClassImportsController,
  MAX_IMPORT_FILE_BYTES,
} from './class-imports.controller';
import { ClassImportsRepository } from './class-imports.repository';
import {
  ClassImportsService,
  IMPORT_CUSTOMER_NOT_FOUND,
  IMPORT_DUPLICATE_EVENT_NAME,
  IMPORT_FILE_NOT_UTF8,
  IMPORT_FILE_REQUIRED,
  IMPORT_INSTRUCTOR_NOT_FOUND,
  IMPORT_LESSON_TYPE_NOT_FOUND,
  IMPORT_NOT_DRAFT,
  IMPORT_NOT_FOUND,
  IMPORT_NOTHING_TO_UPDATE,
  IMPORT_ROW_NOT_FOUND,
} from './class-imports.service';

const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';

const message = (res: request.Response) =>
  (res.body as { message: string }).message;

const SAMPLE = importCsv([
  { id: '9000001', email: 'mei.tester@example.com' },
  { id: '9000002', instructor: 'Nobody Known', event: 'Group Lesson 2h' },
  { id: '9000003', instructor: '安娜', email: 'stranger@example.com' },
  { id: '9000004', status: 'deleted', email: '' },
  {
    id: '9000005',
    start: '2099-01-10T10:00:00-05:00',
    end: '2099-01-10T12:00:00-05:00',
    email: '',
    phone: '647.555.0100',
  },
]);

async function build() {
  const repo = new InMemoryClassImportsRepository();
  const audit = recordingAudit();
  const app = await startAdminApp(
    Test.createTestingModule({
      controllers: [ClassImportsController],
      providers: [
        ClassImportsService,
        { provide: ClassImportsRepository, useValue: repo },
        { provide: AuditService, useValue: audit },
      ],
    }),
  );
  return { app, repo, audit };
}

describe('class imports admin HTTP', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());

  beforeEach(async () => {
    ctx = await build();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  const upload = (csv: string | Buffer = SAMPLE, name = 'bookings.csv') =>
    http()
      .post('/admin/class-imports')
      .set('Authorization', admin)
      .attach('file', Buffer.isBuffer(csv) ? csv : Buffer.from(csv), name);

  const uploaded = async (csv?: string) =>
    (await upload(csv).expect(201)).body as ClassImportDetail;

  const mapEvents = (
    mappings: { eventName: string; lessonTypeId: string | null }[],
  ) =>
    http()
      .put('/admin/class-imports/event-map')
      .set('Authorization', admin)
      .send({ mappings });

  describe('auth', () => {
    const routes: [string, (r: ReturnType<typeof http>) => request.Test][] = [
      ['GET imports', (r) => r.get('/admin/class-imports')],
      ['POST import', (r) => r.post('/admin/class-imports')],
      ['GET event map', (r) => r.get('/admin/class-imports/event-map')],
      [
        'PUT event map',
        (r) => r.put('/admin/class-imports/event-map').send({ mappings: [] }),
      ],
      ['GET import', (r) => r.get(`/admin/class-imports/${UNKNOWN_ID}`)],
      [
        'PATCH row',
        (r) => r.patch(`/admin/class-imports/${UNKNOWN_ID}/rows/1`).send({}),
      ],
      [
        'POST commit',
        (r) => r.post(`/admin/class-imports/${UNKNOWN_ID}/commit`),
      ],
      [
        'POST discard',
        (r) => r.post(`/admin/class-imports/${UNKNOWN_ID}/discard`),
      ],
    ];

    it.each(routes)('%s → 401 without a token', async (_name, send) => {
      await send(http()).expect(401);
    });

    it.each(routes)('%s → 403 for a non-admin', async (_name, send) => {
      await send(http()).set('Authorization', INSTRUCTOR_AUTH).expect(403);
    });
  });

  describe('upload', () => {
    it('creates a draft with dry-run matches and an audited summary', async () => {
      const body = await uploaded();

      expect(body.import).toMatchObject({
        filename: 'bookings.csv',
        status: 'draft',
        uploadedBy: ADMIN_ID,
      });
      expect(body.summary).toEqual({
        total: 5,
        matched: 0,
        willImport: 0,
        needsInstructor: 1,
        needsLessonType: 5,
        customerNotFound: 3,
        cancelled: 1,
        invalid: 0,
        duplicate: 0,
        alreadyImported: 0,
        imported: 0,
      });
      expect(body.eventNames).toEqual([
        { eventName: 'Group Lesson 2h', rows: 1, lessonTypeId: null },
        { eventName: 'Private Lesson 2h', rows: 4, lessonTypeId: null },
      ]);
      const [first, second, third, fourth, fifth] = body.rows;
      expect(first).toMatchObject({
        rowNo: 1,
        externalId: '9000001',
        instructorId: ANNA_ID,
        matchedInstructorName: 'Anna Example',
        customerId: MEI_ID,
        matchedCustomerName: 'Mei Tester',
        statusToSet: 'completed',
        startsAt: '2025-12-20T15:00:00.000Z',
        problems: ['lesson_type_unmapped'],
      });
      expect(second.problems).toEqual([
        'instructor_not_found',
        'lesson_type_unmapped',
        'customer_not_found',
      ]);
      expect(third).toMatchObject({ instructorId: ANNA_ID, customerId: null });
      expect(fourth.statusToSet).toBe('cancelled');
      expect(fifth).toMatchObject({
        statusToSet: 'scheduled',
        customerId: MEI_ID,
      });

      expect(ctx.audit.entries).toHaveLength(1);
      expect(ctx.audit.entries[0]).toMatchObject({
        action: 'class_import.create',
        targetType: 'class_import',
        targetId: body.import.id,
        metadata: { total: 5, cancelled: 1 },
      });
      expect(JSON.stringify(ctx.audit.entries)).not.toMatch(
        /example\.com|Tester/,
      );
    });

    it('applies the saved event map on upload', async () => {
      await mapEvents([
        { eventName: 'Private Lesson 2h', lessonTypeId: PRIVATE_2H_ID },
      ]).expect(200);

      const body = await uploaded();

      expect(body.rows[0]).toMatchObject({
        lessonTypeId: PRIVATE_2H_ID,
        problems: [],
      });
      expect(body.summary).toMatchObject({ matched: 4, willImport: 4 });
    });

    it('flags repeated CSV ids and rows with bad dates', async () => {
      const body = await uploaded(
        importCsv([
          { id: '9000001' },
          { id: '9000001' },
          { id: '9000002', start: 'soon' },
          { id: '9000003', end: '2025-12-20T09:00:00-05:00' },
          { id: '' },
        ]),
      );

      expect(
        body.rows.map((r) => r.problems.filter((p) => p.endsWith('_row'))),
      ).toEqual([
        [],
        ['duplicate_row'],
        ['invalid_row'],
        ['invalid_row'],
        ['invalid_row'],
      ]);
      expect(body.rows[4].externalId).toBe('row-5');
      expect(body.summary).toMatchObject({ invalid: 3, duplicate: 1 });
    });

    it('falls back to the instructor calendar summary', async () => {
      ctx.repo.calendarRefs = [{ instructorId: BEN_ID, summary: 'Coach B.' }];

      const body = await uploaded(importCsv([{ instructor: 'coach b' }]));

      expect(body.rows[0].instructorId).toBe(BEN_ID);
    });

    it('rejects a request without a file', async () => {
      const res = await http()
        .post('/admin/class-imports')
        .set('Authorization', admin)
        .expect(400);
      expect(message(res)).toBe(IMPORT_FILE_REQUIRED);
    });

    it('rejects a file that is not UTF-8', async () => {
      const res = await upload(Buffer.from([0xff, 0xfe, 0x00, 0x41])).expect(
        400,
      );
      expect(message(res)).toBe(IMPORT_FILE_NOT_UTF8);
    });

    it('rejects a CSV without the booking columns', async () => {
      const res = await upload('name,email\nx,y\n').expect(400);
      expect(message(res)).toMatch(/missing columns: id, event\.name/);
      expect(ctx.repo.imports).toHaveLength(0);
    });

    it('rejects a CSV with too many rows', async () => {
      const csv = importCsv(
        Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({
          id: String(i + 1),
        })),
      );
      await upload(csv).expect(400);
    });

    it('rejects files over 5 MB', async () => {
      await upload(Buffer.alloc(MAX_IMPORT_FILE_BYTES + 1, 'a')).expect(413);
      expect(ctx.repo.imports).toHaveLength(0);
    });

    it('removes the draft when its rows cannot be stored', async () => {
      ctx.repo.failSaveRows = true;

      await upload().expect(500);

      expect(ctx.repo.imports).toHaveLength(0);
      expect(ctx.audit.entries).toHaveLength(0);
    });
  });

  describe('review', () => {
    it('lists recent imports newest first', async () => {
      const a = await uploaded();
      const b = await uploaded();

      const res = await http()
        .get('/admin/class-imports')
        .set('Authorization', admin)
        .expect(200);

      expect((res.body as { id: string }[]).map((i) => i.id)).toEqual([
        b.import.id,
        a.import.id,
      ]);
    });

    it('filters rows by problem', async () => {
      const { import: draft } = await uploaded();
      const get = (problem?: string) =>
        http()
          .get(`/admin/class-imports/${draft.id}`)
          .query(problem ? { problem } : {})
          .set('Authorization', admin);

      const rowNos = async (problem: string) =>
        ((await get(problem).expect(200)).body as ClassImportDetail).rows.map(
          (r) => r.rowNo,
        );

      expect(await rowNos('instructor_not_found')).toEqual([2]);
      expect(await rowNos('customer_not_found')).toEqual([2, 3, 4]);
      expect(await rowNos('any')).toEqual([1, 2, 3, 4, 5]);
      expect(await rowNos('blocking')).toEqual([1, 2, 3, 4, 5]);
      const all = (await get().expect(200)).body as ClassImportDetail;
      expect(all.summary.total).toBe(5);
      await get('nonsense').expect(400);
    });

    it('returns 404 for an unknown import', async () => {
      const res = await http()
        .get(`/admin/class-imports/${UNKNOWN_ID}`)
        .set('Authorization', admin)
        .expect(404);
      expect(message(res)).toBe(IMPORT_NOT_FOUND);
    });

    it('lets the admin fix one row and keeps the choice across re-matches', async () => {
      const { import: draft } = await uploaded();
      const patch = (rowNo: number, body: object) =>
        http()
          .patch(`/admin/class-imports/${draft.id}/rows/${rowNo}`)
          .set('Authorization', admin)
          .send(body);

      const res = await patch(2, {
        instructorId: BEN_ID,
        lessonTypeId: GROUP_2H_ID,
        customerId: MEI_ID,
      }).expect(200);
      const body = res.body as ClassImportDetail;
      expect(body.rows[1]).toMatchObject({
        instructorId: BEN_ID,
        matchedInstructorName: 'Ben Sample',
        lessonTypeId: GROUP_2H_ID,
        customerId: MEI_ID,
        problems: [],
        manualFields: ['instructor', 'lesson_type', 'customer'],
      });
      expect(body.summary.willImport).toBe(1);
      expect(ctx.repo.imports[0].counts).toMatchObject({ willImport: 1 });

      await mapEvents([
        { eventName: 'Group Lesson 2h', lessonTypeId: PRIVATE_2H_ID },
      ]).expect(200);
      const after = (
        await http()
          .get(`/admin/class-imports/${draft.id}`)
          .set('Authorization', admin)
          .expect(200)
      ).body as ClassImportDetail;
      expect(after.rows[1]).toMatchObject({
        instructorId: BEN_ID,
        lessonTypeId: GROUP_2H_ID,
      });

      const cleared = (await patch(3, { customerId: null }).expect(200))
        .body as ClassImportDetail;
      expect(cleared.rows[2]).toMatchObject({ customerId: null });
      expect(cleared.rows[2].problems).not.toContain('customer_not_found');

      expect(ctx.audit.entries.map((e) => e.action)).toEqual([
        'class_import.create',
        'class_import.row_update',
        'class_import.event_map_update',
        'class_import.row_update',
      ]);
      expect(ctx.audit.entries[1].metadata).toEqual({
        rowNo: 2,
        fields: ['instructorId', 'lessonTypeId', 'customerId'],
        blocked: false,
      });
    });

    it('validates row fixes', async () => {
      const { import: draft } = await uploaded();
      const patch = (rowNo: number | string, body: object) =>
        http()
          .patch(`/admin/class-imports/${draft.id}/rows/${rowNo}`)
          .set('Authorization', admin)
          .send(body);

      expect(message(await patch(1, {}).expect(400))).toBe(
        IMPORT_NOTHING_TO_UPDATE,
      );
      expect(
        message(await patch(1, { instructorId: UNKNOWN_ID }).expect(400)),
      ).toBe(IMPORT_INSTRUCTOR_NOT_FOUND);
      expect(
        message(await patch(1, { lessonTypeId: UNKNOWN_ID }).expect(400)),
      ).toBe(IMPORT_LESSON_TYPE_NOT_FOUND);
      expect(
        message(await patch(1, { customerId: UNKNOWN_ID }).expect(400)),
      ).toBe(IMPORT_CUSTOMER_NOT_FOUND);
      expect(
        message(await patch(99, { instructorId: BEN_ID }).expect(404)),
      ).toBe(IMPORT_ROW_NOT_FOUND);
      await patch('x', { instructorId: BEN_ID }).expect(400);
      await patch(1, { instructorId: 'nope' }).expect(400);
      await patch(1, { extra: true }).expect(400);
      await http()
        .patch(`/admin/class-imports/${UNKNOWN_ID}/rows/1`)
        .set('Authorization', admin)
        .send({ instructorId: BEN_ID })
        .expect(404);
    });
  });

  describe('paging rows', () => {
    const LARGE = importCsv(
      Array.from({ length: 60 }, (_, i) => ({
        id: String(9100001 + i),
        instructor: (i + 1) % 4 === 0 ? 'Nobody Known' : 'Anna Example',
        event: (i + 1) % 10 === 0 ? 'Group Lesson 2h' : 'Private Lesson 2h',
      })),
    );
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const lostInstructor = (n: number) => n % 4 === 0;

    let draftId: string;
    beforeEach(async () => {
      draftId = (await uploaded(LARGE)).import.id;
    });

    const get = (query: Record<string, string | number> = {}) =>
      http()
        .get(`/admin/class-imports/${draftId}`)
        .query(query)
        .set('Authorization', admin);
    const detail = (res: request.Response) => res.body as ClassImportDetail;
    const rowNos = (res: request.Response) =>
      detail(res).rows.map((r) => r.rowNo);
    const total = (res: request.Response) =>
      res.headers[TOTAL_COUNT_HEADER.toLowerCase()];

    it('returns every row with the total when no page or limit is given', async () => {
      const res = await get().expect(200);
      expect(rowNos(res)).toEqual(range(1, 60));
      expect(total(res)).toBe('60');
    });

    it('returns every filtered row with the filtered total when unpaged', async () => {
      const res = await get({ problem: 'instructor_not_found' }).expect(200);
      expect(rowNos(res)).toEqual(range(1, 60).filter(lostInstructor));
      expect(total(res)).toBe('15');
    });

    it('defaults to 50 per page when only page is given', async () => {
      const first = await get({ page: 1 }).expect(200);
      expect(rowNos(first)).toEqual(range(1, 50));
      expect(total(first)).toBe('60');
      const second = await get({ page: 2 }).expect(200);
      expect(rowNos(second)).toEqual(range(51, 60));
      expect(total(second)).toBe('60');
    });

    it('defaults to the first page when only limit is given', async () => {
      const res = await get({ limit: 5 }).expect(200);
      expect(rowNos(res)).toEqual(range(1, 5));
      expect(total(res)).toBe('60');
    });

    it('returns the requested slice for page and limit', async () => {
      const res = await get({ page: 3, limit: 25 }).expect(200);
      expect(rowNos(res)).toEqual(range(51, 60));
      expect(total(res)).toBe('60');
    });

    it('filters by problem before paging, with the filtered total', async () => {
      const res = await get({
        problem: 'instructor_not_found',
        page: 2,
        limit: 4,
      }).expect(200);
      expect(rowNos(res)).toEqual([20, 24, 28, 32]);
      expect(total(res)).toBe('15');
    });

    it('keeps the summary and event names over every row of the import', async () => {
      const unpaged = detail(await get().expect(200));
      const paged = detail(
        await get({
          problem: 'instructor_not_found',
          page: 2,
          limit: 3,
        }).expect(200),
      );
      expect(paged.import).toEqual(unpaged.import);
      expect(paged.summary).toEqual(unpaged.summary);
      expect(paged.summary).toMatchObject({ total: 60, needsInstructor: 15 });
      expect(paged.eventNames).toEqual([
        { eventName: 'Group Lesson 2h', rows: 6, lessonTypeId: null },
        { eventName: 'Private Lesson 2h', rows: 54, lessonTypeId: null },
      ]);
    });

    it('answers a page past the end with no rows and the real total', async () => {
      const res = await get({ page: 4, limit: 20 }).expect(200);
      expect(detail(res).rows).toEqual([]);
      expect(detail(res).summary.total).toBe(60);
      expect(total(res)).toBe('60');
    });

    it('accepts the largest page and page size', async () => {
      const res = await get({ page: 10000, limit: 100 }).expect(200);
      expect(detail(res).rows).toEqual([]);
      expect(total(res)).toBe('60');
    });

    it('leaves the row fix response unpaged', async () => {
      const res = await http()
        .patch(`/admin/class-imports/${draftId}/rows/2`)
        .query({ page: 1, limit: 5 })
        .set('Authorization', admin)
        .send({ lessonTypeId: PRIVATE_2H_ID })
        .expect(200);
      expect(rowNos(res)).toEqual(range(1, 60));
      expect(total(res)).toBeUndefined();
    });

    it.each([
      'page=0',
      'page=-1',
      'page=10001',
      'page=1.5',
      'page=abc',
      'limit=0',
      'limit=101',
      'limit=2.5',
      'limit=abc',
    ])('rejects %s with 400', async (query) => {
      await http()
        .get(`/admin/class-imports/${draftId}?${query}`)
        .set('Authorization', admin)
        .expect(400);
    });
  });

  describe('event map', () => {
    it('saves, lists and removes mappings and re-matches open drafts only', async () => {
      const open = await uploaded();
      const closed = await uploaded();
      await http()
        .post(`/admin/class-imports/${closed.import.id}/discard`)
        .set('Authorization', admin)
        .expect(200);

      const res = await mapEvents([
        { eventName: ' Private Lesson 2h ', lessonTypeId: PRIVATE_2H_ID },
        { eventName: 'Group Lesson 2h', lessonTypeId: GROUP_2H_ID },
      ]).expect(200);
      expect(res.body as EventMapResult).toEqual({
        mappings: [
          { eventName: 'Group Lesson 2h', lessonTypeId: GROUP_2H_ID },
          { eventName: 'Private Lesson 2h', lessonTypeId: PRIVATE_2H_ID },
        ],
        rematchedImports: 1,
      });
      const openRows = await ctx.repo.listRows(open.import.id);
      expect(openRows.map((r) => r.lesson_type_id)).toEqual([
        PRIVATE_2H_ID,
        GROUP_2H_ID,
        PRIVATE_2H_ID,
        PRIVATE_2H_ID,
        PRIVATE_2H_ID,
      ]);
      expect(
        ctx.repo.imports.find((i) => i.id === open.import.id)?.counts,
      ).toMatchObject({
        needsLessonType: 0,
      });
      const closedRows = await ctx.repo.listRows(closed.import.id);
      expect(closedRows.every((r) => r.lesson_type_id === null)).toBe(true);

      await mapEvents([
        { eventName: 'Group Lesson 2h', lessonTypeId: null },
      ]).expect(200);
      const listed = await http()
        .get('/admin/class-imports/event-map')
        .set('Authorization', admin)
        .expect(200);
      expect(listed.body).toEqual([
        { eventName: 'Private Lesson 2h', lessonTypeId: PRIVATE_2H_ID },
      ]);
      expect(ctx.audit.entries.at(-1)).toMatchObject({
        action: 'class_import.event_map_update',
        metadata: { set: 0, removed: 1, rematchedImports: 1 },
      });
    });

    it('rejects unknown lesson types, duplicates and empty bodies', async () => {
      expect(
        message(
          await mapEvents([
            { eventName: 'A', lessonTypeId: UNKNOWN_ID },
          ]).expect(400),
        ),
      ).toBe(IMPORT_LESSON_TYPE_NOT_FOUND);
      expect(
        message(
          await mapEvents([
            { eventName: 'A', lessonTypeId: PRIVATE_2H_ID },
            { eventName: 'A ', lessonTypeId: null },
          ]).expect(400),
        ),
      ).toBe(IMPORT_DUPLICATE_EVENT_NAME);
      await mapEvents([]).expect(400);
      await mapEvents([{ eventName: '', lessonTypeId: null }]).expect(400);
      expect(ctx.repo.map).toHaveLength(0);
    });
  });

  describe('commit and discard', () => {
    const commit = (id: string) =>
      http()
        .post(`/admin/class-imports/${id}/commit`)
        .set('Authorization', admin);

    it('commits ready rows once and never duplicates classes on re-import', async () => {
      await mapEvents([
        { eventName: 'Private Lesson 2h', lessonTypeId: PRIVATE_2H_ID },
        { eventName: 'Group Lesson 2h', lessonTypeId: GROUP_2H_ID },
      ]).expect(200);
      const first = await uploaded();

      const res = await commit(first.import.id).expect(200);
      const body = res.body as CommitResult;
      expect(body.counts).toEqual({
        total: 5,
        ready: 4,
        created: 4,
        alreadyImported: 0,
        participants: 2,
        skipped: 1,
      });
      expect(body.import.status).toBe('committed');
      expect(ctx.repo.classes).toHaveLength(4);
      expect(ctx.audit.entries.at(-1)).toMatchObject({
        action: 'class_import.commit',
        targetId: first.import.id,
        metadata: body.counts,
      });

      const again = await uploaded();
      expect(again.summary).toMatchObject({
        alreadyImported: 4,
        willImport: 0,
      });
      const second = (await commit(again.import.id).expect(200))
        .body as CommitResult;
      expect(second.counts).toMatchObject({ created: 0, alreadyImported: 4 });
      expect(ctx.repo.classes).toHaveLength(4);

      await commit(first.import.id).expect(409);
      await http()
        .patch(`/admin/class-imports/${first.import.id}/rows/1`)
        .set('Authorization', admin)
        .send({ instructorId: BEN_ID })
        .expect(409);
      await http()
        .post(`/admin/class-imports/${first.import.id}/discard`)
        .set('Authorization', admin)
        .expect(409);
    });

    it('maps commit-time races onto 404 and 409', async () => {
      const { import: draft } = await uploaded();

      ctx.repo.commitError = new DatabaseError('commit', 'P0002', 'gone');
      expect(message(await commit(draft.id).expect(404))).toBe(
        IMPORT_NOT_FOUND,
      );
      ctx.repo.commitError = new DatabaseError('commit', '55000', 'not draft');
      expect(message(await commit(draft.id).expect(409))).toBe(
        IMPORT_NOT_DRAFT,
      );
      ctx.repo.commitError = new DatabaseError('commit', undefined, 'boom');
      await commit(draft.id).expect(500);
      await commit(UNKNOWN_ID).expect(404);
    });

    it('discards a draft, audited, and refuses to commit it afterwards', async () => {
      const { import: draft } = await uploaded();

      const res = await http()
        .post(`/admin/class-imports/${draft.id}/discard`)
        .set('Authorization', admin)
        .expect(200);

      expect((res.body as { status: string }).status).toBe('discarded');
      expect(ctx.audit.entries.at(-1)).toMatchObject({
        action: 'class_import.discard',
        targetId: draft.id,
      });
      await commit(draft.id).expect(409);
      await http()
        .post(`/admin/class-imports/${UNKNOWN_ID}/discard`)
        .set('Authorization', admin)
        .expect(404);
    });
  });
});
