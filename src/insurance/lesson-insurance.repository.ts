import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import {
  type CountedResult,
  type PageRequest,
  PGRST_RANGE_NOT_SATISFIABLE,
  type RowPage,
} from '../database/pagination';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

export const INSURANCE_RECORDS_TABLE = 'lesson_insurance_records';
export const INSURANCE_REQUESTS_TABLE = 'lesson_insurance_requests';
export const INSURANCE_PAGE_SIZE = 1000;
export const INSURANCE_RECORD_COLUMNS = [
  'id, instructor_id, request_id, season_key, kind, lesson_date, duration_hours, location_id, location_other, students, student_count, list_cents, amount_cents, coverage, payment_status, paid_on, paid_note, paid_by, voided_at, voided_reason, voided_by, voided_from_status, record_no, created_by, created_at, updated_at',
  'location:teaching_locations(name)',
].join(', ');
export const ADMIN_INSURANCE_RECORD_COLUMNS = [
  INSURANCE_RECORD_COLUMNS,
  'instructor:instructors(display_name_en, display_name_zh, email)',
  'request:lesson_insurance_requests!lesson_insurance_records_request_id_fkey(request_no)',
].join(', ');
export const INSURANCE_REQUEST_COLUMNS = [
  'id, instructor_id, season_key, request_no, payment_status, total_cents, lesson_count, paid_on, paid_note, paid_by, voided_at, voided_reason, voided_by, voided_from_status, created_by, created_at, updated_at',
  `lessons:lesson_insurance_records!lesson_insurance_records_request_id_fkey(${INSURANCE_RECORD_COLUMNS})`,
].join(', ');
export const ADMIN_INSURANCE_REQUEST_COLUMNS = [
  INSURANCE_REQUEST_COLUMNS,
  'instructor:instructors!lesson_insurance_requests_instructor_id_fkey(display_name_en, display_name_zh, email)',
].join(', ');
export const INSURANCE_INSTRUCTOR_COLUMNS = 'id, approval_status, is_active';
export const INSURANCE_SUMMARY_INSTRUCTOR_COLUMNS =
  'id, display_name_en, display_name_zh, email';

export type InsuranceKind = 'lesson' | 'season_pass';
export type InsuranceCoverage =
  | 'per_lesson'
  | 'cap_top_up'
  | 'capped'
  | 'season_pass';
export type PaymentStatus = 'unpaid' | 'paid' | 'not_required' | 'voided';
export type InstructorApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface InsuranceStudent {
  name: string;
  waiverConfirmed: boolean;
}

export interface InsuranceRecordRow {
  id: string;
  instructor_id: string;
  request_id: string | null;
  season_key: string;
  kind: InsuranceKind;
  lesson_date: string | null;
  duration_hours: number | null;
  location_id: string | null;
  location_other: string | null;
  students: InsuranceStudent[] | null;
  student_count: number | null;
  list_cents: number;
  amount_cents: number;
  coverage: InsuranceCoverage | null;
  payment_status: PaymentStatus;
  paid_on: string | null;
  paid_note: string | null;
  paid_by: string | null;
  voided_at: string | null;
  voided_reason: string | null;
  voided_by: string | null;
  voided_from_status: Exclude<PaymentStatus, 'voided'> | null;
  record_no: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  location: { name: string } | null;
}

export interface InsuranceRowInstructor {
  display_name_en: string;
  display_name_zh: string | null;
  email: string;
}

export interface AdminInsuranceRecordRow extends InsuranceRecordRow {
  instructor: InsuranceRowInstructor | null;
  request?: { request_no: string } | null;
}

export interface InsuranceRequestRow {
  id: string;
  instructor_id: string;
  season_key: string;
  request_no: string;
  payment_status: PaymentStatus;
  total_cents: number;
  lesson_count: number;
  paid_on: string | null;
  paid_note: string | null;
  paid_by: string | null;
  voided_at: string | null;
  voided_reason: string | null;
  voided_by: string | null;
  voided_from_status: Exclude<PaymentStatus, 'voided'> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  lessons: InsuranceRecordRow[];
}

export interface AdminInsuranceRequestRow extends InsuranceRequestRow {
  instructor: InsuranceRowInstructor | null;
}

export interface InsuranceInstructorRow {
  id: string;
  approval_status: InstructorApprovalStatus;
  is_active: boolean;
}

export interface InsuranceSummaryInstructorRow {
  id: string;
  display_name_en: string;
  display_name_zh: string | null;
  email: string;
}

