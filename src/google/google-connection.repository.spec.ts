import {
  GOOGLE_CONNECTION_COLUMNS,
  GOOGLE_CONNECTION_TABLE,
  SupabaseGoogleConnectionRepository,
} from './google-connection.repository';
import type { GoogleConnectionRow } from './google.types';

interface Result {
  data: unknown;
  error: { message: string } | null;
}

function fakeSupabase(result: Result = { data: null, error: null }) {
  const queries: { table: string; ops: [string, ...unknown[]][] }[] = [];
  const client = {
    from(table: string) {
      const query = { table, ops: [] as [string, ...unknown[]][] };
      queries.push(query);
      const builder: Record<string, unknown> = {
        then: (resolve: (r: Result) => unknown, reject: (e: unknown) => void) =>
          Promise.resolve(result).then(resolve, reject),
      };
      for (const op of [
        'select',
        'eq',
        'upsert',
        'update',
        'delete',
        'single',
        'maybeSingle',
      ]) {
        builder[op] = (...args: unknown[]) => {
          query.ops.push([op, ...args]);
          return builder;
        };
      }
      return builder;
    },
  };
  return {
    repo: new SupabaseGoogleConnectionRepository(client as never),
    queries,
  };
}

const row: GoogleConnectionRow = {
  account_email: 'admin@ssnow.club',
  refresh_token_enc: 'v1:a:b:c',
  scopes: ['s'],
  connected_at: '2026-10-11T00:00:00.000Z',
  connected_by: 'admin-1',
  last_refresh_at: null,
  last_error: null,
  last_error_at: null,
};

describe('SupabaseGoogleConnectionRepository', () => {
  it('reads the single row', async () => {
    const { repo, queries } = fakeSupabase({ data: row, error: null });
    await expect(repo.get()).resolves.toEqual(row);
    expect(queries[0]).toEqual({
      table: GOOGLE_CONNECTION_TABLE,
      ops: [
        ['select', GOOGLE_CONNECTION_COLUMNS],
        ['eq', 'id', true],
        ['maybeSingle'],
      ],
    });
  });

  it('returns null when nothing is connected', async () => {
    const { repo } = fakeSupabase();
    await expect(repo.get()).resolves.toBeNull();
  });

  it('upserts the single row and clears previous errors', async () => {
    const { repo, queries } = fakeSupabase({ data: row, error: null });
    await repo.save({
      accountEmail: 'admin@ssnow.club',
      refreshTokenEnc: 'v1:a:b:c',
      scopes: ['s'],
      connectedBy: 'admin-1',
      connectedAt: '2026-10-11T00:00:00.000Z',
    });
    expect(queries[0].ops[0]).toEqual([
      'upsert',
      {
        id: true,
        account_email: 'admin@ssnow.club',
        refresh_token_enc: 'v1:a:b:c',
        scopes: ['s'],
        connected_at: '2026-10-11T00:00:00.000Z',
        connected_by: 'admin-1',
        last_refresh_at: '2026-10-11T00:00:00.000Z',
        last_error: null,
        last_error_at: null,
      },
      { onConflict: 'id' },
    ]);
  });

  it('fails loudly when the upsert returns no row', async () => {
    const { repo } = fakeSupabase();
    await expect(
      repo.save({
        accountEmail: 'a',
        refreshTokenEnc: 'b',
        scopes: [],
        connectedBy: null,
        connectedAt: 'now',
      }),
    ).rejects.toThrow('no row returned');
  });

  it('records a refresh and clears the error', async () => {
    const { repo, queries } = fakeSupabase();
    await repo.recordRefresh('2026-10-11T01:00:00.000Z');
    expect(queries[0].ops).toEqual([
      [
        'update',
        {
          last_refresh_at: '2026-10-11T01:00:00.000Z',
          last_error: null,
          last_error_at: null,
        },
      ],
      ['eq', 'id', true],
    ]);
  });

  it('records an error, optionally clearing the token', async () => {
    const { repo, queries } = fakeSupabase();
    await repo.recordError('boom', 't1');
    await repo.recordError('invalid_grant', 't2', { clearToken: true });
    expect(queries[0].ops[0]).toEqual([
      'update',
      { last_error: 'boom', last_error_at: 't1' },
    ]);
    expect(queries[1].ops[0]).toEqual([
      'update',
      {
        last_error: 'invalid_grant',
        last_error_at: 't2',
        refresh_token_enc: null,
      },
    ]);
  });

  it('deletes the row', async () => {
    const { repo, queries } = fakeSupabase();
    await repo.delete();
    expect(queries[0].ops).toEqual([['delete'], ['eq', 'id', true]]);
  });

  it.each([
    ['get', (r: SupabaseGoogleConnectionRepository) => r.get()],
    [
      'recordRefresh',
      (r: SupabaseGoogleConnectionRepository) => r.recordRefresh('t'),
    ],
    [
      'recordError',
      (r: SupabaseGoogleConnectionRepository) => r.recordError('m', 't'),
    ],
    ['delete', (r: SupabaseGoogleConnectionRepository) => r.delete()],
  ])('surfaces database errors from %s', async (_name, call) => {
    const { repo } = fakeSupabase({ data: null, error: { message: 'denied' } });
    await expect(call(repo)).rejects.toThrow('denied');
  });
});
