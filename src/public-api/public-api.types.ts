/**
 * Internal domain types for the Public API module.
 *
 * `*Row` types mirror DB column shapes (snake_case). The public DTOs returned to
 * external consumers live in `public-instructor.dto.ts`.
 */

export type ApiKeyEnvironment = 'live' | 'test';

/** `api_keys` row (the subset we read). `key_hash` never leaves the server. */
export interface ApiKeyRow {
  id: string;
  name: string;
  environment: ApiKeyEnvironment;
  prefix: string;
  last_four: string;
  rate_limit_per_min: number;
  created_at: string;
  revoked_at: string | null;
}

/** Result of a successful key issuance — plaintext key shown exactly once. */
export interface IssuedApiKey {
  id: string;
  name: string;
  environment: ApiKeyEnvironment;
  prefix: string;
  lastFour: string;
  rateLimitPerMin: number;
  createdAt: string;
  /** Full secret (`ssms_live_…`). Returned once; never persisted in plaintext. */
  apiKey: string;
}

/** Public instructor core row (only public columns — no email/DOB/etc.). */
export interface PublicInstructorRow {
  id: string;
  display_name_en: string;
  display_name_zh: string | null;
  bio_en: string | null;
  bio_zh: string | null;
  profile_photo_url: string | null;
}

/** A linked reference row joined for a given instructor. */
export interface PublicRefRow {
  instructor_id: string;
  key: string;
  name: string;
  sort_order: number;
}

/** Certification row (public subset; partial_components is internal, omitted). */
export interface PublicCertRow {
  instructor_id: string;
  org: 'csia' | 'casi';
  track: 'regular' | 'park' | 'carving';
  level: number;
  is_partial: boolean;
}

/** Trainer-status row (public subset). */
export interface PublicTrainerRow {
  instructor_id: string;
  discipline: 'ski' | 'snowboard';
  trainer_level: number | null;
}

/** Normalised, validated filter/sort/pagination input for the list query. */
export interface ListInstructorsParams {
  locale: 'en' | 'zh-CN';
  page: number;
  locations?: string[];
  languages?: string[];
  disciplines?: Array<'ski' | 'snowboard'>;
  minCsiaLevel?: number;
  minCasiLevel?: number;
  trainersOnly: boolean;
  sort: 'name' | 'seniority';
  order?: 'asc' | 'desc';
}
