import { ShopifyConfigError } from './shopify.errors';

export const DEFAULT_SHOPIFY_API_VERSION = '2026-07';

export interface ShopifyConfig {
  shop: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
}

export function readShopifyConfig(
  get: (key: string) => string | undefined,
): ShopifyConfig {
  const value = (key: string) => get(key)?.trim() || undefined;
  const shop = value('SHOPIFY_SHOP');
  const clientId = value('SHOPIFY_CLIENT_ID');
  const clientSecret = value('SHOPIFY_CLIENT_SECRET');
  const missing = [
    ['SHOPIFY_SHOP', shop],
    ['SHOPIFY_CLIENT_ID', clientId],
    ['SHOPIFY_CLIENT_SECRET', clientSecret],
  ]
    .filter(([, v]) => v === undefined)
    .map(([key]) => key as string);
  if (!shop || !clientId || !clientSecret) {
    throw new ShopifyConfigError(missing);
  }
  return {
    shop: shop.replace(/\.myshopify\.com$/, ''),
    clientId,
    clientSecret,
    apiVersion: value('SHOPIFY_API_VERSION') ?? DEFAULT_SHOPIFY_API_VERSION,
  };
}
