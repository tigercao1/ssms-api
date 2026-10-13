import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import { DatabaseError, PG_FOREIGN_KEY_VIOLATION } from '../database/db-result';
import { GoogleApiError } from '../google/google.errors';
import type { FreeBusyResult, GoogleEventInput } from '../google/google.types';
import { GoogleCalendarClient } from '../google/google-calendar.client';
import type { ClassRow } from '../lessons/classes.repository';
import { type AdminClass, toAdminClass } from '../lessons/classes.service';
import { type Interval, overlapsAny } from './availability.service';
import {
  BOOKING_CLOCK,
  type BookingClock,
  BookingCalendarsService,
} from './booking-calendars.service';
import {
  addDays,
  localParts,
  SCHOOL_TIME_ZONE,
  zonedInstant,
} from './booking-time';
import {
  type BookingCustomerRow,
  type BookingInstructorRow,
  type BookingLessonTypeRow,
  BookingRepository,
  type ClassBooking,
} from './booking.repository';
import type {
  BookableStatus,
  CreateBookingDto,
  UpdateBookingDto,
} from './dto/booking.dto';

export const INSTRUCTOR_NOT_FOUND = 'Instructor not found';
export const INSTRUCTOR_NOT_BOOKABLE =
  'Only active, approved instructors can take new lessons';
export const LESSON_TYPE_NOT_FOUND = 'Lesson type not found';
export const LESSON_TYPE_INACTIVE = 'Lesson type is not active';
export const CUSTOMER_NOT_FOUND = 'Customer not found';
export const LOCATION_NOT_FOUND = 'Location not found';
export const CLASS_NOT_FOUND = 'Class not found';
export const CLASS_CANCELLED = 'Cancelled classes cannot be edited';
export const INSTRUCTOR_BUSY = 'The instructor is not free at that time';
export const CALENDAR_UNAVAILABLE =
  'The instructor has no confirmed, writable Google calendar';
export const PAST_REPEAT = 'Past lessons cannot repeat';
export const FUTURE_STATUS = 'A lesson in the future must be scheduled';
export const NOTHING_TO_UPDATE = 'Nothing to update';
export const REFERENCE_NOT_FOUND = 'A referenced record no longer exists';
export const GOOGLE_WRITE_FAILED = 'Google Calendar request failed';
export const BOOKING_CONFLICT_CODE = 'SB409';
export const PG_NO_DATA_FOUND = 'P0002';

const MINUTE_MS = 60_000;
const DEFAULT_LESSON_NAME = 'Lesson';

export interface BookingConflict {
  occurrence: number;
  startsAt: string;
  endsAt: string;
  busyStart: string;
  busyEnd: string;
  source: 'ssms' | 'google';
}

export interface LastClass {
  classId: string;
  startsAt: string;
  weekday: string;
  time: string;
  lessonTypeId: string | null;
  lessonTypeNameEn: string | null;
  lessonTypeNameZh: string | null;
  instructorId: string;
  instructorName: string | null;
  instructorNameZh: string | null;
  locationId: string | null;
}

interface Occurrence {
  start: Date;
  end: Date;
}

interface EventView {
  classId: string;
  lessonTypeName: string | null;
  customers: Pick<BookingCustomerRow, 'first_name' | 'last_name' | 'phone'>[];
  notes: string | null;
  locationName: string | null;
  start: Date;
  end: Date;
}

