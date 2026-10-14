import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import { DatabaseError } from '../database/db-result';
import {
  CUSTOMER_SYNC_STATUS_COLUMNS,
  SupabaseCustomerSyncStatusRepository,
} from './customer-sync-status.repository';

const fail = { data: null, error: { message: 'boom' } };

describe('SupabaseCustomerSyncStatusRepository', () => {
  it('takes the lock through the RPC and returns its token, or null when held', async () => {
    const { client, queries } = recordingSupabase({
      'rpc:try_lock_customer_sync': [
        { data: 'token-1', error: null },
        { data: null, error: null },
      ],
    });
    const repo = new SupabaseCustomerSyncStatusRepository(client);
    await expect(repo.tryLock(600)).resolves.toBe('token-1');
    await expect(repo.tryLock(600)).resolves.toBeNull();
    expect(queries[0].ops).toEqual([['rpc', { p_lease_seconds: 600 }]]);
  });

  it('releases the lock with the run outcome', async () => {
    const { client, queries } = recordingSupabase();
    const repo = new SupabaseCustomerSyncStatusRepository(client);
    await repo.finish('token-1', { fetched: 7, error: null });
    await repo.finish('token-2', { fetched: null, error: 'Shopify down' });
    expect(queries.map((q) => [q.table, ...q.ops])).toEqual([
      [
        'rpc:finish_customer_sync',
        ['rpc', { p_token: 'token-1', p_fetched: 7, p_error: null }],
      ],
      [
        'rpc:finish_customer_sync',
        [
          'rpc',
          { p_token: 'token-2', p_fetched: null, p_error: 'Shopify down' },
        ],
      ],
    ]);
  });

  it('reads the singleton status row', async () => {
    const status = {
      last_started_at: '2026-10-13T12:00:00Z',
      last_finished_at: null,
      last_success_at: null,
      last_fetched: null,
      last_error: null,
    };
    const { client, queries } = recordingSupabase({
      customer_sync_status: { data: status, error: null },
    });
    await expect(
      new SupabaseCustomerSyncStatusRepository(client).status(),
    ).resolves.toEqual(status);
    expect(queries[0].ops).toEqual([
      ['select', CUSTOMER_SYNC_STATUS_COLUMNS],
      ['eq', 'id', true],
      ['maybeSingle'],
    ]);
  });

  it('stores the incremental watermark and the reconcile outcome under the lock token', async () => {
    const { client, queries } = recordingSupabase();
    const repo = new SupabaseCustomerSyncStatusRepository(client);
    await repo.setIncrementalSince('2026-10-13T11:58:00.000Z');
    await repo.finishReconcile('token-1', '2026-10-14T03:00:00.000Z', 'nope');
    expect(queries.map((q) => [q.table, ...q.ops])).toEqual([
      [
        'customer_sync_status',
        ['update', { incremental_since: '2026-10-13T11:58:00.000Z' }],
        ['eq', 'id', true],
      ],
      [
        'customer_sync_status',
        [
          'update',
          {
            last_reconcile_at: '2026-10-14T03:00:00.000Z',
            last_reconcile_error: 'nope',
          },
        ],
        ['eq', 'id', true],
        ['eq', 'lock_token', 'token-1'],
      ],
    ]);
  });

  it.each([
    [
      'setIncrementalSince',
      (r: SupabaseCustomerSyncStatusRepository) => r.setIncrementalSince('x'),
      'customer_sync_status',
    ],
    [
      'finishReconcile',
      (r: SupabaseCustomerSyncStatusRepository) =>
        r.finishReconcile('t', 'x', null),
      'customer_sync_status',
    ],
    [
      'tryLock',
      (r: SupabaseCustomerSyncStatusRepository) => r.tryLock(1),
      'rpc:try_lock_customer_sync',
    ],
    [
      'finish',
      (r: SupabaseCustomerSyncStatusRepository) =>
        r.finish('t', { fetched: 0, error: null }),
      'rpc:finish_customer_sync',
    ],
    [
      'status',
      (r: SupabaseCustomerSyncStatusRepository) => r.status(),
      'customer_sync_status',
    ],
  ])('%s surfaces database errors', async (_name, call, key) => {
    const { client } = recordingSupabase({ [key]: fail });
    await expect(
      call(new SupabaseCustomerSyncStatusRepository(client)),
    ).rejects.toThrow(DatabaseError);
  });
});
