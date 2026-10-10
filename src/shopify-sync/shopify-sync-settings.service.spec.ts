import type { ConfigService } from '@nestjs/config';
import {
  isMasterSwitchOn,
  isShopifyConfigured,
} from './shopify-sync-settings.service';

const configOf = (env: Record<string, string | undefined>) =>
  ({ get: (key: string) => env[key] }) as ConfigService;

describe('Shopify sync environment', () => {
  it.each([
    ['true', true],
    [' true ', true],
    ['TRUE', false],
    ['1', false],
    [undefined, false],
  ])('master switch %j is on: %s', (value, on) => {
    expect(isMasterSwitchOn(configOf({ SHOPIFY_SYNC_ENABLED: value }))).toBe(
      on,
    );
  });

  it('is configured only with shop, client id and client secret', () => {
    const full = {
      SHOPIFY_SHOP: 'acme',
      SHOPIFY_CLIENT_ID: 'id',
      SHOPIFY_CLIENT_SECRET: 'secret',
    };
    expect(isShopifyConfigured(configOf(full))).toBe(true);
    expect(
      isShopifyConfigured(configOf({ ...full, SHOPIFY_CLIENT_SECRET: ' ' })),
    ).toBe(false);
  });

  it('rethrows unexpected config errors', () => {
    const config = {
      get: () => {
        throw new Error('config exploded');
      },
    } as unknown as ConfigService;
    expect(() => isShopifyConfigured(config)).toThrow('config exploded');
  });
});
