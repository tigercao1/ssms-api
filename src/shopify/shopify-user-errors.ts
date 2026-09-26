import {
  ShopifyError,
  type ShopifyUserError,
  ShopifyUserErrorsError,
} from './shopify.errors';

export function assertNoUserErrors<
  T extends { userErrors?: ShopifyUserError[] | null },
>(operation: string, payload: T | null | undefined): T {
  if (!payload) {
    throw new ShopifyError(`${operation} returned no payload.`);
  }
  if (payload.userErrors?.length) {
    throw new ShopifyUserErrorsError(operation, payload.userErrors);
  }
  return payload;
}
