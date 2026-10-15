import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditActor,
} from '../audit/audit.types';
import { DatabaseError, PG_FOREIGN_KEY_VIOLATION } from '../database/db-result';
import { toPayRate } from '../lessons/pay-rates.service';
import type {
  CreatePayrollAdjustmentDto,
  FinalizePayrollPeriodDto,
} from './dto/payroll.dto';
import { payrollDetailCsv, payrollSheetCsv } from './payroll-csv';
import {
  type ClassLine,
  type CurrencyTotal,
  classLinesFor,
  currencyTotals,
  DEFAULT_CURRENCY,
  type InstructorTotal,
  instructorTotals,
  markAlreadyPaid,
  NEEDS_RATE,
  type PayableClass,
} from './payroll-lines';
import {
  addDays,
  localDate,
  localTime,
  periodsAround,
  startOfLocalDay,
} from './payroll-time';
import {
  type InstructorEmbed,
  type PayrollClassRow,
  type PayrollLineRow,
  type PayrollPeriodRow,
  type PayrollPeriodStatus,
  PayrollRepository,
} from './payroll.repository';

export const PAYROLL_CLOCK = Symbol('PAYROLL_CLOCK');
export const PERIODS_BEFORE = 2;
export const PERIODS_AFTER = 2;

export const PERIOD_NOT_FOUND = 'Payroll period not found';
export const PERIOD_FINALIZED =
  'This payroll period is finalized; reopen it to make changes';
export const PERIOD_NOT_FINALIZED = 'This payroll period is not finalized';
export const PERIOD_NEEDS_RATE =
  'Some lessons have no pay rate; set the rates or finalize with acceptZeroRate';
export const SETTINGS_LOCKED =
  'The payroll anchor cannot change once a period is finalized';
export const ANCHOR_HAS_ADJUSTMENTS =
  'Adjustments exist in periods the new anchor would remove; delete them first';
export const ADJUSTMENT_NOT_FOUND = 'Adjustment not found';
export const INSTRUCTOR_NOT_FOUND = 'Instructor not found';

const PG_PREREQUISITE_STATE = '55000';
const PG_NO_DATA_FOUND = 'P0002';

export interface PayrollSettings {
  anchorDate: string;
  periodDays: number;
  locked: boolean;
}

export interface PayrollPeriod {
  id: string;
  startsOn: string;
  endsOn: string;
  status: PayrollPeriodStatus;
  finalizedAt: string | null;
  finalizedBy: string | null;
  isCurrent: boolean;
}

export interface PayrollLessonLine extends ClassLine {
  date: string;
  time: string;
  lessonTypeNameZh: string | null;
  instructorName: string | null;
}

export interface PayrollAdjustment {
  id: string;
  instructorId: string;
  instructorName: string | null;
  description: string;
  amount: number;
  currency: string;
  createdAt: string;
}

export interface PayrollInstructorSummary extends InstructorTotal {
  instructorName: string | null;
  instructorNameZh: string | null;
  email: string | null;
}

export interface PayrollPeriodDetail {
  period: PayrollPeriod;
  instructors: PayrollInstructorSummary[];
  lines: PayrollLessonLine[];
  adjustments: PayrollAdjustment[];
  totals: CurrencyTotal[];
  needsRateCount: number;
}

export interface PayrollExport {
  filename: string;
  body: string;
}

function customerName(
  customer: { first_name: string | null; last_name: string | null } | null,
): string {
  return [customer?.first_name, customer?.last_name]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0)
    .join(' ');
}

function toPayable(row: PayrollClassRow): PayableClass {
  return {
    id: row.id,
    instructorId: row.instructor_id,
    lessonTypeId: row.lesson_type_id,
    lessonTypeName: row.lesson_type?.name_en ?? null,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    customerNames: (row.participants ?? [])
      .map((p) => customerName(p.customer))
      .filter((name) => name.length > 0),
  };
}

