import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  FILE_SAMPLES,
  InMemoryCertificationUploadsRepository,
} from '../../test/helpers/certification-fakes';
import {
  ADMIN_AUTH as admin,
  ADMIN_USER_ID,
  certificationUploadRow,
  INSTRUCTOR_AUTH,
  INSTRUCTOR_USER_ID,
  InMemoryDocumentAssignmentsRepository,
  InMemoryDocumentSubjectsRepository,
  InMemoryDocumentTemplatesRepository,
  InMemoryPrivateStorage,
  startDocumentsApp,
  UNVERIFIED_AUTH,
} from '../../test/helpers/documents-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { AdminCertificationUploadsController } from './admin-certification-uploads.controller';
import { AdminCertificationUploadsService } from './admin-certification-uploads.service';
import { AdminDocumentAssignmentsController } from './admin-document-assignments.controller';
import { MAX_CERTIFICATION_BYTES } from './certification-files';
import {
  CertificationUploadsRepository,
  type NewCertificationUploadRow,
} from './certification-uploads.repository';
import { addDays, torontoToday } from './certification-validity';
import { DocumentAssignmentsRepository } from './document-assignments.repository';
import { DocumentAssignmentsService } from './document-assignments.service';
import { DocumentNotificationsService } from './document-notifications.service';
import { DocumentSigningService } from './document-signing.service';
import { DocumentSubjectsRepository } from './document-subjects.repository';
import { DocumentTemplatesRepository } from './document-templates.repository';
import type {
  CertificationChecklistItem,
  CertificationUploadRow,
  Checklist,
  InstructorDocuments,
} from './documents.types';
import { MeCertificationUploadsController } from './me-certification-uploads.controller';
import {
  CERTIFICATION_FILE_MISMATCH,
  CERTIFICATION_FILE_MISSING,
  CERTIFICATION_FILE_TOO_LARGE,
  CERTIFICATION_UPLOAD_NOT_FOUND,
  MeCertificationUploadsService,
  NO_MATCHING_CERTIFICATION,
  VALID_UNTIL_IN_PAST,
} from './me-certification-uploads.service';
import { MeDocumentsController } from './me-documents.controller';
import { MeDocumentsService, PENDING_APPROVAL } from './me-documents.service';
import {
  ObjectTooLargeError,
  PrivateStorageClient,
} from './private-storage.client';
import { storageKeys } from './storage-keys';

const anyString: unknown = expect.any(String);
const messageOf = (res: request.Response) =>
  (res.body as { message: string }).message;
const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const PDF = FILE_SAMPLES['application/pdf'];
const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

