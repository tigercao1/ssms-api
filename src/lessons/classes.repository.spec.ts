import { recordingSupabase } from '../../test/helpers/lessons-fakes';
import {
  CLASS_COLUMNS,
  MAX_CLASSES_PER_LIST,
  SupabaseClassesRepository,
} from './classes.repository';

const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';

describe('SupabaseClassesRepository', () => {
  it('selects classes with instructor, location, product and participants', async () => {
    const { client, queries } = recordingSupabase({
      classes: { data: [{ id: ID }], error: null },
    });
    const repo = new SupabaseClassesRepository(client);
    await expect(repo.list({})).resolves.toEqual([{ id: ID }]);
    expect(queries[0].ops).toEqual([
      ['select', CLASS_COLUMNS],
      ['order', 'starts_at', { ascending: true }],
      ['order', 'id', { ascending: true }],
      ['limit', MAX_CLASSES_PER_LIST],
    ]);
    expect(CLASS_COLUMNS).toContain('participants:class_participants(');
  });

  it('applies every filter it is given', async () => {
    const { client, queries } = recordingSupabase();
    const repo = new SupabaseClassesRepository(client);
    await expect(
      repo.list({ from: '2026-12-01', to: '2026-12-31', instructorId: ID }),
    ).resolves.toEqual([]);
    expect(queries[0].ops).toEqual(
      expect.arrayContaining([
        ['gte', 'starts_at', '2026-12-01'],
        ['lt', 'starts_at', '2026-12-31'],
        ['eq', 'instructor_id', ID],
      ]),
    );
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
