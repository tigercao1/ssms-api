import type { SupabaseClient } from '@supabase/supabase-js';
import type { NewInvite } from '../activation.types';
import type { RosterCertification } from './roster-csv';

export const IMPORT_SEASON_CLAIM = 'roster_import_season';
const USERS_PAGE_SIZE = 1000;
const PG_UNIQUE_VIOLATION = '23505';

export interface ExistingAuthUser {
  id: string;
  importedSeason: string | null;
}

export interface NewRosterInstructor {
  authUserId: string;
  email: string;
  displayNameEn: string;
  dateOfBirth: string | null;
}

/** Read-only queries; the only port dry-run receives. */
export interface RosterReader {
  authUsersByEmail(): Promise<Map<string, ExistingAuthUser>>;
  teachingLocationIds(keys: string[]): Promise<Map<string, string>>;
}

/** Writes used by `--apply`. */
export interface RosterWriter {
  createUser(email: string, season: string): Promise<string>;
  findInstructorId(authUserId: string): Promise<string | null>;
  insertInstructor(instructor: NewRosterInstructor): Promise<string>;
  setProfileRelations(
    instructorId: string,
    certifications: RosterCertification[],
    teachingLocationIds: string[],
  ): Promise<void>;
  insertInvite(invite: NewInvite): Promise<void>;
}

function fail(action: string, message: string | undefined): Error {
  return new Error(`Failed to ${action}: ${message ?? 'unknown error'}`);
}

/** {@link RosterReader} over a service-role client: `listUsers` and `select` only. */
export class SupabaseRosterReader implements RosterReader {
  constructor(private readonly supabase: SupabaseClient) {}

  async authUsersByEmail(): Promise<Map<string, ExistingAuthUser>> {
    const users = new Map<string, ExistingAuthUser>();
    for (let page = 1; ; page++) {
      const { data, error } = await this.supabase.auth.admin.listUsers({
        page,
        perPage: USERS_PAGE_SIZE,
      });
      if (error) {
        throw fail('list auth users', error.message);
      }
      for (const user of data.users) {
        if (!user.email) {
          continue;
        }
        const season = (user.app_metadata as Record<string, unknown>)?.[
          IMPORT_SEASON_CLAIM
        ];
        users.set(user.email.toLowerCase(), {
          id: user.id,
          importedSeason: typeof season === 'string' ? season : null,
        });
      }
      if (data.users.length < USERS_PAGE_SIZE) {
        return users;
      }
    }
  }

  async teachingLocationIds(keys: string[]): Promise<Map<string, string>> {
    if (keys.length === 0) {
      return new Map();
    }
    const { data, error } = await this.supabase
      .from('teaching_locations')
      .select('id, key')
      .in('key', keys);
    if (error) {
      throw fail('load teaching locations', error.message);
    }
    return new Map(
      ((data ?? []) as { id: string; key: string }[]).map((r) => [r.key, r.id]),
    );
  }
}

/** {@link RosterWriter} over a service-role client. */
export class SupabaseRosterWriter implements RosterWriter {
  constructor(private readonly supabase: SupabaseClient) {}

  async createUser(email: string, season: string): Promise<string> {
    const { data, error } = await this.supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: { [IMPORT_SEASON_CLAIM]: season },
    });
    if (error || !data.user) {
      throw fail('create auth user', error?.message);
    }
    return data.user.id;
  }

  async findInstructorId(authUserId: string): Promise<string | null> {
    const { data, error } = await this.supabase
      .from('instructors')
      .select('id')
      .eq('auth_user_id', authUserId)
      .maybeSingle();
    if (error) {
      throw fail('load instructor', error.message);
    }
    return (data as { id: string } | null)?.id ?? null;
  }

  async insertInstructor(instructor: NewRosterInstructor): Promise<string> {
    const { data, error } = await this.supabase
      .from('instructors')
      .insert({
        auth_user_id: instructor.authUserId,
        email: instructor.email,
        display_name_en: instructor.displayNameEn,
        date_of_birth: instructor.dateOfBirth,
        preferred_language: 'zh-CN',
        approval_status: 'pending',
        is_active: true,
      })
      .select('id')
      .single();
    if (error?.code === PG_UNIQUE_VIOLATION) {
      const existing = await this.findInstructorId(instructor.authUserId);
      if (existing) {
        return existing;
      }
    }
    if (error || !data) {
      throw fail('create instructor', error?.message);
    }
    return (data as { id: string }).id;
  }

  async setProfileRelations(
    instructorId: string,
    certifications: RosterCertification[],
    teachingLocationIds: string[],
  ): Promise<void> {
    const { error } = await this.supabase.rpc('update_instructor_profile', {
      p_instructor_id: instructorId,
      p_patch: {
        certifications: certifications.map((c) => ({
          org: c.org,
          track: c.track,
          level: c.level,
          is_partial: false,
          partial_components: [],
        })),
        teaching_location_ids: teachingLocationIds,
      },
    });
    if (error) {
      throw fail('set certifications and locations', error.message);
    }
  }

  async insertInvite(invite: NewInvite): Promise<void> {
    const { error } = await this.supabase
      .from('instructor_invites')
      .upsert(invite, {
        onConflict: 'instructor_id,season',
        ignoreDuplicates: true,
      });
    if (error) {
      throw fail('create invite', error.message);
    }
  }
}
