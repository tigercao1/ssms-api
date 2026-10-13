import {
  DatabaseError,
  PG_FOREIGN_KEY_VIOLATION,
} from '../../src/database/db-result';
import type { ClassStatus } from '../../src/lessons/lessons.types';
import type { PayRateRow } from '../../src/lessons/pay-rates.repository';
import { daysBetween } from '../../src/payroll/payroll-time';
import {
  type AdjustmentInsert,
  type InstructorEmbed,
  type PayrollClassRow,
  type PayrollLineRow,
  PayrollRepository,
  type PayrollPeriodRow,
  type PayrollSettingsRow,
  type SnapshotLine,
} from '../../src/payroll/payroll.repository';

export const ADA_ID = '2d8b6e3a-4c5f-4a7b-8c9d-0e1f2a3b4c5d';
export const BO_ID = '3e9c7f4b-5d6a-4b8c-9d0e-1f2a3b4c5d6e';
export const PRIVATE_90 = '4fad8a5c-6e7b-4c9d-8e1f-2a3b4c5d6e7f';
export const GROUP_60 = '5abe9b6d-7f8c-4dae-9f2a-3b4c5d6e7f8a';

let sequence = 0;
export const nextPayrollId = () =>
  `00000000-0000-4000-9000-${String(++sequence).padStart(12, '0')}`;

const prerequisite = (detail: string) =>
  new DatabaseError('payroll', '55000', detail);

export class InMemoryPayrollRepository extends PayrollRepository {
  settingsRow: PayrollSettingsRow = {
    anchor_date: '2025-12-15',
    period_days: 14,
    updated_at: '2026-10-01T00:00:00.000Z',
  };
  periods: PayrollPeriodRow[] = [];
  lineRows: PayrollLineRow[] = [];
  classes: PayrollClassRow[] = [];
  rates: PayRateRow[] = [];
  instructorNames = new Map<string, InstructorEmbed>([
    [
      ADA_ID,
      {
        display_name_en: 'Ada Lin',
        display_name_zh: '林艾达',
        email: 'ada@example.com',
      },
    ],
    [
      BO_ID,
      {
        display_name_en: 'Bo Chen',
        display_name_zh: null,
        email: 'bo@example.com',
      },
    ],
  ]);
  lessonTypes = new Map<string, { name_en: string; name_zh: string | null }>([
    [PRIVATE_90, { name_en: 'Private 90', name_zh: '私教90分钟' }],
    [GROUP_60, { name_en: 'Group 60', name_zh: null }],
  ]);
  private clock = Date.parse('2026-10-10T00:00:00.000Z');

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  addClass(input: {
    instructorId?: string;
    lessonTypeId?: string | null;
    startsAt: string;
    minutes?: number;
    status?: ClassStatus;
    customers?: [string | null, string | null][];
  }): PayrollClassRow {
    const instructorId = input.instructorId ?? ADA_ID;
    const lessonTypeId =
      input.lessonTypeId === undefined ? PRIVATE_90 : input.lessonTypeId;
    const row: PayrollClassRow = {
      id: nextPayrollId(),
      instructor_id: instructorId,
      lesson_type_id: lessonTypeId,
      starts_at: new Date(input.startsAt).toISOString(),
      ends_at: new Date(
        Date.parse(input.startsAt) + (input.minutes ?? 90) * 60_000,
      ).toISOString(),
      status: input.status ?? 'completed',
      instructor: this.instructorNames.get(instructorId) ?? null,
      lesson_type: lessonTypeId
        ? (this.lessonTypes.get(lessonTypeId) ?? null)
        : null,
      participants: (input.customers ?? []).map(([first, last]) => ({
        customer: { first_name: first, last_name: last },
      })),
    };
    this.classes.push(row);
    return row;
  }

