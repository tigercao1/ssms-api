import { InternalServerErrorException } from '@nestjs/common';
import { SupabaseInstructorsRepository } from './instructors.repository';

interface DbResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

/** Minimal chainable + thenable Supabase query-builder fake. */
class QueryBuilder implements PromiseLike<DbResult> {
  updates: unknown[] = [];
  inserts: unknown[] = [];
  filters: Array<[string, unknown]> = [];
  constructor(
    private readonly result: DbResult,
    readonly table: string,
  ) {}
  select(): this {
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }
  update(values: unknown): this {
    this.updates.push(values);
    return this;
  }
  insert(values: unknown): this {
    this.inserts.push(values);
    return this;
  }
  in(column: string, values: unknown): this {
    this.filters.push([column, values]);
    return this;
  }
  maybeSingle(): Promise<DbResult> {
    return Promise.resolve(this.result);
  }
  single(): Promise<DbResult> {
    return Promise.resolve(this.result);
  }
  then<TResult1 = DbResult, TResult2 = never>(
    onfulfilled?:
      | ((value: DbResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

class FakeSupabase {
  next: DbResult = { data: null, error: null };
  rpcResult: { error: unknown } = { error: null };
  rpcCalls: Array<{ name: string; params: unknown }> = [];
  builders: QueryBuilder[] = [];
  userPages: Array<{ data: { users: unknown[] }; error: unknown }> = [];
  listUsersCalls: unknown[] = [];
  auth = {
    admin: {
      listUsers: (params: unknown) => {
        this.listUsersCalls.push(params);
        return Promise.resolve(
          this.userPages.shift() ?? { data: { users: [] }, error: null },
        );
      },
    },
  };
  from(table: string): QueryBuilder {
    const builder = new QueryBuilder(this.next, table);
    this.builders.push(builder);
    return builder;
  }
  rpc(name: string, params: unknown) {
    this.rpcCalls.push({ name, params });
    return Promise.resolve(this.rpcResult);
  }
}

function makeRepo() {
  const fake = new FakeSupabase();
  const repo = new SupabaseInstructorsRepository(fake as never);
  return { repo, fake };
}

const NO_NAMES = { firstName: null, lastName: null, displayNameEn: null };

describe('SupabaseInstructorsRepository', () => {
  it('findByAuthUserId returns the row', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: { id: 'inst-1' }, error: null };
    await expect(repo.findByAuthUserId('auth-1')).resolves.toEqual({
      id: 'inst-1',
    });
  });

  it('findByAuthUserId selects min_student_age', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: { id: 'inst-1' }, error: null };
    const select = jest.spyOn(QueryBuilder.prototype, 'select');
    await repo.findByAuthUserId('auth-1');
    expect(select).toHaveBeenCalledWith(
      expect.stringContaining('min_student_age'),
    );
    select.mockRestore();
  });

  it('findByAuthUserId returns null when absent', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: null, error: null };
    await expect(repo.findByAuthUserId('auth-1')).resolves.toBeNull();
  });

  it('findByAuthUserId throws on a DB error', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: null, error: { message: 'boom' } };
    await expect(repo.findByAuthUserId('auth-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('findById returns the row', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: { id: 'inst-2' }, error: null };
    await expect(repo.findById('inst-2')).resolves.toEqual({ id: 'inst-2' });
  });

  it('findById throws on a DB error', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: null, error: { message: 'x' } };
    await expect(repo.findById('inst-2')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('insertPending returns the created row', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: { id: 'inst-3' }, error: null };
    await expect(
      repo.insertPending('auth-3', 'a@b.com', NO_NAMES),
    ).resolves.toEqual({ id: 'inst-3' });
  });

  it('insertPending stores the sign-up names and display name', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: { id: 'inst-3' }, error: null };
    await repo.insertPending('auth-3', 'a@b.com', {
      firstName: 'Jane',
      lastName: 'Doe',
      displayNameEn: 'JJ',
    });
    expect(fake.builders[0].inserts).toEqual([
      {
        auth_user_id: 'auth-3',
        email: 'a@b.com',
        first_name: 'Jane',
        last_name: 'Doe',
        display_name_en: 'JJ',
      },
    ]);
  });

  it('insertPending leaves the display name to its default when absent', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: { id: 'inst-3' }, error: null };
    await repo.insertPending('auth-3', 'a@b.com', NO_NAMES);
    expect(fake.builders[0].inserts).toEqual([
      {
        auth_user_id: 'auth-3',
        email: 'a@b.com',
        first_name: null,
        last_name: null,
      },
    ]);
  });

  it('insertPending returns null on unique-violation (race)', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: null, error: { code: '23505', message: 'dup' } };
    await expect(
      repo.insertPending('auth-3', 'a@b.com', NO_NAMES),
    ).resolves.toBeNull();
  });

  it('insertPending throws on other errors', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: null, error: { code: '23502', message: 'notnull' } };
    await expect(
      repo.insertPending('auth-3', 'a@b.com', NO_NAMES),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('getTeachingLocations maps + sorts by sort_order', async () => {
    const { repo, fake } = makeRepo();
    fake.next = {
      data: [
        {
          teaching_locations: {
            id: 'b',
            key: 'blue',
            name: 'Blue',
            sort_order: 2,
          },
        },
        {
          teaching_locations: {
            id: 'a',
            key: 'glen',
            name: 'Glen',
            sort_order: 1,
          },
        },
        { teaching_locations: null },
      ],
      error: null,
    };
    await expect(repo.getTeachingLocations('inst-1')).resolves.toEqual([
      { id: 'a', key: 'glen', name: 'Glen' },
      { id: 'b', key: 'blue', name: 'Blue' },
    ]);
  });

  it('getLanguages throws on a DB error', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: null, error: { message: 'x' } };
    await expect(repo.getLanguages('inst-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('getCourseLevels returns rows', async () => {
    const { repo, fake } = makeRepo();
    fake.next = {
      data: [
        {
          course_levels_offered: {
            id: 'c',
            key: 'beg',
            name: 'Beginner',
            sort_order: 1,
          },
        },
      ],
      error: null,
    };
    await expect(repo.getCourseLevels('inst-1')).resolves.toEqual([
      { id: 'c', key: 'beg', name: 'Beginner' },
    ]);
  });

  it('getCertifications returns rows', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: [{ org: 'csia' }], error: null };
    await expect(repo.getCertifications('inst-1')).resolves.toEqual([
      { org: 'csia' },
    ]);
  });

  it('getCertifications throws on a DB error', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: null, error: { message: 'x' } };
    await expect(repo.getCertifications('inst-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('getTrainerStatus returns rows', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: [{ discipline: 'ski' }], error: null };
    await expect(repo.getTrainerStatus('inst-1')).resolves.toEqual([
      { discipline: 'ski' },
    ]);
  });

  it('getTrainerStatus throws on a DB error', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: null, error: { message: 'x' } };
    await expect(repo.getTrainerStatus('inst-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('applyProfilePatch calls the RPC with the patch', async () => {
    const { repo, fake } = makeRepo();
    await repo.applyProfilePatch('inst-1', { bio_en: 'hi' });
    expect(fake.rpcCalls).toEqual([
      {
        name: 'update_instructor_profile',
        params: { p_instructor_id: 'inst-1', p_patch: { bio_en: 'hi' } },
      },
    ]);
  });

  it('applyProfilePatch rethrows the RPC error', async () => {
    const { repo, fake } = makeRepo();
    fake.rpcResult = { error: { code: '23514', message: 'check' } };
    await expect(repo.applyProfilePatch('inst-1', {})).rejects.toEqual({
      code: '23514',
      message: 'check',
    });
  });

  it('bumpProfilePhotoVersion calls the RPC for the instructor', async () => {
    const { repo, fake } = makeRepo();
    await repo.bumpProfilePhotoVersion('inst-1');
    expect(fake.rpcCalls).toEqual([
      {
        name: 'bump_profile_photo_version',
        params: { p_instructor_id: 'inst-1' },
      },
    ]);
  });

  it('bumpProfilePhotoVersion throws on an RPC error', async () => {
    const { repo, fake } = makeRepo();
    fake.rpcResult = { error: { message: 'boom' } };
    await expect(repo.bumpProfilePhotoVersion('inst-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it.each([2, 3] as const)(
    'setAdditionalPhoto writes slot %i url and a fresh version',
    async (slot) => {
      const { repo, fake } = makeRepo();
      const before = Date.now();
      await repo.setAdditionalPhoto('inst-1', slot, 'https://cdn.test/p.jpg');
      const [builder] = fake.builders;
      expect(builder.table).toBe('instructors');
      expect(builder.filters).toEqual([['id', 'inst-1']]);
      const [values] = builder.updates as Record<string, string>[];
      expect(values[`photo_${slot}_url`]).toBe('https://cdn.test/p.jpg');
      expect(
        Date.parse(values[`photo_${slot}_version`]),
      ).toBeGreaterThanOrEqual(before);
      expect(Object.keys(values)).toHaveLength(2);
    },
  );

  it('setAdditionalPhoto clears the url', async () => {
    const { repo, fake } = makeRepo();
    await repo.setAdditionalPhoto('inst-1', 2, null);
    expect(fake.builders[0].updates[0]).toMatchObject({ photo_2_url: null });
  });

  it('setAdditionalPhoto throws on a DB error', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: null, error: { message: 'boom' } };
    await expect(
      repo.setAdditionalPhoto('inst-1', 3, null),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('hasCalendar is true when the instructor has a calendar row', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: { instructor_id: 'inst-1' }, error: null };
    await expect(repo.hasCalendar('inst-1')).resolves.toBe(true);
    expect(fake.builders[0].table).toBe('instructor_calendars');
    expect(fake.builders[0].filters).toEqual([['instructor_id', 'inst-1']]);
  });

  it('hasCalendar is false without a calendar row', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: null, error: null };
    await expect(repo.hasCalendar('inst-1')).resolves.toBe(false);
  });

  it('hasCalendar throws on a DB error', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: null, error: { message: 'boom' } };
    await expect(repo.hasCalendar('inst-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  describe('listAdminRecipients', () => {
    const user = (id: string, role: string | undefined, email?: string) => ({
      id,
      email,
      app_metadata: role ? { role } : {},
    });

    it('pages through auth users, keeps admins with an email and attaches instructor languages', async () => {
      const { repo, fake } = makeRepo();
      const fullPage = Array.from({ length: 1000 }, (_, i) =>
        user(`u-${i}`, 'instructor', `u${i}@x.com`),
      );
      fullPage[0] = user('admin-1', 'admin', 'boss@x.com');
      fake.userPages = [
        { data: { users: fullPage }, error: null },
        {
          data: {
            users: [
              user('admin-2', 'admin', 'ops@x.com'),
              user('admin-3', 'admin'),
              user('u-x', undefined, 'plain@x.com'),
            ],
          },
          error: null,
        },
      ];
      fake.next = {
        data: [{ auth_user_id: 'admin-1', preferred_language: 'zh-CN' }],
        error: null,
      };

      await expect(repo.listAdminRecipients()).resolves.toEqual([
        {
          authUserId: 'admin-1',
          email: 'boss@x.com',
          preferredLanguage: 'zh-CN',
        },
        { authUserId: 'admin-2', email: 'ops@x.com', preferredLanguage: null },
      ]);
      expect(fake.listUsersCalls).toEqual([
        { page: 1, perPage: 1000 },
        { page: 2, perPage: 1000 },
      ]);
      expect(fake.builders[0].table).toBe('instructors');
      expect(fake.builders[0].filters).toEqual([
        ['auth_user_id', ['admin-1', 'admin-2']],
      ]);
    });

    it('returns [] without querying instructors when there are no admins', async () => {
      const { repo, fake } = makeRepo();
      fake.userPages = [
        { data: { users: [user('u', 'instructor', 'a@b.c')] }, error: null },
      ];
      await expect(repo.listAdminRecipients()).resolves.toEqual([]);
      expect(fake.builders).toHaveLength(0);
    });

    it('throws when the auth admin API fails', async () => {
      const { repo, fake } = makeRepo();
      fake.userPages = [{ data: { users: [] }, error: { message: 'nope' } }];
      await expect(repo.listAdminRecipients()).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('throws when the instructor language lookup fails', async () => {
      const { repo, fake } = makeRepo();
      fake.userPages = [
        { data: { users: [user('admin-1', 'admin', 'a@b.c')] }, error: null },
      ];
      fake.next = { data: null, error: { message: 'db down' } };
      await expect(repo.listAdminRecipients()).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('treats a null instructor result as no languages', async () => {
      const { repo, fake } = makeRepo();
      fake.userPages = [
        { data: { users: [user('admin-1', 'admin', 'a@b.c')] }, error: null },
      ];
      fake.next = { data: null, error: null };
      await expect(repo.listAdminRecipients()).resolves.toEqual([
        { authUserId: 'admin-1', email: 'a@b.c', preferredLanguage: null },
      ]);
    });
  });
});
