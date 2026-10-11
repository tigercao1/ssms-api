import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { RedeemedInvite } from './activation.types';
import { ActivationAuth } from './activation-auth';
import { InviteDispatcher } from './invite-dispatcher';
import { hashInviteToken, isInviteExpired } from './invite-token';
import { InvitesRepository } from './invites.repository';

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Lowercased, trimmed email: the form invites are stored and matched in. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Season-invite activation: exchange an invite token for a Supabase sign-in,
 * re-issue expired links without revealing which emails exist, and record
 * when the instructor finished setting a password.
 */
@Injectable()
export class ActivationService {
  private readonly logger = new Logger(ActivationService.name);

  constructor(
    private readonly invites: InvitesRepository,
    private readonly auth: ActivationAuth,
    private readonly dispatcher: InviteDispatcher,
  ) {}

  /**
   * Unknown token → 404. Expired → 410 with `{ email }`. An invite whose auth
   * user's email has changed since it was issued is treated as unknown.
   * Otherwise returns a one-time magic-link token hash for the invite email
   * and stamps `redeemed_at` the first time.
   */
  async redeem(token: string): Promise<RedeemedInvite> {
    const invite = TOKEN_SHAPE.test(token)
      ? await this.invites.findByTokenHash(hashInviteToken(token))
      : null;
    if (!invite) {
      throw new NotFoundException('Invite not found');
    }
    const now = new Date();
    if (isInviteExpired(invite.expires_at, now)) {
      throw new HttpException({ email: invite.email }, HttpStatus.GONE);
    }
    const currentEmail = await this.auth.findEmail(invite.auth_user_id);
    if (!currentEmail) {
      throw new NotFoundException('Invite not found');
    }
    if (normalizeEmail(currentEmail) !== invite.email) {
      this.logger.warn(
        `Invite ${invite.id} not redeemed: the auth user's email no longer matches the invite`,
      );
      throw new NotFoundException('Invite not found');
    }
    const tokenHash = await this.auth.magicLinkTokenHash(invite.email);
    if (invite.redeemed_at === null) {
      await this.invites.markRedeemed(invite.id, now);
    }
    return { email: invite.email, tokenHash };
  }

  /**
   * Emails a fresh invite link when a sent invite exists for `email` and it is
   * either not activated yet or expired. Silent in every other case.
   */
  async resend(email: string): Promise<void> {
    const invite = await this.invites.findLatestByEmail(normalizeEmail(email));
    if (!invite || invite.sent_at === null) {
      return;
    }
    const now = new Date();
    if (
      invite.activated_at !== null &&
      !isInviteExpired(invite.expires_at, now)
    ) {
      return;
    }
    const outcome = await this.dispatcher.dispatch(
      invite,
      'invite.season',
      'background',
      now,
    );
    if (outcome !== 'sent') {
      this.logger.warn(`Invite resend ${invite.id} was ${outcome}`);
    }
  }

  /** Runs {@link resend} without letting the caller observe its timing or errors. */
  resendInBackground(email: string): void {
    this.resend(email).catch((err: unknown) => {
      this.logger.error(
        `Invite resend failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** Stamps `activated_at` on the caller's invites; a no-op when already set or absent. */
  async complete(authUserId: string): Promise<void> {
    await this.invites.markActivated(authUserId, new Date());
  }
}
