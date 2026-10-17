import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type {
  DocumentExportRow,
  DocumentExportStatus,
  DocumentExportWrite,
  NewDocumentExportRow,
  TemplateAssignmentDbRow,
  TemplateAssignmentQuery,
} from './document-exports.types';

export const DOCUMENT_EXPORTS_TABLE = 'document_exports';
export const DOCUMENT_EXPORT_COLUMNS =
  'id, template_id, season, assignment_ids, status, file_count, skipped_count, ' +
  'size_bytes, zip_key, error, requested_by, started_at, finished_at, ' +
  'expires_at, inserted_at, updated_at';

/** Data access for `document_exports` and the per-template assignment listing. */
export abstract class DocumentExportsRepository {
  abstract insert(row: NewDocumentExportRow): Promise<DocumentExportRow>;
  abstract findById(id: string): Promise<DocumentExportRow | null>;
  /** A template's latest `limit` exports, newest first. */
  abstract listForTemplate(
    templateId: string,
    limit: number,
  ): Promise<DocumentExportRow[]>;
  /** Updates the row only while its status is one of `statuses`; null otherwise. */
  abstract updateIfStatus(
    id: string,
    statuses: DocumentExportStatus[],
    patch: DocumentExportWrite,
  ): Promise<DocumentExportRow | null>;
  /** Marks every `queued` or `running` export `failed`; returns how many. */
  abstract failUnfinished(error: string, at: string): Promise<number>;
  /** `ready` exports whose `expires_at` is at or before `now`. */
  abstract listExpired(now: string): Promise<DocumentExportRow[]>;
  /** Non-archived instructor assignments of a template, filtered, sorted and paged. */
  abstract listTemplateAssignments(
    query: TemplateAssignmentQuery,
  ): Promise<TemplateAssignmentDbRow[]>;
}

@Injectable()
export class SupabaseDocumentExportsRepository extends DocumentExportsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async insert(row: NewDocumentExportRow): Promise<DocumentExportRow> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_EXPORTS_TABLE)
      .insert(row)
      .select(DOCUMENT_EXPORT_COLUMNS)
      .single()) as DbResult<DocumentExportRow>;
    check(error, 'create document export');
    return data as DocumentExportRow;
  }

  async findById(id: string): Promise<DocumentExportRow | null> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_EXPORTS_TABLE)
      .select(DOCUMENT_EXPORT_COLUMNS)
      .eq('id', id)
      .maybeSingle()) as DbResult<DocumentExportRow>;
    check(error, 'load document export');
    return data ?? null;
  }

  async listForTemplate(
    templateId: string,
    limit: number,
  ): Promise<DocumentExportRow[]> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_EXPORTS_TABLE)
      .select(DOCUMENT_EXPORT_COLUMNS)
      .eq('template_id', templateId)
      .order('inserted_at', { ascending: false })
      .limit(limit)) as DbResult<DocumentExportRow[]>;
    check(error, 'list document exports');
    return data ?? [];
  }

  async updateIfStatus(
    id: string,
    statuses: DocumentExportStatus[],
    patch: DocumentExportWrite,
  ): Promise<DocumentExportRow | null> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_EXPORTS_TABLE)
      .update(patch)
      .eq('id', id)
      .in('status', statuses)
      .select(DOCUMENT_EXPORT_COLUMNS)
      .maybeSingle()) as DbResult<DocumentExportRow>;
    check(error, 'update document export');
    return data ?? null;
  }

  async failUnfinished(error: string, at: string): Promise<number> {
    const { data, error: dbError } = (await this.supabase
      .from(DOCUMENT_EXPORTS_TABLE)
      .update({ status: 'failed', error, finished_at: at })
      .in('status', ['queued', 'running'])
      .select('id')) as DbResult<{ id: string }[]>;
    check(dbError, 'fail unfinished document exports');
    return (data ?? []).length;
  }

  async listExpired(now: string): Promise<DocumentExportRow[]> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_EXPORTS_TABLE)
      .select(DOCUMENT_EXPORT_COLUMNS)
      .eq('status', 'ready')
      .lte('expires_at', now)) as DbResult<DocumentExportRow[]>;
    check(error, 'list expired document exports');
    return data ?? [];
  }

  async listTemplateAssignments(
    query: TemplateAssignmentQuery,
  ): Promise<TemplateAssignmentDbRow[]> {
    const { data, error } = (await this.supabase.rpc(
      'document_template_assignments',
      {
        p_template_id: query.templateId,
        p_season: query.season,
        p_status: query.status,
        p_patterns: query.patterns,
        p_ids: query.ids,
        p_limit: query.limit,
        p_offset: query.offset,
      },
    )) as DbResult<TemplateAssignmentDbRow[]>;
    check(error, 'list template assignments');
    return data ?? [];
  }
}
