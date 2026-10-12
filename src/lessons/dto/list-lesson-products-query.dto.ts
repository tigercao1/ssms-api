import { IsIn, IsOptional } from 'class-validator';
import {
  LESSON_PRODUCT_STATUSES,
  type LessonProductStatus,
} from '../lessons.types';

export class ListLessonProductsQueryDto {
  @IsOptional()
  @IsIn(LESSON_PRODUCT_STATUSES)
  status?: LessonProductStatus;
}
