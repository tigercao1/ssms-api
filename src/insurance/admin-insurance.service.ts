import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
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
  type GrantSeasonPassDto,
  INSURANCE_LIST_DEFAULT_LIMIT,
} from './dto/insurance.dto';
import {
  type AdminInsuranceRecord,
  type AdminInsuranceRequest,
  type SeasonCoverage,
  toAdminRecord,
  toAdminRequest,
  totalsOf,
} from './insurance.presenters';
import {
  type AdminInsuranceRecordRow,
  type InsuranceRecordPatch,
  LessonInsuranceRepository,
  type PaymentStatus,
  type RequestTransitionInput,
} from './lesson-insurance.repository';

export const RECORD_NOT_FOUND = 'Insurance record not found';
export const MARK_PAID_NEEDS_UNPAID =
  'Only an unpaid record can be marked paid';
export const MARK_UNPAID_NEEDS_PAID = 'Only a paid record can be marked unpaid';
export const ALREADY_VOIDED = 'This record is already voided';
export const RECORD_CHANGED = 'This record changed; reload and try again';
export const RECORD_IN_REQUEST =
  'This record belongs to a request; update the request instead';
export const REQUEST_NOT_FOUND = 'Insurance request not found';
export const REQUEST_MARK_PAID_NEEDS_UNPAID =
  'Only an unpaid request can be marked paid';
export const REQUEST_MARK_UNPAID_NEEDS_PAID =
  'Only a paid request can be marked unpaid';
export const REQUEST_ALREADY_VOIDED = 'This request is already voided';
export const INSTRUCTOR_NOT_FOUND = 'Instructor not found';
export const INSTRUCTOR_NOT_APPROVED =
  'Only an approved instructor can be granted a season pass';
export const NO_CURRENT_SEASON = 'No current season is set up';
export const ALREADY_COVERED = 'This season is already covered';
export const ALREADY_HAS_PASS = 'This instructor already has a season pass';

export interface InstructorInsuranceSummary {
  instructorId: string;
  name: string | null;
  nameZh: string | null;
  email: string | null;
  owedCents: number;
  paidCents: number;
  unpaidCents: number;
  coverage: SeasonCoverage;
  seasonPassRecordId: string | null;
  seasonPassPaymentStatus: 'unpaid' | 'paid' | null;
  records: number;
}

export interface AdminInsuranceRecordPage {
  records: AdminInsuranceRecord[];
  total: number;
}

export interface AdminInsuranceRequestPage {
  requests: AdminInsuranceRequest[];
  total: number;
}

