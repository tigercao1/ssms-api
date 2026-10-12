import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import { DatabaseError } from '../database/db-result';
import { SupabaseInstructorCalendarsRepository } from './instructor-calendars.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';
const row = {
  instructor_id: ID,
  google_calendar_id: 'eddie@example.com',
  calendar_summary: 'Eddie',
  match_status: 'confirmed',
  updated_at: '2026-10-10T00:00:00Z',
};
const input = {
  google_calendar_id: 'eddie@example.com',
  calendar_summary: 'Eddie',
  match_status: 'suggested' as const,
};
const fail = { data: null, error: { message: 'boom' } };

describe('SupabaseInstructorCalendarsRepository', () => {
  it('reads instructor existence, the instructor list and stored calendars', async () => {
    const { client, queries } = recordingSupabase({
      instructors: [
        { data: { id: ID }, error: null },
        { data: [{ id: ID }], error: null },
      ],
      instructor_calendars: [
        { data: row, error: null },
        { data: null, error: null },
        { data: [row], error: null },
      ],
    });
    const repo = new SupabaseInstructorCalendarsRepository(client);
    await expect(repo.instructorExists(ID)).resolves.toBe(true);
    await expect(repo.listInstructors()).resolves.toEqual([{ id: ID }]);
    await expect(repo.find(ID)).resolves.toEqual(row);
    await expect(repo.find(ID)).resolves.toBeNull();
    await expect(repo.list()).resolves.toEqual([row]);
    expect(queries[1].ops[0][1]).toContain('display_name_zh');
  });

  it('upserts on instructor_id and records who changed it', async () => {
    const { client, queries } = recordingSupabase({
      instructor_calendars: { data: row, error: null },
    });
    const repo = new SupabaseInstructorCalendarsRepository(client);
    await expect(repo.upsert(ID, input, 'admin-1')).resolves.toEqual(row);
    expect(queries[0].ops[0]).toEqual([
      'upsert',
      { instructor_id: ID, ...input, updated_by: 'admin-1' },
      { onConflict: 'instructor_id' },
    ]);
  });

  it('fails when the upsert returns no row', async () => {
    const { client } = recordingSupabase();
    const repo = new SupabaseInstructorCalendarsRepository(client);
    await expect(repo.upsert(ID, input, null)).rejects.toThrow(
      'no row returned',
    );
  });

  it('inserts a suggestion only when the instructor has no row yet', async () => {
    const { client, queries } = recordingSupabase({
      instructor_calendars: [
        { data: [{ instructor_id: ID }], error: null },
        { data: [], error: null },
        { data: null, error: { message: 'dup', code: '23505' } },
      ],
    });
    const repo = new SupabaseInstructorCalendarsRepository(client);
    await expect(repo.insertIfAbsent(ID, input, null)).resolves.toBe(true);
    await expect(repo.insertIfAbsent(ID, input, null)).resolves.toBe(false);
    await expect(repo.insertIfAbsent(ID, input, null)).resolves.toBe(false);
    expect(queries[0].ops[0][2]).toEqual({
      onConflict: 'instructor_id',
      ignoreDuplicates: true,
    });
  });

  it('deletes the row on remove', async () => {
    const { client, queries } = recordingSupabase();
    const repo = new SupabaseInstructorCalendarsRepository(client);
    await repo.remove(ID);
    expect(queries[0].ops).toEqual([['delete'], ['eq', 'instructor_id', ID]]);
  });

  it.each([
    [
      'instructorExists',
      (r: SupabaseInstructorCalendarsRepository) => r.instructorExists(ID),
    ],
    [
      'listInstructors',
      (r: SupabaseInstructorCalendarsRepository) => r.listInstructors(),
    ],
    ['list', (r: SupabaseInstructorCalendarsRepository) => r.list()],
    ['find', (r: SupabaseInstructorCalendarsRepository) => r.find(ID)],
    [
      'upsert',
      (r: SupabaseInstructorCalendarsRepository) => r.upsert(ID, input, null),
    ],
    [
      'insertIfAbsent',
      (r: SupabaseInstructorCalendarsRepository) =>
        r.insertIfAbsent(ID, input, null),
    ],
    ['remove', (r: SupabaseInstructorCalendarsRepository) => r.remove(ID)],
  ])('%s surfaces database errors', async (_name, call) => {
    const { client } = recordingSupabase({
      instructors: fail,
      instructor_calendars: fail,
    });
    await expect(
      call(new SupabaseInstructorCalendarsRepository(client)),
    ).rejects.toThrow(DatabaseError);
  });
});
