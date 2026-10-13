import { FakeSupabase } from '../supabase-fake.test-util';
import {
  IMPORT_SEASON_CLAIM,
  SupabaseRosterReader,
  SupabaseRosterWriter,
} from './roster-ports';

function users(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `u-${offset + i}`,
    email: `User${offset + i}@Example.test`,
    app_metadata: {},
  }));
}

describe('SupabaseRosterReader', () => {
  it('pages through auth users keyed by lowercased email', async () => {
    const db = new FakeSupabase();
    db.auth.admin.listUsers
      .mockResolvedValueOnce({ data: { users: users(1000) }, error: null })
      .mockResolvedValueOnce({
        data: {
          users: [
            {
              id: 'imp',
              email: 'Imported@Example.test',
              app_metadata: { [IMPORT_SEASON_CLAIM]: '2026/27' },
            },
            { id: 'phone-only', email: undefined, app_metadata: {} },
          ],
        },
        error: null,
      });
    const map = await new SupabaseRosterReader(
      db.asClient(),
    ).authUsersByEmail();
    expect(map.size).toBe(1001);
    expect(map.get('user0@example.test')).toEqual({
      id: 'u-0',
      importedSeason: null,
    });
    expect(map.get('imported@example.test')).toEqual({
      id: 'imp',
      importedSeason: '2026/27',
    });
    expect(db.auth.admin.listUsers.mock.calls).toEqual([
      [{ page: 1, perPage: 1000 }],
      [{ page: 2, perPage: 1000 }],
    ]);
  });

  it('surfaces listUsers errors', async () => {
    const db = new FakeSupabase();
    db.auth.admin.listUsers.mockResolvedValue({
      data: { users: [] },
      error: { message: 'nope' },
    });
    await expect(
      new SupabaseRosterReader(db.asClient()).authUsersByEmail(),
    ).rejects.toThrow('Failed to list auth users: nope');
  });

  it('looks teaching locations up by key with a select only', async () => {
    const db = new FakeSupabase();
    db.queue.push({
      data: [{ id: 'loc-1', key: 'teaching_location.moonstone' }],
      error: null,
    });
    const reader = new SupabaseRosterReader(db.asClient());
    expect(
      await reader.teachingLocationIds(['teaching_location.moonstone']),
    ).toEqual(new Map([['teaching_location.moonstone', 'loc-1']]));
    expect(db.queries[0]).toEqual({
      table: 'teaching_locations',
      ops: [
        ['select', ['id, key']],
        ['in', ['key', ['teaching_location.moonstone']]],
      ],
    });
    expect(await reader.teachingLocationIds([])).toEqual(new Map());
    expect(db.queries).toHaveLength(1);
  });

  it('handles empty and failing location lookups', async () => {
    const db = new FakeSupabase();
    db.queue.push(
      { data: null, error: null },
      { data: null, error: { message: 'down' } },
    );
    const reader = new SupabaseRosterReader(db.asClient());
    expect(await reader.teachingLocationIds(['x'])).toEqual(new Map());
    await expect(reader.teachingLocationIds(['x'])).rejects.toThrow(
      'Failed to load teaching locations: down',
    );
  });
});

