import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADA_AUTH,
  ADA_INSTRUCTOR,
  ADA_USER,
  ADMIN_AUTH,
  BO_INSTRUCTOR,
  BO_USER,
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
  ALREADY_COVERED,
  ALREADY_HAS_PASS,
  ALREADY_VOIDED,
  AdminInsuranceService,
  INSTRUCTOR_NOT_APPROVED,
  type InstructorInsuranceSummary,
  INSTRUCTOR_NOT_FOUND,
  NO_CURRENT_SEASON,
  MARK_PAID_NEEDS_UNPAID,
  MARK_UNPAID_NEEDS_PAID,
  RECORD_CHANGED,
} from './admin-insurance.service';
import type {
  AdminInsuranceRecord,
  InsuranceRecord,
} from './insurance.presenters';
import {
  LessonInsuranceRepository,
  type RegisterInput,
} from './lesson-insurance.repository';
import { MeInsuranceController } from './me-insurance.controller';
import { MeInsuranceService, type MyInsurance } from './me-insurance.service';

const CAROL_USER = 'c0000000-0000-4000-8000-0000000000c0';
const CAROL_INSTRUCTOR = 'c1000000-0000-4000-8000-0000000000c0';

async function build(
  seasons = new InMemorySeasonsRepository([SEASON_2026, seasonRow('2027/28')]),
) {
  const now = () => new Date(NOW);
  const repo = new InMemoryLessonInsuranceRepository(
    () => [...seasons.rows.values()],
    now,
  );
  repo.addInstructor(
    ADA_USER,
    ADA_INSTRUCTOR,
    'Ada Lovelace',
    'approved',
    '艾达',
  );
  repo.addInstructor(BO_USER, BO_INSTRUCTOR, 'Bo Zhang');
  repo.addInstructor(CAROL_USER, CAROL_INSTRUCTOR, 'Carol King');
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
  return { app, repo, audit, admin: app.get(AdminInsuranceService) };
}

