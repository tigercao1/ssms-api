import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH as admin,
  startAdminApp,
} from '../../test/helpers/admin-http';
import {
  AMY_CAL,
  AMY_ID,
  BEN_ID,
  BLUE_ID,
  fakeBookingGoogle,
  IMMEDIATE_BOOKING_EMAILS,
  InMemoryBookingRepository,
  LEO_ID,
  MEI_ID,
  PRIVATE_1H,
} from '../../test/helpers/booking-fakes';
import {
  FAKE_SENDER_ADDRESS,
  RecordingMailer,
} from '../../test/helpers/mailer-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { GoogleCalendarClient } from '../google/google-calendar.client';
import { MailerService } from '../mailer/mailer.service';
import type { SendEmailRequest } from '../mailer/mailer.types';
import { AvailabilityService } from './availability.service';
import {
  BOOKING_CLOCK,
  BookingCalendarsService,
} from './booking-calendars.service';
import {
  type BatchBookingResult,
  BookingBatchService,
} from './booking-batch.service';
import {
  BookingEmailsService,
  CUSTOMER_EMAIL_MISSING,
  INSTRUCTOR_EMAIL_MISSING,
} from './booking-emails.service';
import { BookingController } from './booking.controller';
import { BookingRepository } from './booking.repository';
import {
  BookingService,
  INSTRUCTOR_BUSY,
  NOTHING_TO_UPDATE,
  type NotifiedClass,
} from './booking.service';
import { CalendarSyncService } from './calendar-sync.service';
import { CalendarSyncWorker } from './calendar-sync.worker';
import { BookingSettingsService } from './booking-settings.service';

const NOW = Date.parse('2026-12-10T17:00:00.000Z');
const CLASS_A = 'c0000000-0000-4000-8000-000000000001';
const BATCH = 'b0000000-0000-4000-8000-000000000001';

