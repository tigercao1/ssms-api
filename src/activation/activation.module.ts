import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { MailerModule } from '../mailer/mailer.module';
import { MailerService } from '../mailer/mailer.service';
import { ActivationAuth, SupabaseActivationAuth } from './activation-auth';
import { ActivationController } from './activation.controller';
import { ActivationService } from './activation.service';
import { InviteDispatcher } from './invite-dispatcher';
import { InviteRemindersService } from './invite-reminders.service';
import {
  InvitesRepository,
  SupabaseInvitesRepository,
} from './invites.repository';
import { MeActivationController } from './me-activation.controller';
import {
  ResendCooldownRepository,
  SupabaseResendCooldownRepository,
} from './resend-cooldown.repository';

/**
 * Season instructor invites: public redeem/resend under `/activation` and the
 * signed-in `POST /me/activation/complete`. Invite emails go through
 * {@link MailerService}; the roster import script reuses the same repository
 * and {@link InviteDispatcher}.
 */
@Module({
  imports: [MailerModule, DocumentsModule],
  controllers: [ActivationController, MeActivationController],
  providers: [
    ActivationService,
    { provide: InvitesRepository, useClass: SupabaseInvitesRepository },
    { provide: ActivationAuth, useClass: SupabaseActivationAuth },
    {
      provide: ResendCooldownRepository,
      useClass: SupabaseResendCooldownRepository,
    },
    {
      provide: InviteDispatcher,
      inject: [InvitesRepository, MailerService],
      useFactory: (invites: InvitesRepository, mailer: MailerService) =>
        new InviteDispatcher(invites, mailer),
    },
    InviteRemindersService,
  ],
  exports: [InviteRemindersService],
})
export class ActivationModule {}
