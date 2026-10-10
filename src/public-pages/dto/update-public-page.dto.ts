import { IsString, Length, Matches } from 'class-validator';
import { PAGE_TITLE_MAX_LENGTH } from '../public-pages.types';

export class UpdatePublicPageDto {
  @IsString()
  @Length(1, PAGE_TITLE_MAX_LENGTH)
  @Matches(/\S/, { message: 'title must not be blank' })
  title!: string;
}
