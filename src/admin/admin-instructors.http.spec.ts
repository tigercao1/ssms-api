import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH as admin,
  INSTRUCTOR_AUTH,
  startAdminApp,
} from '../../test/helpers/admin-http';
import {
  type CappedRequest,
  cappedSupabase,
  POSTGREST_MAX_ROWS,
} from '../../test/helpers/capped-supabase';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { BIO_TRANSLATOR } from '../bio-translation/bio-translator.interface';
import { TOTAL_COUNT_HEADER } from '../config/cors';
import type { PageRequest, RowPage } from '../database/pagination';
import { DocumentOnboardingService } from '../documents/document-onboarding.service';
import { InstructorsService } from '../instructors/instructors.service';
import { MailerService } from '../mailer/mailer.service';
import { SeasonsService } from '../seasons/seasons.service';
import { GoLiveService } from '../shopify-sync/go-live.service';
import {
  INSTRUCTOR_STAGES,
  type InstructorStage,
} from '../shopify-sync/instructor-stage';
import { AdminController } from './admin.controller';
import { AdminRepository, SupabaseAdminRepository } from './admin.repository';
import { AdminService } from './admin.service';
import type {
  AdminInstructorListRecord,
  AdminInstructorListRow,
  ListInstructorsFilter,
} from './admin.types';

const instructorId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function makeRow(n: number): AdminInstructorListRow {
  return {
    id: instructorId(n),
    auth_user_id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    email: `instructor${n}@example.com`,
    first_name: null,
    last_name: null,
    display_name_en: n % 2 === 0 ? `Eric Wang ${n}` : `Jane Li ${n}`,
    display_name_zh: null,
    bio_en: null,
    bio_zh: null,
    date_of_birth: null,
    profile_photo_url: null,
    min_student_age: 5,
    display_order: null,
    preferred_language: 'en',
    approval_status: n % 3 === 0 ? 'pending' : 'approved',
    is_active: n % 5 !== 0,
    inserted_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    updated_at: '2026-01-01T00:00:00.000Z',
    instructor_calendars:
      n % 4 === 0 ? { instructor_id: instructorId(n) } : null,
  };
}

class InMemoryInstructorList {
  rows: AdminInstructorListRow[] = [];
  calls: { filter: ListInstructorsFilter; page?: PageRequest }[] = [];

  listInstructors(
    filter: ListInstructorsFilter,
    page?: PageRequest,
  ): Promise<RowPage<AdminInstructorListRow>> {
    this.calls.push({ filter, page });
    const tokens = (filter.q ?? '').trim().toLowerCase().split(/\s+/);
    const text = (r: AdminInstructorListRow) =>
      [r.display_name_en, r.display_name_zh, r.email].join(' ').toLowerCase();
    const matches = this.rows
      .filter((r) => !filter.status || r.approval_status === filter.status)
      .filter(
        (r) => filter.isActive === undefined || r.is_active === filter.isActive,
      )
      .filter(
        (r) =>
          filter.calendarConnected === undefined ||
          (r.instructor_calendars !== null) === filter.calendarConnected,
      )
      .filter((r) => tokens.every((t) => text(r).includes(t)))
      .sort(
        (a, b) =>
          b.inserted_at.localeCompare(a.inserted_at) ||
          a.id.localeCompare(b.id),
      );
    return Promise.resolve({
      rows: page
        ? matches.slice(page.offset, page.offset + page.limit)
        : matches,
      total: matches.length,
    });
  }

  async listAllInstructors(
    filter: ListInstructorsFilter,
  ): Promise<AdminInstructorListRow[]> {
    return (await this.listInstructors(filter)).rows;
  }
}

const stageOf = (n: number): InstructorStage =>
  INSTRUCTOR_STAGES[n % INSTRUCTOR_STAGES.length];

class StageLookup {
  calls: string[][] = [];

  stages(ids: string[]): Promise<Map<string, InstructorStage>> {
    this.calls.push(ids);
    return Promise.resolve(
      new Map(ids.map((id) => [id, stageOf(Number(id.slice(-12)))])),
    );
  }
}

async function build(count = 60) {
  const repo = new InMemoryInstructorList();
  const goLive = new StageLookup();
  repo.rows = Array.from({ length: count }, (_, i) => makeRow(i + 1));
  const app = await startListApp(repo, goLive);
  return { app, repo, goLive };
}

