import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type { RateUnit } from './pay-rates';

export const PAY_RATES_TABLE = 'pay_rates';
export const PAY_RATE_COLUMNS =
  'id, lesson_type_id, instructor_id, hourly_rate, rate_unit, currency, effective_from, effective_to, created_at, updated_at';

export interface PayRateRow {
  id: string;
  lesson_type_id: string;
  instructor_id: string | null;
  hourly_rate: number | string;
  rate_unit: RateUnit;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayRateFilter {
  lessonTypeId?: string;
  instructorId?: string;
  scope?: 'default' | 'override';
}

export interface PayRateInsert {
  lesson_type_id: string;
  instructor_id: string | null;
  hourly_rate: number;
  rate_unit?: RateUnit;
  currency?: string;
  effective_from: string;
  effective_to: string | null;
  created_by: string | null;
}

export interface PayRatePatch {
  hourly_rate?: number;
  rate_unit?: RateUnit;
  currency?: string;
  effective_from?: string;
  effective_to?: string | null;
}

export abstract class PayRatesRepository {
  abstract list(filter: PayRateFilter): Promise<PayRateRow[]>;
  abstract findById(id: string): Promise<PayRateRow | null>;
  abstract ratesFor(
    lessonTypeId: string,
    instructorId: string,
  ): Promise<PayRateRow[]>;
  abstract insert(input: PayRateInsert): Promise<PayRateRow>;
  abstract update(id: string, patch: PayRatePatch): Promise<PayRateRow | null>;
}

@Injectable()
export class SupabasePayRatesRepository extends PayRatesRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async list(filter: PayRateFilter): Promise<PayRateRow[]> {
    let query = this.supabase.from(PAY_RATES_TABLE).select(PAY_RATE_COLUMNS);
    if (filter.lessonTypeId) {
      query = query.eq('lesson_type_id', filter.lessonTypeId);
    }
    if (filter.instructorId) {
      query = query.eq('instructor_id', filter.instructorId);
    }
    if (filter.scope === 'default') {
      query = query.is('instructor_id', null);
    } else if (filter.scope === 'override') {
      query = query.not('instructor_id', 'is', null);
    }
    const { data, error } = (await query
      .order('lesson_type_id', { ascending: true })
      .order('effective_from', { ascending: false })
      .order('id', { ascending: true })) as DbResult<PayRateRow[]>;
    check(error, 'list pay rates');
    return data ?? [];
  }

  async findById(id: string): Promise<PayRateRow | null> {
    const { data, error } = (await this.supabase
      .from(PAY_RATES_TABLE)
      .select(PAY_RATE_COLUMNS)
      .eq('id', id)
      .maybeSingle()) as DbResult<PayRateRow>;
    check(error, 'load pay rate');
    return data ?? null;
  }

  async ratesFor(
    lessonTypeId: string,
    instructorId: string,
  ): Promise<PayRateRow[]> {
    const { data, error } = (await this.supabase
      .from(PAY_RATES_TABLE)
      .select(PAY_RATE_COLUMNS)
      .eq('lesson_type_id', lessonTypeId)
      .or(
        `instructor_id.is.null,instructor_id.eq.${instructorId}`,
      )) as DbResult<PayRateRow[]>;
    check(error, 'load pay rates');
    return data ?? [];
  }

  async insert(input: PayRateInsert): Promise<PayRateRow> {
    const { data, error } = (await this.supabase
      .from(PAY_RATES_TABLE)
      .insert(input)
      .select(PAY_RATE_COLUMNS)
      .single()) as DbResult<PayRateRow>;
    check(error, 'create pay rate');
    if (!data) {
      throw new Error('Failed to create pay rate: no row returned');
    }
    return data;
  }

  async update(id: string, patch: PayRatePatch): Promise<PayRateRow | null> {
    const { data, error } = (await this.supabase
      .from(PAY_RATES_TABLE)
      .update(patch)
      .eq('id', id)
      .select(PAY_RATE_COLUMNS)
      .maybeSingle()) as DbResult<PayRateRow>;
    check(error, 'update pay rate');
    return data ?? null;
  }
}
