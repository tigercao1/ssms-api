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
  NOW,
  startInsuranceApp,
  UNVERIFIED_AUTH,
} from '../../test/helpers/insurance-fakes';
import {
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
  InMemoryDocumentTemplatesRepository,
} from '../../test/helpers/documents-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import {
  InMemorySeasonsRepository,
  SEASON_2026,
  seasonRow,
  seasonsProviders,
} from '../../test/helpers/seasons-fakes';
import { AuditService } from '../audit/audit.service';
import { DocumentAssignmentsRepository } from '../documents/document-assignments.repository';
import { DocumentSubjectsRepository } from '../documents/document-subjects.repository';
import { DocumentTemplatesRepository } from '../documents/document-templates.repository';
import { MeDocumentsService } from '../documents/me-documents.service';
import { AdminInsuranceController } from './admin-insurance.controller';
import { AdminInsuranceService } from './admin-insurance.service';
import type { InsuranceRecord } from './insurance.presenters';
import { LessonInsuranceRepository } from './lesson-insurance.repository';
import { MeInsuranceController } from './me-insurance.controller';
import {
  INSURANCE_ONBOARDING_INCOMPLETE,
  INSURANCE_PENDING,
  INSURANCE_REJECTED,
  MeInsuranceService,
  type MyInsurance,
  WAIVER_UNCONFIRMED,
} from './me-insurance.service';

