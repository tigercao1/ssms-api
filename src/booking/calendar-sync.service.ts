import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  GoogleApiError,
  GoogleAuthError,
  GoogleNotConnectedError,
} from '../google/google.errors';
import type { GoogleEventInput } from '../google/google.types';
import { GoogleCalendarClient } from '../google/google-calendar.client';
import type { ClassRow } from '../lessons/classes.repository';
import { type AdminClass, toAdminClass } from '../lessons/classes.service';
import { BOOKING_CLOCK, type BookingClock } from './booking-calendars.service';
import { SCHOOL_TIME_ZONE } from './booking-time';
import {
  BookingRepository,
  type EventDeletionRow,
  type SyncResult,
} from './booking.repository';

export const SYNC_NOT_CONNECTED = 'not_connected';
export const SYNC_INTERNAL_ERROR = 'internal';
const DEFAULT_LESSON_NAME = 'Lesson';
const MAX_SYNC_ERROR_LENGTH = 200;

export type CalendarSync = 'ok' | 'failed';

export interface BookedClass extends AdminClass {
  calendarSync: CalendarSync;
  calendarSyncError: string | null;
}

export interface SyncOutcome {
  calendarSync: CalendarSync;
  error: string | null;
}

interface EventView {
  classId: string;
  lessonTypeName: string | null;
  customers: {
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
  }[];
  notes: string | null;
  locationName: string | null;
  start: Date;
  end: Date;
}

@Injectable()
export class CalendarSyncService {
  private readonly logger = new Logger(CalendarSyncService.name);

  constructor(
    private readonly repo: BookingRepository,
    private readonly google: GoogleCalendarClient,
    @Inject(BOOKING_CLOCK) private readonly clock: BookingClock,
  ) {}

  isConnected(): Promise<boolean> {
    return this.google.isConnected();
  }

  async syncPending(ids: string[]): Promise<void> {
    const rows = await this.load(ids);
    for (const row of rows) {
      if (row.google_sync_status === 'pending') {
        await this.syncRow(row);
      }
    }
  }

  async syncClass(id: string): Promise<SyncOutcome | null> {
    const [row] = await this.load([id]);
    return row ? this.syncRow(row) : null;
  }

  async processDeletions(rows: EventDeletionRow[]): Promise<string | null> {
    let firstError: string | null = null;
    for (const row of rows) {
      try {
        await this.google.deleteEvent(
          row.google_calendar_id,
          row.google_event_id,
        );
        await this.repo.completeDeletion(row.id);
      } catch (err) {
        const code = syncErrorCode(err);
        firstError ??= code;
        this.logger.warn(
          `Could not delete Google event ${row.google_event_id}: ${messageOf(err)}`,
        );
        await this.repo
          .failDeletion(row, code, new Date(this.clock.now()).toISOString())
          .catch((e) =>
            this.logger.error(
              `Could not record deletion failure for ${row.google_event_id}: ${messageOf(e)}`,
            ),
          );
      }
    }
    return firstError;
  }

  private async load(ids: string[]): Promise<ClassRow[]> {
    try {
      return await this.repo.findClasses(ids);
    } catch (err) {
      this.logger.error(`Could not load classes to sync: ${messageOf(err)}`);
      return [];
    }
  }

  private async syncRow(row: ClassRow): Promise<SyncOutcome> {
    const result: SyncResult = {
      calendarId: row.google_calendar_id,
      eventId: null,
      error: null,
    };
    try {
      if (!(await this.google.isConnected())) {
        throw new GoogleNotConnectedError();
      }
      if (row.status !== 'cancelled' && row.google_calendar_id) {
        result.eventId = await this.upsert(row, row.google_calendar_id);
      }
    } catch (err) {
      result.error = syncErrorCode(err);
      this.logger.warn(
        `Google sync of class ${row.id} failed: ${messageOf(err)}`,
      );
    }
    if (result.error !== SYNC_NOT_CONNECTED) {
      try {
        const deletionError = await this.processDeletions(
          await this.repo.classDeletions(row.id),
        );
        result.error ??= deletionError;
      } catch (err) {
        result.error ??= SYNC_INTERNAL_ERROR;
        this.logger.error(
          `Could not process deletions for class ${row.id}: ${messageOf(err)}`,
        );
      }
    }
    try {
      await this.repo.finishSync(row.id, row.updated_at, result);
    } catch (err) {
      this.logger.error(
        `Could not record Google sync of class ${row.id}: ${messageOf(err)}`,
      );
      return { calendarSync: 'failed', error: SYNC_INTERNAL_ERROR };
    }
    return {
      calendarSync: result.error ? 'failed' : 'ok',
      error: result.error,
    };
  }

  private async upsert(row: ClassRow, calendarId: string): Promise<string> {
    const input = eventInput(viewOf(row));
    if (row.google_event_id) {
      await this.google.patchEvent(calendarId, row.google_event_id, input);
      return row.google_event_id;
    }
    const eventId = classEventId(row.id, row.google_event_seq);
    try {
      await this.google.insertEvent(calendarId, input, { eventId });
    } catch (err) {
      if (!(err instanceof GoogleApiError && err.status === 409)) {
        throw err;
      }
      await this.google.patchEvent(calendarId, eventId, input);
    }
    return eventId;
  }
}

export function classEventId(classId: string, seq: number): string {
  return `ssms${classId.replace(/-/g, '').toLowerCase()}${seq}`;
}

export function toBookedClass(row: ClassRow): BookedClass {
  return {
    ...toAdminClass(row),
    calendarSync: row.google_sync_status === 'ok' ? 'ok' : 'failed',
    calendarSyncError: row.google_sync_error,
  };
}

export function syncErrorCode(err: unknown): string {
  if (err instanceof GoogleNotConnectedError) {
    return SYNC_NOT_CONNECTED;
  }
  if (err instanceof GoogleApiError) {
    if (err.status === undefined) {
      return 'network';
    }
    return (
      err.reason ? `${err.status}:${err.reason}` : String(err.status)
    ).slice(0, MAX_SYNC_ERROR_LENGTH);
  }
  if (err instanceof GoogleAuthError) {
    return `auth:${err.code}`.slice(0, MAX_SYNC_ERROR_LENGTH);
  }
  return SYNC_INTERNAL_ERROR;
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

function fullName(c: { first_name: string | null; last_name: string | null }) {
  return [c.first_name?.trim(), c.last_name?.trim()].filter((p) => p).join(' ');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
