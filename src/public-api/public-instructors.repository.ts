import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import {
  ListInstructorsParams,
  PublicCertRow,
  PublicInstructorRow,
  PublicRefRow,
  PublicTrainerRow,
} from './public-api.types';

/** Result of the list RPC: ordered page ids + overall match count. */
export interface ListPage {
  ids: string[];
  totalCount: number;
}

/** Public columns only — internal columns never selected here. */
const PUBLIC_INSTRUCTOR_COLUMNS =
  'id, display_name_en, display_name_zh, bio_en, bio_zh, profile_photo_url';

/**
 * Read boundary for the Public API. Abstract so tests can bind an in-memory
 * fake. All reads go through the service-role client (RLS bypassed) but apply
 * the public visibility predicate (`approved` AND `is_active`) explicitly.
 */
export abstract class PublicInstructorsRepository {
  /** Filter/sort/paginate via RPC; returns the page's ids + total count. */
  abstract listVisible(params: ListInstructorsParams): Promise<ListPage>;
  /** Fetch public core rows for the given ids (visible only). */
  abstract findVisibleByIds(ids: string[]): Promise<PublicInstructorRow[]>;
  /** Fetch a single public core row by id (visible only), or null. */
  abstract findVisibleById(id: string): Promise<PublicInstructorRow | null>;
  abstract getTeachingLocations(ids: string[]): Promise<PublicRefRow[]>;
  abstract getLanguages(ids: string[]): Promise<PublicRefRow[]>;
  abstract getCourseLevels(ids: string[]): Promise<PublicRefRow[]>;
  abstract getCertifications(ids: string[]): Promise<PublicCertRow[]>;
  abstract getTrainerStatus(ids: string[]): Promise<PublicTrainerRow[]>;
}

@Injectable()
export class SupabasePublicInstructorsRepository extends PublicInstructorsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async listVisible(params: ListInstructorsParams): Promise<ListPage> {
    const { data, error } = (await this.supabase.rpc(
      'public_list_instructors',
      {
        p_locale: params.locale,
        p_page: params.page,
        p_page_size: 50,
        p_locations: params.locations ?? null,
        p_languages: params.languages ?? null,
        p_disciplines: params.disciplines ?? null,
        p_min_csia: params.minCsiaLevel ?? null,
        p_min_casi: params.minCasiLevel ?? null,
        p_trainers_only: params.trainersOnly,
        p_sort: params.sort,
        p_order: params.order ?? null,
      },
    )) as {
      data: Array<{ id: string; total_count: number }> | null;
      error: { message: string } | null;
    };
    if (error) {
      throw new InternalServerErrorException(
        `Failed to list instructors: ${error.message}`,
      );
    }
    const rows = data ?? [];
    return {
      ids: rows.map((r) => r.id),
      totalCount: rows.length > 0 ? Number(rows[0].total_count) : 0,
    };
  }

  async findVisibleByIds(ids: string[]): Promise<PublicInstructorRow[]> {
    if (ids.length === 0) {
      return [];
    }
    const { data, error } = await this.supabase
      .from('instructors')
      .select(PUBLIC_INSTRUCTOR_COLUMNS)
      .in('id', ids)
      .eq('approval_status', 'approved')
      .eq('is_active', true);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load instructors: ${error.message}`,
      );
    }
    return data ?? [];
  }

  async findVisibleById(id: string): Promise<PublicInstructorRow | null> {
    const { data, error } = await this.supabase
      .from('instructors')
      .select(PUBLIC_INSTRUCTOR_COLUMNS)
      .eq('id', id)
      .eq('approval_status', 'approved')
      .eq('is_active', true)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load instructor: ${error.message}`,
      );
    }
    return data ?? null;
  }

  private async fetchRefs(
    junction: string,
    fkColumn: string,
    refTable: string,
    ids: string[],
  ): Promise<PublicRefRow[]> {
    if (ids.length === 0) {
      return [];
    }
    const { data, error } = await this.supabase
      .from(junction)
      .select(
        `instructor_id, ${refTable}:${fkColumn} ( key, name, sort_order )`,
      )
      .in('instructor_id', ids);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load ${refTable}: ${error.message}`,
      );
    }
    const rows = (data ?? []) as unknown as Array<{
      instructor_id: string;
      [k: string]: unknown;
    }>;
    return rows
      .map((r) => {
        const ref = r[refTable] as {
          key: string;
          name: string;
          sort_order: number;
        } | null;
        if (ref == null) {
          return null;
        }
        return {
          instructor_id: r.instructor_id,
          key: ref.key,
          name: ref.name,
          sort_order: ref.sort_order,
        };
      })
      .filter((r): r is PublicRefRow => r !== null);
  }

  getTeachingLocations(ids: string[]): Promise<PublicRefRow[]> {
    return this.fetchRefs(
      'instructors_teaching_locations',
      'teaching_location_id',
      'teaching_locations',
      ids,
    );
  }

  getLanguages(ids: string[]): Promise<PublicRefRow[]> {
    return this.fetchRefs(
      'instructors_languages',
      'language_id',
      'languages',
      ids,
    );
  }

  getCourseLevels(ids: string[]): Promise<PublicRefRow[]> {
    return this.fetchRefs(
      'instructors_course_levels_offered',
      'course_level_offered_id',
      'course_levels_offered',
      ids,
    );
  }

  async getCertifications(ids: string[]): Promise<PublicCertRow[]> {
    if (ids.length === 0) {
      return [];
    }
    const { data, error } = await this.supabase
      .from('instructor_certifications')
      .select('instructor_id, org, track, level, is_partial')
      .in('instructor_id', ids);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load certifications: ${error.message}`,
      );
    }
    return data ?? [];
  }

  async getTrainerStatus(ids: string[]): Promise<PublicTrainerRow[]> {
    if (ids.length === 0) {
      return [];
    }
    const { data, error } = await this.supabase
      .from('instructor_trainer_status')
      .select('instructor_id, discipline, trainer_level')
      .in('instructor_id', ids);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load trainer status: ${error.message}`,
      );
    }
    return data ?? [];
  }
}
