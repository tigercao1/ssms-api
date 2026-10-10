import { IsBoolean } from 'class-validator';

export class UpdateShopifySyncDto {
  @IsBoolean()
  enabled!: boolean;
}
