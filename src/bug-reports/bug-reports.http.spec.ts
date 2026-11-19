import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { InMemoryBugReports } from '../../test/helpers/bug-reports-fakes';
import {
  ADMIN_AUTH,
  ADMIN_USER_ID,
  INSTRUCTOR_AUTH,
  INSTRUCTOR_USER_ID,
  InMemoryPrivateStorage,
  startDocumentsApp,
  UNVERIFIED_AUTH,
} from '../../test/helpers/documents-fakes';
import {
  FAKE_PORTAL_URL,
  flushBackground,
  RecordingMailer,
} from '../../test/helpers/mailer-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { PrivateStorageClient } from '../documents/private-storage.client';
import { MailerService } from '../mailer/mailer.service';
import { AdminBugReportsController } from './admin-bug-reports.controller';
import { BugReportsRepository } from './bug-reports.repository';
import {
  BUG_REPORT_CHANGED,
  BugReportsService,
  SCREENSHOT_INVALID,
  SCREENSHOT_LIMITED,
  SCREENSHOT_MISSING,
  SCREENSHOT_NOT_YOURS,
} from './bug-reports.service';
import type { BugReportDetail, BugReportItem } from './bug-reports.types';
import { MeBugReportsController } from './me-bug-reports.controller';

const OTHER_USER_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

