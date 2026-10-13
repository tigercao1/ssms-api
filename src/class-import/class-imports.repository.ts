import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type {
  ClassImport,
  CommitCounts,
  ImportProblem,
  ImportStatus,
  ManualField,
  RowStatus,
} from './class-import.types';
import type {
  CalendarRef,
  CustomerMatch,
  InstructorRef,
} from './class-import-matching';

export const IMPORTS_TABLE = 'class_imports';
export const ROWS_TABLE = 'class_import_rows';
export const EVENT_MAP_TABLE = 'class_import_event_map';
export const IMPORT_COLUMNS =
  'id, filename, uploaded_by, status, counts, committed_by, committed_at, created_at, updated_at';
export const ROW_COLUMNS =
  'import_id, row_no, external_id, raw, event_name, instructor_name, instructor_id, lesson_type_id, customer_id, starts_at, ends_at, status_to_set, problems, manual_fields, class_id';
export const PAGE_SIZE = 1000;
export const ID_CHUNK = 200;
export const MAX_IMPORTS_LISTED = 20;

export interface ImportRecord {
  id: string;
  filename: string;
  uploaded_by: string | null;
  status: ImportStatus;
  counts: ClassImport['counts'];
  committed_by: string | null;
  committed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportRowRecord {
  import_id: string;
  row_no: number;
  external_id: string;
  raw: Record<string, unknown>;
  event_name: string | null;
  instructor_name: string | null;
  instructor_id: string | null;
  lesson_type_id: string | null;
  customer_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  status_to_set: RowStatus | null;
  problems: ImportProblem[];
  manual_fields: ManualField[];
  class_id: string | null;
}

export interface EventMapRecord {
  event_name: string;
  lesson_type_id: string;
}

export interface CustomerNameRecord {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

export type LookupTable = 'instructors' | 'lesson_types' | 'customers';

export abstract class ClassImportsRepository {
  abstract listImports(limit: number): Promise<ImportRecord[]>;
  abstract getImport(id: string): Promise<ImportRecord | null>;
  abstract createImport(input: {
    filename: string;
    uploaded_by: string | null;
    counts: ClassImport['counts'];
  }): Promise<ImportRecord>;
  abstract deleteImport(id: string): Promise<void>;
  abstract updateCounts(
    id: string,
    counts: Record<string, unknown>,
  ): Promise<void>;
  abstract discardDraft(id: string): Promise<ImportRecord | null>;
  abstract draftIds(): Promise<string[]>;
  abstract listRows(importId: string): Promise<ImportRowRecord[]>;
  abstract saveRows(rows: ImportRowRecord[]): Promise<void>;
  abstract instructors(): Promise<InstructorRef[]>;
  abstract calendars(): Promise<CalendarRef[]>;
  abstract eventMap(): Promise<EventMapRecord[]>;
  abstract saveEventMap(
    upserts: EventMapRecord[],
    removals: string[],
    actorId: string | null,
  ): Promise<void>;
  abstract findCustomers(
    emails: string[],
    phones: string[],
  ): Promise<CustomerMatch[]>;
  abstract customerNames(ids: string[]): Promise<CustomerNameRecord[]>;
  abstract importedExternalIds(ids: string[]): Promise<string[]>;
  abstract existingIds(table: LookupTable, ids: string[]): Promise<string[]>;
  abstract commit(id: string, actorId: string | null): Promise<CommitCounts>;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

@Injectable()
export class SupabaseClassImportsRepository extends ClassImportsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async listImports(limit: number): Promise<ImportRecord[]> {
    const { data, error } = (await this.supabase
      .from(IMPORTS_TABLE)
      .select(IMPORT_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(limit)) as DbResult<ImportRecord[]>;
    check(error, 'list class imports');
    return data ?? [];
  }

  async getImport(id: string): Promise<ImportRecord | null> {
    const { data, error } = (await this.supabase
      .from(IMPORTS_TABLE)
      .select(IMPORT_COLUMNS)
      .eq('id', id)
      .maybeSingle()) as DbResult<ImportRecord>;
    check(error, 'load class import');
    return data;
  }

  async createImport(input: {
    filename: string;
    uploaded_by: string | null;
    counts: ClassImport['counts'];
  }): Promise<ImportRecord> {
    const { data, error } = (await this.supabase
      .from(IMPORTS_TABLE)
      .insert(input)
      .select(IMPORT_COLUMNS)
      .single()) as DbResult<ImportRecord>;
    check(error, 'create class import');
    return data as ImportRecord;
  }

  async deleteImport(id: string): Promise<void> {
    const { error } = await this.supabase
      .from(IMPORTS_TABLE)
      .delete()
      .eq('id', id);
    check(error, 'delete class import');
  }

  async updateCounts(id: string, counts: ClassImport['counts']): Promise<void> {
    const { error } = await this.supabase
      .from(IMPORTS_TABLE)
      .update({ counts })
      .eq('id', id);
    check(error, 'update class import counts');
  }

  async discardDraft(id: string): Promise<ImportRecord | null> {
    const { data, error } = (await this.supabase
      .from(IMPORTS_TABLE)
      .update({ status: 'discarded' })
      .eq('id', id)
      .eq('status', 'draft')
      .select(IMPORT_COLUMNS)
      .maybeSingle()) as DbResult<ImportRecord>;
    check(error, 'discard class import');
    return data;
  }

