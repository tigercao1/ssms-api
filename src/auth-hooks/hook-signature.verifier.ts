import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IncomingHttpHeaders } from 'node:http';
import { Webhook } from 'standardwebhooks';

export const SEND_EMAIL_HOOK_SECRET_ENV = 'SEND_EMAIL_HOOK_SECRET';
export const HOOK_NOT_CONFIGURED = 'Send email hook is not configured';
export const HOOK_SIGNATURE_INVALID = 'Invalid webhook signature';

const SIGNATURE_HEADERS = [
  'webhook-id',
  'webhook-timestamp',
  'webhook-signature',
] as const;

/**
 * Verifies Supabase auth hook calls with Standard Webhooks (HMAC-SHA256 over
 * `id.timestamp.body`, 5-minute timestamp tolerance).
 *
 * `SEND_EMAIL_HOOK_SECRET` holds the secret exactly as Supabase shows it,
 * `v1,whsec_<base64>`. Several secrets separated by `|` are accepted so the
 * secret can be rotated without downtime. When the secret is unset or
 * malformed every call is refused with 503.
 */
@Injectable()
export class HookSignatureVerifier {
  private readonly logger = new Logger(HookSignatureVerifier.name);
  private readonly webhooks: Webhook[];

  constructor(config: ConfigService) {
    this.webhooks = parseSecrets(
      config.get<string>(SEND_EMAIL_HOOK_SECRET_ENV),
      this.logger,
    );
  }

  isConfigured(): boolean {
    return this.webhooks.length > 0;
  }

  /**
   * Returns the parsed JSON body when the signature headers match `rawBody`.
   * Throws 503 when no secret is configured and 401 when verification fails.
   */
  verify(rawBody: Buffer, headers: IncomingHttpHeaders): unknown {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(HOOK_NOT_CONFIGURED);
    }
    const signatureHeaders = pickSignatureHeaders(headers);
    let reason = '';
    for (const webhook of this.webhooks) {
      try {
        return webhook.verify(rawBody, signatureHeaders);
      } catch (err) {
        reason = (err as Error).message;
      }
    }
    this.logger.warn(`Hook signature rejected: ${reason}`);
    throw new UnauthorizedException(HOOK_SIGNATURE_INVALID);
  }
}

function parseSecrets(value: string | undefined, logger: Logger): Webhook[] {
  const secrets = (value ?? '')
    .split('|')
    .map((secret) => secret.trim().replace(/^v1,/, ''))
    .filter((secret) => secret !== '');
  try {
    return secrets.map((secret) => new Webhook(secret));
  } catch (err) {
    logger.error(
      `${SEND_EMAIL_HOOK_SECRET_ENV} is malformed (${(err as Error).message}); the send email hook will refuse every call.`,
    );
    return [];
  }
}

function pickSignatureHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of SIGNATURE_HEADERS) {
    const value = headers[name];
    picked[name] = Array.isArray(value) ? value.join(' ') : (value ?? '');
  }
  return picked;
}
