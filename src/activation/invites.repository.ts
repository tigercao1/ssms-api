import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type { InviteRecipient, InviteRow } from './activation.types';

const TABLE = 'instructor_invites';
const INVITE_COLUMNS =
  'id, instructor_id, auth_user_id, email, token_hash, season, expires_at, ' +
  'send_claimed_at, sent_at, remind_claimed_at, reminded_at, redeemed_at, ' +
  'activated_at, created_at';
const RECIPIENT_COLUMNS = `${INVITE_COLUMNS}, instructors(display_name_en, preferred_language)`;
const REMINDER_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

/** Which roster email a claim guards: the first invite or the reminder. */
export type DeliveryKind = 'send' | 'remind';

const DELIVERY_COLUMNS: Record<
  DeliveryKind,
  {
    claimed: 'send_claimed_at' | 'remind_claimed_at';
    done: 'sent_at' | 'reminded_at';
  }
> = {
  send: { claimed: 'send_claimed_at', done: 'sent_at' },
  remind: { claimed: 'remind_claimed_at', done: 'reminded_at' },
};

interface RecipientRecord extends InviteRow {
  instructors: {
    display_name_en: string | null;
    preferred_language: string | null;
  } | null;
}

function toRecipient(record: RecipientRecord): InviteRecipient {
  const { instructors, ...invite } = record;
  return {
    ...invite,
    display_name_en: instructors?.display_name_en ?? '',
    preferred_language: instructors?.preferred_language ?? null,
  };
}

/** Persistence for `instructor_invites`; abstract so tests can bind a fake. */
export abstract class InvitesRepository {
  abstract findByTokenHash(tokenHash: string): Promise<InviteRow | null>;
  abstract findLatestByEmail(email: string): Promise<InviteRecipient | null>;
  /** The auth user's newest invite, or `null` when they were never invited. */
  abstract findLatestByAuthUser(authUserId: string): Promise<InviteRow | null>;
  abstract listUnsent(
    season: string,
    email?: string,
  ): Promise<InviteRecipient[]>;
  abstract listDueForReminder(
    season: string,
    now: Date,
  ): Promise<InviteRecipient[]>;
  abstract setToken(
    id: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void>;
  /** Atomically claims an undelivered, unclaimed invite; false when another run holds it. */
  abstract claim(id: string, kind: DeliveryKind, at: Date): Promise<boolean>;
  /** Drops the claim taken at `claimedAt` if the email was never marked delivered. */
  abstract releaseClaim(
    id: string,
    kind: DeliveryKind,
    claimedAt: Date,
  ): Promise<void>;
  /** Ids of invites claimed but never marked delivered: possibly sent by a run that died. */
  abstract listUnfinishedClaims(
    season: string,
    kind: DeliveryKind,
  ): Promise<string[]>;
  /** Clears unfinished claims taken before `claimedBefore`; returns the released ids. */
  abstract releaseStaleClaims(
    season: string,
    kind: DeliveryKind,
    claimedBefore: Date,
  ): Promise<string[]>;
  abstract markSent(id: string, at: Date): Promise<void>;
  abstract markReminded(id: string, at: Date): Promise<void>;
  abstract markRedeemed(id: string, at: Date): Promise<void>;
  abstract markActivated(authUserId: string, at: Date): Promise<void>;
}

/** {@link InvitesRepository} over the service-role Supabase client. */
@Injectable()
export class SupabaseInvitesRepository extends InvitesRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async findByTokenHash(tokenHash: string): Promise<InviteRow | null> {
    const { data, error } = await this.supabase
      .from(TABLE)
      .select(INVITE_COLUMNS)
      .eq('token_hash', tokenHash)
      .maybeSingle();
    if (error) {
      throw failure('load invite', error.message);
    }
    return (data as unknown as InviteRow | null) ?? null;
  }

