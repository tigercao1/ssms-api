import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { ShopifySyncAdminController } from './shopify-sync-admin.controller';
import { ShopifySyncController } from './shopify-sync.controller';
import { ShopifySyncWorker } from './shopify-sync.worker';

describe('ShopifySyncModule in the app', () => {
  const keys = [
    'SHOPIFY_SYNC_ENABLED',
    'SHOPIFY_SHOP',
    'SHOPIFY_CLIENT_ID',
    'SHOPIFY_CLIENT_SECRET',
    'SHOPIFY_RECONCILE_TOKEN',
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const originalFetch = global.fetch;

  beforeEach(() => {
    for (const key of keys) delete process.env[key];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('boots with no Shopify env, logs that sync is off and touches nothing', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const supabase = { from: jest.fn(), rpc: jest.fn() };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SUPABASE_CLIENT)
      .useValue(supabase)
      .compile();
    await moduleRef.init();

    expect(moduleRef.get(ShopifySyncController)).toBeInstanceOf(
      ShopifySyncController,
    );
    expect(moduleRef.get(ShopifySyncAdminController)).toBeInstanceOf(
      ShopifySyncAdminController,
    );
    expect(moduleRef.get(ShopifySyncWorker).mode().enabled).toBe(false);
    expect(logs).toHaveBeenCalledWith(
      'Shopify sync disabled: SHOPIFY_SYNC_ENABLED is not "true"',
    );
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await moduleRef.close();
  });
});
