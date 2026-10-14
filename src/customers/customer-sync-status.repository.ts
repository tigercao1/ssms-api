import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

export const CUSTOMER_SYNC_STATUS_TABLE = 'customer_sync_status';
export const CUSTOMER_SYNC_STATUS_COLUMNS =
  'last_started_at, last_finished_at, last_success_at, last_fetched, last_error, incremental_since, last_reconcile_at, last_reconcile_error';

export interface CustomerSyncStatusRow {
  last_started_at: string | null;
  last_finished_at: string | null;
  last_success_at: string | null;
  last_fetched: number | null;
  last_error: string | null;
  incremental_since: string | null;
  last_reconcile_at: string | null;
  last_reconcile_error: string | null;
}

export type CustomerSyncOutcome =
  | { fetched: number; error: null }
  | { fetched: null; error: string };

export abstract class CustomerSyncStatusRepository {
  abstract tryLock(leaseSeconds: number): Promise<string | null>;
  abstract finish(token: string, outcome: CustomerSyncOutcome): Promise<void>;
  abstract status(): Promise<CustomerSyncStatusRow | null>;
  abstract setIncrementalSince(since: string): Promise<void>;
  abstract finishReconcile(
    token: string,
    at: string,
    error: string | null,
  ): Promise<void>;
}

@Injectable()
export class SupabaseCustomerSyncStatusRepository extends CustomerSyncStatusRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async tryLock(leaseSeconds: number): Promise<string | null> {
    const { data, error } = (await this.supabase.rpc('try_lock_customer_sync', {
      p_lease_seconds: leaseSeconds,
    })) as DbResult<string>;
    check(error, 'lock customer sync');
    return data ?? null;
  }

  async finish(token: string, outcome: CustomerSyncOutcome): Promise<void> {
    const { error } = (await this.supabase.rpc('finish_customer_sync', {
      p_token: token,
      p_fetched: outcome.fetched,
      p_error: outcome.error,
    })) as DbResult<boolean>;
    check(error, 'record customer sync');
  }

  async status(): Promise<CustomerSyncStatusRow | null> {
    const { data, error } = (await this.supabase
      .from(CUSTOMER_SYNC_STATUS_TABLE)
      .select(CUSTOMER_SYNC_STATUS_COLUMNS)
      .eq('id', true)
      .maybeSingle()) as DbResult<CustomerSyncStatusRow>;
    check(error, 'load customer sync status');
    return data;
  }

  async setIncrementalSince(since: string): Promise<void> {
    const { error } = (await this.supabase
      .from(CUSTOMER_SYNC_STATUS_TABLE)
      .update({ incremental_since: since })
      .eq('id', true)) as DbResult<null>;
    check(error, 'save customer sync watermark');
  }

  async finishReconcile(
    token: string,
    at: string,
    error: string | null,
  ): Promise<void> {
    const { error: dbError } = (await this.supabase
      .from(CUSTOMER_SYNC_STATUS_TABLE)
      .update({ last_reconcile_at: at, last_reconcile_error: error })
      .eq('id', true)
      .eq('lock_token', token)) as DbResult<null>;
    check(dbError, 'record customer reconcile');
  }
}
