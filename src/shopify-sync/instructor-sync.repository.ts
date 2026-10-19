import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type {
  InstructorShopifyState,
  InstructorShopifyStatePatch,
  InstructorSnapshot,
  ReconcileCounts,
  SyncCertRow,
  SyncInstructorRow,
  SyncQueueRow,
  SyncRefName,
  SyncTrainerRow,
} from './instructor-sync.types';

const INSTRUCTOR_COLUMNS =
  'id, display_name_en, display_name_zh, bio_en, bio_zh, profile_photo_url, profile_photo_version, ' +
  'photo_2_url, photo_2_version, photo_3_url, photo_3_version, min_student_age, display_order, approval_status, is_active';

const STATE_TABLE = 'instructor_shopify_state';
const INSTRUCTOR_ID_CHUNK = 100;
const QUEUE_TABLE = 'instructor_sync_queue';

interface DbError {
  message: string;
}

interface RefJoin {
  name: string;
  name_zh: string | null;
  sort_order: number;
  is_active: boolean;
}

export abstract class InstructorSyncRepository {
  abstract loadSnapshot(
    instructorId: string,
  ): Promise<InstructorSnapshot | null>;
  abstract loadSnapshots(
    instructorIds: readonly string[],
  ): Promise<Map<string, InstructorSnapshot>>;
  abstract getState(
    instructorId: string,
  ): Promise<InstructorShopifyState | null>;
  abstract getStates(
    instructorIds: readonly string[],
  ): Promise<Map<string, InstructorShopifyState>>;
  abstract saveState(
    instructorId: string,
    patch: InstructorShopifyStatePatch,
  ): Promise<void>;
  abstract isHandleStoredByOther(
    handle: string,
    instructorId: string,
  ): Promise<boolean>;
  abstract claimQueueBatch(
    limit: number,
    maxAttempts: number,
  ): Promise<SyncQueueRow[]>;
  abstract completeQueueRow(row: SyncQueueRow): Promise<void>;
  abstract recordQueueFailure(row: SyncQueueRow, error: string): Promise<void>;
  abstract enqueueAll(): Promise<ReconcileCounts>;
  abstract createSignedPhotoUrl(
    bucket: string,
    path: string,
    expiresInSeconds: number,
  ): Promise<string>;
}

