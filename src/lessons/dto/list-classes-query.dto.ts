import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE, MAX_PAGE_SIZE } from '../../database/pagination';
import {
  CLASS_SORTS,
  CLASS_STATUSES,
  type ClassSort,
  type ClassStatus,
} from '../lessons.types';

export const CLASS_LIST_DEFAULT_LIMIT = 50;
export const CLASS_SEARCH_MAX_LENGTH = 100;

function toStatusList(value: unknown): unknown {
  const values: unknown[] = Array.isArray(value) ? value : [value];
  const cleaned = values
    .flatMap((v): unknown[] => (typeof v === 'string' ? v.split(',') : [v]))
    .map((v) => (typeof v === 'string' ? v.trim() : v))
    .filter((v) => v !== '' && v !== undefined && v !== null);
  return cleaned.length > 0 ? [...new Set(cleaned)] : undefined;
}

function toSearch(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export class ClassFiltersQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @IsUUID()
  instructorId?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toSearch(value))
  @IsString()
  @MaxLength(CLASS_SEARCH_MAX_LENGTH)
  q?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toStatusList(value))
  @IsIn(CLASS_STATUSES, { each: true })
  status?: ClassStatus[];

  @IsOptional()
  @IsUUID()
  lessonTypeId?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  createdFrom?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  createdTo?: string;

  @IsOptional()
  @IsIn(CLASS_SORTS)
  sort?: ClassSort;
}

export class ListClassesQueryDto extends ClassFiltersQueryDto {
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
