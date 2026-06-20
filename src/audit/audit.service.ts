import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import type { AuditEntry } from './audit.types';

const AUDIT_TABLE = 'audit_log';

/**
 * T6.8 — the single append-only writer for `audit_log`.
 *
 * Inserts go through the server-side `service_role` client, which bypasses RLS
 * (the table grants no INSERT/UPDATE/DELETE to anon/authenticated — see
 * RLS_AND_SECURITY_PLAN.md § audit_log). Each `record()` call writes **exactly
 * one** row.
 *
 * Best-effort by design: a failure to write the audit row is logged but never
 * thrown back to the caller, so an audit hiccup can never roll back the
 * security action it is recording (mirrors the notification-failure posture).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  /** Append one row to `audit_log`. Never throws. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      const { error } = await this.supabase.from(AUDIT_TABLE).insert({
        actor_user_id: entry.actor?.userId ?? null,
        actor_role: entry.actor?.role ?? null,
        action: entry.action,
        target_type: entry.targetType ?? null,
        target_id: entry.targetId ?? null,
        metadata: entry.metadata ?? null,
        ip: entry.actor?.ip ?? null,
        user_agent: entry.actor?.userAgent ?? null,
      });

      if (error) {
        this.logger.error(
          `Failed to write audit row '${entry.action}': ${error.message}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Unexpected error writing audit row '${entry.action}': ` +
          `${(err as Error).message}`,
      );
    }
  }
}
