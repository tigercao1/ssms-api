import { Module } from '@nestjs/common';
import { EMAIL_SENDER } from './email-sender.interface';
import { MailerConfig } from './mailer.config';
import { MailerService } from './mailer.service';
import { ResendEmailSender } from './resend-email-sender';
import { EmailRenderer } from './templates/email-renderer';

@Module({
  providers: [
    MailerService,
    MailerConfig,
    EmailRenderer,
    { provide: EMAIL_SENDER, useClass: ResendEmailSender },
  ],
  exports: [MailerService, EmailRenderer],
})
export class MailerCoreModule {}
