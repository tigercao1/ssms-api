import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  check,
  type DbResult,
  hasCode,
  PG_UNIQUE_VIOLATION,
} from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

export const INSTRUCTOR_CALENDARS_TABLE = 'instructor_calendars';
const COLUMNS =
  'instructor_id, google_calendar_id, calendar_summary, match_status, updated_at';
const INSTRUCTOR_COLUMNS =
  'id, email, display_name_en, display_name_zh, approval_status, is_active';

export type CalendarMatchStatus = 'suggested' | 'confirmed';

export interface InstructorCalendarRow {
  instructor_id: string;
  google_calendar_id: string;
  calendar_summary: string | null;
  match_status: CalendarMatchStatus;
  updated_at: string;
}

export interface InstructorCalendarInput {
  google_calendar_id: string;
  calendar_summary: string | null;
  match_status: CalendarMatchStatus;
}

export interface CalendarInstructorRow {
  id: string;
  email: string | null;
  display_name_en: string;
  display_name_zh: string | null;
  approval_status: string;
  is_active: boolean;
}

export abstract class InstructorCalendarsRepository {
  abstract instructorExists(id: string): Promise<boolean>;
  abstract listInstructors(): Promise<CalendarInstructorRow[]>;
  abstract list(): Promise<InstructorCalendarRow[]>;
  abstract find(instructorId: string): Promise<InstructorCalendarRow | null>;
  abstract upsert(
    instructorId: string,
    input: InstructorCalendarInput,
    userId: string | null,
  ): Promise<InstructorCalendarRow>;
  abstract insertIfAbsent(
    instructorId: string,
    input: InstructorCalendarInput,
    userId: string | null,
  ): Promise<boolean>;
  abstract remove(instructorId: string): Promise<void>;
}

@Injectable()
export class SupabaseInstructorCalendarsRepository extends InstructorCalendarsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async instructorExists(id: string): Promise<boolean> {
    const { data, error } = (await this.supabase
      .from('instructors')
      .select('id')
      .eq('id', id)
      .maybeSingle()) as DbResult<{ id: string }>;
    check(error, 'load instructor');
    return data !== null;
  }

  async listInstructors(): Promise<CalendarInstructorRow[]> {
    const { data, error } = (await this.supabase
      .from('instructors')
      .select(INSTRUCTOR_COLUMNS)
      .order('display_name_en', { ascending: true })
      .order('id', { ascending: true })) as DbResult<CalendarInstructorRow[]>;
    check(error, 'list instructors');
    return data ?? [];
  }

  async list(): Promise<InstructorCalendarRow[]> {
    const { data, error } = (await this.supabase
      .from(INSTRUCTOR_CALENDARS_TABLE)
      .select(COLUMNS)) as DbResult<InstructorCalendarRow[]>;
    check(error, 'list instructor calendars');
    return data ?? [];
  }

  async find(instructorId: string): Promise<InstructorCalendarRow | null> {
    const { data, error } = (await this.supabase
      .from(INSTRUCTOR_CALENDARS_TABLE)
      .select(COLUMNS)
      .eq('instructor_id', instructorId)
      .maybeSingle()) as DbResult<InstructorCalendarRow>;
    check(error, 'load instructor calendar');
    return data ?? null;
  }

  async upsert(
    instructorId: string,
    input: InstructorCalendarInput,
    userId: string | null,
  ): Promise<InstructorCalendarRow> {
    const { data, error } = (await this.supabase
      .from(INSTRUCTOR_CALENDARS_TABLE)
      .upsert(
        { instructor_id: instructorId, ...input, updated_by: userId },
        { onConflict: 'instructor_id' },
      )
      .select(COLUMNS)
      .single()) as DbResult<InstructorCalendarRow>;
    check(error, 'save instructor calendar');
    if (!data) {
      throw new Error('Failed to save instructor calendar: no row returned');
    }
    return data;
  }

  async insertIfAbsent(
    instructorId: string,
    input: InstructorCalendarInput,
    userId: string | null,
  ): Promise<boolean> {
    const { data, error } = (await this.supabase
      .from(INSTRUCTOR_CALENDARS_TABLE)
      .upsert(
        { instructor_id: instructorId, ...input, updated_by: userId },
        { onConflict: 'instructor_id', ignoreDuplicates: true },
      )
      .select('instructor_id')) as DbResult<{ instructor_id: string }[]>;
    try {
      check(error, 'suggest instructor calendar');
    } catch (err) {
      if (hasCode(err, PG_UNIQUE_VIOLATION)) {
        return false;
      }
      throw err;
    }
    return (data ?? []).length > 0;
  }

  async remove(instructorId: string): Promise<void> {
    const { error } = (await this.supabase
      .from(INSTRUCTOR_CALENDARS_TABLE)
      .delete()
      .eq('instructor_id', instructorId)) as DbResult<null>;
    check(error, 'clear instructor calendar');
  }
}
