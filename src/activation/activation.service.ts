import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS } from '../audit/audit.types';
import { DocumentOnboardingService } from '../documents/document-onboarding.service';
import type {
  InviteRow,
  RedeemedInvite,
  ResendAccepted,
} from './activation.types';
import { ActivationAuth } from './activation-auth';
import { InviteDispatcher } from './invite-dispatcher';
import { hashInviteToken, isInviteExpired } from './invite-token';
import { InvitesRepository } from './invites.repository';
import { ResendCooldownRepository } from './resend-cooldown.repository';

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Lowercased, trimmed email: the form invites are stored and matched in. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashEmail(email: string): string {
  return createHash('sha256')
    .update(normalizeEmail(email), 'utf8')
    .digest('hex');
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
    private readonly onboarding: DocumentOnboardingService,
    private readonly cooldowns: ResendCooldownRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Unknown token → 404. Expired → 410 with `{ email, retryAfterSeconds }`,
   * the seconds until that email may request a new link. An invite whose auth
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
      throw new HttpException(
        {
          email: invite.email,
          retryAfterSeconds: await this.resendRetryAfter(invite.email),
        },
        HttpStatus.GONE,
      );
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
   * Emails a fresh invite link when a sent invite exists for `email`, it is
   * either not activated yet or expired, and its last link went out at least
   * a minute ago. Silent in every other case.
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
    const outcome = await this.dispatcher.resend(invite, now);
    if (outcome === 'cooling_down') {
      this.logger.log(
        `Invite resend ${invite.id} skipped: the last link went out under a minute ago`,
      );
    } else if (outcome !== 'sent') {
      this.logger.warn(`Invite resend ${invite.id} was ${outcome}`);
    }
  }

  async requestResend(email: string): Promise<ResendAccepted> {
    const claim = await this.cooldowns.claim(hashEmail(email));
    if (claim.accepted) {
      this.resendInBackground(email);
    }
    return { status: 'accepted', retryAfterSeconds: claim.retryAfterSeconds };
  }

  /** Runs {@link resend} without letting the caller observe its timing or errors. */
  resendInBackground(email: string): void {
    this.resend(email).catch((err: unknown) => {
      this.logger.error(
        `Invite resend failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Stamps `activated_at` on the caller's invites (a no-op when already set or
   * absent), approves the invited instructor if they are still pending and
   * active, then assigns the published onboarding documents to an approved
   * instructor. Approval and assignment failures are logged and never fail
   * activation.
   */
  async complete(authUserId: string): Promise<void> {
    await this.invites.markActivated(authUserId, new Date());
    const invite = await this.latestInvite(authUserId);
    if (invite) {
      await this.approveInvitedInstructor(invite);
      await this.onboarding.assignPublished(invite.instructor_id);
    } else {
      await this.onboarding.assignPublishedForAuthUser(authUserId);
    }
  }

  private async resendRetryAfter(email: string): Promise<number> {
    try {
      return await this.cooldowns.retryAfterSeconds(hashEmail(email));
    } catch (err) {
      this.logger.error(
        `Could not load the resend cooldown: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  private async latestInvite(authUserId: string): Promise<InviteRow | null> {
    try {
      return await this.invites.findLatestByAuthUser(authUserId);
    } catch (err) {
      this.logger.error(
        `Could not load the invite of the activated account: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async approveInvitedInstructor(invite: InviteRow): Promise<void> {
    let approved = false;
    try {
      approved = await this.invites.approveIfPendingAndActive(
        invite.instructor_id,
      );
    } catch (err) {
      this.logger.error(
        `Could not approve invited instructor ${invite.instructor_id}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (approved) {
      await this.audit.record({
        action: AUDIT_ACTIONS.instructorApprove,
        actor: { userId: null, role: 'system' },
        targetType: 'instructor',
        targetId: invite.instructor_id,
        metadata: {
          from: 'pending',
          to: 'approved',
          reason: null,
          source: 'invite_activation',
          inviteId: invite.id,
        },
      });
    }
  }
}
