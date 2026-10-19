import { IsIn, IsOptional } from 'class-validator';
import {
  DOCUMENT_REVIEW_FILTERS,
  type DocumentReviewFilter,
} from '../document-reviews.types';

/** `GET /admin/document-reviews` query. */
export class DocumentReviewsQueryDto {
  @IsOptional()
  @IsIn(DOCUMENT_REVIEW_FILTERS)
  status?: DocumentReviewFilter;
}
