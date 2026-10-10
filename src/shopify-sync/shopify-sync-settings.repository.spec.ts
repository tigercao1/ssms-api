import { SupabaseShopifySyncSettingsRepository } from './shopify-sync-settings.repository';

interface Result {
  data: unknown;
  error: { message: string } | null;
}

function fakeSupabase(
  tables: Record<string, Result> = {},
  rpcs: Record<string, Result> = {},
) {
  const queries: { table: string; ops: [string, ...unknown[]][] }[] = [];
  const rpcCalls: { name: string; args: unknown }[] = [];
  const client = {
    from(table: string) {
      const query = { table, ops: [] as [string, ...unknown[]][] };
      queries.push(query);
      const result = tables[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {
        then: (resolve: (r: Result) => unknown, reject: (e: unknown) => void) =>
          Promise.resolve(result).then(resolve, reject),
      };
      for (const op of ['select', 'eq', 'update', 'maybeSingle']) {
        builder[op] = (...args: unknown[]) => {
          query.ops.push([op, ...args]);
          return builder;
        };
      }
      return builder;
    },
    rpc(name: string, args?: unknown) {
      rpcCalls.push({ name, args });
      return Promise.resolve(rpcs[name] ?? { data: null, error: null });
    },
  };
  return {
    repo: new SupabaseShopifySyncSettingsRepository(client as never),
    queries,
    rpcCalls,
  };
}

const anyString: unknown = expect.any(String);
const failure = { data: null, error: { message: 'boom' } };
const settingsRow = {
  enabled: true,
  updated_at: '2026-10-10T04:00:00.000Z',
  updated_by: 'admin-1',
  last_tick_at: null,
  last_success_at: null,
  last_error: null,
  last_error_at: null,
};

describe('SupabaseShopifySyncSettingsRepository', () => {
  it('reads the single settings row', async () => {
    const { repo, queries } = fakeSupabase({
      shopify_sync_settings: { data: settingsRow, error: null },
    });
    await expect(repo.getSettings()).resolves.toEqual(settingsRow);
    expect(queries[0].ops).toEqual([
      [
        'select',
        'enabled, updated_at, updated_by, last_tick_at, last_success_at, last_error, last_error_at',
      ],
      ['eq', 'id', true],
      ['maybeSingle'],
    ]);
  });

  it('returns null when the row is missing', async () => {
    const { repo } = fakeSupabase();
    await expect(repo.getSettings()).resolves.toBeNull();
  });

  it('writes the flag with who changed it and when', async () => {
    const { repo, queries } = fakeSupabase({
      shopify_sync_settings: { data: settingsRow, error: null },
    });
    await expect(repo.setEnabled(true, 'admin-1')).resolves.toEqual(
      settingsRow,
    );
    const [update, eq] = queries[0].ops;
    expect(update).toEqual([
      'update',
      { enabled: true, updated_by: 'admin-1', updated_at: anyString },
    ]);
    expect(eq).toEqual(['eq', 'id', true]);
  });

  it('fails when there is no settings row to update', async () => {
    const { repo } = fakeSupabase();
    await expect(repo.setEnabled(false, null)).rejects.toThrow(
      'Shopify sync settings row is missing',
    );
  });

  it('writes heartbeat columns only', async () => {
    const { repo, queries } = fakeSupabase();
    await repo.recordHeartbeat({ last_tick_at: '2026-10-10T04:00:00.000Z' });
    expect(queries[0].ops).toEqual([
      ['update', { last_tick_at: '2026-10-10T04:00:00.000Z' }],
      ['eq', 'id', true],
    ]);
  });

  it('maps the stats RPC', async () => {
    const { repo, rpcCalls } = fakeSupabase(
      {},
      {
        shopify_sync_stats: {
          data: [
            {
              pending: 3,
              retrying: 1,
              failed: 2,
              oldest_enqueued_at: '2026-10-10T03:00:00+00:00',
              synced: 40,
              active: 38,
              draft: 2,
            },
          ],
          error: null,
        },
      },
    );
    await expect(repo.stats(10)).resolves.toEqual({
      pending: 3,
      retrying: 1,
      failed: 2,
      oldestEnqueuedAt: '2026-10-10T03:00:00+00:00',
      synced: 40,
      active: 38,
      draft: 2,
    });
    expect(rpcCalls).toEqual([
      { name: 'shopify_sync_stats', args: { p_max_attempts: 10 } },
    ]);
  });

  it('reports zeros when the stats RPC returns nothing', async () => {
    const { repo } = fakeSupabase();
    await expect(repo.stats(10)).resolves.toEqual({
      pending: 0,
      retrying: 0,
      failed: 0,
      oldestEnqueuedAt: null,
      synced: 0,
      active: 0,
      draft: 0,
    });
  });

  it('reads one queue row', async () => {
    const queued = {
      instructor_id: 'i-1',
      enqueued_at: '2026-10-10T03:00:00+00:00',
      attempts: 1,
      last_error: 'x',
    };
    const { repo, queries } = fakeSupabase({
      instructor_sync_queue: { data: queued, error: null },
    });
    await expect(repo.queueRow('i-1')).resolves.toEqual(queued);
    expect(queries[0].ops).toContainEqual(['eq', 'instructor_id', 'i-1']);
    await expect(fakeSupabase().repo.queueRow('i-1')).resolves.toBeNull();
  });

  it('checks whether an instructor exists', async () => {
    const found = fakeSupabase({
      instructors: { data: { id: 'i-1' }, error: null },
    });
    await expect(found.repo.instructorExists('i-1')).resolves.toBe(true);
    expect(found.queries[0].ops).toContainEqual(['eq', 'id', 'i-1']);
    await expect(fakeSupabase().repo.instructorExists('i-1')).resolves.toBe(
      false,
    );
  });

  it('enqueues one instructor through the RPC', async () => {
    const { repo, rpcCalls } = fakeSupabase();
    await repo.enqueueInstructor('i-1');
    expect(rpcCalls).toEqual([
      { name: 'enqueue_one_instructor_sync', args: { p_instructor_id: 'i-1' } },
    ]);
  });

  it.each([
    [
      'getSettings',
      (r: SupabaseShopifySyncSettingsRepository) => r.getSettings(),
    ],
    [
      'setEnabled',
      (r: SupabaseShopifySyncSettingsRepository) => r.setEnabled(true, null),
    ],
    [
      'recordHeartbeat',
      (r: SupabaseShopifySyncSettingsRepository) => r.recordHeartbeat({}),
    ],
    ['stats', (r: SupabaseShopifySyncSettingsRepository) => r.stats(10)],
    ['queueRow', (r: SupabaseShopifySyncSettingsRepository) => r.queueRow('i')],
    [
      'instructorExists',
      (r: SupabaseShopifySyncSettingsRepository) => r.instructorExists('i'),
    ],
    [
      'enqueueInstructor',
      (r: SupabaseShopifySyncSettingsRepository) => r.enqueueInstructor('i'),
    ],
  ])('%s surfaces database errors', async (_name, call) => {
    const { repo } = fakeSupabase(
      {
        shopify_sync_settings: failure,
        instructor_sync_queue: failure,
        instructors: failure,
      },
      { shopify_sync_stats: failure, enqueue_one_instructor_sync: failure },
    );
    await expect(call(repo)).rejects.toThrow(/boom/);
  });
});
