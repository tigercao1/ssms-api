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
  eddieProducts,
  fakeShopify,
  InMemoryLessonProductsRepository,
} from '../../test/helpers/lessons-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ShopifyAdminClient } from '../shopify/shopify-admin.client';
import { ShopifyGraphqlError } from '../shopify/shopify.errors';
import { LessonProductSyncService } from './lesson-product-sync.service';
import { LessonProductsController } from './lesson-products.controller';
import { LessonProductsRepository } from './lesson-products.repository';
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
  const audit = recordingAudit();
  const shopify = fakeShopify(options.pages ?? []);
  const moduleRef = await Test.createTestingModule({
    controllers: [LessonProductsController],
    providers: [
      LessonProductSyncService,
      ShopifyLessonCatalog,
      { provide: LessonProductsRepository, useValue: products },
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
  return { app, products, audit, graphql: shopify.graphql };
}

const admin = 'Bearer jwt-admin';

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
      ['POST sync', (r) => r.post('/admin/lesson-products/sync')],
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
});
