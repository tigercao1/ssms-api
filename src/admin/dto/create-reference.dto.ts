import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Body for `POST /admin/reference/:type` (T6.7). Adds one row to a reference
 * (lookup) table — teaching locations, languages, course levels, exam preps.
 *
 * `key` is the stable i18n key the frontend uses to look up a translated label
 * (e.g. `language.fr`); `name` is the canonical/default display string. A
 * duplicate `key` is rejected by the unique constraint (mapped to 409).
 */
export class CreateReferenceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  key!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  /** Lower sorts first; defaults to 0 to match the column default. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  /** Defaults to true (visible in public reference reads). */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
