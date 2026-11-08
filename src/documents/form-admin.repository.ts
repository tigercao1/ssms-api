import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { DOCUMENT_TEMPLATES_TABLE } from './document-templates.repository';
import type { DocumentLanguage } from './documents.types';
import {
  DOCUMENT_FORM_VERSIONS_TABLE,
  FORM_VERSION_COLUMNS,
} from './form-signing.repository';
import type {
  FormField,
  FormTemplateRow,
  FormVersionRow,
  SignatureLookupRow,
} from './form-templates.types';

const FORM_COLUMNS = `id, slug, title_en, title_zh, email_copy, inserted_at, updated_at, versions:${DOCUMENT_FORM_VERSIONS_TABLE}(${FORM_VERSION_COLUMNS})`;
const FORM_LIST_COLUMNS = `id, slug, title_en, title_zh, email_copy, inserted_at, updated_at, versions:${DOCUMENT_FORM_VERSIONS_TABLE}(language, version, published_at)`;

export interface FormDraftWrite {
  title: string;
  body_markdown: string;
  body_sha256: string;
  fields: FormField[];
  updated_by: string | null;
}

export type FormSourceWrite = Pick<
  FormVersionRow,
  | 'source_key'
  | 'source_sha256'
  | 'source_size_bytes'
  | 'page_count'
  | 'pages'
  | 'placements'
>;

export type FormDraftPatch = Partial<FormDraftWrite & FormSourceWrite>;

export type FormDraftSource = Pick<
  FormVersionRow,
  'source_key' | 'source_sha256'
>;

export interface FormTemplateWrite {
  slug?: string;
  title_en?: string;
  title_zh?: string | null;
  email_copy?: boolean;
  updated_by?: string | null;
}

export abstract class FormAdminRepository {
  abstract list(): Promise<FormTemplateRow[]>;
  abstract findById(id: string): Promise<FormTemplateRow | null>;
  abstract insert(
    row: FormTemplateWrite & { slug: string; title_en: string },
  ): Promise<FormTemplateRow>;
  abstract update(
    id: string,
    patch: FormTemplateWrite,
  ): Promise<FormTemplateRow | null>;
  abstract updateDraft(
    templateId: string,
    language: DocumentLanguage,
    expected: FormDraftSource,
    draft: FormDraftPatch,
  ): Promise<FormVersionRow | null>;
  abstract insertDraft(
    templateId: string,
    language: DocumentLanguage,
    version: number,
    draft: FormDraftWrite & Partial<FormSourceWrite>,
  ): Promise<FormVersionRow>;
  abstract publishDraft(
    templateId: string,
    language: DocumentLanguage,
    expectedUpdatedAt: string,
    publishedBy: string | null,
    publishedAt: string,
  ): Promise<FormVersionRow | null>;
  abstract lookupSignatures(
    query: string,
    limit: number,
  ): Promise<SignatureLookupRow[]>;
  abstract signatureCheck(
    email: string,
  ): Promise<{ title_en: string; signed_at: string }[]>;
  abstract studentSignatures(
    instructorId: string,
    query: string,
    limit: number,
  ): Promise<{ name: string | null; signed_at: string | null }[]>;
}

