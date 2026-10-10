import { IsOptional, IsUUID } from 'class-validator';

export class RunShopifySyncDto {
  @IsOptional()
  @IsUUID('4')
  instructorId?: string;
}
