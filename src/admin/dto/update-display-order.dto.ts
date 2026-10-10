import { IsInt, Max, Min, ValidateIf } from 'class-validator';

export class UpdateDisplayOrderDto {
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  displayOrder!: number | null;
}
