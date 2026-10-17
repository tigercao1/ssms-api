import {
  type BookingCustomerRow,
  type BookingInstructorRow,
  type BookingLessonTypeRow,
  type BookingLocationRow,
  BookingRepository,
  type BookingSettingsRow,
  type BookingSettingsWrite,
  type BusyClassRow,
  type CalendarLinkRow,
  type ClassBooking,
  type ClassRebooking,
  type EventDeletionRow,
  type SeriesBooking,
  type SyncCandidateRow,
  type SyncFinish,
  type SyncResult,
} from '../../src/booking/booking.repository';
import { classEventId } from '../../src/booking/calendar-sync.service';
import { DatabaseError } from '../../src/database/db-result';
import { GoogleApiError } from '../../src/google/google.errors';
import type {
  FreeBusyResult,
  GoogleCalendar,
  GoogleEventInput,
} from '../../src/google/google.types';
import type { GoogleCalendarClient } from '../../src/google/google-calendar.client';
import type { ClassRow } from '../../src/lessons/classes.repository';
import type { ClassStatus } from '../../src/lessons/lessons.types';

export const AMY_ID = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
export const BEN_ID = '1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e';
export const CAL_ID = '2c3d4e5f-6a7b-4c8d-8e9f-0a1b2c3d4e5f';
export const DEV_ID = '3d4e5f6a-7b8c-4d9e-9f0a-1b2c3d4e5f6a';
export const EVA_ID = '4e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b';
export const PRIVATE_1H = '5f6a7b8c-9d0e-4f1a-9b2c-3d4e5f6a7b8c';
export const GROUP_90 = '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d';
export const RETIRED_TYPE = '7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
export const MEI_ID = '8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f';
export const LEO_ID = '9d0e1f2a-3b4c-4d5e-9f6a-7b8c9d0e1f2a';
export const BLUE_ID = 'ae1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b';

export const AMY_CAL = 'amy@group.calendar.google.com';
export const BEN_CAL = 'ben@group.calendar.google.com';
export const CAL_CAL = 'cal@group.calendar.google.com';
export const DEV_CAL = 'dev@group.calendar.google.com';

let sequence = 0;
const nextEventId = () => `ev${String(++sequence).padStart(6, '0')}`;

export function bookingSupabase(
  results: Record<string, { data: unknown; error: unknown } | undefined> = {},
) {
  const queries: { table: string; ops: unknown[][] }[] = [];
  const rpcs: { name: string; args: unknown }[] = [];
  const builder = (key: string, ops: unknown[][]) => {
    const b: Record<string, unknown> = {
      then: (resolve: (r: unknown) => unknown) =>
        Promise.resolve(results[key] ?? { data: null, error: null }).then(
          resolve,
        ),
    };
    for (const op of [
      'select',
      'eq',
      'neq',
      'in',
      'gt',
      'lt',
      'order',
      'limit',
      'update',
      'delete',
      'maybeSingle',
    ]) {
      b[op] = (...args: unknown[]) => {
        ops.push([op, ...args]);
        return b;
      };
    }
    return b;
  };
  const client = {
    from(table: string) {
      const query = { table, ops: [] as unknown[][] };
      queries.push(query);
      return builder(table, query.ops);
    },
    rpc(name: string, args: unknown) {
      rpcs.push({ name, args });
      return Promise.resolve(
        results[`rpc:${name}`] ?? { data: null, error: null },
      );
    },
  };
  return { client: client as never, queries, rpcs };
}

