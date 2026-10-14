import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import type { BioDraftMode } from '../../bio-translation/bio-translator.interface';

/** POST /me/instructor/bio/draft body. */
export class BioDraftDto {
  @IsString()
  @MaxLength(2000)
  @Matches(/\S/, { message: 'text cannot be empty' })
  text!: string;

  @IsIn(['refine', 'translate'])
  mode!: BioDraftMode;
}