function storedLine(row: PayrollLineRow): ClassLine {
  return {
    classId: row.class_id as string,
    instructorId: row.instructor_id,
    lessonTypeId: row.lesson_type_id,
    description: row.description,
    classStatus: row.class_status ?? 'completed',
    startsAt: row.starts_at as string,
    endsAt: row.ends_at as string,
    customerNames: row.customer_names ?? [],
    minutes: row.minutes ?? 0,
    hourlyRate: row.hourly_rate === null ? null : Number(row.hourly_rate),
    rateUnit: row.rate_unit,
    currency: row.currency,
    amount: Number(row.amount),
    flags: row.flags ?? [],
  };
}

function toAdjustment(row: PayrollLineRow): PayrollAdjustment {
  return {
    id: row.id,
    instructorId: row.instructor_id,
    instructorName: row.instructor?.display_name_en ?? null,
    description: row.description ?? '',
    amount: Number(row.amount),
    currency: row.currency,
    createdAt: row.created_at,
  };
}

function toHttp(err: unknown): unknown {
  if (!(err instanceof DatabaseError)) {
    return err;
  }
  switch (err.code) {
    case PG_PREREQUISITE_STATE:
      return new ConflictException(
        err.message.includes('not finalized')
          ? PERIOD_NOT_FINALIZED
          : err.message.includes('adjustments exist')
            ? ANCHOR_HAS_ADJUSTMENTS
            : err.message.includes('a payroll period is finalized')
              ? SETTINGS_LOCKED
              : PERIOD_FINALIZED,
      );
    case PG_NO_DATA_FOUND:
      return new NotFoundException(PERIOD_NOT_FOUND);
    case PG_FOREIGN_KEY_VIOLATION:
      return new BadRequestException(INSTRUCTOR_NOT_FOUND);
    default:
      return err;
  }
}

@Injectable()
export class PayrollService {
  private readonly now: () => Date;

  constructor(
    private readonly repo: PayrollRepository,
    private readonly audit: AuditService,
    @Optional() @Inject(PAYROLL_CLOCK) clock?: () => Date,
  ) {
    this.now = clock ?? (() => new Date());
  }

  async settings(): Promise<PayrollSettings> {
    const [row, locked] = await Promise.all([
      this.repo.settings(),
      this.repo.hasFinalizedPeriod(),
    ]);
    return {
      anchorDate: row.anchor_date,
      periodDays: row.period_days,
      locked,
    };
  }

  async updateSettings(
    anchorDate: string,
    actor: AuditActor,
  ): Promise<PayrollSettings> {
    const before = await this.settings();
    if (before.locked) {
      throw new ConflictException(SETTINGS_LOCKED);
    }
    try {
      await this.repo.setAnchor(anchorDate, actor.userId ?? null);
    } catch (err) {
      throw toHttp(err);
    }
    const after = await this.settings();
    await this.record(AUDIT_ACTIONS.payrollSettingsUpdate, actor, null, {
      before: { anchorDate: before.anchorDate },
      after: { anchorDate: after.anchorDate },
    });
    return after;
  }

  async listPeriods(around?: string): Promise<PayrollPeriod[]> {
    const { anchor_date: anchor } = await this.repo.settings();
    const ranges = periodsAround(
      anchor,
      around ?? this.today(),
      PERIODS_BEFORE,
      PERIODS_AFTER,
    );
    const rows = await this.repo.ensurePeriods(
      ranges.map((r) => ({ starts_on: r.startsOn, ends_on: r.endsOn })),
    );
    return rows.map((row) => this.toPeriod(row));
  }

