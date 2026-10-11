import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const DEFAULT_REPLY_TO = 'info@ssnow.club';
export const DEFAULT_EMAIL_LOGO_URL = 'https://app.ssnow.club/email-logo.png';
export const DEFAULT_PORTAL_URL = 'https://app.ssnow.club';
export const DEV_PORTAL_URL = 'http://localhost:5173';

/**
 * Mailer settings read from env, all optional at boot:
 *   - `PORTAL_URL`     — portal base for links in emails. Defaults to
 *     `https://app.ssnow.club` when `NODE_ENV=production`, else `http://localhost:5173`.
 *   - `MAIL_REPLY_TO`  — Reply-To address (default `info@ssnow.club`).
 *   - `EMAIL_LOGO_URL` — PNG logo in the email header.
 */
@Injectable()
export class MailerConfig {
  readonly portalUrl: string;
  readonly replyTo: string;
  readonly logoUrl: string;

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
  }

  /** Absolute portal URL for `path` (e.g. `/login`). */
  portalLink(path: string): string {
    return `${this.portalUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }
}

/** Reads a trimmed env value, treating blank as unset. */
export function readOptional(
  config: ConfigService,
  key: string,
): string | undefined {
  return config.get<string>(key)?.trim() || undefined;
}
