import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const SHOPIFY_WEBHOOK_NOT_CONFIGURED =
  'Shopify webhooks are not configured';
export const SHOPIFY_WEBHOOK_SIGNATURE_INVALID =
  'Invalid Shopify webhook signature';
export const SHOPIFY_WEBHOOK_SHOP_INVALID = 'Unexpected Shopify shop';

export function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

@Injectable()
export class ShopifyWebhookVerifier {
  private readonly logger = new Logger(ShopifyWebhookVerifier.name);
  private readonly secret?: string;
  private readonly shopDomain?: string;

  constructor(config: ConfigService) {
    this.secret =
      config.get<string>('SHOPIFY_CLIENT_SECRET')?.trim() || undefined;
    const shop = config
      .get<string>('SHOPIFY_SHOP')
      ?.trim()
      .toLowerCase()
      .replace(/\.myshopify\.com$/, '');
    this.shopDomain = shop ? `${shop}.myshopify.com` : undefined;
  }

  verify(rawBody: Buffer, headers: IncomingHttpHeaders): void {
    if (!this.secret || !this.shopDomain) {
      throw new ServiceUnavailableException(SHOPIFY_WEBHOOK_NOT_CONFIGURED);
    }
    const expected = createHmac('sha256', this.secret).update(rawBody).digest();
    const given = Buffer.from(
      headerValue(headers, 'x-shopify-hmac-sha256'),
      'base64',
    );
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      this.logger.warn(
        `Shopify webhook signature rejected (topic ${headerValue(headers, 'x-shopify-topic') || 'none'})`,
      );
      throw new UnauthorizedException(SHOPIFY_WEBHOOK_SIGNATURE_INVALID);
    }
    if (
      headerValue(headers, 'x-shopify-shop-domain').toLowerCase() !==
      this.shopDomain
    ) {
      this.logger.warn('Shopify webhook rejected: unexpected shop domain');
      throw new UnauthorizedException(SHOPIFY_WEBHOOK_SHOP_INVALID);
    }
  }
}
