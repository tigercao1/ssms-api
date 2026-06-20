/**
 * T10.1 — Test fixture seeder (TESTING_STRATEGY.md § Test data / fixtures).
 *
 * A small, in-memory set of instructors covering **every** lifecycle state plus
 * one instructor carrying a full spread of certification combinations, for
 * display-string, filter, and visibility tests. This is the canonical fixture
 * shape; repository fakes and `makeFakeSupabase()` can serve these rows.
 *
 * Mirrors the production seed (`supabase/seed.sql`) for reference data; the rows
 * here intentionally stay tiny and deterministic (fixed UUIDs) so assertions can
 * reference them by name.
 */

export interface InstructorFixture {
  id: string;
  auth_user_id: string;
  email: string;
  display_name_en: string;
  display_name_zh: string | null;
  bio_en: string | null;
  bio_zh: string | null;
  date_of_birth: string | null;
  profile_photo_url: string | null;
  preferred_language: 'en' | 'zh-CN';
  approval_status: 'pending' | 'approved' | 'rejected';
  is_active: boolean;
  inserted_at: string;
  updated_at: string;
}

export interface CertFixture {
  instructor_id: string;
  org: 'csia' | 'casi';
  track: 'regular' | 'park' | 'carving';
  level: number;
  is_partial: boolean;
  partial_components: string[] | null;
  achieved_on: string | null;
}

export interface TrainerFixture {
  instructor_id: string;
  org: 'csia' | 'casi';
  trainer_level: number | null;
  rookie_session_completed: boolean;
}

const T = '2026-01-01T00:00:00Z';

/** One instructor per lifecycle state. `approvedActive` is publicly visible. */
export const instructors: Record<string, InstructorFixture> = {
  pending: row('a0000000-0000-4000-8000-000000000001', 'pending', {
    approval_status: 'pending',
    is_active: true,
    display_name_en: 'Pat Pending',
  }),
  approvedActive: row('a0000000-0000-4000-8000-000000000002', 'approved', {
    approval_status: 'approved',
    is_active: true,
    display_name_en: 'Avery Approved',
    display_name_zh: '艾芙莉',
    bio_en: 'Veteran instructor.',
    bio_zh: '资深教练。',
  }),
  approvedInactive: row('a0000000-0000-4000-8000-000000000003', 'approved', {
    approval_status: 'approved',
    is_active: false,
    display_name_en: 'Ira Inactive',
  }),
  rejected: row('a0000000-0000-4000-8000-000000000004', 'rejected', {
    approval_status: 'rejected',
    is_active: false,
    display_name_en: 'Rex Rejected',
  }),
};

/** The visible instructor carries a full cert spread for formatter/filter tests. */
export const certifications: CertFixture[] = [
  cert('csia', 'regular', 4, false),
  cert('csia', 'park', 2, false),
  cert('casi', 'regular', 3, true, ['toe-side', 'switch']),
];

export const trainerStatus: TrainerFixture[] = [
  {
    instructor_id: instructors.approvedActive.id,
    org: 'csia',
    trainer_level: 2,
    rookie_session_completed: true,
  },
];

/** All fixtures as a flat list — convenient for seeding a fake/db. */
export function allInstructors(): InstructorFixture[] {
  return Object.values(instructors);
}

function row(
  id: string,
  seed: string,
  over: Partial<InstructorFixture>,
): InstructorFixture {
  return {
    id,
    auth_user_id: id.replace('a000', 'b000'),
    email: `${seed}@example.com`,
    display_name_en: 'Instructor',
    display_name_zh: null,
    bio_en: null,
    bio_zh: null,
    date_of_birth: null,
    profile_photo_url: null,
    preferred_language: 'en',
    approval_status: 'pending',
    is_active: true,
    inserted_at: T,
    updated_at: T,
    ...over,
  };
}

function cert(
  org: CertFixture['org'],
  track: CertFixture['track'],
  level: number,
  isPartial: boolean,
  partialComponents: string[] | null = null,
): CertFixture {
  return {
    instructor_id: instructors.approvedActive.id,
    org,
    track,
    level,
    is_partial: isPartial,
    partial_components: partialComponents,
    achieved_on: T,
  };
}