@Injectable()
export class SupabaseInstructorSyncRepository extends InstructorSyncRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async loadSnapshot(instructorId: string): Promise<InstructorSnapshot | null> {
    const { data, error } = (await this.supabase
      .from('instructors')
      .select(INSTRUCTOR_COLUMNS)
      .eq('id', instructorId)
      .maybeSingle()) as {
      data: SyncInstructorRow | null;
      error: DbError | null;
    };
    check(error, 'load instructor');
    if (!data) {
      return null;
    }
    const [
      locations,
      languages,
      courseLevels,
      examPreparations,
      certifications,
      trainers,
    ] = await Promise.all([
      this.refNames(
        instructorId,
        'instructors_teaching_locations',
        'teaching_location_id',
        'teaching_locations',
      ),
      this.refNames(
        instructorId,
        'instructors_languages',
        'language_id',
        'languages',
      ),
      this.refNames(
        instructorId,
        'instructors_course_levels_offered',
        'course_level_offered_id',
        'course_levels_offered',
      ),
      this.refNames(
        instructorId,
        'instructors_exam_preparations',
        'exam_preparation_id',
        'exam_preparations',
      ),
      this.rows<SyncCertRow>(
        'instructor_certifications',
        'org, track, level, is_partial',
        instructorId,
      ),
      this.rows<SyncTrainerRow>(
        'instructor_trainer_status',
        'discipline, trainer_level',
        instructorId,
      ),
    ]);
    return {
      instructor: data,
      locations,
      languages,
      courseLevels,
      examPreparations,
      certifications,
      trainers,
    };
  }

  async loadSnapshots(
    instructorIds: readonly string[],
  ): Promise<Map<string, InstructorSnapshot>> {
    const snapshots = new Map<string, InstructorSnapshot>();
    for (let i = 0; i < instructorIds.length; i += INSTRUCTOR_ID_CHUNK) {
      const ids = instructorIds.slice(i, i + INSTRUCTOR_ID_CHUNK);
      const { data, error } = (await this.supabase
        .from('instructors')
        .select(INSTRUCTOR_COLUMNS)
        .in('id', ids)) as {
        data: SyncInstructorRow[] | null;
        error: DbError | null;
      };
      check(error, 'load instructors');
      const [
        locations,
        languages,
        courseLevels,
        examPreparations,
        certifications,
        trainers,
      ] = await Promise.all([
        this.refNamesFor(
          ids,
          'instructors_teaching_locations',
          'teaching_location_id',
          'teaching_locations',
        ),
        this.refNamesFor(
          ids,
          'instructors_languages',
          'language_id',
          'languages',
        ),
        this.refNamesFor(
          ids,
          'instructors_course_levels_offered',
          'course_level_offered_id',
          'course_levels_offered',
        ),
        this.refNamesFor(
          ids,
          'instructors_exam_preparations',
          'exam_preparation_id',
          'exam_preparations',
        ),
        this.rowsFor<SyncCertRow>(
          'instructor_certifications',
          'org, track, level, is_partial',
          ids,
        ),
        this.rowsFor<SyncTrainerRow>(
          'instructor_trainer_status',
          'discipline, trainer_level',
          ids,
        ),
      ]);
      for (const instructor of data ?? []) {
        snapshots.set(instructor.id, {
          instructor,
          locations: locations.get(instructor.id) ?? [],
          languages: languages.get(instructor.id) ?? [],
          courseLevels: courseLevels.get(instructor.id) ?? [],
          examPreparations: examPreparations.get(instructor.id) ?? [],
          certifications: certifications.get(instructor.id) ?? [],
          trainers: trainers.get(instructor.id) ?? [],
        });
      }
    }
    return snapshots;
  }

  async getStates(
    instructorIds: readonly string[],
  ): Promise<Map<string, InstructorShopifyState>> {
    const states = new Map<string, InstructorShopifyState>();
    for (let i = 0; i < instructorIds.length; i += INSTRUCTOR_ID_CHUNK) {
      const { data, error } = (await this.supabase
        .from(STATE_TABLE)
        .select('*')
        .in(
          'instructor_id',
          instructorIds.slice(i, i + INSTRUCTOR_ID_CHUNK),
        )) as {
        data: InstructorShopifyState[] | null;
        error: DbError | null;
      };
      check(error, 'load Shopify states');
      for (const state of data ?? []) {
        states.set(state.instructor_id, state);
      }
    }
    return states;
  }

  async getState(instructorId: string): Promise<InstructorShopifyState | null> {
    const { data, error } = (await this.supabase
      .from(STATE_TABLE)
      .select('*')
      .eq('instructor_id', instructorId)
      .maybeSingle()) as {
      data: InstructorShopifyState | null;
      error: DbError | null;
    };
    check(error, 'load Shopify state');
    return data ?? null;
  }

  async saveState(
    instructorId: string,
    patch: InstructorShopifyStatePatch,
  ): Promise<void> {
    const { error } = await this.supabase
      .from(STATE_TABLE)
      .upsert(
        { instructor_id: instructorId, ...patch },
        { onConflict: 'instructor_id' },
      );
    check(error, 'save Shopify state');
  }

  async isHandleStoredByOther(
    handle: string,
    instructorId: string,
  ): Promise<boolean> {
    const { data, error } = await this.supabase
      .from(STATE_TABLE)
      .select('instructor_id')
      .eq('shopify_handle', handle)
      .neq('instructor_id', instructorId)
      .limit(1);
    check(error, 'check stored handles');
    return (data ?? []).length > 0;
  }

  async claimQueueBatch(
    limit: number,
    maxAttempts: number,
  ): Promise<SyncQueueRow[]> {
    const { data, error } = (await this.supabase.rpc(
      'claim_instructor_sync_batch',
      { p_limit: limit, p_max_attempts: maxAttempts },
    )) as { data: SyncQueueRow[] | null; error: DbError | null };
    check(error, 'claim sync queue rows');
    return data ?? [];
  }

  async completeQueueRow(row: SyncQueueRow): Promise<void> {
    const { error } = await this.supabase
      .from(QUEUE_TABLE)
      .delete()
      .eq('instructor_id', row.instructor_id)
      .eq('enqueued_at', row.enqueued_at);
    check(error, 'complete sync queue row');
  }

  async recordQueueFailure(row: SyncQueueRow, message: string): Promise<void> {
    const { error } = await this.supabase
      .from(QUEUE_TABLE)
      .update({ attempts: row.attempts + 1, last_error: message })
      .eq('instructor_id', row.instructor_id);
    check(error, 'record sync failure');
  }

  async enqueueAll(): Promise<ReconcileCounts> {
    const { data, error } = (await this.supabase.rpc(
      'enqueue_all_instructor_sync',
    )) as {
      data: { instructor_count: number; orphaned_count: number }[] | null;
      error: DbError | null;
    };
    check(error, 'enqueue all instructors');
    const [counts] = data ?? [];
    return {
      instructors: Number(counts?.instructor_count ?? 0),
      orphaned: Number(counts?.orphaned_count ?? 0),
    };
  }

  async createSignedPhotoUrl(
    bucket: string,
    path: string,
    expiresInSeconds: number,
  ): Promise<string> {
    const { data, error } = await this.supabase.storage
      .from(bucket)
      .createSignedUrl(path, expiresInSeconds);
    check(error, `sign photo URL for ${bucket}/${path}`);
    if (!data?.signedUrl) {
      throw new Error(`Failed to sign photo URL for ${bucket}/${path}`);
    }
    return data.signedUrl;
  }

  private async refNames(
    instructorId: string,
    junction: string,
    fkColumn: string,
    refTable: string,
  ): Promise<SyncRefName[]> {
    const { data, error } = await this.supabase
      .from(junction)
      .select(
        `${refTable}:${fkColumn} ( name, name_zh, sort_order, is_active )`,
      )
      .eq('instructor_id', instructorId);
    check(error, `load ${refTable}`);
    return sortedRefNames(
      ((data ?? []) as unknown as Record<string, RefJoin | null>[])
        .map((row) => row[refTable])
        .filter((ref): ref is RefJoin => ref != null && ref.is_active),
    );
  }

  private async refNamesFor(
    instructorIds: readonly string[],
    junction: string,
    fkColumn: string,
    refTable: string,
  ): Promise<Map<string, SyncRefName[]>> {
    const { data, error } = await this.supabase
      .from(junction)
      .select(
        `instructor_id, ${refTable}:${fkColumn} ( name, name_zh, sort_order, is_active )`,
      )
      .in('instructor_id', instructorIds);
    check(error, `load ${refTable}`);
    const byInstructor = new Map<string, RefJoin[]>();
    for (const row of (data ?? []) as unknown as (Record<
      string,
      RefJoin | null
    > & { instructor_id: string })[]) {
      const ref = row[refTable];
      if (ref != null && ref.is_active) {
        byInstructor.set(row.instructor_id, [
          ...(byInstructor.get(row.instructor_id) ?? []),
          ref,
        ]);
      }
    }
    return new Map(
      [...byInstructor].map(([id, refs]) => [id, sortedRefNames(refs)]),
    );
  }

  private async rowsFor<T>(
    table: string,
    columns: string,
    instructorIds: readonly string[],
  ): Promise<Map<string, T[]>> {
    const { data, error } = await this.supabase
      .from(table)
      .select(`instructor_id, ${columns}`)
      .in('instructor_id', instructorIds);
    check(error, `load ${table}`);
    const byInstructor = new Map<string, T[]>();
    for (const row of (data ?? []) as unknown as (T & {
      instructor_id: string;
    })[]) {
      const { instructor_id: id, ...rest } = row;
      byInstructor.set(id, [...(byInstructor.get(id) ?? []), rest as T]);
    }
    return byInstructor;
  }

  private async rows<T>(
    table: string,
    columns: string,
    instructorId: string,
  ): Promise<T[]> {
    const { data, error } = await this.supabase
      .from(table)
      .select(columns)
      .eq('instructor_id', instructorId);
    check(error, `load ${table}`);
    return (data ?? []) as T[];
  }
}

function sortedRefNames(refs: RefJoin[]): SyncRefName[] {
  return [...refs]
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    .map((ref) => ({ name: ref.name, name_zh: ref.name_zh ?? null }));
}

function check(error: DbError | null, action: string): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}
