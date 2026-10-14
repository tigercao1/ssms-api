import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BioDraftMode } from '../bio-translation/bio-translator.interface';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

/** Requests in the rolling 24 h window. */
export interface BioAiWindow {
  used: number;
  oldestAt: string | null;
}

export interface BioAiReservation extends BioAiWindow {
  /** Null when the limit was already reached. */
  requestId: string | null;
}

interface WindowRow {
  used: number;
  oldest_at: string | null;
  request_id?: string | null;
}

/** Quota storage for bio refine / translate requests (migration 282). */
export abstract class BioAiQuotaRepository {
  abstract usage(instructorId: string): Promise<BioAiWindow>;
  /** Atomically records a request unless `limit` are already in the window. */
  abstract reserve(
    instructorId: string,
    mode: BioDraftMode,
    limit: number,
  ): Promise<BioAiReservation>;
  abstract release(requestId: string): Promise<void>;
}

@Injectable()
export class SupabaseBioAiQuotaRepository extends BioAiQuotaRepository {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {
    super();
  }

  async usage(instructorId: string): Promise<BioAiWindow> {
    const row = await this.callWindow('bio_ai_usage', {
      p_instructor_id: instructorId,
    });
    return { used: row.used, oldestAt: row.oldest_at };
  }

  async reserve(
    instructorId: string,
    mode: BioDraftMode,
    limit: number,
  ): Promise<BioAiReservation> {
    const row = await this.callWindow('reserve_bio_ai_request', {
      p_instructor_id: instructorId,
      p_mode: mode,
      p_limit: limit,
    });
    return {
      requestId: row.request_id ?? null,
      used: row.used,
      oldestAt: row.oldest_at,
    };
  }

  async release(requestId: string): Promise<void> {
    const { error } = await this.supabase
      .from('bio_ai_requests')
      .delete()
      .eq('id', requestId);
    if (error) {
      throw new InternalServerErrorException(
        `Failed to release bio AI request: ${error.message}`,
      );
    }
  }

  private async callWindow(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<WindowRow> {
    const { data, error } = await this.supabase.rpc(fn, args).single();
    if (error) {
      throw new InternalServerErrorException(
        `Failed to read bio AI usage: ${error.message}`,
      );
    }
    return data as WindowRow;
  }
}
