import { InternalServerErrorException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SUPABASE_CLIENT } from '../database/supabase-client.token';
import { AdminRepository, SupabaseAdminRepository } from './admin.repository';

/**
 * Chainable Supabase double: every builder method returns the builder and
 * records its args; the terminal call (`maybeSingle`/`single`) or awaiting the
 * builder resolves to the configured `{ data, error }`.
 */
function makeSupabaseStub(result: {
  data?: unknown;
  count?: number | null;
  error?: { message: string; code?: string } | null;
}) {
  const calls: {
    from?: string;
    select?: unknown[];
    eq: unknown[][];
    order: unknown[][];
    update?: unknown;
    insert?: unknown;
    delete?: boolean;
  } = { eq: [], order: [] };

  const resolved = {
    data: result.data ?? null,
    count: result.count ?? null,
    error: result.error ?? null,
  };

  const builder: Record<string, unknown> = {};
  builder.select = jest.fn((...a: unknown[]) => {
    calls.select = a;
    return builder;
  });
  builder.eq = jest.fn((...a: unknown[]) => {
    calls.eq.push(a);
    return builder;
  });
  builder.order = jest.fn((...a: unknown[]) => {
    calls.order.push(a);
    return builder;
  });
  builder.update = jest.fn((v: unknown) => {
    calls.update = v;
    return builder;
  });
  builder.insert = jest.fn((v: unknown) => {
    calls.insert = v;
    return builder;
  });
  builder.delete = jest.fn(() => {
    calls.delete = true;
    return builder;
  });
  builder.maybeSingle = jest.fn(() => Promise.resolve(resolved));
  builder.single = jest.fn(() => Promise.resolve(resolved));
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolved).then(resolve);

  const client = {
    from: jest.fn((table: string) => {
      calls.from = table;
      return builder;
    }),
  };
  return { client, calls };
}

async function build(stub: ReturnType<typeof makeSupabaseStub>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      { provide: AdminRepository, useClass: SupabaseAdminRepository },
      { provide: SUPABASE_CLIENT, useValue: stub.client },
    ],
  }).compile();
  return moduleRef.get(AdminRepository);
}

