import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import {
  CertificationRow,
  InstructorProfilePatch,
  InstructorRow,
  ReferenceRow,
  TrainerStatusRow,
} from './instructors.types';

/** Postgres unique-violation; surfaced when two first-calls race the insert. */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Data-access boundary for the Instructors module. Declared as an abstract
 * class so it doubles as a DI token and lets unit tests bind an in-memory fake
 * (TESTING_STRATEGY.md § Mocking pattern — repository fakes preferred).
 */
export abstract class InstructorsRepository {
  abstract findByAuthUserId(authUserId: string): Promise<InstructorRow | null>;
  abstract findById(id: string): Promise<InstructorRow | null>;
  /** Insert a fresh `pending` row. Returns null on unique-violation (race). */
  abstract insertPending(
    authUserId: string,
    email: string,
  ): Promise<InstructorRow | null>;
  abstract getTeachingLocations(instructorId: string): Promise<ReferenceRow[]>;
  abstract getLanguages(instructorId: string): Promise<ReferenceRow[]>;
  abstract getCourseLevels(instructorId: string): Promise<ReferenceRow[]>;
  abstract getCertifications(instructorId: string): Promise<CertificationRow[]>;
  abstract getTrainerStatus(instructorId: string): Promise<TrainerStatusRow[]>;
  /** Apply the whole patch in a single DB transaction (T3.4 RPC). */
  abstract applyProfilePatch(
    instructorId: string,
    patch: InstructorProfilePatch,
  ): Promise<void>;
}

const INSTRUCTOR_COLUMNS =
  'id, auth_user_id, email, display_name_en, display_name_zh, bio_en, bio_zh, ' +
  'bio_en_machine_translated, bio_zh_machine_translated, date_of_birth, ' +
  'profile_photo_url, preferred_language, approval_status, is_active, ' +
  'inserted_at, updated_at';

@Injectable()
export class SupabaseInstructorsRepository extends InstructorsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async findByAuthUserId(authUserId: string): Promise<InstructorRow | null> {
    const { data, error } = await this.supabase
      .from('instructors')
      .select(INSTRUCTOR_COLUMNS)
      .eq('auth_user_id', authUserId)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load instructor: ${error.message}`,
      );
    }
    return (data as unknown as InstructorRow | null) ?? null;
  }

  async findById(id: string): Promise<InstructorRow | null> {
    const { data, error } = await this.supabase
      .from('instructors')
      .select(INSTRUCTOR_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load instructor: ${error.message}`,
      );
    }
    return (data as unknown as InstructorRow | null) ?? null;
  }

  async insertPending(
    authUserId: string,
    email: string,
  ): Promise<InstructorRow | null> {
    const { data, error } = await this.supabase
      .from('instructors')
      .insert({ auth_user_id: authUserId, email })
      .select(INSTRUCTOR_COLUMNS)
      .single();
    if (error) {
      // Concurrent first-call already inserted the row — caller re-reads it.
      if (error.code === PG_UNIQUE_VIOLATION) {
        return null;
      }
      throw new InternalServerErrorException(
        `Failed to create instructor: ${error.message}`,
      );
    }
    return data as unknown as InstructorRow;
  }

  private async fetchRefs(
    junction: string,
    fkColumn: string,
    refTable: string,
    instructorId: string,
  ): Promise<ReferenceRow[]> {
    const { data, error } = await this.supabase
      .from(junction)
      .select(`${refTable}:${fkColumn} ( id, key, name, sort_order )`)
      .eq('instructor_id', instructorId);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load ${refTable}: ${error.message}`,
      );
    }
    const rows = (data ?? []) as unknown as Array<
      Record<
        string,
        { id: string; key: string; name: string; sort_order: number } | null
      >
    >;
    return rows
      .map((r) => r[refTable])
      .filter(
        (
          r,
        ): r is { id: string; key: string; name: string; sort_order: number } =>
          r != null,
      )
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(({ id, key, name }) => ({ id, key, name }));
  }

  getTeachingLocations(instructorId: string): Promise<ReferenceRow[]> {
    return this.fetchRefs(
      'instructors_teaching_locations',
      'teaching_location_id',
      'teaching_locations',
      instructorId,
    );
  }

  getLanguages(instructorId: string): Promise<ReferenceRow[]> {
    return this.fetchRefs(
      'instructors_languages',
      'language_id',
      'languages',
      instructorId,
    );
  }

  getCourseLevels(instructorId: string): Promise<ReferenceRow[]> {
    return this.fetchRefs(
      'instructors_course_levels_offered',
      'course_level_offered_id',
      'course_levels_offered',
      instructorId,
    );
  }

  async getCertifications(instructorId: string): Promise<CertificationRow[]> {
    const { data, error } = await this.supabase
      .from('instructor_certifications')
      .select('org, track, level, is_partial, partial_components, achieved_on')
      .eq('instructor_id', instructorId);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load certifications: ${error.message}`,
      );
    }
    return data ?? [];
  }

  async getTrainerStatus(instructorId: string): Promise<TrainerStatusRow[]> {
    const { data, error } = await this.supabase
      .from('instructor_trainer_status')
      .select(
        'discipline, rookie_session_completed, trainer_exam_passed, trainer_level',
      )
      .eq('instructor_id', instructorId);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load trainer status: ${error.message}`,
      );
    }
    return data ?? [];
  }

  async applyProfilePatch(
    instructorId: string,
    patch: InstructorProfilePatch,
  ): Promise<void> {
    // Single-transaction update + relation replacement (T3.4 migration 210).
    const { error } = await this.supabase.rpc('update_instructor_profile', {
      p_instructor_id: instructorId,
      p_patch: patch,
    });
    if (error) {
      throw error;
    }
  }
}
