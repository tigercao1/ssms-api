import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import {
  BookingRemindersRepository,
  type ReminderSettingsRow,
} from './booking-reminders.repository';

export const DEFAULT_REMINDER_OFFSETS_MINUTES = [1440, 60];
export const MAX_REMINDER_OFFSETS = 5;
export const MIN_REMINDER_OFFSET_MINUTES = 15;
export const MAX_REMINDER_OFFSET_MINUTES = 14 * 24 * 60;
export const REMINDER_OFFSETS_REQUIRED =
  'Add at least one reminder time, or turn reminders off';
export const REMINDER_OFFSETS_TOO_MANY = `Add at most ${MAX_REMINDER_OFFSETS} reminder times`;
export const REMINDER_OFFSETS_DUPLICATE =
  'Each reminder time must be different';
export const REMINDER_OFFSET_RANGE = `Each reminder time must be a whole number of minutes from ${MIN_REMINDER_OFFSET_MINUTES} (15 minutes) to ${MAX_REMINDER_OFFSET_MINUTES} (14 days) before the lesson`;

export interface BookingReminderSettings {
  enabled: boolean;
  offsetsMinutes: number[];
  updatedAt: string;
}

export interface BookingReminderSettingsInput {
  enabled: boolean;
  offsetsMinutes: number[];
}

@Injectable()
export class BookingReminderSettingsService {
  constructor(
    private readonly repo: BookingRemindersRepository,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<BookingReminderSettings> {
    return toSettings(await this.repo.getSettings());
  }

  async update(
    input: BookingReminderSettingsInput,
    actor: AuditActor,
  ): Promise<BookingReminderSettings> {
    if (input.enabled && input.offsetsMinutes.length === 0) {
      throw new BadRequestException(REMINDER_OFFSETS_REQUIRED);
    }
    const before = await this.get();
    const after = toSettings(
      await this.repo.saveSettings(
        {
          enabled: input.enabled,
          offsets_minutes: sortedOffsets(input.offsetsMinutes),
        },
        actor.userId ?? null,
      ),
    );
    await this.audit.record({
      action: AUDIT_ACTIONS.bookingReminderSettingsUpdate,
      actor: { ...actor, role: 'admin' },
      targetType: 'booking_reminder_settings',
      metadata: {
        from: {
          enabled: before.enabled,
          offsetsMinutes: before.offsetsMinutes,
        },
        to: { enabled: after.enabled, offsetsMinutes: after.offsetsMinutes },
      },
    });
    return after;
  }
}

function sortedOffsets(offsets: number[]): number[] {
  return [...new Set(offsets)].sort((a, b) => b - a);
}

function toSettings(row: ReminderSettingsRow): BookingReminderSettings {
  return {
    enabled: row.enabled,
    offsetsMinutes: sortedOffsets(row.offsets_minutes ?? []),
    updatedAt: row.updated_at,
  };
}
