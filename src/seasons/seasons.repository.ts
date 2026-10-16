import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

export const SEASONS_TABLE = 'seasons';
export const SEASON_COLUMNS = 'key, starts_on, ends_on';
export const SEASON_REFERENCES: readonly { table: string; column: string }[] = [
  { table: 'document_templates', column: 'season' },
  { table: 'document_assignments', column: 'season' },
  { table: 'instructor_invites', column: 'season' },
];

export interface SeasonRow {
  key: string;
  starts_on: string;
  ends_on: string;
}

export interface SeasonDatesPatch {
  starts_on?: string;
  ends_on?: string;
}

export abstract class SeasonsRepository {
  abstract list(): Promise<SeasonRow[]>;
  abstract insert(row: SeasonRow): Promise<SeasonRow>;
  abstract update(
    key: string,
    patch: SeasonDatesPatch,
  ): Promise<SeasonRow | null>;
  abstract delete(key: string): Promise<SeasonRow | null>;
  abstract referenceCount(key: string): Promise<number>;
}

@Injectable()
export class SupabaseSeasonsRepository extends SeasonsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async list(): Promise<SeasonRow[]> {
    const { data, error } = (await this.supabase
      .from(SEASONS_TABLE)
      .select(SEASON_COLUMNS)
      .order('starts_on', { ascending: false })) as DbResult<SeasonRow[]>;
    check(error, 'list seasons');
    return data ?? [];
  }

  async insert(row: SeasonRow): Promise<SeasonRow> {
    const { data, error } = (await this.supabase
      .from(SEASONS_TABLE)
      .insert(row)
      .select(SEASON_COLUMNS)
      .single()) as DbResult<SeasonRow>;
    check(error, 'create season');
    return data as SeasonRow;
  }

  async update(
    key: string,
    patch: SeasonDatesPatch,
  ): Promise<SeasonRow | null> {
    const { data, error } = (await this.supabase
      .from(SEASONS_TABLE)
      .update(patch)
      .eq('key', key)
      .select(SEASON_COLUMNS)
      .maybeSingle()) as DbResult<SeasonRow>;
    check(error, 'update season');
    return data;
  }

  async delete(key: string): Promise<SeasonRow | null> {
    const { data, error } = (await this.supabase
      .from(SEASONS_TABLE)
      .delete()
      .eq('key', key)
      .select(SEASON_COLUMNS)
      .maybeSingle()) as DbResult<SeasonRow>;
    check(error, 'delete season');
    return data;
  }

  async referenceCount(key: string): Promise<number> {
    const counts = await Promise.all(
      SEASON_REFERENCES.map(async ({ table, column }) => {
        const { count, error } = await this.supabase
          .from(table)
          .select(column, { count: 'exact', head: true })
          .eq(column, key);
        check(error, `count ${table} using season`);
        return count ?? 0;
      }),
    );
    return counts.reduce((sum, n) => sum + n, 0);
  }
}
