import { Transform } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { RATE_UNITS, type RateUnit } from '../pay-rates';

export const MAX_HOURLY_RATE = 99_999_999.99;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = '$property must be a date in YYYY-MM-DD format';

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreatePayRateDto {
  @IsUUID()
  lessonTypeId!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  instructorId?: string | null;

  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_HOURLY_RATE)
  hourlyRate!: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsIn(RATE_UNITS)
  rateUnit?: RateUnit;

  @IsOptional()
  @Transform(upper)
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter code' })
  currency?: string;

  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  effectiveFrom!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  effectiveTo?: string | null;
}

export class UpdatePayRateDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_HOURLY_RATE)
  hourlyRate?: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsIn(RATE_UNITS)
  rateUnit?: RateUnit;

  @IsOptional()
  @Transform(upper)
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter code' })
  currency?: string;

  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  effectiveFrom?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  effectiveTo?: string | null;
}

export class ListPayRatesQueryDto {
  @IsOptional()
  @IsUUID()
  lessonTypeId?: string;

  @IsOptional()
  @IsUUID()
  instructorId?: string;

  @IsOptional()
  @IsIn(['default', 'override'])
  scope?: 'default' | 'override';
}

export class ResolvePayRateQueryDto {
  @IsUUID()
  instructorId!: string;

  @IsUUID()
  lessonTypeId!: string;

  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  date!: string;
}
