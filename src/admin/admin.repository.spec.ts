import { InternalServerErrorException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { recordingSupabase } from '../../test/helpers/lessons-fakes';
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
    or: unknown[][];
    order: unknown[][];
    update?: unknown;
    insert?: unknown;
    delete?: boolean;
  } = { eq: [], or: [], order: [] };

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
  builder.or = jest.fn((...a: unknown[]) => {
    calls.or.push(a);
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
  it('listInstructors matches every search word against English name, Chinese name or email', async () => {
    const stub = makeSupabaseStub({ data: [] });
    const repo = await build(stub);

    await repo.listInstructors({ q: ' eric  wang ' });
    expect(stub.calls.or).toEqual([
      [
        'display_name_en.ilike."%eric%",display_name_zh.ilike."%eric%",email.ilike."%eric%"',
      ],
      [
        'display_name_en.ilike."%wang%",display_name_zh.ilike."%wang%",email.ilike."%wang%"',
      ],
    ]);

    stub.calls.or = [];
    await repo.listInstructors({ q: '   ' });
    expect(stub.calls.or).toEqual([]);
  });

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

  it('listInstructors embeds the linked calendar in the same query', async () => {
    const stub = makeSupabaseStub({ data: [] });
    const repo = await build(stub);

    await repo.listInstructors({});

    expect(String(stub.calls.select?.[0])).toMatch(
      /, instructor_calendars\(instructor_id\)$/,
    );
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

  it('listInstructors returns every match with an exact count when unpaged', async () => {
    const rows = [{ id: 'i1' }, { id: 'i2' }];
    const { client, queries } = recordingSupabase({
      instructors: { data: rows, error: null, count: 2 },
    });
    await expect(
      new SupabaseAdminRepository(client).listInstructors({}),
    ).resolves.toEqual({ rows, total: 2 });
    expect(queries[0].ops).toEqual([
      ['select', expect.any(String), { count: 'exact' }],
      ['order', 'inserted_at', { ascending: false }],
      ['order', 'id', { ascending: true }],
    ]);
  });

  it('listInstructors pages filtered matches with a range and an exact count', async () => {
    const { client, queries } = recordingSupabase({
      instructors: { data: [{ id: 'i51' }], error: null, count: 51 },
    });
    await expect(
      new SupabaseAdminRepository(client).listInstructors(
        { status: 'approved', isActive: true, q: 'wang' },
        { limit: 50, offset: 50 },
      ),
    ).resolves.toEqual({ rows: [{ id: 'i51' }], total: 51 });
    expect(queries[0].ops).toEqual([
      ['select', expect.any(String), { count: 'exact' }],
      ['eq', 'approval_status', 'approved'],
      ['eq', 'is_active', true],
      [
        'or',
        'display_name_en.ilike."%wang%",display_name_zh.ilike."%wang%",email.ilike."%wang%"',
      ],
      ['order', 'inserted_at', { ascending: false }],
      ['order', 'id', { ascending: true }],
      ['range', 50, 99],
    ]);
  });

  it('listInstructors answers a page past the end with no rows and the real filtered total', async () => {
    const { client, queries } = recordingSupabase({
      instructors: [
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
      new SupabaseAdminRepository(client).listInstructors(
        { status: 'pending', q: 'eric' },
        { limit: 50, offset: 500 },
      ),
    ).resolves.toEqual({ rows: [], total: 7 });
    expect(queries[1].ops).toEqual([
      ['select', 'id', { count: 'exact', head: true }],
      ['eq', 'approval_status', 'pending'],
      [
        'or',
        'display_name_en.ilike."%eric%",display_name_zh.ilike."%eric%",email.ilike."%eric%"',
      ],
    ]);
  });

  it.each([
    [true, ['not', 'instructor_calendars', 'is', null]],
    [false, ['is', 'instructor_calendars', null]],
  ])(
    'listInstructors with calendarConnected=%s filters on the calendar embed',
    async (calendarConnected, calendarOp) => {
      const { client, queries } = recordingSupabase({
        instructors: { data: [], error: null, count: 0 },
      });
      await new SupabaseAdminRepository(client).listInstructors(
        { status: 'approved', calendarConnected },
        { limit: 50, offset: 0 },
      );
      expect(queries[0].ops).toEqual([
        [
          'select',
          expect.stringMatching(/, instructor_calendars\(instructor_id\)$/),
          { count: 'exact' },
        ],
        ['eq', 'approval_status', 'approved'],
        calendarOp,
        ['order', 'inserted_at', { ascending: false }],
        ['order', 'id', { ascending: true }],
        ['range', 0, 49],
      ]);
    },
  );

  it.each([
    [true, ['not', 'instructor_calendars', 'is', null]],
    [false, ['is', 'instructor_calendars', null]],
  ])(
    'listInstructors counts a past-the-end page with calendarConnected=%s through the calendar embed',
    async (calendarConnected, calendarOp) => {
      const { client, queries } = recordingSupabase({
        instructors: [
          {
            data: null,
            error: {
              message: 'Requested range not satisfiable',
              code: 'PGRST103',
            },
          },
          { data: null, error: null, count: 3 },
        ],
      });
      await expect(
        new SupabaseAdminRepository(client).listInstructors(
          { isActive: true, calendarConnected },
          { limit: 50, offset: 500 },
        ),
      ).resolves.toEqual({ rows: [], total: 3 });
      expect(queries[1].ops).toEqual([
        [
          'select',
          'id, instructor_calendars(instructor_id)',
          { count: 'exact', head: true },
        ],
        ['eq', 'is_active', true],
        calendarOp,
      ]);
    },
  );

  it('listInstructors surfaces a failed past-the-end count as 500', async () => {
    const { client } = recordingSupabase({
      instructors: [
        { data: null, error: { message: 'range', code: 'PGRST103' } },
        { data: null, error: { message: 'boom' } },
      ],
    });
    await expect(
      new SupabaseAdminRepository(client).listInstructors(
        {},
        { limit: 50, offset: 500 },
      ),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
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
      nameZh: '法语',
      nameEnTranslatedBy: null,
      nameZhTranslatedBy: 'gemini-test',
      sortOrder: 5,
      isActive: true,
    });

    expect(stub.calls.from).toBe('languages');
    expect(stub.calls.insert).toEqual({
      key: 'language.fr',
      name: 'French',
      name_zh: '法语',
      name_en_translated_by: null,
      name_zh_translated_by: 'gemini-test',
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
        nameZh: null,
        nameEnTranslatedBy: null,
        nameZhTranslatedBy: null,
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

  it('reads the Chinese name and translation provenance of reference rows', async () => {
    const stub = makeSupabaseStub({ data: [refRow] });
    const repo = await build(stub);

    await repo.listReferences('languages');

    expect(String(stub.calls.select?.[0])).toContain(
      'name_zh, name_en_translated_by, name_zh_translated_by',
    );
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

  describe('revokeSessions', () => {
    async function buildWithRpc(result: {
      data: unknown;
      error: { message: string } | null;
    }) {
      const rpc = jest.fn().mockResolvedValue(result);
      const moduleRef = await Test.createTestingModule({
        providers: [
          { provide: AdminRepository, useClass: SupabaseAdminRepository },
          { provide: SUPABASE_CLIENT, useValue: { rpc } },
        ],
      }).compile();
      return { repo: moduleRef.get(AdminRepository), rpc };
    }

    it('calls revoke_user_sessions for the user and returns the revoked count', async () => {
      const { repo, rpc } = await buildWithRpc({ data: 2, error: null });

      await expect(repo.revokeSessions('user-9')).resolves.toBe(2);
      expect(rpc).toHaveBeenCalledWith('revoke_user_sessions', {
        p_user_id: 'user-9',
      });
    });

    it('surfaces Supabase errors as 500', async () => {
      const { repo } = await buildWithRpc({
        data: null,
        error: { message: 'boom' },
      });

      await expect(repo.revokeSessions('user-9')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });
});
