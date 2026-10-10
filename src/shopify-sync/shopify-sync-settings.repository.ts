import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type { SyncQueueRow } from './instructor-sync.types';

const SETTINGS_TABLE = 'shopify_sync_settings';
const SETTINGS_COLUMNS =
  'enabled, updated_at, updated_by, last_tick_at, last_success_at, last_error, last_error_at';

export interface ShopifySyncSettingsRow {
  enabled: boolean;
  updated_at: string;
  updated_by: string | null;
  last_tick_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

export type ShopifySyncHeartbeat = Partial<
  Pick<
    ShopifySyncSettingsRow,
    'last_tick_at' | 'last_success_at' | 'last_error' | 'last_error_at'
  >
>;

export interface ShopifySyncStats {
  pending: number;
  retrying: number;
  failed: number;
  oldestEnqueuedAt: string | null;
  synced: number;
  active: number;
  draft: number;
}

interface StatsRow {
  pending: number;
  retrying: number;
  failed: number;
  oldest_enqueued_at: string | null;
  synced: number;
  active: number;
  draft: number;
}

interface DbError {
  message: string;
}

export abstract class ShopifySyncSettingsRepository {
  abstract getSettings(): Promise<ShopifySyncSettingsRow | null>;
  abstract setEnabled(
    enabled: boolean,
    userId: string | null,
  ): Promise<ShopifySyncSettingsRow>;
  abstract recordHeartbeat(heartbeat: ShopifySyncHeartbeat): Promise<void>;
  abstract stats(maxAttempts: number): Promise<ShopifySyncStats>;
  abstract queueRow(instructorId: string): Promise<SyncQueueRow | null>;
  abstract instructorExists(instructorId: string): Promise<boolean>;
  abstract enqueueInstructor(instructorId: string): Promise<void>;
}

@Injectable()
export class SupabaseShopifySyncSettingsRepository extends ShopifySyncSettingsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async getSettings(): Promise<ShopifySyncSettingsRow | null> {
    const { data, error } = (await this.supabase
      .from(SETTINGS_TABLE)
      .select(SETTINGS_COLUMNS)
      .eq('id', true)
      .maybeSingle()) as {
      data: ShopifySyncSettingsRow | null;
      error: DbError | null;
    };
    check(error, 'load Shopify sync settings');
    return data ?? null;
  }

  async setEnabled(
    enabled: boolean,
    userId: string | null,
  ): Promise<ShopifySyncSettingsRow> {
    const { data, error } = (await this.supabase
      .from(SETTINGS_TABLE)
      .update({
        enabled,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', true)
      .select(SETTINGS_COLUMNS)
      .maybeSingle()) as {
      data: ShopifySyncSettingsRow | null;
      error: DbError | null;
    };
    check(error, 'save Shopify sync settings');
    if (!data) {
      throw new Error('Shopify sync settings row is missing');
    }
    return data;
  }

  async recordHeartbeat(heartbeat: ShopifySyncHeartbeat): Promise<void> {
    const { error } = await this.supabase
      .from(SETTINGS_TABLE)
      .update(heartbeat)
      .eq('id', true);
    check(error, 'record Shopify sync heartbeat');
  }

  async stats(maxAttempts: number): Promise<ShopifySyncStats> {
    const { data, error } = (await this.supabase.rpc('shopify_sync_stats', {
      p_max_attempts: maxAttempts,
    })) as { data: StatsRow[] | null; error: DbError | null };
    check(error, 'load Shopify sync stats');
    const [row] = data ?? [];
    return {
      pending: Number(row?.pending ?? 0),
      retrying: Number(row?.retrying ?? 0),
      failed: Number(row?.failed ?? 0),
      oldestEnqueuedAt: row?.oldest_enqueued_at ?? null,
      synced: Number(row?.synced ?? 0),
      active: Number(row?.active ?? 0),
      draft: Number(row?.draft ?? 0),
    };
  }

  async queueRow(instructorId: string): Promise<SyncQueueRow | null> {
    const { data, error } = (await this.supabase
      .from('instructor_sync_queue')
      .select('instructor_id, enqueued_at, attempts, last_error')
      .eq('instructor_id', instructorId)
      .maybeSingle()) as { data: SyncQueueRow | null; error: DbError | null };
    check(error, 'load sync queue row');
    return data ?? null;
  }

  async instructorExists(instructorId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('instructors')
      .select('id')
      .eq('id', instructorId)
      .maybeSingle();
    check(error, 'load instructor');
    return data != null;
  }

  async enqueueInstructor(instructorId: string): Promise<void> {
    const { error } = await this.supabase.rpc('enqueue_one_instructor_sync', {
      p_instructor_id: instructorId,
    });
    check(error, 'enqueue instructor sync');
  }
}

function check(error: DbError | null, action: string): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}
