import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_PAGE, MAX_PAGE_SIZE } from '../../database/pagination';
import { SEASON_KEY } from '../../seasons/dto/season.dto';
import type { PaymentStatus } from '../lesson-insurance.repository';

export const MAX_STUDENTS = 50;
export const MAX_REQUEST_LESSONS = 10;
export const INSURANCE_LIST_DEFAULT_LIMIT = 50;
export const PAYMENT_STATUSES: PaymentStatus[] = [
  'unpaid',
  'paid',
  'not_required',
  'voided',
];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = '$property must be a date in YYYY-MM-DD format';
const SEASON_MESSAGE = 'season must look like 2026/27';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class InsuranceSeasonQueryDto {
  @IsOptional()
  @Matches(SEASON_KEY, { message: SEASON_MESSAGE })
  season?: string;
}

export class InsuranceStudentDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsBoolean()
  waiverConfirmed!: boolean;
}

export class RegisterLessonDto {
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  lessonDate!: string;

  @IsIn([1, 2])
  durationHours!: 1 | 2;

  @IsOptional()
  @IsUUID('all')
  locationId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  locationOther?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_STUDENTS)
  @ValidateNested({ each: true })
  @Type(() => InsuranceStudentDto)
  students!: InsuranceStudentDto[];

  @IsOptional()
  @IsBoolean()
  topUp?: boolean;

  @IsUUID('all')
  idempotencyKey!: string;
}

export class RequestLessonDto {
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  lessonDate!: string;

  @IsIn([1, 2])
  durationHours!: 1 | 2;

  @IsOptional()
  @IsUUID('all')
  locationId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  locationOther?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_STUDENTS)
  @ValidateNested({ each: true })
  @Type(() => InsuranceStudentDto)
  students!: InsuranceStudentDto[];
}

export class SubmitInsuranceRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RequestLessonDto)
  lessons!: RequestLessonDto[];

  @IsUUID('all')
  idempotencyKey!: string;
}

export class GrantSeasonPassDto {
  @IsOptional()
  @Matches(SEASON_KEY, { message: SEASON_MESSAGE })
  season?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  paidOn?: string;
}

export class AdminInsuranceRecordsQueryDto extends InsuranceSeasonQueryDto {
  @IsOptional()
  @IsUUID('all')
  instructorId?: string;

  @IsOptional()
  @IsIn(PAYMENT_STATUSES)
  paymentStatus?: PaymentStatus;

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

export class MarkPaidDto {
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  paidOn?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class VoidRecordDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
