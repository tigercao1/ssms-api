import { Module } from '@nestjs/common';
import { EmailPreviewController } from './email-preview.controller';
import { MailerCoreModule } from './mailer-core.module';

/**
 * Notifications module: every transactional email (instructor status, auth,
 * season invites, admin alerts) rendered through one branded layout and sent
 * via {@link MailerService}.
 *
 * - {@link MailerCoreModule} binds `EMAIL_SENDER` → `ResendEmailSender` (REST
 *   API via fetch). Swap the binding to change providers.
 * - `EmailRenderer` renders the template registry (`templates/`) with
 *   copy from the shared i18n catalog (`src/i18n`, `email.*`).
 * - {@link EmailPreviewController} serves admin-only previews under
 *   `/admin/email-previews`.
 *
 * ConfigModule + DatabaseModule are @Global, so ConfigService and
 * SUPABASE_CLIENT are injectable without importing them here.
 */
@Module({
  imports: [MailerCoreModule],
  controllers: [EmailPreviewController],
  exports: [MailerCoreModule],
})
export class MailerModule {}