interface RequestChange {
  input: Omit<RequestTransitionInput, 'requestId' | 'actor'>;
  conflict: string;
  action: AuditAction;
  metadata: Record<string, unknown>;
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

function passPaymentStatus(
  pass: AdminInsuranceRecordRow | undefined,
): 'unpaid' | 'paid' | null {
  return pass?.payment_status === 'paid' || pass?.payment_status === 'unpaid'
    ? pass.payment_status
    : null;
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
    const [records, approved] = await Promise.all([
      this.repo.seasonRecords(season.key),
      this.repo.approvedInstructors(),
    ]);
    const byInstructor = new Map<
      string,
      {
        instructor: AdminInsuranceRecordRow['instructor'];
        rows: AdminInsuranceRecordRow[];
      }
    >(approved.map(({ id, ...instructor }) => [id, { instructor, rows: [] }]));
    for (const row of records) {
      const entry = byInstructor.get(row.instructor_id) ?? {
        instructor: row.instructor,
        rows: [],
      };
      entry.rows.push(row);
      byInstructor.set(row.instructor_id, entry);
    }
    return [...byInstructor.entries()]
      .map(([instructorId, { instructor, rows }]) => {
        const pass = rows.find(
          (row) =>
            row.kind === 'season_pass' && row.payment_status !== 'voided',
        );
        return {
          instructorId,
          name: instructor?.display_name_en ?? null,
          nameZh: instructor?.display_name_zh ?? null,
          email: instructor?.email ?? null,
          ...totalsOf(rows),
          seasonPassRecordId: pass?.id ?? null,
          seasonPassPaymentStatus: passPaymentStatus(pass),
          records: rows.length,
        };
      })
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

  async requests(
    query: AdminInsuranceRecordsQueryDto,
  ): Promise<AdminInsuranceRequestPage> {
    const season = await this.seasonFor(query.season);
    if (!season) {
      return { requests: [], total: 0 };
    }
    const limit = query.limit ?? INSURANCE_LIST_DEFAULT_LIMIT;
    const { rows, total } = await this.repo.listRequests(
      {
        seasonKey: season.key,
        instructorId: query.instructorId,
        paymentStatus: query.paymentStatus,
      },
      { limit, offset: pageOffset(query.page ?? 1, limit) },
    );
    return { requests: rows.map(toAdminRequest), total };
  }

  markRequestPaid(
    id: string,
    input: MarkPaidInput,
    actor: AuditActor,
  ): Promise<AdminInsuranceRequest> {
    const paidOn = input.paidOn ?? this.seasons.today();
    const note = input.note ? input.note : null;
    return this.transitionRequest(id, actor, {
      input: { action: 'mark_paid', paidOn, note, reason: null },
      conflict: REQUEST_MARK_PAID_NEEDS_UNPAID,
      action: AUDIT_ACTIONS.lessonInsuranceRequestMarkPaid,
      metadata: { paidOn, note },
    });
  }

  markRequestUnpaid(
    id: string,
    actor: AuditActor,
  ): Promise<AdminInsuranceRequest> {
    return this.transitionRequest(id, actor, {
      input: { action: 'mark_unpaid', paidOn: null, note: null, reason: null },
      conflict: REQUEST_MARK_UNPAID_NEEDS_PAID,
      action: AUDIT_ACTIONS.lessonInsuranceRequestMarkUnpaid,
      metadata: {},
    });
  }

  voidRequest(
    id: string,
    reason: string,
    actor: AuditActor,
  ): Promise<AdminInsuranceRequest> {
    return this.transitionRequest(id, actor, {
      input: { action: 'void', paidOn: null, note: null, reason },
      conflict: REQUEST_ALREADY_VOIDED,
      action: AUDIT_ACTIONS.lessonInsuranceRequestVoid,
      metadata: { reason },
    });
  }

  async grantSeasonPass(
    instructorId: string,
    dto: GrantSeasonPassDto,
    actor: AuditActor,
  ): Promise<AdminInsuranceRecord> {
    const instructor = await this.repo.instructorById(instructorId);
    if (!instructor) {
      throw new NotFoundException(INSTRUCTOR_NOT_FOUND);
    }
    if (instructor.approval_status !== 'approved') {
      throw new ConflictException({
        statusCode: 409,
        code: 'not_approved',
        message: INSTRUCTOR_NOT_APPROVED,
      });
    }
    const season = await this.seasonFor(dto.season);
    if (!season) {
      throw new BadRequestException(NO_CURRENT_SEASON);
    }
    const note = dto.note ? dto.note : null;
    const paidOn = dto.paidOn ?? null;
    const outcome = await this.repo.grantSeasonPass({
      instructorId,
      seasonKey: season.key,
      actor: actor.userId ?? null,
      idempotencyKey: randomUUID(),
      paidOn,
      paidNote: paidOn ? note : null,
    });
    if (
      outcome.outcome === 'already_covered' ||
      outcome.outcome === 'already_has_pass'
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: outcome.outcome,
        message:
          outcome.outcome === 'already_covered'
            ? ALREADY_COVERED
            : ALREADY_HAS_PASS,
        owedCents: outcome.owed_cents,
      });
    }
    if (outcome.outcome !== 'created') {
      throw new Error(`Unexpected season pass outcome ${outcome.outcome}`);
    }
    const created = await this.findOrThrow(outcome.id);
    await this.audit.record({
      action: AUDIT_ACTIONS.lessonInsuranceGrantSeasonPass,
      actor: { ...actor, role: actor.role ?? 'admin' },
      targetType: 'lesson_insurance_record',
      targetId: created.id,
      metadata: {
        recordNo: created.record_no,
        instructorId,
        seasonKey: created.season_key,
        amountCents: created.amount_cents,
        note,
        paidOn,
        paymentStatus: created.payment_status,
      },
    });
    return toAdminRecord(created);
  }

  async markPaid(
    id: string,
    input: MarkPaidInput,
    actor: AuditActor,
  ): Promise<AdminInsuranceRecord> {
    const paidOn = input.paidOn ?? this.seasons.today();
    const note = input.note ? input.note : null;
    return this.transition(await this.standaloneOrThrow(id), {
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
    return this.transition(await this.standaloneOrThrow(id), {
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
    const current = await this.standaloneOrThrow(id);
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

  private async transitionRequest(
    id: string,
    actor: AuditActor,
    change: RequestChange,
  ): Promise<AdminInsuranceRequest> {
    const outcome = await this.repo.transitionRequest({
      requestId: id,
      actor: actor.userId ?? null,
      ...change.input,
    });
    if (outcome.outcome === 'not_found') {
      throw new NotFoundException(REQUEST_NOT_FOUND);
    }
    if (outcome.outcome === 'conflict') {
      throw new ConflictException(change.conflict);
    }
    const row = await this.repo.findRequest(id);
    if (!row) {
      throw new NotFoundException(REQUEST_NOT_FOUND);
    }
    await this.audit.record({
      action: change.action,
      actor: { ...actor, role: actor.role ?? 'admin' },
      targetType: 'lesson_insurance_request',
      targetId: row.id,
      metadata: {
        requestNo: row.request_no,
        instructorId: row.instructor_id,
        seasonKey: row.season_key,
        totalCents: row.total_cents,
        recordIds: row.lessons.map((lesson) => lesson.id),
        from: outcome.from,
        to: row.payment_status,
        ...change.metadata,
      },
    });
    return toAdminRequest(row);
  }

  private async standaloneOrThrow(
    id: string,
  ): Promise<AdminInsuranceRecordRow> {
    const row = await this.findOrThrow(id);
    if (row.request_id !== null) {
      throw new ConflictException({
        statusCode: 409,
        code: 'part_of_request',
        message: RECORD_IN_REQUEST,
        requestId: row.request_id,
      });
    }
    return row;
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
