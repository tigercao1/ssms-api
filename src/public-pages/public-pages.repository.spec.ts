import {
  DuplicateSlugError,
  PUBLIC_PAGE_COLUMNS,
  SupabasePublicPagesRepository,
} from './public-pages.repository';
import type { PublicPageRow } from './public-pages.types';

interface Result {
  data: unknown;
  error: { message: string; code?: string } | null;
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
        'order',
        'insert',
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
    repo: new SupabasePublicPagesRepository(client as never),
    queries,
  };
}

const row: PublicPageRow = {
  id: '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a',
  slug: 'faq',
  title: 'FAQ',
  status: 'draft',
  draft_sha256: null,
  draft_size_bytes: null,
  published_sha256: null,
  published_at: null,
  created_by: 'admin-1',
  updated_by: 'admin-1',
  created_at: '2026-10-10T04:00:00.000Z',
  updated_at: '2026-10-10T04:00:00.000Z',
};
const failure: Result = { data: null, error: { message: 'boom' } };

describe('SupabasePublicPagesRepository', () => {
  it('lists newest updated_at first', async () => {
    const { repo, queries } = fakeSupabase({ data: [row], error: null });
    await expect(repo.list()).resolves.toEqual([row]);
    expect(queries[0]).toEqual({
      table: 'public_pages',
      ops: [
        ['select', PUBLIC_PAGE_COLUMNS],
        ['order', 'updated_at', { ascending: false }],
        ['order', 'id', { ascending: true }],
      ],
    });
  });

  it('lists nothing when there are no rows', async () => {
    const { repo } = fakeSupabase();
    await expect(repo.list()).resolves.toEqual([]);
  });

  it('finds a page by id', async () => {
    const { repo, queries } = fakeSupabase({ data: row, error: null });
    await expect(repo.findById(row.id)).resolves.toEqual(row);
    expect(queries[0].ops).toEqual([
      ['select', PUBLIC_PAGE_COLUMNS],
      ['eq', 'id', row.id],
      ['maybeSingle'],
    ]);
  });

  it('returns null for a missing page', async () => {
    const { repo } = fakeSupabase();
    await expect(repo.findById(row.id)).resolves.toBeNull();
  });

  it('creates a page with its author', async () => {
    const { repo, queries } = fakeSupabase({ data: row, error: null });
    await expect(
      repo.create({ slug: 'faq', title: 'FAQ', userId: 'admin-1' }),
    ).resolves.toEqual(row);
    expect(queries[0].ops).toEqual([
      [
        'insert',
        {
          slug: 'faq',
          title: 'FAQ',
          created_by: 'admin-1',
          updated_by: 'admin-1',
        },
      ],
      ['select', PUBLIC_PAGE_COLUMNS],
      ['single'],
    ]);
  });

  it('maps a unique violation to DuplicateSlugError', async () => {
    const { repo } = fakeSupabase({
      data: null,
      error: { message: 'duplicate key', code: '23505' },
    });
    await expect(
      repo.create({ slug: 'faq', title: 'FAQ', userId: null }),
    ).rejects.toBeInstanceOf(DuplicateSlugError);
  });

  it('fails create when no row comes back', async () => {
    const { repo } = fakeSupabase();
    await expect(
      repo.create({ slug: 'faq', title: 'FAQ', userId: null }),
    ).rejects.toThrow('no row returned');
  });

  it('updates a page and stamps updated_by', async () => {
    const { repo, queries } = fakeSupabase({ data: row, error: null });
    await expect(
      repo.update(row.id, { title: 'Questions' }, 'admin-2'),
    ).resolves.toEqual(row);
    expect(queries[0].ops).toEqual([
      ['update', { title: 'Questions', updated_by: 'admin-2' }],
      ['eq', 'id', row.id],
      ['select', PUBLIC_PAGE_COLUMNS],
      ['maybeSingle'],
    ]);
  });

  it('returns null when updating a missing page', async () => {
    const { repo } = fakeSupabase();
    await expect(repo.update(row.id, { title: 'x' }, null)).resolves.toBeNull();
  });

  it('deletes a page by id', async () => {
    const { repo, queries } = fakeSupabase();
    await repo.delete(row.id);
    expect(queries[0].ops).toEqual([['delete'], ['eq', 'id', row.id]]);
  });

  it.each([
    ['list', (r: SupabasePublicPagesRepository) => r.list()],
    ['findById', (r: SupabasePublicPagesRepository) => r.findById(row.id)],
    [
      'create',
      (r: SupabasePublicPagesRepository) =>
        r.create({ slug: 'faq', title: 'FAQ', userId: null }),
    ],
    [
      'update',
      (r: SupabasePublicPagesRepository) => r.update(row.id, {}, null),
    ],
    ['delete', (r: SupabasePublicPagesRepository) => r.delete(row.id)],
  ])('%s surfaces database errors', async (_name, call) => {
    const { repo } = fakeSupabase(failure);
    await expect(call(repo)).rejects.toThrow('boom');
  });
});
