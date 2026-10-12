import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  catalogPage,
  classRow,
  EDDIE_ID,
  eddieProducts,
  ERIC_ID,
  fakeShopify,
  InMemoryClassesRepository,
  InMemoryInstructorCalendarsRepository,
  InMemoryLessonProductsRepository,
} from '../../test/helpers/lessons-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ShopifyAdminClient } from '../shopify/shopify-admin.client';
import { ShopifyGraphqlError } from '../shopify/shopify.errors';
import { ClassesController } from './classes.controller';
import { ClassesRepository } from './classes.repository';
import { ClassesService } from './classes.service';
import { InstructorCalendarsController } from './instructor-calendars.controller';
import { InstructorCalendarsRepository } from './instructor-calendars.repository';
import { InstructorCalendarsService } from './instructor-calendars.service';
import { LessonProductSyncService } from './lesson-product-sync.service';
import { LessonProductsController } from './lesson-products.controller';
import { LessonProductsRepository } from './lesson-products.repository';
import {
  LESSON_PRODUCT_CONFLICT,
  LESSON_PRODUCT_SESSIONS_REQUIRED,
  LessonProductsService,
} from './lesson-products.service';
import type { LessonProduct } from './lessons.types';
import { ShopifyLessonCatalog } from './shopify-lesson-catalog';

const ADMIN_ID = '7d0f8a1e-5b2c-4e3d-9a8b-1c2d3e4f5a6b';

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

