import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ShopifyAdminClient } from './shopify-admin.client';
import { ShopifyConfigError } from './shopify.errors';
import { ShopifyModule } from './shopify.module';

describe('ShopifyModule', () => {
  const shopifyKeys = [
    'SHOPIFY_SHOP',
    'SHOPIFY_CLIENT_ID',
    'SHOPIFY_CLIENT_SECRET',
    'SHOPIFY_API_VERSION',
  ];
  const saved = Object.fromEntries(shopifyKeys.map((k) => [k, process.env[k]]));
  const originalFetch = global.fetch;

  beforeEach(() => {
    for (const key of shopifyKeys) delete process.env[key];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const key of shopifyKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('compiles without Shopify env or network, and fails only on first use', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ShopifyModule,
      ],
    }).compile();
    const client = moduleRef.get(ShopifyAdminClient);

    expect(client).toBeInstanceOf(ShopifyAdminClient);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      client.graphql('query { shop { name } }'),
    ).rejects.toBeInstanceOf(ShopifyConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
    await moduleRef.close();
  });
});
