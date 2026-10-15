import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult, likePattern } from '../database/db-result';
import {
  type CountedResult,
  type PageRequest,
  PGRST_RANGE_NOT_SATISFIABLE,
  type RowPage,
} from '../database/pagination';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

export const CUSTOMERS_TABLE = 'customers';
export const CUSTOMER_COLUMNS =
  'id, shopify_customer_id, first_name, last_name, email, phone, shopify_updated_at, shopify_deleted_at, created_at, updated_at';

export interface CustomerRow {
  id: string;
  shopify_customer_id: number | string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  shopify_updated_at: string | null;
  shopify_deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerUpsert {
  shopify_customer_id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  shopify_updated_at: string | null;
}

export interface CustomerPageRequest extends PageRequest {
  includeDeleted?: boolean;
}

export type CustomerUpsertOutcome = 'inserted' | 'updated' | 'stale';

export interface CustomerReconcileCounts {
  deleted: number;
  restored: number;
}

export type CustomerRowPage = RowPage<CustomerRow>;

export abstract class CustomersRepository {
  abstract search(
    tokens: string[],
    page: CustomerPageRequest,
  ): Promise<CustomerRowPage>;
  abstract latestShopifyUpdatedAt(): Promise<string | null>;
  abstract upsertMany(rows: CustomerUpsert[]): Promise<void>;
  abstract upsertOne(row: CustomerUpsert): Promise<CustomerRow>;
  abstract upsertIfNewer(row: CustomerUpsert): Promise<CustomerUpsertOutcome>;
  abstract markDeletedInShopify(
    shopifyCustomerId: number,
    deletedAt: string,
  ): Promise<boolean>;
  abstract reconcileDeletions(
    shopifyCustomerIds: number[],
    startedAt: string,
  ): Promise<CustomerReconcileCounts>;
  abstract countCustomers(deleted: boolean): Promise<number>;
}

@Injectable()
export class SupabaseCustomersRepository extends CustomersRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async search(
    tokens: string[],
    { limit, offset, includeDeleted = false }: CustomerPageRequest,
  ): Promise<CustomerRowPage> {
    const { data, error, count } = (await this.matching(
      this.supabase
        .from(CUSTOMERS_TABLE)
        .select(CUSTOMER_COLUMNS, { count: 'exact' }),
      tokens,
      includeDeleted,
    )
      .order('last_name', { ascending: true, nullsFirst: false })
      .order('first_name', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1)) as CountedResult<CustomerRow[]>;
    if (error?.code === PGRST_RANGE_NOT_SATISFIABLE) {
      return { rows: [], total: await this.count(tokens, includeDeleted) };
    }
    check(error, 'search customers');
    return { rows: data ?? [], total: count ?? 0 };
  }

  private async count(
    tokens: string[],
    includeDeleted: boolean,
  ): Promise<number> {
    const { error, count } = (await this.matching(
      this.supabase
        .from(CUSTOMERS_TABLE)
        .select('id', { count: 'exact', head: true }),
      tokens,
      includeDeleted,
    )) as CountedResult<null>;
    check(error, 'count customers');
    return count ?? 0;
  }

  private matching<
    Q extends {
      ilike(column: string, pattern: string): Q;
      is(column: string, value: null): Q;
    },
  >(query: Q, tokens: string[], includeDeleted: boolean): Q {
    return tokens.reduce(
      (q, token) => q.ilike('search_text', likePattern(token.toLowerCase())),
      includeDeleted ? query : query.is('shopify_deleted_at', null),
    );
  }

  async latestShopifyUpdatedAt(): Promise<string | null> {
    const { data, error } = (await this.supabase
      .from(CUSTOMERS_TABLE)
      .select('shopify_updated_at')
      .not('shopify_updated_at', 'is', null)
      .order('shopify_updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()) as DbResult<{ shopify_updated_at: string }>;
    check(error, 'load customer sync cursor');
    return data?.shopify_updated_at ?? null;
  }

  async upsertMany(rows: CustomerUpsert[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const { error } = (await this.supabase
      .from(CUSTOMERS_TABLE)
      .upsert(rows, { onConflict: 'shopify_customer_id' })) as DbResult<null>;
    check(error, 'save customers');
  }

  async upsertOne(row: CustomerUpsert): Promise<CustomerRow> {
    const { data, error } = (await this.supabase
      .from(CUSTOMERS_TABLE)
      .upsert(row, { onConflict: 'shopify_customer_id' })
      .select(CUSTOMER_COLUMNS)
      .single()) as DbResult<CustomerRow>;
    check(error, 'save customer');
    if (!data) {
      throw new Error('Failed to save customer: no row returned');
    }
    return data;
  }

  async upsertIfNewer(row: CustomerUpsert): Promise<CustomerUpsertOutcome> {
    const { data, error } = (await this.supabase.rpc(
      'upsert_customer_if_newer',
      {
        p_shopify_customer_id: row.shopify_customer_id,
        p_first_name: row.first_name,
        p_last_name: row.last_name,
        p_email: row.email,
        p_phone: row.phone,
        p_shopify_updated_at: row.shopify_updated_at,
      },
    )) as DbResult<CustomerUpsertOutcome>;
    check(error, 'save customer from Shopify');
    if (!data) {
      throw new Error('Failed to save customer from Shopify: no outcome');
    }
    return data;
  }

  async markDeletedInShopify(
    shopifyCustomerId: number,
    deletedAt: string,
  ): Promise<boolean> {
    const { data, error } = (await this.supabase.rpc(
      'mark_customer_deleted_in_shopify',
      { p_shopify_customer_id: shopifyCustomerId, p_deleted_at: deletedAt },
    )) as DbResult<boolean>;
    check(error, 'mark customer deleted');
    return data === true;
  }

  async reconcileDeletions(
    shopifyCustomerIds: number[],
    startedAt: string,
  ): Promise<CustomerReconcileCounts> {
    const { data, error } = (await this.supabase.rpc(
      'reconcile_customer_deletions',
      { p_shopify_ids: shopifyCustomerIds, p_started_at: startedAt },
    )) as DbResult<CustomerReconcileCounts>;
    check(error, 'reconcile customer deletions');
    return { deleted: data?.deleted ?? 0, restored: data?.restored ?? 0 };
  }

  async countCustomers(deleted: boolean): Promise<number> {
    const query = this.supabase
      .from(CUSTOMERS_TABLE)
      .select('id', { count: 'exact', head: true });
    const { error, count } = (await (deleted
      ? query.not('shopify_deleted_at', 'is', null)
      : query.is('shopify_deleted_at', null))) as CountedResult<null>;
    check(error, 'count customers');
    return count ?? 0;
  }
}
