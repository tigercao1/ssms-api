import { rowFields } from './class-import-csv';
import {
  BLOCKING_PROBLEMS,
  type ImportProblem,
  type ImportSummary,
  type ManualField,
  type RowStatus,
} from './class-import.types';

const MIN_NAME_KEY_LENGTH = 2;
const MIN_PHONE_DIGITS = 7;

export function nameKey(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export interface InstructorRef {
  id: string;
  displayNameEn: string;
  displayNameZh: string | null;
}

export interface CalendarRef {
  instructorId: string;
  summary: string | null;
}

export interface CustomerMatch {
  id: string;
  emailKey: string | null;
  phoneKey: string | null;
}

export interface MatchContext {
  instructors: InstructorRef[];
  calendars: CalendarRef[];
  eventMap: ReadonlyMap<string, string>;
  customers: CustomerMatch[];
  importedExternalIds: ReadonlySet<string>;
  now: Date;
}

export interface MatchInput {
  rowNo: number;
  externalId: string;
  raw: Record<string, unknown>;
  instructorId: string | null;
  lessonTypeId: string | null;
  customerId: string | null;
  manualFields: ManualField[];
  classId: string | null;
}

export interface MatchedRow extends MatchInput {
  eventName: string | null;
  instructorName: string | null;
  startsAt: string | null;
  endsAt: string | null;
  statusToSet: RowStatus | null;
  problems: ImportProblem[];
}

export function emailKey(value: string | null | undefined): string | null {
  const key = (value ?? '').trim().toLowerCase();
  return key.includes('@') ? key : null;
}

export function phoneKey(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  const key = /^1\d{10}$/.test(digits) ? digits.slice(1) : digits;
  return key.length >= MIN_PHONE_DIGITS ? key : null;
}

export type InstructorMatch =
  | { instructorId: string }
  | { problem: 'instructor_not_found' | 'instructor_ambiguous' };

function single(
  ids: string[],
): { instructorId: string } | { problem: 'instructor_ambiguous' } | null {
  const distinct = [...new Set(ids)];
  if (distinct.length === 1) {
    return { instructorId: distinct[0] };
  }
  return distinct.length > 1 ? { problem: 'instructor_ambiguous' } : null;
}

export function matchInstructor(
  name: string | null,
  ctx: Pick<MatchContext, 'instructors' | 'calendars'>,
): InstructorMatch {
  const key = nameKey(name);
  if (key.length < MIN_NAME_KEY_LENGTH) {
    return { problem: 'instructor_not_found' };
  }
  const byName = single(
    ctx.instructors
      .filter(
        (i) =>
          nameKey(i.displayNameEn) === key || nameKey(i.displayNameZh) === key,
      )
      .map((i) => i.id),
  );
  if (byName) {
    return byName;
  }
  const byCalendar = single(
    ctx.calendars
      .filter((c) => nameKey(c.summary) === key)
      .map((c) => c.instructorId),
  );
  return byCalendar ?? { problem: 'instructor_not_found' };
}

export function matchCustomer(
  email: string | null,
  phone: string | null,
  customers: CustomerMatch[],
): string | null {
  const byKey = (
    pick: (c: CustomerMatch) => string | null,
    key: string | null,
  ) => {
    if (!key) {
      return null;
    }
    const ids = [
      ...new Set(customers.filter((c) => pick(c) === key).map((c) => c.id)),
    ];
    return ids.length === 1 ? ids[0] : null;
  };
  return (
    byKey((c) => c.emailKey, emailKey(email)) ??
    byKey((c) => c.phoneKey, phoneKey(phone))
  );
}

export function duplicateRowNos(
  rows: Pick<MatchInput, 'rowNo' | 'externalId'>[],
): Set<number> {
  const seen = new Set<string>();
  const duplicates = new Set<number>();
  for (const row of [...rows].sort((a, b) => a.rowNo - b.rowNo)) {
    if (seen.has(row.externalId)) {
      duplicates.add(row.rowNo);
    }
    seen.add(row.externalId);
  }
  return duplicates;
}

function rowStatus(
  deleted: boolean,
  endsAt: string | null,
  now: Date,
): RowStatus | null {
  if (deleted) {
    return 'cancelled';
  }
  if (!endsAt) {
    return null;
  }
  return Date.parse(endsAt) <= now.getTime() ? 'completed' : 'scheduled';
}

export function matchRow(
  row: MatchInput,
  ctx: MatchContext,
  duplicate: boolean,
): MatchedRow {
  const fields = rowFields(row.raw);
  const manual = new Set(row.manualFields);
  const problems: ImportProblem[] = [];

  if (!fields.valid) {
    problems.push('invalid_row');
  }
  if (duplicate) {
    problems.push('duplicate_row');
  }

  let instructorId = row.instructorId;
  if (!manual.has('instructor')) {
    const match = matchInstructor(fields.instructorName, ctx);
    instructorId = 'instructorId' in match ? match.instructorId : null;
    if ('problem' in match) {
      problems.push(match.problem);
    }
  } else if (!instructorId) {
    problems.push('instructor_not_found');
  }

  let lessonTypeId = row.lessonTypeId;
  if (!manual.has('lesson_type')) {
    lessonTypeId = fields.eventName
      ? (ctx.eventMap.get(fields.eventName) ?? null)
      : null;
  }
  if (!lessonTypeId) {
    problems.push('lesson_type_unmapped');
  }

  let customerId = row.customerId;
  if (!manual.has('customer')) {
    customerId = matchCustomer(fields.email, fields.phone, ctx.customers);
    if (!customerId) {
      problems.push('customer_not_found');
    }
  }

  if (row.classId === null && ctx.importedExternalIds.has(row.externalId)) {
    problems.push('already_imported');
  }

  return {
    ...row,
    instructorId,
    lessonTypeId,
    customerId,
    eventName: fields.eventName,
    instructorName: fields.instructorName,
    startsAt: fields.startsAt,
    endsAt: fields.endsAt,
    statusToSet: fields.valid
      ? rowStatus(fields.deleted, fields.endsAt, ctx.now)
      : null,
    problems,
  };
}

export function matchRows(rows: MatchInput[], ctx: MatchContext): MatchedRow[] {
  const duplicates = duplicateRowNos(rows);
  return rows.map((row) => matchRow(row, ctx, duplicates.has(row.rowNo)));
}

const BLOCKING = new Set<ImportProblem>(BLOCKING_PROBLEMS);

export function isBlocked(problems: readonly ImportProblem[]): boolean {
  return problems.some((p) => BLOCKING.has(p));
}

export function summarize(
  rows: Pick<MatchedRow, 'problems' | 'statusToSet' | 'classId'>[],
): ImportSummary {
  const count = (predicate: (row: (typeof rows)[number]) => boolean) =>
    rows.filter(predicate).length;
  const has = (problem: ImportProblem) => (row: (typeof rows)[number]) =>
    row.problems.includes(problem);
  return {
    total: rows.length,
    matched: count((r) => !isBlocked(r.problems)),
    willImport: count(
      (r) =>
        !isBlocked(r.problems) &&
        !r.problems.includes('already_imported') &&
        r.classId === null,
    ),
    needsInstructor: count(
      (r) =>
        r.problems.includes('instructor_not_found') ||
        r.problems.includes('instructor_ambiguous'),
    ),
    needsLessonType: count(has('lesson_type_unmapped')),
    customerNotFound: count(has('customer_not_found')),
    cancelled: count((r) => r.statusToSet === 'cancelled'),
    invalid: count(has('invalid_row')),
    duplicate: count(has('duplicate_row')),
    alreadyImported: count(has('already_imported')),
    imported: count((r) => r.classId !== null),
  };
}
