import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  NotEquals,
} from 'class-validator';

export const MAX_ADJUSTMENT = 1_000_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = '$property must be a date in YYYY-MM-DD format';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class ListPayrollPeriodsQueryDto {
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  around?: string;
}

export class UpdatePayrollSettingsDto {
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  anchorDate!: string;
}

export class CreatePayrollAdjustmentDto {
  @IsUUID()
  instructorId!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description!: string;

  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @NotEquals(0)
  @Min(-MAX_ADJUSTMENT)
  @Max(MAX_ADJUSTMENT)
  amount!: number;

  @IsOptional()
  @Transform(upper)
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter code' })
  currency?: string;
}

export class FinalizePayrollPeriodDto {
  @IsOptional()
  @IsBoolean()
  acceptZeroRate?: boolean;
}

export class ExportPayrollQueryDto {
  @IsOptional()
  @IsIn(['0', '1'])
  detail?: '0' | '1';
}
