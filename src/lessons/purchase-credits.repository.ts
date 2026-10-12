import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { check } from './lesson-products.repository';
import type { PurchaseCredits } from './lessons.types';

export const PURCHASES_TABLE = 'purchases';
const COLUMNS = 'id, credits_total, credits_used, status';

export abstract class PurchaseCreditsRepository {
  abstract find(purchaseId: string): Promise<PurchaseCredits | null>;
  abstract setCreditsUsed(
    purchaseId: string,
    expectedUsed: number,
    nextUsed: number,
  ): Promise<PurchaseCredits | null>;
}

type DbResult<T> = { data: T | null; error: { message: string } | null };

@Injectable()
export class SupabasePurchaseCreditsRepository extends PurchaseCreditsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async find(purchaseId: string): Promise<PurchaseCredits | null> {
    const { data, error } = (await this.supabase
      .from(PURCHASES_TABLE)
      .select(COLUMNS)
      .eq('id', purchaseId)
      .maybeSingle()) as DbResult<PurchaseCredits>;
    check(error, 'load purchase');
    return data ?? null;
  }

  async setCreditsUsed(
    purchaseId: string,
    expectedUsed: number,
    nextUsed: number,
  ): Promise<PurchaseCredits | null> {
    const { data, error } = (await this.supabase
      .from(PURCHASES_TABLE)
      .update({ credits_used: nextUsed })
      .eq('id', purchaseId)
      .eq('credits_used', expectedUsed)
      .eq('status', 'active')
      .select(COLUMNS)) as DbResult<PurchaseCredits[]>;
    check(error, 'update purchase credits');
    return data?.[0] ?? null;
  }
}
