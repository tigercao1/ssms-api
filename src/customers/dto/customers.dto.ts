import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const CUSTOMER_SEARCH_DEFAULT_LIMIT = 20;
export const CUSTOMER_SEARCH_MAX_LIMIT = 100;
export const CUSTOMER_NAME_MAX_LENGTH = 255;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const blankToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export class SearchCustomersQueryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CUSTOMER_SEARCH_MAX_LIMIT)
  limit?: number;
}

export class CreateCustomerDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(CUSTOMER_NAME_MAX_LENGTH)
  firstName!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(CUSTOMER_NAME_MAX_LENGTH)
  lastName!: string;

  @IsOptional()
  @Transform(blankToUndefined)
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @Transform(blankToUndefined)
  @Matches(/^\+?[0-9][0-9 ().-]{5,24}$/, {
    message: 'phone must be a phone number, e.g. +16475550100',
  })
  phone?: string;
}

export class SyncCustomersDto {
  @IsOptional()
  @IsBoolean()
  full?: boolean;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  cursor?: string;
}
