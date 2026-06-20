import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { EMAIL_SENDER, type EmailSender } from './email-sender.interface';
import {
  NOTIFICATION_RENDERER,
  type NotificationRenderer,
} from './notification-renderer.interface';
import type {
  EmailMessage,
  InstructorNotificationContext,
} from './mailer.types';

const AUDIT_TABLE = 'audit_log';
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 250;

/** Result of a notification attempt (for callers / tests / observability). */
export type SendOutcome =
  | 'sent' // delivered to the provider
  | 'skipped' // sender not configured — intentionally no-op
  | 'failed'; // all attempts exhausted; audited as notification.failure

/**
 * Transactional email for admin actions (ADMIN_ROLE_PLAN.md, AUTH_V1_DECISIONS.md).
 *
 * Contract (locked in V1_SCOPE.md): **fire-and-forget with retry**. A failed
 * send must NEVER throw to the caller and must NEVER roll back the underlying
 * admin action (approve / reject / deactivate). On final failure we record a
 * `notification.failure` row in `audit_log` so an unhealthy mailer is visible.
 *
 * Rendering (copy + language by `preferred_language`) is delegated to the
 * {@link NOTIFICATION_RENDERER} binding; transport to the {@link EMAIL_SENDER}
 * binding (Resend in v1). Neither concern leaks into call sites.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly maxAttempts = DEFAULT_MAX_ATTEMPTS;

  constructor(
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(NOTIFICATION_RENDERER)
    private readonly renderer: NotificationRenderer,
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  /**
   * Renders + sends an instructor notification for an admin action.
   *
   * Resolves (never rejects) to a {@link SendOutcome}. Callers may `void` the
   * promise for true fire-and-forget, or `await` it to observe the outcome —
   * either way the admin transaction is unaffected.
   */
  async sendInstructorNotification(
    context: InstructorNotificationContext,
  ): Promise<SendOutcome> {
    if (!this.sender.isConfigured()) {
      this.logger.warn(
        `Email sender not configured; skipping ${context.type} notification ` +
          `to ${redactEmail(context.to)}.`,
      );
      return 'skipped';
    }

    let message: EmailMessage;
    try {
      message = this.renderer.render(context);
    } catch (err) {
      // A render bug must not break the admin action either.
      await this.auditFailure(context, err as Error, 0);
      this.logger.error(
        `Failed to render ${context.type} notification: ${(err as Error).message}`,
      );
      return 'failed';
    }

    return this.sendWithRetry(message, context);
  }

  private async sendWithRetry(
    message: EmailMessage,
    context: InstructorNotificationContext,
  ): Promise<SendOutcome> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const { id } = await this.sender.send(message);
        this.logger.log(
          `Sent ${context.type} notification to ${redactEmail(context.to)}` +
            (id ? ` (id=${id})` : '') +
            (attempt > 1 ? ` after ${attempt} attempts` : ''),
        );
        return 'sent';
      } catch (err) {
        lastError = err as Error;
        this.logger.warn(
          `Attempt ${attempt}/${this.maxAttempts} to send ${context.type} ` +
            `notification failed: ${lastError.message}`,
        );
        if (attempt < this.maxAttempts) {
          await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        }
      }
    }

    await this.auditFailure(
      context,
      lastError ?? new Error('unknown send failure'),
      this.maxAttempts,
    );
    return 'failed';
  }

  /**
   * Records a `notification.failure` audit row. Best-effort: a failure to write
   * the audit row is itself only logged — it must not surface to the caller.
   */
  private async auditFailure(
    context: InstructorNotificationContext,
    err: Error,
    attempts: number,
  ): Promise<void> {
    try {
      const { error } = await this.supabase.from(AUDIT_TABLE).insert({
        actor_role: 'system',
        action: 'notification.failure',
        target_type: 'instructor',
        target_id: context.instructorId ?? null,
        metadata: {
          notification_type: context.type,
          language: context.language ?? null,
          recipient: redactEmail(context.to),
          attempts,
          error: err.message,
        },
      });
      if (error) {
        this.logger.error(
          `Failed to write notification.failure audit row: ${error.message}`,
        );
      }
    } catch (auditErr) {
      this.logger.error(
        `Unexpected error writing notification.failure audit row: ` +
          `${(auditErr as Error).message}`,
      );
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Masks the local part of an email for logs (keeps domain for debugging). */
function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) {
    return '***';
  }
  const local = email.slice(0, at);
  const masked =
    local.length <= 2
      ? '*'.repeat(local.length)
      : `${local[0]}***${local.at(-1)}`;
  return `${masked}${email.slice(at)}`;
}
