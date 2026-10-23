import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  InMemoryCertificationUploadsRepository,
  POSTGREST_MAX_ROWS,
} from '../../test/helpers/certification-fakes';
import {
  ADMIN_AUTH as admin,
  certificationUploadRow,
  INSTRUCTOR_AUTH,
  INSTRUCTOR_USER_ID,
  InMemoryDocumentSubjectsRepository,
  InMemoryPrivateStorage,
  startDocumentsApp,
} from '../../test/helpers/documents-fakes';
import { RecordingMailer } from '../../test/helpers/mailer-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { TOTAL_COUNT_HEADER } from '../config/cors';
import { MailerService } from '../mailer/mailer.service';
import { AdminCertificationUploadsController } from './admin-certification-uploads.controller';
import { AdminCertificationUploadsService } from './admin-certification-uploads.service';
import { AdminDocumentReviewsController } from './admin-document-reviews.controller';
import {
  AdminDocumentReviewsService,
  DECIDED_REVIEW_WINDOW_DAYS,
} from './admin-document-reviews.service';
import { CertificationUploadsRepository } from './certification-uploads.repository';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import type { DocumentReviewItem } from './document-reviews.types';
import type { CertOrg, CertTrack } from './documents.types';
import { DOCUMENT_REVIEWS_DEFAULT_LIMIT } from './dto/document-review.dto';
import { PrivateStorageClient } from './private-storage.client';

const DAY_MS = 24 * 60 * 60 * 1000;
const KEYS: [CertOrg, CertTrack][] = [
  ['csia', 'regular'],
  ['csia', 'park'],
  ['csia', 'carving'],
  ['casi', 'regular'],
  ['casi', 'park'],
  ['casi', 'carving'],
];
const daysAgo = (days: number) =>
  new Date(Date.now() - days * DAY_MS).toISOString();

