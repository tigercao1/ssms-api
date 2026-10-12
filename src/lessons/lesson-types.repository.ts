import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

export const LESSON_TYPES_TABLE = 'lesson_types';
export const LESSON_TYPE_COLUMNS =
  'id, name_en, name_zh, group_size, duration_min, is_promo, active, sort_order, created_at, updated_at';

export interface LessonTypeRow {
  id: string;
  name_en: string;
  name_zh: string | null;
  group_size: number | null;
  duration_min: number;
  is_promo: boolean;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type LessonTypeWrite = Partial<
  Omit<LessonTypeRow, 'id' | 'created_at' | 'updated_at'>
>;

export abstract class LessonTypesRepository {
  abstract list(filter: { active?: boolean }): Promise<LessonTypeRow[]>;
  abstract findById(id: string): Promise<LessonTypeRow | null>;
  abstract insert(
    input: LessonTypeWrite & Pick<LessonTypeRow, 'name_en' | 'duration_min'>,
  ): Promise<LessonTypeRow>;
  abstract update(
    id: string,
    patch: LessonTypeWrite,
  ): Promise<LessonTypeRow | null>;
}

@Injectable()
export class SupabaseLessonTypesRepository extends LessonTypesRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async list(filter: { active?: boolean }): Promise<LessonTypeRow[]> {
    let query = this.supabase
      .from(LESSON_TYPES_TABLE)
      .select(LESSON_TYPE_COLUMNS);
    if (filter.active !== undefined) {
      query = query.eq('active', filter.active);
    }
    const { data, error } = (await query
      .order('sort_order', { ascending: true })
      .order('name_en', { ascending: true })) as DbResult<LessonTypeRow[]>;
    check(error, 'list lesson types');
    return data ?? [];
  }

  async findById(id: string): Promise<LessonTypeRow | null> {
    const { data, error } = (await this.supabase
      .from(LESSON_TYPES_TABLE)
      .select(LESSON_TYPE_COLUMNS)
      .eq('id', id)
      .maybeSingle()) as DbResult<LessonTypeRow>;
    check(error, 'load lesson type');
    return data ?? null;
  }

  async insert(
    input: LessonTypeWrite & Pick<LessonTypeRow, 'name_en' | 'duration_min'>,
  ): Promise<LessonTypeRow> {
    const { data, error } = (await this.supabase
      .from(LESSON_TYPES_TABLE)
      .insert(input)
      .select(LESSON_TYPE_COLUMNS)
      .single()) as DbResult<LessonTypeRow>;
    check(error, 'create lesson type');
    if (!data) {
      throw new Error('Failed to create lesson type: no row returned');
    }
    return data;
  }

  async update(
    id: string,
    patch: LessonTypeWrite,
  ): Promise<LessonTypeRow | null> {
    const { data, error } = (await this.supabase
      .from(LESSON_TYPES_TABLE)
      .update(patch)
      .eq('id', id)
      .select(LESSON_TYPE_COLUMNS)
      .maybeSingle()) as DbResult<LessonTypeRow>;
    check(error, 'update lesson type');
    return data ?? null;
  }
}
