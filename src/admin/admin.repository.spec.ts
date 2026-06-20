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
  error?: { message: string; code?: string } | null;
}) {
  const calls: {
    from?: string;
    select?: unknown[];
    eq: unknown[][];
    order: unknown[][];
    update?: unknown;
    insert?: unknown;
  } = { eq: [], order: [] };

  const resolved = {
    data: result.data ?? null,
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
});
