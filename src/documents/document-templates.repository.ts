import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type {
  DocumentTemplateRow,
  DocumentTemplateWrite,
  TemplateStatus,
} from './documents.types';

export const DOCUMENT_TEMPLATES_TABLE = 'document_templates';
export const DOCUMENT_TEMPLATE_COLUMNS =
  'id, kind, audience, title_en, title_zh, description_en, description_zh, required, ' +
  'status, assign_to, season, published_at, published_by, ' +
  'sort_order, source_key, source_sha256, page_count, pages, fields, ' +
  'updated_by, inserted_at, updated_at';

export type NewDocumentTemplate = DocumentTemplateWrite &
  Pick<DocumentTemplateRow, 'kind' | 'audience' | 'title_en'>;

/** Data access for `document_templates`. */
export abstract class DocumentTemplatesRepository {
  /** Every template, by `sort_order` then English title. */
  abstract list(): Promise<DocumentTemplateRow[]>;
  abstract findById(id: string): Promise<DocumentTemplateRow | null>;
  /** `live` templates published to `all` of an audience, by `sort_order`; optionally one season only. */
  abstract listLiveForAll(
    audience: DocumentTemplateRow['audience'],
    season?: string | null,
  ): Promise<DocumentTemplateRow[]>;
  abstract insert(input: NewDocumentTemplate): Promise<DocumentTemplateRow>;
  abstract update(
    id: string,
    patch: DocumentTemplateWrite,
  ): Promise<DocumentTemplateRow | null>;
  /** Updates the row only while its status is one of `statuses`; null otherwise. */
  abstract updateIfStatus(
    id: string,
    statuses: TemplateStatus[],
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

  async listLiveForAll(
    audience: DocumentTemplateRow['audience'],
    season?: string | null,
  ): Promise<DocumentTemplateRow[]> {
    let query = this.supabase
      .from(DOCUMENT_TEMPLATES_TABLE)
      .select(DOCUMENT_TEMPLATE_COLUMNS)
      .eq('audience', audience)
      .eq('status', 'live')
      .eq('assign_to', 'all');
    if (season) {
      query = query.eq('season', season);
    }
    const { data, error } = (await query
      .order('sort_order', { ascending: true })
      .order('title_en', { ascending: true })) as DbResult<
      DocumentTemplateRow[]
    >;
    check(error, 'list published document templates');
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

  async updateIfStatus(
    id: string,
    statuses: TemplateStatus[],
    patch: DocumentTemplateWrite,
  ): Promise<DocumentTemplateRow | null> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_TEMPLATES_TABLE)
      .update(patch)
      .eq('id', id)
      .in('status', statuses)
      .select(DOCUMENT_TEMPLATE_COLUMNS)
      .maybeSingle()) as DbResult<DocumentTemplateRow>;
    check(error, 'update document template');
    return data ?? null;
  }
}
