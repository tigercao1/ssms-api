import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult, likePattern } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

type CountedResult<T> = DbResult<T> & { count: number | null };

export const CUSTOMERS_TABLE = 'customers';
export const CUSTOMER_COLUMNS =
  'id, shopify_customer_id, first_name, last_name, email, phone, shopify_updated_at, created_at, updated_at';

export interface CustomerRow {
  id: string;
  shopify_customer_id: number | string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  shopify_updated_at: string | null;
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

export interface CustomerPageRequest {
  limit: number;
  offset: number;
}

export interface CustomerRowPage {
  rows: CustomerRow[];
  total: number;
}

export const PGRST_RANGE_NOT_SATISFIABLE = 'PGRST103';

export abstract class CustomersRepository {
  abstract search(
    tokens: string[],
    page: CustomerPageRequest,
  ): Promise<CustomerRowPage>;
  abstract latestShopifyUpdatedAt(): Promise<string | null>;
  abstract upsertMany(rows: CustomerUpsert[]): Promise<void>;
  abstract upsertOne(row: CustomerUpsert): Promise<CustomerRow>;
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
    { limit, offset }: CustomerPageRequest,
  ): Promise<CustomerRowPage> {
    const { data, error, count } = (await this.matching(
      this.supabase
        .from(CUSTOMERS_TABLE)
        .select(CUSTOMER_COLUMNS, { count: 'exact' }),
      tokens,
    )
      .order('last_name', { ascending: true, nullsFirst: false })
      .order('first_name', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1)) as CountedResult<CustomerRow[]>;
    if (error?.code === PGRST_RANGE_NOT_SATISFIABLE) {
      return { rows: [], total: await this.count(tokens) };
    }
    check(error, 'search customers');
    return { rows: data ?? [], total: count ?? 0 };
  }

  private async count(tokens: string[]): Promise<number> {
    const { error, count } = (await this.matching(
      this.supabase
        .from(CUSTOMERS_TABLE)
        .select('id', { count: 'exact', head: true }),
      tokens,
    )) as CountedResult<null>;
    check(error, 'count customers');
    return count ?? 0;
  }

  private matching<Q extends { ilike(column: string, pattern: string): Q }>(
    query: Q,
    tokens: string[],
  ): Q {
    return tokens.reduce(
      (q, token) => q.ilike('search_text', likePattern(token.toLowerCase())),
      query,
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
}
