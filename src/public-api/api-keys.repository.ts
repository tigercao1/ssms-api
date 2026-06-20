import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { ApiKeyEnvironment, ApiKeyRow } from './public-api.types';

/** A row to be appended to `audit_log` (RLS_AND_SECURITY_PLAN.md § Audit Log). */
export interface AuditEntry {
  actorUserId?: string | null;
  actorRole?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Fields needed to persist a freshly-issued key (already hashed). */
export interface NewApiKeyRecord {
  name: string;
  environment: ApiKeyEnvironment;
  prefix: string;
  lastFour: string;
  keyHash: string;
  rateLimitPerMin: number;
  createdBy?: string | null;
}

/**
 * Data-access boundary for the Public API module. Declared abstract so it
 * doubles as a DI token and lets unit tests bind an in-memory fake
 * (TESTING_STRATEGY.md § Mocking pattern — repo fakes preferred).
 */
export abstract class ApiKeysRepository {
  /** Insert a new (hashed) key; returns the stored row (minus the hash). */
  abstract insert(record: NewApiKeyRecord): Promise<ApiKeyRow>;
  /** Find an active (non-revoked) key by its hash, or null. */
  abstract findActiveByHash(keyHash: string): Promise<ApiKeyRow | null>;
  /** Soft-delete a key by id; returns the row if it was active, else null. */
  abstract revoke(
    id: string,
    revokedBy?: string | null,
  ): Promise<ApiKeyRow | null>;
  /** Append an audit row (service-role only). */
  abstract recordAudit(entry: AuditEntry): Promise<void>;
}

const API_KEY_COLUMNS =
  'id, name, environment, prefix, last_four, rate_limit_per_min, created_at, revoked_at';

@Injectable()
export class SupabaseApiKeysRepository extends ApiKeysRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async insert(record: NewApiKeyRecord): Promise<ApiKeyRow> {
    const { data, error } = await this.supabase
      .from('api_keys')
      .insert({
        name: record.name,
        environment: record.environment,
        prefix: record.prefix,
        last_four: record.lastFour,
        key_hash: record.keyHash,
        rate_limit_per_min: record.rateLimitPerMin,
        created_by: record.createdBy ?? null,
      })
      .select(API_KEY_COLUMNS)
      .single();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to create API key: ${error.message}`,
      );
    }
    return data;
  }

  async findActiveByHash(keyHash: string): Promise<ApiKeyRow | null> {
    const { data, error } = await this.supabase
      .from('api_keys')
      .select(API_KEY_COLUMNS)
      .eq('key_hash', keyHash)
      .is('revoked_at', null)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to look up API key: ${error.message}`,
      );
    }
    return data ?? null;
  }

  async revoke(
    id: string,
    revokedBy?: string | null,
  ): Promise<ApiKeyRow | null> {
    const { data, error } = await this.supabase
      .from('api_keys')
      .update({
        revoked_at: new Date().toISOString(),
        revoked_by: revokedBy ?? null,
      })
      .eq('id', id)
      .is('revoked_at', null)
      .select(API_KEY_COLUMNS)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to revoke API key: ${error.message}`,
      );
    }
    return data ?? null;
  }

  async recordAudit(entry: AuditEntry): Promise<void> {
    const { error } = await this.supabase.from('audit_log').insert({
      actor_user_id: entry.actorUserId ?? null,
      actor_role: entry.actorRole ?? null,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      metadata: entry.metadata ?? null,
    });
    if (error) {
      throw new InternalServerErrorException(
        `Failed to write audit log: ${error.message}`,
      );
    }
  }
}