describe('bug reports', () => {
  let app: INestApplication<App>;
  let reports: InMemoryBugReports;
  let storage: InMemoryPrivateStorage;
  let mailer: RecordingMailer;
  let audit: ReturnType<typeof recordingAudit>;
  const http = () => request(app.getHttpServer());

  async function start(env: Record<string, string> = {}): Promise<void> {
    reports = new InMemoryBugReports();
    reports.instructorNames.set(INSTRUCTOR_USER_ID, 'Ada Lovelace');
    storage = new InMemoryPrivateStorage();
    mailer = new RecordingMailer();
    audit = recordingAudit();
    app = await startDocumentsApp(
      Test.createTestingModule({
        controllers: [MeBugReportsController, AdminBugReportsController],
        providers: [
          BugReportsService,
          { provide: BugReportsRepository, useValue: reports },
          { provide: PrivateStorageClient, useValue: storage },
          { provide: MailerService, useValue: mailer.asService() },
          { provide: AuditService, useValue: audit },
          { provide: ConfigService, useValue: new ConfigService(env) },
        ],
      }),
    );
  }

  const submit = (body: object, auth = INSTRUCTOR_AUTH) =>
    http().post('/me/bug-reports').set('Authorization', auth).send(body);

  const screenshotUrl = (body: object, auth = INSTRUCTOR_AUTH) =>
    http()
      .post('/me/bug-reports/screenshot-url')
      .set('Authorization', auth)
      .send(body);

  const minimal = { description: 'Save does nothing', pageUrl: '/me' };

  async function uploadedScreenshot(): Promise<string> {
    const res = await screenshotUrl({
      contentType: 'image/png',
      contentLength: PNG.length,
    }).expect(200);
    const { key } = res.body as { key: string };
    storage.seed(key, PNG, 'image/png');
    return key;
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  describe('submitting', () => {
    beforeEach(() => start());

    it('stores a report without a screenshot and snapshots the reporter', async () => {
      const res = await submit({
        description: '  The save button does nothing\u0000\r\nat all\u202E  ',
        expected: '  It saves  ',
        severity: 'wrong',
        pageUrl: ' javascript:alert(1)\n',
        appVersion: '1.2.3',
        viewport: '390x844',
        userAgent: 'Mozilla/5.0\tTest',
      }).expect(201);

      const [row] = reports.rows;
      expect(res.body).toEqual({ id: row.id, createdAt: row.created_at });
      expect(row).toMatchObject({
        reporter_id: INSTRUCTOR_USER_ID,
        reporter_name: 'Ada Lovelace',
        reporter_email: 'instructor@example.com',
        reporter_role: 'instructor',
        description: 'The save button does nothing\nat all',
        expected: 'It saves',
        severity: 'wrong',
        page_url: 'javascript:alert(1)',
        app_version: '1.2.3',
        viewport: '390x844',
        user_agent: 'Mozilla/5.0 Test',
        screenshot_key: null,
        status: 'new',
      });
    });

    it('records an admin reporter by email when there is no instructor profile', async () => {
      await submit(minimal, ADMIN_AUTH).expect(201);

      expect(reports.rows[0]).toMatchObject({
        reporter_id: ADMIN_USER_ID,
        reporter_name: 'admin@example.com',
        reporter_role: 'admin',
        expected: null,
        severity: null,
      });
    });

    it('issues a presigned PUT under the caller prefix and accepts the uploaded screenshot', async () => {
      const res = await screenshotUrl({
        contentType: 'image/webp',
        contentLength: 2048,
      }).expect(200);
      const body = res.body as { uploadUrl: string; key: string };

      expect(body.key).toMatch(
        new RegExp(`^bug-reports/${INSTRUCTOR_USER_ID}/[0-9a-f-]{36}\\.webp$`),
      );
      expect(res.body).toEqual({
        uploadUrl: `memory://PUT/${body.key}`,
        key: body.key,
        expiresAt: expect.any(String) as string,
      });
      expect(storage.presigned).toEqual([
        {
          op: 'PUT',
          key: body.key,
          input: { contentType: 'image/webp', contentLength: 2048 },
        },
      ]);

      const key = await uploadedScreenshot();
      await submit({ ...minimal, screenshotKey: key }).expect(201);
      expect(reports.rows[0].screenshot_key).toBe(key);
    });

    it.each([
      ['a GIF', { contentType: 'image/gif', contentLength: 10 }],
      ['an empty file', { contentType: 'image/png', contentLength: 0 }],
      ['more than 3 MB', { contentType: 'image/png', contentLength: 3145729 }],
      ['no length', { contentType: 'image/png' }],
    ])('refuses a screenshot URL for %s', async (_label, body) => {
      await screenshotUrl(body).expect(400);
      expect(storage.presigned).toEqual([]);
    });

    it('accepts the bounds exactly', async () => {
      await screenshotUrl({
        contentType: 'image/jpeg',
        contentLength: 3145728,
      }).expect(200);
      await submit({
        description: 'd'.repeat(4000),
        expected: 'e'.repeat(2000),
        pageUrl: 'p'.repeat(500),
        appVersion: 'a'.repeat(64),
        viewport: 'v'.repeat(32),
        userAgent: 'u'.repeat(300),
      }).expect(201);
    });

    it.each([
      ['a missing description', { pageUrl: '/' }],
      ['a blank description', { description: ' \u0000 ', pageUrl: '/' }],
      ['a long description', { ...minimal, description: 'd'.repeat(4001) }],
      ['a long expectation', { ...minimal, expected: 'e'.repeat(2001) }],
      ['an unknown severity', { ...minimal, severity: 'urgent' }],
      ['a missing page URL', { description: 'x' }],
      ['a long page URL', { ...minimal, pageUrl: 'p'.repeat(501) }],
      ['a long app version', { ...minimal, appVersion: 'a'.repeat(65) }],
      ['a long viewport', { ...minimal, viewport: 'v'.repeat(33) }],
      ['a long user agent', { ...minimal, userAgent: 'u'.repeat(301) }],
      ['an unknown field', { ...minimal, status: 'resolved' }],
    ])('refuses %s with 400', async (_label, body) => {
      await submit(body).expect(400);
      expect(reports.rows).toEqual([]);
    });

    it.each([
      ['another user', `bug-reports/${OTHER_USER_ID}/${OTHER_USER_ID}.png`],
      [
        'a path that climbs out of the caller prefix',
        `bug-reports/${INSTRUCTOR_USER_ID}/../${OTHER_USER_ID}/${OTHER_USER_ID}.png`,
      ],
      ['another part of the bucket', `subjects/instructor/x/documents/y.pdf`],
    ])('refuses a screenshot key of %s', async (_label, key) => {
      storage.seed(key, PNG, 'image/png');

      const res = await submit({ ...minimal, screenshotKey: key }).expect(400);

      expect((res.body as { message: string }).message).toBe(
        SCREENSHOT_NOT_YOURS,
      );
      expect(reports.rows).toEqual([]);
    });

    it('refuses a screenshot that was never uploaded', async () => {
      const res = await screenshotUrl({
        contentType: 'image/png',
        contentLength: 10,
      });
      const { key } = res.body as { key: string };

      const refused = await submit({ ...minimal, screenshotKey: key });

      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toBe(
        SCREENSHOT_MISSING,
      );
    });

    it.each([
      ['not an image', Buffer.from('<svg/>'), 'image/svg+xml'],
      ['larger than 3 MB', Buffer.alloc(3145729), 'image/png'],
    ])('refuses an uploaded object that is %s', async (_label, body, type) => {
      const key = `bug-reports/${INSTRUCTOR_USER_ID}/${OTHER_USER_ID}.png`;
      storage.seed(key, body, type);

      const res = await submit({ ...minimal, screenshotKey: key }).expect(400);

      expect((res.body as { message: string }).message).toBe(
        SCREENSHOT_INVALID,
      );
    });

    it('limits each user to 10 reports an hour', async () => {
      for (let i = 0; i < 10; i++) {
        await submit(minimal).expect(201);
      }

      await submit(minimal).expect(429);
      await submit(minimal, ADMIN_AUTH).expect(201);
      reports.now += 61 * 60 * 1000;
      await submit(minimal).expect(201);
    });

    it('applies a ceiling across all reporters per minute', async () => {
      for (let i = 0; i < 30; i++) {
        reports.seed();
      }

      await submit(minimal).expect(429);
    });

    const pngUrl = (auth = INSTRUCTOR_AUTH) =>
      screenshotUrl({ contentType: 'image/png', contentLength: 3145728 }, auth);

    it('limits each user to 20 screenshot URLs an hour without limiting others', async () => {
      for (let i = 0; i < 20; i++) {
        await pngUrl().expect(200);
      }

      const res = await pngUrl().expect(429);

      expect((res.body as { message: string }).message).toBe(
        SCREENSHOT_LIMITED,
      );
      expect(storage.presigned).toHaveLength(20);
      await pngUrl(ADMIN_AUTH).expect(200);
      reports.now += 61 * 60 * 1000;
      await pngUrl().expect(200);
    });

    it('applies a ceiling of 90 screenshot URLs a minute across all users', async () => {
      for (let i = 0; i < 90; i++) {
        reports.screenshots.push({
          key: `bug-reports/${i}`,
          reporterId: randomUUID(),
          createdAt: reports.now,
        });
      }

      await pngUrl(ADMIN_AUTH).expect(429);
      reports.now += 61 * 1000;
      await pngUrl(ADMIN_AUTH).expect(200);
    });

    it('still accepts reports while screenshot URLs are limited', async () => {
      const key = await uploadedScreenshot();
      for (let i = 0; i < 19; i++) {
        await pngUrl().expect(200);
      }
      await pngUrl().expect(429);

      await submit({ ...minimal, screenshotKey: key }).expect(201);
      await submit(minimal).expect(201);
      expect(reports.rows.map((r) => r.screenshot_key)).toEqual([key, null]);
    });

    it('stops a flood of 100 screenshot URLs from one user at 20 and records each issued key', async () => {
      const statuses: number[] = [];
      const keys = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const res = await pngUrl();
        statuses.push(res.status);
        if (res.status === 200) {
          keys.add((res.body as { key: string }).key);
        }
      }

      expect(statuses.filter((s) => s === 200)).toHaveLength(20);
      expect(statuses.filter((s) => s === 429)).toHaveLength(80);
      expect(keys.size).toBe(20);
      expect(reports.screenshots.map((s) => s.key)).toEqual([...keys]);
      expect(reports.rows).toEqual([]);
    });

    it('needs a verified signed-in user', async () => {
      await http().post('/me/bug-reports').send(minimal).expect(401);
      await submit(minimal, UNVERIFIED_AUTH).expect(403);
      await screenshotUrl(
        { contentType: 'image/png', contentLength: 10 },
        UNVERIFIED_AUTH,
      ).expect(403);
    });

    it('sends no email when BUG_REPORT_EMAIL is unset', async () => {
      await submit(minimal).expect(201);
      await flushBackground();

      expect(mailer.sentText).toEqual([]);
    });
  });

  describe('email notification', () => {
    beforeEach(() => start({ BUG_REPORT_EMAIL: 'triage@example.com' }));

    it('emails a plain-text summary with a link to the report', async () => {
      const description = `Payroll page <b>crashes</b> when I open October ${'x'.repeat(80)}`;
      const res = await submit({
        description,
        expected: 'It shows <i>the period</i>',
        severity: 'blocked',
        pageUrl: '/payroll?period=oct',
      }).expect(201);
      await flushBackground();
      const { id } = res.body as { id: string };

      expect(mailer.sentText).toEqual([
        {
          kind: 'admin.bug_report',
          to: 'triage@example.com',
          subject: `[SSMS] blocked: ${description.slice(0, 60)}`,
          text: [
            description,
            '',
            'Expected:',
            'It shows <i>the period</i>',
            '',
            'Reporter: Ada Lovelace (instructor)',
            'Page: /payroll?period=oct',
            `Open: ${FAKE_PORTAL_URL}/admin/bug-reports/${id}`,
          ].join('\n'),
          metadata: { bugReportId: id },
        },
      ]);
    });

    it('keeps the subject on one line and labels reports without a severity', async () => {
      await submit({ description: 'Line one\nline two', pageUrl: '/' });
      await flushBackground();

      expect(mailer.sentText[0].subject).toBe(
        '[SSMS] report: Line one line two',
      );
    });

    it('still answers 201 when the email fails', async () => {
      mailer.outcome = 'failed';

      await submit(minimal).expect(201);
      await flushBackground();

      expect(reports.rows).toHaveLength(1);
      expect(mailer.sentText).toHaveLength(1);
    });
  });

  describe('admin triage', () => {
    beforeEach(() => start());

    const list = (query = '', auth = ADMIN_AUTH) =>
      http().get(`/admin/bug-reports${query}`).set('Authorization', auth);

    function seedAt(minutesAgo: number, status: BugReportItem['status']) {
      return reports.seed({
        created_at: new Date(reports.now - minutesAgo * 60_000).toISOString(),
        status,
      });
    }

    it('lists reports newest first with a total, filtered by status and paged', async () => {
      const oldest = seedAt(30, 'new');
      const resolved = seedAt(20, 'resolved');
      const middle = seedAt(10, 'new');
      const newest = seedAt(1, 'new');

      const all = await list().expect(200);
      expect((all.body as { total: number }).total).toBe(4);
      expect(
        (all.body as { items: BugReportItem[] }).items.map((i) => i.id),
      ).toEqual([newest.id, middle.id, resolved.id, oldest.id]);

      const page = await list('?status=new&limit=2&page=2').expect(200);
      expect(page.body).toEqual({
        items: [
          {
            id: oldest.id,
            createdAt: oldest.created_at,
            status: 'new',
            severity: null,
            description: 'Seeded report',
            expected: null,
            reporter: {
              id: oldest.reporter_id,
              name: 'Seeded Reporter',
              email: 'seeded@example.com',
              role: 'instructor',
            },
            pageUrl: '/',
            hasScreenshot: false,
          },
        ],
        total: 3,
      });
    });

    it('pages 25 reports by default', async () => {
      for (let i = 0; i < 30; i++) {
        seedAt(i, 'new');
      }

      const res = await list().expect(200);

      expect((res.body as { items: unknown[] }).items).toHaveLength(25);
    });

    it.each(['?status=done', '?limit=101', '?limit=0', '?page=0'])(
      'refuses %s with 400',
      async (query) => {
        await list(query).expect(400);
      },
    );

    it('shows a report with a 5-minute signed screenshot URL', async () => {
      const key = `bug-reports/${INSTRUCTOR_USER_ID}/${OTHER_USER_ID}.png`;
      const row = reports.seed({
        screenshot_key: key,
        app_version: '1.0.0',
        viewport: '1440x900',
        user_agent: 'UA',
      });

      const res = await http()
        .get(`/admin/bug-reports/${row.id}`)
        .set('Authorization', ADMIN_AUTH)
        .expect(200);

      expect(res.body).toMatchObject({
        id: row.id,
        hasScreenshot: true,
        appVersion: '1.0.0',
        viewport: '1440x900',
        userAgent: 'UA',
        adminNote: null,
        updatedAt: row.updated_at,
        screenshotUrl: `memory://GET/${key}`,
      });
      expect(storage.presigned).toEqual([{ op: 'GET', key, input: undefined }]);
    });

    it('shows a report without a screenshot with a null URL', async () => {
      const row = reports.seed();

      const res = await http()
        .get(`/admin/bug-reports/${row.id}`)
        .set('Authorization', ADMIN_AUTH)
        .expect(200);

      expect((res.body as BugReportDetail).screenshotUrl).toBeNull();
      expect(storage.presigned).toEqual([]);
    });

    it('answers 404 for an unknown report and 400 for a malformed id', async () => {
      await http()
        .get(`/admin/bug-reports/${OTHER_USER_ID}`)
        .set('Authorization', ADMIN_AUTH)
        .expect(404);
      await http()
        .get('/admin/bug-reports/nope')
        .set('Authorization', ADMIN_AUTH)
        .expect(400);
    });

    const patch = (id: string, body: object, auth = ADMIN_AUTH) =>
      http()
        .patch(`/admin/bug-reports/${id}`)
        .set('Authorization', auth)
        .send(body);

    it('changes the status and note and audits who changed what', async () => {
      const row = reports.seed();

      const res = await patch(row.id, {
        status: 'in_progress',
        adminNote: '  Looking into it  ',
      }).expect(200);

      expect(res.body).toMatchObject({
        id: row.id,
        status: 'in_progress',
        adminNote: 'Looking into it',
        screenshotUrl: null,
      });
      expect(audit.entries).toEqual([
        {
          action: 'bug_report.update',
          actor: { userId: ADMIN_USER_ID, role: 'admin', userAgent: null },
          targetType: 'bug_report',
          targetId: row.id,
          metadata: {
            fromStatus: 'new',
            toStatus: 'in_progress',
            adminNoteChanged: true,
          },
        },
      ]);
    });

    it('clears the note with an empty string and keeps the status', async () => {
      const row = reports.seed({ status: 'resolved', admin_note: 'Fixed' });

      const res = await patch(row.id, { adminNote: '' }).expect(200);

      expect(res.body).toMatchObject({ status: 'resolved', adminNote: null });
    });

    it.each([
      ['an empty body', {}],
      ['an unknown status', { status: 'done' }],
      ['a long note', { adminNote: 'n'.repeat(2001) }],
    ])('refuses %s with 400', async (_label, body) => {
      const row = reports.seed();

      await patch(row.id, body).expect(400);

      expect(audit.entries).toEqual([]);
    });

    it('answers 404 for an unknown report', async () => {
      await patch(OTHER_USER_ID, { status: 'resolved' }).expect(404);
    });

    it('answers 409 when the status changed since it was read', async () => {
      const row = reports.seed();
      jest.spyOn(reports, 'update').mockResolvedValueOnce(null);

      const res = await patch(row.id, { status: 'resolved' }).expect(409);

      expect((res.body as { message: string }).message).toBe(
        BUG_REPORT_CHANGED,
      );
      expect(audit.entries).toEqual([]);
    });

    it('refuses instructors on every admin route', async () => {
      const row = reports.seed();

      await list('', INSTRUCTOR_AUTH).expect(403);
      await http()
        .get(`/admin/bug-reports/${row.id}`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(403);
      await patch(row.id, { status: 'resolved' }, INSTRUCTOR_AUTH).expect(403);
      expect(row.status).toBe('new');
    });
  });
});
