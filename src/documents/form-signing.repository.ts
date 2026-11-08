import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import {
  type DocumentAssignmentWrite,
  DOCUMENT_ASSIGNMENT_COLUMNS,
  DOCUMENT_ASSIGNMENTS_TABLE,
} from './document-assignments.repository';
import { DOCUMENT_TEMPLATES_TABLE } from './document-templates.repository';
import type {
  DocumentAssignmentRow,
  DocumentLanguage,
} from './documents.types';
import type { FormVersionRow, PublishedForm } from './form-templates.types';

export const DOCUMENT_FORM_VERSIONS_TABLE = 'document_form_versions';
export const FORM_VERSION_COLUMNS =
  'template_id, language, version, title, body_markdown, body_sha256, fields, ' +
  'published_at, published_by, updated_by, inserted_at, updated_at';

export const FORM_COPY_EMAIL_LIMITS = {
  perRecipient: 5,
  recipientWindowSeconds: 60 * 60,
  global: 30,
  globalWindowSeconds: 60,
} as const;

export type NewSignedFormAssignment = DocumentAssignmentWrite & {
  id: string;
  template_id: string;
  subject_id: string;
  form_version: number;
};

interface FormTemplateRow {
  id: string;
  slug: string;
  title_en: string;
  title_zh: string | null;
}

export abstract class FormSigningRepository {
  abstract findPublished(
    slug: string,
    language: DocumentLanguage,
  ): Promise<PublishedForm | null>;
  abstract customerForEmail(
    email: string,
    firstName: string | null,
    lastName: string | null,
  ): Promise<string>;
  abstract insertSigned(
    row: NewSignedFormAssignment,
  ): Promise<DocumentAssignmentRow>;
  abstract claimCopyEmail(emailHash: string): Promise<boolean>;
}

@Injectable()
export class SupabaseFormSigningRepository extends FormSigningRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async findPublished(
    slug: string,
    language: DocumentLanguage,
  ): Promise<PublishedForm | null> {
    const { data: template, error } = (await this.supabase
      .from(DOCUMENT_TEMPLATES_TABLE)
      .select('id, slug, title_en, title_zh')
      .eq('slug', slug)
      .eq('kind', 'form')
      .maybeSingle()) as DbResult<FormTemplateRow>;
    check(error, 'load form template');
    if (!template) {
      return null;
    }
    const { data: version, error: versionError } = (await this.supabase
      .from(DOCUMENT_FORM_VERSIONS_TABLE)
      .select(FORM_VERSION_COLUMNS)
      .eq('template_id', template.id)
      .eq('language', language)
      .not('published_at', 'is', null)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()) as DbResult<FormVersionRow>;
    check(versionError, 'load published form version');
    return version
      ? {
          templateId: template.id,
          slug: template.slug,
          titleEn: template.title_en,
          titleZh: template.title_zh,
          version,
        }
      : null;
  }

  async customerForEmail(
    email: string,
    firstName: string | null,
    lastName: string | null,
  ): Promise<string> {
    const { data, error } = (await this.supabase.rpc(
      'waiver_customer_for_email',
      { p_email: email, p_first_name: firstName, p_last_name: lastName },
    )) as DbResult<string>;
    check(error, 'match waiver customer');
    if (!data) {
      throw new Error('Failed to match waiver customer: no id returned');
    }
    return data;
  }

  async insertSigned(
    row: NewSignedFormAssignment,
  ): Promise<DocumentAssignmentRow> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_ASSIGNMENTS_TABLE)
      .insert({ ...row, subject_type: 'customer', status: 'completed' })
      .select(DOCUMENT_ASSIGNMENT_COLUMNS)
      .single()) as DbResult<DocumentAssignmentRow>;
    check(error, 'record signed form');
    if (!data) {
      throw new Error('Failed to record signed form: no row returned');
    }
    return data;
  }

  async claimCopyEmail(emailHash: string): Promise<boolean> {
    const { data, error } = (await this.supabase.rpc('claim_form_copy_email', {
      p_email_hash: emailHash,
      p_per_recipient: FORM_COPY_EMAIL_LIMITS.perRecipient,
      p_recipient_window_seconds: FORM_COPY_EMAIL_LIMITS.recipientWindowSeconds,
      p_global: FORM_COPY_EMAIL_LIMITS.global,
      p_global_window_seconds: FORM_COPY_EMAIL_LIMITS.globalWindowSeconds,
    })) as DbResult<boolean>;
    check(error, 'claim form copy email');
    return data === true;
  }
}
