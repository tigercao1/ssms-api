import type {
  InviteRecipient,
  InviteRow,
} from '../../src/activation/activation.types';
import {
  type DeliveryKind,
  InvitesRepository,
} from '../../src/activation/invites.repository';
import {
  RESEND_COOLDOWN_SECONDS,
  type ResendClaim,
  ResendCooldownRepository,
} from '../../src/activation/resend-cooldown.repository';
import {
  type DailyReminderRunOutcome,
  DailyReminderRunsRepository,
} from '../../src/reminders/daily-reminder-runs.repository';

const DAY_MS = 24 * 60 * 60 * 1000;

const COLUMNS: Record<
  DeliveryKind,
  {
    claimed: 'send_claimed_at' | 'remind_claimed_at';
    done: 'sent_at' | 'reminded_at';
  }
> = {
  send: { claimed: 'send_claimed_at', done: 'sent_at' },
  remind: { claimed: 'remind_claimed_at', done: 'reminded_at' },
};

let inviteSeq = 0;

export function inviteRecipient(
  overrides: Partial<InviteRecipient> = {},
): InviteRecipient {
  inviteSeq += 1;
  return {
    id: `inv-${inviteSeq}`,
    instructor_id: `ins-${inviteSeq}`,
    auth_user_id: `auth-${inviteSeq}`,
    email: `instructor${inviteSeq}@example.test`,
    token_hash: 'a'.repeat(64),
    season: '2026/27',
    expires_at: null,
    send_claimed_at: null,
    sent_at: null,
    remind_claimed_at: null,
    reminded_at: null,
    redeemed_at: null,
    activated_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    display_name_en: 'Avery',
    preferred_language: 'en',
    ...overrides,
  };
}

export class InMemoryInvitesRepository extends InvitesRepository {
  readonly rows = new Map<string, InviteRecipient>();

  seed(overrides: Partial<InviteRecipient> = {}): InviteRecipient {
    const row = inviteRecipient(overrides);
    this.rows.set(row.id, row);
    return row;
  }

  findByTokenHash(tokenHash: string): Promise<InviteRow | null> {
    return Promise.resolve(
      [...this.rows.values()].find((r) => r.token_hash === tokenHash) ?? null,
    );
  }

  findLatestByEmail(email: string): Promise<InviteRecipient | null> {
    return Promise.resolve(
      [...this.rows.values()].find((r) => r.email === email) ?? null,
    );
  }

  findLatestByAuthUser(authUserId: string): Promise<InviteRow | null> {
    return Promise.resolve(
      [...this.rows.values()].find((r) => r.auth_user_id === authUserId) ??
        null,
    );
  }

  listUnsent(season: string): Promise<InviteRecipient[]> {
    return Promise.resolve(
      this.list(
        (r) =>
          r.season === season &&
          r.sent_at === null &&
          r.send_claimed_at === null,
      ),
    );
  }

  listDueForReminder(season: string, now: Date): Promise<InviteRecipient[]> {
    const sentBy = new Date(now.getTime() - 7 * DAY_MS).toISOString();
    return Promise.resolve(
      this.list(
        (r) =>
          r.season === season &&
          r.sent_at !== null &&
          r.sent_at <= sentBy &&
          r.redeemed_at === null &&
          r.activated_at === null &&
          r.reminded_at === null &&
          r.remind_claimed_at === null &&
          r.expires_at !== null &&
          r.expires_at > now.toISOString(),
      ),
    );
  }

  setToken(id: string, tokenHash: string, expiresAt: Date): Promise<void> {
    this.patch(id, {
      token_hash: tokenHash,
      expires_at: expiresAt.toISOString(),
    });
    return Promise.resolve();
  }

  replaceTokenIfExpiringBy(
    id: string,
    tokenHash: string,
    expiresAt: Date,
    currentExpiresBy: Date,
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (
      !row ||
      (row.expires_at !== null && new Date(row.expires_at) > currentExpiresBy)
    ) {
      return Promise.resolve(false);
    }
    this.patch(id, {
      token_hash: tokenHash,
      expires_at: expiresAt.toISOString(),
    });
    return Promise.resolve(true);
  }

  claim(id: string, kind: DeliveryKind, at: Date): Promise<boolean> {
    const { claimed, done } = COLUMNS[kind];
    const row = this.rows.get(id);
    if (!row || row[claimed] !== null || row[done] !== null) {
      return Promise.resolve(false);
    }
    this.patch(id, { [claimed]: at.toISOString() });
    return Promise.resolve(true);
  }

