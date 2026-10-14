import type { CertificationState } from './certification-validity';

/**
 * Domain types for onboarding documents. `*Row` types mirror DB columns
 * (snake_case); the other interfaces are the camelCase shapes the API returns.
 */

export const DOCUMENT_KINDS = ['sign', 'read'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_AUDIENCES = ['instructor', 'customer'] as const;
export type DocumentAudience = (typeof DOCUMENT_AUDIENCES)[number];

export const ASSIGNMENT_STATUSES = [
  'assigned',
  'viewed',
  'completed',
  'archived',
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export type SubjectType = 'instructor' | 'customer';

export const FIELD_TYPES = [
  'signature',
  'initials',
  'full_name',
  'date',
  'text',
  'checkbox',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_PREFILLS = ['full_name', 'email', 'date_signed'] as const;
export type FieldPrefill = (typeof FIELD_PREFILLS)[number];

export const CERT_ORGS = ['csia', 'casi'] as const;
export type CertOrg = (typeof CERT_ORGS)[number];

export const CERT_TRACKS = ['regular', 'park', 'carving'] as const;
export type CertTrack = (typeof CERT_TRACKS)[number];

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

/**
 * Visible page box of the unrotated page in PDF points (CropBox clipped to
 * MediaBox, as pdf.js renders it). `x`/`y` is the box's lower-left corner in
 * user space, so a field at (`x`, `y`) sits at the visible bottom-left corner.
 */
export interface PageGeometry {
  width: number;
  height: number;
  rotate: 0 | 90 | 180 | 270;
  x: number;
  y: number;
}

/** A placed field as stored in `document_templates.fields`. */
export interface TemplateFieldRow {
  id: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
  label_en: string;
  label_zh: string | null;
  prefill: FieldPrefill | null;
}

/** A placed field as returned by and sent to the API. */
export interface TemplateField {
  id: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
  labelEn: string;
  labelZh: string | null;
  prefill: FieldPrefill | null;
}

export interface DocumentTemplateRow {
  id: string;
  kind: DocumentKind;
  audience: DocumentAudience;
  title_en: string;
  title_zh: string | null;
  description_en: string | null;
  description_zh: string | null;
  required: boolean;
  is_active: boolean;
  sort_order: number;
  source_key: string | null;
  source_sha256: string | null;
  page_count: number | null;
  pages: PageGeometry[];
  fields: TemplateFieldRow[];
  updated_by: string | null;
  inserted_at: string;
  updated_at: string;
}

export type DocumentTemplateWrite = Partial<
  Omit<DocumentTemplateRow, 'id' | 'inserted_at' | 'updated_at'>
>;

/** Template columns embedded on an assignment read. */
export type AssignmentTemplateRow = Pick<
  DocumentTemplateRow,
  | 'id'
  | 'kind'
  | 'audience'
  | 'title_en'
  | 'title_zh'
  | 'description_en'
  | 'description_zh'
  | 'required'
  | 'is_active'
  | 'sort_order'
>;

export interface DocumentAssignmentRow {
  id: string;
  template_id: string;
  subject_type: SubjectType;
  subject_id: string;
  season: string | null;
  class_id: string | null;
  status: AssignmentStatus;
  assigned_at: string;
  viewed_at: string | null;
  completed_at: string | null;
  due_at: string | null;
  reminder_sent_at: string | null;
  signer_name: string | null;
  signer_email: string | null;
  signer_ip: string | null;
  signer_user_agent: string | null;
  consent_at: string | null;
  template_sha256: string | null;
  signed_key: string | null;
  signed_sha256: string | null;
  field_values: Record<string, unknown>;
  inserted_at: string;
  updated_at: string;
  template: AssignmentTemplateRow | null;
}

export interface NewAssignmentRow {
  template_id: string;
  subject_type: SubjectType;
  subject_id: string;
  season: string;
}

export interface CertificationUploadRow {
  id: string;
  instructor_id: string;
  org: CertOrg;
  track: CertTrack;
  file_key: string;
  sha256: string;
  content_type: string;
  size_bytes: number;
  review_status: ReviewStatus;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  valid_until: string;
  expiry_reminder_sent_at: string | null;
  ai_result: Record<string, unknown> | null;
  ai_model: string | null;
  ai_checked_at: string | null;
  inserted_at: string;
  updated_at: string;
}

/** An instructor as needed to address documents to them. */
export interface DocumentInstructorRow {
  id: string;
  auth_user_id: string;
  email: string;
  display_name_en: string;
  approval_status: string;
  is_active: boolean;
}

/** One `instructor_certifications` row. */
export interface InstructorCertificationRow {
  org: CertOrg;
  track: CertTrack;
  level: number;
}

export interface TemplateSummary {
  id: string;
  kind: DocumentKind;
  audience: DocumentAudience;
  titleEn: string;
  titleZh: string | null;
  descriptionEn: string | null;
  descriptionZh: string | null;
  required: boolean;
  isActive: boolean;
  sortOrder: number;
  hasSource: boolean;
  pageCount: number | null;
  fieldCount: number;
  insertedAt: string;
  updatedAt: string;
}

export interface Template extends TemplateSummary {
  sourceSha256: string | null;
  pages: PageGeometry[];
  fields: TemplateField[];
  sourceUrl: string | null;
  updatedBy: string | null;
}

/** Response of a source confirm: `fieldsCleared` says whether placed fields were dropped. */
export interface ConfirmedTemplate extends Template {
  fieldsCleared: boolean;
}

export interface AssignmentTemplate {
  id: string;
  kind: DocumentKind;
  titleEn: string;
  titleZh: string | null;
  required: boolean;
}

export interface Assignment {
  id: string;
  templateId: string;
  template: AssignmentTemplate | null;
  subjectType: SubjectType;
  subjectId: string;
  season: string | null;
  classId: string | null;
  status: AssignmentStatus;
  assignedAt: string;
  viewedAt: string | null;
  completedAt: string | null;
  dueAt: string | null;
  reminderSentAt: string | null;
  signerName: string | null;
  signerEmail: string | null;
  consentAt: string | null;
  templateSha256: string | null;
  signedSha256: string | null;
  hasSignedCopy: boolean;
  insertedAt: string;
  updatedAt: string;
}

export interface CertUpload {
  id: string;
  instructorId: string;
  org: CertOrg;
  track: CertTrack;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  reviewStatus: ReviewStatus;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  validUntil: string;
  current: boolean;
  state: CertificationState;
  aiResult: Record<string, unknown> | null;
  aiModel: string | null;
  aiCheckedAt: string | null;
  insertedAt: string;
  updatedAt: string;
}

export interface AssignmentResult {
  created: number;
  skipped: number;
}

export interface InstructorDocuments {
  assignments: Assignment[];
  certificationUploads: CertUpload[];
}

export interface DocumentChecklistItem {
  type: 'document';
  assignmentId: string;
  templateId: string;
  kind: DocumentKind;
  titleEn: string;
  titleZh: string | null;
  descriptionEn: string | null;
  descriptionZh: string | null;
  required: boolean;
  status: AssignmentStatus;
  season: string | null;
  assignedAt: string;
  viewedAt: string | null;
  completedAt: string | null;
  dueAt: string | null;
}

export interface CertificationChecklistItem {
  type: 'certification';
  org: CertOrg;
  track: CertTrack;
  level: number;
  uploadId: string | null;
  reviewStatus: ReviewStatus | null;
  reviewNote: string | null;
  validUntil: string | null;
  state: CertificationState;
}

export type ChecklistItem = DocumentChecklistItem | CertificationChecklistItem;

export interface Checklist {
  season: string | null;
  items: ChecklistItem[];
}

export interface UploadUrl {
  uploadUrl: string;
  expiresAt: string;
}
