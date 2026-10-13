import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type {
  DocumentTemplateRow,
  DocumentTemplateWrite,
} from './documents.types';

export const DOCUMENT_TEMPLATES_TABLE = 'document_templates';
export const DOCUMENT_TEMPLATE_COLUMNS =
  'id, kind, audience, title_en, title_zh, description_en, description_zh, required, ' +
  'is_active, sort_order, source_key, source_sha256, page_count, pages, fields, ' +
  'updated_by, inserted_at, updated_at';

export type NewDocumentTemplate = DocumentTemplateWrite &
  Pick<DocumentTemplateRow, 'kind' | 'audience' | 'title_en'>;

/** Data access for `document_templates`. */
export abstract class DocumentTemplatesRepository {
  /** Every template, by `sort_order` then English title. */
  abstract list(): Promise<DocumentTemplateRow[]>;
  abstract findById(id: string): Promise<DocumentTemplateRow | null>;
  /** Active, required templates for an audience, by `sort_order`. */
  abstract listActiveRequired(
    audience: DocumentTemplateRow['audience'],
  ): Promise<DocumentTemplateRow[]>;
  abstract insert(input: NewDocumentTemplate): Promise<DocumentTemplateRow>;
  abstract update(
    id: string,
    patch: DocumentTemplateWrite,
  ): Promise<DocumentTemplateRow | null>;
}

@Injectable()
export class SupabaseDocumentTemplatesRepository extends DocumentTemplatesRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async list(): Promise<DocumentTemplateRow[]> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_TEMPLATES_TABLE)
      .select(DOCUMENT_TEMPLATE_COLUMNS)
      .order('sort_order', { ascending: true })
      .order('title_en', { ascending: true })) as DbResult<
      DocumentTemplateRow[]
    >;
    check(error, 'list document templates');
    return data ?? [];
  }

  async findById(id: string): Promise<DocumentTemplateRow | null> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_TEMPLATES_TABLE)
      .select(DOCUMENT_TEMPLATE_COLUMNS)
      .eq('id', id)
      .maybeSingle()) as DbResult<DocumentTemplateRow>;
    check(error, 'load document template');
    return data ?? null;
  }

  async listActiveRequired(
    audience: DocumentTemplateRow['audience'],
  ): Promise<DocumentTemplateRow[]> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_TEMPLATES_TABLE)
      .select(DOCUMENT_TEMPLATE_COLUMNS)
      .eq('audience', audience)
      .eq('is_active', true)
      .eq('required', true)
      .order('sort_order', { ascending: true })) as DbResult<
      DocumentTemplateRow[]
    >;
    check(error, 'list required document templates');
    return data ?? [];
  }

  async insert(input: NewDocumentTemplate): Promise<DocumentTemplateRow> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_TEMPLATES_TABLE)
      .insert(input)
      .select(DOCUMENT_TEMPLATE_COLUMNS)
      .single()) as DbResult<DocumentTemplateRow>;
    check(error, 'create document template');
    if (!data) {
      throw new Error('Failed to create document template: no row returned');
    }
    return data;
  }

  async update(
    id: string,
    patch: DocumentTemplateWrite,
  ): Promise<DocumentTemplateRow | null> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_TEMPLATES_TABLE)
      .update(patch)
      .eq('id', id)
      .select(DOCUMENT_TEMPLATE_COLUMNS)
      .maybeSingle()) as DbResult<DocumentTemplateRow>;
    check(error, 'update document template');
    return data ?? null;
  }
}