function startListApp(
  repo: Pick<AdminRepository, 'listInstructors' | 'listAllInstructors'>,
  goLive: Pick<GoLiveService, 'stages'>,
) {
  return startAdminApp(
    Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: SeasonsService, useValue: {} },
        AdminService,
        { provide: AdminRepository, useValue: repo },
        { provide: InstructorsService, useValue: {} },
        { provide: MailerService, useValue: {} },
        { provide: DocumentOnboardingService, useValue: {} },
        { provide: BIO_TRANSLATOR, useValue: {} },
        { provide: AuditService, useValue: recordingAudit() },
        { provide: GoLiveService, useValue: goLive },
      ],
    }),
  );
}

const ids = (res: request.Response) =>
  (res.body as AdminInstructorListRecord[]).map((r) => r.id);
const newestFirst = (...ns: number[]) => ns.map(instructorId);
const range = (from: number, to: number) =>
  Array.from({ length: from - to + 1 }, (_, i) => from - i);

describe('GET /admin/instructors', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());
  const list = (query = '') =>
    http().get(`/admin/instructors${query}`).set('Authorization', admin);

  afterEach(async () => {
    await ctx.app.close();
  });

  it('needs an admin JWT', async () => {
    ctx = await build();
    await http().get('/admin/instructors').expect(401);
    await http()
      .get('/admin/instructors')
      .set('Authorization', INSTRUCTOR_AUTH)
      .expect(403);
    expect(ctx.repo.calls).toEqual([]);
  });

  it('returns every instructor, newest first, with the total when no page or limit is given', async () => {
    ctx = await build(120);
    const res = await list().expect(200);
    expect(ids(res)).toEqual(newestFirst(...range(120, 1)));
    expect(res.headers[TOTAL_COUNT_HEADER.toLowerCase()]).toBe('120');
    expect(ctx.repo.calls[0].page).toBeUndefined();
  });

  it('says whether each instructor has a calendar connected', async () => {
    ctx = await build(8);
    const res = await list('?page=1&limit=4').expect(200);
    const rows = res.body as AdminInstructorListRecord[];
    expect(rows.map((r) => [r.id, r.calendarConnected])).toEqual([
      [instructorId(8), true],
      [instructorId(7), false],
      [instructorId(6), false],
      [instructorId(5), false],
    ]);
    expect(rows[0]).not.toHaveProperty('instructor_calendars');
    expect(rows[0]).not.toHaveProperty('instructorCalendars');
  });

  it('returns every filtered instructor with the filtered total when unpaged', async () => {
    ctx = await build();
    const res = await list('?status=pending&active=false').expect(200);
    expect(ids(res)).toEqual(newestFirst(60, 45, 30, 15));
    expect(res.headers['x-total-count']).toBe('4');
  });

  it('narrows to instructors with a calendar connected, with the filtered total', async () => {
    ctx = await build(20);
    const res = await list('?calendarConnected=true').expect(200);
    expect(ids(res)).toEqual(newestFirst(20, 16, 12, 8, 4));
    expect(res.headers['x-total-count']).toBe('5');
    expect(
      (res.body as AdminInstructorListRecord[]).every(
        (r) => r.calendarConnected,
      ),
    ).toBe(true);
  });

  it('narrows to instructors without a calendar connected, with the filtered total', async () => {
    ctx = await build(10);
    const res = await list('?calendarConnected=false').expect(200);
    expect(ids(res)).toEqual(newestFirst(10, 9, 7, 6, 5, 3, 2, 1));
    expect(res.headers['x-total-count']).toBe('8');
    expect(ctx.repo.calls[0].filter).toEqual({ calendarConnected: false });
  });

  it('pages within the calendar filter combined with status, with the filtered total', async () => {
    ctx = await build();
    const res = await list(
      '?calendarConnected=false&status=pending&page=2&limit=5',
    ).expect(200);
    expect(ids(res)).toEqual(newestFirst(39, 33, 30, 27, 21));
    expect(res.headers['x-total-count']).toBe('15');
    expect(ctx.repo.calls[0]).toEqual({
      filter: { status: 'pending', calendarConnected: false },
      page: { limit: 5, offset: 5 },
    });
  });

  it('answers a calendar-filtered page past the end with no rows and the filtered total', async () => {
    ctx = await build();
    const res = await list('?calendarConnected=true&page=2&limit=20').expect(
      200,
    );
    expect(res.body).toEqual([]);
    expect(res.headers['x-total-count']).toBe('15');
  });

  it('defaults to 50 per page when only page is given', async () => {
    ctx = await build();
    const first = await list('?page=1').expect(200);
    expect(ids(first)).toEqual(newestFirst(...range(60, 11)));
    expect(first.headers['x-total-count']).toBe('60');
    const second = await list('?page=2').expect(200);
    expect(ids(second)).toEqual(newestFirst(...range(10, 1)));
    expect(second.headers['x-total-count']).toBe('60');
  });

  it('defaults to the first page when only limit is given', async () => {
    ctx = await build();
    const res = await list('?limit=5').expect(200);
    expect(ids(res)).toEqual(newestFirst(60, 59, 58, 57, 56));
    expect(res.headers['x-total-count']).toBe('60');
  });

  it('returns the requested slice for page and limit', async () => {
    ctx = await build();
    const res = await list('?page=3&limit=25').expect(200);
    expect(ids(res)).toEqual(newestFirst(...range(10, 1)));
    expect(res.headers['x-total-count']).toBe('60');
  });

  it('pages within status, active and q filters, with the filtered total', async () => {
    ctx = await build();
    const res = await list(
      '?status=approved&active=true&q=eric%20wang&page=2&limit=3',
    ).expect(200);
    expect(ids(res)).toEqual(newestFirst(46, 44, 38));
    expect(res.headers['x-total-count']).toBe('16');
    expect(ctx.repo.calls[0]).toEqual({
      filter: { status: 'approved', isActive: true, q: 'eric wang' },
      page: { limit: 3, offset: 3 },
    });
  });

  it('answers a page past the end with no rows and the real total', async () => {
    ctx = await build();
    const res = await list('?page=4&limit=20').expect(200);
    expect(res.body).toEqual([]);
    expect(res.headers['x-total-count']).toBe('60');
  });

  it('accepts the largest page and page size', async () => {
    ctx = await build();
    const res = await list('?page=10000&limit=100').expect(200);
    expect(res.body).toEqual([]);
    expect(ctx.repo.calls[0].page).toEqual({ limit: 100, offset: 999_900 });
  });

  it('returns each row with its stage, deriving stages for the page only', async () => {
    ctx = await build();
    const res = await list('?page=1&limit=3').expect(200);
    expect(
      (res.body as AdminInstructorListRecord[]).map((r) => [r.id, r.stage]),
    ).toEqual([
      [instructorId(60), stageOf(60)],
      [instructorId(59), stageOf(59)],
      [instructorId(58), stageOf(58)],
    ]);
    expect(ctx.goLive.calls).toEqual([newestFirst(60, 59, 58)]);
  });

  it('filters by several stages before paging, with the filtered total', async () => {
    ctx = await build();
    const wanted = (n: number) => ['live', 'in_review'].includes(stageOf(n));
    const matching = range(60, 1).filter(wanted);

    const first = await list('?stage=live,in_review&page=1&limit=5').expect(
      200,
    );
    const second = await list(
      '?stage=live&stage=in_review&page=2&limit=5',
    ).expect(200);

    expect(ids(first)).toEqual(newestFirst(...matching.slice(0, 5)));
    expect(ids(second)).toEqual(newestFirst(...matching.slice(5, 10)));
    expect(first.headers['x-total-count']).toBe(String(matching.length));
    expect(second.headers['x-total-count']).toBe(String(matching.length));
    expect(ctx.repo.calls[0]).toEqual({ filter: {}, page: undefined });
    expect(ctx.goLive.calls[0]).toHaveLength(60);
  });

  it('combines the stage filter with active, calendar and q', async () => {
    ctx = await build();
    const res = await list(
      '?stage=onboarding,deactivated&active=true&calendarConnected=false&q=jane&limit=50',
    ).expect(200);
    const matching = range(60, 1).filter(
      (n) =>
        ['onboarding', 'deactivated'].includes(stageOf(n)) &&
        n % 5 !== 0 &&
        n % 4 !== 0 &&
        n % 2 === 1,
    );
    expect(ids(res)).toEqual(newestFirst(...matching));
    expect(res.headers['x-total-count']).toBe(String(matching.length));
    expect(ctx.repo.calls[0]).toEqual({
      filter: { isActive: true, calendarConnected: false, q: 'jane' },
      page: undefined,
    });
  });

  it('answers a stage-filtered page past the end with no rows and the filtered total', async () => {
    ctx = await build();
    const res = await list('?stage=going_live&page=5&limit=50').expect(200);
    expect(res.body).toEqual([]);
    expect(res.headers['x-total-count']).toBe(
      String(range(60, 1).filter((n) => stageOf(n) === 'going_live').length),
    );
  });

  it('keeps the approval status filter working alongside stage', async () => {
    ctx = await build();
    const res = await list('?status=pending&stage=live').expect(200);
    const matching = range(60, 1).filter(
      (n) => n % 3 === 0 && stageOf(n) === 'live',
    );
    expect(ids(res)).toEqual(newestFirst(...matching));
    expect(ctx.repo.calls[0].filter).toEqual({ status: 'pending' });
  });

  it.each([
    'stage=held',
    'stage=live,published',
    'stage=approved',
    'page=0',
    'page=-1',
    'page=10001',
    'page=1.5',
    'page=abc',
    'limit=0',
    'limit=101',
    'limit=2.5',
    'limit=abc',
    'calendarConnected=yes',
    'calendarConnected=1',
    'calendarConnected=',
  ])('rejects %s with 400', async (query) => {
    ctx = await build();
    await list(`?${query}`).expect(400);
    expect(ctx.repo.calls).toEqual([]);
  });
});

