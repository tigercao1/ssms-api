/**
 * Public response DTOs (PUBLIC_API_PLAN.md § Response shape). These are the
 * STABLE external contract — they intentionally decouple consumers from the
 * internal schema and never expose internal columns (`auth_user_id`, `email`,
 * `date_of_birth`, `approval_status`, `partial_components`, MT flags, …).
 */

/** Reference item as `{ key, label }` so consumers can localize via `key`. */
export interface PublicRefItem {
  key: string;
  /** Ready-to-render English label (convenience; localize via `key`). */
  label: string;
}

/**
 * Certifications grouped by discipline. A discipline block is omitted entirely
 * when the instructor holds no cert (and is not a trainer) for it. Each track
 * holds the formatted display string, or `null` when not held.
 */
export interface PublicSkiCertifications {
  regular: string | null;
  park: string | null;
  trainer: string | null;
}

export interface PublicSnowboardCertifications {
  regular: string | null;
  park: string | null;
  carving: string | null;
  trainer: string | null;
}

export interface PublicCertifications {
  ski?: PublicSkiCertifications;
  snowboard?: PublicSnowboardCertifications;
}

/** Single instructor, as returned by both list items and the detail endpoint. */
export interface PublicInstructorDto {
  id: string;
  display_name: string;
  bio: string | null;
  profile_photo_url: string | null;
  teaching_locations: PublicRefItem[];
  languages: PublicRefItem[];
  course_levels_offered: PublicRefItem[];
  certifications: PublicCertifications;
}

/** Paginated list envelope (PUBLIC_API_PLAN.md § Response envelope). */
export interface PublicInstructorListDto {
  data: PublicInstructorDto[];
  page: number;
  page_size: number;
  total_count: number;
  total_pages: number;
}
