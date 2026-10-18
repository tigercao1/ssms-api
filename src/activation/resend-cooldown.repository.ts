import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { check, type DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

export const RESEND_COOLDOWN_SECONDS = 60;

export interface ResendClaim {
  accepted: boolean;
  retryAfterSeconds: number;
}

interface ClaimRow {
  accepted: boolean;
  retry_after_seconds: number;
}

export abstract class ResendCooldownRepository {
  abstract claim(emailHash: string): Promise<ResendClaim>;
  abstract retryAfterSeconds(emailHash: string): Promise<number>;
}

@Injectable()
export class SupabaseResendCooldownRepository extends ResendCooldownRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async claim(emailHash: string): Promise<ResendClaim> {
    const { data, error } = (await this.supabase.rpc(
      'claim_activation_resend',
      {
        p_email_hash: emailHash,
        p_cooldown_seconds: RESEND_COOLDOWN_SECONDS,
      },
    )) as DbResult<ClaimRow[]>;
    check(error, 'claim activation resend');
    const row = data?.[0];
    if (!row) {
      throw new Error('claim activation resend returned no row');
    }
    return {
      accepted: row.accepted,
      retryAfterSeconds: row.retry_after_seconds,
    };
  }

  async retryAfterSeconds(emailHash: string): Promise<number> {
    const { data, error } = (await this.supabase.rpc(
      'activation_resend_retry_after',
      {
        p_email_hash: emailHash,
        p_cooldown_seconds: RESEND_COOLDOWN_SECONDS,
      },
    )) as DbResult<number>;
    check(error, 'load activation resend cooldown');
    return data ?? 0;
  }
}
