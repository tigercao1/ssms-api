import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import {
  isTimeOfDay,
  minutesOfDay,
  type Weekday,
  WEEKDAYS,
  weekdayOf,
} from './booking-time';
import {
  BookingRepository,
  type BookingSettingsRow,
} from './booking.repository';

export const SLOT_MINUTES = [15, 30, 60] as const;
export const SETTINGS_RANGE_INVALID = 'The day must end after it starts';
export const SETTINGS_OVERRIDE_INVALID =
  'Each weekday override must be { start, end } in HH:MM with end after start, or { closed: true }';

export interface DayWindow {
  start: string;
  end: string;
}

export type WeekdayOverride = DayWindow | { closed: true };

export interface BookingSettings {
  dayStartTime: string;
  dayEndTime: string;
  slotMinutes: number;
  weekdayOverrides: Partial<Record<Weekday, WeekdayOverride>>;
  updatedAt: string;
}

export interface BookingSettingsInput {
  dayStartTime: string;
  dayEndTime: string;
  slotMinutes: number;
  weekdayOverrides?: Record<string, unknown>;
}

@Injectable()
export class BookingSettingsService {
  constructor(
    private readonly repo: BookingRepository,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<BookingSettings> {
    return toSettings(await this.repo.getSettings());
  }

  async update(
    input: BookingSettingsInput,
    actor: AuditActor,
  ): Promise<BookingSettings> {
    if (minutesOfDay(input.dayEndTime) <= minutesOfDay(input.dayStartTime)) {
      throw new BadRequestException(SETTINGS_RANGE_INVALID);
    }
    const overrides = parseOverrides(input.weekdayOverrides ?? {});
    if (!overrides) {
      throw new BadRequestException(SETTINGS_OVERRIDE_INVALID);
    }
    const before = await this.get();
    const after = toSettings(
      await this.repo.saveSettings(
        {
          day_start_time: input.dayStartTime,
          day_end_time: input.dayEndTime,
          slot_minutes: input.slotMinutes,
          weekday_overrides: overrides,
        },
        actor.userId ?? null,
      ),
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.bookingSettingsUpdate,
      actor: { ...actor, role: 'admin' },
      targetType: 'booking_settings',
      metadata: {
        from: withoutTimestamp(before),
        to: withoutTimestamp(after),
      },
    });
    return after;
  }
}

export function windowFor(
  settings: BookingSettings,
  date: string,
): DayWindow | null {
  const override = settings.weekdayOverrides[weekdayOf(date)];
  if (override && 'closed' in override) {
    return null;
  }
  return override ?? { start: settings.dayStartTime, end: settings.dayEndTime };
}

function withoutTimestamp(settings: BookingSettings) {
  return {
    dayStartTime: settings.dayStartTime,
    dayEndTime: settings.dayEndTime,
    slotMinutes: settings.slotMinutes,
    weekdayOverrides: settings.weekdayOverrides,
  };
}

function parseOverrides(
  raw: Record<string, unknown>,
): Partial<Record<Weekday, WeekdayOverride>> | null {
  const result: Partial<Record<Weekday, WeekdayOverride>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(WEEKDAYS as readonly string[]).includes(key)) {
      return null;
    }
    const override = parseOverride(value);
    if (!override) {
      return null;
    }
    result[key as Weekday] = override;
  }
  return result;
}

function parseOverride(value: unknown): WeekdayOverride | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort().join(',');
  if (keys === 'closed') {
    return entry.closed === true ? { closed: true } : null;
  }
  if (
    keys === 'end,start' &&
    isTimeOfDay(entry.start) &&
    isTimeOfDay(entry.end) &&
    minutesOfDay(entry.end) > minutesOfDay(entry.start)
  ) {
    return { start: entry.start, end: entry.end };
  }
  return null;
}

function toSettings(row: BookingSettingsRow): BookingSettings {
  return {
    dayStartTime: row.day_start_time.slice(0, 5),
    dayEndTime: row.day_end_time.slice(0, 5),
    slotMinutes: row.slot_minutes,
    weekdayOverrides: parseOverrides(row.weekday_overrides ?? {}) ?? {},
    updatedAt: row.updated_at,
  };
}
