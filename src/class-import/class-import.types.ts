export const BLOCKING_PROBLEMS = [
  'instructor_not_found',
  'instructor_ambiguous',
  'lesson_type_unmapped',
  'invalid_row',
  'duplicate_row',
] as const;

export const NOTICE_PROBLEMS = [
  'customer_not_found',
  'already_imported',
] as const;

export const IMPORT_PROBLEMS = [
  ...BLOCKING_PROBLEMS,
  ...NOTICE_PROBLEMS,
] as const;

export type ImportProblem = (typeof IMPORT_PROBLEMS)[number];

export const ROW_FILTERS = [...IMPORT_PROBLEMS, 'any', 'blocking'] as const;
export type RowFilter = (typeof ROW_FILTERS)[number];

export type ImportStatus = 'draft' | 'committed' | 'discarded';
export type RowStatus = 'scheduled' | 'completed' | 'cancelled';
export type ManualField = 'instructor' | 'lesson_type' | 'customer';

export interface ImportSummary {
  total: number;
  matched: number;
  willImport: number;
  needsInstructor: number;
  needsLessonType: number;
  customerNotFound: number;
  cancelled: number;
  invalid: number;
  duplicate: number;
  alreadyImported: number;
  imported: number;
}

export interface CommitCounts {
  total: number;
  ready: number;
  created: number;
  alreadyImported: number;
  participants: number;
  skipped: number;
}

export interface ClassImport {
  id: string;
  filename: string;
  status: ImportStatus;
  counts: Partial<ImportSummary> & { commit?: CommitCounts };
  uploadedBy: string | null;
  committedAt: string | null;
  createdAt: string;
}

export interface ClassImportRowView {
  rowNo: number;
  externalId: string;
  eventName: string | null;
  instructorName: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  startsAt: string | null;
  endsAt: string | null;
  statusToSet: RowStatus | null;
  instructorId: string | null;
  matchedInstructorName: string | null;
  lessonTypeId: string | null;
  customerId: string | null;
  matchedCustomerName: string | null;
  problems: ImportProblem[];
  manualFields: ManualField[];
  classId: string | null;
}

export interface EventNameSummary {
  eventName: string;
  rows: number;
  lessonTypeId: string | null;
}

export interface ClassImportDetail {
  import: ClassImport;
  summary: ImportSummary;
  eventNames: EventNameSummary[];
  rows: ClassImportRowView[];
}

export interface EventMapping {
  eventName: string;
  lessonTypeId: string;
}

export interface EventMapResult {
  mappings: EventMapping[];
  rematchedImports: number;
}

export interface CommitResult {
  import: ClassImport;
  counts: CommitCounts;
}
