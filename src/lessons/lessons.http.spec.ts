import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH as admin,
  ADMIN_ID,
  INSTRUCTOR_AUTH,
  startAdminApp,
} from '../../test/helpers/admin-http';
import {
  classRow,
  EDDIE_ID,
  ERIC_ID,
  fakeGoogle,
  InMemoryClassesRepository,
  InMemoryInstructorCalendarsRepository,
  InMemoryLessonTypesRepository,
  InMemoryPayRatesRepository,
} from '../../test/helpers/lessons-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { GoogleApiError } from '../google/google.errors';
import { GoogleCalendarClient } from '../google/google-calendar.client';
import { ClassesController } from './classes.controller';
import { ClassesRepository } from './classes.repository';
import { ClassesService } from './classes.service';
import { InstructorCalendarsController } from './instructor-calendars.controller';
import { InstructorCalendarsRepository } from './instructor-calendars.repository';
import {
  CALENDAR_ALREADY_LINKED,
  InstructorCalendarsService,
} from './instructor-calendars.service';
import { LessonTypesController } from './lesson-types.controller';
import { LessonTypesRepository } from './lesson-types.repository';
import {
  LESSON_TYPE_NAME_TAKEN,
  LessonTypesService,
} from './lesson-types.service';
import { PayRatesController } from './pay-rates.controller';
import { PayRatesRepository } from './pay-rates.repository';
import {
  PAY_RATE_INSTRUCTOR_NOT_FOUND,
  PAY_RATE_LESSON_TYPE_NOT_FOUND,
  PAY_RATE_OVERLAP,
  PAY_RATE_RANGE_INVALID,
  PayRatesService,
} from './pay-rates.service';

const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';

async function build(google = fakeGoogle()) {
  const lessonTypes = new InMemoryLessonTypesRepository();
  const payRates = new InMemoryPayRatesRepository();
  const classes = new InMemoryClassesRepository();
  const calendars = new InMemoryInstructorCalendarsRepository();
  const audit = recordingAudit();
  const app = await startAdminApp(
    Test.createTestingModule({
      controllers: [
        LessonTypesController,
        PayRatesController,
        ClassesController,
        InstructorCalendarsController,
      ],
      providers: [
        LessonTypesService,
        PayRatesService,
        ClassesService,
        InstructorCalendarsService,
        { provide: LessonTypesRepository, useValue: lessonTypes },
        { provide: PayRatesRepository, useValue: payRates },
        { provide: ClassesRepository, useValue: classes },
        { provide: InstructorCalendarsRepository, useValue: calendars },
        { provide: GoogleCalendarClient, useValue: google.client },
        { provide: AuditService, useValue: audit },
      ],
    }),
  );
  return { app, lessonTypes, payRates, classes, calendars, audit, google };
}

