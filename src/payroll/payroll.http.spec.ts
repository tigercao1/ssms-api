import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH as admin,
  ADMIN_ID,
  INSTRUCTOR_AUTH,
  startAdminApp,
} from '../../test/helpers/admin-http';
import {
  ADA_ID,
  BO_ID,
  GROUP_60,
  InMemoryPayrollRepository,
} from '../../test/helpers/payroll-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { PayrollController } from './payroll.controller';
import { PayrollRepository } from './payroll.repository';
import {
  ADJUSTMENT_NOT_FOUND,
  ANCHOR_HAS_ADJUSTMENTS,
  INSTRUCTOR_NOT_FOUND,
  PAYROLL_CLOCK,
  PERIOD_FINALIZED,
  PERIOD_NEEDS_RATE,
  PERIOD_NOT_FINALIZED,
  PERIOD_NOT_FOUND,
  PayrollService,
  SETTINGS_LOCKED,
  type PayrollAdjustment,
  type PayrollPeriod,
  type PayrollPeriodDetail,
} from './payroll.service';

const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';

async function build(now = '2026-01-07T17:00:00Z') {
  const repo = new InMemoryPayrollRepository();
  const audit = recordingAudit();
  const app = await startAdminApp(
    Test.createTestingModule({
      controllers: [PayrollController],
      providers: [
        PayrollService,
        { provide: PayrollRepository, useValue: repo },
        { provide: AuditService, useValue: audit },
        { provide: PAYROLL_CLOCK, useValue: () => new Date(now) },
      ],
    }),
  );
  return { app, repo, audit };
}

