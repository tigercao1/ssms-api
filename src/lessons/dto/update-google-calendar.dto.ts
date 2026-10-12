import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import type { CalendarMatchStatus } from '../instructor-calendars.repository';

export const GOOGLE_CALENDAR_ID_MAX_LENGTH = 320;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateGoogleCalendarDto {
  @Transform(trim)
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(1, GOOGLE_CALENDAR_ID_MAX_LENGTH)
  @Matches(/^\S+$/, { message: 'googleCalendarId must not contain spaces' })
  googleCalendarId!: string | null;

  @IsOptional()
  @IsIn(['suggested', 'confirmed'])
  matchStatus?: CalendarMatchStatus;
}
