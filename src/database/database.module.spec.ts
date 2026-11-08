import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DatabaseModule } from './database.module';
import { SUPABASE_CLIENT } from './supabase-client.token';

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function clientWith(env: Record<string, string>) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        ignoreEnvVars: true,
        load: [
          () => ({
            SUPABASE_URL: 'http://localhost',
            SUPABASE_SECRET_KEY: 'test',
            ...env,
          }),
        ],
      }),
      DatabaseModule,
    ],
  }).compile();
  return moduleRef.get<SupabaseClient>(SUPABASE_CLIENT);
}

describe('DatabaseModule', () => {
  let release: (() => void)[];

  beforeEach(() => {
    release = [];
    jest.spyOn(global, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) =>
          release.push(() =>
            resolve(
              new Response('[]', {
                headers: { 'content-type': 'application/json' },
              }),
            ),
          ),
        ),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const queryTwice = (client: SupabaseClient) =>
    Promise.all([
      client.from('instructors').select('id'),
      client.from('customers').select('id'),
    ]);

  it('sends requests without a cap by default', async () => {
    const done = queryTwice(await clientWith({}));
    await settle();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    release.forEach((r) => r());
    await done;
  });

  it('caps in-flight requests at SUPABASE_MAX_CONCURRENT_REQUESTS', async () => {
    const done = queryTwice(
      await clientWith({ SUPABASE_MAX_CONCURRENT_REQUESTS: '1' }),
    );
    await settle();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    release[0]();
    await settle();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    release[1]();
    await done;
  });

  it('refuses to boot with an invalid cap', async () => {
    await expect(
      clientWith({ SUPABASE_MAX_CONCURRENT_REQUESTS: '0' }),
    ).rejects.toThrow('SUPABASE_MAX_CONCURRENT_REQUESTS');
  });
});
