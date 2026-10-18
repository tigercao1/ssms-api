import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADA_AUTH,
  ADA_INSTRUCTOR,
  ADA_USER,
  ADMIN_AUTH,
  BO_AUTH,
  BO_INSTRUCTOR,
  BO_USER,
  HILL_ID,
  InMemoryLessonInsuranceRepository,
  INSURANCE_ADMIN_ID,
  NOW,
  startInsuranceApp,
} from '../../test/helpers/insurance-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import {
  InMemorySeasonsRepository,
  SEASON_2026,
  seasonRow,
  seasonsProviders,
} from '../../test/helpers/seasons-fakes';
import { AuditService } from '../audit/audit.service';
import { AdminInsuranceController } from './admin-insurance.controller';
import {
  ALREADY_VOIDED,
  type AdminInsuranceRecordPage,
  type AdminInsuranceRequestPage,
  AdminInsuranceService,
  type InstructorInsuranceSummary,
  MARK_PAID_NEEDS_UNPAID,
  MARK_UNPAID_NEEDS_PAID,
  RECORD_NOT_FOUND,
  REQUEST_ALREADY_VOIDED,
  REQUEST_MARK_PAID_NEEDS_UNPAID,
  REQUEST_MARK_UNPAID_NEEDS_PAID,
  REQUEST_NOT_FOUND,
} from './admin-insurance.service';
import type {
  AdminInsuranceRecord,
  AdminInsuranceRequest,
  InsuranceRecord,
  InsuranceRequest,
} from './insurance.presenters';
import {
  LessonInsuranceRepository,
  type RequestTransitionInput,
} from './lesson-insurance.repository';
import { MeInsuranceController } from './me-insurance.controller';
import {
  INSURANCE_PENDING,
  LOCATION_CONFLICT,
  MeInsuranceService,
  MIXED_SEASONS,
  type MyInsurance,
  NO_SEASON_FOR_DATE,
  TOO_MANY_LESSONS,
  UNKNOWN_LOCATION,
  WAIVER_UNCONFIRMED,
} from './me-insurance.service';

