import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export const SIGNER_NAME_MAX_LENGTH = 200;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Body of `POST /me/documents/:assignmentId/complete`. `read` documents send
 * `{ acknowledged: true }`; `sign` documents send `consent`, `signerName`,
 * `values` and `signatures`. Which fields are required depends on the
 * template, so the service checks them.
 */
export class CompleteDocumentDto {
  @IsOptional()
  @IsBoolean()
  acknowledged?: boolean;

  @IsOptional()
  @IsBoolean()
  consent?: boolean;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(SIGNER_NAME_MAX_LENGTH)
  signerName?: string;

  @IsOptional()
  @IsObject()
  values?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  signatures?: Record<string, unknown>;
}