export function fakeBookingGoogle(
  options: {
    connected?: boolean;
    calendars?: GoogleCalendar[];
  } = {},
) {
  const busy = new Map<string, { start: string; end: string }[]>();
  const calendarErrors = new Map<string, string>();
  const isConnected = jest.fn(() => Promise.resolve(options.connected ?? true));
  const listCalendars = jest.fn(() =>
    Promise.resolve(
      options.calendars ?? [
        { id: AMY_CAL, summary: 'Amy', accessRole: 'owner' },
        { id: BEN_CAL, summary: 'Ben', accessRole: 'writer' },
        { id: DEV_CAL, summary: 'Dev', accessRole: 'reader' },
      ],
    ),
  );
  const freeBusy = jest.fn(
    (
      ids: string[],
      timeMin: string,
      timeMax: string,
    ): Promise<FreeBusyResult> =>
      Promise.resolve({
        timeMin,
        timeMax,
        calendars: ids.map((id) => ({
          id,
          busy: (busy.get(id) ?? [])
            .filter((b) => b.start < timeMax && b.end > timeMin)
            .map((b) => ({
              start: b.start < timeMin ? timeMin : b.start,
              end: b.end > timeMax ? timeMax : b.end,
            })),
          errors: calendarErrors.has(id)
            ? [{ domain: 'calendar', reason: calendarErrors.get(id)! }]
            : [],
        })),
      }),
  );
  const events = new Map<string, GoogleEventInput>();
  const key = (calendarId: string, eventId: string) =>
    `${calendarId}/${eventId}`;
  const toEvent = (eventId: string, event: GoogleEventInput) => ({
    id: eventId,
    status: 'confirmed',
    htmlLink: null,
    summary: event.summary ?? null,
    start: event.start ?? null,
    end: event.end ?? null,
    ssmsClassId: event.ssmsClassId ?? null,
  });
  const insertEvent = jest.fn(
    (
      calendarId: string,
      event: GoogleEventInput,
      options: { eventId?: string } = {},
    ) => {
      const eventId = options.eventId ?? nextEventId();
      if (events.has(key(calendarId, eventId))) {
        return Promise.reject(
          new GoogleApiError(409, 'duplicate', 'Event id already exists'),
        );
      }
      events.set(key(calendarId, eventId), event);
      return Promise.resolve(toEvent(eventId, event));
    },
  );
  const patchEvent = jest.fn(
    (calendarId: string, eventId: string, event: GoogleEventInput) => {
      const current = events.get(key(calendarId, eventId));
      if (!current) {
        return Promise.reject(new GoogleApiError(404, 'notFound', 'Not Found'));
      }
      const merged = { ...current, ...event };
      events.set(key(calendarId, eventId), merged);
      return Promise.resolve(toEvent(eventId, merged));
    },
  );
  const deleteEvent = jest.fn((calendarId: string, eventId: string) => {
    events.delete(key(calendarId, eventId));
    return Promise.resolve();
  });
  return {
    client: {
      isConnected,
      listCalendars,
      freeBusy,
      insertEvent,
      patchEvent,
      deleteEvent,
    } as unknown as GoogleCalendarClient,
    busy,
    calendarErrors,
    events,
    isConnected,
    listCalendars,
    freeBusy,
    insertEvent,
    patchEvent,
    deleteEvent,
  };
}

const instructor = (
  id: string,
  name: string,
  overrides: Partial<BookingInstructorRow> = {},
): BookingInstructorRow => ({
  id,
  display_name_en: name,
  display_name_zh: null,
  approval_status: 'approved',
  is_active: true,
  ...overrides,
});

export class InMemoryBookingRepository extends BookingRepository {
  settings: BookingSettingsRow = {
    day_start_time: '08:00:00',
    day_end_time: '18:00:00',
    slot_minutes: 30,
    weekday_overrides: {},
    updated_at: '2026-10-01T00:00:00.000Z',
  };
  savedBy: (string | null)[] = [];
  instructors: BookingInstructorRow[] = [
    instructor(AMY_ID, 'Amy', { display_name_zh: '艾米' }),
    instructor(BEN_ID, 'Ben'),
    instructor(CAL_ID, 'Cal'),
    instructor(DEV_ID, 'Dev'),
    instructor(EVA_ID, 'Eva', { is_active: false }),
  ];
  links: CalendarLinkRow[] = [
    {
      instructor_id: AMY_ID,
      google_calendar_id: AMY_CAL,
    },
    {
      instructor_id: BEN_ID,
      google_calendar_id: BEN_CAL,
    },
    {
      instructor_id: CAL_ID,
      google_calendar_id: CAL_CAL,
    },
    {
      instructor_id: DEV_ID,
      google_calendar_id: DEV_CAL,
    },
  ];
  lessonTypes: BookingLessonTypeRow[] = [
    {
      id: PRIVATE_1H,
      name_en: 'Private 1h',
      name_zh: '私教1小时',
      duration_min: 60,
      active: true,
    },
    {
      id: GROUP_90,
      name_en: 'Group 90',
      name_zh: null,
      duration_min: 90,
      active: true,
    },
    {
      id: RETIRED_TYPE,
      name_en: 'Retired',
      name_zh: null,
      duration_min: 60,
      active: false,
    },
  ];
  customers: (BookingCustomerRow & { email: string | null })[] = [
    {
      id: MEI_ID,
      first_name: 'Mei',
      last_name: 'Wang',
      phone: '+1 647 555 0100',
      email: 'mei@example.com',
    },
    {
      id: LEO_ID,
      first_name: 'Leo',
      last_name: 'Chen',
      phone: null,
      email: null,
    },
  ];
  locations: BookingLocationRow[] = [{ id: BLUE_ID, name: 'Blue Mountain' }];
  classes: (ClassRow & { series_id: string | null; customer_ids: string[] })[] =
    [];
  series: SeriesBooking[] = [];
  deletions: EventDeletionRow[] = [];
  failNext?: DatabaseError;
  now: () => number = () => Date.parse('2026-12-10T17:00:00.000Z');
  private tick = 0;
  private deletionSeq = 0;

