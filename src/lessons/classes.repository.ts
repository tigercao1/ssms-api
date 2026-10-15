import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { check } from '../database/db-result';
import {
  type CountedResult,
  type PageRequest,
  PGRST_RANGE_NOT_SATISFIABLE,
  type RowPage,
} from '../database/pagination';
import type {
  Attendance,
  ClassSource,
  ClassStatus,
  GoogleSyncStatus,
} from './lessons.types';

export const CLASSES_TABLE = 'classes';
export const MAX_CLASSES_PER_LIST = 1000;
export const CLASS_COLUMNS = [
  'id, instructor_id, lesson_type_id, location_id, starts_at, ends_at, status, source, google_calendar_id, google_event_id, google_event_seq, google_sync_status, google_sync_error, google_sync_attempts, google_synced_at, notes, created_at, updated_at',
  'instructor:instructors(display_name_en, display_name_zh)',
  'location:teaching_locations(name)',
  'lesson_type:lesson_types(name_en, name_zh, duration_min, group_size, is_promo)',
  'participants:class_participants(customer_id, attendance, customer:customers(first_name, last_name, email, phone))',
].join(', ');

export interface ClassParticipantRow {
  customer_id: string;
  attendance: Attendance;
  customer: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
  } | null;
}

export interface ClassRow {
  id: string;
  instructor_id: string;
  lesson_type_id: string | null;
  location_id: string | null;
  starts_at: string;
  ends_at: string;
  status: ClassStatus;
  source: ClassSource;
  google_calendar_id: string | null;
  google_event_id: string | null;
  google_event_seq: number;
  google_sync_status: GoogleSyncStatus;
  google_sync_error: string | null;
  google_sync_attempts: number;
  google_synced_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  instructor: {
    display_name_en: string;
    display_name_zh: string | null;
  } | null;
  location: { name: string } | null;
  lesson_type: {
    name_en: string;
    name_zh: string | null;
    duration_min: number;
    group_size: number | null;
    is_promo: boolean;
  } | null;
  participants: ClassParticipantRow[] | null;
}

export interface ClassFilter {
  from?: string;
  to?: string;
  instructorId?: string;
}

export abstract class ClassesRepository {
  abstract list(
    filter: ClassFilter,
    page?: PageRequest,
  ): Promise<RowPage<ClassRow>>;
}

@Injectable()
export class SupabaseClassesRepository extends ClassesRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async list(
    filter: ClassFilter,
    page?: PageRequest,
  ): Promise<RowPage<ClassRow>> {
    const ordered = this.matching(filter, CLASS_COLUMNS, { count: 'exact' })
      .order('starts_at', { ascending: true })
      .order('id', { ascending: true });
    const { data, error, count } = (await (page
      ? ordered.range(page.offset, page.offset + page.limit - 1)
      : ordered.limit(MAX_CLASSES_PER_LIST))) as CountedResult<ClassRow[]>;
    if (error?.code === PGRST_RANGE_NOT_SATISFIABLE) {
      return { rows: [], total: await this.count(filter) };
    }
    check(error, 'list classes');
    return { rows: data ?? [], total: count ?? 0 };
  }

  private async count(filter: ClassFilter): Promise<number> {
    const { error, count } = (await this.matching(filter, 'id', {
      count: 'exact',
      head: true,
    })) as CountedResult<null>;
    check(error, 'count classes');
    return count ?? 0;
  }

  private matching(
    filter: ClassFilter,
    columns: string,
    options: { count: 'exact'; head?: boolean },
  ) {
    let query = this.supabase.from(CLASSES_TABLE).select(columns, options);
    if (filter.from) {
      query = query.gte('starts_at', filter.from);
    }
    if (filter.to) {
      query = query.lt('starts_at', filter.to);
    }
    if (filter.instructorId) {
      query = query.eq('instructor_id', filter.instructorId);
    }
    return query;
  }
}
