import { torontoToday } from '../documents/certification-validity';
import type {
  AdminInsuranceRecordRow,
  AdminInsuranceRequestRow,
  InsuranceCoverage,
  InsuranceKind,
  InsuranceRecordRow,
  InsuranceRequestRow,
  InsuranceStudent,
  PaymentStatus,
} from './lesson-insurance.repository';

export const CAP_CENTS = 40000;

export type SeasonCoverage = 'none' | 'capped' | 'season_pass';

export interface InsuranceRecord {
  id: string;
  recordNo: string;
  kind: InsuranceKind;
  seasonKey: string;
  lessonDate: string | null;
  durationHours: number | null;
  locationId: string | null;
  locationName: string | null;
  locationOther: string | null;
  students: InsuranceStudent[];
  studentCount: number | null;
  listCents: number;
  amountCents: number;
  coverage: InsuranceCoverage | null;
  paymentStatus: PaymentStatus;
  paidOn: string | null;
  createdAt: string;
}

export interface AdminInsuranceRecord extends InsuranceRecord {
  requestId: string | null;
  requestNo: string | null;
  instructorId: string;
  instructorName: string | null;
  instructorNameZh: string | null;
  instructorEmail: string | null;
  paidNote: string | null;
  paidBy: string | null;
  voidedAt: string | null;
  voidedReason: string | null;
  voidedBy: string | null;
  voidedFromStatus: Exclude<PaymentStatus, 'voided'> | null;
  createdBy: string | null;
  updatedAt: string;
}

export interface InsuranceRequest {
  id: string;
  requestNo: string;
  seasonKey: string;
  paymentStatus: PaymentStatus;
  totalCents: number;
  lessonCount: number;
  studentCount: number;
  createdAt: string;
  paidOn: string | null;
  lessons: InsuranceRecord[];
}

export interface AdminInsuranceRequest extends Omit<
  InsuranceRequest,
  'lessons'
> {
  instructorId: string;
  instructorName: string | null;
  instructorNameZh: string | null;
  instructorEmail: string | null;
  paidNote: string | null;
  paidBy: string | null;
  voidedAt: string | null;
  voidedReason: string | null;
  voidedBy: string | null;
  voidedFromStatus: Exclude<PaymentStatus, 'voided'> | null;
  createdBy: string | null;
  updatedAt: string;
  lessons: AdminInsuranceRecord[];
}

export interface InsuranceTotals {
  owedCents: number;
  paidCents: number;
  unpaidCents: number;
  coverage: SeasonCoverage;
}

export function toRecord(row: InsuranceRecordRow): InsuranceRecord {
  return {
    id: row.id,
    recordNo: row.record_no,
    kind: row.kind,
    seasonKey: row.season_key,
    lessonDate: row.lesson_date,
    durationHours: row.duration_hours,
    locationId: row.location_id,
    locationName: row.location?.name ?? null,
    locationOther: row.location_other,
    students: (row.students ?? []).map((s) => ({
      name: s.name,
      waiverConfirmed: s.waiverConfirmed,
    })),
    studentCount: row.student_count,
    listCents: row.list_cents,
    amountCents: row.amount_cents,
    coverage: row.coverage,
    paymentStatus: row.payment_status,
    paidOn: row.paid_on,
    createdAt: row.created_at,
  };
}

export function toAdminRecord(
  row: AdminInsuranceRecordRow,
): AdminInsuranceRecord {
  return {
    ...toRecord(row),
    requestId: row.request_id,
    requestNo: row.request?.request_no ?? null,
    instructorId: row.instructor_id,
    instructorName: row.instructor?.display_name_en ?? null,
    instructorNameZh: row.instructor?.display_name_zh ?? null,
    instructorEmail: row.instructor?.email ?? null,
    paidNote: row.paid_note,
    paidBy: row.paid_by,
    voidedAt: row.voided_at,
    voidedReason: row.voided_reason,
    voidedBy: row.voided_by,
    voidedFromStatus: row.voided_from_status,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
  };
}

export function totalsOf(rows: readonly InsuranceRecordRow[]): InsuranceTotals {
  const sum = (keep: (row: InsuranceRecordRow) => boolean) =>
    rows.filter(keep).reduce((total, row) => total + row.amount_cents, 0);
  const owedCents = sum((row) => row.payment_status !== 'voided');
  const hasPass = rows.some(
    (row) => row.kind === 'season_pass' && row.payment_status !== 'voided',
  );
  return {
    owedCents,
    paidCents: sum((row) => row.payment_status === 'paid'),
    unpaidCents: sum((row) => row.payment_status === 'unpaid'),
    coverage:
      owedCents < CAP_CENTS ? 'none' : hasPass ? 'season_pass' : 'capped',
  };
}

function sortDate(row: InsuranceRecordRow): string {
  return row.lesson_date ?? torontoToday(new Date(row.created_at));
}

export function byLessonDateDesc(
  a: InsuranceRecordRow,
  b: InsuranceRecordRow,
): number {
  return (
    sortDate(b).localeCompare(sortDate(a)) ||
    Date.parse(b.created_at) - Date.parse(a.created_at) ||
    b.record_no.localeCompare(a.record_no)
  );
}

function inEnteredOrder(
  lessons: readonly InsuranceRecordRow[],
): InsuranceRecordRow[] {
  return [...lessons].sort((a, b) => a.record_no.localeCompare(b.record_no));
}

export function toRequest(row: InsuranceRequestRow): InsuranceRequest {
  const lessons = inEnteredOrder(row.lessons);
  return {
    id: row.id,
    requestNo: row.request_no,
    seasonKey: row.season_key,
    paymentStatus: row.payment_status,
    totalCents: row.total_cents,
    lessonCount: row.lesson_count,
    studentCount: lessons.reduce(
      (total, lesson) => total + (lesson.student_count ?? 0),
      0,
    ),
    createdAt: row.created_at,
    paidOn: row.paid_on,
    lessons: lessons.map(toRecord),
  };
}

export function toAdminRequest(
  row: AdminInsuranceRequestRow,
): AdminInsuranceRequest {
  return {
    ...toRequest(row),
    instructorId: row.instructor_id,
    instructorName: row.instructor?.display_name_en ?? null,
    instructorNameZh: row.instructor?.display_name_zh ?? null,
    instructorEmail: row.instructor?.email ?? null,
    paidNote: row.paid_note,
    paidBy: row.paid_by,
    voidedAt: row.voided_at,
    voidedReason: row.voided_reason,
    voidedBy: row.voided_by,
    voidedFromStatus: row.voided_from_status,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    lessons: inEnteredOrder(row.lessons).map((lesson) =>
      toAdminRecord({
        ...lesson,
        instructor: row.instructor,
        request: { request_no: row.request_no },
      }),
    ),
  };
}

export function byCreatedDesc(
  a: InsuranceRequestRow,
  b: InsuranceRequestRow,
): number {
  return (
    Date.parse(b.created_at) - Date.parse(a.created_at) ||
    b.request_no.localeCompare(a.request_no)
  );
}
