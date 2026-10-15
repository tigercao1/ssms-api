import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  DOCUMENT_AUDIENCES,
  DOCUMENT_KINDS,
  type DocumentAudience,
  type DocumentKind,
  FIELD_PREFILLS,
  FIELD_TYPES,
  type FieldPrefill,
  type FieldType,
  TEMPLATE_ASSIGN_TO,
  type TemplateAssignTo,
} from '../documents.types';
import { SEASON_MAX_LENGTH } from './assignment.dto';
import { MAX_TEMPLATE_BYTES } from '../template-pdf';

export const TEMPLATE_TITLE_MAX_LENGTH = 200;
export const TEMPLATE_DESCRIPTION_MAX_LENGTH = 2000;
export const FIELD_LABEL_MAX_LENGTH = 200;
export const MAX_FIELDS = 200;
export const FIELD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateTemplateDto {
  @IsIn(DOCUMENT_KINDS)
  kind!: DocumentKind;

  @IsIn(DOCUMENT_AUDIENCES)
  audience!: DocumentAudience;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(TEMPLATE_TITLE_MAX_LENGTH)
  titleEn!: string;

  @IsOptional()
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(TEMPLATE_TITLE_MAX_LENGTH)
  titleZh?: string | null;

  @IsOptional()
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(TEMPLATE_DESCRIPTION_MAX_LENGTH)
  descriptionEn?: string | null;

  @IsOptional()
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(TEMPLATE_DESCRIPTION_MAX_LENGTH)
  descriptionZh?: string | null;

  @IsBoolean()
  required!: boolean;

  @IsInt()
  sortOrder!: number;
}

export class UpdateTemplateDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(TEMPLATE_TITLE_MAX_LENGTH)
  titleEn?: string;

  @IsOptional()
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(TEMPLATE_TITLE_MAX_LENGTH)
  titleZh?: string | null;

  @IsOptional()
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(TEMPLATE_DESCRIPTION_MAX_LENGTH)
  descriptionEn?: string | null;

  @IsOptional()
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(TEMPLATE_DESCRIPTION_MAX_LENGTH)
  descriptionZh?: string | null;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SourceUploadUrlDto {
  @IsInt()
  @Min(1)
  @Max(MAX_TEMPLATE_BYTES)
  contentLength!: number;
}

export class TemplateFieldDto {
  @Matches(FIELD_ID_PATTERN)
  id!: string;

  @IsIn(FIELD_TYPES)
  type!: FieldType;

  @IsInt()
  @Min(1)
  page!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  x!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  y!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  w!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  h!: number;

  @IsBoolean()
  required!: boolean;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(FIELD_LABEL_MAX_LENGTH)
  labelEn!: string;

  @IsOptional()
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(FIELD_LABEL_MAX_LENGTH)
  labelZh?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsIn(FIELD_PREFILLS)
  prefill?: FieldPrefill | null;
}

export class PutTemplateFieldsDto {
  @IsArray()
  @ArrayMaxSize(MAX_FIELDS)
  @ValidateNested({ each: true })
  @Type(() => TemplateFieldDto)
  fields!: TemplateFieldDto[];
}

export class PublishTemplateDto {
  @IsIn(TEMPLATE_ASSIGN_TO)
  assignTo!: TemplateAssignTo;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(SEASON_MAX_LENGTH)
  season?: string;
}

export class PublishPreviewQueryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(SEASON_MAX_LENGTH)
  season?: string;
}
