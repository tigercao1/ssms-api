import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH,
  certificationUploadRow,
  INSTRUCTOR_AUTH,
  INSTRUCTOR_USER_ID,
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
  InMemoryDocumentTemplatesRepository,
  startDocumentsApp,
  UNVERIFIED_AUTH,
} from '../../test/helpers/documents-fakes';
import {
  ADA_ID,
  BO_ID,
  GROUP_60,
  InMemoryPayrollRepository,
} from '../../test/helpers/payroll-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import {
  seasonsProviders,
  seasonsRepo,
} from '../../test/helpers/seasons-fakes';
import { AuditService } from '../audit/audit.service';
import { DocumentAssignmentsRepository } from '../documents/document-assignments.repository';
import { DocumentSubjectsRepository } from '../documents/document-subjects.repository';
import { DocumentTemplatesRepository } from '../documents/document-templates.repository';
import { MeDocumentsService } from '../documents/me-documents.service';
import { MeLessonsController } from './me-lessons.controller';
import { MeLessonsService, type MyLessonsResponse } from './me-lessons.service';
import { addDays } from './payroll-time';
import { type ApprovalStatus, PayrollRepository } from './payroll.repository';
import { PAYROLL_CLOCK, PayrollService } from './payroll.service';

const NOW = '2026-01-20T17:00:00Z';
const ACTOR = { userId: null };

async function build(status: ApprovalStatus = 'approved', now = NOW) {
  const repo = new InMemoryPayrollRepository();
  repo.addInstructorUser(INSTRUCTOR_USER_ID, ADA_ID, status);
  const templates = new InMemoryDocumentTemplatesRepository();
  const subjects = new InMemoryDocumentSubjectsRepository();
  const assignments = new InMemoryDocumentAssignmentsRepository(
    templates,
    subjects,
  );
  const app = await startDocumentsApp(
    Test.createTestingModule({
      controllers: [MeLessonsController],
      providers: [
        MeLessonsService,
        PayrollService,
        MeDocumentsService,
        ...seasonsProviders(seasonsRepo('2025-26', '2026-27')),
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PayrollRepository, useValue: repo },
        { provide: DocumentTemplatesRepository, useValue: templates },
        { provide: DocumentAssignmentsRepository, useValue: assignments },
        { provide: DocumentSubjectsRepository, useValue: subjects },
        { provide: AuditService, useValue: recordingAudit() },
        { provide: PAYROLL_CLOCK, useValue: () => new Date(now) },
      ],
    }),
  );
  return {
    app,
    repo,
    templates,
    assignments,
    subjects,
    payroll: app.get(PayrollService),
  };
}