  releaseClaim(id: string, kind: DeliveryKind, claimedAt: Date): Promise<void> {
    const { claimed, done } = COLUMNS[kind];
    const row = this.rows.get(id);
    if (row && row[claimed] === claimedAt.toISOString() && row[done] === null) {
      this.patch(id, { [claimed]: null });
    }
    return Promise.resolve();
  }

  listUnfinishedClaims(season: string, kind: DeliveryKind): Promise<string[]> {
    const { claimed, done } = COLUMNS[kind];
    return Promise.resolve(
      this.list(
        (r) => r.season === season && r[claimed] !== null && r[done] === null,
      ).map((r) => r.id),
    );
  }

  releaseStaleClaims(): Promise<string[]> {
    return Promise.resolve([]);
  }

  markSent(id: string, at: Date): Promise<void> {
    this.patch(id, { sent_at: at.toISOString() });
    return Promise.resolve();
  }

  markReminded(id: string, at: Date): Promise<void> {
    this.patch(id, { reminded_at: at.toISOString() });
    return Promise.resolve();
  }

  markRedeemed(id: string, at: Date): Promise<void> {
    this.patch(id, { redeemed_at: at.toISOString() });
    return Promise.resolve();
  }

  markActivated(authUserId: string, at: Date): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.auth_user_id === authUserId && row.activated_at === null) {
        this.patch(row.id, { activated_at: at.toISOString() });
      }
    }
    return Promise.resolve();
  }

  private list(match: (row: InviteRecipient) => boolean): InviteRecipient[] {
    return [...this.rows.values()]
      .filter(match)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((r) => ({ ...r }));
  }

  private patch(id: string, patch: Partial<InviteRecipient>): void {
    const row = this.rows.get(id);
    if (row) {
      this.rows.set(id, { ...row, ...patch });
    }
  }
}

export class InMemoryResendCooldownRepository extends ResendCooldownRepository {
  readonly lastRequestedAt = new Map<string, number>();

  claim(emailHash: string): Promise<ResendClaim> {
    const now = Date.now();
    const remaining = this.remainingSeconds(emailHash, now);
    if (remaining > 0) {
      return Promise.resolve({ accepted: false, retryAfterSeconds: remaining });
    }
    this.lastRequestedAt.set(emailHash, now);
    return Promise.resolve({
      accepted: true,
      retryAfterSeconds: RESEND_COOLDOWN_SECONDS,
    });
  }

  retryAfterSeconds(emailHash: string): Promise<number> {
    return Promise.resolve(this.remainingSeconds(emailHash, Date.now()));
  }

  private remainingSeconds(emailHash: string, now: number): number {
    const last = this.lastRequestedAt.get(emailHash);
    if (last === undefined) return 0;
    const remainingMs = last + RESEND_COOLDOWN_SECONDS * 1000 - now;
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  }
}

export interface StoredReminderRun {
  token: string | null;
  lockedUntil: number | null;
  attempts: number;
  finished: DailyReminderRunOutcome | null;
}

export class InMemoryDailyReminderRunsRepository extends DailyReminderRunsRepository {
  readonly runs = new Map<string, StoredReminderRun>();
  heldElsewhere = false;
  private tokens = 0;

  tryStart(day: string, leaseSeconds: number): Promise<string | null> {
    if (this.heldElsewhere) {
      return Promise.resolve(null);
    }
    const run = this.runs.get(day) ?? {
      token: null,
      lockedUntil: null,
      attempts: 0,
      finished: null,
    };
    this.runs.set(day, run);
    if (
      run.finished !== null ||
      (run.lockedUntil !== null && run.lockedUntil > Date.now())
    ) {
      return Promise.resolve(null);
    }
    run.token = `run-${++this.tokens}`;
    run.lockedUntil = Date.now() + leaseSeconds * 1000;
    run.attempts += 1;
    return Promise.resolve(run.token);
  }

  renew(token: string, leaseSeconds: number): Promise<boolean> {
    for (const run of this.runs.values()) {
      if (run.token === token && run.finished === null) {
        run.lockedUntil = Date.now() + leaseSeconds * 1000;
        return Promise.resolve(true);
      }
    }
    return Promise.resolve(false);
  }

  finish(token: string, outcome: DailyReminderRunOutcome): Promise<boolean> {
    for (const run of this.runs.values()) {
      if (run.token === token) {
        run.token = null;
        run.lockedUntil = null;
        run.finished = outcome;
        return Promise.resolve(true);
      }
    }
    return Promise.resolve(false);
  }

  expireLease(day: string): void {
    const run = this.runs.get(day);
    if (run) {
      run.lockedUntil = Date.now();
    }
  }

  holdLease(day: string, untilMs: number): void {
    this.runs.set(day, {
      token: 'elsewhere',
      lockedUntil: untilMs,
      attempts: 1,
      finished: null,
    });
  }
}
