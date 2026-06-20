import { Controller, Get, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';

/**
 * Diagnostic endpoint to verify the server's live connections in the current
 * (pre-feature) state:
 *   - DB: can we reach Postgres/PostgREST with the secret API key?
 *   - JWKS: is the ES256 signing-key endpoint reachable?
 *
 * Not part of any feature card — a temporary smoke test. Safe to remove once
 * real endpoints exist.
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async check() {
    return {
      status: 'ok',
      db: await this.checkDb(),
      jwks: await this.checkJwks(),
    };
  }

  /** Cheap count query — distinguishes connected/migrated/auth states. */
  private async checkDb(): Promise<string> {
    const { error } = await this.supabase
      .from('instructors')
      .select('id', { head: true, count: 'exact' });

    if (!error) return 'ok'; // connected + migrated
    // Table missing → reached PostgREST but migrations not applied yet.
    if (error.code === '42P01' || /does not exist/i.test(error.message)) {
      return 'reachable-not-migrated';
    }
    // Anything else (bad key, network) → surface the code.
    return `error:${error.code ?? 'unknown'}`;
  }

  /** Confirms the JWKS URL returns keys (proves URL + signing-key setup). */
  private async checkJwks(): Promise<string> {
    const url =
      this.config.get<string>('SUPABASE_JWKS_URL') ??
      `${this.config.getOrThrow<string>('SUPABASE_URL').replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`;
    try {
      const res = await fetch(url);
      if (!res.ok) return `error:http_${res.status}`;
      const body = (await res.json()) as { keys?: unknown[] };
      return Array.isArray(body.keys) && body.keys.length > 0
        ? 'ok'
        : 'no-keys';
    } catch {
      return 'error:unreachable';
    }
  }
}
