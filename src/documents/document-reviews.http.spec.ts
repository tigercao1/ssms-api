import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { InMemoryCertificationUploadsRepository } from '../../test/helpers/certification-fakes';
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
import { MailerService } from '../mailer/mailer.service';
import { AdminCertificationUploadsController } from './admin-certification-uploads.controller';
import { AdminCertificationUploadsService } from './admin-certification-uploads.service';
import { AdminDocumentReviewsController } from './admin-document-reviews.controller';
import {
  AdminDocumentReviewsService,
  DECIDED_REVIEW_LIMIT,
  DECIDED_REVIEW_WINDOW_DAYS,
} from './admin-document-reviews.service';
import { CertificationUploadsRepository } from './certification-uploads.repository';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import type { DocumentReviewItem } from './document-reviews.types';
import { PrivateStorageClient } from './private-storage.client';

const DAY_MS = 24 * 60 * 60 * 1000;
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
  return { app, subjects, audit, mailer, instructor };
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

  it(`caps recent decisions at ${DECIDED_REVIEW_LIMIT}`, async () => {
    for (let i = 0; i <= DECIDED_REVIEW_LIMIT; i += 1) {
      seedUpload({
        instructor_id: ctx.instructor.id,
        review_status: 'approved',
        reviewed_at: daysAgo(1),
      });
    }

    expect(await list('?status=decided')).toHaveLength(DECIDED_REVIEW_LIMIT);
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