  addRate(input: {
    lessonTypeId?: string;
    instructorId?: string | null;
    hourlyRate: number | string;
    from: string;
    to?: string | null;
    currency?: string;
  }): void {
    this.rates.push({
      id: nextPayrollId(),
      lesson_type_id: input.lessonTypeId ?? PRIVATE_90,
      instructor_id: input.instructorId ?? null,
      hourly_rate: input.hourlyRate,
      currency: input.currency ?? 'CAD',
      effective_from: input.from,
      effective_to: input.to ?? null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
  }

  private isFinalized(periodId: string): boolean {
    return this.periods.some(
      (p) => p.id === periodId && p.status === 'finalized',
    );
  }

  settings(): Promise<PayrollSettingsRow> {
    return Promise.resolve({ ...this.settingsRow });
  }

  setAnchor(anchorDate: string): Promise<void> {
    if (this.periods.some((p) => p.status === 'finalized')) {
      throw prerequisite('a payroll period is finalized');
    }
    const misaligned = (p: PayrollPeriodRow) =>
      daysBetween(anchorDate, p.starts_on) % 14 !== 0;
    const doomed = new Set(this.periods.filter(misaligned).map((p) => p.id));
    if (this.lineRows.some((l) => doomed.has(l.period_id))) {
      throw prerequisite('payroll adjustments exist');
    }
    this.periods = this.periods.filter((p) => !doomed.has(p.id));
    this.settingsRow = { ...this.settingsRow, anchor_date: anchorDate };
    return Promise.resolve();
  }

  hasFinalizedPeriod(): Promise<boolean> {
    return Promise.resolve(this.periods.some((p) => p.status === 'finalized'));
  }

  ensurePeriods(
    periods: { starts_on: string; ends_on: string }[],
  ): Promise<PayrollPeriodRow[]> {
    for (const period of periods) {
      if (!this.periods.some((p) => p.starts_on === period.starts_on)) {
        this.periods.push({
          id: nextPayrollId(),
          ...period,
          status: 'open',
          finalized_at: null,
          finalized_by: null,
        });
      }
    }
    const wanted = new Set(periods.map((p) => p.starts_on));
    return Promise.resolve(
      this.periods
        .filter((p) => wanted.has(p.starts_on))
        .sort((a, b) => a.starts_on.localeCompare(b.starts_on))
        .map((p) => ({ ...p })),
    );
  }

  findPeriod(id: string): Promise<PayrollPeriodRow | null> {
    const period = this.periods.find((p) => p.id === id);
    return Promise.resolve(period ? { ...period } : null);
  }

  classesBetween(from: string, to: string): Promise<PayrollClassRow[]> {
    return Promise.resolve(
      this.classes.filter(
        (c) =>
          Date.parse(c.starts_at) >= Date.parse(from) &&
          Date.parse(c.starts_at) < Date.parse(to) &&
          c.status !== 'cancelled',
      ),
    );
  }

  ratesFor(lessonTypeIds: string[]): Promise<PayRateRow[]> {
    return Promise.resolve(
      this.rates.filter((r) => lessonTypeIds.includes(r.lesson_type_id)),
    );
  }

  lines(periodId: string): Promise<PayrollLineRow[]> {
    return Promise.resolve(
      this.lineRows
        .filter((l) => l.period_id === periodId)
        .map((l) => ({ ...l })),
    );
  }

  insertAdjustment(input: AdjustmentInsert): Promise<PayrollLineRow> {
    if (this.isFinalized(input.period_id)) {
      throw prerequisite('payroll period is finalized');
    }
    if (!this.instructorNames.has(input.instructor_id)) {
      throw new DatabaseError(
        'create payroll adjustment',
        PG_FOREIGN_KEY_VIOLATION,
        'instructor_id',
      );
    }
    const row: PayrollLineRow = {
      id: nextPayrollId(),
      period_id: input.period_id,
      instructor_id: input.instructor_id,
      class_id: null,
      kind: 'adjustment',
      description: input.description,
      lesson_type_id: null,
      class_status: null,
      starts_at: null,
      ends_at: null,
      customer_names: [],
      minutes: null,
      hourly_rate: null,
      currency: input.currency,
      amount: input.amount.toFixed(2),
      flags: [],
      created_at: this.tick(),
      instructor: this.instructorNames.get(input.instructor_id) ?? null,
      lesson_type: null,
    };
    this.lineRows.push(row);
    return Promise.resolve({ ...row });
  }

  deleteAdjustment(
    periodId: string,
    id: string,
  ): Promise<PayrollLineRow | null> {
    const row = this.lineRows.find(
      (l) => l.id === id && l.period_id === periodId && l.kind === 'adjustment',
    );
    if (!row) {
      return Promise.resolve(null);
    }
    if (this.isFinalized(periodId)) {
      throw prerequisite('payroll period is finalized');
    }
    this.lineRows = this.lineRows.filter((l) => l !== row);
    return Promise.resolve({ ...row });
  }

  finalize(
    periodId: string,
    lines: SnapshotLine[],
    actor: string | null,
  ): Promise<void> {
    const period = this.periods.find((p) => p.id === periodId);
    if (!period) {
      throw new DatabaseError('finalize', 'P0002', 'payroll period not found');
    }
    if (period.status !== 'open') {
      throw prerequisite('payroll period is finalized');
    }
    this.lineRows = this.lineRows.filter(
      (l) => !(l.period_id === periodId && l.kind === 'class'),
    );
    for (const line of lines) {
      this.lineRows.push({
        id: nextPayrollId(),
        period_id: periodId,
        kind: 'class',
        ...line,
        hourly_rate:
          line.hourly_rate === null ? null : String(line.hourly_rate),
        amount: line.amount.toFixed(2),
        created_at: this.tick(),
        instructor: this.instructorNames.get(line.instructor_id) ?? null,
        lesson_type: line.lesson_type_id
          ? {
              name_zh:
                this.lessonTypes.get(line.lesson_type_id)?.name_zh ?? null,
            }
          : null,
      });
    }
    period.status = 'finalized';
    period.finalized_at = this.tick();
    period.finalized_by = actor;
    return Promise.resolve();
  }

  reopen(periodId: string): Promise<void> {
    const period = this.periods.find((p) => p.id === periodId);
    if (!period) {
      throw new DatabaseError('reopen', 'P0002', 'payroll period not found');
    }
    if (period.status !== 'finalized') {
      throw prerequisite('payroll period is not finalized');
    }
    period.status = 'open';
    period.finalized_at = null;
    period.finalized_by = null;
    this.lineRows = this.lineRows.filter(
      (l) => !(l.period_id === periodId && l.kind === 'class'),
    );
    return Promise.resolve();
  }
}

export interface PayrollFakeResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

export interface PayrollRecordedCall {
  target: string;
  ops: [string, ...unknown[]][];
}

export function recordingPayrollSupabase(
  results: Record<string, PayrollFakeResult | PayrollFakeResult[]> = {},
) {
  const calls: PayrollRecordedCall[] = [];
  const next = (key: string): PayrollFakeResult => {
    const entry = results[key];
    if (Array.isArray(entry)) {
      return entry.shift() ?? { data: null, error: null };
    }
    return entry ?? { data: null, error: null };
  };
  const builderFor = (key: string, call: PayrollRecordedCall) => {
    const builder: Record<string, unknown> = {
      then: (
        resolve: (r: PayrollFakeResult) => unknown,
        reject: (e: unknown) => void,
      ) => Promise.resolve(next(key)).then(resolve, reject),
    };
    for (const op of [
      'select',
      'eq',
      'neq',
      'in',
      'gte',
      'lt',
      'limit',
      'order',
      'range',
      'insert',
      'upsert',
      'delete',
      'single',
      'maybeSingle',
    ]) {
      builder[op] = (...args: unknown[]) => {
        call.ops.push([op, ...args]);
        return builder;
      };
    }
    return builder;
  };
  const client = {
    from(table: string) {
      const call: PayrollRecordedCall = { target: table, ops: [] };
      calls.push(call);
      return builderFor(table, call);
    },
    rpc(fn: string, args: unknown) {
      const call: PayrollRecordedCall = {
        target: `rpc:${fn}`,
        ops: [['args', args]],
      };
      calls.push(call);
      return builderFor(`rpc:${fn}`, call);
    },
  };
  return { client: client as never, calls };
}
