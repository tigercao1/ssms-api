import { EmailDeliveryError } from '../mailer/mailer.types';
import type { InviteRecipient } from './activation.types';
import type { InviteDispatcher, InviteTemplate } from './invite-dispatcher';
import type { DeliveryKind, InvitesRepository } from './invites.repository';

export const SEND_INTERVAL_MS = 500;

export const DELIVERED_LABEL: Record<DeliveryKind, string> = {
  send: 'sent',
  remind: 'reminded',
};

const TEMPLATES: Record<DeliveryKind, InviteTemplate> = {
  send: 'invite.season',
  remind: 'invite.reminder',
};

export interface InviteDeliveryDeps {
  invites: InvitesRepository;
  dispatcher: InviteDispatcher;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  now: () => Date;
  canSend?: () => Promise<boolean>;
}

export interface InviteDeliveryFailure {
  inviteId: string;
  email: string;
  error: string;
}

export interface InviteDeliveryResult {
  candidates: number;
  sent: number;
  skipped: number;
  failed: InviteDeliveryFailure[];
  needsReview: string[];
}

type DeliveryOutcome = 'sent' | 'failed' | 'skipped' | 'needs_review';

export function inviteIdempotencyKey(
  inviteId: string,
  kind: DeliveryKind,
  claimedAt: Date,
): string {
  return `invite-${inviteId}-${kind === 'send' ? 'sent' : 'remind'}-${claimedAt.toISOString()}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function deliveryError(err: unknown): string {
  return err instanceof EmailDeliveryError
    ? `${err.outcome}: ${err.message}`
    : errorMessage(err);
}

async function deliverOne(
  deps: InviteDeliveryDeps,
  invite: InviteRecipient,
  kind: DeliveryKind,
  failed: InviteDeliveryFailure[],
): Promise<DeliveryOutcome> {
  const { invites, dispatcher } = deps;
  const template = TEMPLATES[kind];
  const claimedAt = deps.now();
  const fail = (err: unknown) => {
    const error = deliveryError(err);
    failed.push({ inviteId: invite.id, email: invite.email, error });
    deps.log(`  FAILED ${template} to ${invite.email}: ${error}`);
  };
  try {
    if (!(await invites.claim(invite.id, kind, claimedAt))) {
      deps.log(`  skipped invite ${invite.id}: claimed by another run`);
      return 'skipped';
    }
  } catch (err) {
    fail(err);
    return 'failed';
  }
  try {
    await dispatcher.dispatch(
      invite,
      template,
      'sync',
      claimedAt,
      inviteIdempotencyKey(invite.id, kind, claimedAt),
    );
  } catch (err) {
    fail(err);
    try {
      await invites.releaseClaim(invite.id, kind, claimedAt);
      return 'failed';
    } catch (releaseErr) {
      deps.log(
        `  could not release the claim on invite ${invite.id}: ${errorMessage(releaseErr)}`,
      );
      return 'needs_review';
    }
  }
  try {
    if (kind === 'send') {
      await invites.markSent(invite.id, claimedAt);
    } else {
      await invites.markReminded(invite.id, claimedAt);
    }
  } catch (err) {
    deps.log(
      `  sent ${template} to ${invite.email} but could not mark invite ${invite.id} ${DELIVERED_LABEL[kind]}: ${errorMessage(err)}`,
    );
    return 'needs_review';
  }
  deps.log(`  sent ${template} to ${invite.email}`);
  return 'sent';
}

export async function deliverInvites(
  deps: InviteDeliveryDeps,
  season: string,
  candidates: InviteRecipient[],
  kind: DeliveryKind,
): Promise<InviteDeliveryResult> {
  const needsReview = await deps.invites.listUnfinishedClaims(season, kind);
  const failed: InviteDeliveryFailure[] = [];
  let sent = 0;
  let skipped = 0;
  for (const [i, invite] of candidates.entries()) {
    if (i > 0) {
      await deps.sleep(SEND_INTERVAL_MS);
    }
    if (deps.canSend && !(await deps.canSend())) {
      break;
    }
    const outcome = await deliverOne(deps, invite, kind, failed);
    if (outcome === 'sent') {
      sent++;
    } else if (outcome === 'skipped') {
      skipped++;
    } else if (outcome === 'needs_review') {
      needsReview.push(invite.id);
    }
  }
  return { candidates: candidates.length, sent, skipped, failed, needsReview };
}

export async function remindDueInvites(
  deps: InviteDeliveryDeps,
  season: string,
): Promise<InviteDeliveryResult> {
  const candidates = await deps.invites.listDueForReminder(season, deps.now());
  return deliverInvites(deps, season, candidates, 'remind');
}
