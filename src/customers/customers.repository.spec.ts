import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import { DatabaseError } from '../database/db-result';
import {
  CUSTOMER_COLUMNS,
  SupabaseCustomersRepository,
} from './customers.repository';

const row = {
  shopify_customer_id: 501,
  first_name: 'Mei',
  last_name: 'Wang',
  email: null,
  phone: null,
  shopify_updated_at: '2026-10-01T00:00:00Z',
};
const fail = { data: null, error: { message: 'boom' } };

describe('SupabaseCustomersRepository', () => {
  it('searches search_text with one escaped ilike per token', async () => {
    const { client, queries } = recordingSupabase({
      customers: { data: [row], error: null },
    });
    await expect(
      new SupabaseCustomersRepository(client).search(['Wang', '50%'], 20),
    ).resolves.toEqual([row]);
    expect(queries[0].ops).toEqual([
      ['select', CUSTOMER_COLUMNS],
      ['ilike', 'search_text', '%wang%'],
      ['ilike', 'search_text', '%50\\%%'],
      ['order', 'last_name', { ascending: true, nullsFirst: false }],
      ['order', 'first_name', { ascending: true, nullsFirst: false }],
      ['order', 'id', { ascending: true }],
      ['limit', 20],
    ]);
    expect(CUSTOMER_COLUMNS).not.toMatch(/wechat/);
  });

  it('reads the newest Shopify update as the sync cursor', async () => {
    const { client, queries } = recordingSupabase({
      customers: [
        { data: { shopify_updated_at: '2026-10-01T00:00:00Z' }, error: null },
        { data: null, error: null },
      ],
    });
    const repo = new SupabaseCustomersRepository(client);
    await expect(repo.latestShopifyUpdatedAt()).resolves.toBe(
      '2026-10-01T00:00:00Z',
    );
    await expect(repo.latestShopifyUpdatedAt()).resolves.toBeNull();
    expect(queries[0].ops).toEqual([
      ['select', 'shopify_updated_at'],
      ['not', 'shopify_updated_at', 'is', null],
      ['order', 'shopify_updated_at', { ascending: false }],
      ['limit', 1],
      ['maybeSingle'],
    ]);
  });

  it('upserts on shopify_customer_id and skips empty batches', async () => {
    const { client, queries } = recordingSupabase({
      customers: [
        { data: null, error: null },
        { data: { id: 'c1', ...row }, error: null },
      ],
    });
    const repo = new SupabaseCustomersRepository(client);
    await repo.upsertMany([]);
    await repo.upsertMany([row]);
    await expect(repo.upsertOne(row)).resolves.toMatchObject({ id: 'c1' });
    expect(queries).toHaveLength(2);
    expect(queries[0].ops[0]).toEqual([
      'upsert',
      [row],
      { onConflict: 'shopify_customer_id' },
    ]);
    expect(queries[1].ops[0]).toEqual([
      'upsert',
      row,
      { onConflict: 'shopify_customer_id' },
    ]);
  });

  it('fails when upsertOne returns no row', async () => {
    await expect(
      new SupabaseCustomersRepository(recordingSupabase().client).upsertOne(
        row,
      ),
    ).rejects.toThrow('no row returned');
  });

  it.each([
    ['search', (r: SupabaseCustomersRepository) => r.search([], 1)],
    [
      'latestShopifyUpdatedAt',
      (r: SupabaseCustomersRepository) => r.latestShopifyUpdatedAt(),
    ],
    ['upsertMany', (r: SupabaseCustomersRepository) => r.upsertMany([row])],
    ['upsertOne', (r: SupabaseCustomersRepository) => r.upsertOne(row)],
  ])('%s surfaces database errors', async (_name, call) => {
    const { client } = recordingSupabase({ customers: fail });
    await expect(call(new SupabaseCustomersRepository(client))).rejects.toThrow(
      DatabaseError,
    );
  });
});
