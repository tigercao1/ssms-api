import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import {
  CLASS_COLUMNS,
  CLASSES_TABLE,
  type ClassRow,
} from '../lessons/classes.repository';
import type { ClassStatus } from '../lessons/lessons.types';

export const BOOKING_SETTINGS_TABLE = 'booking_settings';
const SETTINGS_COLUMNS =
  'day_start_time, day_end_time, slot_minutes, weekday_overrides, updated_at';
const INSTRUCTOR_COLUMNS =
  'id, display_name_en, display_name_zh, approval_status, is_active';

export interface BookingSettingsRow {
  day_start_time: string;
  day_end_time: string;
  slot_minutes: number;
  weekday_overrides: Record<string, unknown>;
  updated_at: string;
}

export interface BookingSettingsWrite {
  day_start_time: string;
  day_end_time: string;
  slot_minutes: number;
  weekday_overrides: Record<string, unknown>;
}

export interface BookingInstructorRow {
  id: string;
  display_name_en: string;
  display_name_zh: string | null;
  approval_status: string;
  is_active: boolean;
}

export interface CalendarLinkRow {
  instructor_id: string;
  google_calendar_id: string;
  match_status: 'suggested' | 'confirmed';
}

export interface BookingLessonTypeRow {
  id: string;
  name_en: string;
  name_zh: string | null;
  duration_min: number;
  active: boolean;
}

export interface BookingCustomerRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
}

export interface BookingLocationRow {
  id: string;
  name: string;
}

export interface BusyClassRow {
  id: string;
  instructor_id: string;
  starts_at: string;
  ends_at: string;
}

export interface ClassBooking {
  id: string;
  instructor_id: string;
  lesson_type_id: string;
  location_id: string | null;
  starts_at: string;
  ends_at: string;
  status: ClassStatus;
  google_calendar_id: string | null;
  google_event_id: string | null;
  notes: string | null;
  created_by: string | null;
  customer_ids: string[];
}

export interface SeriesBooking {
  id: string;
  count: number;
  created_by: string | null;
}

export interface ClassRebooking {
  instructor_id: string;
  lesson_type_id: string | null;
  starts_at: string;
  ends_at: string;
  google_calendar_id: string | null;
  google_event_id: string | null;
  notes: string | null;
}

export abstract class BookingRepository {
  abstract getSettings(): Promise<BookingSettingsRow>;
  abstract saveSettings(
    write: BookingSettingsWrite,
    userId: string | null,
  ): Promise<BookingSettingsRow>;
  abstract listInstructors(ids?: string[]): Promise<BookingInstructorRow[]>;
  abstract listCalendarLinks(
    instructorIds: string[],
  ): Promise<CalendarLinkRow[]>;
  abstract findLessonType(id: string): Promise<BookingLessonTypeRow | null>;
  abstract findCustomers(ids: string[]): Promise<BookingCustomerRow[]>;
  abstract findLocation(id: string): Promise<BookingLocationRow | null>;
  abstract findClasses(ids: string[]): Promise<ClassRow[]>;
  abstract busyClasses(
    instructorIds: string[],
    from: string,
    to: string,
  ): Promise<BusyClassRow[]>;
  abstract lastClassForCustomer(customerId: string): Promise<ClassRow | null>;
  abstract bookClasses(
    series: SeriesBooking | null,
    classes: ClassBooking[],
  ): Promise<void>;
  abstract rebookClass(
    id: string,
    rebooking: ClassRebooking,
    customerIds: string[] | null,
  ): Promise<void>;
  abstract setClassStatus(id: string, status: ClassStatus): Promise<void>;
}

