import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE, MAX_PAGE_SIZE } from '../../database/pagination';
import {
  DOCUMENT_REVIEW_FILTERS,
  type DocumentReviewFilter,
} from '../document-reviews.types';

export const DOCUMENT_REVIEWS_DEFAULT_LIMIT = 50;

export class DocumentReviewsQueryDto {
  @IsOptional()
  @IsIn(DOCUMENT_REVIEW_FILTERS)
  status?: DocumentReviewFilter;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}
