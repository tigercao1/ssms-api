import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbResult } from '../database/db-result';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

export const SESSION_LIVENESS_CLOCK = Symbol('SESSION_LIVENESS_CLOCK');
export const SESSION_LIVENESS_TTL_MS = 30_000;
const MAX_CACHED_SESSIONS = 10_000;

export interface SessionLivenessClock {
  now(): number;
}

/** Checks that a token's Supabase session still exists (not revoked or expired). */
@Injectable()
export class SessionLivenessService {
  private readonly activeUntil = new Map<string, number>();

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    @Inject(SESSION_LIVENESS_CLOCK)
    private readonly clock: SessionLivenessClock,
  ) {}

  /** True iff the session is live; rpc failures raise 503, never 401. */
  async isActive(sessionId: string): Promise<boolean> {
    const now = this.clock.now();
    const cachedUntil = this.activeUntil.get(sessionId);
    if (cachedUntil !== undefined && cachedUntil > now) {
      return true;
    }
    this.activeUntil.delete(sessionId);

    let result: DbResult<boolean>;
    try {
      result = (await this.supabase.rpc('session_is_active', {
        p_session_id: sessionId,
      })) as DbResult<boolean>;
    } catch {
      throw new ServiceUnavailableException('Session check unavailable');
    }
    if (result.error) {
      throw new ServiceUnavailableException('Session check unavailable');
    }
    if (result.data !== true) {
      return false;
    }
    this.remember(sessionId, now + SESSION_LIVENESS_TTL_MS, now);
    return true;
  }

  private remember(sessionId: string, until: number, now: number): void {
    if (this.activeUntil.size >= MAX_CACHED_SESSIONS) {
      for (const [id, expiry] of this.activeUntil) {
        if (expiry <= now) {
          this.activeUntil.delete(id);
        }
      }
      if (this.activeUntil.size >= MAX_CACHED_SESSIONS) {
        this.activeUntil.clear();
      }
    }
    this.activeUntil.set(sessionId, until);
  }
}