@Injectable()
export class SupabaseBookingRepository extends BookingRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async getSettings(): Promise<BookingSettingsRow> {
    const { data, error } = (await this.supabase
      .from(BOOKING_SETTINGS_TABLE)
      .select(SETTINGS_COLUMNS)
      .eq('id', true)
      .maybeSingle()) as DbResult<BookingSettingsRow>;
    check(error, 'load booking settings');
    if (!data) {
      throw new Error('Booking settings row is missing');
    }
    return data;
  }

  async saveSettings(
    write: BookingSettingsWrite,
    userId: string | null,
  ): Promise<BookingSettingsRow> {
    const { data, error } = (await this.supabase
      .from(BOOKING_SETTINGS_TABLE)
      .update({ ...write, updated_by: userId })
      .eq('id', true)
      .select(SETTINGS_COLUMNS)
      .maybeSingle()) as DbResult<BookingSettingsRow>;
    check(error, 'save booking settings');
    if (!data) {
      throw new Error('Booking settings row is missing');
    }
    return data;
  }

  async listInstructors(ids?: string[]): Promise<BookingInstructorRow[]> {
    let query = this.supabase.from('instructors').select(INSTRUCTOR_COLUMNS);
    if (ids) {
      query = query.in('id', ids);
    } else {
      query = query.eq('is_active', true).eq('approval_status', 'approved');
    }
    const { data, error } = (await query
      .order('display_name_en', { ascending: true })
      .order('id', { ascending: true })) as DbResult<BookingInstructorRow[]>;
    check(error, 'list instructors');
    return data ?? [];
  }

  async listCalendarLinks(instructorIds: string[]): Promise<CalendarLinkRow[]> {
    if (instructorIds.length === 0) {
      return [];
    }
    const { data, error } = (await this.supabase
      .from('instructor_calendars')
      .select('instructor_id, google_calendar_id, match_status')
      .in('instructor_id', instructorIds)) as DbResult<CalendarLinkRow[]>;
    check(error, 'list instructor calendars');
    return data ?? [];
  }

  async findLessonType(id: string): Promise<BookingLessonTypeRow | null> {
    const { data, error } = (await this.supabase
      .from('lesson_types')
      .select('id, name_en, name_zh, duration_min, active')
      .eq('id', id)
      .maybeSingle()) as DbResult<BookingLessonTypeRow>;
    check(error, 'load lesson type');
    return data ?? null;
  }

  async findCustomers(ids: string[]): Promise<BookingCustomerRow[]> {
    if (ids.length === 0) {
      return [];
    }
    const { data, error } = (await this.supabase
      .from('customers')
      .select('id, first_name, last_name, phone')
      .in('id', ids)) as DbResult<BookingCustomerRow[]>;
    check(error, 'load customers');
    return data ?? [];
  }

  async findLocation(id: string): Promise<BookingLocationRow | null> {
    const { data, error } = (await this.supabase
      .from('teaching_locations')
      .select('id, name')
      .eq('id', id)
      .maybeSingle()) as DbResult<BookingLocationRow>;
    check(error, 'load location');
    return data ?? null;
  }

  async findClasses(ids: string[]): Promise<ClassRow[]> {
    if (ids.length === 0) {
      return [];
    }
    const { data, error } = (await this.supabase
      .from(CLASSES_TABLE)
      .select(CLASS_COLUMNS)
      .in('id', ids)
      .order('starts_at', { ascending: true })) as unknown as DbResult<
      ClassRow[]
    >;
    check(error, 'load classes');
    return data ?? [];
  }

  async busyClasses(
    instructorIds: string[],
    from: string,
    to: string,
  ): Promise<BusyClassRow[]> {
    if (instructorIds.length === 0) {
      return [];
    }
    const { data, error } = (await this.supabase
      .from(CLASSES_TABLE)
      .select('id, instructor_id, starts_at, ends_at')
      .in('instructor_id', instructorIds)
      .neq('status', 'cancelled')
      .lt('starts_at', to)
      .gt('ends_at', from)
      .order('starts_at', { ascending: true })) as DbResult<BusyClassRow[]>;
    check(error, 'list busy classes');
    return data ?? [];
  }

  async lastClassForCustomer(customerId: string): Promise<ClassRow | null> {
    const { data, error } = (await this.supabase
      .from(CLASSES_TABLE)
      .select(`${CLASS_COLUMNS}, matched:class_participants!inner(customer_id)`)
      .eq('matched.customer_id', customerId)
      .neq('status', 'cancelled')
      .order('starts_at', { ascending: false })
      .limit(1)) as unknown as DbResult<ClassRow[]>;
    check(error, 'load last class');
    return data?.[0] ?? null;
  }

  async bookClasses(
    series: SeriesBooking | null,
    classes: ClassBooking[],
  ): Promise<void> {
    const { error } = (await this.supabase.rpc('book_classes', {
      p_series: series,
      p_classes: classes,
    })) as DbResult<null>;
    check(error, 'book classes');
  }

  async rebookClass(
    id: string,
    rebooking: ClassRebooking,
    customerIds: string[] | null,
  ): Promise<void> {
    const { error } = (await this.supabase.rpc('rebook_class', {
      p_class_id: id,
      p_class: rebooking,
      p_customer_ids: customerIds,
    })) as DbResult<null>;
    check(error, 'move class');
  }

  async setClassStatus(id: string, status: ClassStatus): Promise<void> {
    const { error } = (await this.supabase.rpc('set_class_status', {
      p_class_id: id,
      p_status: status,
    })) as DbResult<null>;
    check(error, 'set class status');
  }
}
