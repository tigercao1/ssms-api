import type {
  CertOrg,
  CertTrack,
  TrainerDiscipline,
} from '../instructors/cert-display.formatter';

export const SSMS_INSTRUCTOR_TYPE = 'ssms_instructor';

export type PublishableStatus = 'ACTIVE' | 'DRAFT';

export interface SyncInstructorRow {
  id: string;
  display_name_en: string;
  display_name_zh: string | null;
  bio_en: string | null;
  bio_zh: string | null;
  profile_photo_url: string | null;
  profile_photo_version: string | null;
  min_student_age: number | null;
  approval_status: string;
  is_active: boolean;
}

export interface SyncCertRow {
  org: CertOrg;
  track: CertTrack;
  level: number;
  is_partial: boolean;
}

export interface SyncTrainerRow {
  discipline: TrainerDiscipline;
  trainer_level: number | null;
}

export interface InstructorSnapshot {
  instructor: SyncInstructorRow;
  locations: string[];
  languages: string[];
  courseLevels: string[];
  examPreparations: string[];
  certifications: SyncCertRow[];
  trainers: SyncTrainerRow[];
}

export interface InstructorShopifyState {
  instructor_id: string;
  shopify_metaobject_id: string | null;
  shopify_handle: string | null;
  shopify_photo_file_id: string | null;
  synced_photo_version: string | null;
  last_synced_at: string | null;
  last_status: string | null;
}

export type InstructorShopifyStatePatch = Partial<
  Omit<InstructorShopifyState, 'instructor_id'>
>;

export interface SyncQueueRow {
  instructor_id: string;
  enqueued_at: string;
  attempts: number;
  last_error: string | null;
}

export interface ReconcileCounts {
  instructors: number;
  orphaned: number;
}

export interface ShopifyFieldInput {
  key: string;
  value: string;
}

export function isVisible(instructor: SyncInstructorRow): boolean {
  return instructor.approval_status === 'approved' && instructor.is_active;
}
