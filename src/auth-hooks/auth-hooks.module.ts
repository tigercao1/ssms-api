import { Module } from '@nestjs/common';
import {
  InstructorsRepository,
  SupabaseInstructorsRepository,
} from '../instructors/instructors.repository';
import { MailerModule } from '../mailer/mailer.module';
import { HookSignatureVerifier } from './hook-signature.verifier';
import { HookThrottlerGuard } from './hook-throttler.guard';
import { SendEmailHookController } from './send-email-hook.controller';
import { SendEmailHookService } from './send-email-hook.service';

/**
 * AuthHooksModule — HTTP endpoints Supabase Auth calls (`/hooks/auth/*`).
 *
 * The Send Email hook renders every auth email through {@link MailerModule}.
 * Requests are verified with `SEND_EMAIL_HOOK_SECRET`; the app must be created
 * with `rawBody: true` so the signature can be checked against the exact bytes
 * Supabase signed.
 */
@Module({
  imports: [MailerModule],
  controllers: [SendEmailHookController],
  providers: [
    HookSignatureVerifier,
    HookThrottlerGuard,
    SendEmailHookService,
    { provide: InstructorsRepository, useClass: SupabaseInstructorsRepository },
  ],
})
export class AuthHooksModule {}