describe('SupabaseAdminRepository', () => {
  it('listInstructors applies no eq filters when none given, orders deterministically', async () => {
    const stub = makeSupabaseStub({ data: [] });
    const repo = await build(stub);

    await repo.listInstructors({});

    expect(stub.calls.from).toBe('instructors');
    expect(stub.calls.eq).toEqual([]);
    expect(stub.calls.order).toEqual([
      ['inserted_at', { ascending: false }],
      ['id', { ascending: true }],
    ]);
  });

  it('listInstructors selects min_student_age', async () => {
    const stub = makeSupabaseStub({ data: [] });
    const repo = await build(stub);

    await repo.listInstructors({});

    expect(String(stub.calls.select?.[0])).toContain('min_student_age');
  });

  it('listInstructors narrows by status and isActive', async () => {
    const stub = makeSupabaseStub({ data: [] });
    const repo = await build(stub);

    await repo.listInstructors({ status: 'pending', isActive: false });

    expect(stub.calls.eq).toEqual([
      ['approval_status', 'pending'],
      ['is_active', false],
    ]);
  });

  it('listInstructors surfaces Supabase errors as 500', async () => {
    const stub = makeSupabaseStub({ error: { message: 'boom' } });
    const repo = await build(stub);
    await expect(repo.listInstructors({})).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('updateInstructor sends the patch and returns the row', async () => {
    const row = { id: 'i1', approval_status: 'approved' };
    const stub = makeSupabaseStub({ data: row });
    const repo = await build(stub);

    const result = await repo.updateInstructor('i1', {
      approval_status: 'approved',
    });

    expect(stub.calls.update).toEqual({ approval_status: 'approved' });
    expect(stub.calls.eq).toEqual([['id', 'i1']]);
    expect(result).toEqual(row);
  });

  it('insertReference maps camelCase input to snake_case columns', async () => {
    const row = {
      id: 'r1',
      key: 'language.fr',
      name: 'French',
      sort_order: 5,
      is_active: true,
    };
    const stub = makeSupabaseStub({ data: row });
    const repo = await build(stub);

    const result = await repo.insertReference('languages', {
      key: 'language.fr',
      name: 'French',
      sortOrder: 5,
      isActive: true,
    });

    expect(stub.calls.from).toBe('languages');
    expect(stub.calls.insert).toEqual({
      key: 'language.fr',
      name: 'French',
      sort_order: 5,
      is_active: true,
    });
    expect(result).toEqual(row);
  });

  it('insertReference re-throws the raw error (so the service can map 23505)', async () => {
    const stub = makeSupabaseStub({ error: { message: 'dup', code: '23505' } });
    const repo = await build(stub);
    await expect(
      repo.insertReference('languages', {
        key: 'k',
        name: 'n',
        sortOrder: 0,
        isActive: true,
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  const refRow = {
    id: 'r1',
    key: 'location.whistler',
    name: 'Whistler',
    sort_order: 1,
    is_active: false,
  };

  it('listReferences reads every row (no is_active filter) in public order', async () => {
    const stub = makeSupabaseStub({ data: [refRow] });
    const repo = await build(stub);

    const result = await repo.listReferences('teaching_locations');

    expect(stub.calls.from).toBe('teaching_locations');
    expect(stub.calls.eq).toEqual([]);
    expect(stub.calls.order).toEqual([
      ['sort_order', { ascending: true }],
      ['key', { ascending: true }],
    ]);
    expect(result).toEqual([refRow]);
  });

  it('listReferences returns [] when Supabase yields no data', async () => {
    const stub = makeSupabaseStub({ data: null });
    const repo = await build(stub);
    await expect(repo.listReferences('languages')).resolves.toEqual([]);
  });

  it('findReferenceById returns the row or null', async () => {
    const found = makeSupabaseStub({ data: refRow });
    await expect(
      (await build(found)).findReferenceById('languages', 'r1'),
    ).resolves.toEqual(refRow);
    expect(found.calls.eq).toEqual([['id', 'r1']]);

    const missing = makeSupabaseStub({ data: null });
    await expect(
      (await build(missing)).findReferenceById('languages', 'r1'),
    ).resolves.toBeNull();
  });

  it('updateReference sends only the patch columns and returns the row', async () => {
    const stub = makeSupabaseStub({ data: refRow });
    const repo = await build(stub);

    const result = await repo.updateReference('languages', 'r1', {
      is_active: false,
    });

    expect(stub.calls.from).toBe('languages');
    expect(stub.calls.update).toEqual({ is_active: false });
    expect(stub.calls.eq).toEqual([['id', 'r1']]);
    expect(result).toEqual(refRow);
  });

  it('updateReference returns null for an unknown id', async () => {
    const stub = makeSupabaseStub({ data: null });
    const repo = await build(stub);
    await expect(
      repo.updateReference('languages', 'nope', { name: 'x' }),
    ).resolves.toBeNull();
  });

  it('countReferenceLinks counts junction rows for the reference id', async () => {
    const stub = makeSupabaseStub({ count: 7 });
    const repo = await build(stub);

    const result = await repo.countReferenceLinks(
      { table: 'instructors_languages', column: 'language_id' },
      'r1',
    );

    expect(stub.calls.from).toBe('instructors_languages');
    expect(stub.calls.select).toEqual([
      'instructor_id',
      { count: 'exact', head: true },
    ]);
    expect(stub.calls.eq).toEqual([['language_id', 'r1']]);
    expect(result).toBe(7);
  });

  it('countReferenceLinks treats a null count as 0', async () => {
    const stub = makeSupabaseStub({ count: null });
    const repo = await build(stub);
    await expect(
      repo.countReferenceLinks(
        { table: 'instructors_languages', column: 'language_id' },
        'r1',
      ),
    ).resolves.toBe(0);
  });

  it('deleteReference deletes by id and returns the removed row', async () => {
    const stub = makeSupabaseStub({ data: refRow });
    const repo = await build(stub);

    const result = await repo.deleteReference('teaching_locations', 'r1');

    expect(stub.calls.from).toBe('teaching_locations');
    expect(stub.calls.delete).toBe(true);
    expect(stub.calls.eq).toEqual([['id', 'r1']]);
    expect(result).toEqual(refRow);
  });

  it('deleteReference returns null for an unknown id', async () => {
    const stub = makeSupabaseStub({ data: null });
    const repo = await build(stub);
    await expect(
      repo.deleteReference('teaching_locations', 'nope'),
    ).resolves.toBeNull();
  });

  it.each([
    ['listReferences', (r: AdminRepository) => r.listReferences('languages')],
    [
      'findReferenceById',
      (r: AdminRepository) => r.findReferenceById('languages', 'r1'),
    ],
    [
      'updateReference',
      (r: AdminRepository) =>
        r.updateReference('languages', 'r1', { name: 'x' }),
    ],
    [
      'countReferenceLinks',
      (r: AdminRepository) =>
        r.countReferenceLinks(
          { table: 'instructors_languages', column: 'language_id' },
          'r1',
        ),
    ],
    [
      'deleteReference',
      (r: AdminRepository) => r.deleteReference('languages', 'r1'),
    ],
  ])('%s surfaces Supabase errors as 500', async (_name, call) => {
    const stub = makeSupabaseStub({ error: { message: 'boom' } });
    const repo = await build(stub);
    await expect(call(repo)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
