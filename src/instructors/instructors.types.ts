/**
 * Internal domain types for the Instructors module.
 * `*Row` types mirror DB column shapes (snake_case); the `InstructorProfile`
 * presenter type is the camelCase shape returned by `/me/instructor`.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type PreferredLanguage = 'en' | 'zh-CN';

/** Core `instructors` row (subset we read/return). */
export interface InstructorRow {
  id: string;
  auth_user_id: string;
  email: string;
  display_name_en: string;
  display_name_zh: string | null;
  bio_en: string | null;
  bio_zh: string | null;
  bio_en_machine_translated: boolean;
  bio_zh_machine_translated: boolean;
  date_of_birth: string | null;
  profile_photo_url: string | null;
  preferred_language: PreferredLanguage;
  approval_status: ApprovalStatus;
  is_active: boolean;
  inserted_at: string;
  updated_at: string;
}

/** A linked reference row (teaching location / language / course level). */
export interface ReferenceRow {
  id: string;
  key: string;
  name: string;
}

export interface CertificationRow {
  org: 'csia' | 'casi';
  track: 'regular' | 'park' | 'carving';
  level: number;
  is_partial: boolean;
  partial_components: string[];
  achieved_on: string | null;
}

export interface TrainerStatusRow {
  discipline: 'ski' | 'snowboard';
  rookie_session_completed: boolean;
  trainer_exam_passed: boolean;
  trainer_level: number | null;
}

/** camelCase presenter returned to the instructor (self view). */
export interface InstructorProfile {
  id: string;
  email: string;
  displayNameEn: string;
  displayNameZh: string | null;
  bioEn: string | null;
  bioZh: string | null;
  bioEnMachineTranslated: boolean;
  bioZhMachineTranslated: boolean;
  dateOfBirth: string | null;
  preferredLanguage: PreferredLanguage;
  approvalStatus: ApprovalStatus;
  isActive: boolean;
  profilePhotoUrl: string | null;
  teachingLocations: Array<{ id: string; key: string; name: string }>;
  languages: Array<{ id: string; key: string; name: string }>;
  courseLevelsOffered: Array<{ id: string; key: string; name: string }>;
  certifications: Array<{
    org: 'csia' | 'casi';
    track: 'regular' | 'park' | 'carving';
    level: number;
    isPartial: boolean;
    partialComponents: string[];
    achievedOn: string | null;
    display: string;
  }>;
  trainerStatus: Array<{
    discipline: 'ski' | 'snowboard';
    rookieSessionCompleted: boolean;
    trainerExamPassed: boolean;
    trainerLevel: number | null;
    display: string | null;
  }>;
}

/**
 * Snake_case JSONB patch handed to the `update_instructor_profile` RPC. Only
 * keys explicitly present are applied (omit = leave untouched; empty array =
 * clear the relation). See migration 210 + InstructorsService.buildPatch.
 */
export interface InstructorProfilePatch {
  display_name_en?: string;
  display_name_zh?: string | null;
  bio_en?: string | null;
  bio_zh?: string | null;
  date_of_birth?: string | null;
  preferred_language?: PreferredLanguage;
  profile_photo_url?: string | null;
  teaching_location_ids?: string[];
  language_ids?: string[];
  course_level_offered_ids?: string[];
  certifications?: Array<{
    org: string;
    track: string;
    level: number;
    is_partial: boolean;
    partial_components: string[];
    achieved_on: string | null;
  }>;
  trainer_status?: Array<{
    discipline: string;
    rookie_session_completed: boolean;
    trainer_exam_passed: boolean;
    trainer_level: number | null;
  }>;
}