async function build(approval: 'approved' | 'pending' = 'approved') {
  const seasons = new InMemorySeasonsRepository([
    SEASON_2026,
    seasonRow('2027/28'),
  ]);
  const now = () => new Date(NOW);
  const repo = new InMemoryLessonInsuranceRepository(
    () => [...seasons.rows.values()],
    now,
  );
  repo.addInstructor(ADA_USER, ADA_INSTRUCTOR, 'Ada Lovelace', approval);
  repo.addInstructor(BO_USER, BO_INSTRUCTOR, 'Bo Zhang');
  const audit = recordingAudit();
  const app = await startInsuranceApp(
    Test.createTestingModule({
      controllers: [MeInsuranceController, AdminInsuranceController],
      providers: [
        ...seasonsProviders(seasons, now),
        MeInsuranceService,
        AdminInsuranceService,
        { provide: LessonInsuranceRepository, useValue: repo },
        { provide: AuditService, useValue: audit },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }),
  );
  return { app, repo, audit };
}

const students = (n: number, waiver = true) =>
  Array.from({ length: n }, (_, i) => ({
    name: `Student ${i + 1}`,
    waiverConfirmed: waiver,
  }));

const lessonOf = (
  lessonDate: string,
  durationHours: number,
  count: number,
  extra: object = {},
) => ({ lessonDate, durationHours, students: students(count), ...extra });

describe('insurance requests', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());
  const submit = (
    lessons: object[],
    idempotencyKey: string = randomUUID(),
    auth = ADA_AUTH,
  ) =>
    http()
      .post('/me/insurance/requests')
      .set('Authorization', auth)
      .send({ lessons, idempotencyKey });
  const created = async (lessons: object[], auth = ADA_AUTH) =>
    (await submit(lessons, randomUUID(), auth).expect(201))
      .body as InsuranceRequest;
  const register = async (lesson: object) =>
    (
      await http()
        .post('/me/insurance/records')
        .set('Authorization', ADA_AUTH)
        .send({ idempotencyKey: randomUUID(), ...lesson })
        .expect(201)
    ).body as InsuranceRecord;
  const mine = async (auth = ADA_AUTH) =>
    (await http().get('/me/insurance').set('Authorization', auth).expect(200))
      .body as MyInsurance;
  const admin = (path: string, body: object = {}, auth = ADMIN_AUTH) =>
    http()
      .post(`/admin/insurance/requests/${path}`)
      .set('Authorization', auth)
      .send(body);
  const summaryRow = async (instructorId = ADA_INSTRUCTOR) =>
    (
      (
        await http()
          .get('/admin/insurance/summary')
          .set('Authorization', ADMIN_AUTH)
          .expect(200)
      ).body as InstructorInsuranceSummary[]
    ).find((row) => row.instructorId === instructorId);

  afterEach(async () => {
    await ctx.app.close();
  });

  describe('POST /me/insurance/requests', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('creates one request with one number, one status and one total', async () => {
      const res = await submit([
        lessonOf('2026-12-02', 2, 5, { locationId: HILL_ID }),
        lessonOf('2026-12-01', 1, 1, { locationOther: ' Back hill ' }),
      ]).expect(201);
      const body = res.body as InsuranceRequest;
      expect(body).toEqual({
        id: expect.any(String) as unknown,
        requestNo: 'INS-20261015-0001',
        seasonKey: '2026/27',
        paymentStatus: 'unpaid',
        totalCents: 9000,
        lessonCount: 2,
        studentCount: 6,
        createdAt: expect.any(String) as unknown,
        paidOn: null,
        lessons: [
          expect.objectContaining({
            recordNo: 'INS-20261015-0002',
            kind: 'lesson',
            lessonDate: '2026-12-02',
            durationHours: 2,
            locationId: HILL_ID,
            locationName: 'CI Hill',
            locationOther: null,
            studentCount: 5,
            listCents: 8000,
            amountCents: 8000,
            coverage: 'per_lesson',
            paymentStatus: 'unpaid',
          }),
          expect.objectContaining({
            recordNo: 'INS-20261015-0003',
            lessonDate: '2026-12-01',
            locationId: null,
            locationOther: 'Back hill',
            studentCount: 1,
            listCents: 1000,
            amountCents: 1000,
            coverage: 'per_lesson',
          }),
        ],
      });
      expect(ctx.repo.submitCalls[0]).toMatchObject({
        instructorId: ADA_INSTRUCTOR,
        seasonKey: null,
        actor: ADA_USER,
      });
      expect(ctx.repo.rows.size).toBe(2);
    });

    it('prices lessons in the order entered across the cap inside one request', async () => {
      for (const day of ['01', '02', '03', '04']) {
        await register(lessonOf(`2026-11-${day}`, 2, 4));
      }
      const req = await created([
        lessonOf('2026-12-01', 1, 2),
        lessonOf('2026-12-02', 2, 4),
        lessonOf('2026-12-03', 1, 1),
      ]);
      expect(
        req.lessons.map((l) => [l.listCents, l.amountCents, l.coverage]),
      ).toEqual([
        [2000, 2000, 'per_lesson'],
        [8000, 6000, 'cap_top_up'],
        [1000, 0, 'capped'],
      ]);
      expect(req).toMatchObject({ totalCents: 8000, paymentStatus: 'unpaid' });
      expect(req.lessons[2].paymentStatus).toBe('not_required');
      expect((await mine()).owedCents).toBe(40000);
    });

    it('prices across two requests and is free once capped', async () => {
      const first = await created([
        lessonOf('2026-12-01', 2, 4),
        lessonOf('2026-12-02', 2, 4),
        lessonOf('2026-12-03', 2, 4),
        lessonOf('2026-12-04', 2, 4),
        lessonOf('2026-12-05', 2, 2),
      ]);
      expect(first.totalCents).toBe(36000);
      const second = await created([
        lessonOf('2026-12-06', 2, 4),
        lessonOf('2026-12-07', 1, 1),
      ]);
      expect(second.lessons.map((l) => l.amountCents)).toEqual([4000, 0]);
      expect(second.totalCents).toBe(4000);
      const third = await created([lessonOf('2026-12-08', 2, 4)]);
      expect(third).toMatchObject({
        totalCents: 0,
        paymentStatus: 'not_required',
      });
      expect(third.lessons[0].coverage).toBe('capped');
      const overview = await mine();
      expect(overview).toMatchObject({
        owedCents: 40000,
        unpaidCents: 40000,
        coverage: 'capped',
        records: [],
      });
      expect(overview.requests.map((r) => r.id)).toEqual([
        third.id,
        second.id,
        first.id,
      ]);
    });

    it('returns the existing request with 200 on a repeated idempotency key', async () => {
      const key = randomUUID();
      const first = (
        await submit([lessonOf('2026-12-01', 1, 1)], key).expect(201)
      ).body as InsuranceRequest;
      const again = await submit([lessonOf('2026-12-09', 2, 3)], key).expect(
        200,
      );
      expect(again.body).toEqual(first);
      expect(ctx.repo.rows.size).toBe(1);
      expect(ctx.repo.requests.size).toBe(1);
    });

    it('creates nothing when lesson 3 fails', async () => {
      await register(lessonOf('2026-11-01', 1, 1));
      const counters = new Map(ctx.repo.counters);
      await submit([
        lessonOf('2026-12-01', 1, 1),
        lessonOf('2026-12-02', 1, 1),
        lessonOf('2026-12-03', 1, 1, { locationId: randomUUID() }),
      ]).expect(400, {
        statusCode: 400,
        message: UNKNOWN_LOCATION,
        error: 'Bad Request',
      });
      expect(ctx.repo.rows.size).toBe(1);
      expect(ctx.repo.requests.size).toBe(0);
      expect(ctx.repo.counters).toEqual(counters);
      expect((await mine()).owedCents).toBe(1000);
    });

    it('accepts 10 lessons and rejects 11 with too_many_lessons', async () => {
      const lessons = (n: number) =>
        Array.from({ length: n }, (_, i) =>
          lessonOf(`2026-12-${String(i + 1).padStart(2, '0')}`, 1, 1),
        );
      await submit(lessons(11)).expect(400, {
        statusCode: 400,
        code: 'too_many_lessons',
        message: TOO_MANY_LESSONS,
        maxLessons: 10,
      });
      expect(ctx.repo.submitCalls).toHaveLength(0);
      const ten = await created(lessons(10));
      expect(ten).toMatchObject({ lessonCount: 10, totalCents: 10000 });
      expect(ten.lessons.map((l) => l.lessonDate)).toEqual(
        lessons(10).map((l) => l.lessonDate),
      );
    });

    it('400s too_many_lessons from the database as well', async () => {
      jest.spyOn(ctx.repo, 'submitRequest').mockResolvedValueOnce({
        outcome: 'too_many_lessons',
        lesson_count: 11,
      });
      await submit([lessonOf('2026-12-01', 1, 1)]).expect(400, {
        statusCode: 400,
        code: 'too_many_lessons',
        message: TOO_MANY_LESSONS,
        maxLessons: 10,
      });
    });

    it('400s mixed_seasons and no_season naming the lesson', async () => {
      await submit([
        lessonOf('2026-12-01', 1, 1),
        lessonOf('2027-12-01', 1, 1),
      ]).expect(400, {
        statusCode: 400,
        code: 'mixed_seasons',
        message: MIXED_SEASONS,
        lessonIndex: 1,
        seasonKey: '2026/27',
      });
      await submit([
        lessonOf('2026-12-01', 1, 1),
        lessonOf('2026-12-02', 1, 1),
        lessonOf('2027-05-15', 1, 1),
      ]).expect(400, {
        statusCode: 400,
        code: 'no_season',
        message: NO_SEASON_FOR_DATE,
        lessonIndex: 2,
      });
      jest
        .spyOn(ctx.repo, 'submitRequest')
        .mockResolvedValueOnce({ outcome: 'no_season' });
      await submit([lessonOf('2026-12-01', 1, 1)]).expect(400, {
        statusCode: 400,
        code: 'no_season',
        message: NO_SEASON_FOR_DATE,
        lessonIndex: null,
      });
      expect(ctx.repo.rows.size).toBe(0);
    });

    it('400s waiver_unconfirmed with every lesson and student index', async () => {
      await submit([
        {
          lessonDate: '2026-12-01',
          durationHours: 1,
          students: [
            { name: 'Ada', waiverConfirmed: true },
            { name: 'Leo', waiverConfirmed: false },
          ],
        },
        lessonOf('2026-12-02', 1, 1),
        {
          lessonDate: '2026-12-03',
          durationHours: 2,
          students: students(1, false),
        },
      ]).expect(400, {
        statusCode: 400,
        code: 'waiver_unconfirmed',
        message: WAIVER_UNCONFIRMED,
        indexes: [
          { lessonIndex: 0, studentIndex: 1 },
          { lessonIndex: 2, studentIndex: 0 },
        ],
      });
      expect(ctx.repo.submitCalls).toHaveLength(0);
    });

    it('400s a lesson with both a ski area and another, naming it', async () => {
      await submit([
        lessonOf('2026-12-01', 1, 1),
        lessonOf('2026-12-02', 1, 1, {
          locationId: HILL_ID,
          locationOther: 'X',
        }),
      ]).expect(400, {
        statusCode: 400,
        code: 'location_conflict',
        message: LOCATION_CONFLICT,
        lessonIndex: 1,
      });
    });

    it('validates the body shape', async () => {
      for (const body of [
        { lessons: [], idempotencyKey: randomUUID() },
        { lessons: [lessonOf('2026-12-01', 1, 1)] },
        {
          lessons: [lessonOf('2026-12-01', 3, 1)],
          idempotencyKey: randomUUID(),
        },
        {
          lessons: [lessonOf('2026-12-01', 1, 0)],
          idempotencyKey: randomUUID(),
        },
        {
          lessons: [lessonOf('12/01/2026', 1, 1)],
          idempotencyKey: randomUUID(),
        },
        {
          lessons: [lessonOf('2026-12-01', 1, 1, { topUp: true })],
          idempotencyKey: randomUUID(),
        },
      ]) {
        await http()
          .post('/me/insurance/requests')
          .set('Authorization', ADA_AUTH)
          .send(body)
          .expect(400);
      }
      expect(ctx.repo.submitCalls).toHaveLength(0);
    });

    it('rethrows other database errors and fails loudly when the request cannot be read back', async () => {
      jest
        .spyOn(ctx.repo, 'submitRequest')
        .mockRejectedValueOnce(new Error('boom'));
      await submit([lessonOf('2026-12-01', 1, 1)]).expect(500);
      jest.spyOn(ctx.repo, 'findRequest').mockResolvedValueOnce(null);
      await submit([lessonOf('2026-12-01', 1, 1)]).expect(500);
    });

    it('keeps the old single-lesson endpoint as a standalone record', async () => {
      const record = await register(lessonOf('2026-12-01', 1, 2));
      expect(record).toMatchObject({
        recordNo: 'INS-20261015-0001',
        amountCents: 2000,
        coverage: 'per_lesson',
      });
      expect(record).not.toHaveProperty('requestId');
      const req = await created([lessonOf('2026-12-02', 1, 1)]);
      const overview = await mine();
      expect(overview.records.map((r) => r.id)).toEqual([record.id]);
      expect(overview.requests.map((r) => r.id)).toEqual([req.id]);
      expect(overview).toMatchObject({ owedCents: 3000, unpaidCents: 3000 });
    });

    it('keeps each instructor to their own requests', async () => {
      await created([lessonOf('2026-12-01', 1, 1)], BO_AUTH);
      expect((await mine()).requests).toEqual([]);
      expect((await mine(BO_AUTH)).requests).toHaveLength(1);
    });
  });

  describe('a pending instructor', () => {
    beforeEach(async () => {
      ctx = await build('pending');
    });

    it('cannot submit and sees no requests', async () => {
      await submit([lessonOf('2026-12-01', 1, 1)]).expect(403, {
        message: INSURANCE_PENDING,
        reason: 'pending_approval',
      });
      expect(ctx.repo.submitCalls).toHaveLength(0);
      ctx.repo.instructors.get(ADA_INSTRUCTOR)!.approval_status = 'approved';
      await created([lessonOf('2026-12-01', 1, 1)]);
      ctx.repo.instructors.get(ADA_INSTRUCTOR)!.approval_status = 'pending';
      expect(await mine()).toMatchObject({ requests: [], records: [] });
    });
  });

  describe('/admin/insurance/requests', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('is admin only', async () => {
      const req = await created([lessonOf('2026-12-01', 1, 1)]);
      for (const call of [
        http().get('/admin/insurance/requests'),
        http().post(`/admin/insurance/requests/${req.id}/mark-paid`),
        http().post(`/admin/insurance/requests/${req.id}/mark-unpaid`),
        http()
          .post(`/admin/insurance/requests/${req.id}/void`)
          .send({ reason: 'x' }),
      ]) {
        await call.set('Authorization', ADA_AUTH).expect(403);
      }
      expect(ctx.repo.transitionCalls).toHaveLength(0);
    });

    it('pages requests with their lessons and the instructor, filtered', async () => {
      const a1 = await created([
        lessonOf('2026-12-01', 1, 1),
        lessonOf('2026-12-02', 2, 2),
      ]);
      const b1 = await created([lessonOf('2026-12-03', 1, 3)], BO_AUTH);
      await created([lessonOf('2027-12-01', 1, 1)]);
      const res = await http()
        .get('/admin/insurance/requests')
        .set('Authorization', ADMIN_AUTH)
        .expect(200);
      const page = res.body as AdminInsuranceRequestPage;
      expect(page.total).toBe(2);
      expect(page.requests.map((r) => r.id)).toEqual([b1.id, a1.id]);
      expect(page.requests[1]).toMatchObject({
        instructorId: ADA_INSTRUCTOR,
        instructorName: 'Ada Lovelace',
        instructorEmail: 'ada.lovelace@example.com',
        totalCents: 5000,
        studentCount: 3,
        paidNote: null,
        voidedReason: null,
        createdBy: ADA_USER,
      });
      expect(page.requests[1].lessons).toEqual([
        expect.objectContaining({
          lessonDate: '2026-12-01',
          instructorName: 'Ada Lovelace',
          paidNote: null,
        }),
        expect.objectContaining({
          lessonDate: '2026-12-02',
          amountCents: 4000,
        }),
      ]);
      const filtered = await http()
        .get('/admin/insurance/requests')
        .query({
          season: '2026/27',
          instructorId: BO_INSTRUCTOR,
          paymentStatus: 'unpaid',
          page: 1,
          limit: 1,
        })
        .set('Authorization', ADMIN_AUTH)
        .expect(200);
      expect(
        (filtered.body as AdminInsuranceRequestPage).requests.map((r) => r.id),
      ).toEqual([b1.id]);
      expect(ctx.repo.listRequestCalls.at(-1)).toEqual({
        filter: {
          seasonKey: '2026/27',
          instructorId: BO_INSTRUCTOR,
          paymentStatus: 'unpaid',
        },
        page: { limit: 1, offset: 0 },
      });
      await http()
        .get('/admin/insurance/requests')
        .query({ paymentStatus: 'refunded' })
        .set('Authorization', ADMIN_AUTH)
        .expect(400);
    });

    it('is empty without any season', async () => {
      await ctx.app.close();
      const seasons = new InMemorySeasonsRepository([]);
      const repo = new InMemoryLessonInsuranceRepository(() => []);
      ctx.app = await startInsuranceApp(
        Test.createTestingModule({
          controllers: [AdminInsuranceController],
          providers: [
            ...seasonsProviders(seasons, () => new Date(NOW)),
            AdminInsuranceService,
            { provide: LessonInsuranceRepository, useValue: repo },
            { provide: AuditService, useValue: recordingAudit() },
            { provide: ConfigService, useValue: { get: () => undefined } },
          ],
        }),
      );
      await http()
        .get('/admin/insurance/requests')
        .set('Authorization', ADMIN_AUTH)
        .expect(200, { requests: [], total: 0 });
    });

    it('marks a request paid, cascading to its unpaid lessons, audited, and only from unpaid', async () => {
      for (const day of ['01', '02', '03', '04']) {
        await register(lessonOf(`2026-11-${day}`, 2, 4));
      }
      const req = await created([
        lessonOf('2026-12-01', 2, 4),
        lessonOf('2026-12-02', 1, 1),
      ]);
      const res = await admin(`${req.id}/mark-paid`, {
        note: ' e-transfer 7 ',
      }).expect(200);
      const body = res.body as AdminInsuranceRequest;
      expect(body).toMatchObject({
        id: req.id,
        paymentStatus: 'paid',
        paidOn: '2026-10-15',
        paidNote: 'e-transfer 7',
        paidBy: INSURANCE_ADMIN_ID,
      });
      expect(body.lessons.map((l) => [l.paymentStatus, l.paidOn])).toEqual([
        ['paid', '2026-10-15'],
        ['not_required', null],
      ]);
      expect(ctx.audit.entries).toEqual([
        {
          action: 'lesson_insurance_request.mark_paid',
          actor: { userId: INSURANCE_ADMIN_ID, role: 'admin', userAgent: null },
          targetType: 'lesson_insurance_request',
          targetId: req.id,
          metadata: {
            requestNo: req.requestNo,
            instructorId: ADA_INSTRUCTOR,
            seasonKey: '2026/27',
            totalCents: 8000,
            recordIds: req.lessons.map((l) => l.id),
            from: 'unpaid',
            to: 'paid',
            paidOn: '2026-10-15',
            note: 'e-transfer 7',
          },
        },
      ]);
      expect(await summaryRow()).toMatchObject({
        owedCents: 40000,
        paidCents: 8000,
        unpaidCents: 32000,
        records: 6,
      });
      await admin(`${req.id}/mark-paid`).expect(409, {
        statusCode: 409,
        message: REQUEST_MARK_PAID_NEEDS_UNPAID,
        error: 'Conflict',
      });
      const overview = await mine();
      expect(overview.requests[0]).toMatchObject({
        paymentStatus: 'paid',
        paidOn: '2026-10-15',
      });
      expect(overview.requests[0]).not.toHaveProperty('paidNote');
    });

    it('marks a paid request unpaid again, cascading, and only from paid', async () => {
      const req = await created([
        lessonOf('2026-12-01', 1, 1),
        lessonOf('2026-12-02', 1, 2),
      ]);
      await admin(`${req.id}/mark-unpaid`).expect(409, {
        statusCode: 409,
        message: REQUEST_MARK_UNPAID_NEEDS_PAID,
        error: 'Conflict',
      });
      await admin(`${req.id}/mark-paid`, { paidOn: '2026-10-01' }).expect(200);
      const res = await admin(`${req.id}/mark-unpaid`).expect(200);
      const body = res.body as AdminInsuranceRequest;
      expect(body).toMatchObject({
        paymentStatus: 'unpaid',
        paidOn: null,
        paidNote: null,
        paidBy: null,
      });
      expect(body.lessons.every((l) => l.paymentStatus === 'unpaid')).toBe(
        true,
      );
      expect(ctx.audit.entries.at(-1)).toMatchObject({
        action: 'lesson_insurance_request.mark_unpaid',
        metadata: { from: 'paid', to: 'unpaid' },
      });
      expect(await summaryRow()).toMatchObject({
        paidCents: 0,
        unpaidCents: 3000,
      });
    });

    it('voids a request and every lesson, keeping where each came from, and later lessons are charged again', async () => {
      for (const day of ['01', '02', '03', '04']) {
        await register(lessonOf(`2026-11-${day}`, 2, 4));
      }
      const req = await created([
        lessonOf('2026-12-01', 2, 4),
        lessonOf('2026-12-02', 1, 1),
      ]);
      await admin(`${req.id}/mark-paid`).expect(200);
      const res = await admin(`${req.id}/void`, {
        reason: ' duplicate ',
      }).expect(200);
      const body = res.body as AdminInsuranceRequest;
      expect(body).toMatchObject({
        paymentStatus: 'voided',
        voidedReason: 'duplicate',
        voidedBy: INSURANCE_ADMIN_ID,
        voidedFromStatus: 'paid',
        paidOn: '2026-10-15',
      });
      expect(
        body.lessons.map((l) => [l.paymentStatus, l.voidedFromStatus]),
      ).toEqual([
        ['voided', 'paid'],
        ['voided', 'not_required'],
      ]);
      expect(ctx.audit.entries.at(-1)).toMatchObject({
        action: 'lesson_insurance_request.void',
        targetType: 'lesson_insurance_request',
        metadata: { from: 'paid', to: 'voided', reason: 'duplicate' },
      });
      expect(await summaryRow()).toMatchObject({
        owedCents: 32000,
        paidCents: 0,
        unpaidCents: 32000,
        coverage: 'none',
      });
      const next = await created([lessonOf('2026-12-03', 1, 1)]);
      expect(next.totalCents).toBe(1000);
      await admin(`${req.id}/void`, { reason: 'again' }).expect(409, {
        statusCode: 409,
        message: REQUEST_ALREADY_VOIDED,
        error: 'Conflict',
      });
    });

    it('voids a free request', async () => {
      for (const day of ['01', '02', '03', '04', '05']) {
        await register(lessonOf(`2026-11-${day}`, 2, 4));
      }
      const req = await created([lessonOf('2026-12-01', 1, 1)]);
      expect(req.paymentStatus).toBe('not_required');
      await admin(`${req.id}/mark-paid`).expect(409);
      const res = await admin(`${req.id}/void`, { reason: 'test' }).expect(200);
      expect(res.body).toMatchObject({
        paymentStatus: 'voided',
        voidedFromStatus: 'not_required',
      });
    });

    it('404s an unknown request and 400s a bad id, date or reason', async () => {
      const unknown = randomUUID();
      for (const path of [`${unknown}/mark-paid`, `${unknown}/mark-unpaid`]) {
        await admin(path).expect(404, {
          statusCode: 404,
          message: REQUEST_NOT_FOUND,
          error: 'Not Found',
        });
      }
      await admin(`${unknown}/void`, { reason: 'x' }).expect(404);
      await admin('not-a-uuid/mark-paid').expect(400);
      const req = await created([lessonOf('2026-12-01', 1, 1)]);
      await admin(`${req.id}/mark-paid`, { paidOn: '15/10/2026' }).expect(400);
      await admin(`${req.id}/void`, {}).expect(400);
      await admin(`${req.id}/void`, { reason: 'x'.repeat(501) }).expect(400);
      expect(ctx.audit.entries).toHaveLength(0);
    });

    it('answers with its own transition even when another lands before the response', async () => {
      const req = await created([
        lessonOf('2026-12-01', 1, 1),
        lessonOf('2026-12-02', 1, 2),
      ]);
      jest
        .spyOn(ctx.repo, 'transitionRequest')
        .mockImplementationOnce(async (input: RequestTransitionInput) => {
          const first = await ctx.repo.transitionRequest(input);
          await ctx.repo.transitionRequest({
            requestId: req.id,
            action: 'mark_unpaid',
            actor: INSURANCE_ADMIN_ID,
            paidOn: null,
            note: null,
            reason: null,
          });
          return first;
        });
      const res = await admin(`${req.id}/mark-paid`, {
        paidOn: '2026-10-01',
      }).expect(200);
      const body = res.body as AdminInsuranceRequest;
      expect(body.paymentStatus).toBe('paid');
      expect(body.lessons.map((l) => l.paymentStatus)).toEqual([
        'paid',
        'paid',
      ]);
      expect(ctx.audit.entries.at(-1)).toMatchObject({
        action: 'lesson_insurance_request.mark_paid',
        metadata: { from: 'unpaid', to: 'paid', paidOn: '2026-10-01' },
      });
      expect(ctx.repo.requests.get(req.id)?.payment_status).toBe('unpaid');
    });

    describe('record routes on a lesson in a request', () => {
      const recordAction = (path: string, body: object) =>
        http()
          .post(`/admin/insurance/records/${path}`)
          .set('Authorization', ADMIN_AUTH)
          .send(body);

      it('marks the whole request paid and unpaid, answering with the selected record', async () => {
        const req = await created([
          lessonOf('2026-12-01', 1, 1, { locationId: HILL_ID }),
          lessonOf('2026-12-02', 1, 2),
        ]);
        const [first, second] = req.lessons;
        const paid = (
          await recordAction(`${second.id}/mark-paid`, {
            paidOn: '2026-10-02',
            note: 'cash',
          }).expect(200)
        ).body as AdminInsuranceRecord;
        expect(paid).toMatchObject({
          id: second.id,
          recordNo: second.recordNo,
          kind: 'lesson',
          paymentStatus: 'paid',
          paidOn: '2026-10-02',
          paidNote: 'cash',
          paidBy: INSURANCE_ADMIN_ID,
          instructorId: ADA_INSTRUCTOR,
          instructorName: 'Ada Lovelace',
          amountCents: 2000,
        });
        expect(Object.keys(paid).sort()).toEqual(
          Object.keys(
            (
              (
                await http()
                  .get('/admin/insurance/records')
                  .set('Authorization', ADMIN_AUTH)
                  .expect(200)
              ).body as AdminInsuranceRecordPage
            ).records[0],
          ).sort(),
        );
        expect(
          [...ctx.repo.rows.values()]
            .filter((r) => r.request_id === req.id)
            .map((r) => r.payment_status),
        ).toEqual(['paid', 'paid']);
        expect(ctx.repo.requests.get(req.id)?.payment_status).toBe('paid');
        expect(ctx.audit.entries).toEqual([
          {
            action: 'lesson_insurance_request.mark_paid',
            actor: {
              userId: INSURANCE_ADMIN_ID,
              role: 'admin',
              userAgent: null,
            },
            targetType: 'lesson_insurance_request',
            targetId: req.id,
            metadata: {
              requestNo: req.requestNo,
              instructorId: ADA_INSTRUCTOR,
              seasonKey: '2026/27',
              totalCents: 3000,
              recordIds: [first.id, second.id],
              from: 'unpaid',
              to: 'paid',
              paidOn: '2026-10-02',
              note: 'cash',
              recordId: second.id,
              via: 'record_route',
            },
          },
        ]);
        await recordAction(`${first.id}/mark-paid`, {
          paidOn: '2026-10-02',
        }).expect(409, {
          statusCode: 409,
          message: MARK_PAID_NEEDS_UNPAID,
          error: 'Conflict',
        });

        const unpaid = (
          await recordAction(`${first.id}/mark-unpaid`, {}).expect(200)
        ).body as AdminInsuranceRecord;
        expect(unpaid).toMatchObject({
          id: first.id,
          paymentStatus: 'unpaid',
          paidOn: null,
          paidNote: null,
          locationName: 'CI Hill',
          requestId: req.id,
          requestNo: req.requestNo,
        });
        const listed = (
          await http()
            .get('/admin/insurance/records?season=2026%2F27')
            .set('Authorization', ADMIN_AUTH)
            .expect(200)
        ).body as { records: AdminInsuranceRecord[] };
        expect(
          listed.records
            .filter((r) => r.id === first.id || r.id === second.id)
            .map((r) => [r.requestId, r.requestNo]),
        ).toEqual([
          [req.id, req.requestNo],
          [req.id, req.requestNo],
        ]);
        expect(
          listed.records
            .filter((r) => r.requestId === null)
            .every((r) => r.requestNo === null),
        ).toBe(true);
        expect(ctx.repo.requests.get(req.id)?.payment_status).toBe('unpaid');
        expect(
          [...ctx.repo.rows.values()]
            .filter((r) => r.request_id === req.id)
            .every((r) => r.payment_status === 'unpaid'),
        ).toBe(true);
        expect(ctx.audit.entries.at(-1)).toMatchObject({
          action: 'lesson_insurance_request.mark_unpaid',
          targetId: req.id,
          metadata: {
            from: 'paid',
            to: 'unpaid',
            recordId: first.id,
            via: 'record_route',
          },
        });
        await recordAction(`${first.id}/mark-unpaid`, {}).expect(409, {
          statusCode: 409,
          message: MARK_UNPAID_NEEDS_PAID,
          error: 'Conflict',
        });
      });

      it('voids the whole request from one lesson', async () => {
        for (const day of ['01', '02', '03', '04']) {
          await register(lessonOf(`2026-11-${day}`, 2, 4));
        }
        const req = await created([
          lessonOf('2026-12-01', 2, 4),
          lessonOf('2026-12-02', 1, 1),
        ]);
        const [, free] = req.lessons;
        expect(free.paymentStatus).toBe('not_required');
        await recordAction(`${free.id}/mark-paid`, {
          paidOn: '2026-10-02',
        }).expect(409, {
          statusCode: 409,
          message: MARK_PAID_NEEDS_UNPAID,
          error: 'Conflict',
        });
        const res = await recordAction(`${free.id}/void`, {
          reason: 'duplicate',
        }).expect(200);
        expect(res.body).toMatchObject({
          id: free.id,
          paymentStatus: 'voided',
          voidedFromStatus: 'not_required',
          voidedReason: 'duplicate',
        });
        expect(ctx.repo.requests.get(req.id)).toMatchObject({
          payment_status: 'voided',
          voided_from_status: 'unpaid',
        });
        expect(
          [...ctx.repo.rows.values()]
            .filter((r) => r.request_id === req.id)
            .map((r) => [r.payment_status, r.voided_from_status]),
        ).toEqual([
          ['voided', 'unpaid'],
          ['voided', 'not_required'],
        ]);
        expect(ctx.audit.entries.at(-1)).toMatchObject({
          action: 'lesson_insurance_request.void',
          targetType: 'lesson_insurance_request',
          targetId: req.id,
          metadata: {
            from: 'unpaid',
            to: 'voided',
            reason: 'duplicate',
            recordId: free.id,
            via: 'record_route',
          },
        });
        expect(await summaryRow()).toMatchObject({
          owedCents: 32000,
          unpaidCents: 32000,
        });
        await recordAction(`${req.lessons[0].id}/void`, {
          reason: 'again',
        }).expect(409, {
          statusCode: 409,
          message: ALREADY_VOIDED,
          error: 'Conflict',
        });
      });

      it('maps a request conflict to the record message and never touches one lesson alone', async () => {
        const req = await created([lessonOf('2026-12-01', 1, 1)]);
        const lessonId = req.lessons[0].id;
        jest.spyOn(ctx.repo, 'transitionRequest').mockResolvedValueOnce({
          outcome: 'conflict',
          from: 'paid',
        });
        const update = jest.spyOn(ctx.repo, 'updateIfStatus');
        await recordAction(`${lessonId}/mark-paid`, {
          paidOn: '2026-10-02',
        }).expect(409, {
          statusCode: 409,
          message: MARK_PAID_NEEDS_UNPAID,
          error: 'Conflict',
        });
        jest.spyOn(ctx.repo, 'transitionRequest').mockResolvedValueOnce({
          outcome: 'updated',
          from: 'unpaid',
          to: 'paid',
          request: { ...(await ctx.repo.findRequest(req.id))!, lessons: [] },
        });
        await recordAction(`${lessonId}/mark-paid`, {
          paidOn: '2026-10-02',
        }).expect(404, {
          statusCode: 404,
          message: RECORD_NOT_FOUND,
          error: 'Not Found',
        });
        expect(update).not.toHaveBeenCalled();
        expect(ctx.repo.rows.get(lessonId)?.payment_status).toBe('unpaid');
      });
    });
  });
});
