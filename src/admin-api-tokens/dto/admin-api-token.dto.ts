import { Transform } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateAdminApiTokenDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ValidateIf((_, value) => value !== null)
  @IsISO8601({ strict: true })
  expiresAt!: string | null;
}

export class RotateAdminApiTokenDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(1440)
  graceMinutes?: number;

  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsISO8601({ strict: true })
  expiresAt?: string | null;
}
