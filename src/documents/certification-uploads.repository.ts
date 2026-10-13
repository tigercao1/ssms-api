import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import {
  CERTIFICATION_UPLOAD_COLUMNS,
  CERTIFICATION_UPLOADS_TABLE,
  INSTRUCTOR_ID_CHUNK,
} from './document-subjects.repository';
import type {
  CertOrg,
  CertTrack,
  CertificationUploadRow,
} from './documents.types';

export const EXPIRY_INSTRUCTOR_COLUMNS =
  'id, auth_user_id, email, display_name_en, preferred_language, is_active';
export const EXPIRY_CANDIDATE_COLUMNS = `${CERTIFICATION_UPLOAD_COLUMNS}, instructor:instructors(${EXPIRY_INSTRUCTOR_COLUMNS})`;

/** A confirmed upload, inserted with the id issued at presign time. */
export type NewCertificationUploadRow = Pick<
  CertificationUploadRow,
  | 'id'
  | 'instructor_id'
  | 'org'
  | 'track'
  | 'file_key'
  | 'sha256'
  | 'content_type'
  | 'size_bytes'
  | 'valid_until'
>;

export type CertificationUploadWrite = Partial<
  Pick<
    CertificationUploadRow,
    | 'review_status'
    | 'review_note'
    | 'reviewed_by'
    | 'reviewed_at'
    | 'valid_until'
    | 'expiry_reminder_sent_at'
  >
>;

/** The instructor an expiry email goes to. */
export interface ExpiryInstructorRow {
  id: string;
  auth_user_id: string | null;
  email: string;
  display_name_en: string | null;
  preferred_language: string | null;
  is_active: boolean;
}

export interface ExpiryCandidateRow extends CertificationUploadRow {
  instructor: ExpiryInstructorRow | null;
}

/** Enough of an upload to tell which one is current per `(instructor, org, track)`. */
export interface CertificationUploadKeyRow {
  id: string;
  instructor_id: string;
  org: CertOrg;
  track: CertTrack;
  inserted_at: string;
}

/** One `instructor_certifications` row with its instructor. */
export interface InstructorCertificationKeyRow {
  instructor_id: string;
  org: CertOrg;
  track: CertTrack;
  level: number;
}

/** Writes and cross-instructor reads of `certification_uploads`. */
export abstract class CertificationUploadsRepository {
  abstract findById(id: string): Promise<CertificationUploadRow | null>;
  abstract insert(row: NewCertificationUploadRow): Promise<CertificationUploadRow>;
  abstract update(
    id: string,
    patch: CertificationUploadWrite,
  ): Promise<CertificationUploadRow | null>;
  /** Non-rejected uploads with `fromDate <= valid_until < toDateExclusive`, with their instructor. */
  abstract listExpiryCandidates(
    fromDate: string,
    toDateExclusive: string,
  ): Promise<ExpiryCandidateRow[]>;
  /** Every upload of the given instructors (keys only). */
  abstract listUploadKeys(
    instructorIds: string[],
  ): Promise<CertificationUploadKeyRow[]>;
  /** The `instructor_certifications` rows of the given instructors. */
  abstract listCertifications(
    instructorIds: string[],
  ): Promise<InstructorCertificationKeyRow[]>;
  /**
   * Sets `expiry_reminder_sent_at` to `sentAt` only while it still equals
   * `expected`; `false` when another run changed it first.
   */
  abstract swapExpiryReminderSentAt(
    id: string,
    expected: string | null,
    sentAt: string | null,
  ): Promise<boolean>;
}

@Injectable()
export class SupabaseCertificationUploadsRepository extends CertificationUploadsRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async findById(id: string): Promise<CertificationUploadRow | null> {
    const { data, error } = (await this.supabase
      .from(CERTIFICATION_UPLOADS_TABLE)
      .select(CERTIFICATION_UPLOAD_COLUMNS)
      .eq('id', id)
      .maybeSingle()) as DbResult<CertificationUploadRow>;
    check(error, 'load certification upload');
    return data ?? null;
  }

  async insert(row: NewCertificationUploadRow): Promise<CertificationUploadRow> {
    const { data, error } = (await this.supabase
      .from(CERTIFICATION_UPLOADS_TABLE)
      .insert(row)
      .select(CERTIFICATION_UPLOAD_COLUMNS)
      .single()) as DbResult<CertificationUploadRow>;
    check(error, 'create certification upload');
    return data as CertificationUploadRow;
  }

  async update(
    id: string,
    patch: CertificationUploadWrite,
  ): Promise<CertificationUploadRow | null> {
    const { data, error } = (await this.supabase
      .from(CERTIFICATION_UPLOADS_TABLE)
      .update(patch)
      .eq('id', id)
      .select(CERTIFICATION_UPLOAD_COLUMNS)
      .maybeSingle()) as DbResult<CertificationUploadRow>;
    check(error, 'update certification upload');
    return data ?? null;
  }

  async listExpiryCandidates(
    fromDate: string,
    toDateExclusive: string,
  ): Promise<ExpiryCandidateRow[]> {
    const { data, error } = (await this.supabase
      .from(CERTIFICATION_UPLOADS_TABLE)
      .select(EXPIRY_CANDIDATE_COLUMNS)
      .in('review_status', ['pending', 'approved'])
      .gte('valid_until', fromDate)
      .lt('valid_until', toDateExclusive)
      .order('valid_until', { ascending: true })) as DbResult<
      ExpiryCandidateRow[]
    >;
    check(error, 'list expiring certification uploads');
    return data ?? [];
  }

  async listUploadKeys(
    instructorIds: string[],
  ): Promise<CertificationUploadKeyRow[]> {
    return this.inChunks(instructorIds, async (ids) => {
      const { data, error } = (await this.supabase
        .from(CERTIFICATION_UPLOADS_TABLE)
        .select('id, instructor_id, org, track, inserted_at')
        .in('instructor_id', ids)) as DbResult<CertificationUploadKeyRow[]>;
      check(error, 'list certification upload keys');
      return data ?? [];
    });
  }

  async listCertifications(
    instructorIds: string[],
  ): Promise<InstructorCertificationKeyRow[]> {
    return this.inChunks(instructorIds, async (ids) => {
      const { data, error } = (await this.supabase
        .from('instructor_certifications')
        .select('instructor_id, org, track, level')
        .in('instructor_id', ids)) as DbResult<
        InstructorCertificationKeyRow[]
      >;
      check(error, 'list instructor certifications');
      return data ?? [];
    });
  }

  async swapExpiryReminderSentAt(
    id: string,
    expected: string | null,
    sentAt: string | null,
  ): Promise<boolean> {
    const query = this.supabase
      .from(CERTIFICATION_UPLOADS_TABLE)
      .update({ expiry_reminder_sent_at: sentAt })
      .eq('id', id);
    const guarded =
      expected === null
        ? query.is('expiry_reminder_sent_at', null)
        : query.eq('expiry_reminder_sent_at', expected);
    const { data, error } = (await guarded.select('id')) as DbResult<
      { id: string }[]
    >;
    check(error, 'record certification expiry reminder');
    return (data ?? []).length > 0;
  }

  private async inChunks<T>(
    ids: string[],
    load: (chunk: string[]) => Promise<T[]>,
  ): Promise<T[]> {
    const rows: T[] = [];
    for (let i = 0; i < ids.length; i += INSTRUCTOR_ID_CHUNK) {
      rows.push(...(await load(ids.slice(i, i + INSTRUCTOR_ID_CHUNK))));
    }
    return rows;
  }
}
