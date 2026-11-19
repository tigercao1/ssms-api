import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MAX_PAGE, MAX_PAGE_SIZE } from '../../database/pagination';
import {
  BUG_REPORT_SEVERITIES,
  BUG_REPORT_STATUSES,
  type BugReportSeverity,
  type BugReportStatus,
  MAX_SCREENSHOT_BYTES,
  SCREENSHOT_CONTENT_TYPES,
  type ScreenshotContentType,
} from '../bug-reports.types';

export const BUG_REPORT_DEFAULT_LIMIT = 25;

const FORMAT_CHARACTERS = /[\u202A-\u202E\u2066-\u2069]/g;
const CONTROL_EXCEPT_TAB_AND_NEWLINE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// eslint-disable-next-line no-control-regex
const ANY_CONTROL = /[\u0000-\u001F\u007F-\u009F]+/g;

export function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_EXCEPT_TAB_AND_NEWLINE, '')
    .replace(FORMAT_CHARACTERS, '')
    .trim();
}

export function cleanLine(value: string): string {
  return value.replace(ANY_CONTROL, ' ').replace(FORMAT_CHARACTERS, '').trim();
}

const clean =
  (fn: (value: string) => string, blank: string | null | undefined) =>
  ({ value }: { value: unknown }) =>
    typeof value === 'string' ? fn(value) || blank : value;

export class ScreenshotUploadUrlDto {
  @IsIn(SCREENSHOT_CONTENT_TYPES)
  contentType!: ScreenshotContentType;

  @IsInt()
  @Min(1)
  @Max(MAX_SCREENSHOT_BYTES)
  contentLength!: number;
}

export class SubmitBugReportDto {
  @Transform(clean(cleanText, ''))
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  description!: string;

  @IsOptional()
  @Transform(clean(cleanText, undefined))
  @IsString()
  @MaxLength(2000)
  expected?: string;

  @IsOptional()
  @IsIn(BUG_REPORT_SEVERITIES)
  severity?: BugReportSeverity;

  @Transform(clean(cleanLine, ''))
  @IsString()
  @MaxLength(500)
  pageUrl!: string;

  @IsOptional()
  @Transform(clean(cleanLine, undefined))
  @IsString()
  @MaxLength(64)
  appVersion?: string;

  @IsOptional()
  @Transform(clean(cleanLine, undefined))
  @IsString()
  @MaxLength(32)
  viewport?: string;

  @IsOptional()
  @Transform(clean(cleanLine, undefined))
  @IsString()
  @MaxLength(300)
  userAgent?: string;

  @IsOptional()
  @Transform(clean(cleanLine, undefined))
  @IsString()
  @MaxLength(200)
  screenshotKey?: string;
}

export class BugReportsQueryDto {
  @IsOptional()
  @IsIn(BUG_REPORT_STATUSES)
  status?: BugReportStatus;

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

export class UpdateBugReportDto {
  @IsOptional()
  @IsIn(BUG_REPORT_STATUSES)
  status?: BugReportStatus;

  @IsOptional()
  @Transform(clean(cleanText, null))
  @IsString()
  @MaxLength(2000)
  adminNote?: string | null;
}
