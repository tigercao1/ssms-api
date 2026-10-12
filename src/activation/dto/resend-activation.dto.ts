import { IsEmail, MaxLength } from 'class-validator';

/** `POST /activation/resend` body. */
export class ResendActivationDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
