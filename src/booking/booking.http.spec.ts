import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH as admin,
  ADMIN_ID,
  INSTRUCTOR_AUTH,
  startAdminApp,
} from '../../test/helpers/admin-http';
import {
  AMY_CAL,
  AMY_ID,
  BEN_CAL,
  BEN_ID,
  BLUE_ID,
  CAL_ID,
  DEV_ID,
  EVA_ID,
  fakeBookingGoogle,
  GROUP_90,
  InMemoryBookingRepository,
  LEO_ID,
  MEI_ID,
  PRIVATE_1H,
  RETIRED_TYPE,
} from '../../test/helpers/booking-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { DatabaseError } from '../database/db-result';
import {
  GoogleApiError,
  GoogleNotConnectedError,
} from '../google/google.errors';
import { GoogleCalendarClient } from '../google/google-calendar.client';
import type { AdminClass } from '../lessons/classes.service';
import { GOOGLE_NOT_CONNECTED } from '../google/google-error.filter';
import { type Availability, AvailabilityService } from './availability.service';
import {
  BOOKING_CLOCK,
  BookingCalendarsService,
} from './booking-calendars.service';
import { BookingController } from './booking.controller';
import { BookingRepository } from './booking.repository';
import {
  CALENDAR_UNAVAILABLE,
  CLASS_CANCELLED,
  CUSTOMER_NOT_FOUND,
  FUTURE_STATUS,
  GOOGLE_WRITE_FAILED,
  INSTRUCTOR_BUSY,
  INSTRUCTOR_NOT_BOOKABLE,
  INSTRUCTOR_NOT_FOUND,
  LESSON_TYPE_INACTIVE,
  LOCATION_NOT_FOUND,
  NOTHING_TO_UPDATE,
  PAST_REPEAT,
  type BookingConflict,
  BookingService,
} from './booking.service';
import {
  BookingSettingsService,
  SETTINGS_OVERRIDE_INVALID,
  SETTINGS_RANGE_INVALID,
} from './booking-settings.service';

const NOW = Date.parse('2026-12-10T17:00:00.000Z');
const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const CLASS_A = 'c0000000-0000-4000-8000-000000000001';
const CLASS_B = 'c0000000-0000-4000-8000-000000000002';

async function build(google = fakeBookingGoogle()) {
  const repo = new InMemoryBookingRepository();
  const audit = recordingAudit();
  const clock = { value: NOW, now: () => clock.value };
  const app = await startAdminApp(
    Test.createTestingModule({
      controllers: [BookingController],
      providers: [
        BookingService,
        AvailabilityService,
        BookingSettingsService,
        BookingCalendarsService,
        { provide: BookingRepository, useValue: repo },
        { provide: BOOKING_CLOCK, useValue: clock },
        { provide: GoogleCalendarClient, useValue: google.client },
        { provide: AuditService, useValue: audit },
      ],
    }),
  );
  return { app, repo, audit, google, clock };
}

const one = (res: request.Response) => res.body as AdminClass;
const many = (res: request.Response) => res.body as AdminClass[];
const avail = (res: request.Response) => res.body as Availability;
const err = (res: request.Response) =>
  res.body as { message: string; conflicts: BookingConflict[] };

const booking = (overrides: Record<string, unknown> = {}) => ({
  instructorId: AMY_ID,
  lessonTypeId: PRIVATE_1H,
  startsAt: '2026-12-12T15:00:00.000Z',
  customerIds: [MEI_ID],
  ...overrides,
});

