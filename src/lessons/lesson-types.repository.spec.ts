import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import { DatabaseError, PG_UNIQUE_VIOLATION } from '../database/db-result';
import {
  LESSON_TYPE_COLUMNS,
  SupabaseLessonTypesRepository,
} from './lesson-types.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';
const row = { id: ID, name_en: 'Private 2h' };
const fail = { data: null, error: { message: 'boom' } };

describe('SupabaseLessonTypesRepository', () => {
  it('lists in sort order, optionally only active ones', async () => {
    const { client, queries } = recordingSupabase({
      lesson_types: [
        { data: [row], error: null },
        { data: null, error: null },
      ],
    });
    const repo = new SupabaseLessonTypesRepository(client);
    await expect(repo.list({})).resolves.toEqual([row]);
    await expect(repo.list({ active: true })).resolves.toEqual([]);
    expect(queries[0].ops).toEqual([
      ['select', LESSON_TYPE_COLUMNS],
      ['order', 'sort_order', { ascending: true }],
      ['order', 'name_en', { ascending: true }],
    ]);
    expect(queries[1].ops).toContainEqual(['eq', 'active', true]);
  });

  it('finds, inserts and updates by id', async () => {
    const { client, queries } = recordingSupabase({
      lesson_types: [
        { data: row, error: null },
        { data: row, error: null },
        { data: row, error: null },
        { data: null, error: null },
      ],
    });
    const repo = new SupabaseLessonTypesRepository(client);
    await expect(repo.findById(ID)).resolves.toEqual(row);
    await expect(
      repo.insert({ name_en: 'Private 2h', duration_min: 120 }),
    ).resolves.toEqual(row);
    await expect(repo.update(ID, { active: false })).resolves.toEqual(row);
    await expect(repo.update(ID, { active: false })).resolves.toBeNull();
    expect(queries[1].ops[0]).toEqual([
      'insert',
      { name_en: 'Private 2h', duration_min: 120 },
    ]);
    expect(queries[2].ops.slice(0, 2)).toEqual([
      ['update', { active: false }],
      ['eq', 'id', ID],
    ]);
  });

  it('fails when the insert returns no row', async () => {
    const { client } = recordingSupabase();
    await expect(
      new SupabaseLessonTypesRepository(client).insert({
        name_en: 'X',
        duration_min: 60,
      }),
    ).rejects.toThrow('no row returned');
  });

  it('keeps the Postgres error code', async () => {
    const { client } = recordingSupabase({
      lesson_types: {
        data: null,
        error: { message: 'dup', code: PG_UNIQUE_VIOLATION },
      },
    });
    await expect(
      new SupabaseLessonTypesRepository(client).insert({
        name_en: 'X',
        duration_min: 60,
      }),
    ).rejects.toMatchObject({ code: PG_UNIQUE_VIOLATION });
  });

  it.each([
    ['list', (r: SupabaseLessonTypesRepository) => r.list({})],
    ['findById', (r: SupabaseLessonTypesRepository) => r.findById(ID)],
    ['update', (r: SupabaseLessonTypesRepository) => r.update(ID, {})],
  ])('%s surfaces database errors', async (_name, call) => {
    const { client } = recordingSupabase({ lesson_types: fail });
    await expect(
      call(new SupabaseLessonTypesRepository(client)),
    ).rejects.toThrow(DatabaseError);
  });
});