describe('lessons admin HTTP', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());

  afterEach(async () => {
    await ctx.app.close();
  });

  describe('auth', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const routes: [string, (r: ReturnType<typeof http>) => request.Test][] = [
      ['GET lesson types', (r) => r.get('/admin/lesson-types')],
      ['POST lesson type', (r) => r.post('/admin/lesson-types').send({})],
      [
        'PATCH lesson type',
        (r) => r.patch(`/admin/lesson-types/${UNKNOWN_ID}`).send({}),
      ],
      ['GET pay rates', (r) => r.get('/admin/pay-rates')],
      ['GET resolved pay rate', (r) => r.get('/admin/pay-rates/resolve')],
      ['POST pay rate', (r) => r.post('/admin/pay-rates').send({})],
      [
        'PATCH pay rate',
        (r) => r.patch(`/admin/pay-rates/${UNKNOWN_ID}`).send({}),
      ],
      ['GET classes', (r) => r.get('/admin/classes')],
      ['GET instructor calendars', (r) => r.get('/admin/instructor-calendars')],
      [
        'POST calendar suggestions',
        (r) => r.post('/admin/instructor-calendars/suggest'),
      ],
      [
        'GET google calendar',
        (r) => r.get(`/admin/instructors/${EDDIE_ID}/google-calendar`),
      ],
      [
        'PATCH google calendar',
        (r) =>
          r
            .patch(`/admin/instructors/${EDDIE_ID}/google-calendar`)
            .send({ googleCalendarId: 'x@example.com' }),
      ],
      [
        'PATCH instructor calendar',
        (r) =>
          r
            .patch(`/admin/instructor-calendars/${EDDIE_ID}`)
            .send({ googleCalendarId: 'x@example.com' }),
      ],
    ];

    it.each(routes)('%s → 401 without a token', async (_name, send) => {
      await send(http()).expect(401);
    });

    it.each(routes)('%s → 403 for a non-admin', async (_name, send) => {
      await send(http()).set('Authorization', INSTRUCTOR_AUTH).expect(403);
    });
  });

  describe('/admin/lesson-types', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const create = (body: object) =>
      http().post('/admin/lesson-types').set('Authorization', admin).send(body);

    it('creates a lesson type with defaults and audits it', async () => {
      const res = await create({
        nameEn: ' Private 2h ',
        nameZh: '1对1滑雪课 - 2小时',
        groupSize: 1,
        durationMin: 120,
      }).expect(201);
      expect(res.body).toMatchObject({
        nameEn: 'Private 2h',
        nameZh: '1对1滑雪课 - 2小时',
        groupSize: 1,
        durationMin: 120,
        isPromo: false,
        active: true,
        sortOrder: 0,
      });
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: 'lesson_type.create',
          targetType: 'lesson_type',
          targetId: (res.body as { id: string }).id,
          actor: expect.objectContaining({ userId: ADMIN_ID }) as unknown,
        }),
      ]);
    });

    it('lists in sort order and filters by active', async () => {
      ctx.lessonTypes.seed({
        name_en: 'Promo 1v1',
        sort_order: 2,
        is_promo: true,
      });
      ctx.lessonTypes.seed({ name_en: 'Private 1h', sort_order: 1 });
      ctx.lessonTypes.seed({ name_en: 'Old', sort_order: 0, active: false });
      const all = await http()
        .get('/admin/lesson-types')
        .set('Authorization', admin)
        .expect(200);
      expect((all.body as { nameEn: string }[]).map((t) => t.nameEn)).toEqual([
        'Old',
        'Private 1h',
        'Promo 1v1',
      ]);
      const active = await http()
        .get('/admin/lesson-types?active=true')
        .set('Authorization', admin)
        .expect(200);
      expect(
        (active.body as { nameEn: string }[]).map((t) => t.nameEn),
      ).toEqual(['Private 1h', 'Promo 1v1']);
    });

    it('is 409 when the English name is already used', async () => {
      ctx.lessonTypes.seed({ name_en: 'Private 2h' });
      const res = await create({
        nameEn: 'private 2H',
        durationMin: 60,
      }).expect(409);
      expect((res.body as { message: string }).message).toBe(
        LESSON_TYPE_NAME_TAKEN,
      );
    });

    it('updates only the given fields and audits before/after', async () => {
      const type = ctx.lessonTypes.seed();
      const res = await http()
        .patch(`/admin/lesson-types/${type.id}`)
        .set('Authorization', admin)
        .send({ active: false, groupSize: null, nameZh: '' })
        .expect(200);
      expect(res.body).toMatchObject({
        nameEn: 'Private 2h',
        active: false,
        groupSize: null,
        nameZh: null,
      });
      expect(ctx.audit.entries[0]).toMatchObject({
        action: 'lesson_type.update',
        targetId: type.id,
        metadata: {
          before: {
            active: true,
            group_size: 1,
            name_zh: '1对1滑雪课 - 2小时',
          },
          after: { active: false, group_size: null, name_zh: null },
        },
      });
    });

    it('is 404 for an unknown id, 400 for an empty patch', async () => {
      await http()
        .patch(`/admin/lesson-types/${UNKNOWN_ID}`)
        .set('Authorization', admin)
        .send({ active: false })
        .expect(404);
      const type = ctx.lessonTypes.seed();
      await http()
        .patch(`/admin/lesson-types/${type.id}`)
        .set('Authorization', admin)
        .send({})
        .expect(400);
    });

    it('is 409 when renaming onto an existing name', async () => {
      ctx.lessonTypes.seed({ name_en: 'Private 1h' });
      const type = ctx.lessonTypes.seed({ name_en: 'Private 2h' });
      await http()
        .patch(`/admin/lesson-types/${type.id}`)
        .set('Authorization', admin)
        .send({ nameEn: 'Private 1h' })
        .expect(409);
    });

    it.each([
      [{ durationMin: 60 }],
      [{ nameEn: '', durationMin: 60 }],
      [{ nameEn: 'X' }],
      [{ nameEn: 'X', durationMin: 0 }],
      [{ nameEn: 'X', durationMin: 1441 }],
      [{ nameEn: 'X', durationMin: 60, groupSize: 0 }],
      [{ nameEn: 'X', durationMin: 60, isPromo: 'yes' }],
      [{ nameEn: 'X', durationMin: 60, wechatName: 'x' }],
    ])('rejects %j with 400', async (body) => {
      await create(body).expect(400);
    });
  });

  describe('/admin/pay-rates', () => {
    let lessonTypeId: string;

    beforeEach(async () => {
      ctx = await build();
      lessonTypeId = ctx.lessonTypes.seed().id;
      ctx.payRates.lessonTypeIds.add(lessonTypeId);
    });

    const create = (body: object) =>
      http()
        .post('/admin/pay-rates')
        .set('Authorization', admin)
        .send({ lessonTypeId, ...body });

    it('creates a default rate in CAD and audits it', async () => {
      const res = await create({
        hourlyRate: 42.5,
        effectiveFrom: '2026-11-01',
      }).expect(201);
      expect(res.body).toMatchObject({
        lessonTypeId,
        instructorId: null,
        hourlyRate: 42.5,
        currency: 'CAD',
        effectiveFrom: '2026-11-01',
        effectiveTo: null,
      });
      expect(ctx.audit.entries[0]).toMatchObject({
        action: 'pay_rate.create',
        targetType: 'pay_rate',
        targetId: (res.body as { id: string }).id,
      });
    });

    it('is 409 when a rate overlaps another for the same type and instructor', async () => {
      await create({
        hourlyRate: 40,
        effectiveFrom: '2026-11-01',
        effectiveTo: '2026-12-31',
      }).expect(201);
      const res = await create({
        hourlyRate: 45,
        effectiveFrom: '2026-12-31',
      }).expect(409);
      expect((res.body as { message: string }).message).toBe(PAY_RATE_OVERLAP);
      await create({ hourlyRate: 45, effectiveFrom: '2027-01-01' }).expect(201);
      await create({
        hourlyRate: 60,
        instructorId: EDDIE_ID,
        effectiveFrom: '2026-11-15',
      }).expect(201);
      await create({
        hourlyRate: 61,
        instructorId: EDDIE_ID,
        effectiveFrom: '2027-03-01',
      }).expect(409);
    });

    it('is 400 for a range that ends before it starts', async () => {
      const res = await create({
        hourlyRate: 40,
        effectiveFrom: '2026-11-01',
        effectiveTo: '2026-10-31',
      }).expect(400);
      expect((res.body as { message: string }).message).toBe(
        PAY_RATE_RANGE_INVALID,
      );
    });

    it('is 400 for an unknown lesson type or instructor', async () => {
      const type = await http()
        .post('/admin/pay-rates')
        .set('Authorization', admin)
        .send({
          lessonTypeId: UNKNOWN_ID,
          hourlyRate: 40,
          effectiveFrom: '2026-11-01',
        })
        .expect(400);
      expect((type.body as { message: string }).message).toBe(
        PAY_RATE_LESSON_TYPE_NOT_FOUND,
      );
      const instructor = await create({
        instructorId: UNKNOWN_ID,
        hourlyRate: 40,
        effectiveFrom: '2026-11-01',
      }).expect(400);
      expect((instructor.body as { message: string }).message).toBe(
        PAY_RATE_INSTRUCTOR_NOT_FOUND,
      );
    });

    it.each([
      [{ hourlyRate: -1, effectiveFrom: '2026-11-01' }],
      [{ hourlyRate: 40.123, effectiveFrom: '2026-11-01' }],
      [{ hourlyRate: '40', effectiveFrom: '2026-11-01' }],
      [{ hourlyRate: 40, effectiveFrom: '2026-02-30' }],
      [{ hourlyRate: 40, effectiveFrom: '2026-11-01T00:00:00Z' }],
      [{ hourlyRate: 40, effectiveFrom: '2026-11-01', currency: 'dollars' }],
      [{ hourlyRate: 40, effectiveFrom: '2026-11-01', instructorId: 'eddie' }],
      [{ hourlyRate: 40 }],
    ])('rejects %j with 400', async (body) => {
      await create(body).expect(400);
    });

    it('ends a rate with PATCH, audits it, and refuses to extend into the next one', async () => {
      const first = await create({
        hourlyRate: 40,
        effectiveFrom: '2026-11-01',
      }).expect(201);
      const id = (first.body as { id: string }).id;
      const ended = await http()
        .patch(`/admin/pay-rates/${id}`)
        .set('Authorization', admin)
        .send({ effectiveTo: '2026-12-31', currency: 'cad' })
        .expect(200);
      expect(ended.body).toMatchObject({
        effectiveTo: '2026-12-31',
        currency: 'CAD',
      });
      expect(ctx.audit.entries[1]).toMatchObject({
        action: 'pay_rate.update',
        targetId: id,
        metadata: {
          before: { effectiveTo: null },
          after: { effectiveTo: '2026-12-31' },
        },
      });
      await create({ hourlyRate: 45, effectiveFrom: '2027-01-01' }).expect(201);
      await http()
        .patch(`/admin/pay-rates/${id}`)
        .set('Authorization', admin)
        .send({ effectiveTo: null })
        .expect(409);
      await http()
        .patch(`/admin/pay-rates/${id}`)
        .set('Authorization', admin)
        .send({ effectiveFrom: '2027-02-01' })
        .expect(400);
    });

    it('is 404 for an unknown rate and 400 for an empty patch', async () => {
      await http()
        .patch(`/admin/pay-rates/${UNKNOWN_ID}`)
        .set('Authorization', admin)
        .send({ hourlyRate: 1 })
        .expect(404);
      await http()
        .patch(`/admin/pay-rates/${UNKNOWN_ID}`)
        .set('Authorization', admin)
        .send({})
        .expect(400);
    });

    it('lists with filters', async () => {
      await create({ hourlyRate: 40, effectiveFrom: '2026-11-01' });
      await create({
        hourlyRate: 60,
        instructorId: EDDIE_ID,
        effectiveFrom: '2026-11-01',
      });
      const all = await http()
        .get('/admin/pay-rates')
        .set('Authorization', admin)
        .expect(200);
      expect(all.body).toHaveLength(2);
      const defaults = await http()
        .get(`/admin/pay-rates?lessonTypeId=${lessonTypeId}&scope=default`)
        .set('Authorization', admin)
        .expect(200);
      expect(defaults.body).toEqual([
        expect.objectContaining({ instructorId: null, hourlyRate: 40 }),
      ]);
      const eddie = await http()
        .get(`/admin/pay-rates?instructorId=${EDDIE_ID}`)
        .set('Authorization', admin)
        .expect(200);
      expect(eddie.body).toEqual([
        expect.objectContaining({ instructorId: EDDIE_ID, hourlyRate: 60 }),
      ]);
      const overrides = await http()
        .get('/admin/pay-rates?scope=override')
        .set('Authorization', admin)
        .expect(200);
      expect(overrides.body).toHaveLength(1);
    });

    it('resolves the instructor override first, else the default, on the lesson date', async () => {
      await create({
        hourlyRate: 40,
        effectiveFrom: '2026-11-01',
        effectiveTo: '2026-12-31',
      });
      await create({ hourlyRate: 45, effectiveFrom: '2027-01-01' });
      await create({
        hourlyRate: 60,
        instructorId: EDDIE_ID,
        effectiveFrom: '2026-12-15',
      });
      const resolve = async (instructorId: string, date: string) =>
        (
          await http()
            .get(
              `/admin/pay-rates/resolve?instructorId=${instructorId}&lessonTypeId=${lessonTypeId}&date=${date}`,
            )
            .set('Authorization', admin)
            .expect(200)
        ).body as {
          source: string | null;
          rate: { hourlyRate: number } | null;
        };
      expect(await resolve(EDDIE_ID, '2026-12-01')).toMatchObject({
        source: 'default',
        rate: { hourlyRate: 40 },
      });
      expect(await resolve(EDDIE_ID, '2026-12-15')).toMatchObject({
        source: 'instructor',
        rate: { hourlyRate: 60 },
      });
      expect(await resolve(ERIC_ID, '2027-01-01')).toMatchObject({
        source: 'default',
        rate: { hourlyRate: 45 },
      });
      expect(await resolve(ERIC_ID, '2026-10-31')).toEqual({
        source: null,
        rate: null,
      });
      await http()
        .get(
          `/admin/pay-rates/resolve?instructorId=${ERIC_ID}&lessonTypeId=${lessonTypeId}&date=2026-13-01`,
        )
        .set('Authorization', admin)
        .expect(400);
    });
  });

  describe('GET /admin/classes', () => {
    beforeEach(async () => {
      ctx = await build();
      ctx.classes.rows.push(
        classRow({
          starts_at: '2026-12-13T15:00:00.000Z',
          ends_at: '2026-12-13T16:00:00.000Z',
          instructor_id: ERIC_ID,
          instructor: { display_name_en: 'Eric Wang', display_name_zh: null },
        }),
        classRow({
          lesson_type_id: '8b9c0d1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e',
          lesson_type: {
            name_en: 'Private 1h',
            name_zh: '1对1滑雪课 - 1小时',
            duration_min: 60,
            group_size: 1,
            is_promo: false,
          },
          location_id: '6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c',
          location: { name: 'Blue Mountain' },
          participants: [
            {
              customer_id: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
              attendance: 'expected',
              customer: {
                first_name: 'Lily',
                last_name: 'Chen',
                email: 'lily@example.com',
                phone: null,
              },
            },
          ],
        }),
      );
    });

    it('lists classes in start order with lesson type and participants', async () => {
      const res = await http()
        .get('/admin/classes')
        .set('Authorization', admin)
        .expect(200);
      const body = res.body as Record<string, unknown>[];
      expect(body.map((c) => c.startsAt)).toEqual([
        '2026-12-12T15:00:00.000Z',
        '2026-12-13T15:00:00.000Z',
      ]);
      expect(body[0]).toMatchObject({
        instructorId: EDDIE_ID,
        instructorName: 'Eddie',
        instructorNameZh: '艾迪',
        lessonTypeId: '8b9c0d1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e',
        lessonTypeNameEn: 'Private 1h',
        lessonTypeNameZh: '1对1滑雪课 - 1小时',
        durationMin: 60,
        groupSize: 1,
        isPromo: false,
        locationName: 'Blue Mountain',
        status: 'scheduled',
        source: 'ssms',
        participants: [
          {
            customerId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
            attendance: 'expected',
            firstName: 'Lily',
            lastName: 'Chen',
            email: 'lily@example.com',
            phone: null,
          },
        ],
      });
      expect(body[1]).toMatchObject({
        instructorName: 'Eric Wang',
        lessonTypeId: null,
        lessonTypeNameEn: null,
        locationName: null,
        participants: [],
      });
    });

    it('filters by date range and instructor', async () => {
      const res = await http()
        .get(
          `/admin/classes?from=2026-12-13T00:00:00Z&to=2026-12-14T00:00:00Z&instructorId=${ERIC_ID}`,
        )
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(ctx.classes.filters[0]).toEqual({
        from: '2026-12-13T00:00:00Z',
        to: '2026-12-14T00:00:00Z',
        instructorId: ERIC_ID,
      });
    });

    it.each([
      ['from=yesterday'],
      ['to=2026-13-01'],
      ['instructorId=eddie'],
      ['from=2026-12-14&to=2026-12-13'],
      ['from=2026-12-14&to=2026-12-14'],
    ])('rejects %s with 400', async (qs) => {
      await http()
        .get(`/admin/classes?${qs}`)
        .set('Authorization', admin)
        .expect(400);
    });
  });

  describe('GET /admin/instructors/:id/google-calendar', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const url = (id = EDDIE_ID) => `/admin/instructors/${id}/google-calendar`;

    it('starts empty and reads back a saved link', async () => {
      const empty = await http()
        .get(url())
        .set('Authorization', admin)
        .expect(200);
      expect(empty.body).toEqual({
        instructorId: EDDIE_ID,
        googleCalendarId: null,
        calendarSummary: null,
        matchStatus: null,
        updatedAt: null,
      });

      await http()
        .patch(`/admin/instructor-calendars/${EDDIE_ID}`)
        .set('Authorization', admin)
        .send({ googleCalendarId: 'eddie@example.com' })
        .expect(200);
      const read = await http()
        .get(url())
        .set('Authorization', admin)
        .expect(200);
      expect(read.body).toMatchObject({
        googleCalendarId: 'eddie@example.com',
        matchStatus: 'confirmed',
      });
    });

    it('is 404 for an unknown instructor', async () => {
      await http().get(url(UNKNOWN_ID)).set('Authorization', admin).expect(404);
    });
  });

  describe.each([
    [
      'PATCH /admin/instructor-calendars/:instructorId',
      (id: string) => `/admin/instructor-calendars/${id}`,
    ],
    [
      'PATCH /admin/instructors/:id/google-calendar',
      (id: string) => `/admin/instructors/${id}/google-calendar`,
    ],
  ])('%s', (_name, url) => {
    const googleCalendars = [
      {
        id: 'eddie@example.com',
        summary: ' Eddie Chen ',
        accessRole: 'reader',
      },
      { id: 'eddie-2@example.com', summary: 'Eddie 2', accessRole: 'reader' },
    ];

    beforeEach(async () => {
      ctx = await build(fakeGoogle({ calendars: googleCalendars }));
    });

    const set = (body: object, id = EDDIE_ID) =>
      http().patch(url(id)).set('Authorization', admin).send(body);

    it('saves a confirmed link with the Google summary and audits it once', async () => {
      const saved = await set({
        googleCalendarId: ' eddie@example.com ',
      }).expect(200);
      expect(saved.body).toEqual({
        instructorId: EDDIE_ID,
        googleCalendarId: 'eddie@example.com',
        calendarSummary: 'Eddie Chen',
        matchStatus: 'confirmed',
        updatedAt: expect.any(String) as string,
      });
      await set({ googleCalendarId: 'eddie@example.com' }).expect(200);

      expect(ctx.calendars.rows.get(EDDIE_ID)).toMatchObject({
        google_calendar_id: 'eddie@example.com',
        calendar_summary: 'Eddie Chen',
        updated_by: ADMIN_ID,
      });
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: 'instructor.google_calendar_update',
          targetType: 'instructor',
          targetId: EDDIE_ID,
          metadata: {
            from: null,
            to: 'eddie@example.com',
            fromStatus: null,
            toStatus: 'confirmed',
            fromSummary: null,
            toSummary: 'Eddie Chen',
          },
        }),
      ]);
    });

    it('audits a change of calendar and of match status', async () => {
      await set({
        googleCalendarId: 'eddie@example.com',
        matchStatus: 'suggested',
      }).expect(200);
      await set({
        googleCalendarId: 'eddie@example.com',
        matchStatus: 'confirmed',
      }).expect(200);
      await set({ googleCalendarId: 'eddie-2@example.com' }).expect(200);
      expect(ctx.audit.entries.map((e) => e.metadata)).toEqual([
        expect.objectContaining({
          to: 'eddie@example.com',
          toStatus: 'suggested',
        }),
        expect.objectContaining({
          from: 'eddie@example.com',
          fromStatus: 'suggested',
          toStatus: 'confirmed',
        }),
        expect.objectContaining({
          from: 'eddie@example.com',
          to: 'eddie-2@example.com',
          fromSummary: 'Eddie Chen',
          toSummary: 'Eddie 2',
        }),
      ]);
    });

    it('audits a summary-only change picked up from Google', async () => {
      ctx.calendars.rows.set(EDDIE_ID, {
        instructor_id: EDDIE_ID,
        google_calendar_id: 'eddie@example.com',
        calendar_summary: 'Old name',
        match_status: 'confirmed',
        updated_at: '2026-10-10T00:00:00.000Z',
        updated_by: null,
      });
      const res = await set({ googleCalendarId: 'eddie@example.com' }).expect(
        200,
      );
      expect(res.body).toMatchObject({ calendarSummary: 'Eddie Chen' });
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: 'instructor.google_calendar_update',
          metadata: {
            from: 'eddie@example.com',
            to: 'eddie@example.com',
            fromStatus: 'confirmed',
            toStatus: 'confirmed',
            fromSummary: 'Old name',
            toSummary: 'Eddie Chen',
          },
        }),
      ]);
    });

    it('keeps the stored summary when Google cannot be read, without writing', async () => {
      await ctx.app.close();
      ctx = await build(fakeGoogle({ connected: false }));
      ctx.calendars.rows.set(EDDIE_ID, {
        instructor_id: EDDIE_ID,
        google_calendar_id: 'eddie@example.com',
        calendar_summary: 'Eddie Chen',
        match_status: 'confirmed',
        updated_at: '2026-10-10T00:00:00.000Z',
        updated_by: null,
      });
      const res = await set({ googleCalendarId: 'eddie@example.com' }).expect(
        200,
      );
      expect(res.body).toMatchObject({
        calendarSummary: 'Eddie Chen',
        updatedAt: '2026-10-10T00:00:00.000Z',
      });
      expect(ctx.audit.entries).toEqual([]);

      await set({ googleCalendarId: 'other@example.com' }).expect(200);
      expect(ctx.audit.entries[0].metadata).toMatchObject({
        to: 'other@example.com',
        fromSummary: 'Eddie Chen',
        toSummary: null,
      });
    });

    it('stores no summary for a calendar Google does not list', async () => {
      const res = await set({ googleCalendarId: 'unknown@example.com' }).expect(
        200,
      );
      expect(res.body).toMatchObject({ calendarSummary: null });
    });

    it('still saves when listing Google calendars fails', async () => {
      await ctx.app.close();
      ctx = await build(
        fakeGoogle({ error: new GoogleApiError(500, 'backendError', 'boom') }),
      );
      const res = await set({ googleCalendarId: 'eddie@example.com' }).expect(
        200,
      );
      expect(res.body).toMatchObject({
        googleCalendarId: 'eddie@example.com',
        calendarSummary: null,
      });
      expect(ctx.audit.entries).toHaveLength(1);
    });

    it('clears the link with null and audits it', async () => {
      await set({ googleCalendarId: 'eddie@example.com' }).expect(200);
      const res = await set({ googleCalendarId: null }).expect(200);
      expect(res.body).toEqual({
        instructorId: EDDIE_ID,
        googleCalendarId: null,
        calendarSummary: null,
        matchStatus: null,
        updatedAt: null,
      });
      expect(ctx.calendars.rows.has(EDDIE_ID)).toBe(false);
      expect(ctx.audit.entries[1]).toMatchObject({
        action: 'instructor.google_calendar_update',
        targetId: EDDIE_ID,
        metadata: {
          from: 'eddie@example.com',
          to: null,
          fromStatus: 'confirmed',
          toStatus: null,
          fromSummary: 'Eddie Chen',
          toSummary: null,
        },
      });

      await set({ googleCalendarId: null }).expect(200);
      expect(ctx.audit.entries).toHaveLength(2);
    });

    it('is 409 when the calendar belongs to another instructor', async () => {
      await set({ googleCalendarId: 'shared@example.com' }).expect(200);
      const res = await set(
        { googleCalendarId: 'shared@example.com' },
        ERIC_ID,
      ).expect(409);
      expect((res.body as { message: string }).message).toBe(
        CALENDAR_ALREADY_LINKED,
      );
      expect(ctx.calendars.rows.has(ERIC_ID)).toBe(false);
      expect(ctx.audit.entries).toHaveLength(1);
    });

    it('is 404 for an unknown instructor', async () => {
      await set({ googleCalendarId: 'x@example.com' }, UNKNOWN_ID).expect(404);
      expect(ctx.audit.entries).toEqual([]);
    });

    it.each([
      [{}],
      [{ googleCalendarId: '' }],
      [{ googleCalendarId: 'two words' }],
      [{ googleCalendarId: 42 }],
      [{ googleCalendarId: 'a'.repeat(321) }],
      [{ googleCalendarId: 'x@example.com', matchStatus: 'maybe' }],
      [{ googleCalendarId: 'x@example.com', calendarSummary: 'Eddie' }],
    ])('rejects %j with 400', async (body) => {
      await set(body).expect(400);
    });

    it('rejects a non-UUID instructor id with 400', async () => {
      await set({ googleCalendarId: 'x@example.com' }, 'eddie').expect(400);
    });
  });

  describe('/admin/instructor-calendars', () => {
    const calendars = [
      {
        id: 'admin@ssnow.club',
        summary: 'admin@ssnow.club',
        accessRole: 'owner',
      },
      {
        id: 'eddie@example.com',
        summary: 'eddie@example.com',
        accessRole: 'reader',
      },
      {
        id: 'eric.wang@gmail.com',
        summary: 'Eric W',
        accessRole: 'freeBusyReader',
      },
    ];

    it('lists every instructor with their link and proposed calendars', async () => {
      ctx = await build(fakeGoogle({ calendars }));
      const res = await http()
        .get('/admin/instructor-calendars')
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toMatchObject({
        google: { connected: true, error: null },
        instructors: [
          {
            instructorId: EDDIE_ID,
            displayNameEn: 'Eddie Chen',
            googleCalendarId: null,
            suggestion: { calendarId: 'eddie@example.com', matchedBy: 'email' },
          },
          {
            instructorId: ERIC_ID,
            suggestion: {
              calendarId: 'eric.wang@gmail.com',
              matchedBy: 'name',
            },
          },
        ],
      });
    });

    it('still lists links when Google is not connected or fails', async () => {
      ctx = await build(fakeGoogle({ connected: false }));
      ctx.calendars.rows.set(EDDIE_ID, {
        instructor_id: EDDIE_ID,
        google_calendar_id: 'eddie@example.com',
        calendar_summary: null,
        match_status: 'confirmed',
        updated_at: '2026-10-10T00:00:00.000Z',
        updated_by: null,
      });
      const offline = await http()
        .get('/admin/instructor-calendars')
        .set('Authorization', admin)
        .expect(200);
      expect(offline.body).toMatchObject({
        google: { connected: false, error: null },
        instructors: [
          { googleCalendarId: 'eddie@example.com', candidates: [] },
          { googleCalendarId: null, candidates: [] },
        ],
      });
      expect(ctx.google.listCalendars).not.toHaveBeenCalled();
      await ctx.app.close();

      ctx = await build(
        fakeGoogle({ error: new GoogleApiError(500, 'backendError', 'boom') }),
      );
      const failing = await http()
        .get('/admin/instructor-calendars')
        .set('Authorization', admin)
        .expect(200);
      expect(failing.body).toMatchObject({
        google: { connected: true, error: 'Google Calendar request failed' },
      });
    });

    it('stores unambiguous suggestions for unlinked instructors and audits them', async () => {
      ctx = await build(fakeGoogle({ calendars }));
      ctx.calendars.rows.set(ERIC_ID, {
        instructor_id: ERIC_ID,
        google_calendar_id: 'eric-confirmed@example.com',
        calendar_summary: null,
        match_status: 'confirmed',
        updated_at: '2026-10-10T00:00:00.000Z',
        updated_by: null,
      });
      const res = await http()
        .post('/admin/instructor-calendars/suggest')
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toMatchObject({
        suggested: 1,
        overview: {
          instructors: [
            {
              instructorId: EDDIE_ID,
              googleCalendarId: 'eddie@example.com',
              calendarSummary: 'eddie@example.com',
              matchStatus: 'suggested',
            },
            {
              instructorId: ERIC_ID,
              googleCalendarId: 'eric-confirmed@example.com',
              matchStatus: 'confirmed',
            },
          ],
        },
      });
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: 'instructor.google_calendar_suggest',
          metadata: {
            suggested: [
              { instructorId: EDDIE_ID, googleCalendarId: 'eddie@example.com' },
            ],
          },
        }),
      ]);

      const again = await http()
        .post('/admin/instructor-calendars/suggest')
        .set('Authorization', admin)
        .expect(200);
      expect((again.body as { suggested: number }).suggested).toBe(0);
      expect(ctx.audit.entries).toHaveLength(1);
    });

    it('is 409 when Google is not connected', async () => {
      ctx = await build(fakeGoogle({ connected: false }));
      await http()
        .post('/admin/instructor-calendars/suggest')
        .set('Authorization', admin)
        .expect(409);
    });
  });
});
