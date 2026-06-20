import { NotFoundException } from '@nestjs/common';
import {
  ApiKeysRepository,
  AuditEntry,
  NewApiKeyRecord,
} from './api-keys.repository';
import { ApiKeysService, hashApiKey } from './api-keys.service';
import { ApiKeyRow } from './public-api.types';

/** In-memory fake repo capturing inserts, revokes, and audit rows. */
class FakeApiKeysRepository extends ApiKeysRepository {
  rows: Array<ApiKeyRow & { key_hash: string }> = [];
  audits: AuditEntry[] = [];
  private seq = 0;

  insert(record: NewApiKeyRecord): Promise<ApiKeyRow> {
    const row: ApiKeyRow & { key_hash: string } = {
      id: `id-${++this.seq}`,
      name: record.name,
      environment: record.environment,
      prefix: record.prefix,
      last_four: record.lastFour,
      key_hash: record.keyHash,
      rate_limit_per_min: record.rateLimitPerMin,
      created_at: '2026-01-01T00:00:00Z',
      revoked_at: null,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  findActiveByHash(keyHash: string): Promise<ApiKeyRow | null> {
    return Promise.resolve(
      this.rows.find((r) => r.key_hash === keyHash && r.revoked_at === null) ??
        null,
    );
  }

  revoke(id: string): Promise<ApiKeyRow | null> {
    const row = this.rows.find((r) => r.id === id && r.revoked_at === null);
    if (!row) {
      return Promise.resolve(null);
    }
    row.revoked_at = '2026-02-01T00:00:00Z';
    return Promise.resolve(row);
  }

  recordAudit(entry: AuditEntry): Promise<void> {
    this.audits.push(entry);
    return Promise.resolve();
  }
}

describe('ApiKeysService', () => {
  let repo: FakeApiKeysRepository;
  let service: ApiKeysService;

  beforeEach(() => {
    repo = new FakeApiKeysRepository();
    service = new ApiKeysService(repo);
  });

  describe('issue', () => {
    it('returns a ssms_live_ prefixed plaintext key shown once', async () => {
      const issued = await service.issue({ name: 'shopify-storefront' });
      expect(issued.apiKey).toMatch(/^ssms_live_[A-Za-z0-9_-]+$/);
      expect(issued.prefix).toBe('ssms_live');
      expect(issued.environment).toBe('live');
      expect(issued.rateLimitPerMin).toBe(60);
    });

    it('uses the test prefix when environment=test', async () => {
      const issued = await service.issue({ name: 'ci', environment: 'test' });
      expect(issued.apiKey).toMatch(/^ssms_test_/);
      expect(issued.prefix).toBe('ssms_test');
    });

    it('stores only the hash, never the plaintext', async () => {
      const issued = await service.issue({ name: 'c' });
      const stored = repo.rows[0];
      expect(stored.key_hash).toBe(hashApiKey(issued.apiKey));
      // No stored field equals the plaintext key.
      expect(Object.values(stored)).not.toContain(issued.apiKey);
    });

    it('records an api_key.create audit row', async () => {
      const issued = await service.issue({ name: 'c', createdBy: 'admin-1' });
      expect(repo.audits).toHaveLength(1);
      expect(repo.audits[0]).toMatchObject({
        action: 'api_key.create',
        targetType: 'api_key',
        targetId: issued.id,
        actorUserId: 'admin-1',
        actorRole: 'admin',
      });
    });

    it('honours a custom rate limit', async () => {
      const issued = await service.issue({ name: 'c', rateLimitPerMin: 600 });
      expect(issued.rateLimitPerMin).toBe(600);
      expect(repo.rows[0].rate_limit_per_min).toBe(600);
    });
  });

  describe('verify', () => {
    it('resolves the active key for a valid token', async () => {
      const issued = await service.issue({ name: 'c' });
      const found = await service.verify(issued.apiKey);
      expect(found?.id).toBe(issued.id);
    });

    it('returns null for an unknown token', async () => {
      await service.issue({ name: 'c' });
      expect(await service.verify('ssms_live_nope')).toBeNull();
    });

    it('returns null once the key is revoked', async () => {
      const issued = await service.issue({ name: 'c' });
      await service.revoke(issued.id);
      expect(await service.verify(issued.apiKey)).toBeNull();
    });
  });

  describe('revoke', () => {
    it('disables the key and records an api_key.revoke audit row', async () => {
      const issued = await service.issue({ name: 'c' });
      await service.revoke(issued.id, 'admin-9');
      expect(repo.rows[0].revoked_at).not.toBeNull();
      const revokeAudit = repo.audits.find(
        (a) => a.action === 'api_key.revoke',
      );
      expect(revokeAudit).toMatchObject({
        targetId: issued.id,
        actorUserId: 'admin-9',
      });
    });

    it('throws 404 when the key does not exist or is already revoked', async () => {
      await expect(service.revoke('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const issued = await service.issue({ name: 'c' });
      await service.revoke(issued.id);
      await expect(service.revoke(issued.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