  async draftIds(): Promise<string[]> {
    const { data, error } = (await this.supabase
      .from(IMPORTS_TABLE)
      .select('id')
      .eq('status', 'draft')) as DbResult<{ id: string }[]>;
    check(error, 'list draft class imports');
    return (data ?? []).map((r) => r.id);
  }

  async listRows(importId: string): Promise<ImportRowRecord[]> {
    const rows: ImportRowRecord[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = (await this.supabase
        .from(ROWS_TABLE)
        .select(ROW_COLUMNS)
        .eq('import_id', importId)
        .order('row_no', { ascending: true })
        .range(from, from + PAGE_SIZE - 1)) as DbResult<ImportRowRecord[]>;
      check(error, 'list class import rows');
      rows.push(...(data ?? []));
      if ((data ?? []).length < PAGE_SIZE) {
        return rows;
      }
    }
  }

  async saveRows(rows: ImportRowRecord[]): Promise<void> {
    for (const chunk of chunks(rows, PAGE_SIZE)) {
      const { error } = await this.supabase
        .from(ROWS_TABLE)
        .upsert(chunk, { onConflict: 'import_id,row_no' });
      check(error, 'save class import rows');
    }
  }

  async instructors(): Promise<InstructorRef[]> {
    const { data, error } = (await this.supabase
      .from('instructors')
      .select('id, display_name_en, display_name_zh')) as DbResult<
      { id: string; display_name_en: string; display_name_zh: string | null }[]
    >;
    check(error, 'list instructors');
    return (data ?? []).map((r) => ({
      id: r.id,
      displayNameEn: r.display_name_en,
      displayNameZh: r.display_name_zh,
    }));
  }

  async calendars(): Promise<CalendarRef[]> {
    const { data, error } = (await this.supabase
      .from('instructor_calendars')
      .select('instructor_id, calendar_summary')) as DbResult<
      { instructor_id: string; calendar_summary: string | null }[]
    >;
    check(error, 'list instructor calendars');
    return (data ?? []).map((r) => ({
      instructorId: r.instructor_id,
      summary: r.calendar_summary,
    }));
  }

  async eventMap(): Promise<EventMapRecord[]> {
    const { data, error } = (await this.supabase
      .from(EVENT_MAP_TABLE)
      .select('event_name, lesson_type_id')
      .order('event_name', { ascending: true })) as DbResult<EventMapRecord[]>;
    check(error, 'list class import event map');
    return data ?? [];
  }

  async saveEventMap(
    upserts: EventMapRecord[],
    removals: string[],
    actorId: string | null,
  ): Promise<void> {
    if (upserts.length > 0) {
      const { error } = await this.supabase.from(EVENT_MAP_TABLE).upsert(
        upserts.map((u) => ({ ...u, updated_by: actorId })),
        { onConflict: 'event_name' },
      );
      check(error, 'save class import event map');
    }
    if (removals.length > 0) {
      const { error } = await this.supabase
        .from(EVENT_MAP_TABLE)
        .delete()
        .in('event_name', removals);
      check(error, 'remove class import event map entries');
    }
  }

  async findCustomers(
    emails: string[],
    phones: string[],
  ): Promise<CustomerMatch[]> {
    if (emails.length === 0 && phones.length === 0) {
      return [];
    }
    const { data, error } = (await this.supabase.rpc(
      'class_import_customer_matches',
      { p_emails: emails, p_phones: phones },
    )) as DbResult<
      { id: string; email_key: string | null; phone_key: string | null }[]
    >;
    check(error, 'match import customers');
    return (data ?? []).map((r) => ({
      id: r.id,
      emailKey: r.email_key,
      phoneKey: r.phone_key || null,
    }));
  }

  async customerNames(ids: string[]): Promise<CustomerNameRecord[]> {
    const out: CustomerNameRecord[] = [];
    for (const chunk of chunks([...new Set(ids)], ID_CHUNK)) {
      const { data, error } = (await this.supabase
        .from('customers')
        .select('id, first_name, last_name')
        .in('id', chunk)) as DbResult<CustomerNameRecord[]>;
      check(error, 'load import customers');
      out.push(...(data ?? []));
    }
    return out;
  }

  async importedExternalIds(ids: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const chunk of chunks([...new Set(ids)], ID_CHUNK)) {
      const { data, error } = (await this.supabase
        .from('classes')
        .select('import_external_id')
        .in('import_external_id', chunk)) as DbResult<
        { import_external_id: string }[]
      >;
      check(error, 'check imported classes');
      out.push(...(data ?? []).map((r) => r.import_external_id));
    }
    return out;
  }

  async existingIds(table: LookupTable, ids: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const chunk of chunks([...new Set(ids)], ID_CHUNK)) {
      const { data, error } = (await this.supabase
        .from(table)
        .select('id')
        .in('id', chunk)) as DbResult<{ id: string }[]>;
      check(error, `check ${table}`);
      out.push(...(data ?? []).map((r) => r.id));
    }
    return out;
  }

  async commit(id: string, actorId: string | null): Promise<CommitCounts> {
    const { data, error } = (await this.supabase.rpc('commit_class_import', {
      p_import_id: id,
      p_actor: actorId,
    })) as DbResult<CommitCounts>;
    check(error, 'commit class import');
    return data as CommitCounts;
  }
}
