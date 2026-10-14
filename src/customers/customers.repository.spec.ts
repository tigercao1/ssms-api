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
  it('searches search_text with one escaped ilike per token, one page at a time, with an exact count', async () => {
    const { client, queries } = recordingSupabase({
      customers: { data: [row], error: null, count: 41 },
    });
    await expect(
      new SupabaseCustomersRepository(client).search(['Wang', '50%'], {
        limit: 20,
        offset: 40,
      }),
    ).resolves.toEqual({ rows: [row], total: 41 });
    expect(queries[0].ops).toEqual([
      ['select', CUSTOMER_COLUMNS, { count: 'exact' }],
      ['is', 'shopify_deleted_at', null],
      ['ilike', 'search_text', '%wang%'],
      ['ilike', 'search_text', '%50\\%%'],
      ['order', 'last_name', { ascending: true, nullsFirst: false }],
      ['order', 'first_name', { ascending: true, nullsFirst: false }],
      ['order', 'id', { ascending: true }],
      ['range', 40, 59],
    ]);
    expect(CUSTOMER_COLUMNS).not.toMatch(/wechat/);
  });

  it('answers a page past the end with no rows and the real total', async () => {
    const { client, queries } = recordingSupabase({
      customers: [
        {
          data: null,
          error: {
            message: 'Requested range not satisfiable',
            code: 'PGRST103',
          },
        },
        { data: null, error: null, count: 3 },
      ],
    });
    await expect(
      new SupabaseCustomersRepository(client).search(['wang'], {
        limit: 50,
        offset: 500,
      }),
    ).resolves.toEqual({ rows: [], total: 3 });
    expect(queries[1].ops).toEqual([
      ['select', 'id', { count: 'exact', head: true }],
      ['is', 'shopify_deleted_at', null],
      ['ilike', 'search_text', '%wang%'],
    ]);
  });

  it('includes customers deleted in Shopify only when asked', async () => {
    const { client, queries } = recordingSupabase({
      customers: [
        { data: null, error: { message: 'range', code: 'PGRST103' } },
        { data: null, error: null, count: 4 },
      ],
    });
    await expect(
      new SupabaseCustomersRepository(client).search(['li'], {
        limit: 10,
        offset: 90,
        includeDeleted: true,
      }),
    ).resolves.toEqual({ rows: [], total: 4 });
    expect(queries.flatMap((q) => q.ops).map(([op]) => op)).not.toContain('is');
  });

  it('upserts through upsert_customer_if_newer and returns its outcome', async () => {
    const { client, queries } = recordingSupabase({
      'rpc:upsert_customer_if_newer': [
        { data: 'stale', error: null },
        { data: null, error: null },
      ],
    });
    const repo = new SupabaseCustomersRepository(client);
    await expect(repo.upsertIfNewer(row)).resolves.toBe('stale');
    await expect(repo.upsertIfNewer(row)).rejects.toThrow('no outcome');
    expect(queries[0].ops).toEqual([
      [
        'rpc',
        {
          p_shopify_customer_id: 501,
          p_first_name: 'Mei',
          p_last_name: 'Wang',
          p_email: null,
          p_phone: null,
          p_shopify_updated_at: '2026-10-01T00:00:00Z',
        },
      ],
    ]);
  });

  it('marks deletions and reconciles through their RPCs', async () => {
    const { client, queries } = recordingSupabase({
      'rpc:mark_customer_deleted_in_shopify': [
        { data: true, error: null },
        { data: false, error: null },
      ],
      'rpc:reconcile_customer_deletions': [
        { data: { deleted: 2, restored: 1 }, error: null },
        { data: null, error: null },
      ],
    });
    const repo = new SupabaseCustomersRepository(client);
    await expect(
      repo.markDeletedInShopify(501, '2026-10-02T00:00:00Z'),
    ).resolves.toBe(true);
    await expect(
      repo.markDeletedInShopify(501, '2026-10-02T00:00:00Z'),
    ).resolves.toBe(false);
    await expect(
      repo.reconcileDeletions([1, 2], '2026-10-14T03:00:00Z'),
    ).resolves.toEqual({ deleted: 2, restored: 1 });
    await expect(
      repo.reconcileDeletions([], '2026-10-14T03:00:00Z'),
    ).resolves.toEqual({ deleted: 0, restored: 0 });
    expect(queries.map((q) => q.ops[0])).toEqual([
      [
        'rpc',
        { p_shopify_customer_id: 501, p_deleted_at: '2026-10-02T00:00:00Z' },
      ],
      [
        'rpc',
        { p_shopify_customer_id: 501, p_deleted_at: '2026-10-02T00:00:00Z' },
      ],
      ['rpc', { p_shopify_ids: [1, 2], p_started_at: '2026-10-14T03:00:00Z' }],
      ['rpc', { p_shopify_ids: [], p_started_at: '2026-10-14T03:00:00Z' }],
    ]);
  });

  it('counts active and deleted customers', async () => {
    const { client, queries } = recordingSupabase({
      customers: [
        { data: null, error: null, count: 7 },
        { data: null, error: null },
      ],
    });
    const repo = new SupabaseCustomersRepository(client);
    await expect(repo.countCustomers(false)).resolves.toBe(7);
    await expect(repo.countCustomers(true)).resolves.toBe(0);
    expect(queries.map((q) => q.ops[1])).toEqual([
      ['is', 'shopify_deleted_at', null],
      ['not', 'shopify_deleted_at', 'is', null],
    ]);
  });

  it('surfaces a failing count for a page past the end', async () => {
    const { client } = recordingSupabase({
      customers: [
        { data: null, error: { message: 'range', code: 'PGRST103' } },
        fail,
      ],
    });
    await expect(
      new SupabaseCustomersRepository(client).search([], {
        limit: 1,
        offset: 9,
      }),
    ).rejects.toThrow('Failed to count customers');
  });

  it('treats a missing count as zero', async () => {
    const { client } = recordingSupabase({
      customers: { data: [], error: null },
    });
    await expect(
      new SupabaseCustomersRepository(client).search([], {
        limit: 1,
        offset: 0,
      }),
    ).resolves.toEqual({ rows: [], total: 0 });
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
    [
      'search',
      (r: SupabaseCustomersRepository) => r.search([], { limit: 1, offset: 0 }),
    ],
    [
      'latestShopifyUpdatedAt',
      (r: SupabaseCustomersRepository) => r.latestShopifyUpdatedAt(),
    ],
    ['upsertMany', (r: SupabaseCustomersRepository) => r.upsertMany([row])],
    ['upsertOne', (r: SupabaseCustomersRepository) => r.upsertOne(row)],
    ['upsertIfNewer', (r: SupabaseCustomersRepository) => r.upsertIfNewer(row)],
    [
      'markDeletedInShopify',
      (r: SupabaseCustomersRepository) => r.markDeletedInShopify(1, 'x'),
    ],
    [
      'reconcileDeletions',
      (r: SupabaseCustomersRepository) => r.reconcileDeletions([1], 'x'),
    ],
    [
      'countCustomers',
      (r: SupabaseCustomersRepository) => r.countCustomers(true),
    ],
  ])('%s surfaces database errors', async (_name, call) => {
    const { client } = recordingSupabase({
      customers: fail,
      'rpc:upsert_customer_if_newer': fail,
      'rpc:mark_customer_deleted_in_shopify': fail,
      'rpc:reconcile_customer_deletions': fail,
    });
    await expect(call(new SupabaseCustomersRepository(client))).rejects.toThrow(
      DatabaseError,
    );
  });
});
