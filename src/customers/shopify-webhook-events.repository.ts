import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

export const SHOPIFY_WEBHOOK_EVENTS_TABLE = 'shopify_webhook_events';
export const MAX_WEBHOOK_ERROR_LENGTH = 2_000;

export interface ShopifyWebhookEvent {
  webhook_id: string;
  topic: string;
  shopify_customer_id: number | null;
  triggered_at: string | null;
}

export type ShopifyWebhookClaim = 'new' | 'unfinished' | 'processed';

export interface ShopifyWebhookStats {
  lastReceivedAt: string | null;
  receivedSince: number;
}

export abstract class ShopifyWebhookEventsRepository {
  abstract claim(event: ShopifyWebhookEvent): Promise<ShopifyWebhookClaim>;
  abstract finish(webhookId: string, error: string | null): Promise<void>;
  abstract fail(webhookId: string, error: string): Promise<void>;
  abstract prune(receivedBefore: string): Promise<void>;
  abstract stats(since: string): Promise<ShopifyWebhookStats>;
}

@Injectable()
export class SupabaseShopifyWebhookEventsRepository extends ShopifyWebhookEventsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async claim(event: ShopifyWebhookEvent): Promise<ShopifyWebhookClaim> {
    const { data, error } = (await this.supabase
      .from(SHOPIFY_WEBHOOK_EVENTS_TABLE)
      .upsert(event, { onConflict: 'webhook_id', ignoreDuplicates: true })
      .select('webhook_id')) as DbResult<{ webhook_id: string }[]>;
    check(error, 'record Shopify webhook');
    if (data && data.length > 0) {
      return 'new';
    }
    const { data: existing, error: loadError } = (await this.supabase
      .from(SHOPIFY_WEBHOOK_EVENTS_TABLE)
      .select('processed_at')
      .eq('webhook_id', event.webhook_id)
      .maybeSingle()) as DbResult<{ processed_at: string | null }>;
    check(loadError, 'load Shopify webhook');
    return existing?.processed_at ? 'processed' : 'unfinished';
  }

  async finish(webhookId: string, error: string | null): Promise<void> {
    const { error: dbError } = (await this.supabase
      .from(SHOPIFY_WEBHOOK_EVENTS_TABLE)
      .update({
        processed_at: new Date().toISOString(),
        error: error?.slice(0, MAX_WEBHOOK_ERROR_LENGTH) ?? null,
      })
      .eq('webhook_id', webhookId)) as DbResult<null>;
    check(dbError, 'finish Shopify webhook');
  }

  async fail(webhookId: string, error: string): Promise<void> {
    const { error: dbError } = (await this.supabase
      .from(SHOPIFY_WEBHOOK_EVENTS_TABLE)
      .update({ error: error.slice(0, MAX_WEBHOOK_ERROR_LENGTH) })
      .eq('webhook_id', webhookId)) as DbResult<null>;
    check(dbError, 'record Shopify webhook failure');
  }

  async prune(receivedBefore: string): Promise<void> {
    const { error } = (await this.supabase
      .from(SHOPIFY_WEBHOOK_EVENTS_TABLE)
      .delete()
      .lt('received_at', receivedBefore)) as DbResult<null>;
    check(error, 'prune Shopify webhooks');
  }

  async stats(since: string): Promise<ShopifyWebhookStats> {
    const { data, error } = (await this.supabase
      .from(SHOPIFY_WEBHOOK_EVENTS_TABLE)
      .select('received_at')
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle()) as DbResult<{ received_at: string }>;
    check(error, 'load the last Shopify webhook');
    const { error: countError, count } = (await this.supabase
      .from(SHOPIFY_WEBHOOK_EVENTS_TABLE)
      .select('id', { count: 'exact', head: true })
      .gte('received_at', since)) as DbResult<null> & {
      count: number | null;
    };
    check(countError, 'count Shopify webhooks');
    return {
      lastReceivedAt: data?.received_at ?? null,
      receivedSince: count ?? 0,
    };
  }
}
