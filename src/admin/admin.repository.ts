import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { auditMetadata } from '../audit/audit.service';
import type { AuditEntry } from '../audit/audit.types';
import { DbResult, ilikeAny, searchTokens } from '../database/db-result';
import {
  type CountedResult,
  fetchAllPages,
  type PageRequest,
  PGRST_RANGE_NOT_SATISFIABLE,
  type RowPage,
} from '../database/pagination';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import {
  AdminInstructorListRow,
  AdminInstructorPatch,
  AdminInstructorRow,
  AuditRecord,
  AuthEmailUpdate,
  AuthUserRole,
  CreateReferenceInput,
  ListInstructorsFilter,
  ReferenceJunction,
  ReferencePatch,
  ReferenceRow,
  UserRole,
} from './admin.types';

const INSTRUCTOR_COLUMNS =
  'id, auth_user_id, email, first_name, last_name, ' +
  'display_name_en, display_name_zh, bio_en, bio_zh, ' +
  'date_of_birth, profile_photo_url, preferred_language, approval_status, ' +
  'is_active, min_student_age, display_order, inserted_at, updated_at';

const INSTRUCTOR_CALENDAR_EMBED = 'instructor_calendars(instructor_id)';

const INSTRUCTOR_LIST_COLUMNS = `${INSTRUCTOR_COLUMNS}, ${INSTRUCTOR_CALENDAR_EMBED}`;

const INSTRUCTOR_SEARCH_COLUMNS = [
  'display_name_en',
  'display_name_zh',
  'email',
];

