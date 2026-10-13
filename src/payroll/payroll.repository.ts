import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type { ClassStatus } from '../lessons/lessons.types';
import {
  PAY_RATE_COLUMNS,
  PAY_RATES_TABLE,
  type PayRateRow,
} from '../lessons/pay-rates.repository';

export const PAYROLL_SETTINGS_TABLE = 'payroll_settings';
export const PAYROLL_PERIODS_TABLE = 'payroll_periods';
export const PAYROLL_LINES_TABLE = 'payroll_lines';
export const PAGE_SIZE = 1000;

export const PAYROLL_SETTINGS_COLUMNS = 'anchor_date, period_days, updated_at';
export const PAYROLL_PERIOD_COLUMNS =
  'id, starts_on, ends_on, status, finalized_at, finalized_by';
export const PAYROLL_LINE_COLUMNS = [
  'id, period_id, instructor_id, class_id, kind, description, lesson_type_id, class_status, starts_at, ends_at, customer_names, minutes, hourly_rate, currency, amount, flags, created_at',
  'instructor:instructors(display_name_en, display_name_zh, email)',
  'lesson_type:lesson_types(name_zh)',
].join(', ');
export const PAYROLL_CLASS_COLUMNS = [
  'id, instructor_id, lesson_type_id, starts_at, ends_at, status',
  'instructor:instructors(display_name_en, display_name_zh, email)',
  'lesson_type:lesson_types(name_en, name_zh)',
  'participants:class_participants(customer:customers(first_name, last_name))',
].join(', ');

export interface PayrollSettingsRow {
  anchor_date: string;
  period_days: number;
  updated_at: string;
}

export type PayrollPeriodStatus = 'open' | 'finalized';

export interface PayrollPeriodRow {
  id: string;
  starts_on: string;
  ends_on: string;
  status: PayrollPeriodStatus;
  finalized_at: string | null;
  finalized_by: string | null;
}

export interface InstructorEmbed {
  display_name_en: string;
  display_name_zh: string | null;
  email: string;
}

export interface PayrollLineRow {
  id: string;
  period_id: string;
  instructor_id: string;
  class_id: string | null;
  kind: 'class' | 'adjustment';
  description: string | null;
  lesson_type_id: string | null;
  class_status: ClassStatus | null;
  starts_at: string | null;
  ends_at: string | null;
  customer_names: string[];
  minutes: number | null;
  hourly_rate: number | string | null;
  currency: string;
  amount: number | string;
  flags: string[];
  created_at: string;
  instructor: InstructorEmbed | null;
  lesson_type: { name_zh: string | null } | null;
}

export interface PayrollClassRow {
  id: string;
  instructor_id: string;
  lesson_type_id: string | null;
  starts_at: string;
  ends_at: string;
  status: ClassStatus;
  instructor: InstructorEmbed | null;
  lesson_type: { name_en: string; name_zh: string | null } | null;
  participants:
    | {
        customer: {
          first_name: string | null;
          last_name: string | null;
        } | null;
      }[]
    | null;
}

export interface AdjustmentInsert {
  period_id: string;
  instructor_id: string;
  kind: 'adjustment';
  description: string;
  currency: string;
  amount: number;
  created_by: string | null;
}

export interface SnapshotLine {
  instructor_id: string;
  class_id: string;
  description: string | null;
  lesson_type_id: string | null;
  class_status: ClassStatus;
  starts_at: string;
  ends_at: string;
  customer_names: string[];
  minutes: number;
  hourly_rate: number | null;
  currency: string;
  amount: number;
  flags: string[];
}

export abstract class PayrollRepository {
  abstract settings(): Promise<PayrollSettingsRow>;
  abstract setAnchor(anchorDate: string, actor: string | null): Promise<void>;
  abstract hasFinalizedPeriod(): Promise<boolean>;
  abstract ensurePeriods(
    periods: { starts_on: string; ends_on: string }[],
  ): Promise<PayrollPeriodRow[]>;
  abstract findPeriod(id: string): Promise<PayrollPeriodRow | null>;
  abstract classesBetween(from: string, to: string): Promise<PayrollClassRow[]>;
  abstract ratesFor(lessonTypeIds: string[]): Promise<PayRateRow[]>;
  abstract lines(periodId: string): Promise<PayrollLineRow[]>;
  abstract insertAdjustment(input: AdjustmentInsert): Promise<PayrollLineRow>;
  abstract deleteAdjustment(
    periodId: string,
    id: string,
  ): Promise<PayrollLineRow | null>;
  abstract finalize(
    periodId: string,
    lines: SnapshotLine[],
    actor: string | null,
  ): Promise<void>;
  abstract reopen(periodId: string): Promise<void>;
}