  async detail(id: string): Promise<PayrollPeriodDetail> {
    const period = await this.loadPeriod(id);
    const rows = await this.repo.lines(id);
    const names = new Map<string, InstructorEmbed>();
    const zhNames = new Map<string, string | null>();
    for (const row of rows) {
      if (row.instructor) names.set(row.instructor_id, row.instructor);
      if (row.lesson_type_id && row.lesson_type) {
        zhNames.set(row.lesson_type_id, row.lesson_type.name_zh);
      }
    }
    let classLines: ClassLine[];
    if (period.status === 'open') {
      const classes = await this.repo.classesBetween(
        startOfLocalDay(period.starts_on),
        startOfLocalDay(addDays(period.ends_on, 1)),
      );
      for (const row of classes) {
        if (row.instructor) names.set(row.instructor_id, row.instructor);
        if (row.lesson_type_id && row.lesson_type) {
          zhNames.set(row.lesson_type_id, row.lesson_type.name_zh);
        }
      }
      const lessonTypeIds = [
        ...new Set(
          classes
            .map((c) => c.lesson_type_id)
            .filter((v): v is string => v !== null),
        ),
      ];
      const rates = (await this.repo.ratesFor(lessonTypeIds)).map(toPayRate);
      const live = classLinesFor(
        classes.map(toPayable),
        rates,
        period.starts_on,
        period.ends_on,
      );
      const paidElsewhere = await this.repo.classesPaidElsewhere(
        period.id,
        live.map((line) => line.classId),
      );
      classLines = markAlreadyPaid(live, new Set(paidElsewhere));
    } else {
      classLines = rows
        .filter((row) => row.kind === 'class')
        .map(storedLine)
        .sort(
          (a, b) =>
            a.startsAt.localeCompare(b.startsAt) ||
            a.classId.localeCompare(b.classId),
        );
    }
    const adjustments = rows
      .filter((row) => row.kind === 'adjustment')
      .map(toAdjustment);
    const totals = instructorTotals(classLines, adjustments)
      .map((total) => {
        const who = names.get(total.instructorId);
        return {
          ...total,
          instructorName: who?.display_name_en ?? null,
          instructorNameZh: who?.display_name_zh ?? null,
          email: who?.email ?? null,
        };
      })
      .sort(
        (a, b) =>
          (a.instructorName ?? '').localeCompare(b.instructorName ?? '') ||
          a.instructorId.localeCompare(b.instructorId) ||
          a.currency.localeCompare(b.currency),
      );
    return {
      period: this.toPeriod(period),
      instructors: totals,
      lines: classLines.map((line) => ({
        ...line,
        date: localDate(line.startsAt),
        time: localTime(line.startsAt),
        lessonTypeNameZh: line.lessonTypeId
          ? (zhNames.get(line.lessonTypeId) ?? null)
          : null,
        instructorName: names.get(line.instructorId)?.display_name_en ?? null,
      })),
      adjustments,
      totals: currencyTotals(totals),
      needsRateCount: classLines.filter((l) => l.flags.includes(NEEDS_RATE))
        .length,
    };
  }

  async addAdjustment(
    periodId: string,
    dto: CreatePayrollAdjustmentDto,
    actor: AuditActor,
  ): Promise<PayrollAdjustment> {
    await this.loadOpenPeriod(periodId);
    let row: PayrollLineRow;
    try {
      row = await this.repo.insertAdjustment({
        period_id: periodId,
        instructor_id: dto.instructorId,
        kind: 'adjustment',
        description: dto.description,
        currency: dto.currency ?? DEFAULT_CURRENCY,
        amount: dto.amount,
        created_by: actor.userId ?? null,
      });
    } catch (err) {
      throw toHttp(err);
    }
    const adjustment = toAdjustment(row);
    await this.record(AUDIT_ACTIONS.payrollAdjustmentCreate, actor, periodId, {
      after: adjustment,
    });
    return adjustment;
  }

  async deleteAdjustment(
    periodId: string,
    adjustmentId: string,
    actor: AuditActor,
  ): Promise<void> {
    await this.loadOpenPeriod(periodId);
    let row: PayrollLineRow | null;
    try {
      row = await this.repo.deleteAdjustment(periodId, adjustmentId);
    } catch (err) {
      throw toHttp(err);
    }
    if (!row) {
      throw new NotFoundException(ADJUSTMENT_NOT_FOUND);
    }
    await this.record(AUDIT_ACTIONS.payrollAdjustmentDelete, actor, periodId, {
      before: toAdjustment(row),
    });
  }