  async findLatestByEmail(email: string): Promise<InviteRecipient | null> {
    const { data, error } = await this.supabase
      .from(TABLE)
      .select(RECIPIENT_COLUMNS)
      .eq('email', email)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      throw failure('load invite', error.message);
    }
    const [first] = (data ?? []) as unknown as RecipientRecord[];
    return first ? toRecipient(first) : null;
  }

  async findLatestByAuthUser(authUserId: string): Promise<InviteRow | null> {
    const { data, error } = await this.supabase
      .from(TABLE)
      .select(INVITE_COLUMNS)
      .eq('auth_user_id', authUserId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      throw failure('load invite', error.message);
    }
    const [first] = (data ?? []) as unknown as InviteRow[];
    return first ?? null;
  }

  async listUnsent(season: string, email?: string): Promise<InviteRecipient[]> {
    let query = this.supabase
      .from(TABLE)
      .select(RECIPIENT_COLUMNS)
      .eq('season', season)
      .is('sent_at', null)
      .is('send_claimed_at', null);
    if (email !== undefined) {
      query = query.eq('email', email);
    }
    const { data, error } = await query.order('created_at', {
      ascending: true,
    });
    if (error) {
      throw failure('list unsent invites', error.message);
    }
    return ((data ?? []) as unknown as RecipientRecord[]).map(toRecipient);
  }

  async listDueForReminder(
    season: string,
    now: Date,
  ): Promise<InviteRecipient[]> {
    const { data, error } = await this.supabase
      .from(TABLE)
      .select(RECIPIENT_COLUMNS)
      .eq('season', season)
      .lte('sent_at', new Date(now.getTime() - REMINDER_DELAY_MS).toISOString())
      .is('redeemed_at', null)
      .is('reminded_at', null)
      .is('remind_claimed_at', null)
      .gt('expires_at', now.toISOString())
      .order('created_at', { ascending: true });
    if (error) {
      throw failure('list invites due for a reminder', error.message);
    }
    return ((data ?? []) as unknown as RecipientRecord[]).map(toRecipient);
  }

  async setToken(id: string, tokenHash: string, expiresAt: Date) {
    await this.update(id, {
      token_hash: tokenHash,
      expires_at: expiresAt.toISOString(),
    });
  }

  async claim(id: string, kind: DeliveryKind, at: Date): Promise<boolean> {
    const { claimed, done } = DELIVERY_COLUMNS[kind];
    const { data, error } = await this.supabase
      .from(TABLE)
      .update({ [claimed]: at.toISOString() })
      .eq('id', id)
      .is(claimed, null)
      .is(done, null)
      .select('id');
    if (error) {
      throw failure('claim invite', error.message);
    }
    return ((data ?? []) as unknown[]).length > 0;
  }

  async releaseClaim(
    id: string,
    kind: DeliveryKind,
    claimedAt: Date,
  ): Promise<void> {
    const { claimed, done } = DELIVERY_COLUMNS[kind];
    const { error } = await this.supabase
      .from(TABLE)
      .update({ [claimed]: null })
      .eq('id', id)
      .eq(claimed, claimedAt.toISOString())
      .is(done, null);
    if (error) {
      throw failure('release invite claim', error.message);
    }
  }

  async listUnfinishedClaims(
    season: string,
    kind: DeliveryKind,
  ): Promise<string[]> {
    const { claimed, done } = DELIVERY_COLUMNS[kind];
    const { data, error } = await this.supabase
      .from(TABLE)
      .select('id')
      .eq('season', season)
      .not(claimed, 'is', null)
      .is(done, null)
      .order(claimed, { ascending: true });
    if (error) {
      throw failure('list claimed invites', error.message);
    }
    return ((data ?? []) as { id: string }[]).map((r) => r.id);
  }

  async releaseStaleClaims(
    season: string,
    kind: DeliveryKind,
    claimedBefore: Date,
  ): Promise<string[]> {
    const { claimed, done } = DELIVERY_COLUMNS[kind];
    const { data, error } = await this.supabase
      .from(TABLE)
      .update({ [claimed]: null })
      .eq('season', season)
      .lt(claimed, claimedBefore.toISOString())
      .is(done, null)
      .select('id');
    if (error) {
      throw failure('release stale invite claims', error.message);
    }
    return ((data ?? []) as { id: string }[]).map((r) => r.id);
  }

  async markSent(id: string, at: Date): Promise<void> {
    await this.update(id, { sent_at: at.toISOString() });
  }

  async markReminded(id: string, at: Date): Promise<void> {
    await this.update(id, { reminded_at: at.toISOString() });
  }

  async markRedeemed(id: string, at: Date): Promise<void> {
    const { error } = await this.supabase
      .from(TABLE)
      .update({ redeemed_at: at.toISOString() })
      .eq('id', id)
      .is('redeemed_at', null);
    if (error) {
      throw failure('update invite', error.message);
    }
  }

  async markActivated(authUserId: string, at: Date): Promise<void> {
    const { error } = await this.supabase
      .from(TABLE)
      .update({ activated_at: at.toISOString() })
      .eq('auth_user_id', authUserId)
      .is('activated_at', null);
    if (error) {
      throw failure('update invite', error.message);
    }
  }

  private async update(id: string, patch: Record<string, string>) {
    const { error } = await this.supabase
      .from(TABLE)
      .update(patch)
      .eq('id', id);
    if (error) {
      throw failure('update invite', error.message);
    }
  }
}

function failure(action: string, message: string) {
  return new InternalServerErrorException(`Failed to ${action}: ${message}`);
}
