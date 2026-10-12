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
  type CalendarCandidate,
  proposeCalendarMatches,
} from './calendar-matching';
import {
  type CalendarInstructorRow,
  type CalendarMatchStatus,
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
  matchStatus: CalendarMatchStatus | null;
  updatedAt: string | null;
}

export interface InstructorCalendarOverview extends InstructorGoogleCalendar {
  displayNameEn: string;
  displayNameZh: string | null;
  email: string | null;
  approvalStatus: string;
  isActive: boolean;
  candidates: CalendarCandidate[];
  suggestion: CalendarCandidate | null;
}

export interface InstructorCalendarsOverview {
  google: { connected: boolean; error: string | null };
  instructors: InstructorCalendarOverview[];
}

export interface SetInstructorCalendarInput {
  googleCalendarId: string | null;
  calendarSummary?: string | null;
  matchStatus?: CalendarMatchStatus;
}

export interface SuggestCalendarsResult {
  suggested: number;
  overview: InstructorCalendarsOverview;
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
    let row: InstructorCalendarRow | null = null;
    if (next === null) {
      await this.repo.remove(instructorId);
    } else {
      try {
        row = await this.repo.upsert(
          instructorId,
          {
            google_calendar_id: next,
            calendar_summary: input.calendarSummary?.trim() || null,
            match_status: input.matchStatus ?? 'confirmed',
          },
          actor.userId ?? null,
        );
      } catch (err) {
        if (hasCode(err, PG_UNIQUE_VIOLATION)) {
          throw new ConflictException(CALENDAR_ALREADY_LINKED);
        }
        throw err;
      }
    }
    const result = toCalendar(instructorId, row);
    if (
      (before?.google_calendar_id ?? null) !== result.googleCalendarId ||
      (before?.match_status ?? null) !== result.matchStatus
    ) {
      await this.audit.record({
        action: AUDIT_ACTIONS.instructorGoogleCalendarUpdate,
        actor: { ...actor, role: 'admin' },
        targetType: 'instructor',
        targetId: instructorId,
        metadata: {
          from: before?.google_calendar_id ?? null,
          to: result.googleCalendarId,
          fromStatus: before?.match_status ?? null,
          toStatus: result.matchStatus,
        },
      });
    }
    return result;
  }

  async overview(): Promise<InstructorCalendarsOverview> {
    const [instructors, links] = await Promise.all([
      this.repo.listInstructors(),
      this.repo.list(),
    ]);
    const google = await this.loadCalendars();
    return buildOverview(instructors, links, google.calendars, {
      connected: google.connected,
      error: google.error,
    });
  }

  async suggest(actor: AuditActor): Promise<SuggestCalendarsResult> {
    if (!(await this.google.isConnected())) {
      throw new GoogleNotConnectedError();
    }
    const calendars = await this.google.listCalendars();
    const [instructors, links] = await Promise.all([
      this.repo.listInstructors(),
      this.repo.list(),
    ]);
    const before = buildOverview(instructors, links, calendars, {
      connected: true,
      error: null,
    });
    const stored: { instructorId: string; googleCalendarId: string }[] = [];
    for (const entry of before.instructors) {
      if (entry.googleCalendarId || !entry.suggestion) {
        continue;
      }
      const inserted = await this.repo.insertIfAbsent(
        entry.instructorId,
        {
          google_calendar_id: entry.suggestion.calendarId,
          calendar_summary: entry.suggestion.calendarSummary,
          match_status: 'suggested',
        },
        actor.userId ?? null,
      );
      if (inserted) {
        stored.push({
          instructorId: entry.instructorId,
          googleCalendarId: entry.suggestion.calendarId,
        });
      }
    }
    if (stored.length > 0) {
      await this.audit.record({
        action: AUDIT_ACTIONS.instructorGoogleCalendarSuggest,
        actor: { ...actor, role: 'admin' },
        metadata: { suggested: stored },
      });
    }
    const overview = buildOverview(
      instructors,
      await this.repo.list(),
      calendars,
      {
        connected: true,
        error: null,
      },
    );
    return { suggested: stored.length, overview };
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
    matchStatus: row?.match_status ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function buildOverview(
  instructors: CalendarInstructorRow[],
  links: InstructorCalendarRow[],
  calendars: GoogleCalendar[],
  google: InstructorCalendarsOverview['google'],
): InstructorCalendarsOverview {
  const linkByInstructor = new Map(links.map((l) => [l.instructor_id, l]));
  const owners = new Map(
    links.map((l) => [l.google_calendar_id, l.instructor_id]),
  );
  const proposals = proposeCalendarMatches(
    instructors.map((i) => ({
      id: i.id,
      email: i.email,
      displayNameEn: i.display_name_en,
      displayNameZh: i.display_name_zh,
    })),
    calendars,
    owners,
  );
  return {
    google,
    instructors: instructors.map((i) => {
      const proposal = proposals.get(i.id);
      return {
        ...toCalendar(i.id, linkByInstructor.get(i.id) ?? null),
        displayNameEn: i.display_name_en,
        displayNameZh: i.display_name_zh,
        email: i.email,
        approvalStatus: i.approval_status,
        isActive: i.is_active,
        candidates: proposal?.candidates ?? [],
        suggestion: proposal?.suggestion ?? null,
      };
    }),
  };
}
