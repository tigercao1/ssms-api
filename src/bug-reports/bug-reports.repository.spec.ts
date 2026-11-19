import type { SupabaseClient } from '@supabase/supabase-js';
import { DatabaseError } from '../database/db-result';
import { SupabaseBugReportsRepository } from './bug-reports.repository';
import { BUG_REPORT_STATUSES, type NewBugReport } from './bug-reports.types';

type Result = {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
};

class RecordingSupabase {
  queries: { table: string; calls: [string, unknown[]][] }[] = [];
  rpcs: { name: string; args: unknown }[] = [];
  results: Result[] = [];

  private next(): Promise<Result> {
    return Promise.resolve(this.results.shift() ?? { data: null, error: null });
  }

  from(table: string) {
    const query = { table, calls: [] as [string, unknown[]][] };
    this.queries.push(query);
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'update', 'eq', 'in', 'order', 'range']) {
      builder[method] = (...args: unknown[]) => {
        query.calls.push([method, args]);
        return builder;
      };
    }
    builder.maybeSingle = () => this.next();
    builder.then = (resolve: (r: Result) => unknown) =>
      this.next().then(resolve);
    return builder;
  }

  rpc(name: string, args: unknown) {
    this.rpcs.push({ name, args });
    return {
      single: () => this.next(),
      then: (resolve: (r: Result) => unknown) => this.next().then(resolve),
    };
  }
}

function setup() {
  const db = new RecordingSupabase();
  return {
    db,
    repo: new SupabaseBugReportsRepository(db as unknown as SupabaseClient),
  };
}

const REPORT: NewBugReport = {
  reporter_id: 'user-1',
  reporter_name: 'Ada',
  reporter_email: 'ada@example.com',
  reporter_role: 'instructor',
  description: 'Broken',
  expected: null,
  severity: null,
  page_url: '/',
  app_version: null,
  viewport: null,
  user_agent: null,
  screenshot_key: null,
};
const LIMITS = { hourlyPerReporter: 10, perMinute: 30 };

describe('SupabaseBugReportsRepository', () => {
  it('submits through the limiting function and returns the new id', async () => {
    const { db, repo } = setup();
    db.results = [
      {
        data: { id: 'r-1', created_at: '2026-11-19T00:00:00Z', limited: null },
        error: null,
      },
    ];

    await expect(repo.submit(REPORT, LIMITS)).resolves.toEqual({
      id: 'r-1',
      createdAt: '2026-11-19T00:00:00Z',
    });
    expect(db.rpcs).toEqual([
      {
        name: 'submit_bug_report',
        args: {
          p_report: REPORT,
          p_hourly_limit_per_reporter: 10,
          p_minute_limit: 30,
        },
      },
    ]);
  });

  it('reports which limit refused the submission', async () => {
    const { db, repo } = setup();
    db.results = [
      {
        data: { id: null, created_at: null, limited: 'reporter' },
        error: null,
      },
    ];

    await expect(repo.submit(REPORT, LIMITS)).resolves.toEqual({
      limited: 'reporter',
    });
  });

  it('throws when the function fails', async () => {
    const { db, repo } = setup();
    db.results = [{ data: null, error: { message: 'boom' } }];

    await expect(repo.submit(REPORT, LIMITS)).rejects.toBeInstanceOf(
      DatabaseError,
    );
  });

  it('records a screenshot key through the limiting function', async () => {
    const { db, repo } = setup();
    db.results = [
      { data: null, error: null },
      { data: 'global', error: null },
      { data: null, error: { message: 'boom' } },
    ];

    await expect(
      repo.issueScreenshot('user-1', 'bug-reports/k.png', LIMITS),
    ).resolves.toBeNull();
    await expect(
      repo.issueScreenshot('user-1', 'bug-reports/k.png', LIMITS),
    ).resolves.toBe('global');
    await expect(
      repo.issueScreenshot('user-1', 'bug-reports/k.png', LIMITS),
    ).rejects.toBeInstanceOf(DatabaseError);
    expect(db.rpcs[0]).toEqual({
      name: 'issue_bug_report_screenshot',
      args: {
        p_reporter: 'user-1',
        p_key: 'bug-reports/k.png',
        p_hourly_limit_per_reporter: 10,
        p_minute_limit: 30,
      },
    });
  });

  it('lists one status newest first within the page', async () => {
    const { db, repo } = setup();
    db.results = [{ data: [{ id: 'r-1' }], error: null, count: 7 }];

    await expect(
      repo.list('resolved', { limit: 25, offset: 50 }),
    ).resolves.toEqual({ rows: [{ id: 'r-1' }], total: 7 });
    expect(db.queries[0].calls).toEqual([
      ['select', ['*', { count: 'exact' }]],
      ['in', ['status', ['resolved']]],
      ['order', ['created_at', { ascending: false }]],
      ['order', ['id', { ascending: false }]],
      ['range', [50, 74]],
    ]);
  });

  it('counts every status when a page is past the end', async () => {
    const { db, repo } = setup();
    db.results = [
      { data: null, error: { message: 'range', code: 'PGRST103' } },
      { data: null, error: null, count: 3 },
    ];

    await expect(
      repo.list(undefined, { limit: 25, offset: 100 }),
    ).resolves.toEqual({ rows: [], total: 3 });
    expect(db.queries[1].calls).toEqual([
      ['select', ['id', { count: 'exact', head: true }]],
      ['in', ['status', BUG_REPORT_STATUSES]],
    ]);
  });

  it('updates only while the report keeps the status it was read with', async () => {
    const { db, repo } = setup();
    db.results = [{ data: null, error: null }];

    await expect(
      repo.update('r-1', 'new', { status: 'resolved' }),
    ).resolves.toBeNull();
    expect(db.queries[0].calls).toEqual([
      ['update', [{ status: 'resolved' }]],
      ['eq', ['id', 'r-1']],
      ['eq', ['status', 'new']],
      ['select', ['*']],
    ]);
  });

  it('names the reporter from the instructor profile', async () => {
    const { db, repo } = setup();
    db.results = [
      {
        data: {
          display_name_en: ' ',
          first_name: 'Ada',
          last_name: 'Lovelace',
        },
        error: null,
      },
      { data: null, error: null },
    ];

    await expect(repo.instructorName('user-1')).resolves.toBe('Ada Lovelace');
    await expect(repo.instructorName('user-2')).resolves.toBeNull();
    expect(db.queries[0].calls).toContainEqual([
      'eq',
      ['auth_user_id', 'user-1'],
    ]);
  });
});
