import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export const MAX_CUSTOMERS_PER_CLASS = 20;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_AVAILABILITY_INSTRUCTORS = 200;
export const BOOKABLE_STATUSES = ['scheduled', 'completed', 'no_show'] as const;
export type BookableStatus = (typeof BOOKABLE_STATUSES)[number];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = '$property must be a date in YYYY-MM-DD format';
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIME_MESSAGE = '$property must be a time in HH:MM format';

const commaList = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
    : value;

export class AvailabilityQueryDto {
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  date!: string;

  @IsUUID()
  lessonTypeId!: string;

  @IsOptional()
  @Transform(commaList)
  @IsArray()
  @ArrayMaxSize(MAX_AVAILABILITY_INSTRUCTORS)
  @IsUUID('all', { each: true })
  instructorIds?: string[];
}

export class RepeatDto {
  @IsBoolean()
  @Equals(true)
  weekly!: boolean;

  @IsInt()
  @Min(2)
  @Max(12)
  count!: number;
}

export class CreateBookingDto {
  @IsUUID()
  instructorId!: string;

  @IsUUID()
  lessonTypeId!: string;

  @IsISO8601({ strict: true })
  startsAt!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CUSTOMERS_PER_CLASS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  customerIds!: string[];

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  locationId?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(MAX_NOTES_LENGTH)
  notes?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => RepeatDto)
  repeat?: RepeatDto;

  @IsOptional()
  @IsIn(BOOKABLE_STATUSES)
  status?: BookableStatus;

  @IsOptional()
  @IsBoolean()
  addToCalendar?: boolean;
}

export class UpdateBookingDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  startsAt?: string;

  @IsOptional()
  @IsUUID()
  instructorId?: string;

  @IsOptional()
  @IsUUID()
  lessonTypeId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CUSTOMERS_PER_CLASS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  customerIds?: string[];

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(MAX_NOTES_LENGTH)
  notes?: string | null;
}

export class SetClassStatusDto {
  @IsIn(BOOKABLE_STATUSES)
  status!: BookableStatus;
}

export class BookingSettingsDto {
  @Matches(TIME_OF_DAY, { message: TIME_MESSAGE })
  dayStartTime!: string;

  @Matches(TIME_OF_DAY, { message: TIME_MESSAGE })
  dayEndTime!: string;

  @IsInt()
  @IsIn([15, 30, 60])
  slotMinutes!: number;

  @IsOptional()
  @IsObject()
  weekdayOverrides?: Record<string, unknown>;
}
