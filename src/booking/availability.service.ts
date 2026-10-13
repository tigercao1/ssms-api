import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { GoogleError, GoogleNotConnectedError } from '../google/google.errors';
import type { CalendarFreeBusy } from '../google/google.types';
import {
  BOOKING_CLOCK,
  type BookingClock,
  BookingCalendarsService,
} from './booking-calendars.service';
import {
  type BookingSettings,
  BookingSettingsService,
  type DayWindow,
  windowFor,
} from './booking-settings.service';
import { addMinutes, SCHOOL_TIME_ZONE, zonedInstant } from './booking-time';
import {
  type BookingInstructorRow,
  BookingRepository,
  type CalendarLinkRow,
} from './booking.repository';

export const LESSON_TYPE_NOT_FOUND = 'Lesson type not found';

export type UnavailableReason =
  | 'inactive'
  | 'no_calendar'
  | 'calendar_not_confirmed'
  | 'calendar_not_writable'
  | 'calendar_error'
  | 'google_not_connected'
  | 'google_unavailable';

export interface BusyBlock {
  start: string;
  end: string;
  source: 'google' | 'ssms';
}

export interface InstructorAvailability {
  instructorId: string;
  displayNameEn: string;
  displayNameZh: string | null;
  googleCalendarId: string;
  busy: BusyBlock[];
  freeSlots: string[];
}

export interface UnavailableInstructor {
  instructorId: string;
  displayNameEn: string;
  displayNameZh: string | null;
  reason: UnavailableReason;
}

export interface Availability {
  date: string;
  timeZone: string;
  lessonTypeId: string;
  durationMin: number;
  slotMinutes: number;
  window: DayWindow | null;
  slots: string[];
  instructors: InstructorAvailability[];
  unavailable: UnavailableInstructor[];
}

export interface AvailabilityQuery {
  date: string;
  lessonTypeId: string;
  instructorIds?: string[];
}

interface Candidate {
  instructor: BookingInstructorRow;
  calendarId: string;
}

export interface Interval {
  start: number;
  end: number;
}

