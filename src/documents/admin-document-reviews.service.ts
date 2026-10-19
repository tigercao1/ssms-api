import { Injectable } from '@nestjs/common';
import { pageOffset } from '../database/pagination';
import {
  CertificationUploadsRepository,
  type ReviewQueueQuery,
  type ReviewQueueRow,
} from './certification-uploads.repository';
import { torontoToday } from './certification-validity';
import type {
  CertificationUploadReviewItem,
  DocumentReviewPage,
} from './document-reviews.types';
import { toCertUpload } from './documents.presenters';
import {
  DOCUMENT_REVIEWS_DEFAULT_LIMIT,
  type DocumentReviewsQueryDto,
} from './dto/document-review.dto';

export const DECIDED_REVIEW_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function toReviewItem(
  row: ReviewQueueRow,
  today: string,
): CertificationUploadReviewItem {
  return {
    type: 'certification_upload',
    id: row.id,
    instructor: {
      id: row.instructor_id,
      email: row.instructor_email,
      firstName: row.instructor_first_name,
      lastName: row.instructor_last_name,
      displayNameEn: row.instructor_display_name_en,
      displayNameZh: row.instructor_display_name_zh,
    },
    submittedAt: row.inserted_at,
    reviewStatus: row.review_status,
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    contentType: row.content_type,
    certificationUpload: toCertUpload(row, row.is_current, today),
    level: row.level,
  };
}

@Injectable()
export class AdminDocumentReviewsService {
  constructor(private readonly uploads: CertificationUploadsRepository) {}

  async list(
    query: DocumentReviewsQueryDto,
    now = new Date(),
  ): Promise<DocumentReviewPage> {
    const limit = query.limit ?? DOCUMENT_REVIEWS_DEFAULT_LIMIT;
    const filter: ReviewQueueQuery = {
      status: query.status ?? 'pending',
      since: new Date(
        now.getTime() - DECIDED_REVIEW_WINDOW_DAYS * DAY_MS,
      ).toISOString(),
      limit,
      offset: pageOffset(query.page ?? 1, limit),
    };
    const rows = await this.uploads.listReviewQueue(filter);
    const total =
      rows[0]?.total_count ??
      (filter.offset > 0 ? await this.countReviewQueue(filter) : 0);
    const today = torontoToday(now);
    return { items: rows.map((row) => toReviewItem(row, today)), total };
  }

  private async countReviewQueue(filter: ReviewQueueQuery): Promise<number> {
    const [first] = await this.uploads.listReviewQueue({
      ...filter,
      limit: 1,
      offset: 0,
    });
    return first?.total_count ?? 0;
  }
}