@Injectable()
export class SupabasePayrollRepository extends PayrollRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async settings(): Promise<PayrollSettingsRow> {
    const { data, error } = (await this.supabase
      .from(PAYROLL_SETTINGS_TABLE)
      .select(PAYROLL_SETTINGS_COLUMNS)
      .eq('id', true)
      .single()) as DbResult<PayrollSettingsRow>;
    check(error, 'load payroll settings');
    if (!data) {
      throw new Error('Failed to load payroll settings: no row returned');
    }
    return data;
  }

  async setAnchor(anchorDate: string, actor: string | null): Promise<void> {
    const { error } = await this.supabase.rpc('payroll_set_anchor', {
      p_anchor: anchorDate,
      p_actor: actor,
    });
    check(error, 'set payroll anchor');
  }

  async hasFinalizedPeriod(): Promise<boolean> {
    const { data, error } = (await this.supabase
      .from(PAYROLL_PERIODS_TABLE)
      .select('id')
      .eq('status', 'finalized')
      .limit(1)) as DbResult<{ id: string }[]>;
    check(error, 'check finalized payroll periods');
    return (data ?? []).length > 0;
  }

  async ensurePeriods(
    periods: { starts_on: string; ends_on: string }[],
  ): Promise<PayrollPeriodRow[]> {
    const { error } = await this.supabase
      .from(PAYROLL_PERIODS_TABLE)
      .upsert(periods, { onConflict: 'starts_on', ignoreDuplicates: true });
    check(error, 'create payroll periods');
    const { data, error: selectError } = (await this.supabase
      .from(PAYROLL_PERIODS_TABLE)
      .select(PAYROLL_PERIOD_COLUMNS)
      .in(
        'starts_on',
        periods.map((p) => p.starts_on),
      )
      .order('starts_on', { ascending: true })) as DbResult<PayrollPeriodRow[]>;
    check(selectError, 'list payroll periods');
    return data ?? [];
  }

  async findPeriod(id: string): Promise<PayrollPeriodRow | null> {
    const { data, error } = (await this.supabase
      .from(PAYROLL_PERIODS_TABLE)
      .select(PAYROLL_PERIOD_COLUMNS)
      .eq('id', id)
      .maybeSingle()) as DbResult<PayrollPeriodRow>;
    check(error, 'load payroll period');
    return data ?? null;
  }

  async classesBetween(from: string, to: string): Promise<PayrollClassRow[]> {
    const rows: PayrollClassRow[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = (await this.supabase
        .from('classes')
        .select(PAYROLL_CLASS_COLUMNS)
        .gte('starts_at', from)
        .lt('starts_at', to)
        .neq('status', 'cancelled')
        .order('starts_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1)) as unknown as DbResult<
        PayrollClassRow[]
      >;
      check(error, 'load payroll classes');
      const page = data ?? [];
      rows.push(...page);
      if (page.length < PAGE_SIZE) {
        return rows;
      }
    }
  }

  async ratesFor(lessonTypeIds: string[]): Promise<PayRateRow[]> {
    if (lessonTypeIds.length === 0) {
      return [];
    }
    const { data, error } = (await this.supabase
      .from(PAY_RATES_TABLE)
      .select(PAY_RATE_COLUMNS)
      .in('lesson_type_id', lessonTypeIds)) as DbResult<PayRateRow[]>;
    check(error, 'load pay rates');
    return data ?? [];
  }

  async lines(periodId: string): Promise<PayrollLineRow[]> {
    const rows: PayrollLineRow[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = (await this.supabase
        .from(PAYROLL_LINES_TABLE)
        .select(PAYROLL_LINE_COLUMNS)
        .eq('period_id', periodId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1)) as unknown as DbResult<
        PayrollLineRow[]
      >;
      check(error, 'load payroll lines');
      const page = data ?? [];
      rows.push(...page);
      if (page.length < PAGE_SIZE) {
        return rows;
      }
    }
  }

  async insertAdjustment(input: AdjustmentInsert): Promise<PayrollLineRow> {
    const { data, error } = (await this.supabase
      .from(PAYROLL_LINES_TABLE)
      .insert(input)
      .select(PAYROLL_LINE_COLUMNS)
      .single()) as unknown as DbResult<PayrollLineRow>;
    check(error, 'create payroll adjustment');
    if (!data) {
      throw new Error('Failed to create payroll adjustment: no row returned');
    }
    return data;
  }

  async deleteAdjustment(
    periodId: string,
    id: string,
  ): Promise<PayrollLineRow | null> {
    const { data, error } = (await this.supabase
      .from(PAYROLL_LINES_TABLE)
      .delete()
      .eq('id', id)
      .eq('period_id', periodId)
      .eq('kind', 'adjustment')
      .select(PAYROLL_LINE_COLUMNS)
      .maybeSingle()) as unknown as DbResult<PayrollLineRow>;
    check(error, 'delete payroll adjustment');
    return data ?? null;
  }

  async finalize(
    periodId: string,
    lines: SnapshotLine[],
    actor: string | null,
  ): Promise<void> {
    const { error } = await this.supabase.rpc('payroll_finalize', {
      p_period_id: periodId,
      p_lines: lines,
      p_actor: actor,
    });
    check(error, 'finalize payroll period');
  }

  async reopen(periodId: string): Promise<void> {
    const { error } = await this.supabase.rpc('payroll_reopen', {
      p_period_id: periodId,
    });
    check(error, 'reopen payroll period');
  }
}
