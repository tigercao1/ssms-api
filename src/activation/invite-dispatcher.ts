import { resolveEmailLanguage } from '../mailer/email-language';
import type { MailerService } from '../mailer/mailer.service';
import type { SendMode, SendOutcome } from '../mailer/mailer.types';
import type { InviteRecipient } from './activation.types';
import {
  INVITE_VALID_DAYS,
  type IssuedInviteToken,
  activationPath,
  inviteExpiryFor,
  issueInviteToken,
} from './invite-token';
import { InvitesRepository } from './invites.repository';

export type InviteTemplate = 'invite.season' | 'invite.reminder';
export type InviteMailer = Pick<MailerService, 'send' | 'portalLink'>;
export type ResendOutcome = SendOutcome | 'cooling_down';

export const RESEND_COOLDOWN_MS = 60_000;

/**
 * Issues a fresh invite token (replacing any earlier one, new 30-day expiry),
 * stores only its hash, and emails the activation link.
 */
export class InviteDispatcher {
  constructor(
    private readonly invites: InvitesRepository,
    private readonly mailer: InviteMailer,
  ) {}

  async dispatch(
    invite: InviteRecipient,
    template: InviteTemplate,
    mode: SendMode,
    now: Date = new Date(),
    idempotencyKey?: string,
  ): Promise<SendOutcome> {
    const issued = issueInviteToken(now);
    await this.invites.setToken(invite.id, issued.tokenHash, issued.expiresAt);
    return this.send(invite, issued, template, mode, idempotencyKey);
  }

  async resend(
    invite: InviteRecipient,
    now: Date = new Date(),
  ): Promise<ResendOutcome> {
    const issued = issueInviteToken(now);
    const replaced = await this.invites.replaceTokenIfExpiringBy(
      invite.id,
      issued.tokenHash,
      issued.expiresAt,
      inviteExpiryFor(new Date(now.getTime() - RESEND_COOLDOWN_MS)),
    );
    if (!replaced) {
      return 'cooling_down';
    }
    return this.send(
      invite,
      issued,
      'invite.season',
      'background',
      `invite-${invite.id}-resend-${now.toISOString()}`,
    );
  }

  private send(
    invite: InviteRecipient,
    issued: IssuedInviteToken,
    template: InviteTemplate,
    mode: SendMode,
    idempotencyKey: string | undefined,
  ): Promise<SendOutcome> {
    return this.mailer.send({
      template,
      to: invite.email,
      language: resolveEmailLanguage(invite.preferred_language),
      vars: {
        displayName: invite.display_name_en || undefined,
        season: invite.season,
        activateUrl: this.mailer.portalLink(activationPath(issued.token)),
        validDays: INVITE_VALID_DAYS,
      },
      mode,
      instructorId: invite.instructor_id,
      authUserId: invite.auth_user_id,
      metadata: { inviteId: invite.id, season: invite.season },
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }
}
