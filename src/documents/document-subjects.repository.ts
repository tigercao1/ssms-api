import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { fetchAllPages } from '../database/pagination';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type {
  CertificationUploadRow,
  DocumentInstructorRow,
  InstructorCertificationRow,
} from './documents.types';

export const DOCUMENT_INSTRUCTOR_COLUMNS =
  'id, auth_user_id, email, first_name, last_name, display_name_en, ' +
  'approval_status, is_active, preferred_language';
export const CERTIFICATION_UPLOADS_TABLE = 'certification_uploads';
export const CERTIFICATION_UPLOAD_COLUMNS =
  'id, instructor_id, org, track, file_key, sha256, content_type, size_bytes, ' +
  'review_status, review_note, reviewed_by, reviewed_at, valid_until, verified_level, ' +
  'expiry_reminder_sent_at, ai_result, ai_model, ai_checked_at, inserted_at, updated_at';
export const INSTRUCTOR_ID_CHUNK = 100;

/**
 * Reads the people documents are addressed to: instructors, their
 * certification rows and their certification uploads.
 */
export abstract class DocumentSubjectsRepository {
  abstract findInstructorByAuthUser(
    authUserId: string,
  ): Promise<DocumentInstructorRow | null>;
  abstract findInstructor(id: string): Promise<DocumentInstructorRow | null>;
  /** Ids of every approved, active instructor. */
  abstract listActiveApprovedInstructorIds(): Promise<string[]>;
  /** How many instructors are approved and active. */
  abstract countActiveApprovedInstructors(): Promise<number>;
  /** How many instructors are waiting for approval. */
  abstract countPendingInstructors(): Promise<number>;
  /** The subset of `ids` that are instructors. */
  abstract existingInstructorIds(ids: string[]): Promise<Set<string>>;
  /** The instructor's `instructor_certifications` rows, by org then track. */
  abstract listCertifications(
    instructorId: string,
  ): Promise<InstructorCertificationRow[]>;
  /** Every certification upload of the instructor, newest first. */
  abstract listCertificationUploads(
    instructorId: string,
  ): Promise<CertificationUploadRow[]>;
  abstract listCertificationUploadsFor(
    instructorIds: readonly string[],
  ): Promise<Map<string, CertificationUploadRow[]>>;
}

@Injectable()
export class SupabaseDocumentSubjectsRepository extends DocumentSubjectsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async findInstructorByAuthUser(
    authUserId: string,
  ): Promise<DocumentInstructorRow | null> {
    const { data, error } = (await this.supabase
      .from('instructors')
      .select(DOCUMENT_INSTRUCTOR_COLUMNS)
      .eq('auth_user_id', authUserId)
      .maybeSingle()) as DbResult<DocumentInstructorRow>;
    check(error, 'load instructor');
    return data ?? null;
  }

  async findInstructor(id: string): Promise<DocumentInstructorRow | null> {
    const { data, error } = (await this.supabase
      .from('instructors')
      .select(DOCUMENT_INSTRUCTOR_COLUMNS)
      .eq('id', id)
      .maybeSingle()) as DbResult<DocumentInstructorRow>;
    check(error, 'load instructor');
    return data ?? null;
  }

  async listActiveApprovedInstructorIds(): Promise<string[]> {
    const { data, error } = (await this.supabase
      .from('instructors')
      .select('id')
      .eq('approval_status', 'approved')
      .eq('is_active', true)) as DbResult<{ id: string }[]>;
    check(error, 'list active instructors');
    return (data ?? []).map((row) => row.id);
  }

  async countActiveApprovedInstructors(): Promise<number> {
    const { count, error } = await this.supabase
      .from('instructors')
      .select('id', { count: 'exact', head: true })
      .eq('approval_status', 'approved')
      .eq('is_active', true);
    check(error, 'count active instructors');
    return count ?? 0;
  }

  async countPendingInstructors(): Promise<number> {
    const { count, error } = await this.supabase
      .from('instructors')
      .select('id', { count: 'exact', head: true })
      .eq('approval_status', 'pending');
    check(error, 'count pending instructors');
    return count ?? 0;
  }

  async existingInstructorIds(ids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += INSTRUCTOR_ID_CHUNK) {
      const { data, error } = (await this.supabase
        .from('instructors')
        .select('id')
        .in('id', ids.slice(i, i + INSTRUCTOR_ID_CHUNK))) as DbResult<
        { id: string }[]
      >;
      check(error, 'look up instructors');
      for (const row of data ?? []) {
        found.add(row.id);
      }
    }
    return found;
  }

  async listCertifications(
    instructorId: string,
  ): Promise<InstructorCertificationRow[]> {
    const { data, error } = (await this.supabase
      .from('instructor_certifications')
      .select('org, track, level')
      .eq('instructor_id', instructorId)
      .order('org', { ascending: true })
      .order('track', { ascending: true })) as DbResult<
      InstructorCertificationRow[]
    >;
    check(error, 'list instructor certifications');
    return data ?? [];
  }

  async listCertificationUploads(
    instructorId: string,
  ): Promise<CertificationUploadRow[]> {
    const { data, error } = (await this.supabase
      .from(CERTIFICATION_UPLOADS_TABLE)
      .select(CERTIFICATION_UPLOAD_COLUMNS)
      .eq('instructor_id', instructorId)
      .order('inserted_at', { ascending: false })) as DbResult<
      CertificationUploadRow[]
    >;
    check(error, 'list certification uploads');
    return data ?? [];
  }

  async listCertificationUploadsFor(
    instructorIds: readonly string[],
  ): Promise<Map<string, CertificationUploadRow[]>> {
    const byInstructor = new Map<string, CertificationUploadRow[]>();
    for (let i = 0; i < instructorIds.length; i += INSTRUCTOR_ID_CHUNK) {
      const ids = instructorIds.slice(i, i + INSTRUCTOR_ID_CHUNK);
      const rows = await fetchAllPages<CertificationUploadRow>(
        (from, to) =>
          this.supabase
            .from(CERTIFICATION_UPLOADS_TABLE)
            .select(CERTIFICATION_UPLOAD_COLUMNS)
            .in('instructor_id', ids)
            .order('inserted_at', { ascending: false })
            .order('id', { ascending: true })
            .range(from, to),
        'list certification uploads',
      );
      for (const row of rows) {
        byInstructor.set(row.instructor_id, [
          ...(byInstructor.get(row.instructor_id) ?? []),
          row,
        ]);
      }
    }
    return byInstructor;
  }
}