async function build() {
  const storage = new InMemoryPrivateStorage();
  const subjects = new InMemoryDocumentSubjectsRepository();
  const uploads = new InMemoryCertificationUploadsRepository(subjects);
  const audit = recordingAudit();
  const mailer = new RecordingMailer();
  const app = await startDocumentsApp(
    Test.createTestingModule({
      controllers: [
        AdminDocumentReviewsController,
        AdminCertificationUploadsController,
      ],
      providers: [
        AdminDocumentReviewsService,
        AdminCertificationUploadsService,
        { provide: PrivateStorageClient, useValue: storage },
        { provide: DocumentSubjectsRepository, useValue: subjects },
        { provide: CertificationUploadsRepository, useValue: uploads },
        { provide: AuditService, useValue: audit },
        { provide: MailerService, useValue: mailer.asService() },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }),
  );
  const instructor = subjects.seedInstructor({
    auth_user_id: INSTRUCTOR_USER_ID,
    first_name: 'Eddie',
    last_name: 'Edwards',
    display_name_en: 'Eddie E.',
  });
  subjects.certifications.set(instructor.id, [
    { org: 'csia', track: 'regular', level: 2 },
  ]);
  return { app, subjects, uploads, audit, mailer, instructor };
}

type Ctx = Awaited<ReturnType<typeof build>>;

describe('GET /admin/document-reviews', () => {
  let ctx: Ctx;
  const http = () => request(ctx.app.getHttpServer());

  beforeEach(async () => {
    ctx = await build();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  async function page(query = '') {
    const res = await http()
      .get(`/admin/document-reviews${query}`)
      .set('Authorization', admin)
      .expect(200);
    return {
      ids: (res.body as DocumentReviewItem[]).map((i) => i.id),
      total: res.headers[TOTAL_COUNT_HEADER.toLowerCase()],
    };
  }

  async function list(query = ''): Promise<DocumentReviewItem[]> {
    const res = await http()
      .get(`/admin/document-reviews${query}`)
      .set('Authorization', admin)
      .expect(200);
    return res.body as DocumentReviewItem[];
  }

  function seedUpload(
    overrides: Parameters<typeof certificationUploadRow>[0] = {
      instructor_id: ctx.instructor.id,
    },
  ) {
    const row = certificationUploadRow(overrides);
    ctx.subjects.uploads.push(row);
    return row;
  }

  it('401s without a token and 403s for a non-admin', async () => {
    await http().get('/admin/document-reviews').expect(401);
    await http()
      .get('/admin/document-reviews')
      .set('Authorization', INSTRUCTOR_AUTH)
      .expect(403);
  });

  it('400s on an unknown status filter', async () => {
    await http()
      .get('/admin/document-reviews?status=all')
      .set('Authorization', admin)
      .expect(400);
  });

  it('lists current pending certification uploads, oldest first, with the instructor and declared level', async () => {
    const other = ctx.subjects.seedInstructor({
      email: 'olive@example.com',
      display_name_en: 'Olive',
    });
    const first = seedUpload({
      instructor_id: ctx.instructor.id,
      review_status: 'pending',
      content_type: 'image/jpeg',
    });
    const second = seedUpload({
      instructor_id: other.id,
      org: 'casi',
      track: 'park',
      review_status: 'pending',
    });
    seedUpload({
      instructor_id: ctx.instructor.id,
      org: 'casi',
      review_status: 'approved',
    });

    const items = await list();

    expect(items.map((i) => i.id)).toEqual([first.id, second.id]);
    expect(items[0]).toEqual({
      type: 'certification_upload',
      id: first.id,
      instructor: {
        id: ctx.instructor.id,
        email: 'eddie@example.com',
        firstName: 'Eddie',
        lastName: 'Edwards',
        displayNameEn: 'Eddie E.',
        displayNameZh: null,
      },
      submittedAt: first.inserted_at,
      reviewStatus: 'pending',
      reviewNote: null,
      reviewedAt: null,
      contentType: 'image/jpeg',
      certificationUpload: expect.objectContaining({
        id: first.id,
        org: 'csia',
        track: 'regular',
        reviewStatus: 'pending',
        current: true,
        validUntil: first.valid_until,
      }) as unknown,
      level: 2,
    });
    expect(items[1].level).toBeNull();
    await expect(list('?status=pending')).resolves.toEqual(items);
  });

  it('leaves out a pending upload superseded by a newer one', async () => {
    seedUpload({ instructor_id: ctx.instructor.id, review_status: 'pending' });
    const newer = seedUpload({
      instructor_id: ctx.instructor.id,
      review_status: 'pending',
    });

    expect((await list()).map((i) => i.id)).toEqual([newer.id]);
  });

  it('reviews the queued upload as current when two share an inserted_at', async () => {
    const insertedAt = daysAgo(1);
    const seedTied = (id: string) =>
      seedUpload({
        id,
        instructor_id: ctx.instructor.id,
        review_status: 'pending',
        inserted_at: insertedAt,
      }).id;
    seedTied('00000000-0000-4000-8000-000000000001');
    const higher = seedTied('00000000-0000-4000-8000-000000000002');

    expect((await list()).map((i) => i.id)).toEqual([higher]);
    const res = await http()
      .patch(`/admin/certification-uploads/${higher}`)
      .set('Authorization', admin)
      .send({ reviewStatus: 'approved' })
      .expect(200);
    expect(res.body).toEqual(
      expect.objectContaining({ id: higher, current: true }),
    );
  });

  it('returns an empty queue', async () => {
    await expect(list()).resolves.toEqual([]);
    await expect(list('?status=decided')).resolves.toEqual([]);
  });

  it('lists recent decisions newest first, flagging superseded uploads', async () => {
    const rejected = seedUpload({
      instructor_id: ctx.instructor.id,
      review_status: 'rejected',
      review_note: 'Blurry',
      reviewed_at: daysAgo(2),
    });
    const approved = seedUpload({
      instructor_id: ctx.instructor.id,
      review_status: 'approved',
      reviewed_at: daysAgo(1),
    });
    seedUpload({
      instructor_id: ctx.instructor.id,
      org: 'casi',
      review_status: 'approved',
      reviewed_at: daysAgo(DECIDED_REVIEW_WINDOW_DAYS + 1),
    });
    seedUpload({ instructor_id: ctx.instructor.id, review_status: 'pending' });

    const items = await list('?status=decided');

    expect(items.map((i) => [i.id, i.reviewStatus, i.reviewNote])).toEqual([
      [approved.id, 'approved', null],
      [rejected.id, 'rejected', 'Blurry'],
    ]);
    expect(items.map((i) => i.certificationUpload.current)).toEqual([
      false,
      false,
    ]);
  });

  it.each([
    ['?limit=101'],
    ['?limit=0'],
    ['?page=0'],
    ['?page=x'],
    ['?status=decided&limit=1.5'],
  ])('400s on %s', async (query) => {
    await http()
      .get(`/admin/document-reviews${query}`)
      .set('Authorization', admin)
      .expect(400);
  });

  it(`pages with page and limit, defaulting to ${DOCUMENT_REVIEWS_DEFAULT_LIMIT}, and reports the total past the end`, async () => {
    const instructors = Array.from({ length: 10 }, (_, i) =>
      ctx.subjects.seedInstructor({ email: `coach${i}@example.com` }),
    );
    const seeded = instructors.flatMap((instructor) =>
      KEYS.map(([org, track]) =>
        seedUpload({
          instructor_id: instructor.id,
          org,
          track,
          review_status: 'pending',
        }),
      ),
    );
    const ids = seeded.map((row) => row.id);

    await expect(page()).resolves.toEqual({
      ids: ids.slice(0, DOCUMENT_REVIEWS_DEFAULT_LIMIT),
      total: '60',
    });
    await expect(page('?page=2')).resolves.toEqual({
      ids: ids.slice(DOCUMENT_REVIEWS_DEFAULT_LIMIT),
      total: '60',
    });
    await expect(page('?status=pending&page=3&limit=20')).resolves.toEqual({
      ids: ids.slice(40),
      total: '60',
    });
    await expect(page('?page=9&limit=20')).resolves.toEqual({
      ids: [],
      total: '60',
    });
    await expect(page('?status=decided')).resolves.toEqual({
      ids: [],
      total: '0',
    });
    expect(ctx.uploads.reviewQueries.slice(0, 2)).toEqual([
      expect.objectContaining({
        status: 'pending',
        limit: DOCUMENT_REVIEWS_DEFAULT_LIMIT,
        offset: 0,
      }),
      expect.objectContaining({
        status: 'pending',
        limit: DOCUMENT_REVIEWS_DEFAULT_LIMIT,
        offset: DOCUMENT_REVIEWS_DEFAULT_LIMIT,
      }),
    ]);
  });

  it('breaks ties on the submitted and decided times by id', async () => {
    const other = ctx.subjects.seedInstructor({ email: 'olive@example.com' });
    const at = '2026-10-10T12:00:00.000Z';
    const pending = [ctx.instructor.id, other.id]
      .map((instructorId) =>
        seedUpload({
          instructor_id: instructorId,
          review_status: 'pending',
          inserted_at: at,
        }),
      )
      .map((row) => row.id)
      .sort();
    const decidedAt = daysAgo(1);
    const decided = [ctx.instructor.id, other.id]
      .map((instructorId) =>
        seedUpload({
          instructor_id: instructorId,
          org: 'casi',
          review_status: 'approved',
          reviewed_at: decidedAt,
        }),
      )
      .map((row) => row.id)
      .sort();

    await expect(page()).resolves.toEqual({ ids: pending, total: '2' });
    await expect(page('?limit=1&page=2')).resolves.toEqual({
      ids: [pending[1]],
      total: '2',
    });
    await expect(page('?status=decided')).resolves.toEqual({
      ids: decided,
      total: '2',
    });
  });

  it(`pages past ${POSTGREST_MAX_ROWS} rows with the right total, order and current uploads`, async () => {
    const instructors = Array.from({ length: 200 }, (_, i) =>
      ctx.subjects.seedInstructor({ email: `coach${i}@example.com` }),
    );
    const superseded = new Set(
      instructors.slice(0, 50).flatMap((instructor) =>
        KEYS.map(
          ([org, track]) =>
            seedUpload({
              instructor_id: instructor.id,
              org,
              track,
              review_status: 'pending',
            }).id,
        ),
      ),
    );
    const current = instructors.flatMap((instructor) =>
      KEYS.map(
        ([org, track]) =>
          seedUpload({
            instructor_id: instructor.id,
            org,
            track,
            review_status: 'pending',
          }).id,
      ),
    );
    expect(current.length + superseded.size).toBeGreaterThan(
      POSTGREST_MAX_ROWS,
    );
    expect(current.length).toBeGreaterThan(POSTGREST_MAX_ROWS);

    const seen: string[] = [];
    for (let n = 1; n <= 13; n += 1) {
      const { ids, total } = await page(`?page=${n}&limit=100`);
      expect(total).toBe(String(current.length));
      seen.push(...ids);
    }
    expect(seen).toEqual(current);
    expect(seen.some((id) => superseded.has(id))).toBe(false);
    expect(ctx.uploads.reviewQueries.every((q) => q.limit <= 100)).toBe(true);
  });

  it(`pages past ${POSTGREST_MAX_ROWS} recent decisions, newest first`, async () => {
    const decided = Array.from(
      { length: POSTGREST_MAX_ROWS + 100 },
      (_, i) =>
        seedUpload({
          instructor_id: ctx.instructor.id,
          review_status: i % 2 ? 'rejected' : 'approved',
          reviewed_at: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
        }).id,
    );

    await expect(page('?status=decided&page=11&limit=100')).resolves.toEqual({
      ids: decided.slice(1000),
      total: String(decided.length),
    });
    await expect(page('?status=decided&page=12&limit=100')).resolves.toEqual({
      ids: [],
      total: String(decided.length),
    });
  });

  it('moves an item from pending to decided once reviewed through the certification review endpoint', async () => {
    const row = seedUpload({
      instructor_id: ctx.instructor.id,
      review_status: 'pending',
    });

    await http()
      .patch(`/admin/certification-uploads/${row.id}`)
      .set('Authorization', admin)
      .send({ reviewStatus: 'rejected', reviewNote: 'Expired card' })
      .expect(200);

    await expect(list()).resolves.toEqual([]);
    expect(await list('?status=decided')).toEqual([
      expect.objectContaining({
        id: row.id,
        reviewStatus: 'rejected',
        reviewNote: 'Expired card',
        reviewedAt: expect.any(String) as unknown,
      }),
    ]);
    expect(ctx.audit.entries.map((e) => e.action)).toEqual([
      'certification_upload.review',
      'certification_upload.file_delete',
    ]);
  });
});
