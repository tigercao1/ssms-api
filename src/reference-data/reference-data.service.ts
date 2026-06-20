import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

/**
 * Shape returned to API consumers for every reference-data list.
 *
 * `key` is the stable i18n key (e.g. `language.fr`) the frontend uses to look
 * up a translated label; `name` is the canonical/default display string.
 */
export interface ReferenceItem {
  id: string;
  key: string;
  name: string;
  sortOrder: number;
}

/** DB row shape for the shared reference-table column set. */
interface ReferenceRow {
  id: string;
  key: string;
  name: string;
  sort_order: number;
}

/**
 * Reference (lookup) tables share an identical column set, so a single
 * generic reader serves them all. See REFERENCE_DATA_BEST_PRACTICES.md.
 */
export const REFERENCE_TABLES = {
  teachingLocations: 'teaching_locations',
  languages: 'languages',
  courseLevelsOffered: 'course_levels_offered',
  examPreparations: 'exam_preparations',
} as const;

@Injectable()
export class ReferenceDataService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  /**
   * Lists active rows from a reference table, sorted deterministically by
   * `sort_order` then `key` (the unique tiebreaker keeps ties stable across
   * requests). Inactive rows are excluded.
   */
  private async list(table: string): Promise<ReferenceItem[]> {
    const { data, error } = await this.supabase
      .from(table)
      .select('id, key, name, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('key', { ascending: true });

    if (error) {
      throw new InternalServerErrorException(
        `Failed to load reference data '${table}': ${error.message}`,
      );
    }

    return ((data ?? []) as ReferenceRow[]).map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      sortOrder: row.sort_order,
    }));
  }

  getTeachingLocations(): Promise<ReferenceItem[]> {
    return this.list(REFERENCE_TABLES.teachingLocations);
  }

  getLanguages(): Promise<ReferenceItem[]> {
    return this.list(REFERENCE_TABLES.languages);
  }

  getCourseLevelsOffered(): Promise<ReferenceItem[]> {
    return this.list(REFERENCE_TABLES.courseLevelsOffered);
  }

  getExamPreparations(): Promise<ReferenceItem[]> {
    return this.list(REFERENCE_TABLES.examPreparations);
  }
}
