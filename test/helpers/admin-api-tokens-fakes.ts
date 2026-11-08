import { randomUUID } from 'crypto';
import { newAdminApiTokenSecret } from '../../src/admin-api-tokens/admin-api-token.secret';
import {
  type AdminApiTokenRevocation,
  type AdminApiTokenRotation,
  AdminApiTokensRepository,
  type NewAdminApiToken,
} from '../../src/admin-api-tokens/admin-api-tokens.repository';
import type { AdminApiTokenRow } from '../../src/admin-api-tokens/admin-api-tokens.types';

export interface StoredAdminApiToken extends AdminApiTokenRow {
  token_hash: string;
}

export class FakeClock {
  constructor(public current = Date.parse('2026-11-08T17:00:00.000Z')) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export class InMemoryAdminApiTokens extends AdminApiTokensRepository {
  rows: StoredAdminApiToken[] = [];
  writes: string[] = [];

  constructor(private readonly clock: FakeClock) {
    super();
  }

  private iso(ms = this.clock.now()): string {
    return new Date(ms).toISOString();
  }

  private visible(row: StoredAdminApiToken): AdminApiTokenRow {
    return Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== 'token_hash'),
    ) as unknown as AdminApiTokenRow;
  }

  insert(token: NewAdminApiToken): Promise<AdminApiTokenRow> {
    if (this.rows.some((row) => row.token_hash === token.tokenHash)) {
      throw new Error('duplicate token hash');
    }
    const row: StoredAdminApiToken = {
      id: randomUUID(),
      owner_user_id: token.ownerUserId,
      name: token.name,
      token_hash: token.tokenHash,
      token_prefix: token.tokenPrefix,
      token_last4: token.tokenLast4,
      created_at: this.iso(),
      expires_at: token.expiresAt,
      last_used_at: null,
      revoked_at: null,
      replaced_by: null,
      grace_until: null,
    };
    this.rows.push(row);
    this.writes.push(`insert ${row.id}`);
    return Promise.resolve(this.visible(row));
  }

  listByOwner(ownerUserId: string): Promise<AdminApiTokenRow[]> {
    return Promise.resolve(
      this.rows
        .filter((row) => row.owner_user_id === ownerUserId)
        .reverse()
        .map((row) => this.visible(row)),
    );
  }

  findByHash(tokenHash: string): Promise<AdminApiTokenRow | null> {
    const row = this.rows.find((r) => r.token_hash === tokenHash);
    return Promise.resolve(row ? this.visible(row) : null);
  }

  async rotate(
    rotation: AdminApiTokenRotation,
  ): Promise<AdminApiTokenRow | null> {
    const now = this.clock.now();
    const old = this.rows.find(
      (row) =>
        row.id === rotation.tokenId &&
        row.owner_user_id === rotation.ownerUserId &&
        row.revoked_at === null &&
        row.replaced_by === null &&
        (row.expires_at === null || Date.parse(row.expires_at) > now),
    );
    if (!old) {
      return null;
    }
    const keptExpiry =
      old.expires_at === null
        ? null
        : this.iso(
            now + Date.parse(old.expires_at) - Date.parse(old.created_at),
          );
    const created = await this.insert({
      ownerUserId: old.owner_user_id,
      name: old.name,
      tokenHash: rotation.tokenHash,
      tokenPrefix: rotation.tokenPrefix,
      tokenLast4: rotation.tokenLast4,
      expiresAt: rotation.keepExpiry ? keptExpiry : rotation.expiresAt,
    });
    old.replaced_by = created.id;
    old.grace_until = this.iso(now + rotation.graceMinutes * 60_000);
    return created;
  }

  revoke(
    id: string,
    ownerUserId: string,
    at: string,
  ): Promise<AdminApiTokenRevocation> {
    const row = this.rows.find(
      (r) => r.id === id && r.owner_user_id === ownerUserId,
    );
    if (!row) {
      return Promise.resolve('missing');
    }
    if (row.revoked_at !== null) {
      return Promise.resolve('already_revoked');
    }
    row.revoked_at = at;
    return Promise.resolve('revoked');
  }

  markFirstUse(id: string, at: string): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id && r.last_used_at === null);
    if (!row) {
      return Promise.resolve(false);
    }
    row.last_used_at = at;
    this.writes.push(`first use ${id}`);
    return Promise.resolve(true);
  }

  markUsed(id: string, at: string, before: string): Promise<void> {
    const row = this.rows.find(
      (r) =>
        r.id === id &&
        r.last_used_at !== null &&
        Date.parse(r.last_used_at) < Date.parse(before),
    );
    if (row) {
      row.last_used_at = at;
      this.writes.push(`used ${id}`);
    }
    return Promise.resolve();
  }
}

export async function seedToken(
  repo: InMemoryAdminApiTokens,
  ownerUserId: string,
  expiresAt: string | null = null,
): Promise<{ id: string; token: string }> {
  const secret = newAdminApiTokenSecret();
  const row = await repo.insert({
    ownerUserId,
    name: 'seeded',
    tokenHash: secret.hash,
    tokenPrefix: secret.prefix,
    tokenLast4: secret.last4,
    expiresAt,
  });
  return { id: row.id, token: secret.token };
}