  getSettings(): Promise<BookingSettingsRow> {
    return Promise.resolve({ ...this.settings });
  }

  saveSettings(
    write: BookingSettingsWrite,
    userId: string | null,
  ): Promise<BookingSettingsRow> {
    this.savedBy.push(userId);
    this.settings = {
      day_start_time: `${write.day_start_time}:00`,
      day_end_time: `${write.day_end_time}:00`,
      slot_minutes: write.slot_minutes,
      weekday_overrides: write.weekday_overrides,
      updated_at: '2026-10-02T00:00:00.000Z',
    };
    return this.getSettings();
  }

  listInstructors(ids?: string[]): Promise<BookingInstructorRow[]> {
    return Promise.resolve(
      this.instructors.filter((i) =>
        ids
          ? ids.includes(i.id)
          : i.is_active && i.approval_status === 'approved',
      ),
    );
  }

  listCalendarLinks(instructorIds: string[]): Promise<CalendarLinkRow[]> {
    return Promise.resolve(
      this.links.filter((l) => instructorIds.includes(l.instructor_id)),
    );
  }

  findLessonType(id: string): Promise<BookingLessonTypeRow | null> {
    return Promise.resolve(this.lessonTypes.find((t) => t.id === id) ?? null);
  }

  findCustomers(ids: string[]): Promise<BookingCustomerRow[]> {
    return Promise.resolve(this.customers.filter((c) => ids.includes(c.id)));
  }

  findLocation(id: string): Promise<BookingLocationRow | null> {
    return Promise.resolve(this.locations.find((l) => l.id === id) ?? null);
  }

  findClasses(ids: string[]): Promise<ClassRow[]> {
    return Promise.resolve(
      this.classes
        .filter((c) => ids.includes(c.id))
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
        .map((c) => this.hydrate(c)),
    );
  }

  busyClasses(
    instructorIds: string[],
    from: string,
    to: string,
  ): Promise<BusyClassRow[]> {
    return Promise.resolve(
      this.classes
        .filter(
          (c) =>
            instructorIds.includes(c.instructor_id) &&
            c.status !== 'cancelled' &&
            Date.parse(c.starts_at) < Date.parse(to) &&
            Date.parse(c.ends_at) > Date.parse(from),
        )
        .map(({ id, instructor_id, starts_at, ends_at }) => ({
          id,
          instructor_id,
          starts_at,
          ends_at,
        })),
    );
  }

  lastClassForCustomer(customerId: string): Promise<ClassRow | null> {
    const row = this.classes
      .filter(
        (c) => c.status !== 'cancelled' && c.customer_ids.includes(customerId),
      )
      .sort((a, b) => b.starts_at.localeCompare(a.starts_at))[0];
    return Promise.resolve(row ? this.hydrate(row) : null);
  }

  bookClasses(
    series: SeriesBooking | null,
    classes: ClassBooking[],
  ): Promise<void> {
    this.throwIfFailing();
    for (const c of classes) {
      this.assertFree(c.instructor_id, c.starts_at, c.ends_at, null);
    }
    if (series) {
      this.series.push(series);
    }
    for (const c of classes) {
      this.classes.push(
        this.seed({
          id: c.id,
          instructor_id: c.instructor_id,
          lesson_type_id: c.lesson_type_id,
          location_id: c.location_id,
          starts_at: c.starts_at,
          ends_at: c.ends_at,
          status: c.status,
          google_calendar_id: c.google_calendar_id,
          google_sync_status: c.google_calendar_id ? 'pending' : 'ok',
          notes: c.notes,
          series_id: series?.id ?? null,
          customer_ids: c.customer_ids,
          updated_at: this.stamp(),
        }),
      );
    }
    return Promise.resolve();
  }

