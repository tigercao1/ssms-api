import {
  EVENT_MAP_TABLE,
  ID_CHUNK,
  IMPORT_COLUMNS,
  IMPORTS_TABLE,
  type ImportRowRecord,
  PAGE_SIZE,
  ROW_COLUMNS,
  ROWS_TABLE,
  SupabaseClassImportsRepository,
} from './class-imports.repository';

type Result = {
  data: unknown;
  error: { message: string; code?: string } | null;
};

function fakeSupabase(results: Record<string, Result[]> = {}) {
  const calls: { target: string; ops: unknown[][] }[] = [];
  const next = (key: string): Result =>
    results[key]?.shift() ?? { data: null, error: null };
  const builder = (key: string, ops: unknown[][]) => {
    const b: Record<string, unknown> = {
      then: (resolve: (r: Result) => unknown) =>
        Promise.resolve(next(key)).then(resolve),
    };
    for (const op of [
      'select',
      'eq',
      'in',
      'order',
      'limit',
      'range',
      'insert',
      'update',
      'upsert',
      'delete',
      'single',
      'maybeSingle',
    ]) {
      b[op] = (...args: unknown[]) => {
        ops.push([op, ...args]);
        return b;
      };
    }
    return b;
  };
  const client = {
    from(table: string) {
      const call = { target: table, ops: [] as unknown[][] };
      calls.push(call);
      return builder(table, call.ops);
    },
    rpc(name: string, args: unknown) {
      calls.push({ target: `rpc:${name}`, ops: [['args', args]] });
      return Promise.resolve(next(`rpc:${name}`));
    },
  };
  return { repo: new SupabaseClassImportsRepository(client as never), calls };
}

const ok = (data: unknown): Result => ({ data, error: null });
const boom: Result = { data: null, error: { message: 'boom' } };
const ID = '3f1c2b7a-9d4e-4c1a-8b2f-6a7e5d4c3b2a';

