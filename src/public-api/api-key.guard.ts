import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyRateLimiter } from './api-key-rate-limiter';
import { ApiKeysService } from './api-keys.service';
import { ApiKeyRow } from './public-api.types';

/** Bearer-token prefix that all SSMS API keys carry (PUBLIC_API_PLAN.md). */
export const API_KEY_PREFIX = 'ssms_';

/** Request augmented with the resolved API key (available to handlers). */
export interface ApiKeyRequest extends Request {
  apiKey?: ApiKeyRow;
}

/**
 * T7.7 — Guards `/public/v1/*` with an API key carried as
 * `Authorization: Bearer <key>` (PUBLIC_API_PLAN.md § Auth Model).
 *
 * Failure modes (acceptance criteria):
 *   * missing / malformed Authorization header → 401
 *   * token without the `ssms_` prefix → 401 with a clear message (a JWT sent
 *     here fails fast and obviously)
 *   * unknown / revoked key → 401
 *   * over the per-key rate limit → 429
 *
 * On success the resolved key is attached to `request.apiKey`.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly rateLimiter: ApiKeyRateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApiKeyRequest>();
    const token = this.extractBearer(request);

    if (token === null) {
      throw new UnauthorizedException(
        'Missing API key. Provide it as: Authorization: Bearer <key>',
      );
    }

    if (!token.startsWith(API_KEY_PREFIX)) {
      throw new UnauthorizedException(
        `Invalid API key: expected an '${API_KEY_PREFIX}' prefixed key`,
      );
    }

    const key = await this.apiKeys.verify(token);
    if (key === null) {
      throw new UnauthorizedException('Invalid or revoked API key');
    }

    if (!this.rateLimiter.consume(key.id, key.rate_limit_per_min)) {
      throw new HttpException(
        `Rate limit exceeded (${key.rate_limit_per_min} requests/minute)`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    request.apiKey = key;
    return true;
  }

  /** Pull the token out of `Authorization: Bearer <token>`, or null. */
  private extractBearer(request: ApiKeyRequest): string | null {
    const header = request.headers?.authorization;
    if (typeof header !== 'string') {
      return null;
    }
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !value) {
      return null;
    }
    return value.trim();
  }
}
