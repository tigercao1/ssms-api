import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type { InstructorHandleSource } from './lesson-title.parser';
import type {
  LessonProductRow,
  LessonProductStatus,
  LessonType,
} from './lessons.types';

export const LESSON_PRODUCTS_TABLE = 'lesson_products';
export const LESSON_PRODUCT_COLUMNS =
  'id, shopify_product_id, shopify_variant_id, product_title, variant_title, lesson_type, group_size, sessions, duration_min, priced_per_student, instructor_id, status, price, currency, created_at, updated_at';

export interface LessonProductSyncRow {
  shopify_product_id: number;
  shopify_variant_id: number;
  product_title: string;
  variant_title: string | null;
  lesson_type: LessonType;
  group_size: number | null;
  sessions: number | null;
  duration_min: number | null;
  priced_per_student: boolean;
  instructor_id: string | null;
  price: string | null;
  currency: string | null;
}

export interface LessonProductSyncCounts {
  inserted: number;
  updated: number;
}

export interface LessonProductPatch {
  lesson_type?: LessonType;
  group_size?: number | null;
  sessions?: number | null;
  duration_min?: number | null;
  priced_per_student?: boolean;
  instructor_id?: string | null;
  status?: LessonProductStatus;
}

export abstract class LessonProductsRepository {
  abstract instructorHandleSources(): Promise<InstructorHandleSource[]>;
  abstract instructorExists(id: string): Promise<boolean>;
  abstract sync(rows: LessonProductSyncRow[]): Promise<LessonProductSyncCounts>;
  abstract list(status?: LessonProductStatus): Promise<LessonProductRow[]>;
  abstract findById(id: string): Promise<LessonProductRow | null>;
  abstract update(
    id: string,
    expectedUpdatedAt: string,
    patch: LessonProductPatch,
  ): Promise<LessonProductRow | null>;
}

interface DbError {
  message: string;
  code?: string;
}

@Injectable()
export class SupabaseLessonProductsRepository extends LessonProductsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async instructorHandleSources(): Promise<InstructorHandleSource[]> {
    const [instructors, states] = await Promise.all([
      this.supabase
        .from('instructors')
        .select('id, display_name_en') as unknown as Promise<{
        data: { id: string; display_name_en: string }[] | null;
        error: DbError | null;
      }>,
      this.supabase
        .from('instructor_shopify_state')
        .select('instructor_id, shopify_handle') as unknown as Promise<{
        data: { instructor_id: string; shopify_handle: string | null }[] | null;
        error: DbError | null;
      }>,
    ]);
    check(instructors.error, 'load instructors');
    check(states.error, 'load instructor Shopify handles');
    const handles = new Map(
      (states.data ?? []).map((s) => [s.instructor_id, s.shopify_handle]),
    );
    return (instructors.data ?? []).map((i) => ({
      id: i.id,
      displayNameEn: i.display_name_en,
      shopifyHandle: handles.get(i.id) ?? null,
    }));
  }

  async instructorExists(id: string): Promise<boolean> {
    const { data, error } = (await this.supabase
      .from('instructors')
      .select('id')
      .eq('id', id)
      .maybeSingle()) as { data: { id: string } | null; error: DbError | null };
    check(error, 'load instructor');
    return data !== null;
  }

  async sync(rows: LessonProductSyncRow[]): Promise<LessonProductSyncCounts> {
    const { data, error } = (await this.supabase.rpc('sync_lesson_products', {
      p_rows: rows,
    })) as {
      data: LessonProductSyncCounts[] | LessonProductSyncCounts | null;
      error: DbError | null;
    };
    check(error, 'sync lesson products');
    const counts = Array.isArray(data) ? data[0] : data;
    return {
      inserted: counts?.inserted ?? 0,
      updated: counts?.updated ?? 0,
    };
  }

  async list(status?: LessonProductStatus): Promise<LessonProductRow[]> {
    let query = this.supabase
      .from(LESSON_PRODUCTS_TABLE)
      .select(LESSON_PRODUCT_COLUMNS);
    if (status) {
      query = query.eq('status', status);
    }
    const { data, error } = (await query
      .order('product_title', { ascending: true })
      .order('shopify_product_id', { ascending: true })
      .order('shopify_variant_id', { ascending: true })) as {
      data: LessonProductRow[] | null;
      error: DbError | null;
    };
    check(error, 'list lesson products');
    return data ?? [];
  }

  async findById(id: string): Promise<LessonProductRow | null> {
    const { data, error } = (await this.supabase
      .from(LESSON_PRODUCTS_TABLE)
      .select(LESSON_PRODUCT_COLUMNS)
      .eq('id', id)
      .maybeSingle()) as {
      data: LessonProductRow | null;
      error: DbError | null;
    };
    check(error, 'load lesson product');
    return data ?? null;
  }

  async update(
    id: string,
    expectedUpdatedAt: string,
    patch: LessonProductPatch,
  ): Promise<LessonProductRow | null> {
    const { data, error } = (await this.supabase
      .from(LESSON_PRODUCTS_TABLE)
      .update(patch)
      .eq('id', id)
      .eq('updated_at', expectedUpdatedAt)
      .select(LESSON_PRODUCT_COLUMNS)) as {
      data: LessonProductRow[] | null;
      error: DbError | null;
    };
    check(error, 'update lesson product');
    return data?.[0] ?? null;
  }
}

export function check(error: DbError | null, action: string): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}
