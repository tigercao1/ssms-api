import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { InMemorySyncRepository } from '../../test/helpers/shopify-sync-fakes';
import { RolesGuard } from '../admin/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { InstructorSyncRepository } from './instructor-sync.repository';
import { InstructorSyncService } from './instructor-sync.service';
import { ReconcileAuthGuard } from './reconcile-auth.guard';
import { ShopifySyncController } from './shopify-sync.controller';

const TOKEN = 'reconcile-secret-123';

class FakeJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    const role = /^Bearer jwt-(\w+)$/.exec(header)?.[1];
    if (!role) {
      throw new UnauthorizedException();
    }
    (req as Request & { user: unknown }).user = {
      sub: 'user-1',
      app_metadata: { role },
    };
    return true;
  }
}

async function build(env: Record<string, string | undefined>) {
  const repo = new InMemorySyncRepository();
  repo.counts = { instructors: 2, orphaned: 1 };
  const moduleRef = await Test.createTestingModule({
    controllers: [ShopifySyncController],
    providers: [
      { provide: InstructorSyncRepository, useValue: repo },
      { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      {
        provide: InstructorSyncService,
        useValue: new InstructorSyncService(
          repo,
          {} as never,
          {} as never,
          {} as never,
        ),
      },
      { provide: SupabaseAuthGuard, useClass: FakeJwtGuard },
      RolesGuard,
      ReconcileAuthGuard,
    ],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  await app.init();
  return app;
}

describe('POST /internal/shopify-sync/reconcile', () => {
  let app: INestApplication<App>;

  afterEach(async () => {
    await app?.close();
  });

  const post = (authorization?: string) => {
    const req = request(app.getHttpServer()).post(
      '/internal/shopify-sync/reconcile',
    );
    return authorization ? req.set('Authorization', authorization) : req;
  };

  it('enqueues everyone for the CI bearer token and returns counts', async () => {
    app = await build({ SHOPIFY_RECONCILE_TOKEN: TOKEN });
    const res = await post(`Bearer ${TOKEN}`).expect(200);
    expect(res.body).toEqual({ enqueued: 3, instructors: 2, orphaned: 1 });
  });

  it('accepts an admin JWT', async () => {
    app = await build({ SHOPIFY_RECONCILE_TOKEN: TOKEN });
    await post('Bearer jwt-admin').expect(200);
  });

  it('rejects a non-admin JWT with 403', async () => {
    app = await build({ SHOPIFY_RECONCILE_TOKEN: TOKEN });
    await post('Bearer jwt-instructor').expect(403);
  });

  it.each([undefined, `Bearer ${TOKEN}x`, `Basic ${TOKEN}`, 'Bearer short'])(
    'rejects %s with 401',
    async (authorization) => {
      app = await build({ SHOPIFY_RECONCILE_TOKEN: TOKEN });
      await post(authorization).expect(401);
    },
  );

  it.each([undefined, '', '   '])(
    'is disabled (404) when SHOPIFY_RECONCILE_TOKEN is %j, even for admins',
    async (token) => {
      app = await build({ SHOPIFY_RECONCILE_TOKEN: token });
      await post('Bearer jwt-admin').expect(404);
      await post(`Bearer ${TOKEN}`).expect(404);
    },
  );
});
