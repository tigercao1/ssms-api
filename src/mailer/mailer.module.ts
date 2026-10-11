import { Module } from '@nestjs/common';
import { EMAIL_SENDER } from './email-sender.interface';
import { EmailPreviewController } from './email-preview.controller';
import { MailerConfig } from './mailer.config';
import { MailerService } from './mailer.service';
import { ResendEmailSender } from './resend-email-sender';
import { EmailRenderer } from './templates/email-renderer';

/**
 * Notifications module: every transactional email (instructor status, auth,
 * season invites, admin alerts) rendered through one branded layout and sent
 * via {@link MailerService}.
 *
 * - {@link EMAIL_SENDER} → {@link ResendEmailSender} (REST API via fetch). Swap
 *   the binding to change providers.
 * - {@link EmailRenderer} renders the template registry (`templates/`) with
 *   copy from the shared i18n catalog (`src/i18n`, `email.*`).
 * - {@link EmailPreviewController} serves admin-only previews under
 *   `/admin/email-previews`.
 *
 * ConfigModule + DatabaseModule are @Global, so ConfigService and
 * SUPABASE_CLIENT are injectable without importing them here.
 */
@Module({
  controllers: [EmailPreviewController],
  providers: [
    MailerService,
    MailerConfig,
    EmailRenderer,
    { provide: EMAIL_SENDER, useClass: ResendEmailSender },
  ],
  exports: [MailerService],
})
export class MailerModule {}
