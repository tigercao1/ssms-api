import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { check, likePattern, searchTokens } from '../database/db-result';
import {
  type CountedResult,
  type PageRequest,
  PGRST_RANGE_NOT_SATISFIABLE,
  type RowPage,
} from '../database/pagination';
import type {
  Attendance,
  ClassSort,
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
export const CLASS_SEARCH_EMBED =
  'search:class_participants(customer:customers!inner())';
const CLASS_ID_PREFIX = /^[0-9a-f-]+$/i;
const CLASS_ID_PREFIX_MIN_HEX = 4;
const UUID_HEX_LENGTH = 32;

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
  q?: string;
  statuses?: ClassStatus[];
  lessonTypeId?: string;
  locationId?: string;
  createdFrom?: string;
  createdTo?: string;
}

export abstract class ClassesRepository {
  abstract list(
    filter: ClassFilter,
    page?: PageRequest,
    sort?: ClassSort,
  ): Promise<RowPage<ClassRow>>;
}

function asUuid(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function classIdRange(
  q: string,
): { lowest: string; highest: string } | null {
  if (!CLASS_ID_PREFIX.test(q)) {
    return null;
  }
  const hex = q.replace(/-/g, '').toLowerCase();
  if (hex.length < CLASS_ID_PREFIX_MIN_HEX || hex.length > UUID_HEX_LENGTH) {
    return null;
  }
  return {
    lowest: asUuid(hex.padEnd(UUID_HEX_LENGTH, '0')),
    highest: asUuid(hex.padEnd(UUID_HEX_LENGTH, 'f')),
  };
}

function searchMatch(q: string): string {
  const range = classIdRange(q);
  return range
    ? `search.not.is.null,and(id.gte.${range.lowest},id.lte.${range.highest})`
    : 'search.not.is.null';
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
    sort: ClassSort = 'startsAt',
  ): Promise<RowPage<ClassRow>> {
    const ascending = sort === 'startsAt';
    const ordered = this.matching(filter, CLASS_COLUMNS, { count: 'exact' })
      .order(ascending ? 'starts_at' : 'created_at', { ascending })
      .order('id', { ascending });
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
    const tokens = searchTokens(filter.q);
    let query = this.supabase
      .from(CLASSES_TABLE)
      .select(
        tokens.length > 0 ? `${columns}, ${CLASS_SEARCH_EMBED}` : columns,
        options,
      );
    if (filter.from) {
      query = query.gte('starts_at', filter.from);
    }
    if (filter.to) {
      query = query.lt('starts_at', filter.to);
    }
    if (filter.instructorId) {
      query = query.eq('instructor_id', filter.instructorId);
    }
    if (filter.statuses?.length) {
      query = query.in('status', filter.statuses);
    }
    if (filter.lessonTypeId) {
      query = query.eq('lesson_type_id', filter.lessonTypeId);
    }
    if (filter.locationId) {
      query = query.eq('location_id', filter.locationId);
    }
    if (filter.createdFrom) {
      query = query.gte('created_at', filter.createdFrom);
    }
    if (filter.createdTo) {
      query = query.lt('created_at', filter.createdTo);
    }
    if (filter.q && tokens.length > 0) {
      for (const token of tokens) {
        query = query.ilike(
          'search.customer.search_text',
          likePattern(token.toLowerCase()),
        );
      }
      query = query.or(searchMatch(filter.q));
    }
    return query;
  }
}