describe('GET /admin/instructors/stage-counts', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const counts = () =>
    request(ctx.app.getHttpServer()).get('/admin/instructors/stage-counts');

  afterEach(async () => {
    await ctx.app.close();
  });

  it('needs an admin JWT', async () => {
    ctx = await build();
    await counts().expect(401);
    await counts().set('Authorization', INSTRUCTOR_AUTH).expect(403);
    expect(ctx.repo.calls).toEqual([]);
  });

  it('counts every instructor under its stage', async () => {
    ctx = await build(60);
    const res = await counts().set('Authorization', admin).expect(200);
    expect(res.body).toEqual(
      Object.fromEntries(
        INSTRUCTOR_STAGES.map((stage) => [
          stage,
          range(60, 1).filter((n) => stageOf(n) === stage).length,
        ]),
      ),
    );
    expect(ctx.repo.calls).toEqual([{ filter: {}, page: undefined }]);
    expect(ctx.goLive.calls[0]).toHaveLength(60);
  });
});

describe('GET /admin/instructors over a row-capped PostgREST', () => {
  const count = POSTGREST_MAX_ROWS + 1;
  const allLive = {
    stages: (instructorIds: readonly string[]) =>
      Promise.resolve(
        new Map<string, InstructorStage>(
          instructorIds.map((id) => [id, 'live']),
        ),
      ),
  };
  let app: Awaited<ReturnType<typeof startListApp>>;
  let requests: CappedRequest[];
  const get = (path: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', admin);

  beforeEach(async () => {
    const capped = cappedSupabase({
      instructors: Array.from({ length: count }, (_, i) => makeRow(i + 1)),
    });
    requests = capped.requests;
    app = await startListApp(
      new SupabaseAdminRepository(capped.client as never),
      allLive,
    );
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns every instructor past the response cap when unpaged', async () => {
    const res = await get('/admin/instructors').expect(200);

    expect(ids(res)).toEqual(newestFirst(...range(count, 1)));
    expect(res.headers['x-total-count']).toBe(String(count));
    expect(requests).toEqual([
      { table: 'instructors', range: [0, 999] },
      { table: 'instructors', range: [1000, 1999] },
    ]);
  });

  it('counts stages past the response cap', async () => {
    const res = await get('/admin/instructors/stage-counts').expect(200);

    expect(res.body).toEqual({
      pending: 0,
      rejected: 0,
      deactivated: 0,
      onboarding: 0,
      in_review: 0,
      going_live: 0,
      live: count,
    });
  });

  it('pages candidates past the response cap for the last page and the total', async () => {
    const res = await get(
      '/admin/instructors?stage=live&page=21&limit=50',
    ).expect(200);

    expect(ids(res)).toEqual([instructorId(1)]);
    expect(res.headers['x-total-count']).toBe(String(count));
    expect(requests).toEqual([
      { table: 'instructors', range: [0, 999] },
      { table: 'instructors', range: [1000, 1999] },
    ]);
  });
});