async function build(
  approval: 'approved' | 'pending' | 'rejected' = 'approved',
  seasons = new InMemorySeasonsRepository([SEASON_2026, seasonRow('2027/28')]),
) {
  const now = () => new Date(NOW);
  const repo = new InMemoryLessonInsuranceRepository(
    () => [...seasons.rows.values()],
    now,
  );
  repo.addInstructor(ADA_USER, ADA_INSTRUCTOR, 'Ada Lovelace', approval);
  repo.addInstructor(BO_USER, BO_INSTRUCTOR, 'Bo Zhang');
  const templates = new InMemoryDocumentTemplatesRepository();
  const subjects = new InMemoryDocumentSubjectsRepository();
  const assignments = new InMemoryDocumentAssignmentsRepository(
    templates,
    subjects,
  );
  const app = await startInsuranceApp(
    Test.createTestingModule({
      controllers: [MeInsuranceController, AdminInsuranceController],
      providers: [
        ...seasonsProviders(seasons, now),
        MeInsuranceService,
        AdminInsuranceService,
        MeDocumentsService,
        { provide: DocumentTemplatesRepository, useValue: templates },
        { provide: DocumentAssignmentsRepository, useValue: assignments },
        { provide: DocumentSubjectsRepository, useValue: subjects },
        { provide: LessonInsuranceRepository, useValue: repo },
        { provide: AuditService, useValue: recordingAudit() },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }),
  );
  return { app, repo, seasons, templates, assignments, subjects };
}

const students = (n: number, waiver = true) =>
  Array.from({ length: n }, (_, i) => ({
    name: `Student ${i + 1}`,
    waiverConfirmed: waiver,
  }));

describe('/me/insurance', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());
  const overview = async (auth = ADA_AUTH, season?: string) =>
    (
      await http()
        .get('/me/insurance')
        .query(season ? { season } : {})
        .set('Authorization', auth)
        .expect(200)
    ).body as MyInsurance;
  const register = (body: object, auth = ADA_AUTH) =>
    http()
      .post('/me/insurance/records')
      .set('Authorization', auth)
      .send({ idempotencyKey: randomUUID(), ...body });
  const lesson = async (
    lessonDate: string,
    durationHours: number,
    count: number,
    extra: object = {},
  ) =>
    (
      await register({
        lessonDate,
        durationHours,
        students: students(count),
        ...extra,
      }).expect(201)
    ).body as InsuranceRecord;
  const grantPass = async () =>
    (
      await http()
        .post(`/admin/insurance/instructors/${ADA_INSTRUCTOR}/season-pass`)
        .set('Authorization', ADMIN_AUTH)
        .expect(201)
    ).body as InsuranceRecord;

  afterEach(async () => {
    await ctx.app.close();
  });

  describe('auth and profile', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('is 401 without a token and 403 for an unverified email', async () => {
      await http().get('/me/insurance').expect(401);
      await http()
        .get('/me/insurance')
        .set('Authorization', UNVERIFIED_AUTH)
        .expect(403);
      await register({}, UNVERIFIED_AUTH).expect(403);
    });

    it('is 404 without an instructor profile', async () => {
      ctx.repo.instructors.delete(ADA_INSTRUCTOR);
      await http()
        .get('/me/insurance')
        .set('Authorization', ADA_AUTH)
        .expect(404);
      await register({
        lessonDate: '2026-12-01',
        durationHours: 1,
        students: students(1),
      }).expect(404);
    });

    it('has no instructor route to cancel, void or delete a record', async () => {
      const record = await lesson('2026-12-01', 1, 1);
      for (const call of [
        http().post(`/me/insurance/records/${record.id}/void`),
        http().post(`/me/insurance/records/${record.id}/cancel`),
        http().delete(`/me/insurance/records/${record.id}`),
        http().patch(`/me/insurance/records/${record.id}`),
        http()
          .post('/me/insurance/season-pass')
          .send({ idempotencyKey: randomUUID() }),
      ]) {
        await call.set('Authorization', ADA_AUTH).expect(404);
      }
      expect(ctx.repo.rows.get(record.id)?.payment_status).toBe('unpaid');
    });
  });

  describe('GET', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('defaults to the current season, which is 2026/27 on 2026-10-15', async () => {
      expect(await overview()).toEqual({
        locked: false,
        lockReason: null,
        season: {
          key: '2026/27',
          startsOn: '2026-11-01',
          endsOn: '2027-04-30',
        },
        capCents: 40000,
        owedCents: 0,
        paidCents: 0,
        unpaidCents: 0,
        coverage: 'none',
        records: [],
        requests: [],
      });
    });

    it('reads another season by key and 400s an unknown or malformed one', async () => {
      await lesson('2027-12-01', 1, 1);
      const later = await overview(ADA_AUTH, '2027/28');
      expect(later.season?.key).toBe('2027/28');
      expect(later.owedCents).toBe(1000);
      expect((await overview()).owedCents).toBe(0);
      await http()
        .get('/me/insurance')
        .query({ season: '2099/00' })
        .set('Authorization', ADA_AUTH)
        .expect(400, {
          statusCode: 400,
          message: 'Unknown season',
          error: 'Bad Request',
        });
      await http()
        .get('/me/insurance')
        .query({ season: '2026-27' })
        .set('Authorization', ADA_AUTH)
        .expect(400);
    });

    it('returns a null season with no seasons set up', async () => {
      await ctx.app.close();
      ctx = await build('approved', new InMemorySeasonsRepository([]));
      expect(await overview()).toMatchObject({
        season: null,
        owedCents: 0,
        records: [],
      });
    });

    it('sorts by lesson date desc, a season pass by its creation date, then newest first', async () => {
      const dec = await lesson('2026-12-01', 1, 1);
      const jan = await lesson('2027-01-10', 1, 1);
      const nov = await lesson('2026-11-15', 1, 1);
      const decLater = await lesson('2026-12-01', 2, 1);
      const seasonPass = await grantPass();
      const { records } = await overview();
      expect(records.map((r) => r.id)).toEqual([
        jan.id,
        decLater.id,
        dec.id,
        nov.id,
        seasonPass.id,
      ]);
    });

    it('keeps each instructor to their own records', async () => {
      const key = randomUUID();
      const ada = (
        await register({
          lessonDate: '2026-12-01',
          durationHours: 1,
          students: students(1),
          idempotencyKey: key,
        }).expect(201)
      ).body as InsuranceRecord;
      expect((await overview(BO_AUTH)).records).toEqual([]);
      const bo = (
        await register(
          {
            lessonDate: '2026-12-01',
            durationHours: 2,
            students: students(1),
            idempotencyKey: key,
          },
          BO_AUTH,
        ).expect(201)
      ).body as InsuranceRecord;
      expect(bo.id).not.toBe(ada.id);
      expect((await overview(BO_AUTH)).records.map((r) => r.id)).toEqual([
        bo.id,
      ]);
      expect((await overview()).records.map((r) => r.id)).toEqual([ada.id]);
      expect(ctx.repo.registerCalls.map((c) => c.instructorId)).toEqual([
        ADA_INSTRUCTOR,
        BO_INSTRUCTOR,
      ]);
    });
  });

  describe.each([
    ['pending', 'pending_approval', INSURANCE_PENDING],
    ['rejected', 'rejected', INSURANCE_REJECTED],
  ] as const)('a %s instructor', (approval, reason, message) => {
    beforeEach(async () => {
      ctx = await build(approval);
    });

    it('sees the tab locked with no records and zeros', async () => {
      ctx.repo.instructors.get(ADA_INSTRUCTOR)!.approval_status = 'approved';
      await lesson('2026-12-01', 1, 1);
      ctx.repo.instructors.get(ADA_INSTRUCTOR)!.approval_status = approval;
      expect(await overview()).toEqual({
        locked: true,
        lockReason: reason,
        season: {
          key: '2026/27',
          startsOn: '2026-11-01',
          endsOn: '2027-04-30',
        },
        capCents: 40000,
        owedCents: 0,
        paidCents: 0,
        unpaidCents: 0,
        coverage: 'none',
        records: [],
        requests: [],
      });
    });

    it('cannot register a lesson', async () => {
      await register({
        lessonDate: '2026-12-01',
        durationHours: 1,
        students: students(1),
      }).expect(403, { message, reason });
      expect(ctx.repo.registerCalls).toHaveLength(0);
    });
  });

  describe('onboarding', () => {
    const assign = (status: 'assigned' | 'completed') =>
      ctx.assignments.seed({
        template_id: ctx.templates.seed({}).id,
        subject_id: ADA_INSTRUCTOR,
        status,
        season: SEASON_2026.key,
      });
    const lessonBody = {
      lessonDate: '2026-12-01',
      durationHours: 1,
      students: students(1),
    };

    beforeEach(async () => {
      ctx = await build();
    });

    it('locks an approved instructor with a required document left and reads no records', async () => {
      await lesson('2026-12-01', 1, 1);
      assign('completed');
      assign('assigned');
      const records = jest.spyOn(ctx.repo, 'recordsFor');
      const requests = jest.spyOn(ctx.repo, 'requestsFor');
      expect(await overview()).toEqual({
        locked: true,
        lockReason: 'onboarding_incomplete',
        season: {
          key: '2026/27',
          startsOn: '2026-11-01',
          endsOn: '2027-04-30',
        },
        capCents: 40000,
        owedCents: 0,
        paidCents: 0,
        unpaidCents: 0,
        coverage: 'none',
        records: [],
        requests: [],
      });
      expect(records).not.toHaveBeenCalled();
      expect(requests).not.toHaveBeenCalled();
    });

    it('cannot register a lesson while onboarding is incomplete', async () => {
      assign('assigned');
      await register(lessonBody).expect(403, {
        message: INSURANCE_ONBOARDING_INCOMPLETE,
        reason: 'onboarding_incomplete',
      });
      expect(ctx.repo.registerCalls).toHaveLength(0);
    });

    it('cannot submit an insurance request while onboarding is incomplete', async () => {
      assign('assigned');
      await http()
        .post('/me/insurance/requests')
        .set('Authorization', ADA_AUTH)
        .send({ idempotencyKey: randomUUID(), lessons: [lessonBody] })
        .expect(403, {
          message: INSURANCE_ONBOARDING_INCOMPLETE,
          reason: 'onboarding_incomplete',
        });
      expect(ctx.repo.requests.size).toBe(0);
    });

    it('locks an instructor whose certification is missing', async () => {
      ctx.subjects.certifications.set(ADA_INSTRUCTOR, [
        { org: 'csia', track: 'regular', level: 2 },
      ]);
      await expect(overview()).resolves.toMatchObject({
        locked: true,
        lockReason: 'onboarding_incomplete',
      });
    });

    it('unlocks reads and writes once the last document is completed', async () => {
      const last = assign('assigned');
      await expect(overview()).resolves.toMatchObject({ locked: true });
      ctx.assignments.rows.set(last.id, {
        ...ctx.assignments.rows.get(last.id)!,
        status: 'completed',
      });
      const record = await lesson('2026-12-01', 1, 1);
      const body = await overview();
      expect(body).toMatchObject({ locked: false, lockReason: null });
      expect(body.records.map((r) => r.id)).toEqual([record.id]);
    });

    it.each([
      ['pending', 'pending_approval', INSURANCE_PENDING],
      ['rejected', 'rejected', INSURANCE_REJECTED],
    ] as const)(
      'keeps the %s lock ahead of onboarding',
      async (approval, reason, message) => {
        ctx.repo.instructors.get(ADA_INSTRUCTOR)!.approval_status = approval;
        assign('assigned');
        await expect(overview()).resolves.toMatchObject({
          locked: true,
          lockReason: reason,
        });
        await register(lessonBody).expect(403, { message, reason });
      },
    );
  });

  describe('POST /me/insurance/records', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('charges $10 per hour per student, counting at most 4 students', async () => {
      const res = await register({
        lessonDate: '2026-12-01',
        durationHours: 1,
        locationId: HILL_ID,
        students: [{ name: '  Ada  ', waiverConfirmed: true }, ...students(5)],
      }).expect(201);
      const record = res.body as InsuranceRecord;
      expect(record).toEqual({
        id: expect.any(String) as unknown,
        recordNo: 'INS-20261015-0001',
        kind: 'lesson',
        seasonKey: '2026/27',
        lessonDate: '2026-12-01',
        durationHours: 1,
        locationId: HILL_ID,
        locationName: 'CI Hill',
        locationOther: null,
        students: [{ name: 'Ada', waiverConfirmed: true }, ...students(5)],
        studentCount: 6,
        listCents: 4000,
        amountCents: 4000,
        coverage: 'per_lesson',
        paymentStatus: 'unpaid',
        paidOn: null,
        createdAt: expect.any(String) as unknown,
      });
      const two = await lesson('2026-12-02', 2, 3);
      expect([two.listCents, two.amountCents]).toEqual([6000, 6000]);
      expect(two.recordNo).toBe('INS-20261015-0002');
    });

    it('stores another ski area as free text, or none', async () => {
      const other = await lesson('2026-12-01', 1, 1, {
        locationOther: ' Blue Mountain ',
      });
      expect(other).toMatchObject({
        locationId: null,
        locationName: null,
        locationOther: 'Blue Mountain',
      });
      const none = await lesson('2026-12-01', 1, 1, { locationOther: '  ' });
      expect(none.locationOther).toBeNull();
    });

    it('400s an unknown ski area and both a ski area and another', async () => {
      await register({
        lessonDate: '2026-12-01',
        durationHours: 1,
        locationId: randomUUID(),
        students: students(1),
      }).expect(400, {
        statusCode: 400,
        message: 'Unknown ski area',
        error: 'Bad Request',
      });
      await register({
        lessonDate: '2026-12-01',
        durationHours: 1,
        locationId: HILL_ID,
        locationOther: 'Elsewhere',
        students: students(1),
      }).expect(400);
      expect(ctx.repo.rows.size).toBe(0);
    });

    it('400s waiver_unconfirmed with the offending indexes', async () => {
      await register({
        lessonDate: '2026-12-01',
        durationHours: 1,
        students: [
          { name: 'A', waiverConfirmed: true },
          { name: 'B', waiverConfirmed: false },
          { name: 'C', waiverConfirmed: true },
          { name: 'D', waiverConfirmed: false },
        ],
      }).expect(400, {
        statusCode: 400,
        code: 'waiver_unconfirmed',
        message: WAIVER_UNCONFIRMED,
        indexes: [1, 3],
      });
      expect(ctx.repo.registerCalls).toHaveLength(0);
    });

    it.each([
      ['a 3-hour lesson', { durationHours: 3 }],
      ['no students', { students: [] }],
      ['51 students', { students: students(51) }],
      ['an empty name', { students: [{ name: '  ', waiverConfirmed: true }] }],
      [
        'a 201-character name',
        { students: [{ name: 'x'.repeat(201), waiverConfirmed: true }] },
      ],
      ['a missing waiver flag', { students: [{ name: 'A' }] }],
      ['a bad date', { lessonDate: '2026-13-01' }],
      ['a missing idempotency key', { idempotencyKey: undefined }],
      ['an extra field', { amountCents: 0 }],
      ['a long other ski area', { locationOther: 'x'.repeat(201) }],
    ])('400s %s', async (_label, override) => {
      await register({
        lessonDate: '2026-12-01',
        durationHours: 1,
        students: students(1),
        ...override,
      }).expect(400);
      expect(ctx.repo.registerCalls).toHaveLength(0);
    });

    it('fails loudly when the registered record cannot be read back', async () => {
      jest.spyOn(ctx.repo, 'findRecord').mockResolvedValueOnce(null);
      await register({
        lessonDate: '2026-12-01',
        durationHours: 1,
        students: students(1),
      }).expect(500);
      jest.spyOn(ctx.repo, 'register').mockRejectedValueOnce(new Error('down'));
      await register({
        lessonDate: '2026-12-01',
        durationHours: 1,
        students: students(1),
      }).expect(500);
    });

    it('returns the existing record with 200 on a repeated idempotency key', async () => {
      const body = {
        lessonDate: '2026-12-01',
        durationHours: 1,
        students: students(2),
        idempotencyKey: randomUUID(),
      };
      const first = (await register(body).expect(201)).body as InsuranceRecord;
      const again = (await register(body).expect(200)).body as InsuranceRecord;
      expect(again).toEqual(first);
      expect(ctx.repo.rows.size).toBe(1);
      expect((await overview()).owedCents).toBe(2000);
    });

    it('charges only the remainder when a lesson crosses the cap, with no 409, then registers later lessons for free', async () => {
      for (const day of ['01', '02', '03', '04']) {
        await lesson(`2026-12-${day}`, 2, 4);
      }
      await lesson('2026-12-05', 2, 3);
      expect((await overview()).owedCents).toBe(38000);
      const crossing = (
        await register({
          lessonDate: '2026-12-06',
          durationHours: 2,
          students: students(2),
          topUp: false,
        }).expect(201)
      ).body as InsuranceRecord;
      expect(crossing).toMatchObject({
        listCents: 4000,
        amountCents: 2000,
        coverage: 'cap_top_up',
        paymentStatus: 'unpaid',
      });
      for (const day of ['07', '08']) {
        const free = await lesson(`2026-12-${day}`, 2, 6);
        expect(free).toMatchObject({
          listCents: 8000,
          amountCents: 0,
          coverage: 'capped',
          paymentStatus: 'not_required',
        });
      }
      expect(await overview()).toMatchObject({
        owedCents: 40000,
        unpaidCents: 40000,
        coverage: 'capped',
      });
    });

    it('accepts and ignores a topUp flag from the previous portal', async () => {
      const record = await lesson('2026-12-01', 1, 1, { topUp: true });
      expect(record).toMatchObject({
        amountCents: 1000,
        coverage: 'per_lesson',
      });
      expect(ctx.repo.registerCalls[0]).not.toHaveProperty('topUp');
    });

    it('never lets the amount owed pass 40000', async () => {
      for (let i = 1; i <= 8; i++) {
        await register({
          lessonDate: `2027-01-${String(i).padStart(2, '0')}`,
          durationHours: 2,
          students: students(4),
        }).expect(201);
        expect((await overview()).owedCents).toBeLessThanOrEqual(40000);
      }
      expect((await overview()).owedCents).toBe(40000);
    });

    it('takes the season from the lesson date, so a date after 2027-04-30 has none and 2027/28 starts at 0', async () => {
      for (const day of ['01', '02', '03', '04', '05']) {
        await register({
          lessonDate: `2027-04-${day}`,
          durationHours: 2,
          students: students(4),
        }).expect(201);
      }
      expect((await overview()).coverage).toBe('capped');
      await register({
        lessonDate: '2027-05-01',
        durationHours: 1,
        students: students(1),
      }).expect(400, {
        statusCode: 400,
        code: 'no_season',
        message: 'No season covers this date',
      });
      const next = await lesson('2027-11-01', 1, 1);
      expect(next).toMatchObject({
        seasonKey: '2027/28',
        amountCents: 1000,
        coverage: 'per_lesson',
      });
      const late = await lesson('2026-11-01', 1, 1);
      expect(late).toMatchObject({ seasonKey: '2026/27', amountCents: 0 });
    });
  });
});
