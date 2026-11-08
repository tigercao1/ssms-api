import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  AMY_CAL,
  AMY_ID,
  BEN_ID,
  DEV_ID,
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
  GoogleAuthError,
  GoogleNotConfiguredError,
  GoogleNotConnectedError,
} from '../google/google.errors';
import { GoogleCalendarClient } from '../google/google-calendar.client';
import {
  BATCH_ROW_CONFLICT,
  BATCH_ROW_CONFLICT_MESSAGE,
  type BatchBookingResult,
  BookingBatchService,
  INTERNAL_ERROR,
  rowHash,
} from './booking-batch.service';
import {
  BOOKING_CLOCK,
  BookingCalendarsService,
} from './booking-calendars.service';
import { BookingRepository } from './booking.repository';
import {
  BookingService,
  CALENDAR_UNAVAILABLE,
  CUSTOMER_NOT_FOUND,
  INSTRUCTOR_BUSY,
  LESSON_TYPE_INACTIVE,
} from './booking.service';
import { CalendarSyncService } from './calendar-sync.service';
import type { BatchBookingDto, BookingRowDto } from './dto/booking.dto';

const NOW = Date.parse('2026-12-10T17:00:00.000Z');
const BATCH = 'b0000000-0000-4000-8000-000000000001';
const OTHER_BATCH = 'b0000000-0000-4000-8000-000000000002';
const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const ACTOR = { userId: '7d0f8a1e-5b2c-4e3d-9a8b-1c2d3e4f5a6b', role: 'admin' };

async function build(google = fakeBookingGoogle()) {
  const repo = new InMemoryBookingRepository();
  const audit = recordingAudit();
  const clock = { now: () => NOW };
  repo.now = clock.now;
  const moduleRef = await Test.createTestingModule({
    providers: [
      BookingBatchService,
      BookingService,
      BookingCalendarsService,
      CalendarSyncService,
      { provide: BookingRepository, useValue: repo },
      { provide: BOOKING_CLOCK, useValue: clock },
      { provide: GoogleCalendarClient, useValue: google.client },
      { provide: AuditService, useValue: audit },
      { provide: ConfigService, useValue: { get: () => undefined } },
    ],
  }).compile();
  return { batch: moduleRef.get(BookingBatchService), repo, audit, google };
}

const row = (overrides: Partial<BookingRowDto> = {}): BookingRowDto => ({
  instructorId: AMY_ID,
  lessonTypeId: PRIVATE_1H,
  startsAt: '2026-12-12T15:00:00.000Z',
  customerIds: [MEI_ID],
  ...overrides,
});

const batch = (
  bookings: BookingRowDto[],
  batchId = BATCH,
): BatchBookingDto => ({ batchId, bookings });

const classIds = (result: BatchBookingResult) =>
  result.results.map((r) =>
    r.status === 'created' ? r.classes.map((c) => c.id) : r.code,
  );

