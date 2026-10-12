import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

export class ListClassesQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @IsUUID()
  instructorId?: string;
}
