import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * Normalise a query param that may arrive as a single value or repeated values
 * into a string array. Express parses `?x=a&x=b` as `['a','b']` and `?x=a` as
 * `'a'`. Empty/absent → undefined (so the service treats it as "no filter").
 */
function toStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const arr = Array.isArray(value) ? value : [value];
  const cleaned = arr
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim());
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Coerce a query-string boolean (`'true'`/`'false'`) to a real boolean. */
function toBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Query DTO for `GET /public/v1/instructors` (PUBLIC_API_PLAN.md § List
 * endpoint). Validated by the global ValidationPipe (`whitelist` +
 * `forbidNonWhitelisted`), so unknown params are rejected. `page_size` is NOT a
 * param — it is fixed at 50 (LOCKED).
 */
export class ListInstructorsQueryDto {
  @IsOptional()
  @IsIn(['en', 'zh-CN'])
  locale: 'en' | 'zh-CN' = 'en';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Transform(({ value }) => toStringArray(value))
  @IsString({ each: true })
  location?: string[];

  @IsOptional()
  @Transform(({ value }) => toStringArray(value))
  @IsString({ each: true })
  language?: string[];

  @IsOptional()
  @Transform(({ value }) => toStringArray(value))
  @IsIn(['ski', 'snowboard'], { each: true })
  discipline?: Array<'ski' | 'snowboard'>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  min_csia_level?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(4)
  min_casi_level?: number;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  trainers_only = false;

  @IsOptional()
  @IsIn(['name', 'seniority'])
  sort: 'name' | 'seniority' = 'name';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}
