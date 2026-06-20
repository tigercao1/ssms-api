/**
 * Internal domain types for the Admin module.
 * `*Row` types mirror DB column shapes (snake_case); the `Admin*Record`
 * presenter types are the camelCase shapes returned by `/admin/*`.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type PreferredLanguage = 'en' | 'zh-CN';
/** Roles an admin can assign via `app_metadata.role` (server-set only). */
export type UserRole = 'admin' | 'instructor';

/** Current auth-user role state, as read from the Supabase Admin API. */
export interface AuthUserRole {
  found: boolean;
  /** `null` when the user has no explicit role (treated as a plain instructor). */
  role: UserRole | null;
}

/** Result of a role change returned to the admin caller. */
export interface UserRoleRecord {
  userId: string;
  role: UserRole;
  previousRole: UserRole | null;
  /** `false` when the user already held the requested role (no-op, no audit). */
  changed: boolean;
}

/** Core `instructors` row as read by the admin surface. */
export interface AdminInstructorRow {
  id: string;
  auth_user_id: string;
  email: string;
  display_name_en: string;
  display_name_zh: string | null;
  bio_en: string | null;
  bio_zh: string | null;
  date_of_birth: string | null;
  profile_photo_url: string | null;
  preferred_language: PreferredLanguage;
  approval_status: ApprovalStatus;
  is_active: boolean;
  inserted_at: string;
  updated_at: string;
}

/** camelCase presenter returned to admins for list/detail/transition results. */
export interface AdminInstructorRecord {
  id: string;
  authUserId: string;
  email: string;
  displayNameEn: string;
  displayNameZh: string | null;
  bioEn: string | null;
  bioZh: string | null;
  dateOfBirth: string | null;
  profilePhotoUrl: string | null;
  preferredLanguage: PreferredLanguage;
  approvalStatus: ApprovalStatus;
  isActive: boolean;
  insertedAt: string;
  updatedAt: string;
}

/** Optional narrowing applied to `GET /admin/instructors`. */
export interface ListInstructorsFilter {
  status?: ApprovalStatus;
  isActive?: boolean;
}

/** Mutable core columns an admin transition can write. */
export interface AdminInstructorPatch {
  approval_status?: ApprovalStatus;
  is_active?: boolean;
}

/**
 * Reference (lookup) tables an admin can append rows to (T6.7). Keyed by the
 * URL slug used on `POST /admin/reference/:type`; value is the physical table.
 * Single source of truth for the slug↔table mapping in this module.
 */
export const REFERENCE_SLUG_TO_TABLE = {
  'teaching-locations': 'teaching_locations',
  languages: 'languages',
  'course-levels-offered': 'course_levels_offered',
  'exam-preparations': 'exam_preparations',
} as const;

export type ReferenceSlug = keyof typeof REFERENCE_SLUG_TO_TABLE;

export const REFERENCE_SLUGS = Object.keys(
  REFERENCE_SLUG_TO_TABLE,
) as ReferenceSlug[];

/** DB row shape shared by every reference table. */
export interface ReferenceRow {
  id: string;
  key: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

/** camelCase presenter for a created reference row. */
export interface ReferenceRecord {
  id: string;
  key: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

/** Validated payload for inserting a reference row. */
export interface CreateReferenceInput {
  key: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}
