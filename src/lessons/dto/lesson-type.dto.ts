import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export const LESSON_TYPE_NAME_MAX_LENGTH = 200;
export const LESSON_TYPE_MAX_DURATION_MIN = 1440;
export const LESSON_TYPE_MAX_GROUP_SIZE = 100;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const toBoolean = ({ value }: { value: unknown }) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

export class CreateLessonTypeDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(LESSON_TYPE_NAME_MAX_LENGTH)
  nameEn!: string;

  @IsOptional()
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(LESSON_TYPE_NAME_MAX_LENGTH)
  nameZh?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(LESSON_TYPE_MAX_GROUP_SIZE)
  groupSize?: number | null;

  @IsInt()
  @Min(1)
  @Max(LESSON_TYPE_MAX_DURATION_MIN)
  durationMin!: number;

  @IsOptional()
  @IsBoolean()
  isPromo?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateLessonTypeDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(LESSON_TYPE_NAME_MAX_LENGTH)
  nameEn?: string;

  @IsOptional()
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(LESSON_TYPE_NAME_MAX_LENGTH)
  nameZh?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(LESSON_TYPE_MAX_GROUP_SIZE)
  groupSize?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(LESSON_TYPE_MAX_DURATION_MIN)
  durationMin?: number;

  @IsOptional()
  @IsBoolean()
  isPromo?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class ListLessonTypesQueryDto {
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  active?: boolean;
}
