import { InternalServerErrorException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseAdminApiTokensRepository } from './admin-api-tokens.repository';

type Result = { data: unknown; error: { message: string } | null };

class RecordingSupabase {
  queries: { table: string; calls: [string, unknown[]][] }[] = [];
  rpcs: { name: string; args: unknown }[] = [];
  results: Result[] = [];

  private next(): Promise<Result> {
    return Promise.resolve(this.results.shift() ?? { data: null, error: null });
  }

  from(table: string) {
    const query = { table, calls: [] as [string, unknown[]][] };
    this.queries.push(query);
    const builder: Record<string, unknown> = {};
    for (const method of [
      'select',
      'insert',
      'update',
      'eq',
      'is',
      'lt',
      'order',
      'returns',
    ]) {
      builder[method] = (...args: unknown[]) => {
        query.calls.push([method, args]);
        return builder;
      };
    }
    builder.single = () => this.next();
    builder.maybeSingle = () => this.next();
    builder.then = (resolve: (r: Result) => unknown) =>
      this.next().then(resolve);
    return builder;
  }

  rpc(name: string, args: unknown) {
    this.rpcs.push({ name, args });
    return this.next();
  }
}

function setup() {
  const db = new RecordingSupabase();
  return {
    db,
    repo: new SupabaseAdminApiTokensRepository(db as unknown as SupabaseClient),
  };
}

const ROW = { id: 'token-1', name: 'laptop' };

describe('SupabaseAdminApiTokensRepository', () => {
  it('stores the hash on insert and never selects it back', async () => {
    const { db, repo } = setup();
    db.results = [{ data: ROW, error: null }];

    await expect(
      repo.insert({
        ownerUserId: 'owner-1',
        name: 'laptop',
        tokenHash: 'f'.repeat(64),
        tokenPrefix: 'ssms_pat_abcd',
        tokenLast4: 'wxyz',
        expiresAt: null,
      }),
    ).resolves.toEqual(ROW);

    const [insert, select] = db.queries[0].calls;
    expect(insert).toEqual([
      'insert',
      [
        {
          owner_user_id: 'owner-1',
          name: 'laptop',
          token_hash: 'f'.repeat(64),
          token_prefix: 'ssms_pat_abcd',
          token_last4: 'wxyz',
          expires_at: null,
        },
      ],
    ]);
    expect(select[1][0]).not.toContain('token_hash');
  });

  it('lists an owner’s tokens newest first and finds a token by hash', async () => {
    const { db, repo } = setup();
    db.results = [
      { data: [ROW], error: null },
      { data: null, error: null },
    ];

    await expect(repo.listByOwner('owner-1')).resolves.toEqual([ROW]);
    await expect(repo.findByHash('a'.repeat(64))).resolves.toBeNull();

    expect(db.queries[0].calls).toContainEqual([
      'eq',
      ['owner_user_id', 'owner-1'],
    ]);
    expect(db.queries[0].calls).toContainEqual([
      'order',
      ['created_at', { ascending: false }],
    ]);
    expect(db.queries[1].calls).toContainEqual([
      'eq',
      ['token_hash', 'a'.repeat(64)],
    ]);
  });

  it('rotates through the rpc and returns its row, or null when nothing was rotated', async () => {
    const { db, repo } = setup();
    db.results = [
      { data: [ROW], error: null },
      { data: [], error: null },
    ];
    const rotation = {
      tokenId: 'token-1',
      ownerUserId: 'owner-1',
      tokenHash: 'b'.repeat(64),
      tokenPrefix: 'ssms_pat_efgh',
      tokenLast4: 'stuv',
      keepExpiry: true,
      expiresAt: null,
      graceMinutes: 10,
    };

    await expect(repo.rotate(rotation)).resolves.toEqual(ROW);
    await expect(repo.rotate(rotation)).resolves.toBeNull();
    expect(db.rpcs[0]).toEqual({
      name: 'rotate_admin_api_token',
      args: {
        p_token_id: 'token-1',
        p_owner_user_id: 'owner-1',
        p_token_hash: 'b'.repeat(64),
        p_token_prefix: 'ssms_pat_efgh',
        p_token_last4: 'stuv',
        p_keep_expiry: true,
        p_expires_at: null,
        p_grace_minutes: 10,
      },
    });
  });

  it('tells a fresh revoke from a repeat and a missing token', async () => {
    const { db, repo } = setup();
    db.results = [
      { data: [{ id: 'token-1' }], error: null },
      { data: [], error: null },
      { data: { id: 'token-1' }, error: null },
      { data: [], error: null },
      { data: null, error: null },
    ];
    const at = '2026-11-08T17:00:00.000Z';

    await expect(repo.revoke('token-1', 'owner-1', at)).resolves.toBe(
      'revoked',
    );
    await expect(repo.revoke('token-1', 'owner-1', at)).resolves.toBe(
      'already_revoked',
    );
    await expect(repo.revoke('token-2', 'owner-1', at)).resolves.toBe(
      'missing',
    );
    expect(db.queries[0].calls).toEqual([
      ['update', [{ revoked_at: at }]],
      ['eq', ['id', 'token-1']],
      ['eq', ['owner_user_id', 'owner-1']],
      ['is', ['revoked_at', null]],
      ['select', ['id']],
    ]);
  });

  it('records the first use only while last_used_at is empty and later uses only when older', async () => {
    const { db, repo } = setup();
    db.results = [
      { data: [{ id: 'token-1' }], error: null },
      { data: [], error: null },
      { data: null, error: null },
    ];

    await expect(repo.markFirstUse('token-1', 'now')).resolves.toBe(true);
    await expect(repo.markFirstUse('token-1', 'now')).resolves.toBe(false);
    await repo.markUsed('token-1', 'now', 'a minute ago');

    expect(db.queries[0].calls).toContainEqual(['is', ['last_used_at', null]]);
    expect(db.queries[2].calls).toContainEqual([
      'lt',
      ['last_used_at', 'a minute ago'],
    ]);
  });

  it.each([
    [
      'insert',
      (r: SupabaseAdminApiTokensRepository) =>
        r.insert({
          ownerUserId: 'o',
          name: 'n',
          tokenHash: 'h',
          tokenPrefix: 'p',
          tokenLast4: 'l',
          expiresAt: null,
        }),
    ],
    [
      'listByOwner',
      (r: SupabaseAdminApiTokensRepository) => r.listByOwner('o'),
    ],
    ['findByHash', (r: SupabaseAdminApiTokensRepository) => r.findByHash('h')],
    [
      'revoke',
      (r: SupabaseAdminApiTokensRepository) => r.revoke('t', 'o', 'at'),
    ],
    [
      'markFirstUse',
      (r: SupabaseAdminApiTokensRepository) => r.markFirstUse('t', 'at'),
    ],
    [
      'markUsed',
      (r: SupabaseAdminApiTokensRepository) => r.markUsed('t', 'at', 'before'),
    ],
  ])('%s raises a 500 on a database error', async (_name, call) => {
    const { db, repo } = setup();
    db.results = [{ data: null, error: { message: 'boom' } }];
    await expect(call(repo)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('raises a 500 when the rotation rpc fails', async () => {
    const { db, repo } = setup();
    db.results = [{ data: null, error: { message: 'boom' } }];
    await expect(
      repo.rotate({
        tokenId: 't',
        ownerUserId: 'o',
        tokenHash: 'h',
        tokenPrefix: 'p',
        tokenLast4: 'l',
        keepExpiry: true,
        expiresAt: null,
        graceMinutes: 0,
      }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
