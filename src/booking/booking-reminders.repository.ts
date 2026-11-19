import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { fetchAllPages } from '../database/pagination';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { CLASSES_TABLE } from '../lessons/classes.repository';
import type { ClassStatus } from '../lessons/lessons.types';
import type { Audience } from './booking-emails.service';
import {
  CLASS_NOTICE_COLUMNS,
  type ClassNoticeRow,
} from './booking.repository';

export const REMINDER_SETTINGS_TABLE = 'booking_reminder_settings';
export const REMINDER_SENDS_TABLE = 'booking_reminder_sends';
const REMINDER_SETTINGS_COLUMNS = 'enabled, offsets_minutes, updated_at';
const REMINDER_CLASS_COLUMNS = `${CLASS_NOTICE_COLUMNS}, status, send_emails`;
const REMINDER_KEY_COLUMNS =
  'class_id,starts_at,offset_minutes,audience,recipient_id';

export interface ReminderSettingsRow {
  enabled: boolean;
  offsets_minutes: number[];
  updated_at: string;
}

export interface ReminderSettingsWrite {
  enabled: boolean;
  offsets_minutes: number[];
}

export interface ReminderClassRow extends ClassNoticeRow {
  status: ClassStatus;
  send_emails: boolean;
}

export interface ReminderClaim {
  class_id: string;
  starts_at: string;
  offset_minutes: number;
  audience: Audience;
  recipient_id: string;
}

export type ReminderOutcome = 'sent' | 'skipped' | 'failed';

export abstract class BookingRemindersRepository {
  abstract getSettings(): Promise<ReminderSettingsRow>;
  abstract saveSettings(
    write: ReminderSettingsWrite,
    userId: string | null,
  ): Promise<ReminderSettingsRow>;
  abstract classesStartingBetween(
    after: string,
    until: string,
  ): Promise<ReminderClassRow[]>;
  abstract claim(claim: ReminderClaim): Promise<string | null>;
  abstract finish(id: string, outcome: ReminderOutcome): Promise<void>;
  abstract release(id: string): Promise<void>;
}

@Injectable()
export class SupabaseBookingRemindersRepository extends BookingRemindersRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async getSettings(): Promise<ReminderSettingsRow> {
    const { data, error } = (await this.supabase
      .from(REMINDER_SETTINGS_TABLE)
      .select(REMINDER_SETTINGS_COLUMNS)
      .eq('id', true)
      .maybeSingle()) as DbResult<ReminderSettingsRow>;
    check(error, 'load booking reminder settings');
    if (!data) {
      throw new Error('Booking reminder settings row is missing');
    }
    return data;
  }

  async saveSettings(
    write: ReminderSettingsWrite,
    userId: string | null,
  ): Promise<ReminderSettingsRow> {
    const { data, error } = (await this.supabase
      .from(REMINDER_SETTINGS_TABLE)
      .update({ ...write, updated_by: userId })
      .eq('id', true)
      .select(REMINDER_SETTINGS_COLUMNS)
      .maybeSingle()) as DbResult<ReminderSettingsRow>;
    check(error, 'save booking reminder settings');
    if (!data) {
      throw new Error('Booking reminder settings row is missing');
    }
    return data;
  }

  classesStartingBetween(
    after: string,
    until: string,
  ): Promise<ReminderClassRow[]> {
    return fetchAllPages<ReminderClassRow>(
      (from, to) =>
        this.supabase
          .from(CLASSES_TABLE)
          .select(REMINDER_CLASS_COLUMNS)
          .gt('starts_at', after)
          .lte('starts_at', until)
          .order('starts_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      'list classes due for reminders',
    );
  }

  async claim(claim: ReminderClaim): Promise<string | null> {
    const { data, error } = (await this.supabase
      .from(REMINDER_SENDS_TABLE)
      .upsert(claim, {
        onConflict: REMINDER_KEY_COLUMNS,
        ignoreDuplicates: true,
      })
      .select('id')) as DbResult<{ id: string }[]>;
    check(error, 'claim booking reminder');
    return data?.[0]?.id ?? null;
  }

  async finish(id: string, outcome: ReminderOutcome): Promise<void> {
    const { error } = (await this.supabase
      .from(REMINDER_SENDS_TABLE)
      .update({ status: outcome, finished_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'claimed')) as DbResult<null>;
    check(error, 'record booking reminder');
  }

  async release(id: string): Promise<void> {
    const { error } = (await this.supabase
      .from(REMINDER_SENDS_TABLE)
      .delete()
      .eq('id', id)
      .eq('status', 'claimed')) as DbResult<null>;
    check(error, 'release booking reminder');
  }
}
