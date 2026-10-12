import { Transform } from 'class-transformer';
import { IsString, Length, Matches, ValidateIf } from 'class-validator';

export const GOOGLE_CALENDAR_ID_MAX_LENGTH = 320;

export class UpdateGoogleCalendarDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(1, GOOGLE_CALENDAR_ID_MAX_LENGTH)
  @Matches(/^\S+$/, { message: 'googleCalendarId must not contain spaces' })
  googleCalendarId!: string | null;
}
