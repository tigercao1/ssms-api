import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsIP,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { JOTFORM_FORM_LANGUAGES } from '../jotform-imports.types';

const EMAIL_MAX_LENGTH = 254;
const ANSWER_MAX_LENGTH = 200;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const blankToUndefined = ({ value }: { value: unknown }) => {
  const trimmed = typeof value === 'string' ? value.trim() : value;
  return trimmed === '' ? undefined : trimmed;
};

/** Multipart fields of `POST /admin/signatures/jotform`; the file part is `pdf`. */
export class ImportJotformSignatureDto {
  @Matches(/^[0-9]{1,30}$/)
  submissionId!: string;

  @IsIn(Object.keys(JOTFORM_FORM_LANGUAGES))
  formId!: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/(Z|[+-]\d{2}:\d{2})$/)
  submittedAt!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(ANSWER_MAX_LENGTH)
  participantName!: string;

  @Transform(blankToUndefined)
  @IsOptional()
  @IsIP()
  ip?: string;

  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(ANSWER_MAX_LENGTH)
  typedDate?: string;

  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(ANSWER_MAX_LENGTH)
  idNumber?: string;

  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(ANSWER_MAX_LENGTH)
  guardianName?: string;

  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(ANSWER_MAX_LENGTH)
  witnessName?: string;
}
