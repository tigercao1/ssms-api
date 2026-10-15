import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import { DatabaseError } from '../database/db-result';
import {
  CLASS_COLUMNS,
  MAX_CLASSES_PER_LIST,
  SupabaseClassesRepository,
} from './classes.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';

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
});
