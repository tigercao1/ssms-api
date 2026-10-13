import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ROW_FILTERS, type RowFilter } from '../class-import.types';

export const MAX_EVENT_MAP_ENTRIES = 200;
export const MAX_EVENT_NAME_LENGTH = 500;

export class ClassImportQueryDto {
  @IsOptional()
  @IsIn(ROW_FILTERS)
  problem?: RowFilter;
}

export class UpdateClassImportRowDto {
  @IsOptional()
  @IsUUID()
  instructorId?: string;

  @IsOptional()
  @IsUUID()
  lessonTypeId?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  customerId?: string | null;
}

export class EventMapEntryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_EVENT_NAME_LENGTH)
  eventName!: string;

  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  lessonTypeId!: string | null;
}

export class SetEventMapDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_EVENT_MAP_ENTRIES)
  @ValidateNested({ each: true })
  @Type(() => EventMapEntryDto)
  mappings!: EventMapEntryDto[];
}
