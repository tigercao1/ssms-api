import type { DocumentLanguage, PageGeometry } from './documents.types';

export const FORM_FIELD_TYPES = ['text', 'email', 'date', 'signature'] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormField {
  key: string;
  type: FormFieldType;
  label: string;
  required: boolean;
}

export interface FormPlacement {
  key: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const SIGNER_NAME_KEY = 'participant_name';
export const SIGNER_EMAIL_KEY = 'email';

const field = (
  key: string,
  type: FormFieldType,
  required: boolean,
  en: string,
  zh: string,
) => ({ key, type, required, label: { en, zh } });

const WAIVER_FIELDS = [
  field(SIGNER_NAME_KEY, 'text', true, 'Participant name', '参与者姓名'),
  field(SIGNER_EMAIL_KEY, 'email', true, 'Email', '电子邮箱'),
  field('date', 'date', true, 'Date', '日期'),
  field('id_number', 'text', false, 'ID number', '证件号码'),
  field('initials', 'text', false, 'Initials', '姓名缩写'),
  field(
    'participant_signature',
    'signature',
    true,
    'Participant signature',
    '参与者签名',
  ),
  field('guardian_name', 'text', false, 'Guardian name', '监护人姓名'),
  field(
    'guardian_signature',
    'signature',
    false,
    'Guardian signature',
    '监护人签名',
  ),
  field('witness_name', 'text', false, 'Witness name', '见证人姓名'),
  field(
    'witness_signature',
    'signature',
    false,
    'Witness signature',
    '见证人签名',
  ),
];

export function defaultWaiverFields(language: DocumentLanguage): FormField[] {
  return WAIVER_FIELDS.map(({ label, ...rest }) => ({
    ...rest,
    label: label[language],
  }));
}

export interface FormVersionRow {
  template_id: string;
  language: DocumentLanguage;
  version: number;
  title: string;
  body_markdown: string;
  body_sha256: string;
  fields: FormField[];
  source_key: string | null;
  source_sha256: string | null;
  source_size_bytes: number | null;
  page_count: number | null;
  pages: PageGeometry[];
  placements: FormPlacement[];
  published_at: string | null;
  published_by: string | null;
  updated_by: string | null;
  inserted_at: string;
  updated_at: string;
}

export interface PublishedForm {
  templateId: string;
  slug: string;
  titleEn: string;
  titleZh: string | null;
  emailCopy: boolean;
  version: FormVersionRow;
}

/** `GET /sign/forms/:slug`. */
export interface PublicForm {
  slug: string;
  lang: DocumentLanguage;
  version: number;
  title: string;
  bodyMarkdown: string;
  fields: FormField[];
  hasOriginalPdf: boolean;
  originalPdf: PublicOriginalPdf | null;
  emailCopy: boolean;
}

/** Layout of the served version's original PDF, for overlaying answers in the browser. */
export interface PublicOriginalPdf {
  pageCount: number;
  pages: PageGeometry[];
  placements: FormPlacement[];
}

/** `POST /sign/forms/:slug/complete`. */
export interface CompletedForm {
  status: 'signed';
  emailed: boolean;
}

export interface FormTemplateRow {
  id: string;
  slug: string;
  title_en: string;
  title_zh: string | null;
  email_copy: boolean;
  inserted_at: string;
  updated_at: string;
  versions: FormVersionRow[];
}

/** One language of a form: the version signers see and the unpublished draft, if any. */
export interface FormLanguageVersions {
  published: FormVersion | null;
  draft: FormVersion | null;
}

export interface FormVersion {
  version: number;
  title: string;
  bodyMarkdown: string;
  bodySha256: string;
  fields: FormField[];
  originalPdf: FormOriginalPdf | null;
  placements: FormPlacement[];
  publishedAt: string | null;
  updatedAt: string;
}

/** The original PDF of a form version; `url` is a short-lived GET for the editor to render. */
export interface FormOriginalPdf {
  sha256: string;
  sizeBytes: number;
  pageCount: number;
  pages: PageGeometry[];
  url: string;
  urlExpiresAt: string;
}

/** `GET /admin/documents/forms/:id`. */
export interface FormTemplate {
  id: string;
  slug: string;
  titleEn: string;
  titleZh: string | null;
  emailCopy: boolean;
  languages: Record<DocumentLanguage, FormLanguageVersions>;
  defaultFields: Record<DocumentLanguage, FormField[]>;
  insertedAt: string;
  updatedAt: string;
}

/** `GET /admin/documents/forms`. */
export interface FormTemplateSummary {
  id: string;
  slug: string;
  titleEn: string;
  titleZh: string | null;
  emailCopy: boolean;
  publishedVersions: Record<DocumentLanguage, number | null>;
  hasDraft: Record<DocumentLanguage, boolean>;
  hasOriginalPdf: Record<DocumentLanguage, boolean>;
  updatedAt: string;
  lastChangedAt: string;
}

export interface SignatureLookupRow {
  subject_type: 'instructor' | 'customer';
  subject_id: string;
  name: string | null;
  email: string | null;
  assignment_id: string | null;
  template_id: string | null;
  title_en: string | null;
  title_zh: string | null;
  kind: string | null;
  language: DocumentLanguage | null;
  form_version: number | null;
  signed_at: string | null;
  has_signed_copy: boolean | null;
}

export interface SignedDocumentEntry {
  assignmentId: string;
  templateId: string;
  titleEn: string;
  titleZh: string | null;
  kind: string;
  language: DocumentLanguage | null;
  formVersion: number | null;
  signedAt: string;
  hasSignedCopy: boolean;
}

/** `GET /admin/signatures`: one instructor or customer and what they completed. */
export interface Signer {
  subjectType: 'instructor' | 'customer';
  subjectId: string;
  name: string | null;
  email: string | null;
  signatures: SignedDocumentEntry[];
}

/** `GET /admin/signatures/check?email=`: whether that exact email signed anything, and what. */
export interface SignatureCheck {
  signed: boolean;
  signedAt: string | null;
  templateTitles: string[];
}

/** `GET /me/students/signatures`: name and waiver status only. */
export interface StudentSignature {
  name: string | null;
  signed: boolean;
  signedAt: string | null;
}
