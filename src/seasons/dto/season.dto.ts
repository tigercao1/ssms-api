import { IsISO8601, IsOptional, Matches } from 'class-validator';

export const SEASON_KEY = /^\d{4}\/\d{2}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MESSAGE = '$property must be a date in YYYY-MM-DD format';

export class CreateSeasonDto {
  @Matches(SEASON_KEY, { message: 'key must look like 2026/27' })
  key!: string;

  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  startsOn!: string;

  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  endsOn!: string;
}

export class UpdateSeasonDto {
  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  startsOn?: string;

  @IsOptional()
  @Matches(DATE_ONLY, { message: DATE_MESSAGE })
  @IsISO8601({ strict: true })
  endsOn?: string;
}
