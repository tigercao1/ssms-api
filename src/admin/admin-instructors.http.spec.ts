import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH as admin,
  INSTRUCTOR_AUTH,
  startAdminApp,
} from '../../test/helpers/admin-http';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { BIO_TRANSLATOR } from '../bio-translation/bio-translator.interface';
import { TOTAL_COUNT_HEADER } from '../config/cors';
import type { PageRequest, RowPage } from '../database/pagination';
import { DocumentOnboardingService } from '../documents/document-onboarding.service';
import { InstructorsService } from '../instructors/instructors.service';
import { MailerService } from '../mailer/mailer.service';
import { SeasonsService } from '../seasons/seasons.service';
import { AdminController } from './admin.controller';
import { AdminRepository } from './admin.repository';
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
}

async function build(count = 60) {
  const repo = new InMemoryInstructorList();
  repo.rows = Array.from({ length: count }, (_, i) => makeRow(i + 1));
  const app = await startAdminApp(
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
      ],
    }),
  );
  return { app, repo };
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

  it.each([
    'page=0',
    'page=-1',
    'page=10001',
    'page=1.5',
    'page=abc',
    'limit=0',
    'limit=101',
    'limit=2.5',
    'limit=abc',
  ])('rejects %s with 400', async (query) => {
    ctx = await build();
    await list(`?${query}`).expect(400);
    expect(ctx.repo.calls).toEqual([]);
  });
});