@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private readonly repo: BookingRepository,
    private readonly settings: BookingSettingsService,
    private readonly calendars: BookingCalendarsService,
    @Inject(BOOKING_CLOCK) private readonly clock: BookingClock,
  ) {}

  async availability(query: AvailabilityQuery): Promise<Availability> {
    const lessonType = await this.repo.findLessonType(query.lessonTypeId);
    if (!lessonType) {
      throw new NotFoundException(LESSON_TYPE_NOT_FOUND);
    }
    const settings = await this.settings.get();
    const window = windowFor(settings, query.date);
    const base: Availability = {
      date: query.date,
      timeZone: SCHOOL_TIME_ZONE,
      lessonTypeId: lessonType.id,
      durationMin: lessonType.duration_min,
      slotMinutes: settings.slotMinutes,
      window,
      slots: [],
      instructors: [],
      unavailable: [],
    };
    if (!window) {
      return base;
    }
    const instructors = await this.repo.listInstructors(query.instructorIds);
    const links = new Map(
      (await this.repo.listCalendarLinks(instructors.map((i) => i.id))).map(
        (l) => [l.instructor_id, l],
      ),
    );
    const { from, to } = dayBounds(query.date, window);
    base.slots = grid(from, to, settings);
    const { candidates, unavailable } = await this.candidates(
      instructors,
      links,
    );
    base.unavailable = unavailable;
    if (candidates.length === 0) {
      return base;
    }
    let calendars: Map<string, CalendarFreeBusy>;
    try {
      const result = await this.calendars.cachedFreeBusy(
        candidates.map((c) => c.calendarId),
        from.toISOString(),
        to.toISOString(),
      );
      calendars = new Map(result.calendars.map((c) => [c.id, c]));
    } catch (err) {
      this.logGoogle(err);
      base.unavailable.push(
        ...candidates.map((c) =>
          unavailableFor(googleReason(err))(c.instructor),
        ),
      );
      return base;
    }
    const classes = await this.repo.busyClasses(
      candidates.map((c) => c.instructor.id),
      from.toISOString(),
      to.toISOString(),
    );
    const now = this.clock.now();
    for (const candidate of candidates) {
      const freeBusy = calendars.get(candidate.calendarId);
      if (!freeBusy || freeBusy.errors.length > 0) {
        base.unavailable.push(
          unavailableFor('calendar_error')(candidate.instructor),
        );
        continue;
      }
      const busy: BusyBlock[] = [
        ...freeBusy.busy.map((b) => ({ ...b, source: 'google' as const })),
        ...classes
          .filter((c) => c.instructor_id === candidate.instructor.id)
          .map((c) => ({
            start: new Date(c.starts_at).toISOString(),
            end: new Date(c.ends_at).toISOString(),
            source: 'ssms' as const,
          })),
      ].sort((a, b) => a.start.localeCompare(b.start));
      const intervals = busy.map(toInterval);
      base.instructors.push({
        instructorId: candidate.instructor.id,
        displayNameEn: candidate.instructor.display_name_en,
        displayNameZh: candidate.instructor.display_name_zh,
        googleCalendarId: candidate.calendarId,
        busy,
        freeSlots: base.slots.filter((slot) => {
          const start = Date.parse(slot);
          const end = start + lessonType.duration_min * 60_000;
          return (
            start >= now &&
            end <= to.getTime() &&
            !overlapsAny({ start, end }, intervals)
          );
        }),
      });
    }
    return base;
  }

  private async candidates(
    instructors: BookingInstructorRow[],
    links: Map<string, CalendarLinkRow>,
  ): Promise<{
    candidates: Candidate[];
    unavailable: UnavailableInstructor[];
  }> {
    const unavailable: UnavailableInstructor[] = [];
    const linked: Candidate[] = [];
    for (const instructor of instructors) {
      const link = links.get(instructor.id);
      if (!instructor.is_active || instructor.approval_status !== 'approved') {
        unavailable.push(unavailableFor('inactive')(instructor));
      } else if (!link) {
        unavailable.push(unavailableFor('no_calendar')(instructor));
      } else if (link.match_status !== 'confirmed') {
        unavailable.push(unavailableFor('calendar_not_confirmed')(instructor));
      } else {
        linked.push({ instructor, calendarId: link.google_calendar_id });
      }
    }
    if (linked.length === 0) {
      return { candidates: [], unavailable };
    }
    let writable: Set<string>;
    try {
      if (!(await this.calendars.isConnected())) {
        throw new GoogleNotConnectedError();
      }
      writable = await this.calendars.writableCalendars();
    } catch (err) {
      this.logGoogle(err);
      return {
        candidates: [],
        unavailable: [
          ...unavailable,
          ...linked.map((c) => unavailableFor(googleReason(err))(c.instructor)),
        ],
      };
    }
    const candidates: Candidate[] = [];
    for (const entry of linked) {
      if (writable.has(entry.calendarId)) {
        candidates.push(entry);
      } else {
        unavailable.push(
          unavailableFor('calendar_not_writable')(entry.instructor),
        );
      }
    }
    return { candidates, unavailable };
  }

  private logGoogle(err: unknown): void {
    if (!(err instanceof GoogleError)) {
      throw err;
    }
    if (!(err instanceof GoogleNotConnectedError)) {
      this.logger.warn(`Google availability lookup failed: ${err.message}`);
    }
  }
}

export function dayBounds(
  date: string,
  window: DayWindow,
): { from: Date; to: Date } {
  return {
    from: zonedInstant(date, window.start),
    to: zonedInstant(date, window.end),
  };
}

export function toInterval(block: { start: string; end: string }): Interval {
  return { start: Date.parse(block.start), end: Date.parse(block.end) };
}

export function overlapsAny(slot: Interval, busy: Interval[]): boolean {
  return busy.some((b) => b.start < slot.end && b.end > slot.start);
}

function grid(from: Date, to: Date, settings: BookingSettings): string[] {
  const slots: string[] = [];
  for (
    let t = from;
    t.getTime() < to.getTime();
    t = addMinutes(t, settings.slotMinutes)
  ) {
    slots.push(t.toISOString());
  }
  return slots;
}

function googleReason(err: unknown): UnavailableReason {
  return err instanceof GoogleNotConnectedError
    ? 'google_not_connected'
    : 'google_unavailable';
}

function unavailableFor(reason: UnavailableReason) {
  return (instructor: BookingInstructorRow): UnavailableInstructor => ({
    instructorId: instructor.id,
    displayNameEn: instructor.display_name_en,
    displayNameZh: instructor.display_name_zh,
    reason,
  });
}