  rebookClass(
    id: string,
    rebooking: ClassRebooking,
    customerIds: string[] | null,
  ): Promise<void> {
    this.throwIfFailing();
    this.assertFree(
      rebooking.instructor_id,
      rebooking.starts_at,
      rebooking.ends_at,
      id,
    );
    const row = this.classes.find(
      (c) => c.id === id && c.status !== 'cancelled',
    );
    if (!row) {
      throw new DatabaseError('move class', 'P0002', 'not found or cancelled');
    }
    const calendar = rebooking.google_calendar_id;
    const drop =
      row.google_calendar_id !== null && row.google_calendar_id !== calendar;
    if (drop) {
      this.queueDeletion(
        row.google_calendar_id!,
        row.google_event_id ?? classEventId(row.id, row.google_event_seq),
        row.id,
      );
      row.google_event_id = null;
      row.google_event_seq += 1;
    }
    Object.assign(row, rebooking);
    if (calendar !== null || drop) {
      this.markPending(row);
    }
    if (customerIds) {
      row.customer_ids = customerIds;
    }
    row.updated_at = this.stamp();
    return Promise.resolve();
  }

  setClassStatus(id: string, status: ClassStatus): Promise<void> {
    this.throwIfFailing();
    const row = this.classes.find((c) => c.id === id);
    if (!row) {
      throw new DatabaseError('set class status', 'P0002', 'not found');
    }
    if (row.status === 'cancelled' && status !== 'cancelled') {
      this.assertFree(row.instructor_id, row.starts_at, row.ends_at, id);
    }
    if (status === 'cancelled' && row.status !== 'cancelled') {
      const drop = row.google_calendar_id !== null;
      if (drop) {
        this.queueDeletion(
          row.google_calendar_id!,
          row.google_event_id ?? classEventId(row.id, row.google_event_seq),
          row.id,
        );
        row.google_event_seq += 1;
      }
      row.google_event_id = null;
      this.markPending(row);
      row.google_sync_status = drop ? 'pending' : 'ok';
    } else if (row.status === 'cancelled' && status !== 'cancelled') {
      this.markPending(row);
      row.google_sync_status = row.google_calendar_id ? 'pending' : 'ok';
    }
    row.status = status;
    row.updated_at = this.stamp();
    return Promise.resolve();
  }

  finishSync(
    id: string,
    version: string,
    result: SyncResult,
  ): Promise<SyncFinish> {
    this.throwIfFailing();
    const row = this.classes.find((c) => c.id === id);
    if (result.eventId !== null) {
      if (
        row &&
        row.status !== 'cancelled' &&
        row.google_calendar_id === result.calendarId &&
        (row.google_event_id ?? result.eventId) === result.eventId
      ) {
        row.google_event_id = result.eventId;
      } else {
        this.queueDeletion(result.calendarId!, result.eventId, row ? id : null);
      }
    }
    if (!row) {
      return Promise.resolve('missing');
    }
    if (row.updated_at !== version) {
      return Promise.resolve('stale');
    }
    if (result.error === null) {
      row.google_sync_status = 'ok';
      row.google_sync_error = null;
      row.google_sync_attempts = 0;
      row.google_synced_at = new Date(this.now()).toISOString();
    } else {
      row.google_sync_status = 'failed';
      row.google_sync_error = result.error;
      row.google_sync_attempts += 1;
    }
    row.updated_at = this.stamp();
    return Promise.resolve(result.error === null ? 'ok' : 'failed');
  }

  classDeletions(classId: string): Promise<EventDeletionRow[]> {
    return Promise.resolve(
      this.deletions
        .filter((d) => d.class_id === classId)
        .map((d) => ({ ...d })),
    );
  }

  openDeletions(
    maxAttempts: number,
    limit: number,
  ): Promise<EventDeletionRow[]> {
    return Promise.resolve(
      this.deletions
        .filter((d) => d.attempts < maxAttempts)
        .slice(0, limit)
        .map((d) => ({ ...d })),
    );
  }

  stuckDeletions(limit: number): Promise<EventDeletionRow[]> {
    return Promise.resolve(
      this.deletions
        .filter((d) => d.attempts > 0)
        .slice(0, limit)
        .map((d) => ({ ...d })),
    );
  }

  completeDeletion(id: string): Promise<void> {
    this.deletions = this.deletions.filter((d) => d.id !== id);
    return Promise.resolve();
  }

  failDeletion(
    row: EventDeletionRow,
    error: string,
    at: string,
  ): Promise<void> {
    const stored = this.deletions.find((d) => d.id === row.id);
    if (stored) {
      stored.attempts = row.attempts + 1;
      stored.last_error = error;
      stored.last_attempt_at = at;
    }
    return Promise.resolve();
  }

