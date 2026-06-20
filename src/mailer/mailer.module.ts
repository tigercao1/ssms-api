import { Module } from '@nestjs/common';
import { MailerService } from './mailer.service';
import { EMAIL_SENDER } from './email-sender.interface';
import { ResendEmailSender } from './resend-email-sender';
import { NOTIFICATION_RENDERER } from './notification-renderer.interface';
import { I18nNotificationRenderer } from './templates/i18n-notification-renderer';

/**
 * Notifications module (ADMIN_ROLE_PLAN.md, AUTH_V1_DECISIONS.md).
 *
 * Exposes {@link MailerService} for the admin flow to fire transactional email
 * on approve / reject / deactivate. Sending is fire-and-forget with retry and
 * never rolls back the admin action.
 *
 * - {@link EMAIL_SENDER} → {@link ResendEmailSender} (REST API via fetch). Swap
 *   the binding to change providers.
 * - {@link NOTIFICATION_RENDERER} → {@link I18nNotificationRenderer} (`templates/`):
 *   renders approved/rejected/deactivated in en + zh-CN by `preferred_language`,
 *   sourcing copy from the shared i18n catalog (`src/i18n`).
 *
 * ConfigModule + DatabaseModule are @Global, so ConfigService and
 * SUPABASE_CLIENT are injectable without importing them here.
 */
@Module({
  providers: [
    MailerService,
    { provide: EMAIL_SENDER, useClass: ResendEmailSender },
    { provide: NOTIFICATION_RENDERER, useClass: I18nNotificationRenderer },
  ],
  exports: [MailerService],
})
export class MailerModule {}
