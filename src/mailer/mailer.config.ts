import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailTemplate } from './mailer.types';

export const DEFAULT_REPLY_TO = 'info@ssnow.club';
export const DEFAULT_EMAIL_LOGO_URL = 'https://app.ssnow.club/email-logo.png';
export const DEFAULT_PORTAL_URL = 'https://app.ssnow.club';
export const DEV_PORTAL_URL = 'http://localhost:5173';

/**
 * Mailer settings read from env, all optional at boot:
 *   - `PORTAL_URL`     — portal base for links in emails. Defaults to
 *     `https://app.ssnow.club` when `NODE_ENV=production`, else `http://localhost:5173`.
 *   - `MAIL_REPLY_TO`  — Reply-To address (default `info@ssnow.club`).
 *   - `MAIL_FROM`      — its address is the calendar organizer in ICS
 *     attachments (falls back to the Reply-To address).
 *   - `MAIL_FROM_BOOKINGS` / `MAIL_REPLY_TO_BOOKINGS` — From and Reply-To for
 *     `booking.*` templates, falling back to `MAIL_FROM` / `MAIL_REPLY_TO`.
 *   - `EMAIL_LOGO_URL` — PNG logo in the email header.
 */
@Injectable()
export class MailerConfig {
  readonly portalUrl: string;
  readonly replyTo: string;
  readonly logoUrl: string;
  readonly senderAddress: string;
  private readonly bookingsFrom?: string;
  private readonly bookingsReplyTo?: string;

  constructor(config: ConfigService) {
    const fallbackPortal =
      config.get<string>('NODE_ENV') === 'production'
        ? DEFAULT_PORTAL_URL
        : DEV_PORTAL_URL;
    this.portalUrl = (
      readOptional(config, 'PORTAL_URL') ?? fallbackPortal
    ).replace(/\/+$/, '');
    this.replyTo = readOptional(config, 'MAIL_REPLY_TO') ?? DEFAULT_REPLY_TO;
    this.logoUrl =
      readOptional(config, 'EMAIL_LOGO_URL') ?? DEFAULT_EMAIL_LOGO_URL;
    this.senderAddress =
      addressOf(readOptional(config, 'MAIL_FROM')) ?? addressOf(this.replyTo)!;
    this.bookingsFrom = readOptional(config, 'MAIL_FROM_BOOKINGS');
    this.bookingsReplyTo = readOptional(config, 'MAIL_REPLY_TO_BOOKINGS');
  }

  /** From / Reply-To overrides for `template`; empty means the sender's defaults. */
  mailboxFor(template: string): { from?: string; replyTo?: string } {
    if (!isBookingTemplate(template)) {
      return {};
    }
    return {
      ...(this.bookingsFrom ? { from: this.bookingsFrom } : {}),
      ...(this.bookingsReplyTo ? { replyTo: this.bookingsReplyTo } : {}),
    };
  }

  /** The address `template` is sent from, for the ICS organizer. */
  senderAddressFor(template: EmailTemplate): string {
    return addressOf(this.mailboxFor(template).from) ?? this.senderAddress;
  }

  /** Absolute portal URL for `path` (e.g. `/login`). */
  portalLink(path: string): string {
    return `${this.portalUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }
}

export function isBookingTemplate(template: string): boolean {
  return template.startsWith('booking.');
}

export function addressOf(mailbox: string | undefined): string | undefined {
  const value = mailbox?.match(/<([^<>]+)>/)?.[1] ?? mailbox;
  return value?.trim() || undefined;
}

export function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url);
}

/** Reads a trimmed env value, treating blank as unset. */
export function readOptional(
  config: ConfigService,
  key: string,
): string | undefined {
  return config.get<string>(key)?.trim() || undefined;
}