describe('booking admin HTTP', () => {
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
      ['GET settings', (r) => r.get('/admin/booking/settings')],
      ['PUT settings', (r) => r.put('/admin/booking/settings').send({})],
      ['GET availability', (r) => r.get('/admin/booking/availability')],
      ['POST class', (r) => r.post('/admin/booking/classes').send({})],
      [
        'PATCH class',
        (r) => r.patch(`/admin/booking/classes/${UNKNOWN_ID}`).send({}),
      ],
      [
        'POST cancel',
        (r) => r.post(`/admin/booking/classes/${UNKNOWN_ID}/cancel`),
      ],
      [
        'POST status',
        (r) => r.post(`/admin/booking/classes/${UNKNOWN_ID}/status`).send({}),
      ],
      ['GET last', (r) => r.get(`/admin/booking/customers/${UNKNOWN_ID}/last`)],
    ];

    it.each(routes)('%s → 401 without a token', async (_name, send) => {
      await send(http()).expect(401);
    });

    it.each(routes)('%s → 403 for a non-admin', async (_name, send) => {
      await send(http()).set('Authorization', INSTRUCTOR_AUTH).expect(403);
    });
  });

  describe('settings', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('returns the defaults', async () => {
      const res = await http()
        .get('/admin/booking/settings')
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toMatchObject({
        dayStartTime: '08:00',
        dayEndTime: '18:00',
        slotMinutes: 30,
        weekdayOverrides: {},
      });
    });

    it('saves new hours and weekday overrides, and audits the change', async () => {
      const res = await http()
        .put('/admin/booking/settings')
        .set('Authorization', admin)
        .send({
          dayStartTime: '09:00',
          dayEndTime: '17:30',
          slotMinutes: 15,
          weekdayOverrides: {
            sat: { start: '07:00', end: '20:00' },
            mon: { closed: true },
          },
        })
        .expect(200);
      expect(res.body).toMatchObject({
        dayStartTime: '09:00',
        dayEndTime: '17:30',
        slotMinutes: 15,
        weekdayOverrides: {
          sat: { start: '07:00', end: '20:00' },
          mon: { closed: true },
        },
      });
      expect(ctx.repo.savedBy).toEqual([ADMIN_ID]);
      expect(ctx.audit.entries).toHaveLength(1);
      expect(ctx.audit.entries[0]).toMatchObject({
        action: 'booking.settings_update',
        targetType: 'booking_settings',
        actor: { userId: ADMIN_ID, role: 'admin' },
        metadata: {
          from: {
            dayStartTime: '08:00',
            slotMinutes: 30,
          },
          to: {
            dayStartTime: '09:00',
            slotMinutes: 15,
          },
        },
      });
    });

    it.each([
      [
        { dayStartTime: '18:00', dayEndTime: '08:00', slotMinutes: 30 },
        SETTINGS_RANGE_INVALID,
      ],
      [
        {
          dayStartTime: '08:00',
          dayEndTime: '18:00',
          slotMinutes: 30,
          weekdayOverrides: { funday: { closed: true } },
        },
        SETTINGS_OVERRIDE_INVALID,
      ],
      [
        {
          dayStartTime: '08:00',
          dayEndTime: '18:00',
          slotMinutes: 30,
          weekdayOverrides: { sat: { start: '12:00', end: '11:00' } },
        },
        SETTINGS_OVERRIDE_INVALID,
      ],
      [
        {
          dayStartTime: '08:00',
          dayEndTime: '18:00',
          slotMinutes: 30,
          weekdayOverrides: { sat: { closed: false } },
        },
        SETTINGS_OVERRIDE_INVALID,
      ],
      [
        {
          dayStartTime: '08:00',
          dayEndTime: '18:00',
          slotMinutes: 30,
          weekdayOverrides: { sat: 'closed' },
        },
        SETTINGS_OVERRIDE_INVALID,
      ],
    ])('rejects invalid settings %j', async (body, message) => {
      const res = await http()
        .put('/admin/booking/settings')
        .set('Authorization', admin)
        .send(body)
        .expect(400);
      expect(err(res).message).toBe(message);
      expect(ctx.audit.entries).toEqual([]);
    });

    it.each([
      { dayStartTime: '8:00', dayEndTime: '18:00', slotMinutes: 30 },
      { dayStartTime: '08:00', dayEndTime: '18:00', slotMinutes: 20 },
      { dayStartTime: '08:00', dayEndTime: '24:00', slotMinutes: 30 },
    ])('rejects malformed settings %j', async (body) => {
      await http()
        .put('/admin/booking/settings')
        .set('Authorization', admin)
        .send(body)
        .expect(400);
    });
  });

  describe('availability', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const get = (query: string) =>
      http()
        .get(`/admin/booking/availability?${query}`)
        .set('Authorization', admin);

    it('lists bookable instructors with free slots and explains the rest', async () => {
      ctx.google.busy.set(AMY_CAL, [
        { start: '2026-12-12T14:00:00Z', end: '2026-12-12T15:00:00Z' },
      ]);
      ctx.repo.add({
        id: CLASS_A,
        instructor_id: BEN_ID,
        starts_at: '2026-12-12T20:00:00.000Z',
        ends_at: '2026-12-12T21:00:00.000Z',
      });
      ctx.repo.add({
        id: CLASS_B,
        instructor_id: BEN_ID,
        status: 'cancelled',
        starts_at: '2026-12-12T13:00:00.000Z',
        ends_at: '2026-12-12T14:00:00.000Z',
      });
      const res = await get(
        `date=2026-12-12&lessonTypeId=${PRIVATE_1H}`,
      ).expect(200);
      expect(res.body).toMatchObject({
        date: '2026-12-12',
        timeZone: 'America/Toronto',
        durationMin: 60,
        slotMinutes: 30,
        window: { start: '08:00', end: '18:00' },
      });
      expect(avail(res).slots).toHaveLength(20);
      expect(avail(res).slots[0]).toBe('2026-12-12T13:00:00.000Z');
      expect(avail(res).slots[19]).toBe('2026-12-12T22:30:00.000Z');
      const [amy, ben] = avail(res).instructors;
      expect(amy.instructorId).toBe(AMY_ID);
      expect(amy.busy).toEqual([
        {
          start: '2026-12-12T14:00:00Z',
          end: '2026-12-12T15:00:00Z',
          source: 'google',
        },
      ]);
      expect(amy.freeSlots).not.toContain('2026-12-12T13:30:00.000Z');
      expect(amy.freeSlots).not.toContain('2026-12-12T14:30:00.000Z');
      expect(amy.freeSlots).toContain('2026-12-12T13:00:00.000Z');
      expect(amy.freeSlots).toContain('2026-12-12T15:00:00.000Z');
      expect(amy.freeSlots).toContain('2026-12-12T22:00:00.000Z');
      expect(amy.freeSlots).not.toContain('2026-12-12T22:30:00.000Z');
      expect(ben.busy).toEqual([
        {
          start: '2026-12-12T20:00:00.000Z',
          end: '2026-12-12T21:00:00.000Z',
          source: 'ssms',
        },
      ]);
      expect(ben.freeSlots).toContain('2026-12-12T13:00:00.000Z');
      expect(ben.freeSlots).not.toContain('2026-12-12T19:30:00.000Z');
      expect(avail(res).unavailable).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            instructorId: CAL_ID,
            reason: 'calendar_not_confirmed',
          }),
          expect.objectContaining({
            instructorId: DEV_ID,
            reason: 'calendar_not_writable',
          }),
        ]),
      );
      expect(
        avail(res).unavailable.map(
          (u: { instructorId: string }) => u.instructorId,
        ),
      ).not.toContain(EVA_ID);
      expect(ctx.google.freeBusy).toHaveBeenCalledTimes(1);
      expect(ctx.google.freeBusy).toHaveBeenCalledWith(
        [AMY_CAL, BEN_CAL],
        '2026-12-12T13:00:00.000Z',
        '2026-12-12T23:00:00.000Z',
      );
    });

    it('reports requested instructors that are inactive or have no calendar', async () => {
      ctx.repo.links = ctx.repo.links.filter((l) => l.instructor_id !== BEN_ID);
      const res = await get(
        `date=2026-12-12&lessonTypeId=${PRIVATE_1H}&instructorIds=${BEN_ID},${EVA_ID}`,
      ).expect(200);
      expect(avail(res).instructors).toEqual([]);
      expect(avail(res).unavailable).toEqual([
        expect.objectContaining({
          instructorId: BEN_ID,
          reason: 'no_calendar',
        }),
        expect.objectContaining({ instructorId: EVA_ID, reason: 'inactive' }),
      ]);
      expect(ctx.google.freeBusy).not.toHaveBeenCalled();
    });

    it('uses the slot grid, weekday override and lesson duration from settings', async () => {
      ctx.repo.settings = {
        ...ctx.repo.settings,
        slot_minutes: 60,
        weekday_overrides: { sat: { start: '10:00', end: '13:00' } },
      };
      const res = await get(
        `date=2026-12-12&lessonTypeId=${GROUP_90}&instructorIds=${AMY_ID}`,
      ).expect(200);
      expect(avail(res).window).toEqual({ start: '10:00', end: '13:00' });
      expect(avail(res).slots).toEqual([
        '2026-12-12T15:00:00.000Z',
        '2026-12-12T16:00:00.000Z',
        '2026-12-12T17:00:00.000Z',
      ]);
      expect(avail(res).instructors[0].freeSlots).toEqual([
        '2026-12-12T15:00:00.000Z',
        '2026-12-12T16:00:00.000Z',
      ]);
    });

    it('returns no slots on a closed weekday without calling Google', async () => {
      ctx.repo.settings = {
        ...ctx.repo.settings,
        weekday_overrides: { sat: { closed: true } },
      };
      const res = await get(
        `date=2026-12-12&lessonTypeId=${PRIVATE_1H}`,
      ).expect(200);
      expect(res.body).toMatchObject({
        window: null,
        slots: [],
        instructors: [],
        unavailable: [],
      });
      expect(ctx.google.freeBusy).not.toHaveBeenCalled();
    });

    it('converts the booking window across the November DST change', async () => {
      ctx.clock.value = Date.parse('2026-10-20T00:00:00Z');
      const before = await get(
        `date=2026-10-31&lessonTypeId=${PRIVATE_1H}&instructorIds=${AMY_ID}`,
      ).expect(200);
      const after = await get(
        `date=2026-11-01&lessonTypeId=${PRIVATE_1H}&instructorIds=${AMY_ID}`,
      ).expect(200);
      expect(avail(before).slots[0]).toBe('2026-10-31T12:00:00.000Z');
      expect(avail(after).slots[0]).toBe('2026-11-01T13:00:00.000Z');
    });

    it('hides slots that have already started today', async () => {
      const res = await get(
        `date=2026-12-10&lessonTypeId=${PRIVATE_1H}&instructorIds=${AMY_ID}`,
      ).expect(200);
      expect(avail(res).slots[0]).toBe('2026-12-10T13:00:00.000Z');
      expect(avail(res).instructors[0].freeSlots[0]).toBe(
        '2026-12-10T17:00:00.000Z',
      );
    });

    it('caches freeBusy for 60 seconds per calendar set and day', async () => {
      const query = `date=2026-12-12&lessonTypeId=${PRIVATE_1H}`;
      await get(query).expect(200);
      await get(query).expect(200);
      expect(ctx.google.freeBusy).toHaveBeenCalledTimes(1);
      expect(ctx.google.listCalendars).toHaveBeenCalledTimes(1);
      await get(`date=2026-12-13&lessonTypeId=${PRIVATE_1H}`).expect(200);
      expect(ctx.google.freeBusy).toHaveBeenCalledTimes(2);
      ctx.clock.value += 61_000;
      await get(query).expect(200);
      expect(ctx.google.freeBusy).toHaveBeenCalledTimes(3);
      expect(ctx.google.listCalendars).toHaveBeenCalledTimes(2);
    });

    it('does not cache a failed freeBusy call', async () => {
      ctx.google.freeBusy.mockRejectedValueOnce(
        new GoogleApiError(500, 'backendError', 'boom'),
      );
      const query = `date=2026-12-12&lessonTypeId=${PRIVATE_1H}&instructorIds=${AMY_ID}`;
      const failed = await get(query).expect(200);
      expect(avail(failed).unavailable).toEqual([
        expect.objectContaining({
          instructorId: AMY_ID,
          reason: 'google_unavailable',
        }),
      ]);
      const ok = await get(query).expect(200);
      expect(avail(ok).instructors).toHaveLength(1);
    });

    it('marks instructors whose calendar returned an error', async () => {
      ctx.google.calendarErrors.set(AMY_CAL, 'notFound');
      const res = await get(
        `date=2026-12-12&lessonTypeId=${PRIVATE_1H}`,
      ).expect(200);
      expect(
        avail(res).instructors.map(
          (i: { instructorId: string }) => i.instructorId,
        ),
      ).toEqual([BEN_ID]);
      expect(avail(res).unavailable).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            instructorId: AMY_ID,
            reason: 'calendar_error',
          }),
        ]),
      );
    });

    it('lists every calendar instructor as unavailable when Google is not connected', async () => {
      await ctx.app.close();
      ctx = await build(fakeBookingGoogle({ connected: false }));
      const res = await get(
        `date=2026-12-12&lessonTypeId=${PRIVATE_1H}`,
      ).expect(200);
      expect(avail(res).instructors).toEqual([]);
      expect(avail(res).unavailable).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            instructorId: AMY_ID,
            reason: 'google_not_connected',
          }),
          expect.objectContaining({
            instructorId: CAL_ID,
            reason: 'calendar_not_confirmed',
          }),
        ]),
      );
    });

    it('treats a Google calendar list failure as unavailable', async () => {
      ctx.google.listCalendars.mockRejectedValueOnce(
        new GoogleApiError(503, 'backendError', 'down'),
      );
      const res = await get(
        `date=2026-12-12&lessonTypeId=${PRIVATE_1H}&instructorIds=${AMY_ID}`,
      ).expect(200);
      expect(avail(res).unavailable).toEqual([
        expect.objectContaining({ reason: 'google_unavailable' }),
      ]);
    });

    it('validates the query', async () => {
      await get(`date=2026-13-01&lessonTypeId=${PRIVATE_1H}`).expect(400);
      await get('date=2026-12-12').expect(400);
      await get(
        `date=2026-12-12&lessonTypeId=${PRIVATE_1H}&instructorIds=nope`,
      ).expect(400);
      await get(`date=2026-12-12&lessonTypeId=${UNKNOWN_ID}`).expect(404);
    });
  });

  describe('create', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const post = (body: Record<string, unknown>) =>
      http()
        .post('/admin/booking/classes')
        .set('Authorization', admin)
        .send(body);

    it('books a future lesson and writes the Google event without attendees', async () => {
      const res = await post(
        booking({
          customerIds: [MEI_ID, LEO_ID],
          notes: ' bring poles ',
          locationId: BLUE_ID,
        }),
      ).expect(201);
      expect(res.body).toHaveLength(1);
      const [created] = many(res);
      expect(created).toMatchObject({
        instructorId: AMY_ID,
        lessonTypeId: PRIVATE_1H,
        startsAt: '2026-12-12T15:00:00.000Z',
        endsAt: '2026-12-12T16:00:00.000Z',
        status: 'scheduled',
        source: 'ssms',
        locationName: 'Blue Mountain',
        notes: 'bring poles',
        googleCalendarId: AMY_CAL,
      });
      expect(created.googleEventId).toEqual(expect.any(String));
      expect(
        created.participants.map((p: { customerId: string }) => p.customerId),
      ).toEqual([MEI_ID, LEO_ID]);
      expect(ctx.google.insertEvent).toHaveBeenCalledTimes(1);
      const [calendarId, event] = ctx.google.insertEvent.mock.calls[0];
      expect(calendarId).toBe(AMY_CAL);
      expect(event).toEqual({
        summary: 'Private 1h · Mei, Leo',
        description:
          'Private 1h\nMei Wang · +1 647 555 0100\nLeo Chen\nbring poles',
        location: 'Blue Mountain',
        start: {
          dateTime: '2026-12-12T15:00:00.000Z',
          timeZone: 'America/Toronto',
        },
        end: {
          dateTime: '2026-12-12T16:00:00.000Z',
          timeZone: 'America/Toronto',
        },
        ssmsClassId: created.id,
      });
      expect(event).not.toHaveProperty('attendees');
      expect(ctx.google.freeBusy).toHaveBeenCalledWith(
        [AMY_CAL],
        '2026-12-12T15:00:00.000Z',
        '2026-12-12T16:00:00.000Z',
      );
      expect(ctx.audit.entries).toHaveLength(1);
      expect(ctx.audit.entries[0]).toMatchObject({
        action: 'booking.class_create',
        targetType: 'class',
        targetId: created.id,
        metadata: {
          past: false,
          addToCalendar: true,
          status: 'scheduled',
          seriesId: null,
        },
      });
    });

    it('books a weekly series that keeps local time across DST', async () => {
      ctx.clock.value = Date.parse('2026-10-20T00:00:00Z');
      const res = await post(
        booking({
          startsAt: '2026-10-25T14:00:00.000Z',
          repeat: { weekly: true, count: 3 },
        }),
      ).expect(201);
      expect(many(res).map((c: { startsAt: string }) => c.startsAt)).toEqual([
        '2026-10-25T14:00:00.000Z',
        '2026-11-01T15:00:00.000Z',
        '2026-11-08T15:00:00.000Z',
      ]);
      expect(ctx.repo.series).toEqual([
        expect.objectContaining({ count: 3, created_by: ADMIN_ID }),
      ]);
      expect(new Set(ctx.repo.classes.map((c) => c.series_id))).toEqual(
        new Set([ctx.repo.series[0].id]),
      );
      expect(ctx.google.insertEvent).toHaveBeenCalledTimes(3);
    });

    it('refuses a slot that overlaps another SSMS class and creates nothing', async () => {
      ctx.repo.add({
        id: CLASS_A,
        starts_at: '2026-12-12T15:30:00.000Z',
        ends_at: '2026-12-12T16:30:00.000Z',
      });
      const res = await post(booking()).expect(409);
      expect(res.body).toMatchObject({
        message: INSTRUCTOR_BUSY,
        conflicts: [
          {
            occurrence: 0,
            source: 'ssms',
            busyStart: '2026-12-12T15:30:00.000Z',
            busyEnd: '2026-12-12T16:30:00.000Z',
          },
        ],
      });
      expect(ctx.repo.classes).toHaveLength(1);
      expect(ctx.google.insertEvent).not.toHaveBeenCalled();
      expect(ctx.audit.entries).toEqual([]);
    });

    it('refuses a slot that Google reports busy', async () => {
      ctx.google.busy.set(AMY_CAL, [
        { start: '2026-12-12T14:30:00Z', end: '2026-12-12T15:30:00Z' },
      ]);
      const res = await post(booking()).expect(409);
      expect(err(res).conflicts).toEqual([
        expect.objectContaining({
          source: 'google',
          busyStart: '2026-12-12T15:00:00.000Z',
        }),
      ]);
    });

    it('lists which occurrence of a series conflicts and books none of them', async () => {
      ctx.repo.add({
        id: CLASS_A,
        starts_at: '2026-12-19T15:00:00.000Z',
        ends_at: '2026-12-19T16:00:00.000Z',
      });
      const res = await post(
        booking({ repeat: { weekly: true, count: 3 } }),
      ).expect(409);
      expect(err(res).conflicts).toEqual([
        expect.objectContaining({
          occurrence: 1,
          startsAt: '2026-12-19T15:00:00.000Z',
        }),
      ]);
      expect(ctx.repo.classes).toHaveLength(1);
      expect(ctx.repo.series).toEqual([]);
      expect(ctx.google.insertEvent).not.toHaveBeenCalled();
    });

    it('rolls back earlier Google events and returns 502 when Google fails', async () => {
      ctx.google.insertEvent
        .mockResolvedValueOnce({
          id: 'first',
          status: null,
          htmlLink: null,
          summary: null,
          start: null,
          end: null,
          ssmsClassId: null,
        })
        .mockRejectedValueOnce(new GoogleApiError(403, 'forbidden', 'nope'));
      const res = await post(
        booking({ repeat: { weekly: true, count: 2 } }),
      ).expect(502);
      expect(res.body).toMatchObject({
        message: GOOGLE_WRITE_FAILED,
        googleStatus: 403,
        googleReason: 'forbidden',
      });
      expect(ctx.google.deleteEvent).toHaveBeenCalledWith(AMY_CAL, 'first');
      expect(ctx.repo.classes).toEqual([]);
      expect(ctx.audit.entries).toEqual([]);
    });

    it('deletes the new Google events when the database refuses the booking', async () => {
      ctx.repo.failNext = new DatabaseError('book classes', 'SB409', 'raced');
      const res = await post(booking()).expect(409);
      expect(err(res).message).toBe(INSTRUCTOR_BUSY);
      const eventId = (
        (await ctx.google.insertEvent.mock.results[0].value) as { id: string }
      ).id;
      expect(ctx.google.deleteEvent).toHaveBeenCalledWith(AMY_CAL, eventId);
    });

    it('still reports the database error when cleaning up Google fails', async () => {
      ctx.repo.failNext = new DatabaseError('book classes', '23503', 'fk');
      ctx.google.deleteEvent.mockRejectedValueOnce(
        new GoogleApiError(500, 'backendError', 'down'),
      );
      await post(booking()).expect(400);
    });

    it('needs a confirmed, writable calendar to write the event', async () => {
      for (const instructorId of [CAL_ID, DEV_ID]) {
        const res = await post(booking({ instructorId })).expect(409);
        expect(err(res).message).toBe(CALENDAR_UNAVAILABLE);
      }
    });

    it('lets the admin skip the calendar for a future lesson', async () => {
      const res = await post(
        booking({ instructorId: CAL_ID, addToCalendar: false }),
      ).expect(201);
      expect(many(res)[0]).toMatchObject({
        googleEventId: null,
        status: 'scheduled',
      });
      expect(ctx.google.insertEvent).not.toHaveBeenCalled();
    });

    it('surfaces a disconnected Google account as 409', async () => {
      ctx.google.freeBusy.mockRejectedValueOnce(new GoogleNotConnectedError());
      const res = await post(booking()).expect(409);
      expect(err(res).message).toBe(GOOGLE_NOT_CONNECTED);
    });

    it('returns 502 when the freeBusy re-check fails', async () => {
      ctx.google.calendarErrors.set(AMY_CAL, 'notFound');
      const res = await post(booking()).expect(502);
      expect(res.body).toMatchObject({ googleReason: 'notFound' });
    });

    describe('past lessons', () => {
      const past = { startsAt: '2026-12-01T15:00:00.000Z' };

      it('records a past lesson as completed without touching Google', async () => {
        const res = await post(booking(past)).expect(201);
        expect(many(res)[0]).toMatchObject({
          status: 'completed',
          googleEventId: null,
          startsAt: past.startsAt,
        });
        expect(ctx.google.freeBusy).not.toHaveBeenCalled();
        expect(ctx.google.insertEvent).not.toHaveBeenCalled();
        expect(ctx.audit.entries[0].metadata).toMatchObject({
          past: true,
          addToCalendar: false,
          status: 'completed',
        });
      });

      it('accepts an explicit status and an instructor who has since left', async () => {
        const res = await post(
          booking({ ...past, instructorId: EVA_ID, status: 'no_show' }),
        ).expect(201);
        expect(many(res)[0]).toMatchObject({
          status: 'no_show',
          instructorId: EVA_ID,
        });
      });

      it('writes the Google event only when asked', async () => {
        const res = await post(
          booking({ ...past, addToCalendar: true }),
        ).expect(201);
        expect(many(res)[0].googleEventId).toEqual(expect.any(String));
        expect(ctx.google.freeBusy).not.toHaveBeenCalled();
      });

      it('still refuses an overlap with another SSMS class', async () => {
        ctx.repo.add({
          id: CLASS_A,
          starts_at: '2026-12-01T14:30:00.000Z',
          ends_at: '2026-12-01T15:30:00.000Z',
        });
        const res = await post(booking(past)).expect(409);
        expect(err(res).conflicts).toEqual([
          expect.objectContaining({ source: 'ssms' }),
        ]);
      });

      it('ignores cancelled classes when checking overlaps', async () => {
        ctx.repo.add({
          id: CLASS_A,
          status: 'cancelled',
          starts_at: '2026-12-01T15:00:00.000Z',
          ends_at: '2026-12-01T16:00:00.000Z',
        });
        await post(booking(past)).expect(201);
      });

      it('cannot repeat', async () => {
        const res = await post(
          booking({ ...past, repeat: { weekly: true, count: 2 } }),
        ).expect(400);
        expect(err(res).message).toBe(PAST_REPEAT);
      });
    });

    it.each([
      [{ status: 'completed' }, FUTURE_STATUS],
      [{ customerIds: [UNKNOWN_ID] }, CUSTOMER_NOT_FOUND],
      [{ lessonTypeId: RETIRED_TYPE }, LESSON_TYPE_INACTIVE],
      [{ locationId: UNKNOWN_ID }, LOCATION_NOT_FOUND],
      [{ instructorId: EVA_ID }, INSTRUCTOR_NOT_BOOKABLE],
      [{ instructorId: UNKNOWN_ID }, INSTRUCTOR_NOT_FOUND],
    ])('rejects %j', async (overrides, message) => {
      const res = await post(booking(overrides)).expect(400);
      expect(err(res).message).toBe(message);
      expect(ctx.repo.classes).toEqual([]);
    });

    it.each([
      { customerIds: [] },
      { repeat: { weekly: true, count: 13 } },
      { repeat: { weekly: false, count: 2 } },
      { status: 'cancelled' },
      { startsAt: 'tomorrow' },
      { lessonTypeId: UNKNOWN_ID },
      { attendees: ['x@example.com'] },
    ])('validates the body %j', async (overrides) => {
      const res = await post(booking(overrides));
      expect(res.status).toBe(400);
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const patch = (id: string, body: Record<string, unknown>) =>
      http()
        .patch(`/admin/booking/classes/${id}`)
        .set('Authorization', admin)
        .send(body);

    const withEvent = () =>
      ctx.repo.add({
        id: CLASS_A,
        starts_at: '2026-12-12T15:00:00.000Z',
        ends_at: '2026-12-12T16:00:00.000Z',
        google_calendar_id: AMY_CAL,
        google_event_id: 'evA',
        customer_ids: [MEI_ID],
      });

    it('moves a booked lesson and patches its Google event, ignoring its own busy block', async () => {
      withEvent();
      ctx.google.busy.set(AMY_CAL, [
        { start: '2026-12-12T15:00:00Z', end: '2026-12-12T16:00:00Z' },
      ]);
      const res = await patch(CLASS_A, {
        startsAt: '2026-12-12T15:30:00.000Z',
        notes: 'moved',
      }).expect(200);
      expect(res.body).toMatchObject({
        startsAt: '2026-12-12T15:30:00.000Z',
        endsAt: '2026-12-12T16:30:00.000Z',
        notes: 'moved',
        googleEventId: 'evA',
      });
      expect(ctx.google.patchEvent).toHaveBeenCalledWith(
        AMY_CAL,
        'evA',
        expect.objectContaining({
          summary: 'Private 1h · Mei',
          start: {
            dateTime: '2026-12-12T15:30:00.000Z',
            timeZone: 'America/Toronto',
          },
        }),
      );
      expect(ctx.audit.entries).toHaveLength(1);
      expect(ctx.audit.entries[0]).toMatchObject({
        action: 'booking.class_update',
        targetId: CLASS_A,
        metadata: {
          from: { startsAt: '2026-12-12T15:00:00.000Z' },
          to: { startsAt: '2026-12-12T15:30:00.000Z' },
          notesChanged: true,
          googleEvent: 'patched',
        },
      });
    });

    it('refuses to move onto another busy Google block', async () => {
      withEvent();
      ctx.google.busy.set(AMY_CAL, [
        { start: '2026-12-12T15:00:00Z', end: '2026-12-12T17:00:00Z' },
      ]);
      const res = await patch(CLASS_A, {
        startsAt: '2026-12-12T15:30:00.000Z',
      }).expect(409);
      expect(err(res).conflicts).toEqual([
        expect.objectContaining({
          source: 'google',
          busyStart: '2026-12-12T16:00:00.000Z',
        }),
      ]);
      expect(ctx.google.patchEvent).not.toHaveBeenCalled();
    });

    it('refuses to move onto another SSMS class', async () => {
      withEvent();
      ctx.repo.add({
        id: CLASS_B,
        starts_at: '2026-12-12T17:00:00.000Z',
        ends_at: '2026-12-12T18:00:00.000Z',
      });
      await patch(CLASS_A, { startsAt: '2026-12-12T16:30:00.000Z' }).expect(
        409,
      );
      expect(ctx.repo.classes[0].starts_at).toBe('2026-12-12T15:00:00.000Z');
    });

    it('moves the Google event when the instructor changes', async () => {
      withEvent();
      const res = await patch(CLASS_A, { instructorId: BEN_ID }).expect(200);
      expect(res.body).toMatchObject({
        instructorId: BEN_ID,
        googleCalendarId: BEN_CAL,
      });
      expect(one(res).googleEventId).not.toBe('evA');
      expect(ctx.google.insertEvent).toHaveBeenCalledWith(
        BEN_CAL,
        expect.anything(),
      );
      expect(ctx.google.deleteEvent).toHaveBeenCalledWith(AMY_CAL, 'evA');
      expect(ctx.audit.entries[0].metadata).toMatchObject({
        googleEvent: 'moved',
      });
    });

    it('needs a writable calendar to move the event to a new instructor', async () => {
      withEvent();
      const res = await patch(CLASS_A, { instructorId: DEV_ID }).expect(409);
      expect(err(res).message).toBe(CALENDAR_UNAVAILABLE);
    });

    it('edits a past imported lesson without touching Google', async () => {
      ctx.repo.add({
        id: CLASS_A,
        source: 'app_import',
        status: 'completed',
        lesson_type_id: null,
        starts_at: '2025-12-20T15:00:00.000Z',
        ends_at: '2025-12-20T16:00:00.000Z',
      });
      const res = await patch(CLASS_A, {
        lessonTypeId: GROUP_90,
        customerIds: [LEO_ID],
        startsAt: '2025-12-20T14:00:00.000Z',
        instructorId: EVA_ID,
      }).expect(200);
      expect(res.body).toMatchObject({
        lessonTypeId: GROUP_90,
        instructorId: EVA_ID,
        startsAt: '2025-12-20T14:00:00.000Z',
        endsAt: '2025-12-20T15:30:00.000Z',
        status: 'completed',
        googleEventId: null,
      });
      expect(
        one(res).participants.map((p: { customerId: string }) => p.customerId),
      ).toEqual([LEO_ID]);
      expect(ctx.google.freeBusy).not.toHaveBeenCalled();
      expect(ctx.google.patchEvent).not.toHaveBeenCalled();
      expect(ctx.google.insertEvent).not.toHaveBeenCalled();
    });

    it('keeps the existing duration when only the time changes', async () => {
      ctx.repo.add({
        id: CLASS_A,
        starts_at: '2025-12-20T15:00:00.000Z',
        ends_at: '2025-12-20T17:00:00.000Z',
      });
      const res = await patch(CLASS_A, {
        startsAt: '2025-12-21T15:00:00.000Z',
      }).expect(200);
      expect(one(res).endsAt).toBe('2025-12-21T17:00:00.000Z');
    });

    it('returns 502 and leaves the class alone when Google refuses the patch', async () => {
      withEvent();
      ctx.google.patchEvent.mockRejectedValueOnce(
        new GoogleApiError(404, 'notFound', 'gone'),
      );
      const res = await patch(CLASS_A, {
        startsAt: '2026-12-12T17:00:00.000Z',
      }).expect(502);
      expect(res.body).toMatchObject({ googleStatus: 404 });
      expect(ctx.repo.classes[0].starts_at).toBe('2026-12-12T15:00:00.000Z');
    });

    it('restores the Google event when the database refuses the move', async () => {
      withEvent();
      ctx.repo.failNext = new DatabaseError('move class', 'SB409', 'raced');
      await patch(CLASS_A, { startsAt: '2026-12-12T17:00:00.000Z' }).expect(
        409,
      );
      expect(ctx.google.patchEvent).toHaveBeenCalledTimes(2);
      expect(ctx.google.patchEvent.mock.calls[1][2]).toMatchObject({
        start: {
          dateTime: '2026-12-12T15:00:00.000Z',
          timeZone: 'America/Toronto',
        },
      });
    });

    it('deletes the new event when the database refuses an instructor change', async () => {
      withEvent();
      ctx.repo.failNext = new DatabaseError(
        'move class',
        'P0002',
        'cancelled meanwhile',
      );
      const res = await patch(CLASS_A, { instructorId: BEN_ID }).expect(409);
      expect(err(res).message).toBe(CLASS_CANCELLED);
      const newEvent = (
        (await ctx.google.insertEvent.mock.results[0].value) as { id: string }
      ).id;
      expect(ctx.google.deleteEvent).toHaveBeenCalledWith(BEN_CAL, newEvent);
      expect(ctx.google.deleteEvent).not.toHaveBeenCalledWith(AMY_CAL, 'evA');
    });

    it('refuses cancelled, unknown and empty updates', async () => {
      ctx.repo.add({
        id: CLASS_A,
        status: 'cancelled',
        starts_at: '2026-12-12T15:00:00.000Z',
        ends_at: '2026-12-12T16:00:00.000Z',
      });
      expect(
        err(await patch(CLASS_A, { notes: 'x' }).expect(409)).message,
      ).toBe(CLASS_CANCELLED);
      await patch(UNKNOWN_ID, { notes: 'x' }).expect(404);
      expect(err(await patch(CLASS_A, {}).expect(400)).message).toBe(
        NOTHING_TO_UPDATE,
      );
      await patch(CLASS_A, { status: 'completed' }).expect(400);
    });

    it('rejects unknown references', async () => {
      withEvent();
      await patch(CLASS_A, { lessonTypeId: UNKNOWN_ID }).expect(400);
      await patch(CLASS_A, { instructorId: UNKNOWN_ID }).expect(400);
      await patch(CLASS_A, { customerIds: [UNKNOWN_ID] }).expect(400);
    });
  });

  describe('cancel and status', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const cancel = (id: string) =>
      http()
        .post(`/admin/booking/classes/${id}/cancel`)
        .set('Authorization', admin);
    const status = (id: string, value: string) =>
      http()
        .post(`/admin/booking/classes/${id}/status`)
        .set('Authorization', admin)
        .send({ status: value });

    it('cancels a class and deletes its Google event', async () => {
      ctx.repo.add({
        id: CLASS_A,
        starts_at: '2026-12-12T15:00:00.000Z',
        ends_at: '2026-12-12T16:00:00.000Z',
        google_calendar_id: AMY_CAL,
        google_event_id: 'evA',
      });
      const res = await cancel(CLASS_A).expect(200);
      expect(res.body).toMatchObject({
        status: 'cancelled',
        googleEventId: null,
      });
      expect(ctx.google.deleteEvent).toHaveBeenCalledWith(AMY_CAL, 'evA');
      expect(ctx.audit.entries).toHaveLength(1);
      expect(ctx.audit.entries[0]).toMatchObject({
        action: 'booking.class_cancel',
        targetId: CLASS_A,
        metadata: {
          from: 'scheduled',
          googleEventDeleted: true,
        },
      });
    });

    it('keeps the class when Google fails to delete the event', async () => {
      ctx.repo.add({
        id: CLASS_A,
        starts_at: '2026-12-12T15:00:00.000Z',
        ends_at: '2026-12-12T16:00:00.000Z',
        google_calendar_id: AMY_CAL,
        google_event_id: 'evA',
      });
      ctx.google.deleteEvent.mockRejectedValueOnce(
        new GoogleApiError(500, 'backendError', 'down'),
      );
      await cancel(CLASS_A).expect(502);
      expect(ctx.repo.classes[0].status).toBe('scheduled');
    });

    it('cancels a class without a Google event and is idempotent', async () => {
      ctx.repo.add({
        id: CLASS_A,
        starts_at: '2025-12-12T15:00:00.000Z',
        ends_at: '2025-12-12T16:00:00.000Z',
      });
      await cancel(CLASS_A).expect(200);
      await cancel(CLASS_A).expect(200);
      expect(ctx.google.deleteEvent).not.toHaveBeenCalled();
      expect(ctx.audit.entries).toHaveLength(1);
      await cancel(UNKNOWN_ID).expect(404);
    });

    it('marks a lesson completed or no-show and audits it', async () => {
      ctx.repo.add({
        id: CLASS_A,
        starts_at: '2026-12-01T15:00:00.000Z',
        ends_at: '2026-12-01T16:00:00.000Z',
      });
      expect(one(await status(CLASS_A, 'no_show').expect(200)).status).toBe(
        'no_show',
      );
      expect(one(await status(CLASS_A, 'no_show').expect(200)).status).toBe(
        'no_show',
      );
      expect(one(await status(CLASS_A, 'completed').expect(200)).status).toBe(
        'completed',
      );
      expect(ctx.audit.entries.map((e) => e.metadata)).toEqual([
        { from: 'scheduled', to: 'no_show' },
        { from: 'no_show', to: 'completed' },
      ]);
    });

    it('restores a cancelled lesson unless the slot was taken', async () => {
      ctx.repo.add({
        id: CLASS_A,
        status: 'cancelled',
        starts_at: '2026-12-01T15:00:00.000Z',
        ends_at: '2026-12-01T16:00:00.000Z',
      });
      ctx.repo.add({
        id: CLASS_B,
        starts_at: '2026-12-01T15:30:00.000Z',
        ends_at: '2026-12-01T16:30:00.000Z',
      });
      expect(err(await status(CLASS_A, 'completed').expect(409)).message).toBe(
        INSTRUCTOR_BUSY,
      );
      await cancel(CLASS_B).expect(200);
      expect(one(await status(CLASS_A, 'completed').expect(200)).status).toBe(
        'completed',
      );
    });

    it('validates the status', async () => {
      await status(CLASS_A, 'cancelled').expect(400);
      await status(UNKNOWN_ID, 'completed').expect(404);
    });
  });

  describe('same as last time', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const last = (id: string) =>
      http()
        .get(`/admin/booking/customers/${id}/last`)
        .set('Authorization', admin);

    it("returns the customer's most recent non-cancelled class in school time", async () => {
      ctx.repo.add({
        id: CLASS_A,
        instructor_id: BEN_ID,
        lesson_type_id: GROUP_90,
        starts_at: '2026-12-05T15:30:00.000Z',
        ends_at: '2026-12-05T17:00:00.000Z',
        customer_ids: [MEI_ID],
      });
      ctx.repo.add({
        id: CLASS_B,
        status: 'cancelled',
        starts_at: '2026-12-08T15:00:00.000Z',
        ends_at: '2026-12-08T16:00:00.000Z',
        customer_ids: [MEI_ID],
      });
      const res = await last(MEI_ID).expect(200);
      expect(res.body).toEqual({
        last: {
          classId: CLASS_A,
          startsAt: '2026-12-05T15:30:00.000Z',
          weekday: 'sat',
          time: '10:30',
          lessonTypeId: GROUP_90,
          lessonTypeNameEn: 'Group 90',
          lessonTypeNameZh: null,
          instructorId: BEN_ID,
          instructorName: 'Ben',
          instructorNameZh: null,
          locationId: null,
        },
      });
    });

    it('returns null when there is no history and 404 for an unknown customer', async () => {
      expect((await last(LEO_ID).expect(200)).body).toEqual({ last: null });
      await last(UNKNOWN_ID).expect(404);
    });
  });
});
