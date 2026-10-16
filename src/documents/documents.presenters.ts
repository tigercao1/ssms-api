import { certificationState, currentUploads } from './certification-validity';
import type {
  Assignment,
  CertUpload,
  CertificationUploadRow,
  DocumentAssignmentRow,
  DocumentTemplateRow,
  SigningTemplate,
  Template,
  TemplateCounts,
  TemplateField,
  TemplateFieldRow,
  TemplateSummary,
} from './documents.types';

/** Stored field → API field. */
export function toTemplateField(row: TemplateFieldRow): TemplateField {
  return {
    id: row.id,
    type: row.type,
    page: row.page,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    required: row.required,
    labelEn: row.label_en,
    labelZh: row.label_zh ?? null,
    prefill: row.prefill ?? null,
  };
}

/** API field → stored field. */
export function toTemplateFieldRow(field: TemplateField): TemplateFieldRow {
  return {
    id: field.id,
    type: field.type,
    page: field.page,
    x: field.x,
    y: field.y,
    w: field.w,
    h: field.h,
    required: field.required,
    label_en: field.labelEn,
    label_zh: field.labelZh || null,
    prefill: field.prefill ?? null,
  };
}

export const NO_TEMPLATE_COUNTS: TemplateCounts = {
  hasCompletedAssignments: false,
  assignedCount: 0,
  completedCount: 0,
  approvedAssignedCount: 0,
  approvedCompletedCount: 0,
  approvedCount: 0,
};

export function toTemplateSummary(
  row: DocumentTemplateRow,
  counts: TemplateCounts,
): TemplateSummary {
  return {
    id: row.id,
    kind: row.kind,
    audience: row.audience,
    titleEn: row.title_en,
    titleZh: row.title_zh,
    descriptionEn: row.description_en,
    descriptionZh: row.description_zh,
    required: row.required,
    status: row.status,
    assignTo: row.assign_to,
    season: row.season,
    publishedAt: row.published_at,
    ...counts,
    sortOrder: row.sort_order,
    hasSource: row.source_key !== null,
    pageCount: row.page_count,
    fieldCount: row.fields.length,
    insertedAt: row.inserted_at,
    updatedAt: row.updated_at,
  };
}

export function toTemplate(
  row: DocumentTemplateRow,
  sourceUrl: string | null,
  counts: TemplateCounts,
): Template {
  return {
    ...toTemplateSummary(row, counts),
    sourceSha256: row.source_sha256,
    pages: row.pages,
    fields: row.fields.map(toTemplateField),
    sourceUrl,
    updatedBy: row.updated_by,
  };
}

export function toAssignment(row: DocumentAssignmentRow): Assignment {
  return {
    id: row.id,
    templateId: row.template_id,
    template: row.template
      ? {
          id: row.template.id,
          kind: row.template.kind,
          titleEn: row.template.title_en,
          titleZh: row.template.title_zh,
          required: row.template.required,
        }
      : null,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    season: row.season,
    classId: row.class_id,
    status: row.status,
    assignedAt: row.assigned_at,
    viewedAt: row.viewed_at,
    completedAt: row.completed_at,
    dueAt: row.due_at,
    reminderSentAt: row.reminder_sent_at,
    signerName: row.signer_name,
    signerEmail: row.signer_email,
    consentAt: row.consent_at,
    templateSha256: row.template_sha256,
    signedSha256: row.signed_sha256,
    hasSignedCopy: row.signed_key !== null,
    insertedAt: row.inserted_at,
    updatedAt: row.updated_at,
  };
}

export function toCertUpload(
  row: CertificationUploadRow,
  current: boolean,
  today: string,
): CertUpload {
  return {
    id: row.id,
    instructorId: row.instructor_id,
    org: row.org,
    track: row.track,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    reviewStatus: row.review_status,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    validUntil: row.valid_until,
    current,
    state: certificationState(
      { reviewStatus: row.review_status, validUntil: row.valid_until },
      today,
    ),
    aiResult: row.ai_result,
    aiModel: row.ai_model,
    aiCheckedAt: row.ai_checked_at,
    insertedAt: row.inserted_at,
    updatedAt: row.updated_at,
  };
}

/** Certification uploads with `current` set on the latest per `(org, track)`. */
export function toCertUploads(
  rows: readonly CertificationUploadRow[],
  today: string,
): CertUpload[] {
  const current = currentUploads(
    rows.map((row) => ({
      id: row.id,
      org: row.org,
      track: row.track,
      insertedAt: row.inserted_at,
    })),
  );
  const currentIds = new Set([...current.values()].map((upload) => upload.id));
  return [...rows]
    .sort((a, b) => Date.parse(b.inserted_at) - Date.parse(a.inserted_at))
    .map((row) => toCertUpload(row, currentIds.has(row.id), today));
}

export function toSigningTemplate(row: DocumentTemplateRow): SigningTemplate {
  return {
    id: row.id,
    kind: row.kind,
    titleEn: row.title_en,
    titleZh: row.title_zh,
    descriptionEn: row.description_en,
    descriptionZh: row.description_zh,
    pageCount: row.page_count,
    pages: row.pages,
    fields: row.fields.map(toTemplateField),
  };
}
