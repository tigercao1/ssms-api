import { IsIn, IsOptional } from 'class-validator';
import {
  DOCUMENT_REVIEW_FILTERS,
  type DocumentReviewFilter,
} from '../document-reviews.types';

export class DocumentReviewsQueryDto {
  @IsOptional()
  @IsIn(DOCUMENT_REVIEW_FILTERS)
  status?: DocumentReviewFilter;
}
