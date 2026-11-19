import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { fetchAllPages } from '../database/pagination';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { CLASSES_TABLE } from '../lessons/classes.repository';
import type { ClassSource } from '../lessons/lessons.types';
import type { Audience } from './booking-emails.service';
import {
  CLASS_NOTICE_COLUMNS,
  type ClassNoticeRow,
} from './booking.repository';

export const REMINDER_SETTINGS_TABLE = 'booking_reminder_settings';
export const REMINDER_SENDS_TABLE = 'booking_reminder_sends';
const REMINDER_SETTINGS_COLUMNS =
  'enabled, offsets_minutes, enabled_at, updated_at';
const REMINDER_CLASS_COLUMNS = `${CLASS_NOTICE_COLUMNS}, starts_at_set_at`;
const REMINDER_KEY_COLUMNS =
  'class_id,starts_at,offset_minutes,audience,recipient_id';
const STALE_CLAIM_COLUMNS = 'id, class_id, offset_minutes, audience';
const CLAIM_LOOKUP_CHUNK = 100;
const BOOKED_IN_SSMS: ClassSource = 'ssms';

export interface ReminderSettingsRow {
  enabled: boolean;
  offsets_minutes: number[];
  enabled_at: string;
  updated_at: string;
}

export interface ReminderSettingsWrite {
  enabled: boolean;
  offsets_minutes: number[];
}

export interface ReminderClassRow extends ClassNoticeRow {
  starts_at_set_at: string;
}

export interface ReminderClaim {
  class_id: string;
  starts_at: string;
  offset_minutes: number;
  audience: Audience;
  recipient_id: string;
}

export type ReminderOutcome = 'sent' | 'skipped' | 'failed';

export type StaleReminderClaim = Pick<
  ReminderClaim,
  'class_id' | 'offset_minutes' | 'audience'
> & { id: string };

export abstract class BookingRemindersRepository {
  abstract getSettings(): Promise<ReminderSettingsRow>;
  abstract saveSettings(
    write: ReminderSettingsWrite,
    userId: string | null,
  ): Promise<ReminderSettingsRow>;
  abstract remindableClassesStartingBetween(
    after: string,
    until: string,
  ): Promise<ReminderClassRow[]>;
  abstract claimed(classIds: string[]): Promise<ReminderClaim[]>;
  abstract supersede(claim: ReminderClaim): Promise<boolean>;
  abstract failStaleClaims(
    claimedBefore: string,
  ): Promise<StaleReminderClaim[]>;
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

  remindableClassesStartingBetween(
    after: string,
    until: string,
  ): Promise<ReminderClassRow[]> {
    return fetchAllPages<ReminderClassRow>(
      (from, to) =>
        this.supabase
          .from(CLASSES_TABLE)
          .select(REMINDER_CLASS_COLUMNS)
          .eq('status', 'scheduled')
          .eq('source', BOOKED_IN_SSMS)
          .eq('send_emails', true)
          .gt('starts_at', after)
          .lte('starts_at', until)
          .order('starts_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      'list classes due for reminders',
    );
  }

  async claimed(classIds: string[]): Promise<ReminderClaim[]> {
    const out: ReminderClaim[] = [];
    for (let i = 0; i < classIds.length; i += CLAIM_LOOKUP_CHUNK) {
      const chunk = classIds.slice(i, i + CLAIM_LOOKUP_CHUNK);
      out.push(
        ...(await fetchAllPages<ReminderClaim>(
          (from, to) =>
            this.supabase
              .from(REMINDER_SENDS_TABLE)
              .select(REMINDER_KEY_COLUMNS)
              .in('class_id', chunk)
              .order('id', { ascending: true })
              .range(from, to),
          'list claimed booking reminders',
        )),
      );
    }
    return out;
  }

  async failStaleClaims(claimedBefore: string): Promise<StaleReminderClaim[]> {
    const { data, error } = (await this.supabase
      .from(REMINDER_SENDS_TABLE)
      .update({
        status: 'failed',
        reason: 'stale_claim',
        finished_at: new Date().toISOString(),
      })
      .eq('status', 'claimed')
      .lt('claimed_at', claimedBefore)
      .select(STALE_CLAIM_COLUMNS)) as DbResult<StaleReminderClaim[]>;
    check(error, 'fail stale booking reminder claims');
    return data ?? [];
  }

  async supersede(claim: ReminderClaim): Promise<boolean> {
    const { data, error } = (await this.supabase
      .from(REMINDER_SENDS_TABLE)
      .upsert(
        {
          ...claim,
          status: 'skipped',
          reason: 'superseded',
          finished_at: new Date().toISOString(),
        },
        { onConflict: REMINDER_KEY_COLUMNS, ignoreDuplicates: true },
      )
      .select('id')) as DbResult<{ id: string }[]>;
    check(error, 'record superseded booking reminder');
    return (data?.length ?? 0) > 0;
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