describe('/admin/insurance', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());

  const seed = async (
    instructorId: string,
    lessonDate: string,
    durationHours: number,
    count: number,
  ) => {
    const outcome = await ctx.repo.register({
      instructorId,
      kind: 'lesson',
      seasonKey: null,
      lessonDate,
      durationHours,
      locationId: null,
      locationOther: null,
      students: Array.from({ length: count }, (_, i) => ({
        name: `S${i}`,
        waiverConfirmed: true,
      })),
      idempotencyKey: randomUUID(),
      actor: null,
    } satisfies RegisterInput);
    return (outcome as { id: string }).id;
  };
  const post = (path: string, body: object = {}, auth = ADMIN_AUTH) =>
    http()
      .post(`/admin/insurance/records/${path}`)
      .set('Authorization', auth)
      .send(body);
  const grant = (instructorId: string, body: object = {}) =>
    http()
      .post(`/admin/insurance/instructors/${instructorId}/season-pass`)
      .set('Authorization', ADMIN_AUTH)
      .send(body);
  const summaryRow = async (instructorId: string, season?: string) =>
    (
      (
        await http()
          .get('/admin/insurance/summary')
          .query(season ? { season } : {})
          .set('Authorization', ADMIN_AUTH)
          .expect(200)
      ).body as InstructorInsuranceSummary[]
    ).find((row) => row.instructorId === instructorId);
  const mine = async () =>
    (
      await http()
        .get('/me/insurance')
        .set('Authorization', ADA_AUTH)
        .expect(200)
    ).body as MyInsurance;

  beforeEach(async () => {
    ctx = await build();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it('is admin only', async () => {
    const id = await seed(ADA_INSTRUCTOR, '2026-12-01', 1, 1);
    await http().get('/admin/insurance/summary').expect(401);
    for (const call of [
      http().get('/admin/insurance/summary'),
      http().get('/admin/insurance/records'),
      http().post(`/admin/insurance/records/${id}/mark-paid`),
      http().post(`/admin/insurance/records/${id}/mark-unpaid`),
      http().post(`/admin/insurance/records/${id}/void`).send({ reason: 'x' }),
      http().post(`/admin/insurance/instructors/${ADA_INSTRUCTOR}/season-pass`),
    ]) {
      await call.set('Authorization', ADA_AUTH).expect(403);
    }
    expect(ctx.repo.rows.get(id)?.payment_status).toBe('unpaid');
  });

  describe('GET summary', () => {
    it('totals every approved instructor in the season, sorted by name', async () => {
      await seed(BO_INSTRUCTOR, '2026-12-01', 2, 4);
      await seed(ADA_INSTRUCTOR, '2026-12-01', 1, 1);
      for (const day of ['02', '03', '04', '05', '06']) {
        await seed(ADA_INSTRUCTOR, `2026-12-${day}`, 2, 4);
      }
      await seed(ADA_INSTRUCTOR, '2027-12-01', 1, 1);
      const paid = [...ctx.repo.rows.values()].find(
        (r) => r.instructor_id === BO_INSTRUCTOR,
      )!;
      await post(`${paid.id}/mark-paid`).expect(200);
      await http()
        .get('/admin/insurance/summary')
        .set('Authorization', ADMIN_AUTH)
        .expect(200, [
          {
            instructorId: ADA_INSTRUCTOR,
            name: 'Ada Lovelace',
            nameZh: '艾达',
            email: 'ada.lovelace@example.com',
            owedCents: 40000,
            paidCents: 0,
            unpaidCents: 40000,
            coverage: 'capped',
            seasonPassRecordId: null,
            seasonPassPaymentStatus: null,
            records: 6,
          },
          {
            instructorId: BO_INSTRUCTOR,
            name: 'Bo Zhang',
            nameZh: null,
            email: 'bo.zhang@example.com',
            owedCents: 8000,
            paidCents: 8000,
            unpaidCents: 0,
            coverage: 'none',
            seasonPassRecordId: null,
            seasonPassPaymentStatus: null,
            records: 1,
          },
          {
            instructorId: CAROL_INSTRUCTOR,
            name: 'Carol King',
            nameZh: null,
            email: 'carol.king@example.com',
            owedCents: 0,
            paidCents: 0,
            unpaidCents: 0,
            coverage: 'none',
            seasonPassRecordId: null,
            seasonPassPaymentStatus: null,
            records: 0,
          },
        ]);
      const later = await http()
        .get('/admin/insurance/summary')
        .query({ season: '2027/28' })
        .set('Authorization', ADMIN_AUTH)
        .expect(200);
      expect(later.body).toEqual([
        expect.objectContaining({
          instructorId: ADA_INSTRUCTOR,
          owedCents: 1000,
          records: 1,
        }),
        expect.objectContaining({
          instructorId: BO_INSTRUCTOR,
          owedCents: 0,
          records: 0,
        }),
        expect.objectContaining({
          instructorId: CAROL_INSTRUCTOR,
          owedCents: 0,
          records: 0,
        }),
      ]);
    });

    it('leaves out a pending instructor without records and keeps a rejected one with records', async () => {
      await seed(BO_INSTRUCTOR, '2026-12-01', 1, 1);
      ctx.repo.instructors.get(BO_INSTRUCTOR)!.approval_status = 'rejected';
      ctx.repo.instructors.get(CAROL_INSTRUCTOR)!.approval_status = 'pending';
      const res = await http()
        .get('/admin/insurance/summary')
        .set('Authorization', ADMIN_AUTH)
        .expect(200);
      expect(
        (res.body as InstructorInsuranceSummary[]).map((row) => [
          row.instructorId,
          row.name,
          row.records,
        ]),
      ).toEqual([
        [ADA_INSTRUCTOR, 'Ada Lovelace', 0],
        [BO_INSTRUCTOR, 'Bo Zhang', 1],
      ]);
    });

    it('400s an unknown season and is empty without any season', async () => {
      await http()
        .get('/admin/insurance/summary')
        .query({ season: '2099/00' })
        .set('Authorization', ADMIN_AUTH)
        .expect(400);
      await ctx.app.close();
      ctx = await build(new InMemorySeasonsRepository([]));
      await http()
        .get('/admin/insurance/summary')
        .set('Authorization', ADMIN_AUTH)
        .expect(200, []);
      await http()
        .get('/admin/insurance/records')
        .set('Authorization', ADMIN_AUTH)
        .expect(200, { records: [], total: 0 });
    });
  });

  describe('GET records', () => {
    it('pages records with the instructor and admin fields, filtered', async () => {
      const a = await seed(ADA_INSTRUCTOR, '2026-12-01', 1, 1);
      await seed(ADA_INSTRUCTOR, '2026-12-02', 1, 1);
      await seed(BO_INSTRUCTOR, '2026-12-03', 1, 1);
      await post(`${a}/mark-paid`, {
        paidOn: '2026-10-14',
        note: 'e-transfer',
      });
      const res = await http()
        .get('/admin/insurance/records')
        .query({ instructorId: ADA_INSTRUCTOR, paymentStatus: 'paid' })
        .set('Authorization', ADMIN_AUTH)
        .expect(200);
      const body = res.body as {
        records: AdminInsuranceRecord[];
        total: number;
      };
      expect(body.total).toBe(1);
      expect(body.records[0]).toMatchObject({
        id: a,
        instructorId: ADA_INSTRUCTOR,
        instructorName: 'Ada Lovelace',
        instructorNameZh: '艾达',
        instructorEmail: 'ada.lovelace@example.com',
        paymentStatus: 'paid',
        paidOn: '2026-10-14',
        paidNote: 'e-transfer',
        paidBy: INSURANCE_ADMIN_ID,
        voidedAt: null,
        voidedReason: null,
        voidedBy: null,
        voidedFromStatus: null,
        updatedAt: expect.any(String) as unknown,
      });
      const page = await http()
        .get('/admin/insurance/records')
        .query({ page: 2, limit: 2 })
        .set('Authorization', ADMIN_AUTH)
        .expect(200);
      expect(page.body).toMatchObject({ total: 3 });
      expect((page.body as { records: unknown[] }).records).toHaveLength(1);
      expect(ctx.repo.listCalls.at(-1)).toEqual({
        filter: {
          seasonKey: '2026/27',
          instructorId: undefined,
          paymentStatus: undefined,
        },
        page: { limit: 2, offset: 2 },
      });
      await http()
        .get('/admin/insurance/records')
        .set('Authorization', ADMIN_AUTH)
        .expect(200);
      expect(ctx.repo.listCalls.at(-1)?.page).toEqual({ limit: 50, offset: 0 });
      for (const query of [
        { paymentStatus: 'refunded' },
        { instructorId: 'nope' },
        { limit: 101 },
        { page: 0 },
      ]) {
        await http()
          .get('/admin/insurance/records')
          .query(query)
          .set('Authorization', ADMIN_AUTH)
          .expect(400);
      }
    });
  });

  describe('POST instructors/:instructorId/season-pass', () => {
    it('grants 400 minus what is owed as one unpaid season pass, audited, and later lessons are free', async () => {
      await seed(ADA_INSTRUCTOR, '2026-12-01', 1, 1);
      const res = await grant(ADA_INSTRUCTOR, {
        note: ' paid up front ',
      }).expect(201);
      const record = res.body as AdminInsuranceRecord;
      expect(record).toMatchObject({
        instructorId: ADA_INSTRUCTOR,
        kind: 'season_pass',
        seasonKey: '2026/27',
        listCents: 40000,
        amountCents: 39000,
        coverage: null,
        paymentStatus: 'unpaid',
        paidOn: null,
        paidNote: null,
        createdBy: INSURANCE_ADMIN_ID,
        recordNo: 'INS-20261015-0002',
      });
      expect(ctx.audit.entries).toEqual([
        {
          action: 'lesson_insurance.grant_season_pass',
          actor: { userId: INSURANCE_ADMIN_ID, role: 'admin', userAgent: null },
          targetType: 'lesson_insurance_record',
          targetId: record.id,
          metadata: {
            recordNo: 'INS-20261015-0002',
            instructorId: ADA_INSTRUCTOR,
            seasonKey: '2026/27',
            amountCents: 39000,
            note: 'paid up front',
            paidOn: null,
            paymentStatus: 'unpaid',
          },
        },
      ]);
      const passes = () =>
        [...ctx.repo.rows.values()].filter(
          (r) => r.instructor_id === ADA_INSTRUCTOR && r.kind === 'season_pass',
        );
      expect(passes()).toHaveLength(1);
      await grant(ADA_INSTRUCTOR).expect(409, {
        statusCode: 409,
        code: 'already_has_pass',
        message: ALREADY_HAS_PASS,
        owedCents: 40000,
      });
      expect(passes()).toHaveLength(1);
      expect(await mine()).toMatchObject({
        owedCents: 40000,
        coverage: 'season_pass',
      });
      const free = await seed(ADA_INSTRUCTOR, '2026-12-02', 2, 3);
      expect(ctx.repo.rows.get(free)).toMatchObject({
        amount_cents: 0,
        coverage: 'season_pass',
        payment_status: 'not_required',
      });
      expect(await summaryRow(ADA_INSTRUCTOR)).toMatchObject({
        coverage: 'season_pass',
        seasonPassRecordId: record.id,
        seasonPassPaymentStatus: 'unpaid',
      });
    });

    it('marks the pass paid in the same request when paidOn is given', async () => {
      const res = await grant(BO_INSTRUCTOR, {
        season: '2027/28',
        paidOn: '2026-10-14',
        note: 'e-transfer 9',
      }).expect(201);
      expect(res.body).toMatchObject({
        instructorId: BO_INSTRUCTOR,
        seasonKey: '2027/28',
        amountCents: 40000,
        paymentStatus: 'paid',
        paidOn: '2026-10-14',
        paidNote: 'e-transfer 9',
        paidBy: INSURANCE_ADMIN_ID,
      });
      expect(ctx.repo.grantCalls).toHaveLength(1);
      expect(ctx.repo.grantCalls[0]).toMatchObject({
        instructorId: BO_INSTRUCTOR,
        seasonKey: '2027/28',
        actor: INSURANCE_ADMIN_ID,
        paidOn: '2026-10-14',
        paidNote: 'e-transfer 9',
      });
      expect(ctx.audit.entries).toHaveLength(1);
      expect(ctx.audit.entries[0]).toMatchObject({
        action: 'lesson_insurance.grant_season_pass',
        metadata: {
          note: 'e-transfer 9',
          paidOn: '2026-10-14',
          paymentStatus: 'paid',
        },
      });
      expect(
        [...ctx.repo.rows.values()].filter((r) => r.kind === 'season_pass'),
      ).toHaveLength(1);
      expect(await summaryRow(BO_INSTRUCTOR, '2027/28')).toMatchObject({
        coverage: 'season_pass',
        seasonPassRecordId: (res.body as AdminInsuranceRecord).id,
        seasonPassPaymentStatus: 'paid',
      });
    });

    it('leaves no pass when the paid grant fails, and a retry creates exactly one paid pass', async () => {
      await seed(BO_INSTRUCTOR, '2026-12-01', 1, 1);
      const before = await summaryRow(BO_INSTRUCTOR);
      ctx.repo.grantFaultAfterInsert = new Error('connection reset');
      await grant(BO_INSTRUCTOR, {
        paidOn: '2026-10-14',
        note: 'e-transfer 9',
      }).expect(500);
      const passes = () =>
        [...ctx.repo.rows.values()].filter(
          (r) => r.instructor_id === BO_INSTRUCTOR && r.kind === 'season_pass',
        );
      expect(passes()).toHaveLength(0);
      expect(ctx.audit.entries).toEqual([]);
      expect(await summaryRow(BO_INSTRUCTOR)).toEqual(before);

      ctx.repo.grantFaultAfterInsert = null;
      const res = await grant(BO_INSTRUCTOR, {
        paidOn: '2026-10-14',
        note: 'e-transfer 9',
      }).expect(201);
      expect(res.body).toMatchObject({
        amountCents: 39000,
        paymentStatus: 'paid',
        paidOn: '2026-10-14',
        paidNote: 'e-transfer 9',
        paidBy: INSURANCE_ADMIN_ID,
        recordNo: 'INS-20261015-0002',
      });
      expect(passes()).toHaveLength(1);
      expect(ctx.audit.entries.map((e) => e.action)).toEqual([
        'lesson_insurance.grant_season_pass',
      ]);
      expect(await summaryRow(BO_INSTRUCTOR)).toMatchObject({
        seasonPassRecordId: (res.body as AdminInsuranceRecord).id,
        seasonPassPaymentStatus: 'paid',
      });
    });

    it('voiding the pass makes the next lesson charged again', async () => {
      const { id: passId } = (await grant(ADA_INSTRUCTOR).expect(201))
        .body as AdminInsuranceRecord;
      await post(`${passId}/void`, { reason: 'granted by mistake' }).expect(
        200,
      );
      expect(await summaryRow(ADA_INSTRUCTOR)).toMatchObject({
        seasonPassRecordId: null,
        seasonPassPaymentStatus: null,
        coverage: 'none',
        records: 1,
      });
      const next = await seed(ADA_INSTRUCTOR, '2026-12-01', 1, 2);
      expect(ctx.repo.rows.get(next)).toMatchObject({
        amount_cents: 2000,
        coverage: 'per_lesson',
        payment_status: 'unpaid',
      });
      await grant(ADA_INSTRUCTOR).expect(201);
    });

    it('409s already_covered once the season is capped', async () => {
      for (const day of ['01', '02', '03', '04', '05']) {
        await seed(ADA_INSTRUCTOR, `2026-12-${day}`, 2, 4);
      }
      await grant(ADA_INSTRUCTOR).expect(409, {
        statusCode: 409,
        code: 'already_covered',
        message: ALREADY_COVERED,
        owedCents: 40000,
      });
      expect(ctx.audit.entries).toEqual([]);
    });

    it('404s an unknown instructor, 409s one not approved, and 400s a bad id, season or date', async () => {
      await grant(randomUUID()).expect(404, {
        statusCode: 404,
        message: INSTRUCTOR_NOT_FOUND,
        error: 'Not Found',
      });
      for (const approval of ['pending', 'rejected'] as const) {
        ctx.repo.instructors.get(CAROL_INSTRUCTOR)!.approval_status = approval;
        await grant(CAROL_INSTRUCTOR).expect(409, {
          statusCode: 409,
          code: 'not_approved',
          message: INSTRUCTOR_NOT_APPROVED,
        });
      }
      await grant('not-a-uuid').expect(400);
      await grant(ADA_INSTRUCTOR, { season: '2099/00' }).expect(400);
      await grant(ADA_INSTRUCTOR, { season: 'bad' }).expect(400);
      await grant(ADA_INSTRUCTOR, { paidOn: '2026-13-01' }).expect(400);
      await grant(ADA_INSTRUCTOR, { idempotencyKey: randomUUID() }).expect(400);
      expect(ctx.repo.rows.size).toBe(0);
      await ctx.app.close();
      ctx = await build(new InMemorySeasonsRepository([]));
      await grant(ADA_INSTRUCTOR).expect(400, {
        statusCode: 400,
        message: NO_CURRENT_SEASON,
        error: 'Bad Request',
      });
    });
  });

  describe('mark paid / unpaid', () => {
    it('marks an unpaid record paid on today in Toronto by default, audits it, and only from unpaid', async () => {
      const id = await seed(ADA_INSTRUCTOR, '2026-12-01', 1, 2);
      const res = await post(`${id}/mark-paid`, {
        note: ' e-transfer 123 ',
      }).expect(200);
      expect(res.body).toMatchObject({
        id,
        paymentStatus: 'paid',
        paidOn: '2026-10-15',
        paidNote: 'e-transfer 123',
        paidBy: INSURANCE_ADMIN_ID,
      });
      expect(ctx.audit.entries).toEqual([
        {
          action: 'lesson_insurance.mark_paid',
          actor: { userId: INSURANCE_ADMIN_ID, role: 'admin', userAgent: null },
          targetType: 'lesson_insurance_record',
          targetId: id,
          metadata: {
            recordNo: 'INS-20261015-0001',
            instructorId: ADA_INSTRUCTOR,
            seasonKey: '2026/27',
            amountCents: 2000,
            from: 'unpaid',
            to: 'paid',
            paidOn: '2026-10-15',
            note: 'e-transfer 123',
          },
        },
      ]);
      await post(`${id}/mark-paid`).expect(409, {
        statusCode: 409,
        message: MARK_PAID_NEEDS_UNPAID,
        error: 'Conflict',
      });
      const mineNow = await mine();
      expect(mineNow).toMatchObject({ paidCents: 2000, unpaidCents: 0 });
      expect(mineNow.records[0]).not.toHaveProperty('paidNote');
      expect(mineNow.records[0]).not.toHaveProperty('paidBy');
      expect(mineNow.records[0].paidOn).toBe('2026-10-15');
    });

    it('marks a paid record unpaid again, clearing the payment, and only from paid', async () => {
      const id = await seed(ADA_INSTRUCTOR, '2026-12-01', 1, 1);
      await post(`${id}/mark-unpaid`).expect(409, {
        statusCode: 409,
        message: MARK_UNPAID_NEEDS_PAID,
        error: 'Conflict',
      });
      await post(`${id}/mark-paid`, { paidOn: '2026-10-01' }).expect(200);
      const res = await post(`${id}/mark-unpaid`).expect(200);
      expect(res.body).toMatchObject({
        paymentStatus: 'unpaid',
        paidOn: null,
        paidNote: null,
        paidBy: null,
      });
      expect(ctx.audit.entries.map((e) => e.action)).toEqual([
        'lesson_insurance.mark_paid',
        'lesson_insurance.mark_unpaid',
      ]);
    });

    it('refuses free records, unknown ids, bad ids and bad dates', async () => {
      for (const day of ['01', '02', '03', '04', '05']) {
        await seed(ADA_INSTRUCTOR, `2026-12-${day}`, 2, 4);
      }
      const free = await seed(ADA_INSTRUCTOR, '2026-12-06', 1, 1);
      expect(ctx.repo.rows.get(free)?.payment_status).toBe('not_required');
      await post(`${free}/mark-paid`).expect(409);
      await post(`${randomUUID()}/mark-paid`).expect(404);
      await post('not-a-uuid/mark-paid').expect(400);
      await post(`${free}/mark-paid`, { paidOn: '15/10/2026' }).expect(400);
      await post(`${free}/mark-paid`, { note: 'x'.repeat(501) }).expect(400);
    });

    it('409s when the record changed between the read and the write', async () => {
      const id = await seed(ADA_INSTRUCTOR, '2026-12-01', 1, 1);
      jest.spyOn(ctx.repo, 'updateIfStatus').mockResolvedValueOnce(null);
      await post(`${id}/mark-paid`).expect(409);
      expect(ctx.audit.entries).toHaveLength(0);
    });

    it('can be called by a system actor, such as a future email matcher', async () => {
      const id = await seed(ADA_INSTRUCTOR, '2026-12-01', 1, 1);
      const record = await ctx.admin.markPaid(
        id,
        { paidOn: '2026-10-12', note: 'matched e-transfer' },
        { userId: null, role: 'system' },
      );
      expect(record).toMatchObject({ paymentStatus: 'paid', paidBy: null });
      expect(ctx.audit.entries[0].actor).toEqual({
        userId: null,
        role: 'system',
      });
    });
  });

  describe('void', () => {
    it('voids from any status, keeps where it came from, audits it, and leaves the total', async () => {
      const paid = await seed(ADA_INSTRUCTOR, '2026-12-01', 2, 4);
      await post(`${paid}/mark-paid`, { note: 'e-transfer' }).expect(200);
      for (const day of ['02', '03', '04', '05']) {
        await seed(ADA_INSTRUCTOR, `2026-12-${day}`, 2, 4);
      }
      const free = await seed(ADA_INSTRUCTOR, '2026-12-06', 1, 1);
      expect((await mine()).owedCents).toBe(40000);

      const res = await post(`${paid}/void`, { reason: ' duplicate ' }).expect(
        200,
      );
      expect(res.body).toMatchObject({
        paymentStatus: 'voided',
        voidedReason: 'duplicate',
        voidedBy: INSURANCE_ADMIN_ID,
        voidedFromStatus: 'paid',
        voidedAt: expect.any(String) as unknown,
        paidOn: '2026-10-15',
        paidNote: 'e-transfer',
        paidBy: INSURANCE_ADMIN_ID,
      });
      expect(ctx.audit.entries.at(-1)).toMatchObject({
        action: 'lesson_insurance.void',
        targetId: paid,
        metadata: { from: 'paid', to: 'voided', reason: 'duplicate' },
      });
      const after = await mine();
      expect(after).toMatchObject({
        owedCents: 32000,
        paidCents: 0,
        coverage: 'none',
      });
      expect(after.records.find((r) => r.id === paid)?.paymentStatus).toBe(
        'voided',
      );
      expect(
        after.records.find((r) => r.id === free) as InsuranceRecord,
      ).toMatchObject({ amountCents: 0, coverage: 'capped' });
      expect(after.records[0]).not.toHaveProperty('voidedReason');

      await post(`${free}/void`, { reason: 'test' }).expect(200);
      expect(ctx.repo.rows.get(free)?.voided_from_status).toBe('not_required');
      const unpaid = await seed(ADA_INSTRUCTOR, '2026-12-07', 1, 1);
      const voidedUnpaid = await post(`${unpaid}/void`, {
        reason: 'test',
      }).expect(200);
      expect(voidedUnpaid.body).toMatchObject({
        paymentStatus: 'voided',
        voidedFromStatus: 'unpaid',
        paidOn: null,
        paidNote: null,
        paidBy: null,
      });
      await post(`${paid}/void`, { reason: 'again' }).expect(409, {
        statusCode: 409,
        message: ALREADY_VOIDED,
        error: 'Conflict',
      });
    });

    it('needs a reason of at most 500 characters and a known record', async () => {
      const id = await seed(ADA_INSTRUCTOR, '2026-12-01', 1, 1);
      await post(`${id}/void`).expect(400);
      await post(`${id}/void`, { reason: '   ' }).expect(400);
      await post(`${id}/void`, { reason: 'x'.repeat(501) }).expect(400);
      await post(`${randomUUID()}/void`, { reason: 'x' }).expect(404);
      jest.spyOn(ctx.repo, 'updateIfStatus').mockResolvedValueOnce(null);
      await post(`${id}/void`, { reason: 'x' }).expect(409, {
        statusCode: 409,
        message: RECORD_CHANGED,
        error: 'Conflict',
      });
      expect(ctx.repo.rows.get(id)?.payment_status).toBe('unpaid');
    });
  });
});
