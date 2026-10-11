import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsISO8601,
  IsString,
  MaxLength,
} from 'class-validator';

export const MAX_FREEBUSY_CALENDARS = 500;

function toIdList(value: unknown): unknown {
  const parts = Array.isArray(value) ? value : [value];
  if (!parts.every((part) => typeof part === 'string')) {
    return value;
  }
  return parts
    .flatMap((part) => part.split(','))
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

export class FreeBusyQueryDto {
  @Transform(({ value }) => toIdList(value))
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_FREEBUSY_CALENDARS)
  @IsString({ each: true })
  @MaxLength(1024, { each: true })
  calendarIds!: string[];

  @IsISO8601({ strict: true })
  from!: string;

  @IsISO8601({ strict: true })
  to!: string;
}
