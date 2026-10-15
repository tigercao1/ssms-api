import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  check,
  type DbResult,
  hasCode,
  PG_UNIQUE_VIOLATION,
} from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type {
  AssignmentStatus,
  DocumentAssignmentRow,
  NewAssignmentRow,
  SubjectType,
} from './documents.types';

export const DOCUMENT_ASSIGNMENTS_TABLE = 'document_assignments';
export const DOCUMENT_ASSIGNMENT_COLUMNS =
  'id, template_id, subject_type, subject_id, season, class_id, status, assigned_at, ' +
  'viewed_at, completed_at, due_at, reminder_sent_at, signer_name, signer_email, ' +
  'signer_ip, signer_user_agent, consent_at, template_sha256, signed_key, ' +
  'signed_sha256, field_values, inserted_at, updated_at, ' +
  'template:document_templates(id, kind, audience, title_en, title_zh, ' +
  'description_en, description_zh, required, status, sort_order)';

export const SUBJECT_ID_CHUNK = 100;
const OPEN_STATUSES = ['assigned', 'viewed'];

export type DocumentAssignmentWrite = Partial<
  Omit<DocumentAssignmentRow, 'id' | 'template' | 'inserted_at' | 'updated_at'>
>;

/** Data access for `document_assignments` (rows come with their template embedded). */
export abstract class DocumentAssignmentsRepository {
  /** All of a subject's assignments, newest first. */
  abstract listForSubject(
    subjectType: SubjectType,
    subjectId: string,
  ): Promise<DocumentAssignmentRow[]>;
  abstract findById(id: string): Promise<DocumentAssignmentRow | null>;
  /** Which of `subjectIds` already hold a non-archived assignment of the template for the season. */
  abstract findOpenSubjectIds(
    templateId: string,
    season: string,
    subjectType: SubjectType,
    subjectIds: string[],
  ): Promise<Set<string>>;
  /** Inserts rows in one statement; throws on any conflict. */
  abstract insertMany(rows: NewAssignmentRow[]): Promise<number>;
  /** Inserts one row; `false` when an open assignment already exists. */
  abstract insertIfAbsent(row: NewAssignmentRow): Promise<boolean>;
  abstract update(
    id: string,
    patch: DocumentAssignmentWrite,
  ): Promise<DocumentAssignmentRow | null>;
  /** Updates the row only while its status is one of `statuses`; null otherwise. */
  abstract updateIfStatus(
    id: string,
    statuses: AssignmentStatus[],
    patch: DocumentAssignmentWrite,
  ): Promise<DocumentAssignmentRow | null>;
  /** Whether any assignment of the template is `completed`. */
  abstract hasCompleted(templateId: string): Promise<boolean>;
  /**
   * Open (`assigned` or `viewed`) assignments of a subject type that were
   * assigned before `cutoff` and not reminded since it, oldest first.
   */
  abstract listDueForReminder(
    subjectType: SubjectType,
    cutoff: Date,
  ): Promise<DocumentAssignmentRow[]>;
}

@Injectable()
export class SupabaseDocumentAssignmentsRepository extends DocumentAssignmentsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async listForSubject(
    subjectType: SubjectType,
    subjectId: string,
  ): Promise<DocumentAssignmentRow[]> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_ASSIGNMENTS_TABLE)
      .select(DOCUMENT_ASSIGNMENT_COLUMNS)
      .eq('subject_type', subjectType)
      .eq('subject_id', subjectId)
      .order('assigned_at', { ascending: false })) as DbResult<
      DocumentAssignmentRow[]
    >;
    check(error, 'list document assignments');
    return data ?? [];
  }

  async findById(id: string): Promise<DocumentAssignmentRow | null> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_ASSIGNMENTS_TABLE)
      .select(DOCUMENT_ASSIGNMENT_COLUMNS)
      .eq('id', id)
      .maybeSingle()) as DbResult<DocumentAssignmentRow>;
    check(error, 'load document assignment');
    return data ?? null;
  }

  async findOpenSubjectIds(
    templateId: string,
    season: string,
    subjectType: SubjectType,
    subjectIds: string[],
  ): Promise<Set<string>> {
    const open = new Set<string>();
    for (let i = 0; i < subjectIds.length; i += SUBJECT_ID_CHUNK) {
      const { data, error } = (await this.supabase
        .from(DOCUMENT_ASSIGNMENTS_TABLE)
        .select('subject_id')
        .eq('template_id', templateId)
        .eq('subject_type', subjectType)
        .eq('season', season)
        .not('status', 'eq', 'archived')
        .in(
          'subject_id',
          subjectIds.slice(i, i + SUBJECT_ID_CHUNK),
        )) as DbResult<{ subject_id: string }[]>;
      check(error, 'find open document assignments');
      for (const row of data ?? []) {
        open.add(row.subject_id);
      }
    }
    return open;
  }

  async insertMany(rows: NewAssignmentRow[]): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    const { error } = await this.supabase
      .from(DOCUMENT_ASSIGNMENTS_TABLE)
      .insert(rows);
    check(error, 'create document assignments');
    return rows.length;
  }

  async insertIfAbsent(row: NewAssignmentRow): Promise<boolean> {
    try {
      await this.insertMany([row]);
      return true;
    } catch (err) {
      if (hasCode(err, PG_UNIQUE_VIOLATION)) {
        return false;
      }
      throw err;
    }
  }

  async update(
    id: string,
    patch: DocumentAssignmentWrite,
  ): Promise<DocumentAssignmentRow | null> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_ASSIGNMENTS_TABLE)
      .update(patch)
      .eq('id', id)
      .select(DOCUMENT_ASSIGNMENT_COLUMNS)
      .maybeSingle()) as DbResult<DocumentAssignmentRow>;
    check(error, 'update document assignment');
    return data ?? null;
  }

  async updateIfStatus(
    id: string,
    statuses: AssignmentStatus[],
    patch: DocumentAssignmentWrite,
  ): Promise<DocumentAssignmentRow | null> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_ASSIGNMENTS_TABLE)
      .update(patch)
      .eq('id', id)
      .in('status', statuses)
      .select(DOCUMENT_ASSIGNMENT_COLUMNS)
      .maybeSingle()) as DbResult<DocumentAssignmentRow>;
    check(error, 'update document assignment');
    return data ?? null;
  }

  async hasCompleted(templateId: string): Promise<boolean> {
    const { data, error } = (await this.supabase
      .from(DOCUMENT_ASSIGNMENTS_TABLE)
      .select('id')
      .eq('template_id', templateId)
      .eq('status', 'completed')
      .limit(1)) as DbResult<{ id: string }[]>;
    check(error, 'check completed document assignments');
    return (data ?? []).length > 0;
  }

  async listDueForReminder(
    subjectType: SubjectType,
    cutoff: Date,
  ): Promise<DocumentAssignmentRow[]> {
    const at = cutoff.toISOString();
    const { data, error } = (await this.supabase
      .from(DOCUMENT_ASSIGNMENTS_TABLE)
      .select(DOCUMENT_ASSIGNMENT_COLUMNS)
      .eq('subject_type', subjectType)
      .in('status', OPEN_STATUSES)
      .lt('assigned_at', at)
      .or(`reminder_sent_at.is.null,reminder_sent_at.lt.${at}`)
      .order('assigned_at', { ascending: true })) as DbResult<
      DocumentAssignmentRow[]
    >;
    check(error, 'list document assignments due for a reminder');
    return data ?? [];
  }
}
