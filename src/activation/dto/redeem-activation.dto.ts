import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** `POST /activation/redeem` body: the raw token from the invite link. */
export class RedeemActivationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  token!: string;
}
