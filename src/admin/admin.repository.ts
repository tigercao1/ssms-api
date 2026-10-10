import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import {
  AdminInstructorPatch,
  AdminInstructorRow,
  AuthUserRole,
  CreateReferenceInput,
  ListInstructorsFilter,
  ReferenceJunction,
  ReferencePatch,
  ReferenceRow,
  UserRole,
} from './admin.types';

const INSTRUCTOR_COLUMNS =
  'id, auth_user_id, email, display_name_en, display_name_zh, bio_en, bio_zh, ' +
  'date_of_birth, profile_photo_url, preferred_language, approval_status, ' +
  'is_active, min_student_age, inserted_at, updated_at';

const REFERENCE_COLUMNS =
  'id, key, name, name_zh, name_en_translated_by, name_zh_translated_by, sort_order, is_active';

/**
 * Data-access boundary for the Admin module. Declared as an abstract class so
 * it doubles as a DI token and lets unit tests bind an in-memory fake
 * (TESTING_STRATEGY.md § Mocking pattern — repo fakes preferred).
 */
export abstract class AdminRepository {
  /** All instructors (every status), optionally narrowed; admin-only view. */
  abstract listInstructors(
    filter: ListInstructorsFilter,
  ): Promise<AdminInstructorRow[]>;
  abstract findInstructorById(id: string): Promise<AdminInstructorRow | null>;
  /** Apply a core-column patch (approval_status / is_active) and return it. */
  abstract updateInstructor(
    id: string,
    patch: AdminInstructorPatch,
  ): Promise<AdminInstructorRow | null>;
  /** Append a row to a reference (lookup) table; returns the created row. */
  abstract insertReference(
    table: string,
    input: CreateReferenceInput,
  ): Promise<ReferenceRow>;
  abstract listReferences(table: string): Promise<ReferenceRow[]>;
  abstract findReferenceById(
    table: string,
    id: string,
  ): Promise<ReferenceRow | null>;
  abstract updateReference(
    table: string,
    id: string,
    patch: ReferencePatch,
  ): Promise<ReferenceRow | null>;
  abstract countReferenceLinks(
    junction: ReferenceJunction,
    id: string,
  ): Promise<number>;
  abstract deleteReference(
    table: string,
    id: string,
  ): Promise<ReferenceRow | null>;
  /** Read an auth user's current `app_metadata.role` (Supabase Admin API). */
  abstract getUserRole(authUserId: string): Promise<AuthUserRole>;
  /** Set an auth user's `app_metadata.role`, preserving other metadata keys. */
  abstract setUserRole(authUserId: string, role: UserRole): Promise<void>;
}

/** Narrow an arbitrary `app_metadata.role` claim to a known {@link UserRole}. */
function normalizeRole(value: unknown): UserRole | null {
  return value === 'admin' || value === 'instructor' ? value : null;
}

@Injectable()
export class SupabaseAdminRepository extends AdminRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async listInstructors(
    filter: ListInstructorsFilter,
  ): Promise<AdminInstructorRow[]> {
    let query = this.supabase.from('instructors').select(INSTRUCTOR_COLUMNS);

    if (filter.status !== undefined) {
      query = query.eq('approval_status', filter.status);
    }
    if (filter.isActive !== undefined) {
      query = query.eq('is_active', filter.isActive);
    }

    // Deterministic order: newest applications first, id as a stable tiebreaker.
    const { data, error } = await query
      .order('inserted_at', { ascending: false })
      .order('id', { ascending: true });

    if (error) {
      throw new InternalServerErrorException(
        `Failed to list instructors: ${error.message}`,
      );
    }
    return (data ?? []) as unknown as AdminInstructorRow[];
  }

  async findInstructorById(id: string): Promise<AdminInstructorRow | null> {
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
    return (data as unknown as AdminInstructorRow | null) ?? null;
  }

  async updateInstructor(
    id: string,
    patch: AdminInstructorPatch,
  ): Promise<AdminInstructorRow | null> {
    const { data, error } = await this.supabase
      .from('instructors')
      .update(patch)
      .eq('id', id)
      .select(INSTRUCTOR_COLUMNS)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to update instructor: ${error.message}`,
      );
    }
    return (data as unknown as AdminInstructorRow | null) ?? null;
  }

  async insertReference(
    table: string,
    input: CreateReferenceInput,
  ): Promise<ReferenceRow> {
    const { data, error } = await this.supabase
      .from(table)
      .insert({
        key: input.key,
        name: input.name,
        name_zh: input.nameZh,
        name_en_translated_by: input.nameEnTranslatedBy,
        name_zh_translated_by: input.nameZhTranslatedBy,
        sort_order: input.sortOrder,
        is_active: input.isActive,
      })
      .select(REFERENCE_COLUMNS)
      .single();
    if (error) {
      // Re-throw so the service can map a duplicate `key` (23505) to a 409.
      throw error;
    }
    return data;
  }

  async listReferences(table: string): Promise<ReferenceRow[]> {
    const { data, error } = await this.supabase
      .from(table)
      .select(REFERENCE_COLUMNS)
      .order('sort_order', { ascending: true })
      .order('key', { ascending: true });
    if (error) {
      throw new InternalServerErrorException(
        `Failed to list ${table}: ${error.message}`,
      );
    }
    return data ?? [];
  }

  async findReferenceById(
    table: string,
    id: string,
  ): Promise<ReferenceRow | null> {
    const { data, error } = await this.supabase
      .from(table)
      .select(REFERENCE_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to load ${table} row: ${error.message}`,
      );
    }
    return data ?? null;
  }

  async updateReference(
    table: string,
    id: string,
    patch: ReferencePatch,
  ): Promise<ReferenceRow | null> {
    const { data, error } = await this.supabase
      .from(table)
      .update(patch)
      .eq('id', id)
      .select(REFERENCE_COLUMNS)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to update ${table} row: ${error.message}`,
      );
    }
    return data ?? null;
  }

  async countReferenceLinks(
    junction: ReferenceJunction,
    id: string,
  ): Promise<number> {
    const { count, error } = await this.supabase
      .from(junction.table)
      .select('instructor_id', { count: 'exact', head: true })
      .eq(junction.column, id);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to count ${junction.table} links: ${error.message}`,
      );
    }
    return count ?? 0;
  }

  async deleteReference(
    table: string,
    id: string,
  ): Promise<ReferenceRow | null> {
    const { data, error } = await this.supabase
      .from(table)
      .delete()
      .eq('id', id)
      .select(REFERENCE_COLUMNS)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to delete ${table} row: ${error.message}`,
      );
    }
    return data ?? null;
  }

  async getUserRole(authUserId: string): Promise<AuthUserRole> {
    const { data, error } =
      await this.supabase.auth.admin.getUserById(authUserId);
    if (error) {
      // Supabase returns an error (e.g. 404) when the user does not exist.
      return { found: false, role: null };
    }
    const user = data.user;
    if (!user) {
      return { found: false, role: null };
    }
    return { found: true, role: normalizeRole(user.app_metadata?.role) };
  }

  async setUserRole(authUserId: string, role: UserRole): Promise<void> {
    // Read-modify-write so we never clobber unrelated app_metadata keys.
    const { data: current } =
      await this.supabase.auth.admin.getUserById(authUserId);
    const existing = current?.user?.app_metadata ?? {};
    const { error } = await this.supabase.auth.admin.updateUserById(
      authUserId,
      { app_metadata: { ...existing, role } },
    );
    if (error) {
      throw new InternalServerErrorException(
        `Failed to update user role: ${error.message}`,
      );
    }
  }
}
