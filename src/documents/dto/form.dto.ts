import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { FORM_FIELD_TYPES, type FormFieldType } from '../form-templates.types';
import { TEMPLATE_TITLE_MAX_LENGTH } from './template.dto';

export const FORM_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const FORM_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const FORM_BODY_MAX_LENGTH = 50_000;
export const FORM_MAX_FIELDS = 30;
export const LOOKUP_QUERY_MAX_LENGTH = 100;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateFormDto {
  @Matches(FORM_SLUG_PATTERN)
  @MaxLength(60)
  slug!: string;

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
}

export class UpdateFormDto {
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
}

export class FormFieldDto {
  @Matches(FORM_FIELD_KEY_PATTERN)
  key!: string;

  @IsIn(FORM_FIELD_TYPES)
  type!: FormFieldType;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(TEMPLATE_TITLE_MAX_LENGTH)
  label!: string;

  @IsBoolean()
  required!: boolean;
}

/** `PUT /admin/documents/forms/:id/versions/:lang`; `fields` defaults to the current ones, else the default waiver fields. */
export class SaveFormDraftDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(TEMPLATE_TITLE_MAX_LENGTH)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(FORM_BODY_MAX_LENGTH)
  bodyMarkdown!: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(FORM_MAX_FIELDS)
  @ValidateNested({ each: true })
  @Type(() => FormFieldDto)
  fields?: FormFieldDto[];
}

export class SignatureLookupQueryDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(LOOKUP_QUERY_MAX_LENGTH)
  q!: string;
}

export class StudentSignaturesQueryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(LOOKUP_QUERY_MAX_LENGTH)
  q?: string;
}
