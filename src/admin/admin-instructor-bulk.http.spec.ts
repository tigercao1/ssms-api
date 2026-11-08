import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Logger,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  flushBackground,
  RecordingMailer,
} from '../../test/helpers/mailer-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { BIO_TRANSLATOR } from '../bio-translation/bio-translator.interface';
import { DocumentOnboardingService } from '../documents/document-onboarding.service';
import type { UpdateInstructorProfileDto } from '../instructors/dto/update-instructor-profile.dto';
import { InstructorsService } from '../instructors/instructors.service';
import type { InstructorProfile } from '../instructors/instructors.types';
import { MailerService } from '../mailer/mailer.service';
import { GoLiveService } from '../shopify-sync/go-live.service';
import { AdminInstructorBulkController } from './admin-instructor-bulk.controller';
import {
  AdminInstructorBulkService,
  ATOMIC_NOT_APPLIED,
} from './admin-instructor-bulk.service';
import { AdminRepository } from './admin.repository';
import { AdminService } from './admin.service';
import type { AdminInstructorPatch, AdminInstructorRow } from './admin.types';

const ADMIN_ID = '7d0f8a1e-5b2c-4e3d-9a8b-1c2d3e4f5a6b';
const ANNA = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';
const CHLOE = '33333333-3333-4333-8333-333333333333';
const DANA = 'dddddddd-dddd-4ddd-addd-dddddddddddd';
const UNKNOWN = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const WHISTLER = '44444444-4444-4444-8444-444444444444';
const MISSING_LOCATION = '55555555-5555-4555-8555-555555555555';

class FakeJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const role = /^Bearer jwt-(\w+)$/.exec(
      req.headers.authorization ?? '',
    )?.[1];
    if (!role) {
      throw new UnauthorizedException();
    }
    (req as Request & { user: unknown }).user = {
      sub: role === 'admin' ? ADMIN_ID : 'user-1',
      app_metadata: { role },
    };
    return true;
  }
}