describe('SupabaseClassImportsRepository', () => {
  it('lists, loads, creates, deletes and updates imports', async () => {
    const { repo, calls } = fakeSupabase({
      [IMPORTS_TABLE]: [
        ok([{ id: ID }]),
        ok({ id: ID }),
        ok({ id: ID }),
        ok(null),
        ok(null),
      ],
    });

    await expect(repo.listImports(20)).resolves.toEqual([{ id: ID }]);
    await expect(repo.getImport(ID)).resolves.toEqual({ id: ID });
    await expect(
      repo.createImport({ filename: 'a.csv', uploaded_by: null, counts: {} }),
    ).resolves.toEqual({ id: ID });
    await repo.deleteImport(ID);
    await repo.updateCounts(ID, { total: 1 });

    expect(calls.map((c) => c.ops)).toEqual([
      [
        ['select', IMPORT_COLUMNS],
        ['order', 'created_at', { ascending: false }],
        ['limit', 20],
      ],
      [['select', IMPORT_COLUMNS], ['eq', 'id', ID], ['maybeSingle']],
      [
        ['insert', { filename: 'a.csv', uploaded_by: null, counts: {} }],
        ['select', IMPORT_COLUMNS],
        ['single'],
      ],
      [['delete'], ['eq', 'id', ID]],
      [
        ['update', { counts: { total: 1 } }],
        ['eq', 'id', ID],
      ],
    ]);
  });

  it('discards only drafts and lists draft ids', async () => {
    const { repo, calls } = fakeSupabase({
      [IMPORTS_TABLE]: [ok(null), ok([{ id: ID }])],
    });
    await expect(repo.discardDraft(ID)).resolves.toBeNull();
    await expect(repo.draftIds()).resolves.toEqual([ID]);
    expect(calls[0].ops).toEqual(
      expect.arrayContaining([
        ['update', { status: 'discarded' }],
        ['eq', 'status', 'draft'],
      ]),
    );
    expect(calls[1].ops).toContainEqual(['eq', 'status', 'draft']);
  });

  it('pages through rows and saves them in chunks', async () => {
    const page = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      row_no: i + 1,
    }));
    const { repo, calls } = fakeSupabase({
      [ROWS_TABLE]: [
        ok(page),
        ok([{ row_no: PAGE_SIZE + 1 }]),
        ok(null),
        ok(null),
      ],
    });

    expect(await repo.listRows(ID)).toHaveLength(PAGE_SIZE + 1);
    expect(calls[0].ops).toEqual([
      ['select', ROW_COLUMNS],
      ['eq', 'import_id', ID],
      ['order', 'row_no', { ascending: true }],
      ['range', 0, PAGE_SIZE - 1],
    ]);
    expect(calls[1].ops).toContainEqual([
      'range',
      PAGE_SIZE,
      2 * PAGE_SIZE - 1,
    ]);

    const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => ({
      row_no: i + 1,
    })) as ImportRowRecord[];
    await repo.saveRows(rows);
    expect(calls.slice(2).map((c) => c.ops[0][2])).toEqual([
      { onConflict: 'import_id,row_no' },
      { onConflict: 'import_id,row_no' },
    ]);
  });

  it('loads instructors and calendars as match references', async () => {
    const { repo } = fakeSupabase({
      instructors: [
        ok([{ id: ID, display_name_en: 'Anna', display_name_zh: null }]),
      ],
      instructor_calendars: [
        ok([{ instructor_id: ID, calendar_summary: 'Anna' }]),
      ],
    });
    await expect(repo.instructors()).resolves.toEqual([
      { id: ID, displayNameEn: 'Anna', displayNameZh: null },
    ]);
    await expect(repo.calendars()).resolves.toEqual([
      { instructorId: ID, summary: 'Anna' },
    ]);
  });

  it('reads and writes the event map', async () => {
    const { repo, calls } = fakeSupabase({
      [EVENT_MAP_TABLE]: [ok([{ event_name: 'A', lesson_type_id: ID }])],
    });
    await expect(repo.eventMap()).resolves.toEqual([
      { event_name: 'A', lesson_type_id: ID },
    ]);
    await repo.saveEventMap(
      [{ event_name: 'A', lesson_type_id: ID }],
      ['B'],
      ID,
    );
    await repo.saveEventMap([], [], ID);
    expect(calls.slice(1).map((c) => c.ops)).toEqual([
      [
        [
          'upsert',
          [{ event_name: 'A', lesson_type_id: ID, updated_by: ID }],
          { onConflict: 'event_name' },
        ],
      ],
      [['delete'], ['in', 'event_name', ['B']]],
    ]);
  });

  it('matches customers through the lookup function', async () => {
    const { repo, calls } = fakeSupabase({
      'rpc:class_import_customer_matches': [
        ok([{ id: ID, email_key: 'a@example.com', phone_key: '' }]),
      ],
    });
    await expect(repo.findCustomers([], [])).resolves.toEqual([]);
    await expect(
      repo.findCustomers(['a@example.com'], ['6475550100']),
    ).resolves.toEqual([{ id: ID, emailKey: 'a@example.com', phoneKey: null }]);
    expect(calls).toEqual([
      {
        target: 'rpc:class_import_customer_matches',
        ops: [
          ['args', { p_emails: ['a@example.com'], p_phones: ['6475550100'] }],
        ],
      },
    ]);
  });

  it('looks ids up in chunks', async () => {
    const ids = Array.from({ length: ID_CHUNK + 1 }, (_, i) => `id-${i}`);
    const { repo, calls } = fakeSupabase({
      classes: [ok([{ import_external_id: 'id-1' }]), ok([])],
      customers: [ok([{ id: 'id-2', first_name: 'A', last_name: null }])],
      lesson_types: [ok([{ id: 'id-3' }])],
    });
    await expect(repo.importedExternalIds([...ids, 'id-1'])).resolves.toEqual([
      'id-1',
    ]);
    await expect(repo.customerNames(['id-2'])).resolves.toEqual([
      { id: 'id-2', first_name: 'A', last_name: null },
    ]);
    await expect(repo.existingIds('lesson_types', ['id-3'])).resolves.toEqual([
      'id-3',
    ]);
    expect(calls.filter((c) => c.target === 'classes')).toHaveLength(2);
    expect(calls[0].ops[1]).toEqual([
      'in',
      'import_external_id',
      ids.slice(0, ID_CHUNK),
    ]);
  });

  it('commits through the database function', async () => {
    const counts = {
      total: 1,
      ready: 1,
      created: 1,
      alreadyImported: 0,
      participants: 0,
      skipped: 0,
    };
    const { repo, calls } = fakeSupabase({
      'rpc:commit_class_import': [ok(counts)],
    });
    await expect(repo.commit(ID, null)).resolves.toEqual(counts);
    expect(calls[0].ops).toEqual([
      ['args', { p_import_id: ID, p_actor: null }],
    ]);
  });

  it.each([
    [
      'listImports',
      (r: SupabaseClassImportsRepository) => r.listImports(1),
      IMPORTS_TABLE,
    ],
    [
      'getImport',
      (r: SupabaseClassImportsRepository) => r.getImport(ID),
      IMPORTS_TABLE,
    ],
    [
      'createImport',
      (r: SupabaseClassImportsRepository) =>
        r.createImport({ filename: 'a', uploaded_by: null, counts: {} }),
      IMPORTS_TABLE,
    ],
    [
      'deleteImport',
      (r: SupabaseClassImportsRepository) => r.deleteImport(ID),
      IMPORTS_TABLE,
    ],
    [
      'updateCounts',
      (r: SupabaseClassImportsRepository) => r.updateCounts(ID, {}),
      IMPORTS_TABLE,
    ],
    [
      'discardDraft',
      (r: SupabaseClassImportsRepository) => r.discardDraft(ID),
      IMPORTS_TABLE,
    ],
    [
      'draftIds',
      (r: SupabaseClassImportsRepository) => r.draftIds(),
      IMPORTS_TABLE,
    ],
    [
      'listRows',
      (r: SupabaseClassImportsRepository) => r.listRows(ID),
      ROWS_TABLE,
    ],
    [
      'saveRows',
      (r: SupabaseClassImportsRepository) =>
        r.saveRows([{} as ImportRowRecord]),
      ROWS_TABLE,
    ],
    [
      'instructors',
      (r: SupabaseClassImportsRepository) => r.instructors(),
      'instructors',
    ],
    [
      'calendars',
      (r: SupabaseClassImportsRepository) => r.calendars(),
      'instructor_calendars',
    ],
    [
      'eventMap',
      (r: SupabaseClassImportsRepository) => r.eventMap(),
      EVENT_MAP_TABLE,
    ],
    [
      'saveEventMap upsert',
      (r: SupabaseClassImportsRepository) =>
        r.saveEventMap([{ event_name: 'A', lesson_type_id: ID }], [], null),
      EVENT_MAP_TABLE,
    ],
    [
      'saveEventMap delete',
      (r: SupabaseClassImportsRepository) => r.saveEventMap([], ['A'], null),
      EVENT_MAP_TABLE,
    ],
    [
      'findCustomers',
      (r: SupabaseClassImportsRepository) => r.findCustomers(['a@b.c'], []),
      'rpc:class_import_customer_matches',
    ],
    [
      'customerNames',
      (r: SupabaseClassImportsRepository) => r.customerNames([ID]),
      'customers',
    ],
    [
      'importedExternalIds',
      (r: SupabaseClassImportsRepository) => r.importedExternalIds(['1']),
      'classes',
    ],
    [
      'existingIds',
      (r: SupabaseClassImportsRepository) => r.existingIds('instructors', [ID]),
      'instructors',
    ],
    [
      'commit',
      (r: SupabaseClassImportsRepository) => r.commit(ID, null),
      'rpc:commit_class_import',
    ],
  ])('%s surfaces database errors', async (_name, run, target) => {
    const { repo } = fakeSupabase({ [target]: [boom] });
    await expect(run(repo)).rejects.toThrow(/boom/);
  });
});
