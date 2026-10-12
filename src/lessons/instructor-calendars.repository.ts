import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { check } from './lesson-products.repository';

export const INSTRUCTOR_CALENDARS_TABLE = 'instructor_calendars';
const COLUMNS = 'instructor_id, google_calendar_id, updated_at';

export interface InstructorCalendarRow {
  instructor_id: string;
  google_calendar_id: string;
  updated_at: string;
}

export abstract class InstructorCalendarsRepository {
  abstract instructorExists(id: string): Promise<boolean>;
  abstract find(instructorId: string): Promise<InstructorCalendarRow | null>;
  abstract upsert(
    instructorId: string,
    googleCalendarId: string,
    userId: string | null,
  ): Promise<InstructorCalendarRow>;
  abstract remove(instructorId: string): Promise<void>;
}

type DbResult<T> = { data: T | null; error: { message: string } | null };

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
    googleCalendarId: string,
    userId: string | null,
  ): Promise<InstructorCalendarRow> {
    const { data, error } = (await this.supabase
      .from(INSTRUCTOR_CALENDARS_TABLE)
      .upsert(
        {
          instructor_id: instructorId,
          google_calendar_id: googleCalendarId,
          updated_by: userId,
        },
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

  async remove(instructorId: string): Promise<void> {
    const { error } = (await this.supabase
      .from(INSTRUCTOR_CALENDARS_TABLE)
      .delete()
      .eq('instructor_id', instructorId)) as DbResult<null>;
    check(error, 'clear instructor calendar');
  }
}
