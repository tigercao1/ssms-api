import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * One structured certification row (CERTIFICATION_STRUCTURE.md). Highest-only
 * per (org, track); the DB enforces UNIQUE(instructor_id, org, track) and all
 * the CHECK constraints (carving ⇒ casi, park/carving never partial, etc.).
 * DTO-level validation covers the cheap shape checks; deep cross-field rules
 * are enforced transactionally in Postgres so they can never be bypassed.
 */
export class CertificationDto {
  @IsIn(['csia', 'casi'])
  org!: 'csia' | 'casi';

  @IsIn(['regular', 'park', 'carving'])
  track!: 'regular' | 'park' | 'carving';

  @IsInt()
  @Min(1)
  @Max(4)
  level!: number;

  @IsOptional()
  @IsBoolean()
  isPartial?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  partialComponents?: string[];

  /** ISO date (YYYY-MM-DD) when the highest level was reached. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'achievedOn must be an ISO date (YYYY-MM-DD)',
  })
  achievedOn?: string | null;
}