describe('SupabaseRosterWriter', () => {
  it('creates a confirmed user tagged with the import season', async () => {
    const db = new FakeSupabase();
    db.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: 'new' } },
      error: null,
    });
    expect(
      await new SupabaseRosterWriter(db.asClient()).createUser(
        'a@example.test',
        '2026/27',
      ),
    ).toBe('new');
    expect(db.auth.admin.createUser).toHaveBeenCalledWith({
      email: 'a@example.test',
      email_confirm: true,
      app_metadata: { [IMPORT_SEASON_CLAIM]: '2026/27' },
    });
  });

  it('surfaces createUser errors', async () => {
    const db = new FakeSupabase();
    db.auth.admin.createUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'taken' },
    });
    await expect(
      new SupabaseRosterWriter(db.asClient()).createUser('a@example.test', 's'),
    ).rejects.toThrow('Failed to create auth user: taken');
    db.auth.admin.createUser.mockResolvedValue({
      data: { user: null },
      error: null,
    });
    await expect(
      new SupabaseRosterWriter(db.asClient()).createUser('a@example.test', 's'),
    ).rejects.toThrow('unknown error');
  });

  it('finds an instructor id by auth user', async () => {
    const db = new FakeSupabase();
    db.queue.push(
      { data: { id: 'ins' }, error: null },
      { data: null, error: null },
      { data: null, error: { message: 'x' } },
    );
    const writer = new SupabaseRosterWriter(db.asClient());
    expect(await writer.findInstructorId('auth')).toBe('ins');
    expect(await writer.findInstructorId('auth')).toBeNull();
    await expect(writer.findInstructorId('auth')).rejects.toThrow(
      'Failed to load instructor: x',
    );
    expect(db.ops(0)).toEqual([
      ['select', ['id']],
      ['eq', ['auth_user_id', 'auth']],
      ['maybeSingle', []],
    ]);
  });

  it('inserts a pending, active, zh-CN instructor', async () => {
    const db = new FakeSupabase();
    db.queue.push({ data: { id: 'ins' }, error: null });
    const id = await new SupabaseRosterWriter(db.asClient()).insertInstructor({
      authUserId: 'auth',
      email: 'a@example.test',
      displayNameEn: 'Avery',
      dateOfBirth: '1995-03-04',
    });
    expect(id).toBe('ins');
    expect(db.ops(0)[0]).toEqual([
      'insert',
      [
        {
          auth_user_id: 'auth',
          email: 'a@example.test',
          display_name_en: 'Avery',
          date_of_birth: '1995-03-04',
          preferred_language: 'zh-CN',
          approval_status: 'pending',
          is_active: true,
        },
      ],
    ]);
  });

  it('re-reads the instructor after a unique violation, else fails', async () => {
    const db = new FakeSupabase();
    db.queue.push(
      { data: null, error: { code: '23505', message: 'dup' } },
      { data: { id: 'ins-existing' }, error: null },
      { data: null, error: { code: '23505', message: 'dup' } },
      { data: null, error: null },
      { data: null, error: { message: 'check violation' } },
    );
    const writer = new SupabaseRosterWriter(db.asClient());
    const input = {
      authUserId: 'a',
      email: 'a@example.test',
      displayNameEn: '',
      dateOfBirth: null,
    };
    expect(await writer.insertInstructor(input)).toBe('ins-existing');
    await expect(writer.insertInstructor(input)).rejects.toThrow(
      'Failed to create instructor: dup',
    );
    await expect(writer.insertInstructor(input)).rejects.toThrow(
      'check violation',
    );
  });

  it('sets certifications and locations through update_instructor_profile', async () => {
    const db = new FakeSupabase();
    const writer = new SupabaseRosterWriter(db.asClient());
    await writer.setProfileRelations(
      'ins',
      [
        {
          org: 'casi',
          track: 'park',
          level: 2,
          isPartial: false,
          partialComponents: [],
        },
        {
          org: 'csia',
          track: 'regular',
          level: 3,
          isPartial: true,
          partialComponents: ['ski'],
        },
      ],
      ['loc-1'],
    );
    expect(db.rpcCalls).toEqual([
      {
        name: 'update_instructor_profile',
        params: {
          p_instructor_id: 'ins',
          p_patch: {
            certifications: [
              {
                org: 'casi',
                track: 'park',
                level: 2,
                is_partial: false,
                partial_components: [],
              },
              {
                org: 'csia',
                track: 'regular',
                level: 3,
                is_partial: true,
                partial_components: ['ski'],
              },
            ],
            teaching_location_ids: ['loc-1'],
          },
        },
      },
    ]);
    db.rpcResult = { data: null, error: { message: 'cert_park_level' } };
    await expect(writer.setProfileRelations('ins', [], [])).rejects.toThrow(
      'Failed to set certifications and locations: cert_park_level',
    );
  });

  it('reports whether an instructor has any certification or teaching location', async () => {
    const db = new FakeSupabase();
    db.queue.push(
      { data: null, count: 1, error: null },
      { data: null, count: 0, error: null },
      { data: null, count: 2, error: null },
      { data: null, count: null, error: null },
      { data: null, count: null, error: null },
      { data: null, error: { message: 'down' } },
    );
    const writer = new SupabaseRosterWriter(db.asClient());
    expect(await writer.hasProfileRelations('ins')).toBe(true);
    expect(await writer.hasProfileRelations('ins')).toBe(true);
    expect(await writer.hasProfileRelations('ins')).toBe(false);
    expect(db.queries.map((q) => q.table)).toEqual([
      'instructor_certifications',
      'instructor_certifications',
      'instructors_teaching_locations',
      'instructor_certifications',
      'instructors_teaching_locations',
    ]);
    expect(db.ops(0)).toEqual([
      ['select', ['instructor_id', { count: 'exact', head: true }]],
      ['eq', ['instructor_id', 'ins']],
    ]);
    await expect(writer.hasProfileRelations('ins')).rejects.toThrow(
      'Failed to load certifications and locations: down',
    );
  });

  it('inserts the invite idempotently on (instructor, season)', async () => {
    const db = new FakeSupabase();
    db.queue.push(
      { data: [{ id: 'inv-1' }], error: null },
      { data: [], error: null },
      { data: null, error: null },
      { data: null, error: { message: 'fk' } },
    );
    const writer = new SupabaseRosterWriter(db.asClient());
    const row = {
      instructor_id: 'i',
      auth_user_id: 'a',
      email: 'a@example.test',
      season: 's',
    };
    expect(await writer.insertInvite(row)).toBe(true);
    expect(await writer.insertInvite(row)).toBe(false);
    expect(await writer.insertInvite(row)).toBe(false);
    expect(db.queries[0]).toEqual({
      table: 'instructor_invites',
      ops: [
        [
          'upsert',
          [row, { onConflict: 'instructor_id,season', ignoreDuplicates: true }],
        ],
        ['select', ['id']],
      ],
    });
    await expect(writer.insertInvite(row)).rejects.toThrow(
      'Failed to create invite: fk',
    );
  });
});
