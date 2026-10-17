import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

export interface ReminderPartOutcome {
  sent: number | null;
  error: string | null;
}

export interface DailyReminderRunOutcome {
  documents: ReminderPartOutcome;
  certifications: ReminderPartOutcome;
  invites: ReminderPartOutcome;
}

export abstract class DailyReminderRunsRepository {
  abstract tryStart(day: string, leaseSeconds: number): Promise<string | null>;
  abstract renew(token: string, leaseSeconds: number): Promise<boolean>;
  abstract finish(
    token: string,
    outcome: DailyReminderRunOutcome,
  ): Promise<boolean>;
}

@Injectable()
export class SupabaseDailyReminderRunsRepository extends DailyReminderRunsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async tryStart(day: string, leaseSeconds: number): Promise<string | null> {
    const { data, error } = (await this.supabase.rpc(
      'try_start_daily_reminders',
      { p_day: day, p_lease_seconds: leaseSeconds },
    )) as DbResult<string>;
    check(error, 'start daily reminders');
    return data ?? null;
  }

  async renew(token: string, leaseSeconds: number): Promise<boolean> {
    const { data, error } = (await this.supabase.rpc('renew_daily_reminders', {
      p_token: token,
      p_lease_seconds: leaseSeconds,
    })) as DbResult<boolean>;
    check(error, 'renew daily reminders');
    return data === true;
  }

  async finish(
    token: string,
    { documents, certifications, invites }: DailyReminderRunOutcome,
  ): Promise<boolean> {
    const { data, error } = (await this.supabase.rpc('finish_daily_reminders', {
      p_token: token,
      p_documents_sent: documents.sent,
      p_documents_error: documents.error,
      p_certifications_sent: certifications.sent,
      p_certifications_error: certifications.error,
      p_invites_sent: invites.sent,
      p_invites_error: invites.error,
    })) as DbResult<boolean>;
    check(error, 'record daily reminders');
    return data === true;
  }
}
