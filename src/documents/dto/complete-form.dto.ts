import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  Min,
} from 'class-validator';
import { DOCUMENT_LANGUAGES, type DocumentLanguage } from '../documents.types';

/** Body of `POST /sign/forms/:slug/complete`; the service checks answers against the version's fields. */
export class CompleteFormDto {
  @IsIn(DOCUMENT_LANGUAGES)
  lang!: DocumentLanguage;

  @IsInt()
  @Min(1)
  version!: number;

  @IsObject()
  answers!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  signatures?: Record<string, unknown>;

  @IsBoolean()
  consent!: boolean;
}

export class FormQueryDto {
  @IsOptional()
  @IsIn(DOCUMENT_LANGUAGES)
  lang?: DocumentLanguage;
}
