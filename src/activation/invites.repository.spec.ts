import { InternalServerErrorException } from '@nestjs/common';
import { SupabaseInvitesRepository } from './invites.repository';
import { FakeSupabase } from './supabase-fake.test-util';

const NOW = new Date('2026-10-11T04:00:00Z');

const RECORD = {
  id: 'inv-1',
  instructor_id: 'ins-1',
  auth_user_id: 'auth-1',
  email: 'jane@example.test',
  token_hash: null,
  season: '2026/27',
  expires_at: null,
  sent_at: null,
  reminded_at: null,
  redeemed_at: null,
  activated_at: null,
  created_at: '2026-10-01T00:00:00Z',
};

function setup(
  ...results: Array<{ data: unknown; error: { message: string } | null }>
) {
  const db = new FakeSupabase();
  db.queue.push(...results);
  return { db, repo: new SupabaseInvitesRepository(db.asClient()) };
}

const ERR = { data: null, error: { message: 'down' } };

describe('SupabaseInvitesRepository', () => {
  it('finds by token hash', async () => {
    const { db, repo } = setup(
      { data: RECORD, error: null },
      { data: null, error: null },
    );
    expect(await repo.findByTokenHash('h')).toEqual(RECORD);
    expect(await repo.findByTokenHash('h')).toBeNull();
    expect(db.queries[0].table).toBe('instructor_invites');
    expect(db.ops(0).slice(1)).toEqual([
      ['eq', ['token_hash', 'h']],
      ['maybeSingle', []],
    ]);
  });

  it('finds the latest invite by email with instructor fields', async () => {
    const { db, repo } = setup(
      {
        data: [
          {
            ...RECORD,
            instructors: {
              display_name_en: 'Jane',
              preferred_language: 'zh-CN',
            },
          },
        ],
        error: null,
      },
      { data: [{ ...RECORD, instructors: null }], error: null },
      { data: null, error: null },
    );
    expect(await repo.findLatestByEmail('jane@example.test')).toEqual({
      ...RECORD,
      display_name_en: 'Jane',
      preferred_language: 'zh-CN',
    });
    expect(await repo.findLatestByEmail('jane@example.test')).toMatchObject({
      display_name_en: '',
      preferred_language: null,
    });
    expect(await repo.findLatestByEmail('x@example.test')).toBeNull();
    expect(db.ops(0).slice(1)).toEqual([
      ['eq', ['email', 'jane@example.test']],
      ['order', ['created_at', { ascending: false }]],
      ['limit', [1]],
    ]);
  });

  it('lists unsent invites, optionally for one email', async () => {
    const { db, repo } = setup(
      { data: [{ ...RECORD, instructors: null }], error: null },
      { data: null, error: null },
    );
    expect(await repo.listUnsent('2026/27')).toHaveLength(1);
    expect(await repo.listUnsent('2026/27', 'jane@example.test')).toEqual([]);
    expect(db.ops(0).slice(1)).toEqual([
      ['eq', ['season', '2026/27']],
      ['is', ['sent_at', null]],
      ['order', ['created_at', { ascending: true }]],
    ]);
    expect(db.ops(1)).toContainEqual(['eq', ['email', 'jane@example.test']]);
  });

  it('lists invites due for a reminder', async () => {
    const { db, repo } = setup(
      { data: [], error: null },
      { data: null, error: null },
    );
    expect(await repo.listDueForReminder('2026/27', NOW)).toEqual([]);
    expect(await repo.listDueForReminder('2026/27', NOW)).toEqual([]);
    expect(db.ops(0).slice(1)).toEqual([
      ['eq', ['season', '2026/27']],
      ['lte', ['sent_at', '2026-10-04T04:00:00.000Z']],
      ['is', ['redeemed_at', null]],
      ['is', ['reminded_at', null]],
      ['gt', ['expires_at', '2026-10-11T04:00:00.000Z']],
      ['order', ['created_at', { ascending: true }]],
    ]);
  });

  it('writes token, sent, reminded, redeemed and activated stamps', async () => {
    const { db, repo } = setup();
    await repo.setToken('inv-1', 'a'.repeat(64), NOW);
    await repo.markSent('inv-1', NOW);
    await repo.markReminded('inv-1', NOW);
    await repo.markRedeemed('inv-1', NOW);
    await repo.markActivated('auth-1', NOW);
    const at = NOW.toISOString();
    expect(db.queries.map((q) => q.ops)).toEqual([
      [
        ['update', [{ token_hash: 'a'.repeat(64), expires_at: at }]],
        ['eq', ['id', 'inv-1']],
      ],
      [
        ['update', [{ sent_at: at }]],
        ['eq', ['id', 'inv-1']],
      ],
      [
        ['update', [{ reminded_at: at }]],
        ['eq', ['id', 'inv-1']],
      ],
      [
        ['update', [{ redeemed_at: at }]],
        ['eq', ['id', 'inv-1']],
        ['is', ['redeemed_at', null]],
      ],
      [
        ['update', [{ activated_at: at }]],
        ['eq', ['auth_user_id', 'auth-1']],
        ['is', ['activated_at', null]],
      ],
    ]);
  });

  it.each([
    [
      'findByTokenHash',
      (r: SupabaseInvitesRepository) => r.findByTokenHash('h'),
    ],
    [
      'findLatestByEmail',
      (r: SupabaseInvitesRepository) => r.findLatestByEmail('e'),
    ],
    ['listUnsent', (r: SupabaseInvitesRepository) => r.listUnsent('s')],
    [
      'listDueForReminder',
      (r: SupabaseInvitesRepository) => r.listDueForReminder('s', NOW),
    ],
    ['markSent', (r: SupabaseInvitesRepository) => r.markSent('i', NOW)],
    [
      'markRedeemed',
      (r: SupabaseInvitesRepository) => r.markRedeemed('i', NOW),
    ],
    [
      'markActivated',
      (r: SupabaseInvitesRepository) => r.markActivated('a', NOW),
    ],
  ])('%s surfaces database errors', async (_name, call) => {
    const { repo } = setup(ERR);
    await expect(call(repo)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
