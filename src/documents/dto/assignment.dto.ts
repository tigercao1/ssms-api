import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const SEASON_MAX_LENGTH = 20;
export const MAX_ASSIGN_INSTRUCTORS = 1000;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Exactly one of `instructorIds` and `allActiveInstructors: true` is required. */
export class CreateAssignmentsDto {
  @IsUUID('all')
  templateId!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(SEASON_MAX_LENGTH)
  season!: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_ASSIGN_INSTRUCTORS)
  @IsUUID('all', { each: true })
  instructorIds?: string[];

  @IsOptional()
  @IsBoolean()
  allActiveInstructors?: boolean;
}