  classesToSync(
    maxAttempts: number,
    limit: number,
  ): Promise<SyncCandidateRow[]> {
    return Promise.resolve(
      this.classes
        .filter(
          (c) =>
            c.google_sync_status !== 'ok' &&
            c.google_sync_attempts < maxAttempts,
        )
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
        .slice(0, limit)
        .map((c) => ({
          id: c.id,
          google_sync_attempts: c.google_sync_attempts,
          updated_at: c.updated_at,
        })),
    );
  }

  failedClasses(limit: number): Promise<ClassRow[]> {
    return Promise.resolve(
      this.classes
        .filter((c) => c.google_sync_status === 'failed')
        .slice(0, limit)
        .map((c) => this.hydrate(c)),
    );
  }

  queueDeletion(
    calendarId: string,
    eventId: string,
    classId: string | null,
  ): void {
    if (
      this.deletions.some(
        (d) =>
          d.google_calendar_id === calendarId && d.google_event_id === eventId,
      )
    ) {
      return;
    }
    this.deletions.push({
      id: `del-${++this.deletionSeq}`,
      google_calendar_id: calendarId,
      google_event_id: eventId,
      class_id: classId,
      attempts: 0,
      last_error: null,
      last_attempt_at: null,
      created_at: new Date(this.now()).toISOString(),
    });
  }

  private markPending(row: ClassRow): void {
    row.google_sync_status = 'pending';
    row.google_sync_error = null;
    row.google_sync_attempts = 0;
  }

  private stamp(): string {
    const micros = String(++this.tick % 1000).padStart(3, '0');
    return new Date(this.now()).toISOString().replace('Z', `${micros}+00:00`);
  }

  seed(
    overrides: Partial<ClassRow> & {
      id: string;
      starts_at: string;
      ends_at: string;
      series_id?: string | null;
      customer_ids?: string[];
    },
  ): ClassRow & { series_id: string | null; customer_ids: string[] } {
    return {
      instructor_id: AMY_ID,
      lesson_type_id: PRIVATE_1H,
      location_id: null,
      status: 'scheduled',
      source: 'ssms',
      google_calendar_id: null,
      google_event_id: null,
      google_event_seq: 0,
      google_sync_status: 'ok',
      google_sync_error: null,
      google_sync_attempts: 0,
      google_synced_at: null,
      notes: null,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
      instructor: null,
      location: null,
      lesson_type: null,
      participants: null,
      series_id: null,
      customer_ids: [],
      ...overrides,
    };
  }

  add(
    overrides: Parameters<InMemoryBookingRepository['seed']>[0],
  ): ClassRow & { series_id: string | null; customer_ids: string[] } {
    const row = this.seed(overrides);
    this.classes.push(row);
    return row;
  }

  private hydrate(row: ClassRow & { customer_ids: string[] }): ClassRow {
    const instructor = this.instructors.find((i) => i.id === row.instructor_id);
    const lessonType = this.lessonTypes.find(
      (t) => t.id === row.lesson_type_id,
    );
    const location = this.locations.find((l) => l.id === row.location_id);
    const { customer_ids, ...rest } = row;
    return {
      ...rest,
      instructor: instructor
        ? {
            display_name_en: instructor.display_name_en,
            display_name_zh: instructor.display_name_zh,
          }
        : null,
      lesson_type: lessonType
        ? {
            name_en: lessonType.name_en,
            name_zh: lessonType.name_zh,
            duration_min: lessonType.duration_min,
            group_size: null,
            is_promo: false,
          }
        : null,
      location: location ? { name: location.name } : null,
      participants: customer_ids.map((id) => {
        const c = this.customers.find((x) => x.id === id);
        return {
          customer_id: id,
          attendance: 'expected' as const,
          customer: c
            ? {
                first_name: c.first_name,
                last_name: c.last_name,
                email: c.email,
                phone: c.phone,
              }
            : null,
        };
      }),
    };
  }

  private throwIfFailing(): void {
    const failure = this.failNext;
    if (failure) {
      this.failNext = undefined;
      throw failure;
    }
  }

  private assertFree(
    instructorId: string,
    startsAt: string,
    endsAt: string,
    excludeId: string | null,
  ): void {
    const clash = this.classes.some(
      (c) =>
        c.id !== excludeId &&
        c.instructor_id === instructorId &&
        c.status !== 'cancelled' &&
        Date.parse(c.starts_at) < Date.parse(endsAt) &&
        Date.parse(c.ends_at) > Date.parse(startsAt),
    );
    if (clash) {
      throw new DatabaseError(
        'book classes',
        'SB409',
        'overlaps an existing class',
      );
    }
  }
}
