import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { MailerModule } from '../mailer/mailer.module';
import { MailerService } from '../mailer/mailer.service';
import { ActivationAuth, SupabaseActivationAuth } from './activation-auth';
import {
  ActivationThrottlerGuard,
  EMAIL_THROTTLER,
  HOUR_MS,
  IP_THROTTLER,
  MINUTE_MS,
  emailTracker,
} from './activation-throttler.guard';
import { ActivationController } from './activation.controller';
import { ActivationService } from './activation.service';
import { InviteDispatcher } from './invite-dispatcher';
import {
  InvitesRepository,
  SupabaseInvitesRepository,
} from './invites.repository';
import { MeActivationController } from './me-activation.controller';

/**
 * Season instructor invites: public redeem/resend under `/activation` and the
 * signed-in `POST /me/activation/complete`. Invite emails go through
 * {@link MailerService}; the roster import script reuses the same repository
 * and {@link InviteDispatcher}.
 */
@Module({
  imports: [
    MailerModule,
    ThrottlerModule.forRoot({
      throttlers: [
        { name: IP_THROTTLER, ttl: MINUTE_MS, limit: 10 },
        {
          name: EMAIL_THROTTLER,
          ttl: HOUR_MS,
          limit: 3,
          getTracker: emailTracker,
        },
      ],
    }),
  ],
  controllers: [ActivationController, MeActivationController],
  providers: [
    ActivationService,
    ActivationThrottlerGuard,
    { provide: InvitesRepository, useClass: SupabaseInvitesRepository },
    { provide: ActivationAuth, useClass: SupabaseActivationAuth },
    {
      provide: InviteDispatcher,
      inject: [InvitesRepository, MailerService],
      useFactory: (invites: InvitesRepository, mailer: MailerService) =>
        new InviteDispatcher(invites, mailer),
    },
  ],
})
export class ActivationModule {}
