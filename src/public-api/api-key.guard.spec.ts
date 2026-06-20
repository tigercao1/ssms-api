import {
  ExecutionContext,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeyRateLimiter } from './api-key-rate-limiter';
import { ApiKeyGuard, ApiKeyRequest } from './api-key.guard';
import { ApiKeysService } from './api-keys.service';
import { ApiKeyRow } from './public-api.types';

const ACTIVE_KEY: ApiKeyRow = {
  id: 'key-1',
  name: 'shopify',
  environment: 'live',
  prefix: 'ssms_live',
  last_four: 'abcd',
  rate_limit_per_min: 2,
  created_at: '2026-01-01T00:00:00Z',
  revoked_at: null,
};

function contextWithHeader(authorization?: string): ExecutionContext {
  const request = {
    headers: authorization ? { authorization } : {},
  } as ApiKeyRequest;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function makeGuard(verifyResult: ApiKeyRow | null) {
  const verify = jest.fn().mockResolvedValue(verifyResult);
  const apiKeys = { verify } as unknown as ApiKeysService;
  const limiter = new ApiKeyRateLimiter();
  return { guard: new ApiKeyGuard(apiKeys, limiter), verify, limiter };
}

describe('ApiKeyGuard', () => {
  it('throws 401 when the Authorization header is missing', async () => {
    const { guard } = makeGuard(ACTIVE_KEY);
    await expect(guard.canActivate(contextWithHeader())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('throws 401 when the scheme is not Bearer', async () => {
    const { guard } = makeGuard(ACTIVE_KEY);
    await expect(
      guard.canActivate(contextWithHeader('Basic ssms_live_x')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws 401 with a clear message for a non-ssms_ prefix (e.g. a JWT)', async () => {
    const { guard, verify } = makeGuard(ACTIVE_KEY);
    await expect(
      guard.canActivate(contextWithHeader('Bearer eyJhbGciOi.jwt.token')),
    ).rejects.toThrow(/ssms_/);
    // Fails fast — never even hits the DB.
    expect(verify).not.toHaveBeenCalled();
  });

  it('throws 401 for an unknown / revoked key', async () => {
    const { guard } = makeGuard(null);
    await expect(
      guard.canActivate(contextWithHeader('Bearer ssms_live_unknown')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows a valid key and attaches it to the request', async () => {
    const { guard } = makeGuard(ACTIVE_KEY);
    const ctx = contextWithHeader('Bearer ssms_live_good');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest<ApiKeyRequest>();
    expect(req.apiKey).toEqual(ACTIVE_KEY);
  });

  it('throws 429 once the per-key rate limit is exceeded', async () => {
    const { guard } = makeGuard(ACTIVE_KEY); // limit = 2
    const header = 'Bearer ssms_live_good';
    await expect(guard.canActivate(contextWithHeader(header))).resolves.toBe(
      true,
    );
    await expect(guard.canActivate(contextWithHeader(header))).resolves.toBe(
      true,
    );
    let thrown: unknown;
    try {
      await guard.canActivate(contextWithHeader(header));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });
});