export interface RegisterInput {
  instructorId: string;
  kind: InsuranceKind;
  seasonKey: string | null;
  lessonDate: string | null;
  durationHours: number | null;
  locationId: string | null;
  locationOther: string | null;
  students: InsuranceStudent[] | null;
  idempotencyKey: string;
  actor: string | null;
}

export interface RequestLessonInput {
  lessonDate: string;
  durationHours: number;
  locationId: string | null;
  locationOther: string | null;
  students: InsuranceStudent[];
}

export interface SubmitRequestInput {
  instructorId: string;
  seasonKey: string | null;
  lessons: RequestLessonInput[];
  idempotencyKey: string;
  actor: string | null;
}

export type SubmitRequestOutcome =
  | { outcome: 'created' | 'existing'; id: string }
  | { outcome: 'no_season'; lesson_index?: number }
  | { outcome: 'mixed_seasons'; lesson_index: number; season_key: string }
  | { outcome: 'too_many_lessons'; lesson_count: number };

export type RequestAction = 'mark_paid' | 'mark_unpaid' | 'void';

export interface RequestTransitionInput {
  requestId: string;
  action: RequestAction;
  actor: string | null;
  paidOn: string | null;
  note: string | null;
  reason: string | null;
}

export type RequestTransitionOutcome =
  | {
      outcome: 'updated';
      from: PaymentStatus;
      to: PaymentStatus;
      request: AdminInsuranceRequestRow;
    }
  | { outcome: 'conflict'; from: PaymentStatus }
  | { outcome: 'not_found' };

export interface GrantSeasonPassInput {
  instructorId: string;
  seasonKey: string;
  actor: string | null;
  idempotencyKey: string;
  paidOn: string | null;
  paidNote: string | null;
}

export type RegisterOutcome =
  | { outcome: 'created' | 'existing'; id: string }
  | { outcome: 'no_season' }
  | {
      outcome: 'already_covered' | 'already_has_pass';
      season_key: string;
      owed_cents: number;
    };

export interface InsuranceRecordFilter {
  seasonKey: string;
  instructorId?: string;
  paymentStatus?: PaymentStatus;
}

export type InsuranceRecordPatch = Partial<
  Pick<
    InsuranceRecordRow,
    | 'payment_status'
    | 'paid_on'
    | 'paid_note'
    | 'paid_by'
    | 'voided_at'
    | 'voided_reason'
    | 'voided_by'
    | 'voided_from_status'
  >
>;

export abstract class LessonInsuranceRepository {
  abstract instructorByAuthUser(
    authUserId: string,
  ): Promise<InsuranceInstructorRow | null>;
  abstract instructorById(id: string): Promise<InsuranceInstructorRow | null>;
  abstract approvedInstructors(): Promise<InsuranceSummaryInstructorRow[]>;
  abstract register(input: RegisterInput): Promise<RegisterOutcome>;
  abstract grantSeasonPass(
    input: GrantSeasonPassInput,
  ): Promise<RegisterOutcome>;
  abstract findRecord(id: string): Promise<AdminInsuranceRecordRow | null>;
  abstract recordsFor(
    instructorId: string,
    seasonKey: string,
  ): Promise<InsuranceRecordRow[]>;
  abstract seasonRecords(seasonKey: string): Promise<AdminInsuranceRecordRow[]>;
  abstract listRecords(
    filter: InsuranceRecordFilter,
    page: PageRequest,
  ): Promise<RowPage<AdminInsuranceRecordRow>>;
  abstract updateIfStatus(
    id: string,
    from: PaymentStatus,
    patch: InsuranceRecordPatch,
  ): Promise<AdminInsuranceRecordRow | null>;
  abstract submitRequest(
    input: SubmitRequestInput,
  ): Promise<SubmitRequestOutcome>;
  abstract findRequest(id: string): Promise<AdminInsuranceRequestRow | null>;
  abstract requestsFor(
    instructorId: string,
    seasonKey: string,
  ): Promise<InsuranceRequestRow[]>;
  abstract listRequests(
    filter: InsuranceRecordFilter,
    page: PageRequest,
  ): Promise<RowPage<AdminInsuranceRequestRow>>;
  abstract transitionRequest(
    input: RequestTransitionInput,
  ): Promise<RequestTransitionOutcome>;
}

