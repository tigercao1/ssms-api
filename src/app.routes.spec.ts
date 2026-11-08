import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { listRoutes } from '../test/helpers/http-routes';
import { AppModule } from './app.module';
import { SUPABASE_CLIENT } from './database/supabase-client.token';

const PORTAL_ROUTES = readFileSync(
  join(__dirname, '../test/fixtures/portal-routes.txt'),
  'utf8',
)
  .split('\n')
  .filter((line) => line.length > 0);

describe('AppModule routes', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('serves every route the portal API served before the signing app split', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SUPABASE_CLIENT)
      .useValue({ from: jest.fn(), rpc: jest.fn() })
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    expect(listRoutes(app)).toEqual(PORTAL_ROUTES);
    await app.close();
  });
});
