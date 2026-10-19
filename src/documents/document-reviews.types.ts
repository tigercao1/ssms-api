/** Types for the admin queue of instructor-submitted documents awaiting manual review. */
import type { CertUpload, ReviewStatus } from './documents.types';

export const DOCUMENT_REVIEW_TYPES = ['certification_upload'] as const;
export type DocumentReviewType = (typeof DOCUMENT_REVIEW_TYPES)[number];

export const DOCUMENT_REVIEW_FILTERS = ['pending', 'decided'] as const;
export type DocumentReviewFilter = (typeof DOCUMENT_REVIEW_FILTERS)[number];

export interface DocumentReviewInstructor {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  displayNameEn: string | null;
  displayNameZh: string | null;
}

interface DocumentReviewItemBase<T extends DocumentReviewType> {
  type: T;
  id: string;
  instructor: DocumentReviewInstructor;
  submittedAt: string;
  reviewStatus: ReviewStatus;
  reviewNote: string | null;
  reviewedAt: string | null;
  contentType: string;
}

/** A certification upload; its file is served by `GET /admin/certification-uploads/:id/url`. */
export interface CertificationUploadReviewItem extends DocumentReviewItemBase<'certification_upload'> {
  certificationUpload: CertUpload;
  level: number | null;
}

/** One `GET /admin/document-reviews` item, discriminated by `type`. */
export type DocumentReviewItem = CertificationUploadReviewItem;