@Injectable()
export class SupabaseLessonInsuranceRepository extends LessonInsuranceRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async instructorByAuthUser(
    authUserId: string,
  ): Promise<InsuranceInstructorRow | null> {
    const { data, error } = (await this.supabase
      .from('instructors')
      .select(INSURANCE_INSTRUCTOR_COLUMNS)
      .eq('auth_user_id', authUserId)
      .maybeSingle()) as DbResult<InsuranceInstructorRow>;
    check(error, 'load instructor');
    return data;
  }

  async instructorById(id: string): Promise<InsuranceInstructorRow | null> {
    const { data, error } = (await this.supabase
      .from('instructors')
      .select(INSURANCE_INSTRUCTOR_COLUMNS)
      .eq('id', id)
      .maybeSingle()) as DbResult<InsuranceInstructorRow>;
    check(error, 'load instructor');
    return data;
  }

  approvedInstructors(): Promise<InsuranceSummaryInstructorRow[]> {
    return this.pages<InsuranceSummaryInstructorRow>(
      (from, to) =>
        this.supabase
          .from('instructors')
          .select(INSURANCE_SUMMARY_INSTRUCTOR_COLUMNS)
          .eq('approval_status', 'approved')
          .order('id', { ascending: true })
          .range(from, to),
      'list approved instructors',
    );
  }

  async register(input: RegisterInput): Promise<RegisterOutcome> {
    const { data, error } = (await this.supabase.rpc(
      'lesson_insurance_register',
      {
        p_instructor_id: input.instructorId,
        p_kind: input.kind,
        p_season_key: input.seasonKey,
        p_lesson_date: input.lessonDate,
        p_duration_hours: input.durationHours,
        p_location_id: input.locationId,
        p_location_other: input.locationOther,
        p_students: input.students,
        p_top_up: false,
        p_idempotency_key: input.idempotencyKey,
        p_actor: input.actor,
      },
    )) as DbResult<RegisterOutcome>;
    check(error, 'register lesson insurance');
    if (!data) {
      throw new Error('Failed to register lesson insurance: no result');
    }
    return data;
  }

  async grantSeasonPass(input: GrantSeasonPassInput): Promise<RegisterOutcome> {
    const { data, error } = (await this.supabase.rpc(
      'lesson_insurance_admin_grant_pass',
      {
        p_instructor_id: input.instructorId,
        p_season_key: input.seasonKey,
        p_actor: input.actor,
        p_idempotency_key: input.idempotencyKey,
        p_paid_on: input.paidOn,
        p_paid_note: input.paidNote,
      },
    )) as DbResult<RegisterOutcome>;
    check(error, 'grant season pass');
    if (!data) {
      throw new Error('Failed to grant season pass: no result');
    }
    return data;
  }

  async findRecord(id: string): Promise<AdminInsuranceRecordRow | null> {
    const { data, error } = (await this.supabase
      .from(INSURANCE_RECORDS_TABLE)
      .select(ADMIN_INSURANCE_RECORD_COLUMNS)
      .eq('id', id)
      .maybeSingle()) as DbResult<AdminInsuranceRecordRow>;
    check(error, 'load insurance record');
    return data;
  }

  recordsFor(
    instructorId: string,
    seasonKey: string,
  ): Promise<InsuranceRecordRow[]> {
    return this.all<InsuranceRecordRow>(
      INSURANCE_RECORD_COLUMNS,
      { seasonKey, instructorId },
      'list insurance records',
    );
  }

  seasonRecords(seasonKey: string): Promise<AdminInsuranceRecordRow[]> {
    return this.all<AdminInsuranceRecordRow>(
      ADMIN_INSURANCE_RECORD_COLUMNS,
      { seasonKey },
      'list season insurance records',
    );
  }

  listRecords(
    filter: InsuranceRecordFilter,
    page: PageRequest,
  ): Promise<RowPage<AdminInsuranceRecordRow>> {
    return this.page<AdminInsuranceRecordRow>(
      INSURANCE_RECORDS_TABLE,
      ADMIN_INSURANCE_RECORD_COLUMNS,
      filter,
      page,
      'insurance records',
    );
  }

  async updateIfStatus(
    id: string,
    from: PaymentStatus,
    patch: InsuranceRecordPatch,
  ): Promise<AdminInsuranceRecordRow | null> {
    const { data, error } = (await this.supabase
      .from(INSURANCE_RECORDS_TABLE)
      .update(patch)
      .eq('id', id)
      .eq('payment_status', from)
      .select(ADMIN_INSURANCE_RECORD_COLUMNS)
      .maybeSingle()) as DbResult<AdminInsuranceRecordRow>;
    check(error, 'update insurance record');
    return data;
  }

  async submitRequest(
    input: SubmitRequestInput,
  ): Promise<SubmitRequestOutcome> {
    const { data, error } = (await this.supabase.rpc(
      'lesson_insurance_submit_request',
      {
        p_instructor_id: input.instructorId,
        p_season_key: input.seasonKey,
        p_lessons: input.lessons,
        p_idempotency_key: input.idempotencyKey,
        p_actor: input.actor,
      },
    )) as DbResult<SubmitRequestOutcome>;
    check(error, 'submit insurance request');
    if (!data) {
      throw new Error('Failed to submit insurance request: no result');
    }
    return data;
  }

  async findRequest(id: string): Promise<AdminInsuranceRequestRow | null> {
    const { data, error } = (await this.supabase
      .from(INSURANCE_REQUESTS_TABLE)
      .select(ADMIN_INSURANCE_REQUEST_COLUMNS)
      .eq('id', id)
      .maybeSingle()) as DbResult<AdminInsuranceRequestRow>;
    check(error, 'load insurance request');
    return data;
  }

  requestsFor(
    instructorId: string,
    seasonKey: string,
  ): Promise<InsuranceRequestRow[]> {
    return this.pages<InsuranceRequestRow>(
      (from, to) =>
        this.matching(INSURANCE_REQUESTS_TABLE, INSURANCE_REQUEST_COLUMNS, {
          seasonKey,
          instructorId,
        })
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to),
      'list insurance requests',
    );
  }

  listRequests(
    filter: InsuranceRecordFilter,
    page: PageRequest,
  ): Promise<RowPage<AdminInsuranceRequestRow>> {
    return this.page<AdminInsuranceRequestRow>(
      INSURANCE_REQUESTS_TABLE,
      ADMIN_INSURANCE_REQUEST_COLUMNS,
      filter,
      page,
      'insurance requests',
    );
  }

  async transitionRequest(
    input: RequestTransitionInput,
  ): Promise<RequestTransitionOutcome> {
    const { data, error } = (await this.supabase.rpc(
      'lesson_insurance_request_transition',
      {
        p_request_id: input.requestId,
        p_action: input.action,
        p_actor: input.actor,
        p_paid_on: input.paidOn,
        p_note: input.note,
        p_reason: input.reason,
      },
    )) as DbResult<RequestTransitionOutcome>;
    check(error, 'update insurance request');
    if (!data) {
      throw new Error('Failed to update insurance request: no result');
    }
    return data;
  }

  private async page<T>(
    table: string,
    columns: string,
    filter: InsuranceRecordFilter,
    { limit, offset }: PageRequest,
    noun: string,
  ): Promise<RowPage<T>> {
    const { data, error, count } = (await this.matching(
      table,
      columns,
      filter,
      {
        count: 'exact',
      },
    )
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1)) as CountedResult<T[]>;
    if (error?.code === PGRST_RANGE_NOT_SATISFIABLE) {
      const counted = (await this.matching(table, 'id', filter, {
        count: 'exact',
        head: true,
      })) as CountedResult<unknown>;
      check(counted.error, `count ${noun}`);
      return { rows: [], total: counted.count ?? 0 };
    }
    check(error, `list ${noun}`);
    return { rows: data ?? [], total: count ?? 0 };
  }

  private matching(
    table: string,
    columns: string,
    filter: InsuranceRecordFilter,
    options?: { count: 'exact'; head?: boolean },
  ) {
    let query = this.supabase
      .from(table)
      .select(columns, options)
      .eq('season_key', filter.seasonKey);
    if (filter.instructorId) {
      query = query.eq('instructor_id', filter.instructorId);
    }
    if (filter.paymentStatus) {
      query = query.eq('payment_status', filter.paymentStatus);
    }
    return query;
  }

  private all<T>(
    columns: string,
    filter: InsuranceRecordFilter,
    action: string,
  ): Promise<T[]> {
    return this.pages<T>(
      (from, to) =>
        this.matching(INSURANCE_RECORDS_TABLE, columns, filter)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      action,
    );
  }

  private async pages<T>(
    fetchPage: (from: number, to: number) => PromiseLike<unknown>,
    action: string,
  ): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; ; offset += INSURANCE_PAGE_SIZE) {
      const { data, error } = (await fetchPage(
        offset,
        offset + INSURANCE_PAGE_SIZE - 1,
      )) as DbResult<T[]>;
      check(error, action);
      const page = data ?? [];
      rows.push(...page);
      if (page.length < INSURANCE_PAGE_SIZE) {
        return rows;
      }
    }
  }
}
