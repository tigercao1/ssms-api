import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditActor,
} from '../audit/audit.types';
import { pageOffset } from '../database/pagination';
import type { SeasonRow } from '../seasons/seasons.repository';
import { SeasonsService } from '../seasons/seasons.service';
import {
  type AdminInsuranceRecordsQueryDto,
  INSURANCE_LIST_DEFAULT_LIMIT,
} from './dto/insurance.dto';
import {
  type AdminInsuranceRecord,
  type SeasonCoverage,
  toAdminRecord,
  totalsOf,
} from './insurance.presenters';
import {
  type AdminInsuranceRecordRow,
  type InsuranceRecordPatch,
  LessonInsuranceRepository,
  type PaymentStatus,
} from './lesson-insurance.repository';

export const RECORD_NOT_FOUND = 'Insurance record not found';
export const MARK_PAID_NEEDS_UNPAID =
  'Only an unpaid record can be marked paid';
export const MARK_UNPAID_NEEDS_PAID = 'Only a paid record can be marked unpaid';
export const ALREADY_VOIDED = 'This record is already voided';
export const RECORD_CHANGED = 'This record changed; reload and try again';

export interface InstructorInsuranceSummary {
  instructorId: string;
  name: string | null;
  nameZh: string | null;
  email: string | null;
  owedCents: number;
  paidCents: number;
  unpaidCents: number;
  coverage: SeasonCoverage;
  records: number;
}

export interface AdminInsuranceRecordPage {
  records: AdminInsuranceRecord[];
  total: number;
}

interface StatusChange {
  from: PaymentStatus;
  conflict: string;
  patch: InsuranceRecordPatch;
  action: AuditAction;
  actor: AuditActor;
  metadata: Record<string, unknown>;
}

export interface MarkPaidInput {
  paidOn?: string;
  note?: string | null;
}

@Injectable()
export class AdminInsuranceService {
  constructor(
    private readonly repo: LessonInsuranceRepository,
    private readonly seasons: SeasonsService,
    private readonly audit: AuditService,
  ) {}

  async summary(seasonKey?: string): Promise<InstructorInsuranceSummary[]> {
    const season = await this.seasonFor(seasonKey);
    if (!season) {
      return [];
    }
    const byInstructor = new Map<string, AdminInsuranceRecordRow[]>();
    for (const row of await this.repo.seasonRecords(season.key)) {
      byInstructor.set(row.instructor_id, [
        ...(byInstructor.get(row.instructor_id) ?? []),
        row,
      ]);
    }
    return [...byInstructor.entries()]
      .map(([instructorId, rows]) => ({
        instructorId,
        name: rows[0].instructor?.display_name_en ?? null,
        nameZh: rows[0].instructor?.display_name_zh ?? null,
        email: rows[0].instructor?.email ?? null,
        ...totalsOf(rows),
        records: rows.length,
      }))
      .sort(
        (a, b) =>
          (a.name ?? '').localeCompare(b.name ?? '') ||
          (a.email ?? '').localeCompare(b.email ?? '') ||
          a.instructorId.localeCompare(b.instructorId),
      );
  }

  async records(
    query: AdminInsuranceRecordsQueryDto,
  ): Promise<AdminInsuranceRecordPage> {
    const season = await this.seasonFor(query.season);
    if (!season) {
      return { records: [], total: 0 };
    }
    const limit = query.limit ?? INSURANCE_LIST_DEFAULT_LIMIT;
    const { rows, total } = await this.repo.listRecords(
      {
        seasonKey: season.key,
        instructorId: query.instructorId,
        paymentStatus: query.paymentStatus,
      },
      { limit, offset: pageOffset(query.page ?? 1, limit) },
    );
    return { records: rows.map(toAdminRecord), total };
  }

  async markPaid(
    id: string,
    input: MarkPaidInput,
    actor: AuditActor,
  ): Promise<AdminInsuranceRecord> {
    const paidOn = input.paidOn ?? this.seasons.today();
    const note = input.note ? input.note : null;
    return this.transition(await this.findOrThrow(id), {
      from: 'unpaid',
      conflict: MARK_PAID_NEEDS_UNPAID,
      patch: {
        payment_status: 'paid',
        paid_on: paidOn,
        paid_note: note,
        paid_by: actor.userId ?? null,
      },
      action: AUDIT_ACTIONS.lessonInsuranceMarkPaid,
      actor,
      metadata: { paidOn, note },
    });
  }

  async markUnpaid(
    id: string,
    actor: AuditActor,
  ): Promise<AdminInsuranceRecord> {
    return this.transition(await this.findOrThrow(id), {
      from: 'paid',
      conflict: MARK_UNPAID_NEEDS_PAID,
      patch: {
        payment_status: 'unpaid',
        paid_on: null,
        paid_note: null,
        paid_by: null,
      },
      action: AUDIT_ACTIONS.lessonInsuranceMarkUnpaid,
      actor,
      metadata: {},
    });
  }

  async void(
    id: string,
    reason: string,
    actor: AuditActor,
    now = new Date(),
  ): Promise<AdminInsuranceRecord> {
    const current = await this.findOrThrow(id);
    if (current.payment_status === 'voided') {
      throw new ConflictException(ALREADY_VOIDED);
    }
    const from = current.payment_status;
    return this.transition(current, {
      from,
      conflict: RECORD_CHANGED,
      patch: {
        payment_status: 'voided',
        voided_at: now.toISOString(),
        voided_reason: reason,
        voided_by: actor.userId ?? null,
        voided_from_status: from,
      },
      action: AUDIT_ACTIONS.lessonInsuranceVoid,
      actor,
      metadata: { reason },
    });
  }

  private async transition(
    before: AdminInsuranceRecordRow,
    change: StatusChange,
  ): Promise<AdminInsuranceRecord> {
    if (before.payment_status !== change.from) {
      throw new ConflictException(change.conflict);
    }
    const row = await this.repo.updateIfStatus(
      before.id,
      change.from,
      change.patch,
    );
    if (!row) {
      throw new ConflictException(change.conflict);
    }
    await this.audit.record({
      action: change.action,
      actor: { ...change.actor, role: change.actor.role ?? 'admin' },
      targetType: 'lesson_insurance_record',
      targetId: row.id,
      metadata: {
        recordNo: row.record_no,
        instructorId: row.instructor_id,
        seasonKey: row.season_key,
        amountCents: row.amount_cents,
        from: change.from,
        to: row.payment_status,
        ...change.metadata,
      },
    });
    return toAdminRecord(row);
  }

  private async findOrThrow(id: string): Promise<AdminInsuranceRecordRow> {
    const row = await this.repo.findRecord(id);
    if (!row) {
      throw new NotFoundException(RECORD_NOT_FOUND);
    }
    return row;
  }

  private async seasonFor(seasonKey?: string): Promise<SeasonRow | null> {
    return seasonKey
      ? this.seasons.assertKnown(seasonKey)
      : this.seasons.current();
  }
}
