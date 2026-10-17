import type {
  DocumentExport,
  DocumentExportRow,
  TemplateAssignmentDbRow,
  TemplateAssignmentRow,
} from './document-exports.types';

export function toTemplateAssignmentRow(
  row: TemplateAssignmentDbRow,
): TemplateAssignmentRow {
  return {
    id: row.id,
    status: row.status,
    season: row.season,
    instructor: {
      id: row.instructor_id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
    },
    signerName: row.signer_name,
    signerEmail: row.signer_email,
    assignedAt: row.assigned_at,
    viewedAt: row.viewed_at,
    completedAt: row.completed_at,
    signedSha256: row.signed_sha256,
    hasSignedCopy: row.signed_key !== null,
  };
}

export function toDocumentExport(row: DocumentExportRow): DocumentExport {
  return {
    id: row.id,
    templateId: row.template_id,
    season: row.season,
    selectedCount: row.assignment_ids?.length ?? null,
    status: row.status,
    fileCount: row.file_count,
    skippedCount: row.skipped_count,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    error: row.error,
    requestedAt: row.inserted_at,
    finishedAt: row.finished_at,
    expiresAt: row.expires_at,
  };
}
