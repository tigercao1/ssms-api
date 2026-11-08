import type { DocumentLanguage } from './documents.types';

export const FORM_FIELD_TYPES = ['text', 'email', 'date', 'signature'] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormField {
  key: string;
  type: FormFieldType;
  label: string;
  required: boolean;
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
}

/** `POST /sign/forms/:slug/complete`. */
export interface CompletedForm {
  status: 'signed';
  emailed: boolean;
}
