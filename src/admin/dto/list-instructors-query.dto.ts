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
import {
  INSTRUCTOR_STAGES,
  type InstructorStage,
} from '../../shopify-sync/instructor-stage';
import type { ApprovalStatus } from '../admin.types';

export const INSTRUCTOR_LIST_DEFAULT_LIMIT = 50;

function toStageList(value: unknown): unknown {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const values: unknown[] = Array.isArray(value) ? value : [value];
  const cleaned = values
    .flatMap((v): unknown[] => (typeof v === 'string' ? v.split(',') : [v]))
    .map((v) => (typeof v === 'string' ? v.trim() : v))
    .filter((v) => v !== '');
  return cleaned.length > 0 ? [...new Set(cleaned)] : undefined;
}

/**
 * Query string for `GET /admin/instructors` (T6.3). Every filter is optional;
 * with none, every instructor of every status is returned.
 */
export class ListInstructorsQueryDto {
  /** Narrow by approval workflow state. */
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  status?: ApprovalStatus;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toStageList(value))
  @IsIn(INSTRUCTOR_STAGES, { each: true })
  stage?: InstructorStage[];

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
  @Transform(({ value }: { value: unknown }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  calendarConnected?: boolean;

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
