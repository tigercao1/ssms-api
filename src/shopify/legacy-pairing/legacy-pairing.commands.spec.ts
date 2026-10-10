import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { GraphqlFn, LegacySnapshot } from './legacy-our-team';
import {
  PairingCommandError,
  type PairingDeps,
  parseArgs,
  runApply,
  runPairingCli,
  runPropose,
  runSnapshot,
  snapshotFileName,
} from './legacy-pairing.commands';
import { PAIRING_CSV_COLUMNS } from './pairing-csv';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-10T04:00:00.000Z');

type Row = Record<string, unknown>;
type DbError = { code?: string; message: string } | null;

interface FakeDb {
  tables: Record<string, Row[]>;
  failOn?: { table: string; op: 'select' | 'upsert'; error: DbError };
  writes: { table: string; rows: Row[]; onConflict?: string }[];
}

function fakeSupabase(db: FakeDb): SupabaseClient {
  const from = (table: string) => {
    let filters: ((r: Row) => boolean)[] = [];
    let columns: string[] = [];
    const result = () => {
      const failure = db.failOn;
      if (failure?.table === table && failure.op === 'select') {
        return { data: null, error: failure.error };
      }
      const missing = columns.find(
        (c) => !(c in (db.tables[table][0] ?? { [c]: null })),
      );
      if (missing && db.tables[table].length > 0) {
        return {
          data: null,
          error: {
            code: '42703',
            message: `column ${table}.${missing} does not exist`,
          },
        };
      }
      const rows = db.tables[table].filter((r) => filters.every((f) => f(r)));
      return {
        data: rows.map((r) =>
          Object.fromEntries(columns.map((c) => [c, r[c] ?? null])),
        ),
        error: null,
      };
    };
    const builder = {
      select(cols: string) {
        columns = cols.split(',').map((c) => c.trim());
        filters = [];
        return builder;
      },
      in(column: string, values: unknown[]) {
        filters.push((r) => values.includes(r[column]));
        return builder;
      },
      limit() {
        return builder;
      },
      order() {
        return builder;
      },
      then<T>(resolve: (value: ReturnType<typeof result>) => T) {
        return Promise.resolve(result()).then(resolve);
      },
      upsert(rows: Row[], options: { onConflict?: string }) {
        const failure = db.failOn;
        if (failure?.table === table && failure.op === 'upsert') {
          return Promise.resolve({ error: failure.error });
        }
        db.writes.push({ table, rows, onConflict: options.onConflict });
        for (const row of rows) {
          const existing = db.tables[table].find(
            (r) => r.instructor_id === row.instructor_id,
          );
          if (existing) {
            Object.assign(existing, row);
          } else {
            db.tables[table].push({ ...row });
          }
        }
        return Promise.resolve({ error: null });
      },
    };
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

function seedDb(stateRows: Row[] = []): FakeDb {
  return {
    tables: {
      instructors: [
        {
          id: ID1,
          display_name_en: 'Vincent Li',
          display_name_zh: '李文森',
          approval_status: 'approved',
          is_active: true,
        },
        {
          id: ID2,
          display_name_en: 'Sarah Chen',
          display_name_zh: null,
          approval_status: 'pending',
          is_active: true,
        },
      ],
      instructor_shopify_state: stateRows,
    },
    writes: [],
  };
}

const metaobject = (id: string, handle: string, name: string) => ({
  id,
  handle,
  type: 'our_team',
  displayName: name,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-02-01T00:00:00Z',
  capabilities: { publishable: { status: 'ACTIVE' } },
  fields: [
    {
      key: 'name',
      type: 'single_line_text_field',
      value: name,
      jsonValue: name,
      reference: null,
    },
  ],
});

function fakeShopify() {
  const calls: { query: string; variables?: Record<string, unknown> }[] = [];
  const respond = (query: string, variables?: Record<string, unknown>) => {
    calls.push({ query, variables });
    if (query.includes('translatableResourcesByIds')) {
      const ids = variables?.ids as string[];
      return {
        translatableResourcesByIds: {
          nodes: ids.map((id) => ({
            resourceId: id,
            translatableContent: [
              { key: 'name', value: 'zh', locale: 'zh-CN' },
            ],
            translations: [
              {
                key: 'name',
                value: `en-${id}`,
                locale: 'en',
                outdated: false,
                updatedAt: null,
              },
            ],
          })),
        },
      };
    }
    if (variables?.after == null) {
      return {
        metaobjects: {
          pageInfo: { hasNextPage: true, endCursor: 'c1' },
          nodes: [
            metaobject('gid://shopify/Metaobject/1', 'xiao-li', '小李 Vincent'),
          ],
        },
      };
    }
    return {
      metaobjects: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [metaobject('gid://shopify/Metaobject/2', 'sarah', 'Sarah 陈')],
      },
    };
  };
  const graphql = ((query: string, variables?: Record<string, unknown>) =>
    Promise.resolve(respond(query, variables))) as GraphqlFn;
  return { graphql, calls };
}

function makeDeps(
  db: FakeDb,
  files: Record<string, string> = {},
  env: Record<string, string | undefined> = { SSMS_ENV: 'dev' },
) {
  const shopify = fakeShopify();
  const logs: string[] = [];
  const written: Record<string, string> = {};
  const deps: PairingDeps = {
    graphql: () => shopify.graphql,
    supabase: () => fakeSupabase(db),
    readFile: (file) =>
      file in files
        ? Promise.resolve(files[file])
        : Promise.reject(new Error(`ENOENT ${file}`)),
    writeFile: (file, contents) => {
      written[file] = contents;
      return Promise.resolve();
    },
    isDirectory: (dir) => Promise.resolve(dir === '/backups'),
    log: (line) => logs.push(line),
    now: () => NOW,
    repoRoot: '/repo',
    env,
  };
  return { deps, logs, written, shopify };
}

const reviewed = (...rows: string[]) =>
  [PAIRING_CSV_COLUMNS.join(','), ...rows].join('\n');

describe('runSnapshot', () => {
  it('writes every page with translations to a timestamped file outside the repo', async () => {
    const { deps, written, shopify, logs } = makeDeps(seedDb());
    const file = await runSnapshot(deps, '/backups');

    expect(file).toBe(`/backups/${snapshotFileName(NOW)}`);
    expect(file).toBe('/backups/our_team-2026-10-10T04-00-00-000Z.json');
    const snapshot = JSON.parse(written[file]) as LegacySnapshot;
    expect(snapshot).toMatchObject({
      metaobjectType: 'our_team',
      translationLocale: 'en',
      fetchedAt: NOW.toISOString(),
      count: 2,
    });
    expect(snapshot.entries[0]).toMatchObject({
      id: 'gid://shopify/Metaobject/1',
      handle: 'xiao-li',
      publishableStatus: 'ACTIVE',
      fields: [{ key: 'name', value: '小李 Vincent' }],
      translations: [{ locale: 'en', value: 'en-gid://shopify/Metaobject/1' }],
    });
    expect(shopify.calls.map((c) => c.variables?.after ?? null)).toEqual([
      null,
      'c1',
      null,
    ]);
    expect(shopify.calls.every((c) => /^\s*query /.test(c.query))).toBe(true);
    expect(logs).toEqual([`Wrote 2 our_team entries to ${file}`]);
  });

  it('requires an existing output directory outside the repository', async () => {
    const { deps } = makeDeps(seedDb());
    await expect(runSnapshot(deps, undefined)).rejects.toThrow(
      'Usage: snapshot <output-dir>',
    );
    await expect(runSnapshot(deps, '/repo/backups')).rejects.toThrow(
      /inside the repository/,
    );
    await expect(runSnapshot(deps, '/missing')).rejects.toThrow(
      /not an existing directory/,
    );
  });
});

describe('output path guard on a real filesystem', () => {
  let tmp: string;
  let repo: string;
  let outside: string;
  let linkIntoRepo: string;

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-pairing-')),
    );
    repo = path.join(tmp, 'repo');
    outside = path.join(tmp, 'outside');
    linkIntoRepo = path.join(outside, 'link');
    fs.mkdirSync(path.join(repo, 'backups'), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(repo, linkIntoRepo, 'dir');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function realDeps() {
    const made = makeDeps(seedDb());
    made.deps.repoRoot = repo;
    made.deps.isDirectory = (dir) =>
      Promise.resolve(fs.existsSync(dir) && fs.statSync(dir).isDirectory());
    return made;
  }

  it('refuses a directory outside the repo that is a symlink into it', async () => {
    const { deps, written } = realDeps();
    await expect(runSnapshot(deps, linkIntoRepo)).rejects.toThrow(
      /inside the repository/,
    );
    await expect(
      runSnapshot(deps, path.join(linkIntoRepo, 'backups')),
    ).rejects.toThrow(/inside the repository/);
    await expect(
      runPropose(deps, path.join(linkIntoRepo, 'p.csv')),
    ).rejects.toThrow(/inside the repository/);
    await expect(
      runPropose(deps, path.join(linkIntoRepo, 'new', 'p.csv')),
    ).rejects.toThrow(/inside the repository/);
    expect(written).toEqual({});
  });

  it('refuses a relative path that resolves into the repo', async () => {
    const { deps } = realDeps();
    const cwd = process.cwd();
    process.chdir(outside);
    try {
      await expect(runPropose(deps, 'link/p.csv')).rejects.toThrow(
        /inside the repository/,
      );
    } finally {
      process.chdir(cwd);
    }
  });

  it('allows a normal directory outside the repo', async () => {
    const { deps, written } = realDeps();
    const file = await runSnapshot(deps, outside);
    expect(file).toBe(path.join(outside, snapshotFileName(NOW)));
    expect(Object.keys(written)).toEqual([file]);
  });

  it('allows a not-yet-existing nested output path under an external directory', async () => {
    const { deps, written } = realDeps();
    const target = path.join(outside, 'new', 'deeper', 'p.csv');
    const file = await runPropose(deps, target);
    expect(file).toBe(target);
    expect(Object.keys(written)).toEqual([target]);
  });
});

describe('runPropose', () => {
  it('writes a proposal CSV from live Shopify data without writing to the database', async () => {
    const db = seedDb();
    const { deps, written } = makeDeps(db);
    await runPropose(deps, '/backups/proposals.csv');

    const lines = written['/backups/proposals.csv'].trim().split('\n');
    expect(lines[0]).toBe(PAIRING_CSV_COLUMNS.join(','));
    expect(lines).toContain(
      `${ID1},Vincent Li,李文森,xiao-li,小李 Vincent,0.61,`,
    );
    expect(
      lines.some((l) => l.startsWith(`${ID2},Sarah Chen,,sarah,Sarah 陈,`)),
    ).toBe(true);
    expect(db.writes).toEqual([]);
  });

  it('can use a saved snapshot instead of calling Shopify', async () => {
    const snapshot = {
      entries: [
        {
          handle: 'xiao-li',
          displayName: 'ignored',
          fields: [{ key: 'name', value: '小李 Vincent' }],
        },
        { handle: 'no-name', displayName: 'Sarah Chen', fields: [] },
      ],
    };
    const { deps, written, shopify } = makeDeps(seedDb(), {
      '/backups/s.json': JSON.stringify(snapshot),
    });
    await runPropose(deps, '/backups/p.csv', '/backups/s.json');
    expect(shopify.calls).toEqual([]);
    expect(written['/backups/p.csv']).toContain(
      `${ID2},Sarah Chen,,no-name,Sarah Chen,1.00,`,
    );
  });

  it('refuses output inside the repository and reports read errors', async () => {
    const { deps } = makeDeps(seedDb());
    await expect(runPropose(deps, undefined)).rejects.toThrow(/Usage: propose/);
    await expect(runPropose(deps, '/repo/p.csv')).rejects.toThrow(
      /inside the repository/,
    );
    const failing = seedDb();
    failing.failOn = {
      table: 'instructors',
      op: 'select',
      error: { message: 'boom' },
    };
    await expect(
      runPropose(makeDeps(failing).deps, '/backups/p.csv'),
    ).rejects.toThrow('Failed to read instructors: boom');
  });
});

describe('runApply', () => {
  const stateRow = (id: string, handle: string | null) => ({
    instructor_id: id,
    shopify_metaobject_id: null,
    shopify_handle: handle,
  });

  it('prints the plan but writes nothing without --write', async () => {
    const db = seedDb([stateRow(ID2, null)]);
    const { deps, logs } = makeDeps(db, {
      '/r.csv': reviewed(`${ID1},,,xiao-li,,,y`, `${ID2},,,sarah,,,`),
    });
    await expect(runApply(deps, '/r.csv', false)).resolves.toBe(0);
    expect(db.writes).toEqual([]);
    expect(logs).toEqual([
      `WOULD SET ${ID1} [Vincent Li / 李文森] shopify_handle=xiao-li (was (none))`,
      'Dry run: 1 row(s). Re-run with --write to apply.',
    ]);
  });

  it('upserts the state rows with --write', async () => {
    const db = seedDb([stateRow(ID2, 'old')]);
    const { deps, logs } = makeDeps(db, {
      '/r.csv': reviewed(`${ID1},,,xiao-li,,,y`, `${ID2},,,sarah,,,y`),
    });
    await expect(runApply(deps, '/r.csv', true)).resolves.toBe(2);
    expect(db.writes).toEqual([
      {
        table: 'instructor_shopify_state',
        onConflict: 'instructor_id',
        rows: [
          { instructor_id: ID1, shopify_handle: 'xiao-li' },
          { instructor_id: ID2, shopify_handle: 'sarah' },
        ],
      },
    ]);
    expect(db.tables.instructor_shopify_state).toEqual([
      stateRow(ID2, 'sarah'),
      { instructor_id: ID1, shopify_handle: 'xiao-li' },
    ]);
    expect(logs).toContain(
      `SET ${ID2} [Sarah Chen] shopify_handle=sarah (was old)`,
    );
    expect(logs).toContain('Updated 2 row(s).');
  });

  it('re-applying the same pairing is allowed', async () => {
    const db = seedDb([stateRow(ID1, 'xiao-li')]);
    const { deps } = makeDeps(db, {
      '/r.csv': reviewed(`${ID1},,,xiao-li,,,y`),
    });
    await expect(runApply(deps, '/r.csv', true)).resolves.toBe(1);
  });

  it('refuses a handle confirmed twice in the CSV', async () => {
    const db = seedDb([stateRow(ID2, null)]);
    const { deps } = makeDeps(db, {
      '/r.csv': reviewed(`${ID1},,,xiao-li,,,y`, `${ID2},,,xiao-li,,,y`),
    });
    await expect(runApply(deps, '/r.csv', true)).rejects.toThrow(
      /legacy_handle "xiao-li" is confirmed more than once/,
    );
    expect(db.writes).toEqual([]);
  });

  it('refuses a handle already paired with another instructor', async () => {
    const db = seedDb([stateRow(ID2, 'xiao-li')]);
    const { deps } = makeDeps(db, {
      '/r.csv': reviewed(`${ID1},,,xiao-li,,,y`),
    });
    await expect(runApply(deps, '/r.csv', true)).rejects.toThrow(
      `Handle(s) already paired with another instructor: xiao-li -> ${ID2}`,
    );
    expect(db.writes).toEqual([]);
  });

  it('refuses unknown instructor ids', async () => {
    const db = seedDb([stateRow(ID2, null)]);
    const { deps } = makeDeps(db, { '/r.csv': reviewed(`${ID3},,,x,,,y`) });
    await expect(runApply(deps, '/r.csv', false)).rejects.toThrow(
      `Unknown instructor id(s): ${ID3} (line 2)`,
    );
  });

  it('fails clearly when the shopify_handle column is missing', async () => {
    const db = seedDb([{ instructor_id: ID2, shopify_metaobject_id: null }]);
    const { deps } = makeDeps(db, { '/r.csv': reviewed(`${ID1},,,x,,,y`) });
    await expect(runApply(deps, '/r.csv', false)).rejects.toThrow(
      /instructor_shopify_state\.shopify_handle does not exist.*migration 256/,
    );
  });

  it('requires SSMS_CONFIRM_PROD=yes to write to prod', async () => {
    const db = seedDb([stateRow(ID2, null)]);
    const files = { '/r.csv': reviewed(`${ID1},,,x,,,y`) };
    const prod = makeDeps(db, files, { SSMS_ENV: 'prod' });
    await expect(runApply(prod.deps, '/r.csv', true)).rejects.toThrow(
      'Refusing to write to PROD without SSMS_CONFIRM_PROD=yes.',
    );
    await expect(runApply(prod.deps, '/r.csv', false)).resolves.toBe(0);
    expect(db.writes).toEqual([]);
    const confirmed = makeDeps(db, files, {
      SSMS_ENV: 'prod',
      SSMS_CONFIRM_PROD: 'yes',
    });
    await expect(runApply(confirmed.deps, '/r.csv', true)).resolves.toBe(1);
  });

  it('does nothing when no row is confirmed', async () => {
    const db = seedDb([stateRow(ID2, null)]);
    const { deps, logs } = makeDeps(db, {
      '/r.csv': reviewed(`${ID1},,,x,,,`),
    });
    await expect(runApply(deps, '/r.csv', true)).resolves.toBe(0);
    expect(logs).toEqual(['No rows with confirm=y; nothing to do.']);
    expect(db.writes).toEqual([]);
  });

  it('reports database errors', async () => {
    const files = { '/r.csv': reviewed(`${ID1},,,x,,,y`) };
    const probeFails = seedDb([stateRow(ID2, null)]);
    probeFails.failOn = {
      table: 'instructor_shopify_state',
      op: 'select',
      error: { message: 'denied' },
    };
    await expect(
      runApply(makeDeps(probeFails, files).deps, '/r.csv', false),
    ).rejects.toThrow('Failed to read instructor_shopify_state: denied');

    const lookupFails = seedDb([stateRow(ID2, null)]);
    lookupFails.failOn = {
      table: 'instructors',
      op: 'select',
      error: { message: 'down' },
    };
    await expect(
      runApply(makeDeps(lookupFails, files).deps, '/r.csv', false),
    ).rejects.toThrow('Failed to read instructors: down');

    const upsertFails = seedDb([stateRow(ID2, null)]);
    upsertFails.failOn = {
      table: 'instructor_shopify_state',
      op: 'upsert',
      error: { message: 'conflict' },
    };
    await expect(
      runApply(makeDeps(upsertFails, files).deps, '/r.csv', true),
    ).rejects.toThrow('Failed to upsert instructor_shopify_state: conflict');

    const upsertMissing = seedDb([stateRow(ID2, null)]);
    upsertMissing.failOn = {
      table: 'instructor_shopify_state',
      op: 'upsert',
      error: { code: '42703', message: 'column does not exist' },
    };
    await expect(
      runApply(makeDeps(upsertMissing, files).deps, '/r.csv', true),
    ).rejects.toThrow(/shopify_handle does not exist/);
  });
});

describe('CLI parsing', () => {
  it('parses commands, positionals and options', () => {
    expect(parseArgs(['apply', 'r.csv', '--write'])).toEqual({
      command: 'apply',
      positional: ['r.csv'],
      write: true,
      snapshot: undefined,
    });
    expect(parseArgs(['propose', 'p.csv', '--snapshot', 's.json'])).toEqual({
      command: 'propose',
      positional: ['p.csv'],
      write: false,
      snapshot: 's.json',
    });
    expect(() => parseArgs(['propose', '--snapshot'])).toThrow(
      '--snapshot needs a file path',
    );
    expect(() => parseArgs(['apply', '--force'])).toThrow(
      'Unknown option: --force',
    );
  });

  it('dispatches commands and rejects misuse', async () => {
    const db = seedDb([{ instructor_id: ID2, shopify_handle: null }]);
    const { deps, written } = makeDeps(db, { '/r.csv': reviewed() });
    await runPairingCli(deps, ['snapshot', '/backups']);
    await runPairingCli(deps, ['propose', '/backups/p.csv']);
    await runPairingCli(deps, ['apply', '/r.csv']);
    expect(Object.keys(written)).toHaveLength(2);
    await expect(
      runPairingCli(deps, ['snapshot', '/backups', '--write']),
    ).rejects.toThrow('--write is only valid for apply');
    await expect(runPairingCli(deps, ['push'])).rejects.toThrow(
      PairingCommandError,
    );
    await expect(runApply(deps, undefined, false)).rejects.toThrow(
      /Usage: apply/,
    );
  });
});
