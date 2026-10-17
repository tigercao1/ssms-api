import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import { hasCode, PG_UNIQUE_VIOLATION } from '../database/db-result';
import { GoogleError, GoogleNotConnectedError } from '../google/google.errors';
import type { GoogleCalendar } from '../google/google.types';
import { GoogleCalendarClient } from '../google/google-calendar.client';
import { GOOGLE_UNAVAILABLE } from '../google/google-error.filter';
import {
  type CalendarInstructorRow,
  type InstructorCalendarRow,
  InstructorCalendarsRepository,
} from './instructor-calendars.repository';

export const INSTRUCTOR_NOT_FOUND = 'Instructor not found';
export const CALENDAR_ALREADY_LINKED =
  'This calendar is already linked to another instructor';

export interface InstructorGoogleCalendar {
  instructorId: string;
  googleCalendarId: string | null;
  calendarSummary: string | null;
  updatedAt: string | null;
}

export interface InstructorCalendarOverview extends InstructorGoogleCalendar {
  displayNameEn: string;
  displayNameZh: string | null;
  email: string | null;
  approvalStatus: string;
  isActive: boolean;
}

export interface InstructorCalendarsOverview {
  google: { connected: boolean; error: string | null };
  instructors: InstructorCalendarOverview[];
}

export interface SetInstructorCalendarInput {
  googleCalendarId: string | null;
}

@Injectable()
export class InstructorCalendarsService {
  private readonly logger = new Logger(InstructorCalendarsService.name);

  constructor(
    private readonly repo: InstructorCalendarsRepository,
    private readonly google: GoogleCalendarClient,
    private readonly audit: AuditService,
  ) {}

  async get(instructorId: string): Promise<InstructorGoogleCalendar> {
    await this.requireInstructor(instructorId);
    return toCalendar(instructorId, await this.repo.find(instructorId));
  }

  async set(
    instructorId: string,
    input: SetInstructorCalendarInput,
    actor: AuditActor,
  ): Promise<InstructorGoogleCalendar> {
    await this.requireInstructor(instructorId);
    const before = await this.repo.find(instructorId);
    const next = input.googleCalendarId?.trim() || null;
    const current = toCalendar(instructorId, before);
    let result: InstructorGoogleCalendar;
    if (next === null) {
      if (!before) {
        return current;
      }
      await this.repo.remove(instructorId);
      result = toCalendar(instructorId, null);
    } else {
      const write = {
        google_calendar_id: next,
        calendar_summary: await this.summaryFor(next, before),
      };
      if (
        before &&
        before.google_calendar_id === write.google_calendar_id &&
        before.calendar_summary === write.calendar_summary
      ) {
        return current;
      }
      try {
        result = toCalendar(
          instructorId,
          await this.repo.upsert(instructorId, write, actor.userId ?? null),
        );
      } catch (err) {
        if (hasCode(err, PG_UNIQUE_VIOLATION)) {
          throw new ConflictException(CALENDAR_ALREADY_LINKED);
        }
        throw err;
      }
    }
    await this.recordUpdate(instructorId, current, result, actor);
    return result;
  }

  private async summaryFor(
    calendarId: string,
    before: InstructorCalendarRow | null,
  ): Promise<string | null> {
    const google = await this.loadCalendars();
    const found = google.calendars.find((c) => c.id === calendarId);
    if (found) {
      return found.summary.trim() || null;
    }
    return before?.google_calendar_id === calendarId
      ? before.calendar_summary
      : null;
  }

  private async recordUpdate(
    instructorId: string,
    from: InstructorGoogleCalendar,
    to: InstructorGoogleCalendar,
    actor: AuditActor,
  ): Promise<void> {
    await this.audit.record({
      action: AUDIT_ACTIONS.instructorGoogleCalendarUpdate,
      actor: { ...actor, role: 'admin' },
      targetType: 'instructor',
      targetId: instructorId,
      metadata: {
        from: from.googleCalendarId,
        to: to.googleCalendarId,
        fromSummary: from.calendarSummary,
        toSummary: to.calendarSummary,
      },
    });
  }

  async overview(): Promise<InstructorCalendarsOverview> {
    const [instructors, links] = await Promise.all([
      this.repo.listInstructors(),
      this.repo.list(),
    ]);
    const google = await this.loadCalendars();
    return buildOverview(instructors, links, {
      connected: google.connected,
      error: google.error,
    });
  }

  private async loadCalendars(): Promise<{
    connected: boolean;
    error: string | null;
    calendars: GoogleCalendar[];
  }> {
    try {
      if (!(await this.google.isConnected())) {
        return { connected: false, error: null, calendars: [] };
      }
      return {
        connected: true,
        error: null,
        calendars: await this.google.listCalendars(),
      };
    } catch (err) {
      if (err instanceof GoogleNotConnectedError) {
        return { connected: false, error: null, calendars: [] };
      }
      if (err instanceof GoogleError) {
        this.logger.warn(`Listing Google calendars failed: ${err.message}`);
        return { connected: true, error: GOOGLE_UNAVAILABLE, calendars: [] };
      }
      throw err;
    }
  }

  private async requireInstructor(instructorId: string): Promise<void> {
    if (!(await this.repo.instructorExists(instructorId))) {
      throw new NotFoundException(INSTRUCTOR_NOT_FOUND);
    }
  }
}

function toCalendar(
  instructorId: string,
  row: InstructorCalendarRow | null,
): InstructorGoogleCalendar {
  return {
    instructorId,
    googleCalendarId: row?.google_calendar_id ?? null,
    calendarSummary: row?.calendar_summary ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function buildOverview(
  instructors: CalendarInstructorRow[],
  links: InstructorCalendarRow[],
  google: InstructorCalendarsOverview['google'],
): InstructorCalendarsOverview {
  const linkByInstructor = new Map(links.map((l) => [l.instructor_id, l]));
  return {
    google,
    instructors: instructors.map((i) => ({
      ...toCalendar(i.id, linkByInstructor.get(i.id) ?? null),
      displayNameEn: i.display_name_en,
      displayNameZh: i.display_name_zh,
      email: i.email,
      approvalStatus: i.approval_status,
      isActive: i.is_active,
    })),
  };
}