interface CalendarEvent {
  calendarId: string;
  eventId: string;
}

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly repo: BookingRepository,
    private readonly calendars: BookingCalendarsService,
    private readonly google: GoogleCalendarClient,
    private readonly audit: AuditService,
    @Inject(BOOKING_CLOCK) private readonly clock: BookingClock,
  ) {}

  async create(
    dto: CreateBookingDto,
    actor: AuditActor,
  ): Promise<AdminClass[]> {
    const start = new Date(dto.startsAt);
    const past = start.getTime() < this.clock.now();
    if (past && dto.repeat) {
      throw new BadRequestException(PAST_REPEAT);
    }
    const status: BookableStatus =
      dto.status ?? (past ? 'completed' : 'scheduled');
    if (!past && status !== 'scheduled') {
      throw new BadRequestException(FUTURE_STATUS);
    }
    const addToCalendar = dto.addToCalendar ?? !past;
    const [lessonType, instructor, customers, location] = await Promise.all([
      this.repo.findLessonType(dto.lessonTypeId),
      this.findInstructor(dto.instructorId),
      this.findCustomers(dto.customerIds),
      dto.locationId ? this.repo.findLocation(dto.locationId) : null,
    ]);
    if (!lessonType) {
      throw new BadRequestException(LESSON_TYPE_NOT_FOUND);
    }
    if (!lessonType.active) {
      throw new BadRequestException(LESSON_TYPE_INACTIVE);
    }
    if (dto.locationId && !location) {
      throw new BadRequestException(LOCATION_NOT_FOUND);
    }
    if (!past && !isBookable(instructor)) {
      throw new BadRequestException(INSTRUCTOR_NOT_BOOKABLE);
    }
    const occurrences = weekly(
      start,
      dto.repeat?.count ?? 1,
      lessonType.duration_min,
    );
    const calendarId = await this.confirmedCalendar(instructor.id);
    if (addToCalendar) {
      await this.requireWritable(calendarId);
    }
    const conflicts = await this.conflicts(
      instructor.id,
      occurrences,
      past ? null : calendarId,
    );
    if (conflicts.length > 0) {
      throw busy(conflicts);
    }

    const seriesId = dto.repeat ? randomUUID() : null;
    const notes = dto.notes?.trim() || null;
    const bookings: ClassBooking[] = occurrences.map((o) => ({
      id: randomUUID(),
      instructor_id: instructor.id,
      lesson_type_id: lessonType.id,
      location_id: location?.id ?? null,
      starts_at: o.start.toISOString(),
      ends_at: o.end.toISOString(),
      status,
      google_calendar_id: null,
      google_event_id: null,
      notes,
      created_by: actor.userId ?? null,
      customer_ids: customers.map((c) => c.id),
    }));
    const inserted: CalendarEvent[] = [];
    if (addToCalendar && calendarId) {
      try {
        for (const booking of bookings) {
          const event = await this.google.insertEvent(
            calendarId,
            eventInput({
              classId: booking.id,
              lessonTypeName: lessonType.name_en,
              customers,
              notes,
              locationName: location?.name ?? null,
              start: new Date(booking.starts_at),
              end: new Date(booking.ends_at),
            }),
          );
          booking.google_calendar_id = calendarId;
          booking.google_event_id = event.id;
          inserted.push({ calendarId, eventId: event.id });
        }
      } catch (err) {
        await this.deleteEvents(inserted);
        throw googleHttp(err);
      }
    }
    try {
      await this.repo.bookClasses(
        seriesId
          ? {
              id: seriesId,
              count: bookings.length,
              created_by: actor.userId ?? null,
            }
          : null,
        bookings,
      );
    } catch (err) {
      await this.deleteEvents(inserted);
      throw databaseHttp(err);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.bookingClassCreate,
      actor: { ...actor, role: 'admin' },
      targetType: 'class',
      targetId: bookings[0].id,
      metadata: {
        classIds: bookings.map((b) => b.id),
        seriesId,
        instructorId: instructor.id,
        lessonTypeId: lessonType.id,
        customerIds: customers.map((c) => c.id),
        startsAt: bookings.map((b) => b.starts_at),
        status,
        past,
        addToCalendar: inserted.length > 0,
      },
    });
    return (await this.repo.findClasses(bookings.map((b) => b.id))).map(
      toAdminClass,
    );
  }

  async update(
    id: string,
    dto: UpdateBookingDto,
    actor: AuditActor,
  ): Promise<AdminClass> {
    if (Object.values(dto).every((v) => v === undefined)) {
      throw new BadRequestException(NOTHING_TO_UPDATE);
    }
    const current = await this.loadClass(id);
    if (current.status === 'cancelled') {
      throw new ConflictException(CLASS_CANCELLED);
    }
    const instructorId = dto.instructorId ?? current.instructor_id;
    const instructorChanged = instructorId !== current.instructor_id;
    let lessonType: BookingLessonTypeRow | null = null;
    if (dto.lessonTypeId) {
      lessonType = await this.repo.findLessonType(dto.lessonTypeId);
      if (!lessonType) {
        throw new BadRequestException(LESSON_TYPE_NOT_FOUND);
      }
    }
    if (instructorChanged) {
      await this.findInstructor(instructorId);
    }
    const customers = dto.customerIds
      ? await this.findCustomers(dto.customerIds)
      : null;
    const previous: Occurrence = {
      start: new Date(current.starts_at),
      end: new Date(current.ends_at),
    };
    const start = dto.startsAt ? new Date(dto.startsAt) : previous.start;
    const durationMs = lessonType
      ? lessonType.duration_min * MINUTE_MS
      : previous.end.getTime() - previous.start.getTime();
    const next: Occurrence = {
      start,
      end: new Date(start.getTime() + durationMs),
    };
    const past = next.start.getTime() < this.clock.now();
    const currentEvent = eventOf(current);
    const calendarId = await this.confirmedCalendar(instructorId);
    if (currentEvent && instructorChanged) {
      await this.requireWritable(calendarId);
    }
    const ownBlock =
      currentEvent && currentEvent.calendarId === calendarId
        ? toInterval(previous)
        : null;
    const conflicts = await this.conflicts(
      instructorId,
      [next],
      past ? null : calendarId,
      { classId: id, ownBlock },
    );
    if (conflicts.length > 0) {
      throw busy(conflicts);
    }

    const notes =
      dto.notes === undefined ? current.notes : dto.notes?.trim() || null;
    const before = viewOf(current);
    const after: EventView = {
      classId: id,
      lessonTypeName: lessonType?.name_en ?? before.lessonTypeName,
      customers: customers ?? before.customers,
      notes,
      locationName: before.locationName,
      start: next.start,
      end: next.end,
    };
    let moved: CalendarEvent | null = null;
    let patched = false;
    if (currentEvent) {
      try {
        if (instructorChanged && calendarId) {
          const event = await this.google.insertEvent(
            calendarId,
            eventInput(after),
          );
          moved = { calendarId, eventId: event.id };
        } else {
          await this.google.patchEvent(
            currentEvent.calendarId,
            currentEvent.eventId,
            eventInput(after),
          );
          patched = true;
        }
      } catch (err) {
        throw googleHttp(err);
      }
    }
    const event = moved ?? currentEvent;
    try {
      await this.repo.rebookClass(
        id,
        {
          instructor_id: instructorId,
          lesson_type_id: lessonType?.id ?? current.lesson_type_id,
          starts_at: next.start.toISOString(),
          ends_at: next.end.toISOString(),
          google_calendar_id: event?.calendarId ?? null,
          google_event_id: event?.eventId ?? null,
          notes,
        },
        customers ? customers.map((c) => c.id) : null,
      );
    } catch (err) {
      if (moved) {
        await this.deleteEvents([moved]);
      }
      if (patched && currentEvent) {
        await this.restoreEvent(currentEvent, before);
      }
      throw databaseHttp(err);
    }
    if (moved && currentEvent) {
      await this.deleteEvents([currentEvent]);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.bookingClassUpdate,
      actor: { ...actor, role: 'admin' },
      targetType: 'class',
      targetId: id,
      metadata: {
        from: {
          instructorId: current.instructor_id,
          lessonTypeId: current.lesson_type_id,
          startsAt: previous.start.toISOString(),
          endsAt: previous.end.toISOString(),
          customerIds: (current.participants ?? []).map((p) => p.customer_id),
        },
        to: {
          instructorId,
          lessonTypeId: lessonType?.id ?? current.lesson_type_id,
          startsAt: next.start.toISOString(),
          endsAt: next.end.toISOString(),
          customerIds: customers
            ? customers.map((c) => c.id)
            : (current.participants ?? []).map((p) => p.customer_id),
        },
        notesChanged: notes !== current.notes,
        googleEvent: moved ? 'moved' : patched ? 'patched' : 'none',
      },
    });
    return toAdminClass(await this.loadClass(id));
  }

  async cancel(id: string, actor: AuditActor): Promise<AdminClass> {
    const current = await this.loadClass(id);
    if (current.status === 'cancelled') {
      return toAdminClass(current);
    }
    const event = eventOf(current);
    if (event) {
      try {
        await this.google.deleteEvent(event.calendarId, event.eventId);
      } catch (err) {
        throw googleHttp(err);
      }
    }
    try {
      await this.repo.setClassStatus(id, 'cancelled');
    } catch (err) {
      throw databaseHttp(err);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.bookingClassCancel,
      actor: { ...actor, role: 'admin' },
      targetType: 'class',
      targetId: id,
      metadata: {
        from: current.status,
        startsAt: current.starts_at,
        instructorId: current.instructor_id,
        googleEventDeleted: Boolean(event),
      },
    });
    return toAdminClass(await this.loadClass(id));
  }

  async setStatus(
    id: string,
    status: BookableStatus,
    actor: AuditActor,
  ): Promise<AdminClass> {
    const current = await this.loadClass(id);
    if (current.status === status) {
      return toAdminClass(current);
    }
    try {
      await this.repo.setClassStatus(id, status);
    } catch (err) {
      throw databaseHttp(err);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.bookingClassStatus,
      actor: { ...actor, role: 'admin' },
      targetType: 'class',
      targetId: id,
      metadata: { from: current.status, to: status },
    });
    return toAdminClass(await this.loadClass(id));
  }

  async lastFor(customerId: string): Promise<{ last: LastClass | null }> {
    const found = await this.repo.findCustomers([customerId]);
    if (found.length === 0) {
      throw new NotFoundException(CUSTOMER_NOT_FOUND);
    }
    const row = await this.repo.lastClassForCustomer(customerId);
    if (!row) {
      return { last: null };
    }
    const local = localParts(row.starts_at);
    return {
      last: {
        classId: row.id,
        startsAt: row.starts_at,
        weekday: local.weekday,
        time: local.time,
        lessonTypeId: row.lesson_type_id,
        lessonTypeNameEn: row.lesson_type?.name_en ?? null,
        lessonTypeNameZh: row.lesson_type?.name_zh ?? null,
        instructorId: row.instructor_id,
        instructorName: row.instructor?.display_name_en ?? null,
        instructorNameZh: row.instructor?.display_name_zh ?? null,
        locationId: row.location_id,
      },
    };
  }

  private async loadClass(id: string): Promise<ClassRow> {
    const [row] = await this.repo.findClasses([id]);
    if (!row) {
      throw new NotFoundException(CLASS_NOT_FOUND);
    }
    return row;
  }

  private async findInstructor(id: string): Promise<BookingInstructorRow> {
    const [row] = await this.repo.listInstructors([id]);
    if (!row) {
      throw new BadRequestException(INSTRUCTOR_NOT_FOUND);
    }
    return row;
  }

  private async findCustomers(ids: string[]): Promise<BookingCustomerRow[]> {
    const rows = await this.repo.findCustomers(ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.map((id) => byId.get(id));
    if (ordered.some((r) => !r)) {
      throw new BadRequestException(CUSTOMER_NOT_FOUND);
    }
    return ordered as BookingCustomerRow[];
  }

  private async confirmedCalendar(
    instructorId: string,
  ): Promise<string | null> {
    const [link] = await this.repo.listCalendarLinks([instructorId]);
    return link?.match_status === 'confirmed' ? link.google_calendar_id : null;
  }

  private async requireWritable(calendarId: string | null): Promise<void> {
    if (
      !calendarId ||
      !(await this.calendars.writableCalendars()).has(calendarId)
    ) {
      throw new ConflictException(CALENDAR_UNAVAILABLE);
    }
  }

  private async conflicts(
    instructorId: string,
    occurrences: Occurrence[],
    calendarId: string | null,
    exclude?: { classId: string; ownBlock: Interval | null },
  ): Promise<BookingConflict[]> {
    const from = occurrences[0].start.toISOString();
    const to = occurrences[occurrences.length - 1].end.toISOString();
    const classes = (
      await this.repo.busyClasses([instructorId], from, to)
    ).filter((c) => c.id !== exclude?.classId);
    const google = calendarId
      ? await this.googleBusy(
          calendarId,
          occurrences,
          exclude?.ownBlock ?? null,
        )
      : occurrences.map(() => []);
    const found: BookingConflict[] = [];
    occurrences.forEach((occurrence, index) => {
      const slot = toInterval(occurrence);
      const blocks: [Interval, 'ssms' | 'google'][] = [
        ...classes.map(
          (c) =>
            [
              { start: Date.parse(c.starts_at), end: Date.parse(c.ends_at) },
              'ssms',
            ] as [Interval, 'ssms'],
        ),
        ...google[index].map((b) => [b, 'google'] as [Interval, 'google']),
      ];
      for (const [block, source] of blocks) {
        if (overlapsAny(slot, [block])) {
          found.push({
            occurrence: index,
            startsAt: occurrence.start.toISOString(),
            endsAt: occurrence.end.toISOString(),
            busyStart: new Date(block.start).toISOString(),
            busyEnd: new Date(block.end).toISOString(),
            source,
          });
        }
      }
    });
    return found;
  }

  private async googleBusy(
    calendarId: string,
    occurrences: Occurrence[],
    ownBlock: Interval | null,
  ): Promise<Interval[][]> {
    let results: FreeBusyResult[];
    try {
      results = await Promise.all(
        occurrences.map((o) =>
          this.calendars.freshFreeBusy(
            [calendarId],
            o.start.toISOString(),
            o.end.toISOString(),
          ),
        ),
      );
    } catch (err) {
      throw googleHttp(err);
    }
    return results.map((result) => {
      const entry = result.calendars.find((c) => c.id === calendarId);
      if (!entry || entry.errors.length > 0) {
        throw googleHttp(
          new GoogleApiError(
            undefined,
            entry?.errors[0]?.reason ?? 'missingFromResponse',
            'freeBusy returned an error for the calendar',
          ),
        );
      }
      return entry.busy.flatMap((b) =>
        subtract(
          { start: Date.parse(b.start), end: Date.parse(b.end) },
          ownBlock,
        ),
      );
    });
  }

  private async deleteEvents(events: CalendarEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await this.google.deleteEvent(event.calendarId, event.eventId);
      } catch (err) {
        this.logger.error(
          `Failed to delete Google event ${event.eventId}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async restoreEvent(
    event: CalendarEvent,
    view: EventView,
  ): Promise<void> {
    try {
      await this.google.patchEvent(
        event.calendarId,
        event.eventId,
        eventInput(view),
      );
    } catch (err) {
      this.logger.error(
        `Failed to restore Google event ${event.eventId}: ${(err as Error).message}`,
      );
    }
  }
}

export function weekly(
  start: Date,
  count: number,
  durationMin: number,
): Occurrence[] {
  const local = localParts(start);
  return Array.from({ length: count }, (_, i) => {
    const at =
      i === 0 ? start : zonedInstant(addDays(local.date, 7 * i), local.time);
    return { start: at, end: new Date(at.getTime() + durationMin * MINUTE_MS) };
  });
}

export function eventInput(view: EventView): GoogleEventInput {
  const name = view.lessonTypeName ?? DEFAULT_LESSON_NAME;
  const firstNames = view.customers
    .map((c) => c.first_name?.trim() || c.last_name?.trim() || '')
    .filter((n) => n.length > 0);
  const people = view.customers.map((c) =>
    [fullName(c), c.phone?.trim()].filter((p) => p).join(' · '),
  );
  return {
    summary:
      firstNames.length > 0 ? `${name} · ${firstNames.join(', ')}` : name,
    description: [name, ...people, view.notes]
      .filter((line): line is string => Boolean(line))
      .join('\n'),
    location: view.locationName ?? undefined,
    start: { dateTime: view.start.toISOString(), timeZone: SCHOOL_TIME_ZONE },
    end: { dateTime: view.end.toISOString(), timeZone: SCHOOL_TIME_ZONE },
    ssmsClassId: view.classId,
  };
}

function fullName(c: Pick<BookingCustomerRow, 'first_name' | 'last_name'>) {
  return [c.first_name?.trim(), c.last_name?.trim()].filter((p) => p).join(' ');
}

function isBookable(instructor: BookingInstructorRow): boolean {
  return instructor.is_active && instructor.approval_status === 'approved';
}

function eventOf(row: ClassRow): CalendarEvent | null {
  return row.google_calendar_id && row.google_event_id
    ? { calendarId: row.google_calendar_id, eventId: row.google_event_id }
    : null;
}

function viewOf(row: ClassRow): EventView {
  return {
    classId: row.id,
    lessonTypeName: row.lesson_type?.name_en ?? null,
    customers: (row.participants ?? []).map((p) => ({
      first_name: p.customer?.first_name ?? null,
      last_name: p.customer?.last_name ?? null,
      phone: p.customer?.phone ?? null,
    })),
    notes: row.notes,
    locationName: row.location?.name ?? null,
    start: new Date(row.starts_at),
    end: new Date(row.ends_at),
  };
}

function toInterval(o: Occurrence): Interval {
  return { start: o.start.getTime(), end: o.end.getTime() };
}

export function subtract(block: Interval, own: Interval | null): Interval[] {
  if (!own || own.end <= block.start || own.start >= block.end) {
    return [block];
  }
  const pieces: Interval[] = [];
  if (block.start < own.start) {
    pieces.push({ start: block.start, end: own.start });
  }
  if (block.end > own.end) {
    pieces.push({ start: own.end, end: block.end });
  }
  return pieces;
}

function busy(conflicts: BookingConflict[]): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: INSTRUCTOR_BUSY,
    conflicts,
  });
}

function googleHttp(err: unknown): unknown {
  if (err instanceof GoogleApiError) {
    return new BadGatewayException({
      statusCode: 502,
      error: 'Bad Gateway',
      message: GOOGLE_WRITE_FAILED,
      googleStatus: err.status ?? null,
      googleReason: err.reason ?? null,
    });
  }
  return err;
}

function databaseHttp(err: unknown): unknown {
  if (!(err instanceof DatabaseError)) {
    return err;
  }
  switch (err.code) {
    case BOOKING_CONFLICT_CODE:
      return busy([]);
    case PG_NO_DATA_FOUND:
      return new ConflictException(CLASS_CANCELLED);
    case PG_FOREIGN_KEY_VIOLATION:
      return new BadRequestException(REFERENCE_NOT_FOUND);
    default:
      return err;
  }
}