function makeRow(
  id: string,
  over: Partial<AdminInstructorRow> = {},
): AdminInstructorRow {
  return {
    id,
    auth_user_id: `${id.slice(0, 8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    email: `${id.slice(0, 4)}@example.com`,
    first_name: 'First',
    last_name: 'Last',
    display_name_en: `Instructor ${id.slice(0, 1)}`,
    display_name_zh: null,
    bio_en: null,
    bio_zh: null,
    date_of_birth: null,
    profile_photo_url: null,
    min_student_age: 5,
    display_order: null,
    preferred_language: 'en',
    approval_status: 'approved',
    is_active: true,
    inserted_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

async function build(initial: AdminInstructorRow[]) {
  const rows = new Map(initial.map((row) => [row.id, row]));
  const locations = new Map<string, string[]>();
  const repo = {
    findInstructorById: (id: string) => Promise.resolve(rows.get(id) ?? null),
    updateInstructor: (id: string, patch: AdminInstructorPatch) => {
      const row = rows.get(id);
      if (!row) return Promise.resolve(null);
      const next = { ...row, ...patch };
      rows.set(id, next);
      return Promise.resolve(next);
    },
  };
  const profileOf = (row: AdminInstructorRow): InstructorProfile =>
    ({
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      displayNameEn: row.display_name_en,
      displayNameZh: row.display_name_zh,
      bioEn: row.bio_en,
      bioZh: row.bio_zh,
      dateOfBirth: row.date_of_birth,
      preferredLanguage: row.preferred_language,
      profilePhotoUrl: row.profile_photo_url,
      minStudentAge: row.min_student_age,
      displayOrder: row.display_order,
      approvalStatus: row.approval_status,
      isActive: row.is_active,
      teachingLocations: (locations.get(row.id) ?? []).map((id) => ({
        id,
        key: id,
        name: id,
      })),
      languages: [],
      courseLevelsOffered: [],
      certifications: [],
      trainerStatus: [],
    }) as unknown as InstructorProfile;
  const profileUpdates: Array<{ id: string; dto: UpdateInstructorProfileDto }> =
    [];
  const instructors = {
    getProfileById: (id: string) => {
      const row = rows.get(id);
      if (!row) throw new NotFoundException('Instructor profile not found');
      return Promise.resolve(profileOf(row));
    },
    updateProfileById: (id: string, dto: UpdateInstructorProfileDto) => {
      const row = rows.get(id);
      if (!row) throw new NotFoundException('Instructor profile not found');
      if (dto.teachingLocationIds?.includes(MISSING_LOCATION)) {
        return Promise.reject(
          new BadRequestException('Unknown teaching location'),
        );
      }
      profileUpdates.push({ id, dto });
      if (dto.teachingLocationIds) locations.set(id, dto.teachingLocationIds);
      const next = {
        ...row,
        ...(dto.displayNameEn !== undefined && {
          display_name_en: dto.displayNameEn,
        }),
        ...(dto.bioEn !== undefined && { bio_en: dto.bioEn }),
      };
      rows.set(id, next);
      return Promise.resolve(profileOf(next));
    },
  };
  const audit = recordingAudit();
  const mailer = new RecordingMailer();
  const assigned: string[] = [];
  const onboarding = {
    assignPublished: (id: string) => {
      assigned.push(id);
      return Promise.resolve(null);
    },
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminInstructorBulkController],
    providers: [
      AdminService,
      AdminInstructorBulkService,
      { provide: AdminRepository, useValue: repo },
      { provide: InstructorsService, useValue: instructors },
      { provide: MailerService, useValue: mailer.asService() },
      { provide: DocumentOnboardingService, useValue: onboarding },
      { provide: GoLiveService, useValue: {} },
      { provide: BIO_TRANSLATOR, useValue: {} },
      { provide: AuditService, useValue: audit },
    ],
  })
    .overrideGuard(SupabaseAuthGuard)
    .useClass(FakeJwtGuard)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(0, '127.0.0.1');
  return { app, rows, audit, mailer, assigned, profileUpdates, locations };
}

describe('PATCH /admin/instructors (bulk edit)', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const patch = (body: unknown, auth = 'Bearer jwt-admin') =>
    request(ctx.app.getHttpServer())
      .patch('/admin/instructors')
      .set('Authorization', auth)
      .set('User-Agent', 'jest')
      .send(body as object);
  const order = (id: string) => ctx.rows.get(id)?.display_order;
  const actions = () => ctx.audit.entries.map((entry) => entry.action);
  const summaryRow = () =>
    ctx.audit.entries.find(
      (entry) => entry.action === 'admin.instructors.bulk_update',
    );

  afterEach(async () => {
    await ctx?.app.close();
  });

  it('reorders several instructors in one call, one audit row each plus a summary', async () => {
    ctx = await build([
      makeRow(ANNA, { display_order: 3 }),
      makeRow(BEN, { display_order: 1 }),
      makeRow(CHLOE, { display_order: 2 }),
    ]);

    const res = await patch({
      updates: [
        { id: ANNA, displayOrder: 1 },
        { id: BEN, displayOrder: 2 },
        { id: CHLOE, displayOrder: 3 },
      ],
    }).expect(200);

    expect(res.body).toEqual({
      results: [ANNA, BEN, CHLOE].map((id) => ({
        id,
        status: 'updated',
        changes: ['displayOrder'],
      })),
      summary: { updated: 3, unchanged: 0, failed: 0 },
    });
    expect([order(ANNA), order(BEN), order(CHLOE)]).toEqual([1, 2, 3]);
    expect(actions()).toEqual([
      'instructor.display_order_update',
      'instructor.display_order_update',
      'instructor.display_order_update',
      'admin.instructors.bulk_update',
    ]);
    expect(ctx.audit.entries[0]).toMatchObject({
      targetId: ANNA,
      metadata: { from: 3, to: 1 },
    });
    expect(summaryRow()).toEqual({
      action: 'admin.instructors.bulk_update',
      actor: { userId: ADMIN_ID, role: 'admin', userAgent: 'jest' },
      targetType: 'instructor',
      targetId: null,
      metadata: {
        atomic: false,
        rows: 3,
        updated: 3,
        unchanged: 0,
        failed: 0,
        instructors: [ANNA, BEN, CHLOE].map((id) => ({
          id,
          status: 'updated',
          changes: ['displayOrder'],
        })),
      },
    });
  });

  it('applies good rows and reports bad ones independently', async () => {
    ctx = await build([
      makeRow(ANNA, { display_order: 5 }),
      makeRow(BEN, { display_order: 2 }),
      makeRow(CHLOE),
    ]);

    const res = await patch({
      updates: [
        { id: ANNA, displayOrder: 1, displayNameEn: 'Anna B.' },
        { id: UNKNOWN, displayOrder: 2 },
        { id: BEN, displayOrder: 2, isActive: true },
        { id: CHLOE, displayOrder: -1 },
      ],
    }).expect(200);

    expect(res.body).toEqual({
      results: [
        {
          id: ANNA,
          status: 'updated',
          changes: ['displayNameEn', 'displayOrder'],
        },
        { id: UNKNOWN, status: 'failed', error: 'Instructor not found' },
        { id: BEN, status: 'unchanged' },
        {
          id: CHLOE,
          status: 'failed',
          error: 'displayOrder must not be less than 0',
        },
      ],
      summary: { updated: 1, unchanged: 1, failed: 2 },
    });
    expect(ctx.rows.get(ANNA)).toMatchObject({
      display_order: 1,
      display_name_en: 'Anna B.',
    });
    expect(order(CHLOE)).toBeNull();
    expect(ctx.profileUpdates).toEqual([
      { id: ANNA, dto: { displayNameEn: 'Anna B.' } },
    ]);
    expect(summaryRow()?.metadata).toMatchObject({
      updated: 1,
      unchanged: 1,
      failed: 2,
    });
  });

  it('dry run reports the changed fields and writes nothing', async () => {
    ctx = await build([
      makeRow(ANNA, { approval_status: 'pending', display_order: 4 }),
      makeRow(BEN),
    ]);

    const res = await patch({
      dryRun: true,
      updates: [
        {
          id: ANNA,
          approvalStatus: 'approved',
          displayOrder: 1,
          teachingLocationIds: [WHISTLER],
        },
        { id: BEN, isActive: true, bioEn: '' },
        { id: UNKNOWN, isActive: false },
      ],
    }).expect(200);

    expect(res.body).toEqual({
      results: [
        {
          id: ANNA,
          status: 'updated',
          changes: ['teachingLocationIds', 'displayOrder', 'approvalStatus'],
        },
        { id: BEN, status: 'unchanged' },
        { id: UNKNOWN, status: 'failed', error: 'Instructor not found' },
      ],
      summary: { updated: 1, unchanged: 1, failed: 1 },
    });
    await flushBackground();
    expect(ctx.rows.get(ANNA)).toMatchObject({
      approval_status: 'pending',
      display_order: 4,
    });
    expect(ctx.locations.size).toBe(0);
    expect(ctx.audit.entries).toEqual([]);
    expect(ctx.mailer.sent).toEqual([]);
    expect(ctx.assigned).toEqual([]);
  });

  it('rejects duplicate ids before writing anything', async () => {
    ctx = await build([makeRow(ANNA), makeRow(BEN)]);

    const res = await patch({
      updates: [
        { id: ANNA, displayOrder: 1 },
        { id: BEN, displayOrder: 2 },
        { id: ANNA, displayOrder: 3 },
      ],
    }).expect(400);

    expect((res.body as { message: string }).message).toBe(
      `updates.2.id ${ANNA} appears more than once; send each instructor once`,
    );
    expect([order(ANNA), order(BEN)]).toEqual([null, null]);
    expect(ctx.audit.entries).toEqual([]);
  });

  it('rejects the same id sent in two letter cases before writing anything', async () => {
    ctx = await build([makeRow(DANA, { approval_status: 'pending' })]);

    const res = await patch({
      updates: [
        { id: DANA, approvalStatus: 'rejected', reason: 'No certificate' },
        { id: DANA.toUpperCase(), approvalStatus: 'approved' },
      ],
    }).expect(400);
    await flushBackground();

    expect((res.body as { message: string }).message).toBe(
      `updates.1.id ${DANA} appears more than once; send each instructor once`,
    );
    expect(ctx.rows.get(DANA)?.approval_status).toBe('pending');
    expect(ctx.audit.entries).toEqual([]);
    expect(ctx.mailer.sent).toEqual([]);
  });

  it('writes an uppercase id to the instructor with the lowercase id', async () => {
    ctx = await build([makeRow(DANA)]);

    const res = await patch({
      updates: [{ id: DANA.toUpperCase(), displayOrder: 4 }],
    }).expect(200);

    expect((res.body as { results: unknown[] }).results).toEqual([
      { id: DANA, status: 'updated', changes: ['displayOrder'] },
    ]);
    expect(order(DANA)).toBe(4);
  });

  it('rejects more than 25 rows that set approvalStatus or isActive before writing anything', async () => {
    const ids = Array.from(
      { length: 26 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    ctx = await build(ids.map((id) => makeRow(id)));

    const res = await patch({
      updates: [
        ...ids.slice(0, 13).map((id) => ({ id, isActive: false })),
        ...ids.slice(13).map((id) => ({ id, approvalStatus: 'approved' })),
      ],
    }).expect(400);
    await flushBackground();

    expect((res.body as { message: string }).message).toBe(
      'At most 25 rows per request may set approvalStatus or isActive (got 26); split the request',
    );
    expect(ids.every((id) => ctx.rows.get(id)?.is_active)).toBe(true);
    expect(ctx.audit.entries).toEqual([]);
    expect(ctx.mailer.sent).toEqual([]);
  });

  it('accepts 25 status rows alongside 75 other rows', async () => {
    const ids = Array.from(
      { length: 100 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    ctx = await build(ids.map((id) => makeRow(id)));

    const res = await patch({
      updates: ids.map((id, i) =>
        i < 25 ? { id, isActive: false } : { id, displayOrder: i },
      ),
    }).expect(200);
    await flushBackground();

    expect((res.body as { summary: Record<string, number> }).summary).toEqual({
      updated: 100,
      unchanged: 0,
      failed: 0,
    });
  });

  it.each([
    ['a missing id', [{ displayOrder: 1 }], 'updates.0.id must be a UUID'],
    [
      'a malformed id',
      [{ id: ANNA }, { id: 'nope', displayOrder: 1 }],
      'updates.1.id must be a UUID',
    ],
  ])('rejects %s (400)', async (_label, updates, message) => {
    ctx = await build([makeRow(ANNA)]);
    const res = await patch({ updates }).expect(400);
    expect((res.body as { message: string }).message).toBe(message);
    expect(ctx.audit.entries).toEqual([]);
  });

  it.each([
    ['empty', { updates: [] }],
    [
      'over 100 rows',
      {
        updates: Array.from({ length: 101 }, (_, i) => ({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        })),
      },
    ],
    ['not a list', { updates: { id: ANNA } }],
    ['carrying unknown top-level keys', { updates: [{ id: ANNA }], all: 1 }],
  ])('rejects a request that is %s (400)', async (_label, body) => {
    ctx = await build([makeRow(ANNA)]);
    await patch(body).expect(400);
    expect(ctx.audit.entries).toEqual([]);
  });

  it('refuses email, roles and unknown fields per row and never applies that row', async () => {
    ctx = await build([makeRow(ANNA), makeRow(BEN), makeRow(CHLOE)]);

    const res = await patch({
      updates: [
        { id: ANNA, email: 'new@example.com', displayOrder: 1 },
        { id: BEN, role: 'admin', displayOrder: 2 },
        { id: CHLOE, nickname: 'C', bioEnMachineTranslated: true },
      ],
    }).expect(200);

    const errors = (res.body as { results: { error: string }[] }).results.map(
      (result) => result.error,
    );
    expect(errors).toEqual([
      'email cannot be changed in bulk; use PATCH /admin/instructors/:id/email from a signed-in session',
      'role cannot be changed here; use PATCH /admin/users/:id/role from a signed-in session',
      'property nickname should not exist; property bioEnMachineTranslated should not exist',
    ]);
    expect(ctx.rows.get(ANNA)).toMatchObject({
      email: `${ANNA.slice(0, 4)}@example.com`,
      display_order: null,
    });
    expect(order(BEN)).toBeNull();
    expect(actions()).toEqual(['admin.instructors.bulk_update']);
  });

  it('runs approval, rejection and activation through the single-row side effects', async () => {
    ctx = await build([
      makeRow(ANNA, { approval_status: 'pending' }),
      makeRow(BEN, { approval_status: 'pending' }),
      makeRow(CHLOE),
    ]);

    const res = await patch({
      updates: [
        { id: ANNA, approvalStatus: 'approved' },
        { id: BEN, approvalStatus: 'rejected', reason: 'No certificate' },
        { id: CHLOE, isActive: false, approvalStatus: 'approved' },
      ],
    }).expect(200);
    await flushBackground();

    expect(
      (res.body as { results: { status: string }[] }).results.map(
        (r) => r.status,
      ),
    ).toEqual(['updated', 'updated', 'updated']);
    expect(ctx.rows.get(CHLOE)).toMatchObject({
      is_active: false,
      approval_status: 'approved',
    });
    expect(actions()).toEqual([
      'instructor.approve',
      'instructor.reject',
      'instructor.deactivate',
      'admin.instructors.bulk_update',
    ]);
    expect(ctx.audit.entries[1].metadata).toEqual({
      from: 'pending',
      to: 'rejected',
      reason: 'No certificate',
    });
    expect(ctx.assigned).toEqual([ANNA]);
    expect(ctx.mailer.sent.map((mail) => [mail.template, mail.to])).toEqual([
      ['approved', `${ANNA.slice(0, 4)}@example.com`],
      ['rejected', `${BEN.slice(0, 4)}@example.com`],
      ['deactivated', `${CHLOE.slice(0, 4)}@example.com`],
    ]);
  });

  it('fails a row whose approval transition the single-row route refuses', async () => {
    ctx = await build([makeRow(ANNA), makeRow(BEN)]);

    const res = await patch({
      updates: [
        { id: ANNA, approvalStatus: 'rejected', displayOrder: 1 },
        { id: BEN, reason: 'tidy up' },
      ],
    }).expect(200);

    expect(res.body).toMatchObject({
      results: [
        {
          id: ANNA,
          status: 'failed',
          error:
            "Cannot reject an instructor in 'approved' state; only 'pending' is allowed",
        },
        {
          id: BEN,
          status: 'failed',
          error: 'reason is only accepted with approvalStatus',
        },
      ],
    });
    expect(order(ANNA)).toBeNull();
  });

  it('atomic: one invalid row stops every write', async () => {
    ctx = await build([makeRow(ANNA), makeRow(BEN), makeRow(CHLOE)]);

    const res = await patch({
      atomic: true,
      updates: [
        { id: ANNA, displayOrder: 1 },
        { id: BEN },
        { id: CHLOE, displayOrder: 'first' },
      ],
    }).expect(200);

    expect(res.body).toEqual({
      results: [
        {
          id: ANNA,
          status: 'failed',
          changes: ['displayOrder'],
          error: ATOMIC_NOT_APPLIED,
        },
        { id: BEN, status: 'unchanged' },
        {
          id: CHLOE,
          status: 'failed',
          error:
            'displayOrder must not be greater than 2147483647; displayOrder must not be less than 0; displayOrder must be an integer number',
        },
      ],
      summary: { updated: 0, unchanged: 1, failed: 2 },
    });
    expect(order(ANNA)).toBeNull();
    expect(actions()).toEqual(['admin.instructors.bulk_update']);
  });

  it('atomic: a write that fails after earlier rows applied is reported and later rows are skipped', async () => {
    ctx = await build([makeRow(ANNA), makeRow(BEN), makeRow(CHLOE)]);

    const res = await patch({
      atomic: true,
      updates: [
        { id: ANNA, displayOrder: 1 },
        { id: BEN, teachingLocationIds: [MISSING_LOCATION], displayOrder: 2 },
        { id: CHLOE, displayOrder: 3 },
      ],
    }).expect(200);

    expect(res.body).toEqual({
      results: [
        { id: ANNA, status: 'updated', changes: ['displayOrder'] },
        {
          id: BEN,
          status: 'failed',
          changes: [],
          error: 'Unknown teaching location',
        },
        {
          id: CHLOE,
          status: 'failed',
          changes: ['displayOrder'],
          error: ATOMIC_NOT_APPLIED,
        },
      ],
      summary: { updated: 1, unchanged: 0, failed: 2 },
    });
    expect([order(ANNA), order(BEN), order(CHLOE)]).toEqual([1, null, null]);
  });

  it('reports fields already applied when a later write in the row fails', async () => {
    ctx = await build([makeRow(ANNA)]);
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest
      .spyOn(ctx.app.get(AdminService), 'setDisplayOrder')
      .mockRejectedValueOnce(new Error('connection reset'));

    const res = await patch({
      updates: [{ id: ANNA, displayNameEn: 'Anna', displayOrder: 1 }],
    }).expect(200);

    expect(res.body).toMatchObject({
      results: [
        {
          id: ANNA,
          status: 'failed',
          changes: ['displayNameEn'],
          error:
            'The update could not be saved (already applied: displayNameEn)',
        },
      ],
    });
    expect(logged).toHaveBeenCalledWith(
      'Bulk instructor update row failed',
      expect.stringContaining('connection reset'),
    );
    logged.mockRestore();
  });

  it('rejects non-admins (403) and anonymous callers (401)', async () => {
    ctx = await build([makeRow(ANNA)]);
    const body = { updates: [{ id: ANNA, displayOrder: 1 }] };

    await patch(body, 'Bearer jwt-instructor').expect(403);
    await patch(body, '').expect(401);

    expect(order(ANNA)).toBeNull();
    expect(actions()).toEqual(['auth.admin_guard_failure']);
  });
});