async function build() {
  const storage = new InMemoryPrivateStorage();
  const templates = new InMemoryDocumentTemplatesRepository();
  const assignments = new InMemoryDocumentAssignmentsRepository(templates);
  const subjects = new InMemoryDocumentSubjectsRepository();
  const uploads = new InMemoryCertificationUploadsRepository(subjects);
  const audit = recordingAudit();
  const app = await startDocumentsApp(
    Test.createTestingModule({
      controllers: [
        MeDocumentsController,
        MeCertificationUploadsController,
        AdminCertificationUploadsController,
        AdminDocumentAssignmentsController,
      ],
      providers: [
        MeDocumentsService,
        MeCertificationUploadsService,
        AdminCertificationUploadsService,
        DocumentAssignmentsService,
        { provide: DocumentNotificationsService, useValue: {} },
        { provide: DocumentSigningService, useValue: {} },
        { provide: PrivateStorageClient, useValue: storage },
        { provide: DocumentTemplatesRepository, useValue: templates },
        { provide: DocumentAssignmentsRepository, useValue: assignments },
        { provide: DocumentSubjectsRepository, useValue: subjects },
        { provide: CertificationUploadsRepository, useValue: uploads },
        { provide: AuditService, useValue: audit },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }),
  );
  const instructor = subjects.seedInstructor({
    auth_user_id: INSTRUCTOR_USER_ID,
  });
  subjects.certifications.set(instructor.id, [
    { org: 'csia', track: 'regular', level: 2 },
    { org: 'casi', track: 'park', level: 1 },
  ]);
  return { app, storage, subjects, uploads, audit, instructor };
}

type Ctx = Awaited<ReturnType<typeof build>>;

const today = () => torontoToday();

function uploadBody(overrides: Record<string, unknown> = {}) {
  return {
    org: 'csia',
    track: 'regular',
    validUntil: addDays(today(), 200),
    contentType: 'application/pdf',
    contentLength: PDF.length,
    ...overrides,
  };
}

describe('certification uploads over HTTP', () => {
  let ctx: Ctx;
  const http = () => request(ctx.app.getHttpServer());

  beforeEach(async () => {
    ctx = await build();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ctx.app.close();
  });

  async function presign(overrides: Record<string, unknown> = {}) {
    const res = await http()
      .post('/me/certification-uploads/upload-url')
      .set('Authorization', INSTRUCTOR_AUTH)
      .send(uploadBody(overrides))
      .expect(200);
    return res.body as {
      uploadId: string;
      uploadUrl: string;
      expiresAt: string;
    };
  }

  function stagingKey(uploadId: string, ext = 'pdf') {
    return storageKeys.instructorCertificationStaging(
      ctx.instructor.id,
      uploadId,
      ext,
    );
  }

  function finalKey(uploadId: string, bytes: Buffer = PDF, ext = 'pdf') {
    return storageKeys.instructorCertification(
      ctx.instructor.id,
      uploadId,
      sha256(bytes),
      ext,
    );
  }

  function confirmedObjectKeys() {
    return [...ctx.storage.objects.keys()].filter(
      (key) => key.includes('/certifications/') && !key.includes('/staging/'),
    );
  }

  function stageFailingRead(
    key: string,
    outcome: () => Promise<Buffer | null>,
  ) {
    const getBuffer = ctx.storage.getBuffer.bind(ctx.storage) as (
      key: string,
      maxBytes: number,
    ) => Promise<Buffer | null>;
    jest
      .spyOn(ctx.storage, 'getBuffer')
      .mockImplementation((k: string, maxBytes: number) =>
        k === key ? outcome() : getBuffer(k, maxBytes),
      );
  }

  async function uploadAndConfirm(
    overrides: Record<string, unknown> = {},
    bytes: Buffer = PDF,
  ) {
    const { uploadId } = await presign({
      contentLength: bytes.length,
      ...overrides,
    });
    const type = (overrides.contentType as string) ?? 'application/pdf';
    const ext = { 'application/pdf': 'pdf', 'image/png': 'png' }[type] ?? 'jpg';
    ctx.storage.seed(stagingKey(uploadId, ext), bytes, type);
    const res = await http()
      .post(`/me/certification-uploads/${uploadId}/confirm`)
      .set('Authorization', INSTRUCTOR_AUTH)
      .expect(200);
    return res.body as { id: string; [key: string]: unknown };
  }

  async function certItems(): Promise<CertificationChecklistItem[]> {
    const res = await http()
      .get('/me/documents')
      .set('Authorization', INSTRUCTOR_AUTH)
      .expect(200);
    return (res.body as Checklist).items.filter(
      (i): i is CertificationChecklistItem => i.type === 'certification',
    );
  }

  describe('auth', () => {
    const sample = () => ctx.subjects.uploads[0]?.id ?? UNKNOWN_ID;
    const instructorRoutes: [string, () => request.Test][] = [
      [
        'POST /me/certification-uploads/upload-url',
        () =>
          http()
            .post('/me/certification-uploads/upload-url')
            .send(uploadBody()),
      ],
      [
        'POST /me/certification-uploads/:uploadId/confirm',
        () => http().post(`/me/certification-uploads/${UNKNOWN_ID}/confirm`),
      ],
    ];
    const adminRoutes: [string, () => request.Test][] = [
      [
        'GET /admin/certification-uploads/:id/url',
        () => http().get(`/admin/certification-uploads/${sample()}/url`),
      ],
      [
        'PATCH /admin/certification-uploads/:id',
        () =>
          http()
            .patch(`/admin/certification-uploads/${sample()}`)
            .send({ reviewStatus: 'approved' }),
      ],
    ];

    it.each([...instructorRoutes, ...adminRoutes])(
      '%s → 401 without a token',
      async (_name, send) => {
        await send().expect(401);
      },
    );

    it.each(instructorRoutes)(
      '%s → 403 with an unverified email',
      async (_name, send) => {
        await send().set('Authorization', UNVERIFIED_AUTH).expect(403);
      },
    );

    it.each(instructorRoutes)(
      '%s → 404 without an instructor row',
      async (_name, send) => {
        ctx.subjects.instructors.clear();
        await send().set('Authorization', INSTRUCTOR_AUTH).expect(404);
      },
    );

    it.each(adminRoutes)('%s → 403 for a non-admin', async (_name, send) => {
      ctx.subjects.uploads.push(
        certificationUploadRow({ instructor_id: ctx.instructor.id }),
      );
      await send().set('Authorization', INSTRUCTOR_AUTH).expect(403);
    });
  });

  describe('pending approval', () => {
    it.each(['pending', 'rejected'])(
      '403s upload-url and confirm for a %s instructor',
      async (approval) => {
        const { uploadId } = await presign();
        ctx.storage.seed(stagingKey(uploadId), PDF, 'application/pdf');
        ctx.subjects.instructors.set(ctx.instructor.id, {
          ...ctx.instructor,
          approval_status: approval,
        });
        const expected = {
          message: PENDING_APPROVAL,
          reason: 'pending_approval',
        };
        await http()
          .post('/me/certification-uploads/upload-url')
          .set('Authorization', INSTRUCTOR_AUTH)
          .send(uploadBody())
          .expect(403, expected);
        await http()
          .post(`/me/certification-uploads/${uploadId}/confirm`)
          .set('Authorization', INSTRUCTOR_AUTH)
          .expect(403, expected);
        expect(ctx.subjects.uploads).toHaveLength(0);
      },
    );
  });

  describe('POST /me/certification-uploads/upload-url', () => {
    it('issues an upload id and a presigned PUT to a staging key under the instructor prefix', async () => {
      const validUntil = today();
      const body = await presign({ validUntil, contentType: 'IMAGE/PNG' });
      expect(body.uploadId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.uploadUrl).toBe(
        `memory://PUT/${stagingKey(body.uploadId, 'png')}`,
      );
      expect(ctx.storage.presigned.at(-1)).toEqual({
        op: 'PUT',
        key: stagingKey(body.uploadId, 'png'),
        input: { contentType: 'image/png', contentLength: PDF.length },
      });
      expect(ctx.subjects.uploads).toHaveLength(0);
      const intent = ctx.storage.objects.get(
        storageKeys.instructorCertificationIntent(
          ctx.instructor.id,
          body.uploadId,
        ),
      );
      expect(JSON.parse(intent!.body.toString())).toMatchObject({
        uploadId: body.uploadId,
        instructorId: ctx.instructor.id,
        org: 'csia',
        track: 'regular',
        validUntil,
      });
    });

    it.each([
      [
        'validUntil yesterday',
        { validUntil: addDays(torontoToday(), -1) },
        VALID_UNTIL_IN_PAST,
      ],
      [
        'a cert the instructor does not hold',
        { org: 'casi', track: 'regular' },
        NO_MATCHING_CERTIFICATION,
      ],
    ])('rejects %s', async (_name, overrides, message) => {
      const res = await http()
        .post('/me/certification-uploads/upload-url')
        .set('Authorization', INSTRUCTOR_AUTH)
        .send(uploadBody(overrides))
        .expect(400);
      expect(messageOf(res)).toBe(message);
    });

    it.each([
      ['an unknown org', { org: 'pssa' }],
      ['an unknown track', { track: 'mogul' }],
      ['a datetime', { validUntil: '2030-01-01T00:00:00Z' }],
      ['an impossible date', { validUntil: '2030-02-30' }],
      ['a gif', { contentType: 'image/gif' }],
      ['an empty file', { contentLength: 0 }],
      ['a file over 10 MB', { contentLength: MAX_CERTIFICATION_BYTES + 1 }],
      ['an extra field', { instructorId: UNKNOWN_ID }],
    ])('rejects %s', async (_name, overrides) => {
      await http()
        .post('/me/certification-uploads/upload-url')
        .set('Authorization', INSTRUCTOR_AUTH)
        .send(uploadBody(overrides))
        .expect(400);
    });

    it('accepts exactly 10 MB', async () => {
      await presign({ contentLength: MAX_CERTIFICATION_BYTES });
    });
  });

  describe('POST /me/certification-uploads/:uploadId/confirm', () => {
    it('hashes the file, copies it to the final key, records a pending upload and drops the staged objects', async () => {
      const validUntil = addDays(today(), 120);
      const upload = await uploadAndConfirm({ validUntil });
      expect(upload).toMatchObject({
        instructorId: ctx.instructor.id,
        org: 'csia',
        track: 'regular',
        contentType: 'application/pdf',
        sizeBytes: PDF.length,
        sha256: sha256(PDF),
        reviewStatus: 'pending',
        validUntil,
        current: true,
        state: 'pending',
      });
      const [row] = ctx.subjects.uploads;
      expect(row.id).toBe(upload.id);
      expect(row.file_key).toBe(finalKey(upload.id));
      expect(ctx.storage.deleted).toEqual([
        stagingKey(upload.id),
        storageKeys.instructorCertificationIntent(ctx.instructor.id, upload.id),
      ]);
      expect(ctx.storage.objects.get(finalKey(upload.id))).toEqual({
        body: PDF,
        contentType: 'application/pdf',
      });
      expect(ctx.storage.objects.has(stagingKey(upload.id))).toBe(false);
    });

    it('keeps the reviewed file when the upload URL is reused after confirm', async () => {
      const upload = await uploadAndConfirm();
      const replacement = Buffer.concat([
        Buffer.from('%PDF-'),
        Buffer.alloc(PDF.length - 5, 0x42),
      ]);
      ctx.storage.seed(stagingKey(upload.id), replacement);
      const again = await http()
        .post(`/me/certification-uploads/${upload.id}/confirm`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200);
      expect(again.body).toEqual(upload);
      const res = await http()
        .get(`/admin/certification-uploads/${upload.id}/url`)
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toMatchObject({
        url: `memory://GET/${finalKey(upload.id)}`,
        sha256: sha256(PDF),
      });
      expect(ctx.subjects.uploads[0].sha256).toBe(sha256(PDF));
      expect(ctx.storage.objects.get(finalKey(upload.id))?.body).toEqual(PDF);
      expect(
        ctx.storage.presigned.filter((p) => p.op === 'PUT').map((p) => p.key),
      ).toEqual([stagingKey(upload.id)]);
    });

    it('accepts an image and returns the same upload when confirmed twice', async () => {
      const png = FILE_SAMPLES['image/png'];
      const upload = await uploadAndConfirm({ contentType: 'image/png' }, png);
      expect(upload.contentType).toBe('image/png');
      const again = await http()
        .post(`/me/certification-uploads/${upload.id}/confirm`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200);
      expect(again.body).toEqual(upload);
      expect(ctx.subjects.uploads).toHaveLength(1);
      expect(ctx.subjects.uploads[0].file_key).toBe(
        finalKey(upload.id, png, 'png'),
      );
    });

    it('400s until the file is uploaded, keeping the intent for a retry', async () => {
      const { uploadId } = await presign();
      const res = await http()
        .post(`/me/certification-uploads/${uploadId}/confirm`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(400);
      expect(messageOf(res)).toBe(CERTIFICATION_FILE_MISSING);
      expect(ctx.storage.deleted).toEqual([]);
      ctx.storage.seed(stagingKey(uploadId), PDF);
      await http()
        .post(`/me/certification-uploads/${uploadId}/confirm`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200);
    });

    it.each([
      [
        'a different size than declared',
        () => Buffer.concat([PDF, Buffer.from('x')]),
        'application/pdf',
        CERTIFICATION_FILE_MISMATCH,
      ],
      [
        'a different content type',
        () => PDF,
        'image/png',
        CERTIFICATION_FILE_MISMATCH,
      ],
      [
        'bytes that are not a PDF',
        () => Buffer.alloc(PDF.length, 0x41),
        'application/pdf',
        CERTIFICATION_FILE_MISMATCH,
      ],
      [
        'a file over 10 MB',
        () => Buffer.alloc(MAX_CERTIFICATION_BYTES + 1),
        'application/pdf',
        CERTIFICATION_FILE_TOO_LARGE,
      ],
    ])(
      'rejects %s and deletes the upload',
      async (_name, bytes, type, message) => {
        const { uploadId } = await presign();
        ctx.storage.seed(stagingKey(uploadId), bytes(), type);
        const res = await http()
          .post(`/me/certification-uploads/${uploadId}/confirm`)
          .set('Authorization', INSTRUCTOR_AUTH)
          .expect(400);
        expect(messageOf(res)).toBe(message);
        expect(ctx.storage.deleted).toEqual(
          expect.arrayContaining([
            stagingKey(uploadId),
            storageKeys.instructorCertificationIntent(
              ctx.instructor.id,
              uploadId,
            ),
          ]),
        );
        expect(ctx.subjects.uploads).toHaveLength(0);
        expect(confirmedObjectKeys()).toEqual([]);
      },
    );

    it('rejects a file that grows past the cap between HEAD and read', async () => {
      const { uploadId } = await presign();
      ctx.storage.seed(stagingKey(uploadId), PDF);
      stageFailingRead(stagingKey(uploadId), () =>
        Promise.reject(
          new ObjectTooLargeError(
            stagingKey(uploadId),
            MAX_CERTIFICATION_BYTES,
          ),
        ),
      );
      const res = await http()
        .post(`/me/certification-uploads/${uploadId}/confirm`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(400);
      expect(messageOf(res)).toBe(CERTIFICATION_FILE_TOO_LARGE);
      expect(ctx.storage.deleted).toContain(stagingKey(uploadId));
    });

    it('surfaces other staged read failures', async () => {
      const { uploadId } = await presign();
      ctx.storage.seed(stagingKey(uploadId), PDF);
      stageFailingRead(stagingKey(uploadId), () =>
        Promise.reject(new Error('r2 down')),
      );
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      await http()
        .post(`/me/certification-uploads/${uploadId}/confirm`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(500);
    });

    it('400s when the object vanishes between HEAD and read', async () => {
      const { uploadId } = await presign();
      ctx.storage.seed(stagingKey(uploadId), PDF);
      stageFailingRead(stagingKey(uploadId), () => Promise.resolve(null));
      const res = await http()
        .post(`/me/certification-uploads/${uploadId}/confirm`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(400);
      expect(messageOf(res)).toBe(CERTIFICATION_FILE_MISSING);
    });

    it('never accepts another instructor’s upload id', async () => {
      const other = ctx.subjects.seedInstructor();
      const confirmed = certificationUploadRow({ instructor_id: other.id });
      ctx.subjects.uploads.push(confirmed);
      const pendingId = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
      ctx.storage.seed(
        storageKeys.instructorCertificationIntent(other.id, pendingId),
        Buffer.from(
          JSON.stringify({
            uploadId: pendingId,
            instructorId: other.id,
            org: 'csia',
            track: 'regular',
            validUntil: addDays(today(), 100),
            contentType: 'application/pdf',
            contentLength: PDF.length,
          }),
        ),
        'application/json',
      );
      ctx.storage.seed(
        storageKeys.instructorCertificationStaging(other.id, pendingId, 'pdf'),
        PDF,
      );
      for (const id of [confirmed.id, pendingId, UNKNOWN_ID]) {
        const res = await http()
          .post(`/me/certification-uploads/${id}/confirm`)
          .set('Authorization', INSTRUCTOR_AUTH)
          .expect(404);
        expect(messageOf(res)).toBe(CERTIFICATION_UPLOAD_NOT_FOUND);
      }
      expect(ctx.subjects.uploads).toEqual([confirmed]);
    });

    it('404s on an intent that names someone else or is not JSON', async () => {
      const ids = [
        '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        '2a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      ];
      ctx.storage.seed(
        storageKeys.instructorCertificationIntent(ctx.instructor.id, ids[0]),
        Buffer.from(
          JSON.stringify({ uploadId: ids[0], instructorId: UNKNOWN_ID }),
        ),
      );
      ctx.storage.seed(
        storageKeys.instructorCertificationIntent(ctx.instructor.id, ids[1]),
        Buffer.from('not json'),
      );
      for (const id of ids) {
        await http()
          .post(`/me/certification-uploads/${id}/confirm`)
          .set('Authorization', INSTRUCTOR_AUTH)
          .expect(404);
      }
    });

    it('400s on a malformed upload id', async () => {
      await http()
        .post('/me/certification-uploads/not-a-uuid/confirm')
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(400);
    });

    it('treats a concurrent duplicate insert as already confirmed', async () => {
      const { uploadId } = await presign();
      ctx.storage.seed(stagingKey(uploadId), PDF);
      const insert = ctx.uploads.insert.bind(ctx.uploads) as (
        row: NewCertificationUploadRow,
      ) => Promise<CertificationUploadRow>;
      jest
        .spyOn(ctx.uploads, 'insert')
        .mockImplementationOnce(async (row: NewCertificationUploadRow) => {
          await insert(row);
          return insert(row);
        });
      await http()
        .post(`/me/certification-uploads/${uploadId}/confirm`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200);
      expect(ctx.subjects.uploads).toHaveLength(1);
      expect(ctx.storage.objects.has(finalKey(uploadId))).toBe(true);
    });

    it('drops its own copy when a concurrent confirm recorded different bytes', async () => {
      const { uploadId } = await presign();
      ctx.storage.seed(stagingKey(uploadId), PDF);
      const winnerKey = finalKey(uploadId, Buffer.from('winner'));
      const insert = ctx.uploads.insert.bind(ctx.uploads) as (
        row: NewCertificationUploadRow,
      ) => Promise<CertificationUploadRow>;
      jest
        .spyOn(ctx.uploads, 'insert')
        .mockImplementationOnce(async (row: NewCertificationUploadRow) => {
          await insert({ ...row, file_key: winnerKey, sha256: 'winner' });
          return insert(row);
        });
      await http()
        .post(`/me/certification-uploads/${uploadId}/confirm`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(200);
      expect(ctx.subjects.uploads[0].file_key).toBe(winnerKey);
      expect(ctx.storage.deleted).toContain(finalKey(uploadId));
      expect(ctx.storage.objects.has(finalKey(uploadId))).toBe(false);
    });

    it('surfaces other insert failures', async () => {
      const { uploadId } = await presign();
      ctx.storage.seed(stagingKey(uploadId), PDF);
      jest
        .spyOn(ctx.uploads, 'insert')
        .mockRejectedValueOnce(new Error('db down'));
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      await http()
        .post(`/me/certification-uploads/${uploadId}/confirm`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(500);
    });

    it('logs and carries on when deleting a rejected file fails', async () => {
      const { uploadId } = await presign();
      ctx.storage.seed(stagingKey(uploadId), PDF, 'image/png');
      jest.spyOn(ctx.storage, 'delete').mockRejectedValue(new Error('r2 down'));
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      await http()
        .post(`/me/certification-uploads/${uploadId}/confirm`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(400);
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('keying on (instructor, org, track)', () => {
    it('keeps uploads attached when a profile save re-inserts the certification rows', async () => {
      const upload = await uploadAndConfirm();
      ctx.subjects.certifications.set(ctx.instructor.id, [
        { org: 'casi', track: 'park', level: 1 },
        { org: 'csia', track: 'regular', level: 3 },
      ]);
      const items = await certItems();
      expect(items.find((i) => i.org === 'csia')).toMatchObject({
        level: 3,
        uploadId: upload.id,
        reviewStatus: 'pending',
        state: 'pending',
      });
      expect(items.find((i) => i.org === 'casi')).toMatchObject({
        uploadId: null,
        state: 'missing',
      });
    });

    it('makes the newest confirmed upload current', async () => {
      const first = await uploadAndConfirm();
      const second = await uploadAndConfirm();
      const [item] = (await certItems()).filter((i) => i.org === 'csia');
      expect(item.uploadId).toBe(second.id);
      const res = await http()
        .get(`/admin/instructors/${ctx.instructor.id}/documents`)
        .set('Authorization', admin)
        .expect(200);
      const listed = (res.body as InstructorDocuments).certificationUploads as {
        id: string;
        current: boolean;
      }[];
      expect(listed.map((u) => [u.id, u.current])).toEqual([
        [second.id, true],
        [first.id, false],
      ]);
    });
  });

  describe('checklist states at the boundaries', () => {
    const seed = (
      review: CertificationUploadRow['review_status'],
      days: number,
    ) =>
      ctx.subjects.uploads.push(
        certificationUploadRow({
          instructor_id: ctx.instructor.id,
          review_status: review,
          valid_until: addDays(torontoToday(), days),
        }),
      );

    it.each([
      ['approved', 31, 'valid'],
      ['approved', 30, 'expiring'],
      ['approved', 0, 'expiring'],
      ['approved', -1, 'expired'],
      ['pending', 30, 'pending'],
      ['pending', 0, 'pending'],
      ['pending', -1, 'expired'],
      ['rejected', 200, 'rejected'],
    ] as const)('%s, %i days left → %s', async (review, days, state) => {
      seed(review, days);
      const [item] = (await certItems()).filter((i) => i.org === 'csia');
      expect(item.state).toBe(state);
    });
  });

  describe('on the Toronto date', () => {
    const TORONTO_22H = new Date('2026-10-14T02:00:00.000Z');

    afterEach(() => {
      jest.useRealTimers();
    });

    const at = (now: Date) => {
      jest.useFakeTimers({ toFake: ['Date'], now });
    };

    const approved = (validUntil: string, org: 'csia' | 'casi' = 'csia') => {
      const row = certificationUploadRow({
        instructor_id: ctx.instructor.id,
        org,
        track: org === 'csia' ? 'regular' : 'park',
        review_status: 'approved',
        valid_until: validUntil,
      });
      ctx.subjects.uploads.push(row);
      return row;
    };

    async function adminStates() {
      const res = await http()
        .get(`/admin/instructors/${ctx.instructor.id}/documents`)
        .set('Authorization', admin)
        .expect(200);
      return (
        (res.body as InstructorDocuments).certificationUploads as {
          org: string;
          state: string;
        }[]
      ).map((u) => [u.org, u.state]);
    }

    it('accepts and confirms validUntil = the Toronto date at 22:00 Toronto (02:00 UTC next day)', async () => {
      at(TORONTO_22H);
      const confirmed = await uploadAndConfirm({ validUntil: '2026-10-13' });
      expect(confirmed).toMatchObject({
        validUntil: '2026-10-13',
        state: 'pending',
      });
      const [item] = (await certItems()).filter((i) => i.org === 'csia');
      expect(item.state).toBe('pending');
    });

    it('rejects the previous Toronto date at 22:00 Toronto', async () => {
      at(TORONTO_22H);
      const res = await http()
        .post('/me/certification-uploads/upload-url')
        .set('Authorization', INSTRUCTOR_AUTH)
        .send(uploadBody({ validUntil: '2026-10-12' }))
        .expect(400);
      expect(messageOf(res)).toBe(VALID_UNTIL_IN_PAST);
    });

    it('rejects the old Toronto date once Toronto passes midnight', async () => {
      at(new Date('2026-10-14T04:00:00.000Z'));
      const res = await http()
        .post('/me/certification-uploads/upload-url')
        .set('Authorization', INSTRUCTOR_AUTH)
        .send(uploadBody({ validUntil: '2026-10-13' }))
        .expect(400);
      expect(messageOf(res)).toBe(VALID_UNTIL_IN_PAST);
    });

    it.each([
      ['2026-10-14T02:00:00.000Z', 'expiring', 'valid'],
      ['2026-10-14T03:59:59.999Z', 'expiring', 'valid'],
      ['2026-10-14T04:00:00.000Z', 'expired', 'expiring'],
    ])(
      'at %s an upload valid until 2026-10-13 is %s and one valid until 2026-11-13 is %s',
      async (now, lastDay, monthOut) => {
        approved('2026-10-13');
        approved('2026-11-13', 'casi');
        at(new Date(now));
        const states = Object.fromEntries(
          (await certItems()).map((i) => [i.org, i.state]),
        );
        expect(states).toEqual({ csia: lastDay, casi: monthOut });
        expect(Object.fromEntries(await adminStates())).toEqual(states);
      },
    );

    it.each([
      ['2026-11-02T04:59:59.999Z', 'expiring'],
      ['2026-11-02T05:00:00.000Z', 'expired'],
    ])(
      'follows Toronto midnight after the DST change: at %s an upload valid until 2026-11-01 is %s',
      async (now, state) => {
        approved('2026-11-01');
        at(new Date(now));
        const [item] = (await certItems()).filter((i) => i.org === 'csia');
        expect(item.state).toBe(state);
      },
    );
  });

  describe('admin review', () => {
    let row: CertificationUploadRow;

    beforeEach(() => {
      row = certificationUploadRow({
        instructor_id: ctx.instructor.id,
        review_status: 'pending',
        valid_until: addDays(torontoToday(), 20),
        expiry_reminder_sent_at: new Date().toISOString(),
      });
      ctx.subjects.uploads.push(row);
    });

    it('GET …/url presigns the file inline and audits the view', async () => {
      const res = await http()
        .get(`/admin/certification-uploads/${row.id}/url`)
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toEqual({
        url: `memory://GET/${row.file_key}`,
        expiresAt: anyString,
        sha256: row.sha256,
      });
      expect(ctx.storage.presigned.at(-1)).toEqual({
        op: 'GET',
        key: row.file_key,
        input: undefined,
      });
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: 'certification_upload.view',
          targetType: 'certification_upload',
          targetId: row.id,
          actor: { userId: ADMIN_USER_ID, role: 'admin', userAgent: null },
        }),
      ]);
    });

    it('approves with a note, stamping reviewer and time, and audits it', async () => {
      const res = await http()
        .patch(`/admin/certification-uploads/${row.id}`)
        .set('Authorization', admin)
        .send({ reviewStatus: 'approved', reviewNote: '  Looks good  ' })
        .expect(200);
      expect(res.body).toMatchObject({
        id: row.id,
        reviewStatus: 'approved',
        reviewNote: 'Looks good',
        reviewedBy: ADMIN_USER_ID,
        reviewedAt: anyString,
        validUntil: row.valid_until,
        state: 'expiring',
        current: true,
      });
      expect(ctx.subjects.uploads[0].expiry_reminder_sent_at).toBe(
        row.expiry_reminder_sent_at,
      );
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: 'certification_upload.review',
          targetId: row.id,
          metadata: {
            instructorId: ctx.instructor.id,
            org: 'csia',
            track: 'regular',
            before: { review_status: 'pending', review_note: null },
            after: { review_status: 'approved', review_note: 'Looks good' },
          },
        }),
      ]);
    });

    it('corrects validUntil (even to a past date) and resets the expiry reminder', async () => {
      const corrected = addDays(torontoToday(), -3);
      const res = await http()
        .patch(`/admin/certification-uploads/${row.id}`)
        .set('Authorization', admin)
        .send({ reviewStatus: 'approved', validUntil: corrected })
        .expect(200);
      expect(res.body).toMatchObject({
        validUntil: corrected,
        state: 'expired',
      });
      expect(ctx.subjects.uploads[0]).toMatchObject({
        valid_until: corrected,
        expiry_reminder_sent_at: null,
      });
      expect(ctx.audit.entries[0].metadata).toMatchObject({
        before: { valid_until: row.valid_until },
        after: { valid_until: corrected },
      });
      const [item] = (await certItems()).filter((i) => i.org === 'csia');
      expect(item).toMatchObject({ validUntil: corrected, state: 'expired' });
    });

    it('keeps the reminder when validUntil is resent unchanged, and clears a note with null', async () => {
      ctx.subjects.uploads[0].review_note = 'old';
      const res = await http()
        .patch(`/admin/certification-uploads/${row.id}`)
        .set('Authorization', admin)
        .send({
          reviewStatus: 'rejected',
          reviewNote: null,
          validUntil: row.valid_until,
        })
        .expect(200);
      expect(res.body).toMatchObject({
        reviewStatus: 'rejected',
        reviewNote: null,
        state: 'rejected',
      });
      expect(ctx.subjects.uploads[0].expiry_reminder_sent_at).toBe(
        row.expiry_reminder_sent_at,
      );
    });

    it.each([
      ['no status', {}],
      ['an unknown status', { reviewStatus: 'maybe' }],
      ['a bad date', { reviewStatus: 'approved', validUntil: '31/12/2027' }],
      [
        'a long note',
        { reviewStatus: 'approved', reviewNote: 'x'.repeat(1001) },
      ],
    ])('400s on %s', async (_name, body) => {
      await http()
        .patch(`/admin/certification-uploads/${row.id}`)
        .set('Authorization', admin)
        .send(body)
        .expect(400);
    });

    it('404s on an unknown upload', async () => {
      await http()
        .get(`/admin/certification-uploads/${UNKNOWN_ID}/url`)
        .set('Authorization', admin)
        .expect(404);
      await http()
        .patch(`/admin/certification-uploads/${UNKNOWN_ID}`)
        .set('Authorization', admin)
        .send({ reviewStatus: 'approved' })
        .expect(404);
    });

    it('404s when the row disappears mid-review', async () => {
      jest.spyOn(ctx.uploads, 'update').mockResolvedValueOnce(null);
      await http()
        .patch(`/admin/certification-uploads/${row.id}`)
        .set('Authorization', admin)
        .send({ reviewStatus: 'approved' })
        .expect(404);
    });
  });
});
