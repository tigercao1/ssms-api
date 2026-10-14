import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  CERTIFICATION_CONTENT_TYPES,
  type CertificationContentType,
  MAX_CERTIFICATION_BYTES,
} from '../certification-files';
import {
  CERT_ORGS,
  CERT_TRACKS,
  type CertOrg,
  type CertTrack,
  type ReviewStatus,
} from '../documents.types';

export const REVIEW_STATUSES: readonly ReviewStatus[] = [
  'pending',
  'approved',
  'rejected',
];
export const REVIEW_NOTE_MAX_LENGTH = 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = 'validUntil must be a YYYY-MM-DD date';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CertificationUploadUrlDto {
  @IsIn(CERT_ORGS)
  org!: CertOrg;

  @IsIn(CERT_TRACKS)
  track!: CertTrack;

  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true }, { message: DATE_MESSAGE })
  validUntil!: string;

  @Transform(lower)
  @IsIn(CERTIFICATION_CONTENT_TYPES)
  contentType!: CertificationContentType;

  @IsInt()
  @Min(1)
  @Max(MAX_CERTIFICATION_BYTES)
  contentLength!: number;
}

export class ReviewCertificationUploadDto {
  @IsIn(REVIEW_STATUSES)
  reviewStatus!: ReviewStatus;

  @IsOptional()
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(REVIEW_NOTE_MAX_LENGTH)
  reviewNote?: string | null;

  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true }, { message: DATE_MESSAGE })
  validUntil?: string;
}
