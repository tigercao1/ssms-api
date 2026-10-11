import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import {
  ActivationThrottlerGuard,
  EMAIL_THROTTLER,
  HOUR_MS,
  IP_THROTTLER,
} from './activation-throttler.guard';
import { ActivationService } from './activation.service';
import {
  RESEND_ACCEPTED,
  type RedeemedInvite,
  type ResendAccepted,
} from './activation.types';
import { RedeemActivationDto } from './dto/redeem-activation.dto';
import { ResendActivationDto } from './dto/resend-activation.dto';

/**
 * Public season-invite endpoints (`/activation/*`), no JWT. Throttled per
 * client IP; resend is also throttled per email address.
 */
@Controller('activation')
@UseGuards(ActivationThrottlerGuard)
export class ActivationController {
  constructor(private readonly activation: ActivationService) {}

  /** 200 `{ email, tokenHash }`; 404 unknown token; 410 `{ email }` expired. */
  @Post('redeem')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle({ [EMAIL_THROTTLER]: true })
  redeem(@Body() dto: RedeemActivationDto): Promise<RedeemedInvite> {
    return this.activation.redeem(dto.token);
  }

  /** Always 202 `{ status: 'accepted' }`, whether or not the email has an invite. */
  @Post('resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ [IP_THROTTLER]: { limit: 3, ttl: HOUR_MS } })
  resend(@Body() dto: ResendActivationDto): ResendAccepted {
    this.activation.resendInBackground(dto.email);
    return RESEND_ACCEPTED;
  }
}
