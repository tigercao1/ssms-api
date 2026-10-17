import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isLocalUrl } from '../mailer/mailer.config';
import { MailerService } from '../mailer/mailer.service';
import { InviteDispatcher } from './invite-dispatcher';
import { remindDueInvites, type InviteDeliveryResult } from './invite-delivery';
import { InvitesRepository } from './invites.repository';

@Injectable()
export class InviteRemindersService {
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly invites: InvitesRepository,
    private readonly dispatcher: InviteDispatcher,
    private readonly mailer: MailerService,
    private readonly config: ConfigService,
  ) {}

  remind(
    season: string,
    canSend?: () => Promise<boolean>,
  ): Promise<InviteDeliveryResult> {
    const portal = this.mailer.portalLink('/');
    if (
      this.config.get<string>('NODE_ENV') === 'production' &&
      isLocalUrl(portal)
    ) {
      return Promise.reject(
        new Error(
          `PORTAL_URL is ${portal}, a local address; invite reminders must link to the real portal`,
        ),
      );
    }
    return remindDueInvites(
      {
        invites: this.invites,
        dispatcher: this.dispatcher,
        sleep: this.sleep,
        log: () => undefined,
        now: () => new Date(),
        canSend,
      },
      season,
    );
  }
}
