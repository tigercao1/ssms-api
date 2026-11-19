import { randomUUID } from 'node:crypto';
import {
  type BugReportPatch,
  BugReportsRepository,
  type SubmitLimits,
} from '../../src/bug-reports/bug-reports.repository';
import type {
  BugReportRow,
  BugReportStatus,
  NewBugReport,
  SubmitOutcome,
} from '../../src/bug-reports/bug-reports.types';
import type { PageRequest, RowPage } from '../../src/database/pagination';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export class InMemoryBugReports extends BugReportsRepository {
  readonly rows: BugReportRow[] = [];
  readonly instructorNames = new Map<string, string>();
  now = Date.parse('2026-11-19T12:00:00Z');

  seed(overrides: Partial<BugReportRow> = {}): BugReportRow {
    const at = new Date(this.now).toISOString();
    const row: BugReportRow = {
      id: randomUUID(),
      created_at: at,
      updated_at: at,
      reporter_id: randomUUID(),
      reporter_name: 'Seeded Reporter',
      reporter_email: 'seeded@example.com',
      reporter_role: 'instructor',
      description: 'Seeded report',
      expected: null,
      severity: null,
      page_url: '/',
      app_version: null,
      viewport: null,
      user_agent: null,
      screenshot_key: null,
      status: 'new',
      admin_note: null,
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }

  instructorName(authUserId: string): Promise<string | null> {
    return Promise.resolve(this.instructorNames.get(authUserId) ?? null);
  }

  submit(report: NewBugReport, limits: SubmitLimits): Promise<SubmitOutcome> {
    const since = (ms: number) =>
      this.rows.filter((r) => Date.parse(r.created_at) > this.now - ms);
    if (
      since(HOUR_MS).filter((r) => r.reporter_id === report.reporter_id)
        .length >= limits.hourlyPerReporter
    ) {
      return Promise.resolve({ limited: 'reporter' });
    }
    if (since(MINUTE_MS).length >= limits.perMinute) {
      return Promise.resolve({ limited: 'global' });
    }
    const row = this.seed(report);
    return Promise.resolve({ id: row.id, createdAt: row.created_at });
  }

  list(
    status: BugReportStatus | undefined,
    { limit, offset }: PageRequest,
  ): Promise<RowPage<BugReportRow>> {
    const matching = this.rows
      .filter((r) => !status || r.status === status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return Promise.resolve({
      rows: matching.slice(offset, offset + limit),
      total: matching.length,
    });
  }

  findById(id: string): Promise<BugReportRow | null> {
    const row = this.rows.find((r) => r.id === id);
    return Promise.resolve(row ? { ...row } : null);
  }

  update(
    id: string,
    expectedStatus: BugReportStatus,
    patch: BugReportPatch,
  ): Promise<BugReportRow | null> {
    const row = this.rows.find(
      (r) => r.id === id && r.status === expectedStatus,
    );
    if (!row) {
      return Promise.resolve(null);
    }
    const changes = Object.entries(patch).filter(([, v]) => v !== undefined);
    Object.assign(row, Object.fromEntries(changes), {
      updated_at: new Date(this.now + 1000).toISOString(),
    });
    return Promise.resolve({ ...row });
  }
}
