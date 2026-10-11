import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailSender } from './email-sender.interface';
import { DEFAULT_REPLY_TO, readOptional } from './mailer.config';
import type { EmailMessage } from './mailer.types';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * {@link EmailSender} backed by Resend's REST API.
 *
 * We talk to the HTTP API via the global `fetch` (Node >= 20) instead of
 * pulling the `resend` SDK as a dependency: the surface we need is a single
 * POST, and this keeps the transport trivially mockable in tests
 * (TESTING_STRATEGY.md) with no extra install.
 *
 * Config (read from env via ConfigService; all optional so non-prod boots
 * cleanly — see {@link isConfigured}):
 *   - `RESEND_API_KEY`  — provider secret (`re_...`).
 *   - `MAIL_FROM`       — verified sender, e.g. `Serendipity Snow <noreply@contact.ssnow.club>`.
 *   - `MAIL_REPLY_TO`   — Reply-To address (default `info@ssnow.club`).
 *
 * Throws on any non-2xx response so MailerService can retry / audit.
 */
@Injectable()
export class ResendEmailSender implements EmailSender {
  private readonly logger = new Logger(ResendEmailSender.name);
  private readonly apiKey?: string;
  private readonly from?: string;
  private readonly replyTo: string;

  constructor(config: ConfigService) {
    this.apiKey = readOptional(config, 'RESEND_API_KEY');
    this.from = readOptional(config, 'MAIL_FROM');
    this.replyTo = readOptional(config, 'MAIL_REPLY_TO') ?? DEFAULT_REPLY_TO;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.from);
  }

  async send(message: EmailMessage): Promise<{ id?: string }> {
    if (!this.isConfigured()) {
      throw new Error(
        'Resend is not configured (RESEND_API_KEY / MAIL_FROM missing).',
      );
    }

    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...(message.idempotencyKey
          ? { 'Idempotency-Key': message.idempotencyKey }
          : {}),
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        reply_to: this.replyTo,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });

    if (!response.ok) {
      const detail = await this.safeReadBody(response);
      throw new Error(
        `Resend send failed (${response.status} ${response.statusText}): ${detail}`,
      );
    }

    const body = (await this.safeReadJson(response)) as { id?: string } | null;
    return { id: body?.id };
  }

  private async safeReadBody(response: Response): Promise<string> {
    try {
      return (await response.text()).slice(0, 500);
    } catch {
      return '<unreadable body>';
    }
  }

  private async safeReadJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}