const AUTH_USERS_PAGE_SIZE = 1000;

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
    page: PageRequest,
  ): Promise<RowPage<AdminInstructorListRow>>;
  abstract listAllInstructors(
    filter: ListInstructorsFilter,
  ): Promise<AdminInstructorListRow[]>;
  abstract findInstructorById(id: string): Promise<AdminInstructorRow | null>;
  abstract findAuthUserIdByEmail(email: string): Promise<string | null>;
  abstract updateAuthEmail(
    authUserId: string,
    email: string,
  ): Promise<AuthEmailUpdate>;
  abstract claimInstructorEmail(
    id: string,
    fromEmail: string,
    toEmail: string,
  ): Promise<boolean>;
  abstract findAuthEmail(authUserId: string): Promise<string | null>;
  abstract recordAudit(entry: AuditEntry): Promise<void>;
  abstract listAuditEntries(
    action: string,
    targetId: string,
    limit: number,
  ): Promise<AuditRecord[]>;
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
  /** Delete every auth session of a user; returns how many were revoked. */
  abstract revokeSessions(authUserId: string): Promise<number>;
  abstract listInstructorIdsAtLocation(
    locationKey: string,
  ): Promise<Set<string>>;
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
    page: PageRequest,
  ): Promise<RowPage<AdminInstructorListRow>> {
    // Deterministic order: newest applications first, id as a stable tiebreaker.
    const ordered = this.instructorsMatching(filter, INSTRUCTOR_LIST_COLUMNS, {
      count: 'exact',
    })
      .order('inserted_at', { ascending: false })
      .order('id', { ascending: true });
    const { data, error, count } = (await ordered.range(
      page.offset,
      page.offset + page.limit - 1,
    )) as CountedResult<AdminInstructorListRow[]>;

    if (error?.code === PGRST_RANGE_NOT_SATISFIABLE) {
      return { rows: [], total: await this.countInstructors(filter) };
    }
    if (error) {
      throw new InternalServerErrorException(
        `Failed to list instructors: ${error.message}`,
      );
    }
    return { rows: data ?? [], total: count ?? 0 };
  }

  listAllInstructors(
    filter: ListInstructorsFilter,
  ): Promise<AdminInstructorListRow[]> {
    return fetchAllPages<AdminInstructorListRow>(
      (from, to) =>
        this.instructorsMatching(filter, INSTRUCTOR_LIST_COLUMNS)
          .order('inserted_at', { ascending: false })
          .order('id', { ascending: true })
          .range(from, to),
      'list instructors',
    );
  }

  private async countInstructors(
    filter: ListInstructorsFilter,
  ): Promise<number> {
    const columns =
      filter.calendarConnected === undefined
        ? 'id'
        : `id, ${INSTRUCTOR_CALENDAR_EMBED}`;
    const { error, count } = (await this.instructorsMatching(filter, columns, {
      count: 'exact',
      head: true,
    })) as CountedResult<null>;
    if (error) {
      throw new InternalServerErrorException(
        `Failed to count instructors: ${error.message}`,
      );
    }
    return count ?? 0;
  }

  private instructorsMatching(
    filter: ListInstructorsFilter,
    columns: string,
    options?: { count: 'exact'; head?: boolean },
  ) {
    let query = this.supabase.from('instructors').select(columns, options);

    if (filter.status !== undefined) {
      query = query.eq('approval_status', filter.status);
    }
    if (filter.isActive !== undefined) {
      query = query.eq('is_active', filter.isActive);
    }
    if (filter.calendarConnected === true) {
      query = query.not('instructor_calendars', 'is', null);
    }
    if (filter.calendarConnected === false) {
      query = query.is('instructor_calendars', null);
    }
    for (const token of searchTokens(filter.q)) {
      query = query.or(ilikeAny(INSTRUCTOR_SEARCH_COLUMNS, token));
    }
    return query;
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

  async findAuthUserIdByEmail(email: string): Promise<string | null> {
    for (let page = 1; ; page++) {
      const { data, error } = await this.supabase.auth.admin.listUsers({
        page,
        perPage: AUTH_USERS_PAGE_SIZE,
      });
      if (error) {
        throw new InternalServerErrorException(
          `Failed to list auth users: ${error.message}`,
        );
      }
      const match = data.users.find(
        (user) => user.email?.toLowerCase() === email,
      );
      if (match) {
        return match.id;
      }
      if (data.users.length < AUTH_USERS_PAGE_SIZE) {
        return null;
      }
    }
  }

  async updateAuthEmail(
    authUserId: string,
    email: string,
  ): Promise<AuthEmailUpdate> {
    const { error } = await this.supabase.auth.admin.updateUserById(
      authUserId,
      { email, email_confirm: true },
    );
    if (!error) {
      return 'updated';
    }
    if (error.code === 'email_exists') {
      return 'taken';
    }
    if (error.code === 'validation_failed') {
      return 'invalid';
    }
    throw new InternalServerErrorException(
      `Failed to update the auth email: ${error.message}`,
    );
  }

  async claimInstructorEmail(
    id: string,
    fromEmail: string,
    toEmail: string,
  ): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('instructors')
      .update({ email: toEmail })
      .eq('id', id)
      .eq('email', fromEmail)
      .select('id');
    if (error) {
      throw new InternalServerErrorException(
        `Failed to claim the instructor email: ${error.message}`,
      );
    }
    return (data ?? []).length > 0;
  }

  async findAuthEmail(authUserId: string): Promise<string | null> {
    const { data, error } =
      await this.supabase.auth.admin.getUserById(authUserId);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to read the auth user: ${error.message}`,
      );
    }
    return data.user?.email ?? null;
  }

  async recordAudit(entry: AuditEntry): Promise<void> {
    const { error } = await this.supabase.from('audit_log').insert({
      actor_user_id: entry.actor?.userId ?? null,
      actor_role: entry.actor?.role ?? null,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      metadata: auditMetadata(entry),
      ip: entry.actor?.ip ?? null,
      user_agent: entry.actor?.userAgent ?? null,
    });
    if (error) {
      throw new InternalServerErrorException(
        `Failed to write the audit log: ${error.message}`,
      );
    }
  }

  async listAuditEntries(
    action: string,
    targetId: string,
    limit: number,
  ): Promise<AuditRecord[]> {
    const { data, error } = await this.supabase
      .from('audit_log')
      .select('metadata, inserted_at')
      .eq('action', action)
      .eq('target_id', targetId)
      .order('inserted_at', { ascending: false })
      .limit(limit);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to read the audit log: ${error.message}`,
      );
    }
    return (
      (data ?? []) as {
        metadata: Record<string, unknown> | null;
        inserted_at: string;
      }[]
    ).map((row) => ({
      metadata: row.metadata ?? {},
      insertedAt: row.inserted_at,
    }));
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

  async revokeSessions(authUserId: string): Promise<number> {
    const { data, error } = (await this.supabase.rpc('revoke_user_sessions', {
      p_user_id: authUserId,
    })) as DbResult<number>;
    if (error) {
      throw new InternalServerErrorException(
        `Failed to revoke user sessions: ${error.message}`,
      );
    }
    return data ?? 0;
  }

  async listInstructorIdsAtLocation(locationKey: string): Promise<Set<string>> {
    const rows = await fetchAllPages<{ instructor_id: string }>(
      (from, to) =>
        this.supabase
          .from('instructors_teaching_locations')
          .select('instructor_id, teaching_locations!inner(key)')
          .eq('teaching_locations.key', locationKey)
          .order('instructor_id', { ascending: true })
          .range(from, to),
      'list instructors at a teaching location',
    );
    return new Set(rows.map((row) => row.instructor_id));
  }
}