async function build(google = fakeBookingGoogle()) {
  const repo = new InMemoryBookingRepository();
  const mailer = new RecordingMailer();
  const clock = { value: NOW, now: () => clock.value };
  repo.now = clock.now;
  const app = await startAdminApp(
    Test.createTestingModule({
      controllers: [BookingController],
      providers: [
        BookingService,
        BookingBatchService,
        BookingEmailsService,
        ...IMMEDIATE_BOOKING_EMAILS,
        AvailabilityService,
        BookingSettingsService,
        BookingCalendarsService,
        CalendarSyncService,
        CalendarSyncWorker,
        { provide: BookingRepository, useValue: repo },
        { provide: BOOKING_CLOCK, useValue: clock },
        { provide: GoogleCalendarClient, useValue: google.client },
        { provide: AuditService, useValue: recordingAudit() },
        { provide: MailerService, useValue: mailer.asService() },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }),
  );
  return { app, repo, mailer, google, clock };
}

const booking = (overrides: Record<string, unknown> = {}) => ({
  instructorId: AMY_ID,
  lessonTypeId: PRIVATE_1H,
  startsAt: '2026-12-12T15:00:00.000Z',
  customerIds: [MEI_ID],
  ...overrides,
});

const ics = (mail: SendEmailRequest, index = 0) =>
  mail.attachments![index].content.toString('utf8').replace(/\r\n /g, '');

const sent = (mailer: RecordingMailer) =>
  mailer.sent.map((m) => [m.template, m.to, m.language]);

describe('booking emails HTTP', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());
  const post = (body: Record<string, unknown>) =>
    http()
      .post('/admin/booking/classes')
      .set('Authorization', admin)
      .send(body);
  const patch = (id: string, body: Record<string, unknown>) =>
    http()
      .patch(`/admin/booking/classes/${id}`)
      .set('Authorization', admin)
      .send(body);
  const cancel = (id: string, body?: Record<string, unknown>) => {
    const req = http()
      .post(`/admin/booking/classes/${id}/cancel`)
      .set('Authorization', admin);
    return body ? req.send(body) : req;
  };
  const created = (res: request.Response) => res.body as NotifiedClass[];
  const one = (res: request.Response) => res.body as NotifiedClass;

  beforeEach(async () => {
    ctx = await build();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  describe('booking', () => {
    it('emails the customer in English and the instructor in their language, with an ICS request', async () => {
      const res = await post(booking({ locationId: BLUE_ID })).expect(201);
      const [lesson] = created(res);
      expect(lesson.warnings).toEqual([]);
      expect(sent(ctx.mailer)).toEqual([
        ['booking.confirmed.customer', 'mei@example.com', 'en'],
        ['booking.confirmed.instructor', 'amy@example.com', 'zh-CN'],
      ]);
      const [customer, instructor] = ctx.mailer.sent;
      expect(customer).toMatchObject({
        mode: 'background',
        instructorId: null,
        metadata: {
          booking: 'confirmed',
          classIds: [lesson.id],
          customerId: MEI_ID,
        },
        vars: {
          displayName: 'Mei',
          lessonNameEn: 'Private 1h',
          instructorNameEn: 'Amy',
          location: 'Blue Mountain',
          lessons: [
            {
              startsAt: '2026-12-12T15:00:00.000Z',
              endsAt: '2026-12-12T16:00:00.000Z',
            },
          ],
        },
      });
      expect(instructor).toMatchObject({
        instructorId: AMY_ID,
        vars: { customerNames: ['Mei Wang'] },
      });
      expect(customer.attachments).toEqual([
        expect.objectContaining({
          filename: 'lesson.ics',
          contentType: 'text/calendar; charset=utf-8; method=REQUEST',
        }),
      ]);
      const calendar = ics(customer);
      expect(calendar).toContain('METHOD:REQUEST');
      expect(calendar).toContain(`UID:class-${lesson.id}@ssnow.club`);
      expect(calendar).toContain('SEQUENCE:0');
      expect(calendar).toContain('DTSTART:20261212T150000Z');
      expect(calendar).toContain('SUMMARY:Private 1h · Amy');
      expect(calendar).toContain('LOCATION:Blue Mountain');
      expect(calendar).toContain(`:mailto:${FAKE_SENDER_ADDRESS}`);
      expect(calendar).toContain('CN="Mei Wang"');
      expect(calendar).toContain('mailto:mei@example.com');
      expect(calendar).toContain('mailto:amy@example.com');
      expect(ics(instructor)).toContain('SUMMARY:Private 1h · Mei Wang');
      expect(customer.idempotencyKey).not.toBe(instructor.idempotencyKey);
    });

    it('does not ask Google to invite anyone', async () => {
      await post(booking()).expect(201);
      const [, event, options] = ctx.google.insertEvent.mock.calls[0];
      expect(event).not.toHaveProperty('attendees');
      expect(options).not.toHaveProperty('sendUpdates');
    });

    it('sends nothing when sendEmails is false', async () => {
      const res = await post(
        booking({ customerIds: [MEI_ID, LEO_ID], sendEmails: false }),
      ).expect(201);
      expect(created(res)[0].warnings).toEqual([]);
      expect(ctx.mailer.sent).toEqual([]);
    });

    it('books, skips the customer email and warns when the customer has no email', async () => {
      const res = await post(booking({ customerIds: [MEI_ID, LEO_ID] })).expect(
        201,
      );
      expect(created(res)[0].warnings).toEqual([
        {
          code: 'customer_email_missing',
          message: CUSTOMER_EMAIL_MISSING,
          customerId: LEO_ID,
        },
      ]);
      expect(ctx.repo.classes).toHaveLength(1);
      expect(sent(ctx.mailer).map(([, to]) => to)).toEqual([
        'mei@example.com',
        'amy@example.com',
      ]);
      expect(ics(ctx.mailer.sent[0])).not.toContain('Leo');
    });

    it('warns when the instructor has no email', async () => {
      ctx.repo.instructors[0].email = ' ';
      const res = await post(booking()).expect(201);
      expect(created(res)[0].warnings).toEqual([
        {
          code: 'instructor_email_missing',
          message: INSTRUCTOR_EMAIL_MISSING,
          instructorId: AMY_ID,
        },
      ]);
      expect(sent(ctx.mailer)).toEqual([
        ['booking.confirmed.customer', 'mei@example.com', 'en'],
      ]);
    });

    it('sends one email per person for a weekly series, with one ICS holding every lesson', async () => {
      const res = await post(
        booking({ repeat: { weekly: true, count: 3 } }),
      ).expect(201);
      expect(ctx.mailer.sent).toHaveLength(2);
      const [customer] = ctx.mailer.sent;
      expect(customer.attachments!.map((a) => a.filename)).toEqual([
        'lessons.ics',
      ]);
      const calendar = ics(customer);
      expect(calendar.match(/BEGIN:VCALENDAR/g)).toHaveLength(1);
      expect(calendar.match(/METHOD:REQUEST/g)).toHaveLength(1);
      expect(calendar.match(/BEGIN:VEVENT/g)).toHaveLength(3);
      expect(calendar.match(/^UID:.*$/gm)).toEqual(
        created(res).map((lesson) => `UID:class-${lesson.id}@ssnow.club`),
      );
      expect(calendar.match(/^SEQUENCE:.*$/gm)).toEqual([
        'SEQUENCE:0',
        'SEQUENCE:0',
        'SEQUENCE:0',
      ]);
    });

    it('keeps the idempotency key of a 12-lesson series within 256 characters', async () => {
      await post(booking({ repeat: { weekly: true, count: 12 } })).expect(201);
      const keys = ctx.mailer.sent.map((m) => [m.template, m.idempotencyKey]);
      expect(keys).toEqual([
        ['booking.confirmed.customer', expect.any(String)],
        ['booking.confirmed.instructor', expect.any(String)],
      ]);
      for (const [, key] of keys) {
        expect(key!.length).toBeLessThanOrEqual(256);
      }
      expect(keys[0][1]).toMatch(
        new RegExp(`^booking:confirmed:customer:${MEI_ID}:[0-9a-f]{64}$`),
      );
      expect(keys[1][1]).toMatch(
        new RegExp(`^booking:confirmed:instructor:${AMY_ID}:[0-9a-f]{64}$`),
      );
    });

    it('still books when the email lookup fails', async () => {
      ctx.repo.findClassNotices = () => Promise.reject(new Error('down'));
      const res = await post(booking()).expect(201);
      expect(created(res)[0].warnings).toEqual([]);
      expect(ctx.repo.classes).toHaveLength(1);
      expect(ctx.mailer.sent).toEqual([]);
    });

    it('emails and warns per batch row, honouring sendEmails per row', async () => {
      const res = await http()
        .post('/admin/booking/classes/batch')
        .set('Authorization', admin)
        .send({
          batchId: BATCH,
          bookings: [
            booking({ customerIds: [LEO_ID] }),
            booking({ instructorId: BEN_ID, sendEmails: false }),
          ],
        })
        .expect(200);
      const { results } = res.body as BatchBookingResult;
      expect(results.map((r) => r.status === 'created' && r.warnings)).toEqual([
        [
          {
            code: 'customer_email_missing',
            message: CUSTOMER_EMAIL_MISSING,
            customerId: LEO_ID,
          },
        ],
        [],
      ]);
      expect(sent(ctx.mailer)).toEqual([
        ['booking.confirmed.instructor', 'amy@example.com', 'zh-CN'],
      ]);
    });
  });

  describe('reschedule and cancel', () => {
    beforeEach(() => {
      ctx.repo.add({
        id: CLASS_A,
        starts_at: '2026-12-12T15:00:00.000Z',
        ends_at: '2026-12-12T16:00:00.000Z',
        customer_ids: [MEI_ID],
      });
    });

    it('emails the new time with the previous one and a higher SEQUENCE', async () => {
      const res = await patch(CLASS_A, {
        startsAt: '2026-12-13T18:00:00.000Z',
      }).expect(200);
      expect(one(res).warnings).toEqual([]);
      expect(sent(ctx.mailer)).toEqual([
        ['booking.rescheduled.customer', 'mei@example.com', 'en'],
        ['booking.rescheduled.instructor', 'amy@example.com', 'zh-CN'],
      ]);
      expect(ctx.mailer.sent[0].vars).toMatchObject({
        lessons: [{ startsAt: '2026-12-13T18:00:00.000Z' }],
        previous: [{ startsAt: '2026-12-12T15:00:00.000Z' }],
      });
      const calendar = ics(ctx.mailer.sent[0]);
      expect(calendar).toContain('METHOD:REQUEST');
      expect(calendar).toContain(`UID:class-${CLASS_A}@ssnow.club`);
      expect(calendar).toContain('SEQUENCE:1');
      expect(calendar).toContain('DTSTART:20261213T180000Z');
    });

    it('cancels for the old instructor and books for the new one', async () => {
      await patch(CLASS_A, { instructorId: BEN_ID }).expect(200);
      expect(sent(ctx.mailer)).toEqual([
        ['booking.cancelled.instructor', 'amy@example.com', 'zh-CN'],
        ['booking.rescheduled.customer', 'mei@example.com', 'en'],
        ['booking.confirmed.instructor', 'ben@example.com', 'en'],
      ]);
      expect(ics(ctx.mailer.sent[0])).toContain('METHOD:CANCEL');
      expect(ics(ctx.mailer.sent[0])).toContain('SEQUENCE:1');
      expect(ctx.mailer.sent[1].vars).not.toHaveProperty('previous');
    });

    it('books added customers, cancels for removed ones and warns about missing emails', async () => {
      ctx.repo.customers.push({
        id: BLUE_ID,
        first_name: 'Ann',
        last_name: null,
        phone: null,
        email: 'ann@example.com',
      });
      const res = await patch(CLASS_A, {
        customerIds: [BLUE_ID, LEO_ID],
      }).expect(200);
      expect(sent(ctx.mailer)).toEqual([
        ['booking.cancelled.customer', 'mei@example.com', 'en'],
        ['booking.confirmed.customer', 'ann@example.com', 'en'],
      ]);
      expect(ics(ctx.mailer.sent[0])).toContain('METHOD:CANCEL');
      expect(ics(ctx.mailer.sent[0])).toContain('SEQUENCE:2');
      expect(one(res).warnings).toEqual([
        expect.objectContaining({
          code: 'customer_email_missing',
          customerId: LEO_ID,
        }),
      ]);
    });

    it('re-invites a removed customer with a higher SEQUENCE and a new idempotency key', async () => {
      const [lesson] = created(
        await post(booking({ instructorId: BEN_ID })).expect(201),
      );
      await patch(lesson.id, { customerIds: [LEO_ID] }).expect(200);
      await patch(lesson.id, { customerIds: [MEI_ID] }).expect(200);
      const mei = ctx.mailer.sent.filter((m) => m.to === 'mei@example.com');
      expect(mei.map((m) => m.template)).toEqual([
        'booking.confirmed.customer',
        'booking.cancelled.customer',
        'booking.confirmed.customer',
      ]);
      const sequences = mei.map((m) =>
        Number(/^SEQUENCE:(\d+)$/m.exec(ics(m))![1]),
      );
      expect(sequences[1]).toBeGreaterThan(sequences[0]);
      expect(sequences[2]).toBeGreaterThan(sequences[1]);
      expect(new Set(mei.map((m) => m.idempotencyKey)).size).toBe(3);
    });

    it('sends nothing for a notes-only edit or when sendEmails is false', async () => {
      await patch(CLASS_A, { notes: 'bring poles' }).expect(200);
      await patch(CLASS_A, {
        startsAt: '2026-12-13T18:00:00.000Z',
        sendEmails: false,
      }).expect(200);
      expect(ctx.mailer.sent).toEqual([]);
    });

    it('refuses an update that only sets sendEmails', async () => {
      const res = await patch(CLASS_A, { sendEmails: true }).expect(400);
      expect((res.body as { message: string }).message).toBe(NOTHING_TO_UPDATE);
    });

    it('emails a cancellation with METHOD:CANCEL', async () => {
      const res = await cancel(CLASS_A).expect(200);
      expect(one(res)).toMatchObject({ status: 'cancelled', warnings: [] });
      expect(sent(ctx.mailer)).toEqual([
        ['booking.cancelled.customer', 'mei@example.com', 'en'],
        ['booking.cancelled.instructor', 'amy@example.com', 'zh-CN'],
      ]);
      const calendar = ics(ctx.mailer.sent[0]);
      expect(ctx.mailer.sent[0].attachments![0].contentType).toBe(
        'text/calendar; charset=utf-8; method=CANCEL',
      );
      expect(calendar).toContain('METHOD:CANCEL');
      expect(calendar).toContain('STATUS:CANCELLED');
      expect(calendar).toContain('SEQUENCE:1');
    });

    it('cancels without emails when sendEmails is false, and only once', async () => {
      await cancel(CLASS_A, { sendEmails: false }).expect(200);
      await cancel(CLASS_A).expect(200);
      expect(ctx.mailer.sent).toEqual([]);
    });

    it('rejects a non-boolean sendEmails', async () => {
      await cancel(CLASS_A, { sendEmails: 'no' }).expect(400);
    });
  });

  describe('lessons in the past', () => {
    const PAST = '2026-12-01T15:00:00.000Z';

    it.each([true, false, undefined])(
      'books a past lesson without emails or warnings (sendEmails %p)',
      async (sendEmails) => {
        const res = await post(
          booking({
            startsAt: PAST,
            customerIds: [MEI_ID, LEO_ID],
            sendEmails,
          }),
        ).expect(201);
        expect(created(res)[0]).toMatchObject({
          startsAt: PAST,
          status: 'completed',
          warnings: [],
        });
        expect(ctx.mailer.sent).toEqual([]);
      },
    );

    it('books past batch rows without emails or warnings', async () => {
      const res = await http()
        .post('/admin/booking/classes/batch')
        .set('Authorization', admin)
        .send({
          batchId: BATCH,
          bookings: [
            booking({ startsAt: PAST, customerIds: [LEO_ID] }),
            booking({ startsAt: PAST, instructorId: BEN_ID, sendEmails: true }),
          ],
        })
        .expect(200);
      const { results } = res.body as BatchBookingResult;
      expect(
        results.map((r) => [r.status, 'warnings' in r && r.warnings]),
      ).toEqual([
        ['created', []],
        ['created', []],
      ]);
      expect(ctx.repo.classes).toHaveLength(2);
      expect(ctx.mailer.sent).toEqual([]);
    });

    it('reschedules to a past start without emails or warnings', async () => {
      ctx.repo.add({
        id: CLASS_A,
        starts_at: '2026-12-12T15:00:00.000Z',
        ends_at: '2026-12-12T16:00:00.000Z',
        customer_ids: [MEI_ID],
      });
      const res = await patch(CLASS_A, {
        startsAt: PAST,
        customerIds: [LEO_ID],
        instructorId: BEN_ID,
        sendEmails: true,
      }).expect(200);
      expect(one(res)).toMatchObject({ startsAt: PAST, warnings: [] });
      expect(ctx.mailer.sent).toEqual([]);
    });

    it('cancels a past lesson without emails or warnings', async () => {
      ctx.repo.add({
        id: CLASS_A,
        status: 'completed',
        starts_at: PAST,
        ends_at: '2026-12-01T16:00:00.000Z',
        customer_ids: [MEI_ID, LEO_ID],
      });
      const res = await cancel(CLASS_A, { sendEmails: true }).expect(200);
      expect(one(res)).toMatchObject({ status: 'cancelled', warnings: [] });
      expect(ctx.mailer.sent).toEqual([]);
    });
  });

  describe('instructor without a Google calendar', () => {
    beforeEach(() => {
      ctx.repo.links = ctx.repo.links.filter((l) => l.instructor_id !== BEN_ID);
    });

    it('books the lesson in SSMS without calling Google', async () => {
      const res = await post(booking({ instructorId: BEN_ID })).expect(201);
      expect(created(res)[0]).toMatchObject({
        instructorId: BEN_ID,
        googleCalendarId: null,
        googleEventId: null,
        calendarSync: 'ok',
      });
      expect(ctx.repo.classes).toHaveLength(1);
      expect(ctx.google.freeBusy).not.toHaveBeenCalled();
      expect(ctx.google.listCalendars).not.toHaveBeenCalled();
      expect(ctx.google.insertEvent).not.toHaveBeenCalled();
      expect(sent(ctx.mailer)).toEqual([
        ['booking.confirmed.customer', 'mei@example.com', 'en'],
        ['booking.confirmed.instructor', 'ben@example.com', 'en'],
      ]);
    });

    it('books even when Google is not connected', async () => {
      await ctx.app.close();
      ctx = await build(fakeBookingGoogle({ connected: false }));
      ctx.repo.links = ctx.repo.links.filter((l) => l.instructor_id !== BEN_ID);
      await post(booking({ instructorId: BEN_ID })).expect(201);
      expect(ctx.google.isConnected).not.toHaveBeenCalled();
    });

    it("still refuses an overlap with the instructor's own SSMS lessons", async () => {
      ctx.repo.add({
        id: CLASS_A,
        instructor_id: BEN_ID,
        starts_at: '2026-12-12T15:30:00.000Z',
        ends_at: '2026-12-12T16:30:00.000Z',
      });
      const res = await post(booking({ instructorId: BEN_ID })).expect(409);
      expect(res.body).toMatchObject({
        message: INSTRUCTOR_BUSY,
        conflicts: [expect.objectContaining({ source: 'ssms' })],
      });
      expect(ctx.google.freeBusy).not.toHaveBeenCalled();
    });

    it('moves a calendared lesson to them and removes the old Google event', async () => {
      ctx.google.events.set(`${AMY_CAL}/evA`, { summary: 'old' });
      ctx.repo.add({
        id: CLASS_A,
        starts_at: '2026-12-12T15:00:00.000Z',
        ends_at: '2026-12-12T16:00:00.000Z',
        google_calendar_id: AMY_CAL,
        google_event_id: 'evA',
        customer_ids: [MEI_ID],
      });
      const res = await patch(CLASS_A, { instructorId: BEN_ID }).expect(200);
      expect(one(res)).toMatchObject({
        instructorId: BEN_ID,
        googleCalendarId: null,
        calendarSync: 'ok',
      });
      expect(ctx.google.deleteEvent).toHaveBeenCalledWith(AMY_CAL, 'evA');
      expect(ctx.google.freeBusy).not.toHaveBeenCalled();
    });
  });
});
