import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  type HttpException,
  type Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ShopifyConfigError,
  ShopifyError,
  ShopifyUserErrorsError,
} from '../shopify/shopify.errors';
import { ShopifyScopeMissingError } from './shopify-customers';

export const CUSTOMER_SYNC_FLAG = 'CUSTOMER_SYNC_ENABLED';
export const CUSTOMER_SYNC_DISABLED = `Shopify customer sync is off; set ${CUSTOMER_SYNC_FLAG}=true to enable it.`;
export const SHOPIFY_NOT_CONFIGURED = 'Shopify is not configured on the API.';
export const SHOPIFY_REQUEST_FAILED = 'Shopify request failed';
export const CUSTOMER_EMAIL_TAKEN =
  'A Shopify customer with this email already exists';
export const CUSTOMER_PHONE_TAKEN =
  'A Shopify customer with this phone number already exists';

export const scopeMissingMessage = (scope: string): string =>
  `${scope} scope missing: grant ${scope} to the Shopify app, then try again.`;

function isTaken(
  err: ShopifyUserErrorsError,
  field: 'email' | 'phone',
): boolean {
  return err.userErrors.some(
    (e) =>
      (e.field ?? []).some((f) => f.toLowerCase() === field) &&
      /taken|already|exists/i.test(e.message),
  );
}

export function toHttpError(err: unknown, logger: Logger): unknown {
  if (err instanceof ShopifyUserErrorsError) {
    if (isTaken(err, 'email')) {
      return new ConflictException(CUSTOMER_EMAIL_TAKEN);
    }
    if (isTaken(err, 'phone')) {
      return new ConflictException(CUSTOMER_PHONE_TAKEN);
    }
    return new BadRequestException(
      err.userErrors.map((e) => e.message).join('; '),
    );
  }
  if (err instanceof ShopifyScopeMissingError) {
    return new BadGatewayException(scopeMissingMessage(err.scope));
  }
  if (err instanceof ShopifyConfigError) {
    return new ServiceUnavailableException(SHOPIFY_NOT_CONFIGURED);
  }
  if (err instanceof ShopifyError) {
    logger.error(`Shopify customer request failed: ${err.message}`);
    return new BadGatewayException(SHOPIFY_REQUEST_FAILED);
  }
  return err;
}

export function syncDisabled(): HttpException {
  return new ServiceUnavailableException(CUSTOMER_SYNC_DISABLED);
}
