import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ActivationService } from './activation.service';

/** `POST /me/activation/complete`: the portal calls it once the password is set. */
@Controller('me/activation')
@UseGuards(SupabaseAuthGuard, EmailVerifiedGuard)
export class MeActivationController {
  constructor(private readonly activation: ActivationService) {}

  /** 204; stamps `activated_at` on the caller's invite (idempotent). */
  @Post('complete')
  @HttpCode(HttpStatus.NO_CONTENT)
  complete(@CurrentUser() user: SupabaseJwtPayload): Promise<void> {
    return this.activation.complete(user.sub);
  }
}
