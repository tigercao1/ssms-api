import { InternalServerErrorException } from '@nestjs/common';
import { SupabaseInstructorsRepository } from './instructors.repository';

interface DbResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

/** Minimal chainable + thenable Supabase query-builder fake. */
class QueryBuilder implements PromiseLike<DbResult> {
  constructor(private readonly result: DbResult) {}
  select(): this {
    return this;
  }
  eq(): this {
    return this;
  }
  insert(): this {
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
  from(): QueryBuilder {
    return new QueryBuilder(this.next);
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

describe('SupabaseInstructorsRepository', () => {
  it('findByAuthUserId returns the row', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: { id: 'inst-1' }, error: null };
    await expect(repo.findByAuthUserId('auth-1')).resolves.toEqual({
      id: 'inst-1',
    });
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
    await expect(repo.insertPending('auth-3', 'a@b.com')).resolves.toEqual({
      id: 'inst-3',
    });
  });

  it('insertPending returns null on unique-violation (race)', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: null, error: { code: '23505', message: 'dup' } };
    await expect(repo.insertPending('auth-3', 'a@b.com')).resolves.toBeNull();
  });

  it('insertPending throws on other errors', async () => {
    const { repo, fake } = makeRepo();
    fake.next = { data: null, error: { code: '23502', message: 'notnull' } };
    await expect(
      repo.insertPending('auth-3', 'a@b.com'),
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
});
