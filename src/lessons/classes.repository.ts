import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { check } from './lesson-products.repository';
import type { Attendance, ClassSource, ClassStatus } from './lessons.types';

export const CLASSES_TABLE = 'classes';
export const MAX_CLASSES_PER_LIST = 1000;
export const CLASS_COLUMNS = [
  'id, instructor_id, lesson_product_id, location_id, starts_at, ends_at, status, source, google_calendar_id, google_event_id, notes, created_at, updated_at',
  'instructor:instructors(display_name_en, display_name_zh)',
  'location:teaching_locations(name)',
  'lesson_product:lesson_products(product_title, variant_title)',
  'participants:class_participants(customer_id, purchase_id, attendance, customer:customers(name, email, phone, wechat_id))',
].join(', ');

export interface ClassParticipantRow {
  customer_id: string;
  purchase_id: string | null;
  attendance: Attendance;
  customer: {
    name: string | null;
    email: string | null;
    phone: string | null;
    wechat_id: string | null;
  } | null;
}

export interface ClassRow {
  id: string;
  instructor_id: string;
  lesson_product_id: string | null;
  location_id: string | null;
  starts_at: string;
  ends_at: string;
  status: ClassStatus;
  source: ClassSource;
  google_calendar_id: string | null;
  google_event_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  instructor: {
    display_name_en: string;
    display_name_zh: string | null;
  } | null;
  location: { name: string } | null;
  lesson_product: {
    product_title: string;
    variant_title: string | null;
  } | null;
  participants: ClassParticipantRow[] | null;
}

export interface ClassFilter {
  from?: string;
  to?: string;
  instructorId?: string;
}

export abstract class ClassesRepository {
  abstract list(filter: ClassFilter): Promise<ClassRow[]>;
}

@Injectable()
export class SupabaseClassesRepository extends ClassesRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async list(filter: ClassFilter): Promise<ClassRow[]> {
    let query = this.supabase.from(CLASSES_TABLE).select(CLASS_COLUMNS);
    if (filter.from) {
      query = query.gte('starts_at', filter.from);
    }
    if (filter.to) {
      query = query.lt('starts_at', filter.to);
    }
    if (filter.instructorId) {
      query = query.eq('instructor_id', filter.instructorId);
    }
    const { data, error } = (await query
      .order('starts_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(MAX_CLASSES_PER_LIST)) as unknown as {
      data: ClassRow[] | null;
      error: { message: string } | null;
    };
    check(error, 'list classes');
    return data ?? [];
  }
}
