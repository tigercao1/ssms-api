import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import { SupabaseInstructorCalendarsRepository } from './instructor-calendars.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';
const row = {
  instructor_id: ID,
  google_calendar_id: 'eddie@example.com',
  updated_at: '2026-10-10T00:00:00Z',
};
const fail = { data: null, error: { message: 'boom' } };

describe('SupabaseInstructorCalendarsRepository', () => {
  it('reads instructor existence and the stored calendar', async () => {
    const { client } = recordingSupabase({
      instructors: { data: { id: ID }, error: null },
      instructor_calendars: [
        { data: row, error: null },
        { data: null, error: null },
      ],
    });
    const repo = new SupabaseInstructorCalendarsRepository(client);
    await expect(repo.instructorExists(ID)).resolves.toBe(true);
    await expect(repo.find(ID)).resolves.toEqual(row);
    await expect(repo.find(ID)).resolves.toBeNull();
  });

  it('upserts on instructor_id and records who changed it', async () => {
    const { client, queries } = recordingSupabase({
      instructor_calendars: { data: row, error: null },
    });
    const repo = new SupabaseInstructorCalendarsRepository(client);
    await expect(
      repo.upsert(ID, 'eddie@example.com', 'admin-1'),
    ).resolves.toEqual(row);
    expect(queries[0].ops[0]).toEqual([
      'upsert',
      {
        instructor_id: ID,
        google_calendar_id: 'eddie@example.com',
        updated_by: 'admin-1',
      },
      { onConflict: 'instructor_id' },
    ]);
  });

  it('fails when the upsert returns no row', async () => {
    const { client } = recordingSupabase();
    const repo = new SupabaseInstructorCalendarsRepository(client);
    await expect(repo.upsert(ID, 'x', null)).rejects.toThrow('no row returned');
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
    ['find', (r: SupabaseInstructorCalendarsRepository) => r.find(ID)],
    [
      'upsert',
      (r: SupabaseInstructorCalendarsRepository) => r.upsert(ID, 'x', null),
    ],
    ['remove', (r: SupabaseInstructorCalendarsRepository) => r.remove(ID)],
  ])('%s surfaces database errors', async (_name, call) => {
    const { client } = recordingSupabase({
      instructors: fail,
      instructor_calendars: fail,
    });
    await expect(
      call(new SupabaseInstructorCalendarsRepository(client)),
    ).rejects.toThrow('boom');
  });
});
