import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS } from '../audit/audit.types';
import {
  ApiTokenAuthenticator,
  type ApiTokenRoute,
} from '../auth/api-token-authenticator';
import type { SupabaseJwtPayload } from '../auth/jwt-payload.interface';
import { ApiKeyRateLimiter } from '../public-api/api-key-rate-limiter';
import {
  hashAdminApiToken,
  isWellFormedAdminApiToken,
} from './admin-api-token.secret';
import { AdminApiTokenOwners } from './admin-api-token-owners';
import { AdminApiTokensRepository } from './admin-api-tokens.repository';
import {
  ADMIN_API_TOKEN_CLOCK,
  ADMIN_API_TOKEN_RATE_LIMITER,
  type AdminApiTokenClock,
  type AdminApiTokenRow,
  tokenStatus,
} from './admin-api-tokens.types';

export const ADMIN_API_TOKEN_RATE_LIMIT_PER_MIN = 120;
const LAST_USED_INTERVAL_MS = 60_000;

type FailureReason =
  | 'unknown'
  | 'revoked'
  | 'expired'
  | 'owner_not_admin'
  | 'not_admin_route'
  | 'session_only';

@Injectable()
export class AdminApiTokenAuthenticator extends ApiTokenAuthenticator {
  private readonly logger = new Logger(AdminApiTokenAuthenticator.name);

  constructor(
    private readonly repo: AdminApiTokensRepository,
    private readonly owners: AdminApiTokenOwners,
    private readonly audit: AuditService,
    @Inject(ADMIN_API_TOKEN_RATE_LIMITER)
    private readonly limiter: ApiKeyRateLimiter,
    @Inject(ADMIN_API_TOKEN_CLOCK) private readonly clock: AdminApiTokenClock,
  ) {
    super();
  }

  async authenticate(
    token: string,
    route: ApiTokenRoute,
  ): Promise<SupabaseJwtPayload> {
    const row = isWellFormedAdminApiToken(token)
      ? await this.lookup(hashAdminApiToken(token))
      : null;
    if (row === null) {
      throw this.reject(route, 'unknown', null);
    }
    const now = this.clock.now();
    const status = tokenStatus(row, now);
    if (status === 'revoked' || status === 'expired') {
      throw this.reject(route, status, row);
    }
    if (
      !this.limiter.consume(row.id, ADMIN_API_TOKEN_RATE_LIMIT_PER_MIN, now)
    ) {
      throw new HttpException(
        `Rate limit exceeded (${ADMIN_API_TOKEN_RATE_LIMIT_PER_MIN} requests/minute)`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const owner = await this.owners.activeAdmin(row.owner_user_id);
    if (owner === null) {
      throw this.reject(route, 'owner_not_admin', row);
    }
    if (!route.adminRoute) {
      throw this.reject(route, 'not_admin_route', row);
    }
    if (route.sessionOnly) {
      throw this.reject(route, 'session_only', row);
    }
    await this.recordUse(row, now, route);
    return {
      sub: owner.id,
      email: owner.email ?? undefined,
      email_confirmed_at: owner.emailConfirmedAt,
      aud: 'authenticated',
      app_metadata: { role: 'admin' },
      auth_via: 'api_token',
      token_id: row.id,
    };
  }

  private async lookup(hash: string): Promise<AdminApiTokenRow | null> {
    try {
      return await this.repo.findByHash(hash);
    } catch {
      throw new ServiceUnavailableException('Token check unavailable');
    }
  }

  private reject(
    route: ApiTokenRoute,
    reason: FailureReason,
    row: AdminApiTokenRow | null,
  ): HttpException {
    void this.audit.record({
      action: AUDIT_ACTIONS.adminApiTokenAuthFailure,
      actor: { userId: null, role: null, userAgent: route.userAgent },
      targetType: 'admin_api_token',
      targetId: row?.id ?? null,
      metadata: { reason, method: route.method, path: route.path },
    });
    if (reason === 'not_admin_route') {
      return new ForbiddenException(
        'API tokens are only accepted on admin routes',
      );
    }
    if (reason === 'session_only') {
      return new ForbiddenException(
        'This action needs a signed-in session; API tokens are not accepted',
      );
    }
    return new UnauthorizedException();
  }

  private async recordUse(
    row: AdminApiTokenRow,
    now: number,
    route: ApiTokenRoute,
  ): Promise<void> {
    const at = new Date(now).toISOString();
    try {
      if (row.last_used_at === null) {
        if (await this.repo.markFirstUse(row.id, at)) {
          await this.audit.record({
            action: AUDIT_ACTIONS.adminApiTokenFirstUse,
            actor: {
              userId: row.owner_user_id,
              role: 'admin',
              userAgent: route.userAgent,
              via: 'api_token',
              tokenId: row.id,
            },
            targetType: 'admin_api_token',
            targetId: row.id,
            metadata: { method: route.method, path: route.path },
          });
        }
        return;
      }
      if (now - Date.parse(row.last_used_at) >= LAST_USED_INTERVAL_MS) {
        await this.repo.markUsed(
          row.id,
          at,
          new Date(now - LAST_USED_INTERVAL_MS).toISOString(),
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not record use of admin API token ${row.id}: ${(error as Error).message}`,
      );
    }
  }
}
