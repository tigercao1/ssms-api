import { IsString, Length, Matches } from 'class-validator';
import {
  PAGE_SLUG_MAX_LENGTH,
  PAGE_SLUG_PATTERN,
  PAGE_TITLE_MAX_LENGTH,
} from '../public-pages.types';

export class CreatePublicPageDto {
  @IsString()
  @Length(1, PAGE_SLUG_MAX_LENGTH)
  @Matches(PAGE_SLUG_PATTERN, {
    message: 'slug must be lowercase letters and digits separated by hyphens',
  })
  slug!: string;

  @IsString()
  @Length(1, PAGE_TITLE_MAX_LENGTH)
  @Matches(/\S/, { message: 'title must not be blank' })
  title!: string;
}
