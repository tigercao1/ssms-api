import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { EMAIL_SENDER, type EmailSender } from './email-sender.interface';
import { MailerConfig } from './mailer.config';
import {
  EmailDeliveryError,
  type EmailTemplate,
  type RenderedEmail,
  type SendEmailRequest,
  type SendOutcome,
  type SendMode,
} from './mailer.types';
import { EmailRenderer } from './templates/email-renderer';

const AUDIT_TABLE = 'audit_log';
const EMAIL_LOG_TABLE = 'email_log';
const BACKOFF_BASE_MS = 250;

/**
 * Per-mode retry budget. `sync` serves the Supabase send-email hook, which has
 * a 5s budget for the whole call: 2 x 1.5s + 250ms backoff stays under it.
 */
const RETRY_POLICY: Record<SendMode, { attempts: number; timeoutMs: number }> =
  {
    sync: { attempts: 2, timeoutMs: 1_500 },
    background: { attempts: 3, timeoutMs: 10_000 },
  };

interface AttemptResult {
  outcome: SendOutcome;
  attempts: number;
  providerId?: string;
  error?: string;
}

/**
 * Transactional email: renders an {@link EmailTemplate} through the shared
 * branded layout and hands it to the {@link EMAIL_SENDER} binding (Resend).
 *
 * Every send retries up to 3 times and writes one `email_log` row with the
 * final outcome (`sent`, `skipped` when the sender is not configured, or
 * `failed`). A failure also writes a `notification.failure` row to
 * `audit_log`. In `background` mode {@link send} never rejects; in `sync`
 * mode it throws {@link EmailDeliveryError} when the email was not sent.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);

  constructor(
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    private readonly renderer: EmailRenderer,
    private readonly config: MailerConfig,
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  /** Absolute portal URL for `path`, from `PORTAL_URL`. */
  portalLink(path: string): string {
    return this.config.portalLink(path);
  }

  /**
   * Renders and sends one email. Resolves to the {@link SendOutcome}; in
   * `sync` mode a `skipped` or `failed` outcome throws
   * {@link EmailDeliveryError} instead.
   */
  async send<T extends EmailTemplate>(
    request: SendEmailRequest<T>,
  ): Promise<SendOutcome> {
    let result: AttemptResult;
    try {
      result = await this.deliver(request);
    } catch (err) {
      result = { outcome: 'failed', attempts: 0, error: errorMessage(err) };
    }
    if (request.mode === 'sync' && result.outcome !== 'sent') {
      throw new EmailDeliveryError(
        result.outcome,
        result.error ?? `Email ${request.template} was not sent`,
      );
    }
    return result.outcome;
  }

  private async deliver<T extends EmailTemplate>(
    request: SendEmailRequest<T>,
  ): Promise<AttemptResult> {
    if (!this.sender.isConfigured()) {
      this.logger.warn(
        `Email sender not configured; skipping ${request.template} ` +
          `to ${redactEmail(request.to)}.`,
      );
      const result: AttemptResult = {
        outcome: 'skipped',
        attempts: 0,
        error: 'Email sender is not configured',
      };
      await this.writeLog(request, result);
      return result;
    }

    let rendered: RenderedEmail;
    try {
      rendered = this.renderer.render(
        request.template,
        request.language,
        request.vars,
      );
    } catch (err) {
      const error = errorMessage(err);
      this.logger.error(`Failed to render ${request.template}: ${error}`);
      const result: AttemptResult = { outcome: 'failed', attempts: 0, error };
      await this.auditFailure(request, result);
      await this.writeLog(request, result);
      return result;
    }

    const result = await this.sendWithRetry(request, rendered);
    if (result.outcome === 'failed') {
      await this.auditFailure(request, result);
    }
    await this.writeLog(request, result, rendered.subject);
    return result;
  }

  private async sendWithRetry(
    request: SendEmailRequest,
    rendered: RenderedEmail,
  ): Promise<AttemptResult> {
    const { attempts, timeoutMs } = RETRY_POLICY[request.mode];
    let lastError = 'unknown send failure';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const { id } = await this.sender.send({
          to: request.to,
          ...rendered,
          timeoutMs,
          ...(request.idempotencyKey
            ? { idempotencyKey: request.idempotencyKey }
            : {}),
        });
        this.logger.log(
          `Sent ${request.template} to ${redactEmail(request.to)}` +
            (id ? ` (id=${id})` : '') +
            (attempt > 1 ? ` after ${attempt} attempts` : ''),
        );
        return { outcome: 'sent', attempts: attempt, providerId: id };
      } catch (err) {
        lastError = errorMessage(err);
        this.logger.warn(
          `Attempt ${attempt}/${attempts} to send ${request.template} ` +
            `failed: ${lastError}`,
        );
        if (attempt < attempts) {
          await delay(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        }
      }
    }
    return { outcome: 'failed', attempts, error: lastError };
  }

  /** Best-effort `email_log` insert; a logging failure is only logged. */
  private async writeLog(
    request: SendEmailRequest,
    result: AttemptResult,
    subject?: string,
  ): Promise<void> {
    try {
      const { error } = await this.supabase.from(EMAIL_LOG_TABLE).insert({
        template: request.template,
        recipient: request.to,
        language: request.language,
        instructor_id: request.instructorId ?? null,
        auth_user_id: request.authUserId ?? null,
        provider_id: result.providerId ?? null,
        status: result.outcome,
        error: result.outcome === 'sent' ? null : (result.error ?? null),
        metadata: {
          ...request.metadata,
          mode: request.mode,
          attempts: result.attempts,
          ...(subject ? { subject } : {}),
        },
      });
      if (error) {
        this.logger.error(`Failed to write email_log row: ${error.message}`);
      }
    } catch (logErr) {
      this.logger.error(
        `Unexpected error writing email_log row: ${errorMessage(logErr)}`,
      );
    }
  }

  /** Best-effort `notification.failure` audit row. */
  private async auditFailure(
    request: SendEmailRequest,
    result: AttemptResult,
  ): Promise<void> {
    try {
      const { error } = await this.supabase.from(AUDIT_TABLE).insert({
        actor_role: 'system',
        action: 'notification.failure',
        target_type: 'instructor',
        target_id: request.instructorId ?? null,
        metadata: {
          notification_type: request.template,
          language: request.language,
          recipient: redactEmail(request.to),
          attempts: result.attempts,
          error: result.error ?? null,
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
          `${errorMessage(auditErr)}`,
      );
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Masks the local part of an email for logs (keeps domain for debugging). */
export function redactEmail(email: string): string {
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
