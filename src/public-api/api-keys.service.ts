import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { ApiKeysRepository } from './api-keys.repository';
import { ApiKeyEnvironment, ApiKeyRow, IssuedApiKey } from './public-api.types';

/** Number of random bytes in the secret part (~43 base64url chars). */
const SECRET_BYTES = 32;

/**
 * SHA-256 (hex) of a full presented key. Exported so the guard hashes presented
 * bearer tokens with the exact same algorithm used at issuance.
 */
export function hashApiKey(fullKey: string): string {
  return createHash('sha256').update(fullKey, 'utf8').digest('hex');
}

/** url-safe base64 without padding. */
function randomSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

export interface IssueApiKeyInput {
  name: string;
  environment?: ApiKeyEnvironment;
  rateLimitPerMin?: number;
  createdBy?: string | null;
}

/**
 * T7.8 — API-key issuance / revocation (hashed storage).
 *
 * Keys are Stripe-style prefixed: `ssms_live_<random>` / `ssms_test_<random>`
 * (PUBLIC_API_PLAN.md § Auth Model). Only the SHA-256 hash is persisted; the
 * plaintext is returned exactly once on creation and can never be recovered.
 * Issue/revoke both write `api_key.create` / `api_key.revoke` audit rows
 * (RLS_AND_SECURITY_PLAN.md § Audit Log).
 */
@Injectable()
export class ApiKeysService {
  constructor(private readonly repo: ApiKeysRepository) {}

  /** Issue a new key. The returned `apiKey` is shown once and never stored. */
  async issue(input: IssueApiKeyInput): Promise<IssuedApiKey> {
    const environment: ApiKeyEnvironment = input.environment ?? 'live';
    const prefix = `ssms_${environment}`;
    const secret = randomSecret();
    const fullKey = `${prefix}_${secret}`;
    const lastFour = secret.slice(-4);
    const rateLimitPerMin = input.rateLimitPerMin ?? 60;

    const row = await this.repo.insert({
      name: input.name,
      environment,
      prefix,
      lastFour,
      keyHash: hashApiKey(fullKey),
      rateLimitPerMin,
      createdBy: input.createdBy ?? null,
    });

    await this.repo.recordAudit({
      actorUserId: input.createdBy ?? null,
      actorRole: input.createdBy ? 'admin' : 'system',
      action: 'api_key.create',
      targetType: 'api_key',
      targetId: row.id,
      metadata: { name: row.name, environment, prefix, last_four: lastFour },
    });

    return {
      id: row.id,
      name: row.name,
      environment: row.environment,
      prefix: row.prefix,
      lastFour: row.last_four,
      rateLimitPerMin: row.rate_limit_per_min,
      createdAt: row.created_at,
      apiKey: fullKey,
    };
  }

  /** Revoke a key by id. Throws 404 if it does not exist or is already revoked. */
  async revoke(id: string, revokedBy?: string | null): Promise<void> {
    const row = await this.repo.revoke(id, revokedBy ?? null);
    if (row === null) {
      throw new NotFoundException(`API key ${id} not found or already revoked`);
    }
    await this.repo.recordAudit({
      actorUserId: revokedBy ?? null,
      actorRole: revokedBy ? 'admin' : 'system',
      action: 'api_key.revoke',
      targetType: 'api_key',
      targetId: row.id,
      metadata: { name: row.name },
    });
  }

  /**
   * Verify a presented bearer token. Returns the active key row, or null when
   * the token does not match any active key. Hashing happens here so the
   * plaintext is never compared/stored.
   */
  async verify(fullKey: string): Promise<ApiKeyRow | null> {
    return this.repo.findActiveByHash(hashApiKey(fullKey));
  }
}