  async finalize(
    periodId: string,
    dto: FinalizePayrollPeriodDto,
    actor: AuditActor,
  ): Promise<PayrollPeriodDetail> {
    const live = await this.detail(periodId);
    if (live.period.status !== 'open') {
      throw new ConflictException(PERIOD_FINALIZED);
    }
    if (live.needsRateCount > 0 && dto.acceptZeroRate !== true) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: PERIOD_NEEDS_RATE,
        needsRateCount: live.needsRateCount,
      });
    }
    try {
      await this.repo.finalize(
        periodId,
        live.lines.map((line) => ({
          instructor_id: line.instructorId,
          class_id: line.classId,
          description: line.description,
          lesson_type_id: line.lessonTypeId,
          class_status: line.classStatus,
          starts_at: line.startsAt,
          ends_at: line.endsAt,
          customer_names: line.customerNames,
          minutes: line.minutes,
          hourly_rate: line.hourlyRate,
          rate_unit: line.rateUnit,
          currency: line.currency,
          amount: line.amount,
          flags: line.flags,
        })),
        actor.userId ?? null,
      );
    } catch (err) {
      throw toHttp(err);
    }
    await this.record(AUDIT_ACTIONS.payrollFinalize, actor, periodId, {
      startsOn: live.period.startsOn,
      endsOn: live.period.endsOn,
      lines: live.lines.length,
      adjustments: live.adjustments.length,
      needsRateCount: live.needsRateCount,
      acceptZeroRate: dto.acceptZeroRate === true,
      totals: live.totals,
    });
    return this.detail(periodId);
  }

  async reopen(
    periodId: string,
    actor: AuditActor,
  ): Promise<PayrollPeriodDetail> {
    const period = await this.loadPeriod(periodId);
    if (period.status !== 'finalized') {
      throw new ConflictException(PERIOD_NOT_FINALIZED);
    }
    try {
      await this.repo.reopen(periodId);
    } catch (err) {
      throw toHttp(err);
    }
    await this.record(AUDIT_ACTIONS.payrollReopen, actor, periodId, {
      startsOn: period.starts_on,
      endsOn: period.ends_on,
      finalizedAt: period.finalized_at,
      finalizedBy: period.finalized_by,
    });
    return this.detail(periodId);
  }

  async export(periodId: string, detailed: boolean): Promise<PayrollExport> {
    const detail = await this.detail(periodId);
    const range = `${detail.period.startsOn}-to-${detail.period.endsOn}`;
    return detailed
      ? {
          filename: `payroll-detail-${range}.csv`,
          body: payrollDetailCsv(detail),
        }
      : { filename: `payroll-${range}.csv`, body: payrollSheetCsv(detail) };
  }

  private today(): string {
    return localDate(this.now());
  }

  private toPeriod(row: PayrollPeriodRow): PayrollPeriod {
    const today = this.today();
    return {
      id: row.id,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      status: row.status,
      finalizedAt: row.finalized_at,
      finalizedBy: row.finalized_by,
      isCurrent: row.starts_on <= today && today <= row.ends_on,
    };
  }

  private async loadPeriod(id: string): Promise<PayrollPeriodRow> {
    const period = await this.repo.findPeriod(id);
    if (!period) {
      throw new NotFoundException(PERIOD_NOT_FOUND);
    }
    return period;
  }

  private async loadOpenPeriod(id: string): Promise<PayrollPeriodRow> {
    const period = await this.loadPeriod(id);
    if (period.status !== 'open') {
      throw new ConflictException(PERIOD_FINALIZED);
    }
    return period;
  }

  private record(
    action: AuditAction,
    actor: AuditActor,
    periodId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      action,
      actor: { ...actor, role: 'admin' },
      targetType: periodId ? 'payroll_period' : 'payroll_settings',
      targetId: periodId,
      metadata,
    });
  }
}
