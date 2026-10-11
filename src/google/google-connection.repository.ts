import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type { GoogleConnectionRow } from './google.types';

export const GOOGLE_CONNECTION_TABLE = 'google_connection';
export const GOOGLE_CONNECTION_COLUMNS =
  'account_email, refresh_token_enc, scopes, connected_at, connected_by, last_refresh_at, last_error, last_error_at';

export interface SaveGoogleConnectionInput {
  accountEmail: string;
  refreshTokenEnc: string;
  scopes: string[];
  connectedBy: string | null;
  connectedAt: string;
}

export abstract class GoogleConnectionRepository {
  abstract get(): Promise<GoogleConnectionRow | null>;
  abstract save(input: SaveGoogleConnectionInput): Promise<GoogleConnectionRow>;
  abstract recordRefresh(at: string): Promise<void>;
  abstract recordError(
    message: string,
    at: string,
    options?: { clearToken?: boolean },
  ): Promise<void>;
  abstract delete(): Promise<void>;
}

interface DbError {
  message: string;
}

type Result<T> = { data: T | null; error: DbError | null };

@Injectable()
export class SupabaseGoogleConnectionRepository extends GoogleConnectionRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async get(): Promise<GoogleConnectionRow | null> {
    const { data, error } = (await this.supabase
      .from(GOOGLE_CONNECTION_TABLE)
      .select(GOOGLE_CONNECTION_COLUMNS)
      .eq('id', true)
      .maybeSingle()) as Result<GoogleConnectionRow>;
    check(error, 'load Google connection');
    return data ?? null;
  }

  async save(input: SaveGoogleConnectionInput): Promise<GoogleConnectionRow> {
    const { data, error } = (await this.supabase
      .from(GOOGLE_CONNECTION_TABLE)
      .upsert(
        {
          id: true,
          account_email: input.accountEmail,
          refresh_token_enc: input.refreshTokenEnc,
          scopes: input.scopes,
          connected_at: input.connectedAt,
          connected_by: input.connectedBy,
          last_refresh_at: input.connectedAt,
          last_error: null,
          last_error_at: null,
        },
        { onConflict: 'id' },
      )
      .select(GOOGLE_CONNECTION_COLUMNS)
      .single()) as Result<GoogleConnectionRow>;
    check(error, 'save Google connection');
    if (!data) {
      throw new Error('Failed to save Google connection: no row returned');
    }
    return data;
  }

  async recordRefresh(at: string): Promise<void> {
    const { error } = (await this.supabase
      .from(GOOGLE_CONNECTION_TABLE)
      .update({ last_refresh_at: at, last_error: null, last_error_at: null })
      .eq('id', true)) as Result<null>;
    check(error, 'record Google token refresh');
  }

  async recordError(
    message: string,
    at: string,
    options: { clearToken?: boolean } = {},
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      last_error: message,
      last_error_at: at,
    };
    if (options.clearToken) {
      patch.refresh_token_enc = null;
    }
    const { error } = (await this.supabase
      .from(GOOGLE_CONNECTION_TABLE)
      .update(patch)
      .eq('id', true)) as Result<null>;
    check(error, 'record Google connection error');
  }

  async delete(): Promise<void> {
    const { error } = (await this.supabase
      .from(GOOGLE_CONNECTION_TABLE)
      .delete()
      .eq('id', true)) as Result<null>;
    check(error, 'delete Google connection');
  }
}

function check(error: DbError | null, action: string): void {
  if (error) {
    throw new Error(`Failed to ${action}: ${error.message}`);
  }
}
