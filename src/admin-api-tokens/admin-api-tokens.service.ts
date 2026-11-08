import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { type AuditActor, AUDIT_ACTIONS } from '../audit/audit.types';
import { newAdminApiTokenSecret } from './admin-api-token.secret';
import { AdminApiTokensRepository } from './admin-api-tokens.repository';
import {
  ADMIN_API_TOKEN_CLOCK,
  type AdminApiTokenClock,
  type AdminApiTokenRow,
  type AdminApiTokenSummary,
  type IssuedAdminApiToken,
  tokenStatus,
} from './admin-api-tokens.types';

export const DEFAULT_ROTATION_GRACE_MINUTES = 10;
const MAX_EXPIRY_YEARS = 3;

export interface TokenOwner {
  userId: string;
  actor: AuditActor;
}

function issued(row: AdminApiTokenRow, token: string): IssuedAdminApiToken {
  return {
    id: row.id,
    name: row.name,
    token,
    prefix: row.token_prefix,
    last4: row.token_last4,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

@Injectable()
export class AdminApiTokensService {
  constructor(
    private readonly repo: AdminApiTokensRepository,
    private readonly audit: AuditService,
    @Inject(ADMIN_API_TOKEN_CLOCK) private readonly clock: AdminApiTokenClock,
  ) {}

  async create(
    owner: TokenOwner,
    name: string,
    expiresAt: string | null,
  ): Promise<IssuedAdminApiToken> {
    const expiry = this.checkedExpiry(expiresAt);
    const secret = newAdminApiTokenSecret();
    const row = await this.repo.insert({
      ownerUserId: owner.userId,
      name,
      tokenHash: secret.hash,
      tokenPrefix: secret.prefix,
      tokenLast4: secret.last4,
      expiresAt: expiry,
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.adminApiTokenCreate,
      actor: owner.actor,
      targetType: 'admin_api_token',
      targetId: row.id,
      metadata: {
        name: row.name,
        prefix: row.token_prefix,
        last4: row.token_last4,
        expiresAt: row.expires_at,
      },
    });
    return issued(row, secret.token);
  }

  async list(ownerUserId: string): Promise<AdminApiTokenSummary[]> {
    const now = this.clock.now();
    const rows = await this.repo.listByOwner(ownerUserId);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.token_prefix,
      last4: row.token_last4,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
      status: tokenStatus(row, now),
    }));
  }

  async rotate(
    owner: TokenOwner,
    id: string,
    graceMinutes: number = DEFAULT_ROTATION_GRACE_MINUTES,
    expiresAt?: string | null,
  ): Promise<IssuedAdminApiToken> {
    const keepExpiry = expiresAt === undefined;
    const expiry = keepExpiry ? null : this.checkedExpiry(expiresAt);
    const secret = newAdminApiTokenSecret();
    const row = await this.repo.rotate({
      tokenId: id,
      ownerUserId: owner.userId,
      tokenHash: secret.hash,
      tokenPrefix: secret.prefix,
      tokenLast4: secret.last4,
      keepExpiry,
      expiresAt: expiry,
      graceMinutes,
    });
    if (row === null) {
      throw new NotFoundException('API token not found or not active');
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.adminApiTokenRotate,
      actor: owner.actor,
      targetType: 'admin_api_token',
      targetId: id,
      metadata: {
        replacedBy: row.id,
        graceMinutes,
        prefix: row.token_prefix,
        last4: row.token_last4,
        expiresAt: row.expires_at,
      },
    });
    return issued(row, secret.token);
  }

  async revoke(owner: TokenOwner, id: string): Promise<void> {
    const at = new Date(this.clock.now()).toISOString();
    const outcome = await this.repo.revoke(id, owner.userId, at);
    if (outcome === 'missing') {
      throw new NotFoundException('API token not found');
    }
    if (outcome === 'revoked') {
      await this.audit.record({
        action: AUDIT_ACTIONS.adminApiTokenRevoke,
        actor: owner.actor,
        targetType: 'admin_api_token',
        targetId: id,
      });
    }
  }

  private checkedExpiry(expiresAt: string | null): string | null {
    if (expiresAt === null) {
      return null;
    }
    const now = this.clock.now();
    const expiry = Date.parse(expiresAt);
    if (Number.isNaN(expiry) || expiry <= now) {
      throw new BadRequestException('expiresAt must be in the future');
    }
    const latest = new Date(now);
    latest.setUTCFullYear(latest.getUTCFullYear() + MAX_EXPIRY_YEARS);
    if (expiry > latest.getTime()) {
      throw new BadRequestException(
        `expiresAt must be within ${MAX_EXPIRY_YEARS} years`,
      );
    }
    return new Date(expiry).toISOString();
  }
}
