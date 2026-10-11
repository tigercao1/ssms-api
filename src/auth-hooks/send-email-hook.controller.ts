import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  type RawBodyRequest,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { HookErrorFilter } from './hook-error.filter';
import { HookSignatureVerifier } from './hook-signature.verifier';
import { HookThrottlerGuard } from './hook-throttler.guard';
import { SendEmailHookService } from './send-email-hook.service';
import { parseSendEmailHookPayload } from './send-email-hook.types';

/**
 * Supabase Auth "Send Email" HTTP hook. Public (no JWT): every call must carry
 * a valid Standard Webhooks signature over the raw body. Responds `200 {}` on
 * success and `{ "error": { "http_code", "message" } }` otherwise.
 */
@Controller('hooks/auth')
@UseFilters(HookErrorFilter)
@UseGuards(HookThrottlerGuard)
export class SendEmailHookController {
  constructor(
    private readonly verifier: HookSignatureVerifier,
    private readonly hook: SendEmailHookService,
  ) {}

  @Post('send-email')
  @HttpCode(HttpStatus.OK)
  async sendEmail(
    @Req() req: RawBodyRequest<Request>,
  ): Promise<Record<string, never>> {
    const body = this.verifier.verify(
      req.rawBody ?? Buffer.alloc(0),
      req.headers,
    );
    await this.hook.handle(parseSendEmailHookPayload(body));
    return {};
  }
}
