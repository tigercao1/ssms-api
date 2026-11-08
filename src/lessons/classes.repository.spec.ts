import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import { DatabaseError } from '../database/db-result';
import {
  CLASS_COLUMNS,
  CLASS_SEARCH_EMBED,
  classIdRange,
  MAX_CLASSES_PER_LIST,
  SupabaseClassesRepository,
} from './classes.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';
const LESSON_TYPE_ID = '8b9c0d1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e';
const LOCATION_ID = '6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c';
const SEARCH_COLUMNS = `${CLASS_COLUMNS}, ${CLASS_SEARCH_EMBED}`;

describe('SupabaseClassesRepository', () => {
  it('selects classes with instructor, location, lesson type and participants', async () => {
    const { client, queries } = recordingSupabase({
      classes: { data: [{ id: ID }], error: null, count: 1 },
    });
    const repo = new SupabaseClassesRepository(client);
    await expect(repo.list({})).resolves.toEqual({
      rows: [{ id: ID }],
      total: 1,
    });
    expect(queries[0].ops).toEqual([
      ['select', CLASS_COLUMNS, { count: 'exact' }],
      ['order', 'starts_at', { ascending: true }],
      ['order', 'id', { ascending: true }],
      ['limit', MAX_CLASSES_PER_LIST],
    ]);
    expect(CLASS_COLUMNS).toContain('participants:class_participants(');
    expect(CLASS_COLUMNS).toContain('lesson_type:lesson_types(');
    expect(CLASS_COLUMNS).not.toMatch(/product|purchase|wechat/);
  });

  it('reports the true match count when the unpaged cap truncates', async () => {
    const rows = Array.from({ length: MAX_CLASSES_PER_LIST }, (_, i) => ({
      id: `c${i}`,
    }));
    const { client } = recordingSupabase({
      classes: { data: rows, error: null, count: 1500 },
    });
    await expect(
      new SupabaseClassesRepository(client).list({}),
    ).resolves.toEqual({ rows, total: 1500 });
  });

  it('applies every filter it is given', async () => {
    const { client, queries } = recordingSupabase();
    const repo = new SupabaseClassesRepository(client);
    await expect(
      repo.list({ from: '2026-12-01', to: '2026-12-31', instructorId: ID }),
    ).resolves.toEqual({ rows: [], total: 0 });
    expect(queries[0].ops).toEqual(
      expect.arrayContaining([
        ['gte', 'starts_at', '2026-12-01'],
        ['lt', 'starts_at', '2026-12-31'],
        ['eq', 'instructor_id', ID],
      ]),
    );
  });

  it('pages filtered matches with a range and an exact count', async () => {
    const { client, queries } = recordingSupabase({
      classes: { data: [{ id: ID }], error: null, count: 51 },
    });
    await expect(
      new SupabaseClassesRepository(client).list(
        { from: '2026-12-01', to: '2026-12-31', instructorId: ID },
        { limit: 50, offset: 50 },
      ),
    ).resolves.toEqual({ rows: [{ id: ID }], total: 51 });
    expect(queries[0].ops).toEqual([
      ['select', CLASS_COLUMNS, { count: 'exact' }],
      ['gte', 'starts_at', '2026-12-01'],
      ['lt', 'starts_at', '2026-12-31'],
      ['eq', 'instructor_id', ID],
      ['order', 'starts_at', { ascending: true }],
      ['order', 'id', { ascending: true }],
      ['range', 50, 99],
    ]);
  });

  it('answers a page past the end with no rows and the real filtered total', async () => {
    const { client, queries } = recordingSupabase({
      classes: [
        {
          data: null,
          error: {
            message: 'Requested range not satisfiable',
            code: 'PGRST103',
          },
        },
        { data: null, error: null, count: 7 },
      ],
    });
    await expect(
      new SupabaseClassesRepository(client).list(
        { from: '2026-12-01', instructorId: ID },
        { limit: 50, offset: 500 },
      ),
    ).resolves.toEqual({ rows: [], total: 7 });
    expect(queries[1].ops).toEqual([
      ['select', 'id', { count: 'exact', head: true }],
      ['gte', 'starts_at', '2026-12-01'],
      ['eq', 'instructor_id', ID],
    ]);
  });

  it('surfaces a failed past-the-end count', async () => {
    const { client } = recordingSupabase({
      classes: [
        { data: null, error: { message: 'range', code: 'PGRST103' } },
        { data: null, error: { message: 'boom' } },
      ],
    });
    const failure = new SupabaseClassesRepository(client).list(
      {},
      { limit: 50, offset: 500 },
    );
    await expect(failure).rejects.toBeInstanceOf(DatabaseError);
    await expect(failure).rejects.toThrow('Failed to count classes: boom');
  });

  it('surfaces database errors', async () => {
    const { client } = recordingSupabase({
      classes: { data: null, error: { message: 'boom' } },
    });
    await expect(
      new SupabaseClassesRepository(client).list({}),
    ).rejects.toThrow('Failed to list classes: boom');
  });

  it('narrows by status, lesson type, location and created-at window', async () => {
    const { client, queries } = recordingSupabase();
    await new SupabaseClassesRepository(client).list({
      statuses: ['scheduled', 'no_show'],
      lessonTypeId: LESSON_TYPE_ID,
      locationId: LOCATION_ID,
      createdFrom: '2026-11-01T00:00:00Z',
      createdTo: '2026-11-08T00:00:00Z',
    });
    expect(queries[0].ops).toEqual([
      ['select', CLASS_COLUMNS, { count: 'exact' }],
      ['in', 'status', ['scheduled', 'no_show']],
      ['eq', 'lesson_type_id', LESSON_TYPE_ID],
      ['eq', 'location_id', LOCATION_ID],
      ['gte', 'created_at', '2026-11-01T00:00:00Z'],
      ['lt', 'created_at', '2026-11-08T00:00:00Z'],
      ['order', 'starts_at', { ascending: true }],
      ['order', 'id', { ascending: true }],
      ['limit', MAX_CLASSES_PER_LIST],
    ]);
  });

  it('orders newest booked first for the created-at sort', async () => {
    const { client, queries } = recordingSupabase();
    await new SupabaseClassesRepository(client).list(
      {},
      { limit: 20, offset: 0 },
      'createdAt',
    );
    expect(queries[0].ops).toEqual([
      ['select', CLASS_COLUMNS, { count: 'exact' }],
      ['order', 'created_at', { ascending: false }],
      ['order', 'id', { ascending: false }],
      ['range', 0, 19],
    ]);
  });

  it('searches every token against one participant customer', async () => {
    const { client, queries } = recordingSupabase();
    await new SupabaseClassesRepository(client).list({
      q: 'Lily  CHEN',
      statuses: ['scheduled'],
    });
    expect(queries[0].ops).toEqual([
      ['select', SEARCH_COLUMNS, { count: 'exact' }],
      ['in', 'status', ['scheduled']],
      ['ilike', 'search.customer.search_text', '%lily%'],
      ['ilike', 'search.customer.search_text', '%chen%'],
      ['or', 'search.not.is.null'],
      ['order', 'starts_at', { ascending: true }],
      ['order', 'id', { ascending: true }],
      ['limit', MAX_CLASSES_PER_LIST],
    ]);
    expect(CLASS_SEARCH_EMBED).toBe(
      'search:class_participants(customer:customers!inner())',
    );
  });

  it('also matches a class id prefix', async () => {
    const { client, queries } = recordingSupabase();
    await new SupabaseClassesRepository(client).list({ q: '3F1C2b7a-9d' });
    expect(queries[0].ops).toContainEqual([
      'or',
      'search.not.is.null,and(id.gte.3f1c2b7a-9d00-0000-0000-000000000000,id.lte.3f1c2b7a-9dff-ffff-ffff-ffffffffffff)',
    ]);
    expect(queries[0].ops).toContainEqual([
      'ilike',
      'search.customer.search_text',
      '%3f1c2b7a-9d%',
    ]);
  });

  it('escapes like wildcards in search tokens', async () => {
    const { client, queries } = recordingSupabase();
    await new SupabaseClassesRepository(client).list({ q: '50%_off*' });
    expect(queries[0].ops).toContainEqual([
      'ilike',
      'search.customer.search_text',
      '%50\\%\\_off%',
    ]);
  });

  it('ignores a search made only of wildcards', async () => {
    const { client, queries } = recordingSupabase();
    await new SupabaseClassesRepository(client).list({ q: '**' });
    expect(queries[0].ops[0]).toEqual([
      'select',
      CLASS_COLUMNS,
      { count: 'exact' },
    ]);
    expect(queries[0].ops.map(([op]) => op)).not.toContain('or');
  });

  it('counts a searched page past the end with the same search', async () => {
    const { client, queries } = recordingSupabase({
      classes: [
        { data: null, error: { message: 'range', code: 'PGRST103' } },
        { data: null, error: null, count: 3 },
      ],
    });
    await expect(
      new SupabaseClassesRepository(client).list(
        { q: 'lily' },
        { limit: 50, offset: 500 },
      ),
    ).resolves.toEqual({ rows: [], total: 3 });
    expect(queries[1].ops).toEqual([
      ['select', `id, ${CLASS_SEARCH_EMBED}`, { count: 'exact', head: true }],
      ['ilike', 'search.customer.search_text', '%lily%'],
      ['or', 'search.not.is.null'],
    ]);
  });
});

describe('classIdRange', () => {
  it.each([
    [
      '3f1c',
      '3f1c0000-0000-0000-0000-000000000000',
      '3f1cffff-ffff-ffff-ffff-ffffffffffff',
    ],
    [ID.toUpperCase(), ID, ID],
  ])('spans every id starting with %s', (q, lowest, highest) => {
    expect(classIdRange(q)).toEqual({ lowest, highest });
  });

  it.each(['3f1', 'lily', '3f1c 2b7a', `${ID}0`, ''])(
    'is not an id prefix: %s',
    (q) => {
      expect(classIdRange(q)).toBeNull();
    },
  );
});