describe('GET /me/lessons', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());
  const mine = async () =>
    (
      await http()
        .get('/me/lessons')
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200)
    ).body as MyLessonsResponse;

  const finalize = async (date: string, acceptZeroRate = false) => {
    const [period] = await ctx.repo.ensurePeriods([
      { starts_on: date, ends_on: addDays(date, 13) },
    ]);
    await ctx.payroll.finalize(period.id, { acceptZeroRate }, ACTOR);
    return period;
  };

  afterEach(async () => {
    await ctx.app.close();
  });

  describe('auth', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('is 401 without a token', async () => {
      await http().get('/me/lessons').expect(401);
    });

    it('is 403 for an unverified email', async () => {
      await http()
        .get('/me/lessons')
        .set('Authorization', UNVERIFIED_AUTH)
        .expect(403);
    });

    it('is 404 without an instructor profile', async () => {
      await http()
        .get('/me/lessons')
        .set('Authorization', ADMIN_AUTH)
        .expect(404);
    });
  });

  describe('locks', () => {
    it('shows a pending instructor nothing and reads nothing but the profile', async () => {
      ctx = await build('pending');
      ctx.repo.addRate({ hourlyRate: 90, from: '2025-01-01' });
      ctx.repo.addClass({ startsAt: '2026-01-05T15:00:00Z' });
      ctx.repo.addClass({ startsAt: '2026-02-05T15:00:00Z' });
      const classes = jest.spyOn(ctx.repo, 'classesForInstructor');
      const lines = jest.spyOn(ctx.repo, 'linesForInstructor');
      await expect(mine()).resolves.toEqual({
        locked: true,
        lockReason: 'pending_approval',
        upcoming: { lessons: [], projected: [], needsRateCount: 0 },
        periods: [],
      });
      expect(classes).not.toHaveBeenCalled();
      expect(lines).not.toHaveBeenCalled();
    });

    it('shows a rejected instructor their past periods and no upcoming lessons', async () => {
      ctx = await build('rejected');
      ctx.repo.addRate({ hourlyRate: 90, from: '2025-01-01' });
      ctx.repo.addClass({ startsAt: '2026-01-05T15:00:00Z' });
      ctx.repo.addClass({ startsAt: '2026-01-15T15:00:00Z' });
      ctx.repo.addClass({ startsAt: '2026-02-05T15:00:00Z' });
      await finalize('2025-12-29');
      const body = await mine();
      expect(body).toMatchObject({
        locked: true,
        lockReason: 'rejected',
        upcoming: { lessons: [], projected: [], needsRateCount: 0 },
      });
      expect(
        body.periods.map((p) => [p.startsOn, p.status, p.lessons.length]),
      ).toEqual([
        ['2026-01-12', 'awaiting', 1],
        ['2025-12-29', 'paid', 1],
      ]);
    });
  });

  describe('onboarding', () => {
    const locked = {
      locked: true,
      lockReason: 'onboarding_incomplete',
      upcoming: { lessons: [], projected: [], needsRateCount: 0 },
      periods: [],
    };

    beforeEach(async () => {
      ctx = await build();
      ctx.repo.addRate({ hourlyRate: 90, from: '2025-01-01' });
      ctx.repo.addClass({ startsAt: '2026-01-05T15:00:00Z' });
      ctx.repo.addClass({ startsAt: '2026-02-05T15:00:00Z' });
    });

    const assign = (
      status: 'assigned' | 'completed' | 'archived',
      overrides: { required?: boolean; season?: string } = {},
    ) =>
      ctx.assignments.seed({
        template_id: ctx.templates.seed({ required: overrides.required }).id,
        subject_id: ADA_ID,
        status,
        ...(overrides.season ? { season: overrides.season } : {}),
      });

    const certify = (
      review_status?: 'approved' | 'pending' | 'rejected',
      valid_until = '2026-10-31',
    ) => {
      ctx.subjects.certifications.set(ADA_ID, [
        { org: 'csia', track: 'regular', level: 2 },
      ]);
      if (!review_status) return;
      ctx.subjects.uploads.push(
        certificationUploadRow({
          instructor_id: ADA_ID,
          review_status,
          valid_until,
        }),
      );
    };

    it('locks an approved instructor with a required document left and reads no lessons or pay', async () => {
      assign('completed');
      assign('assigned');
      const classes = jest.spyOn(ctx.repo, 'classesForInstructor');
      const lines = jest.spyOn(ctx.repo, 'linesForInstructor');
      await expect(mine()).resolves.toEqual(locked);
      expect(classes).not.toHaveBeenCalled();
      expect(lines).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', undefined, undefined],
      ['expired', 'approved', '2026-01-19'],
      ['rejected', 'rejected', '2026-10-31'],
      ['awaiting review', 'pending', '2026-10-31'],
    ] as const)(
      'locks an instructor whose certification is %s',
      async (_name, review, validUntil) => {
        certify(review, validUntil);
        await expect(mine()).resolves.toEqual(locked);
      },
    );

    it('unlocks once every required document is completed and every certification is satisfied', async () => {
      assign('completed');
      assign('assigned', { required: false });
      assign('assigned', { season: '2025-26' });
      assign('archived');
      certify('approved', '2026-10-31');
      const body = await mine();
      expect(body).toMatchObject({ locked: false, lockReason: null });
      expect(body.upcoming.lessons).toHaveLength(1);
      expect(body.periods).toHaveLength(1);
    });

    it('unlocks without the reload once the last document is completed', async () => {
      const last = assign('assigned');
      await expect(mine()).resolves.toEqual(locked);
      ctx.assignments.rows.set(last.id, {
        ...ctx.assignments.rows.get(last.id)!,
        status: 'completed',
      });
      await expect(mine()).resolves.toMatchObject({ locked: false });
    });

    it('keeps the rejected lock ahead of onboarding', async () => {
      await ctx.app.close();
      ctx = await build('rejected');
      assign('assigned');
      await expect(mine()).resolves.toMatchObject({
        locked: true,
        lockReason: 'rejected',
      });
    });
  });

  describe('approved', () => {
    beforeEach(async () => {
      ctx = await build();
      ctx.repo.addRate({ hourlyRate: 90, from: '2025-01-01' });
    });

    it('lists upcoming lessons with the projected pay in the contract shape', async () => {
      const cls = ctx.repo.addClass({
        startsAt: '2026-01-23T15:00:00Z',
        minutes: 120,
        status: 'scheduled',
        location: 'Moonstone',
        customers: [
          ['Wei', 'Zhang'],
          ['Amy', 'li'],
        ],
      });
      ctx.repo.addClass({
        instructorId: BO_ID,
        startsAt: '2026-01-24T15:00:00Z',
      });
      await expect(mine()).resolves.toEqual({
        locked: false,
        lockReason: null,
        upcoming: {
          lessons: [
            {
              classId: cls.id,
              date: '2026-01-23',
              startTime: '10:00',
              endTime: '12:00',
              startsAt: cls.starts_at,
              endsAt: cls.ends_at,
              status: 'scheduled',
              lessonTypeNameEn: 'Private 90',
              lessonTypeNameZh: '私教90分钟',
              locationName: 'Moonstone',
              students: ['Wei Z.', 'Amy L.'],
              minutes: 120,
              rate: 90,
              rateUnit: 'hour',
              currency: 'CAD',
              amount: 180,
              needsRate: false,
            },
          ],
          projected: [{ currency: 'CAD', amount: 180, lessons: 1 }],
          needsRateCount: 0,
        },
        periods: [],
      });
    });

    it('pays a daily rate once per upcoming lesson', async () => {
      ctx.repo.addRate({
        lessonTypeId: GROUP_60,
        hourlyRate: 400,
        rateUnit: 'day',
        from: '2025-01-01',
      });
      ctx.repo.addClass({
        startsAt: '2026-01-24T14:00:00Z',
        lessonTypeId: GROUP_60,
        minutes: 360,
      });
      ctx.repo.addClass({ startsAt: '2026-01-25T15:00:00Z', minutes: 60 });
      const { upcoming } = await mine();
      expect(
        upcoming.lessons.map((l) => [l.rate, l.rateUnit, l.minutes, l.amount]),
      ).toEqual([
        [400, 'day', 360, 400],
        [90, 'hour', 60, 90],
      ]);
      expect(upcoming.projected).toEqual([
        { currency: 'CAD', amount: 490, lessons: 2 },
      ]);
    });

    it('shows a lesson without a rate as needsRate with no amount and leaves it out of the projection', async () => {
      ctx.repo.addClass({ startsAt: '2026-01-23T15:00:00Z', minutes: 120 });
      ctx.repo.addClass({
        startsAt: '2026-01-24T15:00:00Z',
        lessonTypeId: GROUP_60,
      });
      ctx.repo.addClass({
        startsAt: '2026-01-25T15:00:00Z',
        lessonTypeId: null,
      });
      const { upcoming } = await mine();
      expect(
        upcoming.lessons.map((l) => [l.amount, l.rate, l.needsRate]),
      ).toEqual([
        [180, 90, false],
        [null, null, true],
        [null, null, true],
      ]);
      expect(upcoming.projected).toEqual([
        { currency: 'CAD', amount: 180, lessons: 1 },
      ]);
      expect(upcoming.needsRateCount).toBe(2);
    });

    it('projects a past period that is not finalized as awaiting', async () => {
      ctx.repo.addClass({ startsAt: '2026-01-13T15:00:00Z', minutes: 120 });
      ctx.repo.addClass({
        startsAt: '2026-01-14T15:00:00Z',
        lessonTypeId: null,
      });
      ctx.repo.addClass({ startsAt: '2026-01-21T15:00:00Z' });
      const { periods, upcoming } = await mine();
      expect(upcoming.lessons.map((l) => l.date)).toEqual(['2026-01-21']);
      expect(periods).toEqual([
        expect.objectContaining({
          startsOn: '2026-01-12',
          endsOn: '2026-01-25',
          status: 'awaiting',
          finalizedAt: null,
          adjustments: [],
          totals: [
            {
              currency: 'CAD',
              lessons: 2,
              minutes: 210,
              lessonAmount: 180,
              adjustmentAmount: 0,
              total: 180,
              needsRateCount: 1,
            },
          ],
        }),
      ]);
      expect(periods[0].lessons.map((l) => [l.date, l.amount])).toEqual([
        ['2026-01-13', 180],
        ['2026-01-14', null],
      ]);
      ctx.repo.rates[0].hourly_rate = 100;
      expect((await mine()).periods[0].totals[0].total).toBe(200);
    });

    it('reads a finalized period from the snapshot even after the rate and class change', async () => {
      const cls = ctx.repo.addClass({
        startsAt: '2026-01-05T15:00:00Z',
        minutes: 120,
        location: 'Moonstone',
        customers: [['Kai', 'Wong']],
      });
      ctx.repo.addClass({
        startsAt: '2026-01-06T15:00:00Z',
        lessonTypeId: null,
      });
      const period = await finalize('2025-12-29', true);
      ctx.repo.rates[0].hourly_rate = 120;
      ctx.repo.rates[0].rate_unit = 'day';
      cls.status = 'cancelled';
      cls.participants = [];
      ctx.repo.addClass({ startsAt: '2026-01-07T15:00:00Z' });
      const [paid] = (await mine()).periods;
      expect(paid).toMatchObject({
        startsOn: '2025-12-29',
        endsOn: '2026-01-11',
        status: 'paid',
        finalizedAt: ctx.repo.periods.find((p) => p.id === period.id)
          ?.finalized_at,
        totals: [
          expect.objectContaining({
            lessons: 2,
            total: 180,
            needsRateCount: 1,
          }),
        ],
      });
      expect(paid.lessons).toEqual([
        expect.objectContaining({
          classId: cls.id,
          status: 'completed',
          rate: 90,
          rateUnit: 'hour',
          minutes: 120,
          amount: 180,
          needsRate: false,
          locationName: 'Moonstone',
          students: ['Kai W.'],
          lessonTypeNameEn: 'Private 90',
          lessonTypeNameZh: '私教90分钟',
        }),
        expect.objectContaining({ amount: 0, rate: null, needsRate: true }),
      ]);
    });

    it('lists a class only in the period that paid it', async () => {
      const cls = ctx.repo.addClass({ startsAt: '2026-01-05T15:00:00Z' });
      await finalize('2025-12-29');
      cls.starts_at = '2026-01-13T15:00:00.000Z';
      cls.ends_at = '2026-01-13T16:30:00.000Z';
      ctx.repo.addClass({ startsAt: '2026-01-14T15:00:00Z' });
      const late = ctx.repo.addClass({ startsAt: '2026-01-30T15:00:00Z' });
      await finalize('2026-01-26');
      const { periods, upcoming } = await mine();
      expect(
        periods.map((p) => [
          p.startsOn,
          p.status,
          p.lessons.map((l) => l.date),
        ]),
      ).toEqual([
        ['2026-01-26', 'paid', ['2026-01-30']],
        ['2026-01-12', 'awaiting', ['2026-01-14']],
        ['2025-12-29', 'paid', ['2026-01-05']],
      ]);
      expect(upcoming.lessons.map((l) => l.classId)).not.toContain(late.id);
    });

    it('skips already-paid lines in a finalized period', async () => {
      const cls = ctx.repo.addClass({ startsAt: '2026-01-05T15:00:00Z' });
      await finalize('2025-12-29');
      cls.starts_at = '2026-01-13T15:00:00.000Z';
      cls.ends_at = '2026-01-13T16:30:00.000Z';
      ctx.repo.addClass({ startsAt: '2026-01-14T15:00:00Z' });
      await finalize('2026-01-12');
      const current = (await mine()).periods.find(
        (p) => p.startsOn === '2026-01-12',
      );
      expect(current?.lessons.map((l) => l.date)).toEqual(['2026-01-14']);
      expect(current?.totals).toEqual([
        expect.objectContaining({ lessons: 1, total: 135 }),
      ]);
    });

    it('shows adjustments in open and finalized periods', async () => {
      ctx.repo.addClass({ startsAt: '2026-01-05T15:00:00Z' });
      const [other, open] = await ctx.repo.ensurePeriods([
        { starts_on: '2026-01-12', ends_on: '2026-01-25' },
        { starts_on: '2025-12-29', ends_on: '2026-01-11' },
      ]);
      const travel = await ctx.payroll.addAdjustment(
        open.id,
        {
          instructorId: ADA_ID,
          description: 'Travel to Blue Mountain',
          amount: 40,
        },
        ACTOR,
      );
      await ctx.payroll.addAdjustment(
        open.id,
        { instructorId: BO_ID, description: 'Not mine', amount: 99 },
        ACTOR,
      );
      const advance = await ctx.payroll.addAdjustment(
        other.id,
        { instructorId: ADA_ID, description: 'Advance', amount: -12.5 },
        ACTOR,
      );
      await ctx.payroll.finalize(other.id, {}, ACTOR);
      const { periods } = await mine();
      expect(periods).toEqual([
        {
          startsOn: '2026-01-12',
          endsOn: '2026-01-25',
          status: 'awaiting',
          finalizedAt: null,
          lessons: [],
          adjustments: [
            {
              id: travel.id,
              description: 'Travel to Blue Mountain',
              amount: 40,
              currency: 'CAD',
            },
          ],
          totals: [
            {
              currency: 'CAD',
              lessons: 0,
              minutes: 0,
              lessonAmount: 0,
              adjustmentAmount: 40,
              total: 40,
              needsRateCount: 0,
            },
          ],
        },
        expect.objectContaining({
          startsOn: '2025-12-29',
          status: 'paid',
          adjustments: [
            {
              id: advance.id,
              description: 'Advance',
              amount: -12.5,
              currency: 'CAD',
            },
          ],
          totals: [
            expect.objectContaining({
              lessons: 1,
              lessonAmount: 135,
              adjustmentAmount: -12.5,
              total: 122.5,
            }),
          ],
        }),
      ]);
    });

    it('leaves cancelled lessons out', async () => {
      ctx.repo.addClass({
        startsAt: '2026-01-13T15:00:00Z',
        status: 'cancelled',
      });
      ctx.repo.addClass({
        startsAt: '2026-01-23T15:00:00Z',
        status: 'cancelled',
      });
      ctx.repo.addClass({
        startsAt: '2026-01-14T15:00:00Z',
        status: 'no_show',
      });
      const { periods, upcoming } = await mine();
      expect(upcoming.lessons).toEqual([]);
      expect(periods.flatMap((p) => p.lessons.map((l) => l.status))).toEqual([
        'no_show',
      ]);
    });

    it('formats students as first name and last initial and skips blank names', async () => {
      ctx.repo.addClass({
        startsAt: '2026-01-23T15:00:00Z',
        customers: [
          ['Wei', 'Zhang'],
          ['米', null],
          ['  ', '  '],
          [null, 'zhou'],
          [' Amy ', ' li'],
        ],
      });
      const { upcoming } = await mine();
      expect(upcoming.lessons[0].students).toEqual([
        'Wei Z.',
        '米',
        'Z.',
        'Amy L.',
      ]);
    });

    it('uses Toronto dates and times across midnight and DST', async () => {
      ctx.repo.addClass({ startsAt: '2026-01-12T03:00:00Z', minutes: 90 });
      ctx.repo.addClass({ startsAt: '2026-03-08T06:30:00Z', minutes: 90 });
      const { periods, upcoming } = await mine();
      expect(periods.map((p) => p.startsOn)).toEqual(['2025-12-29']);
      expect(periods[0].lessons[0]).toMatchObject({
        date: '2026-01-11',
        startTime: '22:00',
        endTime: '23:30',
      });
      expect(upcoming.lessons[0]).toMatchObject({
        date: '2026-03-08',
        startTime: '01:30',
        endTime: '04:00',
        minutes: 90,
      });
    });

    it('never writes, not even payroll periods', async () => {
      ctx.repo.addClass({ startsAt: '2026-01-05T15:00:00Z' });
      ctx.repo.addClass({ startsAt: '2026-01-23T15:00:00Z' });
      const writes = [
        'ensurePeriods',
        'insertAdjustment',
        'deleteAdjustment',
        'finalize',
        'reopen',
        'setAnchor',
      ] as const;
      const spies = writes.map((method) => jest.spyOn(ctx.repo, method));
      const before = JSON.stringify([ctx.repo.periods, ctx.repo.lineRows]);
      const { periods } = await mine();
      expect(periods.map((p) => [p.startsOn, p.status])).toEqual([
        ['2025-12-29', 'awaiting'],
      ]);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(JSON.stringify([ctx.repo.periods, ctx.repo.lineRows])).toBe(
        before,
      );
      expect(ctx.repo.periods).toEqual([]);
    });
  });
});
