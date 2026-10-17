/** Types for the signed-copies index and bulk ZIP exports of one template. */

export const DOCUMENT_EXPORT_STATUSES = [
  'queued',
  'running',
  'ready',
  'failed',
  'expired',
] as const;
export type DocumentExportStatus = (typeof DOCUMENT_EXPORT_STATUSES)[number];

export const TEMPLATE_ASSIGNMENT_FILTERS = [
  'all',
  'completed',
  'open',
] as const;
export type TemplateAssignmentFilter =
  (typeof TEMPLATE_ASSIGNMENT_FILTERS)[number];

/** One `document_exports` row. */
export interface DocumentExportRow {
  id: string;
  template_id: string;
  season: string | null;
  assignment_ids: string[] | null;
  status: DocumentExportStatus;
  file_count: number | null;
  skipped_count: number | null;
  size_bytes: number | null;
  zip_key: string | null;
  error: string | null;
  requested_by: string;
  owner_id: string;
  heartbeat_at: string;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string | null;
  inserted_at: string;
  updated_at: string;
}

export type DocumentExportWrite = Partial<
  Omit<DocumentExportRow, 'id' | 'inserted_at' | 'updated_at'>
>;

export interface NewDocumentExportRow {
  template_id: string;
  season: string | null;
  assignment_ids: string[] | null;
  requested_by: string;
  owner_id: string;
  heartbeat_at: string;
}

/** One row of `document_template_assignments(...)`. */
export interface TemplateAssignmentDbRow {
  id: string;
  status: 'assigned' | 'viewed' | 'completed';
  season: string | null;
  instructor_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  signer_name: string | null;
  signer_email: string | null;
  assigned_at: string;
  viewed_at: string | null;
  completed_at: string | null;
  signed_sha256: string | null;
  signed_key: string | null;
  total_count: number;
}

/**
 * Filters for a template's assignments; `patterns` are ILIKE patterns that
 * must all match, and `signedOnly` keeps rows that have a signed copy.
 */
export interface TemplateAssignmentQuery {
  templateId: string;
  season: string | null;
  status: TemplateAssignmentFilter;
  patterns: string[];
  ids: string[] | null;
  signedOnly: boolean;
  limit: number;
  offset: number;
}

/** `GET /admin/documents/templates/:id/assignments` row. */
export interface TemplateAssignmentRow {
  id: string;
  status: 'assigned' | 'viewed' | 'completed';
  season: string | null;
  instructor: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
  };
  signerName: string | null;
  signerEmail: string | null;
  assignedAt: string;
  viewedAt: string | null;
  completedAt: string | null;
  signedSha256: string | null;
  hasSignedCopy: boolean;
}

/** A page of {@link TemplateAssignmentRow}s and the total across pages. */
export interface TemplateAssignmentPage {
  rows: TemplateAssignmentRow[];
  total: number;
}

/** A bulk export of a template's signed copies. */
export interface DocumentExport {
  id: string;
  templateId: string;
  season: string | null;
  selectedCount: number | null;
  status: DocumentExportStatus;
  fileCount: number | null;
  skippedCount: number | null;
  sizeBytes: number | null;
  error: string | null;
  requestedAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
}

/** `GET /admin/documents/exports/:exportId/url`. */
export interface DocumentExportUrl {
  url: string;
  expiresAt: string;
  sizeBytes: number | null;
}

/** Counts from one export retention pass. */
export interface DocumentExportRetentionResult {
  expired: number;
}
