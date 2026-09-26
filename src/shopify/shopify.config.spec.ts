import {
  DEFAULT_SHOPIFY_API_VERSION,
  readShopifyConfig,
} from './shopify.config';
import { ShopifyConfigError } from './shopify.errors';

const lookup = (values: Record<string, string>) => (key: string) => values[key];

describe('readShopifyConfig', () => {
  it('reads the shop, credentials and a default API version', () => {
    expect(
      readShopifyConfig(
        lookup({
          SHOPIFY_SHOP: 'acme',
          SHOPIFY_CLIENT_ID: 'id',
          SHOPIFY_CLIENT_SECRET: 'secret',
        }),
      ),
    ).toEqual({
      shop: 'acme',
      clientId: 'id',
      clientSecret: 'secret',
      apiVersion: DEFAULT_SHOPIFY_API_VERSION,
    });
  });

  it('accepts an explicit API version and a full myshopify domain', () => {
    const config = readShopifyConfig(
      lookup({
        SHOPIFY_SHOP: ' acme.myshopify.com ',
        SHOPIFY_CLIENT_ID: 'id',
        SHOPIFY_CLIENT_SECRET: 'secret',
        SHOPIFY_API_VERSION: '2026-10',
      }),
    );
    expect(config.shop).toBe('acme');
    expect(config.apiVersion).toBe('2026-10');
  });

  it('lists every missing or blank variable', () => {
    let error: unknown;
    try {
      readShopifyConfig(lookup({ SHOPIFY_CLIENT_ID: '  ' }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ShopifyConfigError);
    expect((error as ShopifyConfigError).missing).toEqual([
      'SHOPIFY_SHOP',
      'SHOPIFY_CLIENT_ID',
      'SHOPIFY_CLIENT_SECRET',
    ]);
    expect((error as Error).message).toMatch(/SHOPIFY_SHOP/);
  });
});
