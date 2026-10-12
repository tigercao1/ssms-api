import {
  IsBoolean,
  IsIn,
  IsInt,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  LESSON_PRODUCT_STATUSES,
  LESSON_TYPES,
  type LessonProductStatus,
  type LessonType,
} from '../lessons.types';

const present = (_: object, value: unknown) => value !== undefined;
const presentAndNotNull = (_: object, value: unknown) =>
  value !== undefined && value !== null;

export const MAX_GROUP_SIZE = 50;
export const MAX_SESSIONS = 100;
export const MAX_DURATION_MIN = 1440;

export class UpdateLessonProductDto {
  @ValidateIf(present)
  @IsIn(LESSON_TYPES)
  lessonType?: LessonType;

  @ValidateIf(presentAndNotNull)
  @IsInt()
  @Min(1)
  @Max(MAX_GROUP_SIZE)
  groupSize?: number | null;

  @ValidateIf(presentAndNotNull)
  @IsInt()
  @Min(1)
  @Max(MAX_SESSIONS)
  sessions?: number | null;

  @ValidateIf(presentAndNotNull)
  @IsInt()
  @Min(1)
  @Max(MAX_DURATION_MIN)
  durationMin?: number | null;

  @ValidateIf(present)
  @IsBoolean()
  pricedPerStudent?: boolean;

  @ValidateIf(presentAndNotNull)
  @IsUUID()
  instructorId?: string | null;

  @ValidateIf(present)
  @IsIn(LESSON_PRODUCT_STATUSES)
  status?: LessonProductStatus;
}
