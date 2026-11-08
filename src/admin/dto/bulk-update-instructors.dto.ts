import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { UpdateInstructorProfileDto } from '../../instructors/dto/update-instructor-profile.dto';

export class BulkInstructorUpdateRowDto extends UpdateInstructorProfileDto {
  @IsUUID('4')
  id!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  displayOrder?: number | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;

  @ValidateIf((_, value) => value !== undefined)
  @IsIn(['approved', 'rejected'])
  approvalStatus?: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class BulkUpdateInstructorsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsObject({ each: true })
  updates!: BulkInstructorUpdateRowDto[];

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @IsOptional()
  @IsBoolean()
  atomic?: boolean;
}