@Injectable()
export class SupabaseFormAdminRepository extends FormAdminRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async list(): Promise<FormTemplateRow[]> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_TEMPLATES_TABLE)
      .select(FORM_LIST_COLUMNS)
      .eq('kind', 'form')
      .order('title_en', { ascending: true })) as DbResult<FormTemplateRow[]>;
    check(error, 'list form templates');
    return data ?? [];
  }

  async findById(id: string): Promise<FormTemplateRow | null> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_TEMPLATES_TABLE)
      .select(FORM_COLUMNS)
      .eq('id', id)
      .eq('kind', 'form')
      .maybeSingle()) as DbResult<FormTemplateRow>;
    check(error, 'load form template');
    return data ?? null;
  }

  async insert(
    row: FormTemplateWrite & { slug: string; title_en: string },
  ): Promise<FormTemplateRow> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_TEMPLATES_TABLE)
      .insert({
        ...row,
        kind: 'form',
        audience: 'customer',
        required: false,
      })
      .select(FORM_COLUMNS)
      .single()) as DbResult<FormTemplateRow>;
    check(error, 'create form template');
    if (!data) {
      throw new Error('Failed to create form template: no row returned');
    }
    return data;
  }

  async update(
    id: string,
    patch: FormTemplateWrite,
  ): Promise<FormTemplateRow | null> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_TEMPLATES_TABLE)
      .update(patch)
      .eq('id', id)
      .eq('kind', 'form')
      .select(FORM_COLUMNS)
      .maybeSingle()) as DbResult<FormTemplateRow>;
    check(error, 'update form template');
    return data ?? null;
  }

  async updateDraft(
    templateId: string,
    language: DocumentLanguage,
    expected: FormDraftSource,
    draft: FormDraftPatch,
  ): Promise<FormVersionRow | null> {
    let query = this.supabase
      .from(DOCUMENT_FORM_VERSIONS_TABLE)
      .update(draft)
      .eq('template_id', templateId)
      .eq('language', language)
      .is('published_at', null);
    for (const column of ['source_key', 'source_sha256'] as const) {
      const value = expected[column];
      query = value === null ? query.is(column, null) : query.eq(column, value);
    }
    const { data, error } = (await query
      .select(FORM_VERSION_COLUMNS)
      .maybeSingle()) as DbResult<FormVersionRow>;
    check(error, 'save form draft');
    return data ?? null;
  }

  async insertDraft(
    templateId: string,
    language: DocumentLanguage,
    version: number,
    draft: FormDraftWrite & Partial<FormSourceWrite>,
  ): Promise<FormVersionRow> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_FORM_VERSIONS_TABLE)
      .insert({ ...draft, template_id: templateId, language, version })
      .select(FORM_VERSION_COLUMNS)
      .single()) as DbResult<FormVersionRow>;
    check(error, 'create form draft');
    if (!data) {
      throw new Error('Failed to create form draft: no row returned');
    }
    return data;
  }

  async publishDraft(
    templateId: string,
    language: DocumentLanguage,
    expectedUpdatedAt: string,
    publishedBy: string | null,
    publishedAt: string,
  ): Promise<FormVersionRow | null> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_FORM_VERSIONS_TABLE)
      .update({ published_at: publishedAt, published_by: publishedBy })
      .eq('template_id', templateId)
      .eq('language', language)
      .is('published_at', null)
      .eq('updated_at', expectedUpdatedAt)
      .select(FORM_VERSION_COLUMNS)
      .maybeSingle()) as DbResult<FormVersionRow>;
    check(error, 'publish form draft');
    return data ?? null;
  }

  async lookupSignatures(
    query: string,
    limit: number,
  ): Promise<SignatureLookupRow[]> {
    const { data, error } = (await this.supabase.rpc('admin_signature_lookup', {
      p_query: query,
      p_limit: limit,
    })) as DbResult<SignatureLookupRow[]>;
    check(error, 'look up signatures');
    return data ?? [];
  }

  async signatureCheck(
    email: string,
  ): Promise<{ title_en: string; signed_at: string }[]> {
    const { data, error } = (await this.supabase.rpc('admin_signature_check', {
      p_email: email,
    })) as DbResult<{ title_en: string; signed_at: string }[]>;
    check(error, 'check signatures by email');
    return data ?? [];
  }

  async studentSignatures(
    instructorId: string,
    query: string,
    limit: number,
  ): Promise<{ name: string | null; signed_at: string | null }[]> {
    const { data, error } = (await this.supabase.rpc(
      'instructor_student_signatures',
      { p_instructor_id: instructorId, p_query: query, p_limit: limit },
    )) as DbResult<{ name: string | null; signed_at: string | null }[]>;
    check(error, 'look up student signatures');
    return data ?? [];
  }
}
