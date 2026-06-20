import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CertificationDto } from './certification.dto';
import { TrainerStatusDto } from './trainer-status.dto';
import { IsPastDateString } from './is-past-date-string.validator';

/**
 * PATCH /me/instructor body (T3.2). Every field is optional — submit only what
 * you want to change. Omitting a key leaves it untouched; sending an empty
 * array for a relation clears it (see CREATE_INSTRUCTOR_EXAMPLE.md § Notes).
 *
 * Deliberately ABSENT (backend-architecture.md §4, INSTRUCTOR_PROFILE_FIELDS.md):
 *   - `email`            — mirrored from auth.users; never user-editable.
 *   - `disciplineIds`    — disciplines are derived from certifications.
 *   - `csiaCertificationIds` / `casiCertificationIds` — replaced by structured
 *     `certifications[]` rows.
 *   - `approvalStatus`, `isActive` — admin-only.
 *
 * The global ValidationPipe runs with `whitelist + forbidNonWhitelisted`, so any
 * of the above sent by a client is rejected rather than silently applied.
 */
export class UpdateInstructorProfileDto {
  /**
   * Required for display; once set it cannot be blanked. Optional in a PATCH,
   * but when provided must be a non-empty, ≤100-char string.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'displayNameEn cannot be empty' })
  @MaxLength(100)
  displayNameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayNameZh?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  bioEn?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  bioZh?: string | null;

  /** ISO date (YYYY-MM-DD); must be a past date (re-checked in the DB CHECK). */
  @IsOptional()
  @IsPastDateString()
  dateOfBirth?: string | null;

  @IsOptional()
  @IsIn(['en', 'zh-CN'])
  preferredLanguage?: 'en' | 'zh-CN';

  /** Public URL produced by our signed-upload flow (MediaService). */
  @IsOptional()
  @IsString()
  profilePhotoUrl?: string | null;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  teachingLocationIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  languageIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  courseLevelOfferedIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CertificationDto)
  certifications?: CertificationDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TrainerStatusDto)
  trainerStatus?: TrainerStatusDto[];
}
