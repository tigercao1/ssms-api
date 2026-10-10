import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuditService } from '../audit/audit.service';
import type { AuditEntry } from '../audit/audit.types';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { BIO_TRANSLATOR } from '../bio-translation/bio-translator.interface';
import { InstructorsService } from '../instructors/instructors.service';
import { MailerService } from '../mailer/mailer.service';
import { AdminController } from './admin.controller';
import { AdminRepository } from './admin.repository';
import { AdminService } from './admin.service';
import type { AdminInstructorPatch, AdminInstructorRow } from './admin.types';

const ADMIN_ID = '7d0f8a1e-5b2c-4e3d-9a8b-1c2d3e4f5a6b';
const INSTRUCTOR_ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';

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

function makeRow(over: Partial<AdminInstructorRow> = {}): AdminInstructorRow {
  return {
    id: INSTRUCTOR_ID,
    auth_user_id: '22222222-2222-4222-8222-222222222222',
    email: 'jane@example.com',
    display_name_en: 'Jane',
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

async function build(initial: AdminInstructorRow = makeRow()) {
  const rows = new Map<string, AdminInstructorRow>([[initial.id, initial]]);
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
  const audits: AuditEntry[] = [];
  const audit = {
    record: (entry: AuditEntry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminController],
    providers: [
      AdminService,
      { provide: AdminRepository, useValue: repo },
      { provide: InstructorsService, useValue: {} },
      { provide: MailerService, useValue: {} },
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
  await app.init();
  return { app, rows, audits };
}

describe('PATCH /admin/instructors/:id/display-order', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const admin = 'Bearer jwt-admin';
  const url = (id = INSTRUCTOR_ID) => `/admin/instructors/${id}/display-order`;
  const http = () => request(ctx.app.getHttpServer());

  afterEach(async () => {
    await ctx?.app.close();
  });

  it('needs a JWT (401)', async () => {
    ctx = await build();
    await http().patch(url()).send({ displayOrder: 3 }).expect(401);
    expect(ctx.rows.get(INSTRUCTOR_ID)?.display_order).toBeNull();
  });

  it('rejects non-admins (403) and changes nothing', async () => {
    ctx = await build();
    await http()
      .patch(url())
      .set('Authorization', 'Bearer jwt-instructor')
      .send({ displayOrder: 3 })
      .expect(403);
    expect(ctx.rows.get(INSTRUCTOR_ID)?.display_order).toBeNull();
    expect(
      ctx.audits.some((a) => a.action === 'instructor.display_order_update'),
    ).toBe(false);
  });

  it('sets the order, returns it on the record and audits the change', async () => {
    ctx = await build(makeRow({ display_order: 7 }));
    const res = await http()
      .patch(url())
      .set('Authorization', admin)
      .set('User-Agent', 'jest')
      .send({ displayOrder: 2 })
      .expect(200);

    expect(res.body).toMatchObject({ id: INSTRUCTOR_ID, displayOrder: 2 });
    expect(ctx.rows.get(INSTRUCTOR_ID)?.display_order).toBe(2);
    expect(ctx.audits).toEqual([
      {
        action: 'instructor.display_order_update',
        actor: { userId: ADMIN_ID, role: 'admin', userAgent: 'jest' },
        targetType: 'instructor',
        targetId: INSTRUCTOR_ID,
        metadata: { from: 7, to: 2 },
      },
    ]);
  });

  it('accepts 0', async () => {
    ctx = await build();
    const res = await http()
      .patch(url())
      .set('Authorization', admin)
      .send({ displayOrder: 0 })
      .expect(200);
    expect(res.body.displayOrder).toBe(0);
  });

  it('clears the order with null', async () => {
    ctx = await build(makeRow({ display_order: 4 }));
    const res = await http()
      .patch(url())
      .set('Authorization', admin)
      .send({ displayOrder: null })
      .expect(200);
    expect(res.body.displayOrder).toBeNull();
    expect(ctx.rows.get(INSTRUCTOR_ID)?.display_order).toBeNull();
    expect(ctx.audits[0].metadata).toEqual({ from: 4, to: null });
  });

  it.each([
    ['missing', {}],
    ['negative', { displayOrder: -1 }],
    ['fractional', { displayOrder: 1.5 }],
    ['a string', { displayOrder: '3' }],
    ['too large', { displayOrder: 2147483648 }],
    ['with extra fields', { displayOrder: 1, minStudentAge: 3 }],
  ])('rejects a body that is %s (400)', async (_label, body) => {
    ctx = await build();
    await http()
      .patch(url())
      .set('Authorization', admin)
      .send(body)
      .expect(400);
    expect(ctx.rows.get(INSTRUCTOR_ID)?.display_order).toBeNull();
    expect(ctx.audits).toEqual([]);
  });

  it('returns 404 for an unknown instructor without auditing', async () => {
    ctx = await build();
    await http()
      .patch(url(UNKNOWN_ID))
      .set('Authorization', admin)
      .send({ displayOrder: 1 })
      .expect(404);
    expect(ctx.audits).toEqual([]);
  });

  it('rejects a malformed id (400)', async () => {
    ctx = await build();
    await http()
      .patch(url('not-a-uuid'))
      .set('Authorization', admin)
      .send({ displayOrder: 1 })
      .expect(400);
  });
});
