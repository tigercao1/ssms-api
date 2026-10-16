import {
  DatabaseError,
  PG_UNIQUE_VIOLATION,
} from '../../src/database/db-result';
import {
  type CertificationUploadKeyRow,
  CertificationUploadsRepository,
  type CertificationUploadWrite,
  type ExpiryCandidateRow,
  type InstructorCertificationKeyRow,
  type NewCertificationUploadRow,
} from '../../src/documents/certification-uploads.repository';
import type {
  CertificationUploadRow,
  ReviewStatus,
} from '../../src/documents/documents.types';
import type { MailerService } from '../../src/mailer/mailer.service';
import type {
  SendEmailRequest,
  SendOutcome,
} from '../../src/mailer/mailer.types';
import type { InMemoryDocumentSubjectsRepository } from './documents-fakes';

let clock = Date.parse('2026-10-05T00:00:00Z');
function nextTimestamp(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

/**
 * In-memory `certification_uploads` sharing rows, instructors and
 * certifications with an {@link InMemoryDocumentSubjectsRepository}.
 */
export class InMemoryCertificationUploadsRepository extends CertificationUploadsRepository {
  readonly languages = new Map<string, string>();
  readonly swaps: { id: string; sentAt: string | null }[] = [];

  constructor(private readonly subjects: InMemoryDocumentSubjectsRepository) {
    super();
  }

  private get rows(): CertificationUploadRow[] {
    return this.subjects.uploads;
  }

  findById(id: string): Promise<CertificationUploadRow | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }

  insert(row: NewCertificationUploadRow): Promise<CertificationUploadRow> {
    if (this.rows.some((r) => r.id === row.id)) {
      return Promise.reject(
        new DatabaseError(
          'create certification upload',
          PG_UNIQUE_VIOLATION,
          'duplicate key value violates unique constraint "certification_uploads_pkey"',
        ),
      );
    }
    const now = nextTimestamp();
    const full: CertificationUploadRow = {
      ...row,
      review_status: 'pending',
      review_note: null,
      reviewed_by: null,
      reviewed_at: null,
      expiry_reminder_sent_at: null,
      ai_result: null,
      ai_model: null,
      ai_checked_at: null,
      inserted_at: now,
      updated_at: now,
    };
    this.rows.push(full);
    return Promise.resolve(full);
  }

  update(
    id: string,
    patch: CertificationUploadWrite,
    fromStatuses?: ReviewStatus[],
  ): Promise<CertificationUploadRow | null> {
    const index = this.rows.findIndex(
      (r) =>
        r.id === id &&
        (!fromStatuses || fromStatuses.includes(r.review_status)),
    );
    if (index < 0) {
      return Promise.resolve(null);
    }
    this.rows[index] = {
      ...this.rows[index],
      ...patch,
      updated_at: nextTimestamp(),
    };
    return Promise.resolve(this.rows[index]);
  }

  listExpiryCandidates(
    fromDate: string,
    toDateExclusive: string,
  ): Promise<ExpiryCandidateRow[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (r) =>
            r.review_status !== 'rejected' &&
            r.valid_until >= fromDate &&
            r.valid_until < toDateExclusive,
        )
        .sort((a, b) => a.valid_until.localeCompare(b.valid_until))
        .map((r) => {
          const instructor = this.subjects.instructors.get(r.instructor_id);
          return {
            ...r,
            instructor: instructor
              ? {
                  id: instructor.id,
                  auth_user_id: instructor.auth_user_id,
                  email: instructor.email,
                  display_name_en: instructor.display_name_en,
                  preferred_language: this.languages.get(instructor.id) ?? 'en',
                  is_active: instructor.is_active,
                  approval_status: instructor.approval_status,
                }
              : null,
          };
        }),
    );
  }

  listUploadKeys(
    instructorIds: string[],
  ): Promise<CertificationUploadKeyRow[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => instructorIds.includes(r.instructor_id))
        .map(({ id, instructor_id, org, track, inserted_at }) => ({
          id,
          instructor_id,
          org,
          track,
          inserted_at,
        })),
    );
  }

  listCertifications(
    instructorIds: string[],
  ): Promise<InstructorCertificationKeyRow[]> {
    return Promise.resolve(
      instructorIds.flatMap((instructorId) =>
        (this.subjects.certifications.get(instructorId) ?? []).map((c) => ({
          instructor_id: instructorId,
          ...c,
        })),
      ),
    );
  }

  swapExpiryReminderSentAt(
    id: string,
    expected: string | null,
    sentAt: string | null,
  ): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.expiry_reminder_sent_at !== expected) {
      return Promise.resolve(false);
    }
    row.expiry_reminder_sent_at = sentAt;
    this.swaps.push({ id, sentAt });
    return Promise.resolve(true);
  }
}

/** Mailer double that records every request and answers with `outcome`. */
export function recordingMailer(outcome: SendOutcome = 'sent') {
  const sent: SendEmailRequest[] = [];
  const control = { outcome };
  const mailer = {
    send: (request: SendEmailRequest) => {
      sent.push(request);
      return Promise.resolve(control.outcome);
    },
    portalLink: (path: string) => `https://portal.example.com${path}`,
  };
  return { mailer: mailer as unknown as MailerService, sent, control };
}

/** Smallest bytes that pass each accepted type's signature check. */
export const FILE_SAMPLES = {
  'application/pdf': Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n'),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]),
  'image/png': Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
  ]),
  'image/webp': Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([8, 0, 0, 0]),
    Buffer.from('WEBPVP8 '),
  ]),
};
