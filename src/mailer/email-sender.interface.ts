import type { EmailMessage } from './mailer.types';

/**
 * Low-level transport contract: takes a fully-rendered {@link EmailMessage} and
 * hands it to the provider (Resend in v1). Implementations MUST throw on a
 * failed send so {@link MailerService} can retry / audit; they MUST NOT swallow
 * errors. Retry, fire-and-forget and audit policy live in MailerService.
 *
 * Swap the binding (see {@link EMAIL_SENDER}) to change providers — no call
 * sites change. Mirrors the BIO_TRANSLATOR port pattern.
 */
export interface EmailSender {
  /** Sends one message. Returns the provider message id when available. */
  send(message: EmailMessage): Promise<{ id?: string }>;

  /**
   * Whether the sender is configured (e.g. Resend API key + from address set).
   * When false, MailerService skips sending (logs a warning) rather than
   * treating a missing key as a hard failure — keeps non-prod boots clean.
   */
  isConfigured(): boolean;
}

/**
 * DI token for the active {@link EmailSender}. Inject with
 * `@Inject(EMAIL_SENDER)`.
 */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
