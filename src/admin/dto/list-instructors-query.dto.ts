import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE, MAX_PAGE_SIZE } from '../../database/pagination';
import type { ApprovalStatus } from '../admin.types';

export const INSTRUCTOR_LIST_DEFAULT_LIMIT = 50;

/**
 * Query string for `GET /admin/instructors` (T6.3). Both filters are optional;
 * with neither, every instructor of every status is returned.
 */
export class ListInstructorsQueryDto {
  /** Narrow by approval workflow state. */
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  status?: ApprovalStatus;

  /** Narrow by active flag. Accepts `true`/`false` (string or boolean). */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(200)
  q?: string;

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
