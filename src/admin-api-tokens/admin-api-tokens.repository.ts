import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type { AdminApiTokenRow } from './admin-api-tokens.types';

export interface NewAdminApiToken {
  ownerUserId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  tokenLast4: string;
  expiresAt: string | null;
}

export interface AdminApiTokenRotation {
  tokenId: string;
  ownerUserId: string;
  tokenHash: string;
  tokenPrefix: string;
  tokenLast4: string;
  keepExpiry: boolean;
  expiresAt: string | null;
  graceMinutes: number;
}

export type AdminApiTokenRevocation = 'revoked' | 'already_revoked' | 'missing';

export abstract class AdminApiTokensRepository {
  abstract insert(token: NewAdminApiToken): Promise<AdminApiTokenRow>;
  abstract listByOwner(ownerUserId: string): Promise<AdminApiTokenRow[]>;
  abstract findByHash(tokenHash: string): Promise<AdminApiTokenRow | null>;
  abstract rotate(
    rotation: AdminApiTokenRotation,
  ): Promise<AdminApiTokenRow | null>;
  abstract revoke(
    id: string,
    ownerUserId: string,
    at: string,
  ): Promise<AdminApiTokenRevocation>;
  abstract markFirstUse(id: string, at: string): Promise<boolean>;
  abstract markUsed(id: string, at: string, before: string): Promise<void>;
}

const COLUMNS =
  'id, owner_user_id, name, token_prefix, token_last4, created_at, expires_at, last_used_at, revoked_at, replaced_by, grace_until';
const TABLE = 'admin_api_tokens';

function failure(action: string, message: string): never {
  throw new InternalServerErrorException(
    `Failed to ${action} admin API token: ${message}`,
  );
}

@Injectable()
export class SupabaseAdminApiTokensRepository extends AdminApiTokensRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async insert(token: NewAdminApiToken): Promise<AdminApiTokenRow> {
    const { data, error } = await this.supabase
      .from(TABLE)
      .insert({
        owner_user_id: token.ownerUserId,
        name: token.name,
        token_hash: token.tokenHash,
        token_prefix: token.tokenPrefix,
        token_last4: token.tokenLast4,
        expires_at: token.expiresAt,
      })
      .select(COLUMNS)
      .single<AdminApiTokenRow>();
    if (error) {
      failure('create', error.message);
    }
    return data;
  }

  async listByOwner(ownerUserId: string): Promise<AdminApiTokenRow[]> {
    const { data, error } = await this.supabase
      .from(TABLE)
      .select(COLUMNS)
      .eq('owner_user_id', ownerUserId)
      .order('created_at', { ascending: false })
      .returns<AdminApiTokenRow[]>();
    if (error) {
      failure('list', error.message);
    }
    return data ?? [];
  }

  async findByHash(tokenHash: string): Promise<AdminApiTokenRow | null> {
    const { data, error } = await this.supabase
      .from(TABLE)
      .select(COLUMNS)
      .eq('token_hash', tokenHash)
      .maybeSingle<AdminApiTokenRow>();
    if (error) {
      failure('look up', error.message);
    }
    return data ?? null;
  }

  async rotate(
    rotation: AdminApiTokenRotation,
  ): Promise<AdminApiTokenRow | null> {
    const { data, error } = (await this.supabase.rpc('rotate_admin_api_token', {
      p_token_id: rotation.tokenId,
      p_owner_user_id: rotation.ownerUserId,
      p_token_hash: rotation.tokenHash,
      p_token_prefix: rotation.tokenPrefix,
      p_token_last4: rotation.tokenLast4,
      p_keep_expiry: rotation.keepExpiry,
      p_expires_at: rotation.expiresAt,
      p_grace_minutes: rotation.graceMinutes,
    })) as DbResult<AdminApiTokenRow[]>;
    if (error) {
      failure('rotate', error.message);
    }
    return data?.[0] ?? null;
  }

  async revoke(
    id: string,
    ownerUserId: string,
    at: string,
  ): Promise<AdminApiTokenRevocation> {
    const { data, error } = await this.supabase
      .from(TABLE)
      .update({ revoked_at: at })
      .eq('id', id)
      .eq('owner_user_id', ownerUserId)
      .is('revoked_at', null)
      .select('id');
    if (error) {
      failure('revoke', error.message);
    }
    if ((data ?? []).length > 0) {
      return 'revoked';
    }
    const existing = await this.supabase
      .from(TABLE)
      .select('id')
      .eq('id', id)
      .eq('owner_user_id', ownerUserId)
      .maybeSingle();
    if (existing.error) {
      failure('revoke', existing.error.message);
    }
    return existing.data ? 'already_revoked' : 'missing';
  }

  async markFirstUse(id: string, at: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from(TABLE)
      .update({ last_used_at: at })
      .eq('id', id)
      .is('last_used_at', null)
      .select('id');
    if (error) {
      failure('record use of', error.message);
    }
    return (data ?? []).length > 0;
  }

  async markUsed(id: string, at: string, before: string): Promise<void> {
    const { error } = await this.supabase
      .from(TABLE)
      .update({ last_used_at: at })
      .eq('id', id)
      .lt('last_used_at', before);
    if (error) {
      failure('record use of', error.message);
    }
  }
}