async function build(
  options: { pages?: unknown[]; env?: Record<string, string> } = {},
) {
  const products = new InMemoryLessonProductsRepository();
  const classes = new InMemoryClassesRepository();
  const calendars = new InMemoryInstructorCalendarsRepository();
  const audit = recordingAudit();
  const shopify = fakeShopify(options.pages ?? []);
  const moduleRef = await Test.createTestingModule({
    controllers: [
      LessonProductsController,
      ClassesController,
      InstructorCalendarsController,
    ],
    providers: [
      LessonProductSyncService,
      LessonProductsService,
      ClassesService,
      InstructorCalendarsService,
      ShopifyLessonCatalog,
      { provide: LessonProductsRepository, useValue: products },
      { provide: ClassesRepository, useValue: classes },
      { provide: InstructorCalendarsRepository, useValue: calendars },
      { provide: ShopifyAdminClient, useValue: shopify.client },
      { provide: AuditService, useValue: audit },
      {
        provide: ConfigService,
        useValue: new ConfigService(
          options.env ?? { LESSON_PRODUCT_SYNC_ENABLED: 'true' },
        ),
      },
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
  return {
    app,
    products,
    classes,
    calendars,
    audit,
    graphql: shopify.graphql,
  };
}

const admin = 'Bearer jwt-admin';
const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';

describe('lessons admin HTTP', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());

  afterEach(async () => {
    await ctx.app.close();
  });

  describe('auth', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const routes: [string, (r: ReturnType<typeof http>) => request.Test][] = [
      ['GET lesson products', (r) => r.get('/admin/lesson-products')],
      [
        'PATCH lesson product',
        (r) =>
          r.patch(`/admin/lesson-products/${UNKNOWN_ID}`).send({ sessions: 1 }),
      ],
      ['POST sync', (r) => r.post('/admin/lesson-products/sync')],
      ['GET classes', (r) => r.get('/admin/classes')],
      [
        'GET google calendar',
        (r) => r.get(`/admin/instructors/${EDDIE_ID}/google-calendar`),
      ],
      [
        'PATCH google calendar',
        (r) =>
          r
            .patch(`/admin/instructors/${EDDIE_ID}/google-calendar`)
            .send({ googleCalendarId: 'x@example.com' }),
      ],
    ];

    it.each(routes)('%s → 401 without a token', async (_name, send) => {
      await send(http()).expect(401);
    });

    it.each(routes)('%s → 403 for a non-admin', async (_name, send) => {
      await send(http())
        .set('Authorization', 'Bearer jwt-instructor')
        .expect(403);
    });
  });

  describe('POST /admin/lesson-products/sync', () => {
    it('is 503 with a clear message while the flag is off', async () => {
      ctx = await build({ env: {} });
      const res = await http()
        .post('/admin/lesson-products/sync')
        .set('Authorization', admin)
        .expect(503);
      expect((res.body as { message: string }).message).toContain(
        'LESSON_PRODUCT_SYNC_ENABLED',
      );
      expect(ctx.graphql).not.toHaveBeenCalled();
    });

    it('syncs and returns the counts', async () => {
      ctx = await build({ pages: [catalogPage(eddieProducts)] });
      const res = await http()
        .post('/admin/lesson-products/sync')
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toMatchObject({ inserted: 4, variants: 4 });
      expect(ctx.products.rows).toHaveLength(4);
      expect(ctx.audit.entries[0].actor).toMatchObject({ userId: ADMIN_ID });
    });

    it('is 502 naming the missing read_products scope', async () => {
      ctx = await build({
        pages: [
          new ShopifyGraphqlError([
            {
              message: 'Access denied for products field.',
              extensions: { code: 'ACCESS_DENIED' },
            },
          ]),
        ],
      });
      const res = await http()
        .post('/admin/lesson-products/sync')
        .set('Authorization', admin)
        .expect(502);
      expect((res.body as { message: string }).message).toMatch(
        /^read_products scope missing/,
      );
    });
  });

  describe('GET /admin/lesson-products', () => {
    beforeEach(async () => {
      ctx = await build();
      ctx.products.seed({ status: 'suggested' });
      ctx.products.seed({ shopify_variant_id: 2, status: 'confirmed' });
      ctx.products.seed({ shopify_variant_id: 3, status: 'ignored' });
    });

    it('lists every product as camelCase with numeric prices', async () => {
      const res = await http()
        .get('/admin/lesson-products')
        .set('Authorization', admin)
        .expect(200);
      const body = res.body as LessonProduct[];
      expect(body).toHaveLength(3);
      expect(body[0]).toMatchObject({
        shopifyProductId: 8827109769238,
        productTitle: '一对一',
        variantTitle: '单次',
        lessonType: 'private',
        groupSize: 1,
        sessions: 1,
        pricedPerStudent: false,
        instructorId: EDDIE_ID,
        price: 280,
        currency: 'CAD',
      });
    });

    it.each(['suggested', 'confirmed', 'ignored'])(
      'filters by status=%s',
      async (status) => {
        const res = await http()
          .get(`/admin/lesson-products?status=${status}`)
          .set('Authorization', admin)
          .expect(200);
        expect((res.body as LessonProduct[]).map((p) => p.status)).toEqual([
          status,
        ]);
      },
    );

    it('rejects an unknown status', async () => {
      await http()
        .get('/admin/lesson-products?status=approved')
        .set('Authorization', admin)
        .expect(400);
    });
  });

  describe('PATCH /admin/lesson-products/:id', () => {
    let id: string;

    beforeEach(async () => {
      ctx = await build();
      id = ctx.products.seed({
        lesson_type: 'other',
        group_size: null,
        sessions: null,
        instructor_id: null,
      }).id;
    });

    const patch = (body: object, target = id) =>
      http()
        .patch(`/admin/lesson-products/${target}`)
        .set('Authorization', admin)
        .send(body);

    it('applies the edit, confirms it and audits before/after', async () => {
      const res = await patch({
        lessonType: 'semi_private',
        groupSize: 2,
        sessions: 4,
        durationMin: 120,
        pricedPerStudent: true,
        instructorId: ERIC_ID,
        status: 'confirmed',
      }).expect(200);
      expect(res.body).toMatchObject({
        id,
        lessonType: 'semi_private',
        groupSize: 2,
        sessions: 4,
        durationMin: 120,
        pricedPerStudent: true,
        instructorId: ERIC_ID,
        status: 'confirmed',
      });
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: 'lesson_product.update',
          targetType: 'lesson_product',
          targetId: id,
          metadata: expect.objectContaining({
            before: expect.objectContaining({
              status: 'suggested',
              sessions: null,
            }) as unknown,
            after: expect.objectContaining({
              status: 'confirmed',
              sessions: 4,
            }) as unknown,
          }) as unknown,
        }),
      ]);
    });

    it('keeps the confirmed values when Shopify is synced again', async () => {
      ctx.products.rows[0].shopify_variant_id = 47123482771478;
      await patch({
        lessonType: 'group',
        sessions: 6,
        status: 'confirmed',
      }).expect(200);
      ctx.graphql.mockResolvedValueOnce(catalogPage([eddieProducts[0]]));
      await http()
        .post('/admin/lesson-products/sync')
        .set('Authorization', admin)
        .expect(200);
      const res = await http()
        .get('/admin/lesson-products?status=confirmed')
        .set('Authorization', admin)
        .expect(200);
      expect((res.body as LessonProduct[])[0]).toMatchObject({
        lessonType: 'group',
        sessions: 6,
        instructorId: null,
        price: 280,
      });
    });

    it('clears nullable fields with null', async () => {
      ctx.products.rows[0].instructor_id = EDDIE_ID;
      const res = await patch({ instructorId: null, groupSize: null }).expect(
        200,
      );
      expect(res.body).toMatchObject({ instructorId: null, groupSize: null });
    });

    it('refuses to confirm a product without sessions', async () => {
      const res = await patch({ status: 'confirmed' }).expect(400);
      expect((res.body as { message: string }).message).toBe(
        LESSON_PRODUCT_SESSIONS_REQUIRED,
      );
    });

    it('rejects an instructor that does not exist', async () => {
      await patch({ instructorId: UNKNOWN_ID }).expect(400);
    });

    it.each([
      [{}],
      [{ lessonType: 'camp' }],
      [{ lessonType: null }],
      [{ status: null }],
      [{ pricedPerStudent: 'yes' }],
      [{ sessions: 0 }],
      [{ sessions: 1.5 }],
      [{ groupSize: 51 }],
      [{ durationMin: 0 }],
      [{ instructorId: 'eddie' }],
      [{ price: 10 }],
    ])('rejects %j with 400', async (body) => {
      await patch(body).expect(400);
      expect(ctx.audit.entries).toHaveLength(0);
    });

    it('is 404 for an unknown product and 400 for a malformed id', async () => {
      await patch({ sessions: 1 }, UNKNOWN_ID).expect(404);
      await patch({ sessions: 1 }, 'not-a-uuid').expect(400);
    });

    it('is 409 when the row changed underneath the edit', async () => {
      jest.spyOn(ctx.products, 'update').mockResolvedValueOnce(null);
      const res = await patch({ sessions: 2 }).expect(409);
      expect((res.body as { message: string }).message).toBe(
        LESSON_PRODUCT_CONFLICT,
      );
    });
  });

  describe('GET /admin/classes', () => {
    beforeEach(async () => {
      ctx = await build();
      ctx.classes.rows.push(
        classRow({
          starts_at: '2026-12-13T15:00:00.000Z',
          ends_at: '2026-12-13T16:00:00.000Z',
          instructor_id: ERIC_ID,
          instructor: { display_name_en: 'Eric Wang', display_name_zh: null },
        }),
        classRow({
          location_id: '6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c',
          location: { name: 'Blue Mountain' },
          lesson_product: { product_title: '一对一', variant_title: '四次' },
          participants: [
            {
              customer_id: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
              purchase_id: null,
              attendance: 'expected',
              customer: {
                name: 'Lily Chen',
                email: 'lily@example.com',
                phone: null,
                wechat_id: 'lilyc',
              },
            },
          ],
        }),
      );
    });

    it('lists classes in start order with their participants', async () => {
      const res = await http()
        .get('/admin/classes')
        .set('Authorization', admin)
        .expect(200);
      const body = res.body as { startsAt: string }[];
      expect(body.map((c) => c.startsAt)).toEqual([
        '2026-12-12T15:00:00.000Z',
        '2026-12-13T15:00:00.000Z',
      ]);
      expect(body[0]).toMatchObject({
        instructorId: EDDIE_ID,
        instructorName: 'Eddie',
        instructorNameZh: '艾迪',
        locationName: 'Blue Mountain',
        lessonProductTitle: '一对一',
        lessonVariantTitle: '四次',
        status: 'scheduled',
        source: 'ssms',
        participants: [
          {
            customerId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
            purchaseId: null,
            attendance: 'expected',
            name: 'Lily Chen',
            email: 'lily@example.com',
            phone: null,
            wechatId: 'lilyc',
          },
        ],
      });
      expect(body[1]).toMatchObject({
        instructorName: 'Eric Wang',
        locationName: null,
        lessonProductTitle: null,
        participants: [],
      });
    });

    it('filters by date range and instructor', async () => {
      const res = await http()
        .get(
          `/admin/classes?from=2026-12-13T00:00:00Z&to=2026-12-14T00:00:00Z&instructorId=${ERIC_ID}`,
        )
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(ctx.classes.filters[0]).toEqual({
        from: '2026-12-13T00:00:00Z',
        to: '2026-12-14T00:00:00Z',
        instructorId: ERIC_ID,
      });
    });

    it.each([
      ['from=yesterday'],
      ['to=2026-13-01'],
      ['instructorId=eddie'],
      ['from=2026-12-14&to=2026-12-13'],
      ['from=2026-12-14&to=2026-12-14'],
    ])('rejects %s with 400', async (qs) => {
      await http()
        .get(`/admin/classes?${qs}`)
        .set('Authorization', admin)
        .expect(400);
    });
  });

  describe('/admin/instructors/:id/google-calendar', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const url = (id = EDDIE_ID) => `/admin/instructors/${id}/google-calendar`;
    const set = (body: object, id = EDDIE_ID) =>
      http().patch(url(id)).set('Authorization', admin).send(body);

    it('starts empty, saves an id, and audits the change once', async () => {
      const empty = await http()
        .get(url())
        .set('Authorization', admin)
        .expect(200);
      expect(empty.body).toEqual({
        instructorId: EDDIE_ID,
        googleCalendarId: null,
        updatedAt: null,
      });

      const saved = await set({
        googleCalendarId: ' eddie@group.calendar.google.com ',
      }).expect(200);
      expect(saved.body).toMatchObject({
        instructorId: EDDIE_ID,
        googleCalendarId: 'eddie@group.calendar.google.com',
      });
      await set({ googleCalendarId: 'eddie@group.calendar.google.com' }).expect(
        200,
      );

      const read = await http()
        .get(url())
        .set('Authorization', admin)
        .expect(200);
      expect(read.body).toMatchObject({
        googleCalendarId: 'eddie@group.calendar.google.com',
      });
      expect(ctx.calendars.rows.get(EDDIE_ID)?.updated_by).toBe(ADMIN_ID);
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: 'instructor.google_calendar_update',
          targetType: 'instructor',
          targetId: EDDIE_ID,
          metadata: {
            from: null,
            to: 'eddie@group.calendar.google.com',
          },
        }),
      ]);
    });

    it('clears the id with null', async () => {
      await set({ googleCalendarId: 'eddie@example.com' }).expect(200);
      const res = await set({ googleCalendarId: null }).expect(200);
      expect(res.body).toEqual({
        instructorId: EDDIE_ID,
        googleCalendarId: null,
        updatedAt: null,
      });
      expect(ctx.calendars.rows.has(EDDIE_ID)).toBe(false);
      expect(ctx.audit.entries[1].metadata).toEqual({
        from: 'eddie@example.com',
        to: null,
      });
    });

    it('is 404 for an unknown instructor', async () => {
      await http().get(url(UNKNOWN_ID)).set('Authorization', admin).expect(404);
      await set({ googleCalendarId: 'x@example.com' }, UNKNOWN_ID).expect(404);
    });

    it.each([
      [{}],
      [{ googleCalendarId: '' }],
      [{ googleCalendarId: 'two words' }],
      [{ googleCalendarId: 42 }],
      [{ googleCalendarId: 'a'.repeat(321) }],
    ])('rejects %j with 400', async (body) => {
      await set(body).expect(400);
    });
  });
});
