import type { DocumentLanguage } from './documents.types';

/** The two Jotform waiver forms SSMS replaced, and the language of each. */
export const JOTFORM_FORM_LANGUAGES: Readonly<
  Record<string, DocumentLanguage>
> = {
  '242658653833264': 'zh',
  '232628492941059': 'en',
};

/** Slug of the SSMS form that imported Jotform waivers are filed under. */
export const JOTFORM_WAIVER_SLUG = 'waiver';

export interface ImportedSignatureRow {
  id: string;
  subject_id: string;
  signed_sha256: string | null;
}

export interface NewImportedSignature {
  id: string;
  template_id: string;
  subject_id: string;
  language: DocumentLanguage;
  signer_name: string;
  signer_email: string;
  signer_ip: string | null;
  completed_at: string;
  signed_key: string;
  signed_sha256: string;
  field_values: Record<string, string>;
  external_id: string;
  external_form_id: string;
}

/** `POST /admin/signatures/jotform`: what the import did with one submission. */
export interface JotformImportResult {
  status: 'imported' | 'existing';
  submissionId: string;
  customerId: string;
  assignmentId: string;
  signedSha256: string | null;
}