describe('BookingBatchService', () => {
  let ctx: Awaited<ReturnType<typeof build>>;

  beforeEach(async () => {
    ctx = await build();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('commits each row on its own and reports results in input order', async () => {
    const result = await ctx.batch.create(
      batch([
        row({ notes: ' first ' }),
        row({ customerIds: [UNKNOWN_ID] }),
        row({ instructorId: BEN_ID, lessonTypeId: RETIRED_TYPE }),
        row({ instructorId: BEN_ID, lessonTypeId: GROUP_90 }),
      ]),
      ACTOR,
    );

    expect(result.batchId).toBe(BATCH);
    expect(result.results).toEqual([
      {
        index: 0,
        status: 'created',
        classes: [
          expect.objectContaining({
            instructorId: AMY_ID,
            notes: 'first',
            googleCalendarId: AMY_CAL,
            calendarSync: 'ok',
          }),
        ],
      },
      {
        index: 1,
        status: 'failed',
        code: 'CUSTOMER_NOT_FOUND',
        message: CUSTOMER_NOT_FOUND,
      },
      {
        index: 2,
        status: 'failed',
        code: 'LESSON_TYPE_INACTIVE',
        message: LESSON_TYPE_INACTIVE,
      },
      {
        index: 3,
        status: 'created',
        classes: [
          expect.objectContaining({ endsAt: '2026-12-12T16:30:00.000Z' }),
        ],
      },
    ]);
    expect(ctx.repo.classes).toHaveLength(2);
    expect(ctx.google.insertEvent).toHaveBeenCalledTimes(2);
    expect(ctx.repo.batchRows.map((r) => r.row_index)).toEqual([0, 3]);
    expect(ctx.audit.entries.map((e) => [e.action, e.metadata?.batch])).toEqual(
      [
        ['booking.class_create', { batchId: BATCH, index: 0 }],
        ['booking.class_create', { batchId: BATCH, index: 3 }],
      ],
    );
  });

  it('refuses a row that overlaps an earlier row of the same batch', async () => {
    const result = await ctx.batch.create(
      batch([
        row(),
        row({ startsAt: '2026-12-12T15:30:00.000Z', customerIds: [LEO_ID] }),
        row({ instructorId: BEN_ID, customerIds: [LEO_ID] }),
      ]),
      ACTOR,
    );

    expect(result.results.map((r) => r.status)).toEqual([
      'created',
      'failed',
      'created',
    ]);
    expect(result.results[1]).toMatchObject({
      code: 'INSTRUCTOR_BUSY',
      message: INSTRUCTOR_BUSY,
    });
    expect(ctx.repo.classes).toHaveLength(2);
  });

  it('replays created rows and retries only the ones that failed', async () => {
    const retried = [
      row(),
      row({ startsAt: '2026-12-12T18:00:00.000Z', customerIds: [UNKNOWN_ID] }),
      row({ instructorId: BEN_ID }),
    ];
    const first = await ctx.batch.create(batch(retried), ACTOR);
    ctx.repo.customers.push({
      id: UNKNOWN_ID,
      first_name: 'Nia',
      last_name: null,
      phone: null,
      email: null,
    });

    const second = await ctx.batch.create(batch(retried), ACTOR);

    expect(second.results.map((r) => r.status)).toEqual([
      'created',
      'created',
      'created',
    ]);
    expect(first.results[1]).toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
    expect(classIds(second)[0]).toEqual(classIds(first)[0]);
    expect(classIds(second)[2]).toEqual(classIds(first)[2]);
    expect(ctx.repo.classes).toHaveLength(3);
    expect(ctx.google.insertEvent).toHaveBeenCalledTimes(3);
    expect(ctx.audit.entries).toHaveLength(3);
  });

  it('treats the same row in another timezone or customer order as a replay', async () => {
    await ctx.batch.create(
      batch([row({ customerIds: [MEI_ID, LEO_ID] })]),
      ACTOR,
    );

    const again = await ctx.batch.create(
      batch([
        row({
          startsAt: '2026-12-12T10:00:00-05:00',
          customerIds: [LEO_ID, MEI_ID],
        }),
      ]),
      ACTOR,
    );

    expect(again.results[0].status).toBe('created');
    expect(ctx.repo.classes).toHaveLength(1);
  });

  it('fails a created row that is resubmitted with different details', async () => {
    const first = await ctx.batch.create(batch([row()]), ACTOR);

    const changed = await ctx.batch.create(
      batch([row({ startsAt: '2026-12-12T18:00:00.000Z' })]),
      ACTOR,
    );

    expect(changed.results).toEqual([
      {
        index: 0,
        status: 'failed',
        code: BATCH_ROW_CONFLICT,
        message: BATCH_ROW_CONFLICT_MESSAGE,
      },
    ]);
    expect(ctx.repo.classes.map((c) => c.id)).toEqual(classIds(first)[0]);
  });

  it('keeps batches apart', async () => {
    await ctx.batch.create(batch([row()]), ACTOR);

    const other = await ctx.batch.create(
      batch([row({ instructorId: BEN_ID })], OTHER_BATCH),
      ACTOR,
    );

    expect(other.results[0].status).toBe('created');
    expect(ctx.repo.classes).toHaveLength(2);
  });

  it('books each row once when the same batch is submitted concurrently', async () => {
    const dto = batch([
      row(),
      row({ instructorId: BEN_ID }),
      row({ instructorId: DEV_ID }),
    ]);

    const [a, b] = await Promise.all([
      ctx.batch.create(dto, ACTOR),
      ctx.batch.create(dto, ACTOR),
    ]);

    expect(ctx.repo.classes).toHaveLength(2);
    expect(ctx.repo.batchRows).toHaveLength(2);
    expect(classIds(a)).toEqual(classIds(b));
    expect(classIds(a)[2]).toBe('CALENDAR_UNAVAILABLE');
    expect(ctx.audit.entries).toHaveLength(2);
    expect(ctx.google.insertEvent).toHaveBeenCalledTimes(2);
  });

  it('returns the stored row when another submit commits it first', async () => {
    const first = await ctx.batch.create(batch([row()]), ACTOR);
    jest.spyOn(ctx.repo, 'findBatchRows').mockResolvedValueOnce([]);
    jest.spyOn(ctx.repo, 'busyClasses').mockResolvedValueOnce([]);

    const again = await ctx.batch.create(batch([row()]), ACTOR);

    expect(classIds(again)).toEqual(classIds(first));
    expect(ctx.repo.classes).toHaveLength(1);
    expect(ctx.audit.entries).toHaveLength(1);
  });

  it('maps Google and unexpected failures to row codes', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    ctx.google.calendarErrors.set(AMY_CAL, 'notFound');

    const result = await ctx.batch.create(
      batch([row(), row({ instructorId: BEN_ID })]),
      ACTOR,
    );
    ctx.repo.failNext = new DatabaseError('book batch row', 'XX000', 'boom');
    const broken = await ctx.batch.create(
      batch(
        [row({ instructorId: BEN_ID, startsAt: '2026-12-13T15:00:00.000Z' })],
        OTHER_BATCH,
      ),
      ACTOR,
    );

    expect(result.results).toEqual([
      expect.objectContaining({
        status: 'failed',
        code: 'GOOGLE_WRITE_FAILED',
      }),
      expect.objectContaining({ status: 'created' }),
    ]);
    expect(broken.results).toEqual([
      expect.objectContaining({ status: 'failed', code: INTERNAL_ERROR }),
    ]);
    expect(ctx.repo.classes).toHaveLength(1);
  });

  it.each([
    [new GoogleNotConnectedError(), 'GOOGLE_NOT_CONNECTED'],
    [
      new GoogleNotConfiguredError(['GOOGLE_CLIENT_ID']),
      'GOOGLE_NOT_CONFIGURED',
    ],
    [new GoogleAuthError(400, 'invalid_grant', ''), 'GOOGLE_WRITE_FAILED'],
  ])('reports %s from the calendar check as %s', async (error, code) => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest
      .spyOn(BookingCalendarsService.prototype, 'writableCalendars')
      .mockRejectedValueOnce(error);

    const result = await ctx.batch.create(batch([row()]), ACTOR);

    expect(result.results[0]).toMatchObject({ status: 'failed', code });
    expect(ctx.repo.classes).toEqual([]);
  });

  it('reports a calendar that cannot be written', async () => {
    const result = await ctx.batch.create(
      batch([row({ instructorId: DEV_ID })]),
      ACTOR,
    );

    expect(result.results[0]).toEqual({
      index: 0,
      status: 'failed',
      code: 'CALENDAR_UNAVAILABLE',
      message: CALENDAR_UNAVAILABLE,
    });
  });

  it('hashes the normalised row', () => {
    expect(rowHash(row({ notes: ' a ' }))).toBe(rowHash(row({ notes: 'a' })));
    expect(rowHash(row({ notes: '' }))).toBe(rowHash(row({ notes: null })));
    expect(rowHash(row({ status: 'scheduled' }))).not.toBe(rowHash(row()));
    expect(rowHash(row({ addToCalendar: false }))).not.toBe(rowHash(row()));
    expect(rowHash(row())).toMatch(/^[0-9a-f]{64}$/);
  });
});
