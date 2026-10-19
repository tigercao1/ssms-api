import { Injectable } from '@nestjs/common';
import {
  CertificationUploadsRepository,
  type ReviewCandidateRow,
  type ReviewInstructorRow,
} from './certification-uploads.repository';
import { currentUploads, torontoToday } from './certification-validity';
import type {
  CertificationUploadReviewItem,
  DocumentReviewFilter,
  DocumentReviewInstructor,
  DocumentReviewItem,
} from './document-reviews.types';
import { toCertUpload } from './documents.presenters';

export const DECIDED_REVIEW_WINDOW_DAYS = 30;
export const DECIDED_REVIEW_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

const instructorCertKey = (instructorId: string, org: string, track: string) =>
  `${instructorId}:${org}:${track}`;

function toInstructor(row: ReviewInstructorRow): DocumentReviewInstructor {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    displayNameEn: row.display_name_en,
    displayNameZh: row.display_name_zh,
  };
}

/**
 * Instructor-submitted documents across every instructor that need (or got)
 * a manual decision. Decisions go through each type's own review endpoint.
 */
@Injectable()
export class AdminDocumentReviewsService {
  constructor(private readonly uploads: CertificationUploadsRepository) {}

  /**
   * `pending`: every current pending item, oldest first. `decided`: items
   * approved or rejected in the last {@link DECIDED_REVIEW_WINDOW_DAYS} days,
   * newest decision first, at most {@link DECIDED_REVIEW_LIMIT}.
   */
  async list(
    filter: DocumentReviewFilter,
    now = new Date(),
  ): Promise<DocumentReviewItem[]> {
    return this.certificationUploads(filter, now);
  }

  private async certificationUploads(
    filter: DocumentReviewFilter,
    now: Date,
  ): Promise<CertificationUploadReviewItem[]> {
    const rows =
      filter === 'pending'
        ? await this.uploads.listPendingReview()
        : await this.uploads.listReviewedSince(
            new Date(
              now.getTime() - DECIDED_REVIEW_WINDOW_DAYS * DAY_MS,
            ).toISOString(),
            DECIDED_REVIEW_LIMIT,
          );
    const withInstructor = rows.filter(
      (row): row is ReviewCandidateRow & { instructor: ReviewInstructorRow } =>
        row.instructor !== null,
    );
    if (withInstructor.length === 0) {
      return [];
    }
    const instructorIds = [
      ...new Set(withInstructor.map((row) => row.instructor_id)),
    ];
    const [keys, certifications] = await Promise.all([
      this.uploads.listUploadKeys(instructorIds),
      this.uploads.listCertifications(instructorIds),
    ]);
    const currentIds = new Set<string>();
    for (const instructorId of instructorIds) {
      const current = currentUploads(
        keys
          .filter((k) => k.instructor_id === instructorId)
          .map((k) => ({ ...k, insertedAt: k.inserted_at })),
      );
      for (const upload of current.values()) {
        currentIds.add(upload.id);
      }
    }
    const levels = new Map(
      certifications.map((c) => [
        instructorCertKey(c.instructor_id, c.org, c.track),
        c.level,
      ]),
    );
    const today = torontoToday(now);
    return withInstructor
      .filter((row) => filter !== 'pending' || currentIds.has(row.id))
      .map((row) => ({
        type: 'certification_upload',
        id: row.id,
        instructor: toInstructor(row.instructor),
        submittedAt: row.inserted_at,
        reviewStatus: row.review_status,
        reviewNote: row.review_note,
        reviewedAt: row.reviewed_at,
        contentType: row.content_type,
        certificationUpload: toCertUpload(row, currentIds.has(row.id), today),
        level:
          levels.get(
            instructorCertKey(row.instructor_id, row.org, row.track),
          ) ?? null,
      }));
  }
}