describe('payroll admin HTTP', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());
  const get = (path: string) => http().get(path).set('Authorization', admin);
  const post = (path: string, body: object = {}) =>
    http().post(path).set('Authorization', admin).send(body);

  const periodsAround = async (around?: string) =>
    (
      await get(
        `/admin/payroll/periods${around ? `?around=${around}` : ''}`,
      ).expect(200)
    ).body as PayrollPeriod[];

  const periodFor = async (date: string) => {
    const periods = await periodsAround(date);
    const period = periods.find((p) => p.startsOn <= date && date <= p.endsOn);
    if (!period) throw new Error(`no period for ${date}`);
    return period;
  };

  const detailFor = async (date: string) => {
    const period = await periodFor(date);
    return (await get(`/admin/payroll/periods/${period.id}`).expect(200))
      .body as PayrollPeriodDetail;
  };

  afterEach(async () => {
    await ctx.app.close();
  });

  describe('auth', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const id = UNKNOWN_ID;
    const routes: [string, (r: ReturnType<typeof http>) => request.Test][] = [
      ['GET settings', (r) => r.get('/admin/payroll/settings')],
      [
        'PUT settings',
        (r) =>
          r.put('/admin/payroll/settings').send({ anchorDate: '2025-12-15' }),
      ],
      ['GET periods', (r) => r.get('/admin/payroll/periods')],
      ['GET period', (r) => r.get(`/admin/payroll/periods/${id}`)],
      ['GET export', (r) => r.get(`/admin/payroll/periods/${id}/export.csv`)],
      [
        'POST adjustment',
        (r) => r.post(`/admin/payroll/periods/${id}/adjustments`).send({}),
      ],
      [
        'DELETE adjustment',
        (r) => r.delete(`/admin/payroll/periods/${id}/adjustments/${id}`),
      ],
      ['POST finalize', (r) => r.post(`/admin/payroll/periods/${id}/finalize`)],
      ['POST reopen', (r) => r.post(`/admin/payroll/periods/${id}/reopen`)],
    ];

    it.each(routes)('%s → 401 without a token', async (_name, send) => {
      await send(http()).expect(401);
    });

    it.each(routes)('%s → 403 for a non-admin', async (_name, send) => {
      await send(http()).set('Authorization', INSTRUCTOR_AUTH).expect(403);
    });
  });

  describe('periods', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('lists 14-day periods from the anchor and marks today’s period current', async () => {
      const periods = await periodsAround();
      expect(
        periods.map((p) => [p.startsOn, p.endsOn, p.status, p.isCurrent]),
      ).toEqual([
        ['2025-12-01', '2025-12-14', 'open', false],
        ['2025-12-15', '2025-12-28', 'open', false],
        ['2025-12-29', '2026-01-11', 'open', true],
        ['2026-01-12', '2026-01-25', 'open', false],
        ['2026-01-26', '2026-02-08', 'open', false],
      ]);
    });

    it('creates the period rows once and reuses them', async () => {
      const first = await periodsAround('2026-03-01');
      const again = await periodsAround('2026-03-01');
      expect(again.map((p) => p.id)).toEqual(first.map((p) => p.id));
      expect(ctx.repo.periods).toHaveLength(5);
      expect(first[2]).toMatchObject({
        startsOn: '2026-02-23',
        endsOn: '2026-03-08',
      });
    });

    it('rejects a malformed date and an unknown period', async () => {
      await get('/admin/payroll/periods?around=2026-02-30').expect(400);
      await get('/admin/payroll/periods/not-a-uuid').expect(400);
      const res = await get(`/admin/payroll/periods/${UNKNOWN_ID}`).expect(404);
      expect(res.body).toMatchObject({ message: PERIOD_NOT_FOUND });
    });
  });

  describe('settings', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('defaults the anchor to 2025-12-15 and moves it with an audit row', async () => {
      await expect(
        get('/admin/payroll/settings').then((r) => r.body as object),
      ).resolves.toEqual({
        anchorDate: '2025-12-15',
        periodDays: 14,
        locked: false,
      });
      const res = await http()
        .put('/admin/payroll/settings')
        .set('Authorization', admin)
        .send({ anchorDate: '2025-12-22' })
        .expect(200);
      expect(res.body).toMatchObject({ anchorDate: '2025-12-22' });
      expect((await periodsAround('2026-01-07'))[2]).toMatchObject({
        startsOn: '2026-01-05',
        endsOn: '2026-01-18',
      });
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: 'payroll.settings_update',
          targetType: 'payroll_settings',
          metadata: {
            before: { anchorDate: '2025-12-15' },
            after: { anchorDate: '2025-12-22' },
          },
        }),
      ]);
    });

    it('is refused once a period is finalized', async () => {
      const period = await periodFor('2026-01-07');
      await post(`/admin/payroll/periods/${period.id}/finalize`).expect(200);
      expect(
        (await get('/admin/payroll/settings').expect(200)).body,
      ).toMatchObject({ locked: true });
      const res = await http()
        .put('/admin/payroll/settings')
        .set('Authorization', admin)
        .send({ anchorDate: '2025-12-22' })
        .expect(409);
      expect(res.body).toMatchObject({ message: SETTINGS_LOCKED });
    });

    it('is refused while an adjustment sits in a period the new anchor would drop', async () => {
      const period = await periodFor('2026-01-07');
      await post(`/admin/payroll/periods/${period.id}/adjustments`, {
        instructorId: ADA_ID,
        description: 'Bonus',
        amount: 10,
      }).expect(201);
      const res = await http()
        .put('/admin/payroll/settings')
        .set('Authorization', admin)
        .send({ anchorDate: '2025-12-22' })
        .expect(409);
      expect(res.body).toMatchObject({ message: ANCHOR_HAS_ADJUSTMENTS });
      await http()
        .put('/admin/payroll/settings')
        .set('Authorization', admin)
        .send({ anchorDate: '2025-11-17' })
        .expect(200);
    });

    it('validates the anchor date', async () => {
      await http()
        .put('/admin/payroll/settings')
        .set('Authorization', admin)
        .send({ anchorDate: '15/12/2025' })
        .expect(400);
    });
  });

  describe('pay rule and money', () => {
    beforeEach(async () => {
      ctx = await build();
      ctx.repo.addRate({ hourlyRate: 37.33, from: '2025-01-01' });
    });

    it('pays completed, no-show and scheduled lessons and skips cancelled ones', async () => {
      ctx.repo.addClass({ startsAt: '2026-01-02T15:00:00Z' });
      ctx.repo.addClass({
        startsAt: '2026-01-03T15:00:00Z',
        status: 'no_show',
      });
      ctx.repo.addClass({
        startsAt: '2026-01-10T15:00:00Z',
        status: 'scheduled',
      });
      ctx.repo.addClass({
        startsAt: '2026-01-04T15:00:00Z',
        status: 'cancelled',
      });
      const detail = await detailFor('2026-01-07');
      expect(detail.lines.map((l) => [l.classStatus, l.amount])).toEqual([
        ['completed', 56],
        ['no_show', 56],
        ['scheduled', 56],
      ]);
      expect(detail.instructors).toEqual([
        expect.objectContaining({
          instructorId: ADA_ID,
          instructorName: 'Ada Lin',
          instructorNameZh: '林艾达',
          email: 'ada@example.com',
          lessons: 3,
          minutes: 270,
          lessonAmount: 168,
          total: 168,
          needsRate: 0,
        }),
      ]);
      expect(detail.lines.every((l) => !l.flags.includes('unconfirmed'))).toBe(
        true,
      );
    });

    it('pays a daily rate once per lesson whatever its length', async () => {
      ctx.repo.addRate({
        lessonTypeId: GROUP_60,
        hourlyRate: 400,
        rateUnit: 'day',
        from: '2025-01-01',
      });
      for (const [day, minutes] of [
        ['02', 30],
        ['03', 90],
        ['04', 480],
      ] as const) {
        ctx.repo.addClass({
          startsAt: `2026-01-${day}T15:00:00Z`,
          lessonTypeId: GROUP_60,
          minutes,
        });
      }
      const detail = await detailFor('2026-01-07');
      expect(
        detail.lines.map((l) => [
          l.minutes,
          l.hourlyRate,
          l.rateUnit,
          l.amount,
        ]),
      ).toEqual([
        [30, 400, 'day', 400],
        [90, 400, 'day', 400],
        [480, 400, 'day', 400],
      ]);
      expect(detail.instructors[0]).toMatchObject({
        lessons: 3,
        minutes: 600,
        total: 1200,
      });
    });

    it('prices a 90-minute lesson as rate × 1.5 rounded to cents', async () => {
      ctx.repo.addClass({
        startsAt: '2026-01-02T15:00:00Z',
        customers: [
          ['Kai', 'Wong'],
          ['米', null],
        ],
      });
      const [line] = (await detailFor('2026-01-07')).lines;
      expect(line).toMatchObject({
        minutes: 90,
        hourlyRate: 37.33,
        rateUnit: 'hour',
        amount: 56,
        currency: 'CAD',
        flags: [],
        date: '2026-01-02',
        time: '10:00',
        description: 'Private 90',
        lessonTypeNameZh: '私教90分钟',
        customerNames: ['Kai Wong', '米'],
      });
    });

    it('applies a rate change on its effective date inside the period', async () => {
      ctx.repo.rates = [];
      ctx.repo.addRate({
        hourlyRate: 40,
        from: '2025-01-01',
        to: '2026-01-04',
      });
      ctx.repo.addRate({ hourlyRate: 45.5, from: '2026-01-05' });
      ctx.repo.addClass({ startsAt: '2026-01-05T04:30:00Z', minutes: 60 });
      ctx.repo.addClass({ startsAt: '2026-01-05T05:30:00Z', minutes: 60 });
      const detail = await detailFor('2026-01-07');
      expect(detail.lines.map((l) => [l.date, l.hourlyRate, l.amount])).toEqual(
        [
          ['2026-01-04', 40, 40],
          ['2026-01-05', 45.5, 45.5],
        ],
      );
      expect(detail.totals).toEqual([
        { currency: 'CAD', lessons: 2, minutes: 120, amount: 85.5 },
      ]);
    });

    it('prefers the instructor override over the default rate', async () => {
      ctx.repo.addRate({
        instructorId: BO_ID,
        hourlyRate: 50,
        from: '2025-06-01',
      });
      ctx.repo.addClass({ startsAt: '2026-01-02T15:00:00Z' });
      ctx.repo.addClass({
        instructorId: BO_ID,
        startsAt: '2026-01-02T18:00:00Z',
      });
      const detail = await detailFor('2026-01-07');
      expect(
        detail.instructors.map((t) => [t.instructorName, t.total]),
      ).toEqual([
        ['Ada Lin', 56],
        ['Bo Chen', 75],
      ]);
    });

    it('flags lessons without a lesson type or rate as needs rate with amount 0', async () => {
      ctx.repo.addClass({
        startsAt: '2026-01-02T15:00:00Z',
        lessonTypeId: null,
      });
      ctx.repo.addClass({
        startsAt: '2026-01-03T15:00:00Z',
        lessonTypeId: GROUP_60,
        minutes: 60,
      });
      ctx.repo.addClass({ startsAt: '2026-01-04T15:00:00Z' });
      const detail = await detailFor('2026-01-07');
      expect(detail.lines.map((l) => [l.amount, l.flags])).toEqual([
        [0, ['needs_rate']],
        [0, ['needs_rate']],
        [56, []],
      ]);
      expect(detail.needsRateCount).toBe(2);
      expect(detail.instructors[0]).toMatchObject({ total: 56, needsRate: 2 });
    });

    it('sums many odd-cent lessons without drifting', async () => {
      ctx.repo.rates = [];
      ctx.repo.addRate({ hourlyRate: 33.33, from: '2025-01-01' });
      for (let day = 0; day < 10; day++) {
        ctx.repo.addClass({
          startsAt: `2026-01-0${(day % 9) + 1}T1${day}:00:00Z`,
          minutes: 50,
        });
      }
      const detail = await detailFor('2026-01-07');
      expect(detail.lines).toHaveLength(10);
      expect(detail.lines.every((l) => l.amount === 27.78)).toBe(true);
      expect(detail.instructors[0].total).toBe(277.8);
    });

    it('uses Toronto dates for period edges across both DST changes', async () => {
      ctx.repo.addClass({ startsAt: '2026-03-09T03:00:00Z', minutes: 60 });
      ctx.repo.addClass({ startsAt: '2026-03-09T04:00:00Z', minutes: 60 });
      ctx.repo.addClass({ startsAt: '2026-11-02T04:30:00Z', minutes: 60 });
      ctx.repo.addClass({ startsAt: '2026-11-02T05:00:00Z', minutes: 60 });
      ctx.repo.addClass({ startsAt: '2026-11-01T05:30:00Z', minutes: 60 });
      const spring = await detailFor('2026-03-08');
      expect(spring.period).toMatchObject({
        startsOn: '2026-02-23',
        endsOn: '2026-03-08',
      });
      expect(spring.lines.map((l) => [l.date, l.time])).toEqual([
        ['2026-03-08', '23:00'],
      ]);
      const fall = await detailFor('2026-11-01');
      expect(fall.period).toMatchObject({
        startsOn: '2026-10-19',
        endsOn: '2026-11-01',
      });
      expect(fall.lines.map((l) => [l.date, l.time, l.minutes])).toEqual([
        ['2026-11-01', '01:30', 60],
        ['2026-11-01', '23:30', 60],
      ]);
      const next = await detailFor('2026-11-02');
      expect(next.lines.map((l) => [l.date, l.time])).toEqual([
        ['2026-11-02', '00:00'],
      ]);
    });
  });

  describe('adjustments', () => {
    let period: PayrollPeriod;
    beforeEach(async () => {
      ctx = await build();
      ctx.repo.addRate({ hourlyRate: 40, from: '2025-01-01' });
      ctx.repo.addClass({ startsAt: '2026-01-02T15:00:00Z' });
      period = await periodFor('2026-01-07');
    });

    const add = (body: object) =>
      post(`/admin/payroll/periods/${period.id}/adjustments`, body);

    it('adds negative and positive adjustments into the totals and audits them', async () => {
      const bonus = (
        await add({
          instructorId: BO_ID,
          description: ' Training day ',
          amount: 80,
        }).expect(201)
      ).body as PayrollAdjustment;
      expect(bonus).toMatchObject({
        instructorId: BO_ID,
        description: 'Training day',
        amount: 80,
        currency: 'CAD',
      });
      await add({
        instructorId: ADA_ID,
        description: 'Advance',
        amount: -12.5,
      }).expect(201);
      const detail = (
        await get(`/admin/payroll/periods/${period.id}`).expect(200)
      ).body as PayrollPeriodDetail;
      expect(
        detail.instructors.map((t) => [
          t.instructorName,
          t.lessonAmount,
          t.adjustmentAmount,
          t.total,
        ]),
      ).toEqual([
        ['Ada Lin', 60, -12.5, 47.5],
        ['Bo Chen', 0, 80, 80],
      ]);
      expect(detail.adjustments).toHaveLength(2);
      expect(ctx.audit.entries.map((e) => [e.action, e.targetId])).toEqual([
        ['payroll.adjustment_create', period.id],
        ['payroll.adjustment_create', period.id],
      ]);
    });

    it('deletes an adjustment and audits it', async () => {
      const created = (
        await add({ instructorId: ADA_ID, description: 'x', amount: 5 }).expect(
          201,
        )
      ).body as PayrollAdjustment;
      await http()
        .delete(`/admin/payroll/periods/${period.id}/adjustments/${created.id}`)
        .set('Authorization', admin)
        .expect(204);
      const missing = await http()
        .delete(`/admin/payroll/periods/${period.id}/adjustments/${created.id}`)
        .set('Authorization', admin)
        .expect(404);
      expect(missing.body).toMatchObject({ message: ADJUSTMENT_NOT_FOUND });
      expect(ctx.audit.entries.map((e) => e.action)).toEqual([
        'payroll.adjustment_create',
        'payroll.adjustment_delete',
      ]);
    });

    it('validates the body and the instructor', async () => {
      await add({ instructorId: ADA_ID, description: 'x', amount: 0 }).expect(
        400,
      );
      await add({ instructorId: ADA_ID, description: '  ', amount: 1 }).expect(
        400,
      );
      await add({
        instructorId: ADA_ID,
        description: 'x',
        amount: 1.005,
      }).expect(400);
      const res = await add({
        instructorId: UNKNOWN_ID,
        description: 'x',
        amount: 1,
      }).expect(400);
      expect(res.body).toMatchObject({ message: INSTRUCTOR_NOT_FOUND });
    });

    it('is refused on a finalized period', async () => {
      const created = (
        await add({ instructorId: ADA_ID, description: 'x', amount: 5 }).expect(
          201,
        )
      ).body as PayrollAdjustment;
      await post(`/admin/payroll/periods/${period.id}/finalize`).expect(200);
      const res = await add({
        instructorId: ADA_ID,
        description: 'late',
        amount: 5,
      }).expect(409);
      expect(res.body).toMatchObject({ message: PERIOD_FINALIZED });
      await http()
        .delete(`/admin/payroll/periods/${period.id}/adjustments/${created.id}`)
        .set('Authorization', admin)
        .expect(409);
    });
  });

  describe('finalize and reopen', () => {
    let period: PayrollPeriod;
    beforeEach(async () => {
      ctx = await build();
      ctx.repo.addRate({ hourlyRate: 40, from: '2025-01-01' });
      ctx.repo.addClass({ startsAt: '2026-01-02T15:00:00Z' });
      period = await periodFor('2026-01-07');
    });

    it('freezes the lines so later rate and class edits do not move a finalized period', async () => {
      const res = await post(
        `/admin/payroll/periods/${period.id}/finalize`,
      ).expect(200);
      const frozen = res.body as PayrollPeriodDetail;
      expect(frozen.period).toMatchObject({ status: 'finalized' });
      expect(frozen.lines).toEqual([
        expect.objectContaining({ amount: 60, hourlyRate: 40, minutes: 90 }),
      ]);
      ctx.repo.rates[0].hourly_rate = 99;
      ctx.repo.classes[0].status = 'cancelled';
      ctx.repo.addClass({ startsAt: '2026-01-03T15:00:00Z' });
      const after = (
        await get(`/admin/payroll/periods/${period.id}`).expect(200)
      ).body as PayrollPeriodDetail;
      expect(after.lines.map((l) => [l.amount, l.date, l.time])).toEqual([
        [60, '2026-01-02', '10:00'],
      ]);
      expect(after.instructors[0]).toMatchObject({
        instructorName: 'Ada Lin',
        total: 60,
      });
      expect(after.lines[0].lessonTypeNameZh).toBe('私教90分钟');
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: 'payroll.finalize',
          targetType: 'payroll_period',
          targetId: period.id,
          actor: expect.objectContaining({ userId: ADMIN_ID }) as unknown,
          metadata: expect.objectContaining({
            lines: 1,
            needsRateCount: 0,
          }) as unknown,
        }),
      ]);
    });

    it('stores the rate unit with each line and keeps it after the rate changes', async () => {
      ctx.repo.addRate({
        lessonTypeId: GROUP_60,
        hourlyRate: 400,
        rateUnit: 'day',
        from: '2025-01-01',
      });
      ctx.repo.addClass({
        startsAt: '2026-01-03T15:00:00Z',
        lessonTypeId: GROUP_60,
        minutes: 300,
      });
      const frozen = (
        await post(`/admin/payroll/periods/${period.id}/finalize`).expect(200)
      ).body as PayrollPeriodDetail;
      expect(
        frozen.lines.map((l) => [
          l.hourlyRate,
          l.rateUnit,
          l.minutes,
          l.amount,
        ]),
      ).toEqual([
        [40, 'hour', 90, 60],
        [400, 'day', 300, 400],
      ]);
      expect(
        ctx.repo.lineRows
          .filter((l) => l.kind === 'class')
          .map((l) => [l.rate_unit, l.amount]),
      ).toEqual([
        ['hour', '60.00'],
        ['day', '400.00'],
      ]);
      ctx.repo.rates[1].rate_unit = 'hour';
      const after = (
        await get(`/admin/payroll/periods/${period.id}`).expect(200)
      ).body as PayrollPeriodDetail;
      expect(after.lines[1]).toMatchObject({ rateUnit: 'day', amount: 400 });
      expect(after.instructors[0]).toMatchObject({ total: 460 });
    });

    it('does not pay a class again after it moves out of a finalized period', async () => {
      await post(`/admin/payroll/periods/${period.id}/finalize`).expect(200);
      ctx.repo.classes[0].starts_at = '2026-01-13T15:00:00.000Z';
      ctx.repo.classes[0].ends_at = '2026-01-13T16:30:00.000Z';
      ctx.repo.addClass({ startsAt: '2026-01-14T15:00:00Z' });
      const next = await detailFor('2026-01-13');
      expect(next.lines.map((l) => [l.date, l.amount, l.flags])).toEqual([
        ['2026-01-13', 0, ['already_paid']],
        ['2026-01-14', 60, []],
      ]);
      expect(next.instructors[0]).toMatchObject({
        lessons: 1,
        minutes: 90,
        total: 60,
      });
      expect(next.needsRateCount).toBe(0);
    });

    it('recomputes live again after reopen and audits the reopen', async () => {
      await post(`/admin/payroll/periods/${period.id}/finalize`).expect(200);
      ctx.repo.rates[0].hourly_rate = 50;
      const reopened = (
        await post(`/admin/payroll/periods/${period.id}/reopen`).expect(200)
      ).body as PayrollPeriodDetail;
      expect(reopened.period.status).toBe('open');
      expect(reopened.lines[0].amount).toBe(75);
      expect(ctx.audit.entries.map((e) => e.action)).toEqual([
        'payroll.finalize',
        'payroll.reopen',
      ]);
    });

    it('refuses while lines need a rate unless zero rates are accepted', async () => {
      ctx.repo.addClass({
        startsAt: '2026-01-03T15:00:00Z',
        lessonTypeId: null,
      });
      const refused = await post(
        `/admin/payroll/periods/${period.id}/finalize`,
      ).expect(409);
      expect(refused.body).toMatchObject({
        message: PERIOD_NEEDS_RATE,
        needsRateCount: 1,
      });
      expect(ctx.audit.entries).toEqual([]);
      const accepted = (
        await post(`/admin/payroll/periods/${period.id}/finalize`, {
          acceptZeroRate: true,
        }).expect(200)
      ).body as PayrollPeriodDetail;
      expect(accepted.lines.map((l) => [l.amount, l.flags])).toEqual([
        [60, []],
        [0, ['needs_rate']],
      ]);
      expect(ctx.audit.entries[0].metadata).toMatchObject({
        acceptZeroRate: true,
        needsRateCount: 1,
      });
    });

    it('refuses to finalize twice, reopen an open period or touch an unknown one', async () => {
      await post(`/admin/payroll/periods/${period.id}/reopen`).expect(409, {
        statusCode: 409,
        message: PERIOD_NOT_FINALIZED,
        error: 'Conflict',
      });
      await post(`/admin/payroll/periods/${period.id}/finalize`).expect(200);
      await post(`/admin/payroll/periods/${period.id}/finalize`).expect(409);
      await post(`/admin/payroll/periods/${UNKNOWN_ID}/finalize`).expect(404);
      await post(`/admin/payroll/periods/${UNKNOWN_ID}/reopen`).expect(404);
      await post(`/admin/payroll/periods/${period.id}/finalize`, {
        acceptZeroRate: 'yes',
      }).expect(400);
    });
  });

  describe('export', () => {
    let period: PayrollPeriod;
    beforeEach(async () => {
      ctx = await build();
      ctx.repo.addRate({ hourlyRate: 40, from: '2025-01-01' });
      ctx.repo.addClass({
        startsAt: '2026-01-02T15:00:00Z',
        customers: [['=Kai', 'Wong, Jr']],
      });
      ctx.repo.addClass({
        instructorId: BO_ID,
        startsAt: '2026-01-03T15:00:00Z',
        lessonTypeId: null,
      });
      period = await periodFor('2026-01-07');
      await post(`/admin/payroll/periods/${period.id}/adjustments`, {
        instructorId: ADA_ID,
        description: 'Advance',
        amount: -12.5,
      }).expect(201);
    });

    it('downloads a payroll sheet with a BOM and Chinese names', async () => {
      const res = await get(
        `/admin/payroll/periods/${period.id}/export.csv`,
      ).expect(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="payroll-2025-12-29-to-2026-01-11.csv"',
      );
      expect(res.text.startsWith('\uFEFF')).toBe(true);
      expect(res.text.slice(1).split('\r\n')).toEqual([
        'Instructor,Instructor (中文),Email,Lessons,Hours,Rate unit,Amount,Currency',
        'Ada Lin,林艾达,ada@example.com,1,1.50,hour,47.50,CAD',
        'Bo Chen,,bo@example.com,1,1.50,,0.00,CAD',
        '',
      ]);
    });

    it('downloads detailed lines including adjustments', async () => {
      const res = await get(
        `/admin/payroll/periods/${period.id}/export.csv?detail=1`,
      ).expect(200);
      expect(res.headers['content-disposition']).toContain(
        'payroll-detail-2025-12-29-to-2026-01-11.csv',
      );
      expect(res.text.slice(1).split('\r\n')).toEqual([
        'Instructor,Date,Time,Type,Lesson type / description,Customers,Status,Minutes,Rate,Rate unit,Amount,Currency,Flags',
        `Ada Lin,2026-01-02,10:00,lesson,Private 90,"'=Kai Wong, Jr",completed,90,40.00,hour,60.00,CAD,`,
        'Bo Chen,2026-01-03,10:00,lesson,,,completed,90,,,0.00,CAD,needs_rate',
        'Ada Lin,,,adjustment,Advance,,,,,,-12.50,CAD,',
        '',
      ]);
      await get(
        `/admin/payroll/periods/${period.id}/export.csv?detail=yes`,
      ).expect(400);
    });

    it('labels daily and mixed rate units in both sheets', async () => {
      ctx.repo.addRate({
        lessonTypeId: GROUP_60,
        hourlyRate: 400,
        rateUnit: 'day',
        from: '2025-01-01',
      });
      ctx.repo.addClass({
        startsAt: '2026-01-05T15:00:00Z',
        lessonTypeId: GROUP_60,
        minutes: 240,
      });
      ctx.repo.addClass({
        instructorId: BO_ID,
        startsAt: '2026-01-06T15:00:00Z',
        lessonTypeId: GROUP_60,
        minutes: 60,
      });
      const sheet = await get(
        `/admin/payroll/periods/${period.id}/export.csv`,
      ).expect(200);
      expect(sheet.text.slice(1).split('\r\n')).toEqual([
        'Instructor,Instructor (中文),Email,Lessons,Hours,Rate unit,Amount,Currency',
        'Ada Lin,林艾达,ada@example.com,2,5.50,day; hour,447.50,CAD',
        'Bo Chen,,bo@example.com,2,2.50,day,400.00,CAD',
        '',
      ]);
      const detail = await get(
        `/admin/payroll/periods/${period.id}/export.csv?detail=1`,
      ).expect(200);
      expect(detail.text.slice(1).split('\r\n')).toEqual(
        expect.arrayContaining([
          'Ada Lin,2026-01-05,10:00,lesson,Group 60,,completed,240,400.00,day,400.00,CAD,',
          'Bo Chen,2026-01-06,10:00,lesson,Group 60,,completed,60,400.00,day,400.00,CAD,',
        ]),
      );
    });
  });
});
