import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE, MAX_PAGE_SIZE } from '../../database/pagination';
import {
  TEMPLATE_ASSIGNMENT_FILTERS,
  type TemplateAssignmentFilter,
} from '../document-exports.types';
import { SEASON_MAX_LENGTH } from './assignment.dto';

export const MAX_EXPORT_FILES = 1000;
export const TEMPLATE_ASSIGNMENTS_DEFAULT_LIMIT = 50;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** `GET /admin/documents/templates/:id/assignments` query. */
export class TemplateAssignmentsQueryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(SEASON_MAX_LENGTH)
  season?: string;

  @IsOptional()
  @IsIn(TEMPLATE_ASSIGNMENT_FILTERS)
  status?: TemplateAssignmentFilter;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  q?: string;

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

/** `POST /admin/documents/templates/:id/exports`; without `assignmentIds`, every completed copy for the season. */
export class CreateDocumentExportDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(SEASON_MAX_LENGTH)
  season?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_EXPORT_FILES)
  @IsUUID('all', { each: true })
  assignmentIds?: string[];
}
