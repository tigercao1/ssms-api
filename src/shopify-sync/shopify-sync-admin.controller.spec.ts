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
  INSTRUCTOR_ID,
  InMemorySettingsRepository,
  InMemorySyncRepository,
} from '../../test/helpers/shopify-sync-fakes';
import { AuditService } from '../audit/audit.service';
import type { AuditEntry } from '../audit/audit.types';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { InstructorSyncRepository } from './instructor-sync.repository';
import { InstructorSyncService } from './instructor-sync.service';
import { ShopifySyncAdminController } from './shopify-sync-admin.controller';
import { ShopifySyncAdminService } from './shopify-sync-admin.service';
import { ShopifySyncSettingsRepository } from './shopify-sync-settings.repository';
import { ShopifySyncSettings } from './shopify-sync-settings.service';
import { MAX_SYNC_ATTEMPTS } from './shopify-sync.worker';

const ADMIN_ID = '7d0f8a1e-5b2c-4e3d-9a8b-1c2d3e4f5a6b';
const ORPHAN_ID = '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const CLIENT_SECRET = 'shpss_do-not-leak';
const CLIENT_ID = 'client-id-do-not-leak';

const liveEnv = {
  SHOPIFY_SYNC_ENABLED: 'true',
  SHOPIFY_SHOP: 'acme',
  SHOPIFY_CLIENT_ID: CLIENT_ID,
  SHOPIFY_CLIENT_SECRET: CLIENT_SECRET,
};

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

async function build(env: Record<string, string | undefined> = {}) {
  const syncRepo = new InMemorySyncRepository();
  const settingsRepo = new InMemorySettingsRepository(syncRepo);
  const audits: AuditEntry[] = [];
  const audit = {
    record: (entry: AuditEntry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [ShopifySyncAdminController],
    providers: [
      ShopifySyncAdminService,
      ShopifySyncSettings,
      { provide: InstructorSyncRepository, useValue: syncRepo },
      { provide: ShopifySyncSettingsRepository, useValue: settingsRepo },
      { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      {
        provide: InstructorSyncService,
        useValue: new InstructorSyncService(
          syncRepo,
          {} as never,
          {} as never,
          {} as never,
        ),
      },
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
  const settings = moduleRef.get(ShopifySyncSettings);
  return { app, syncRepo, settingsRepo, audits, settings };
}

describe('/admin/shopify-sync', () => {
  let ctx: Awaited<ReturnType<typeof build>>;

  afterEach(async () => {
    await ctx?.app.close();
  });

  const http = () => request(ctx.app.getHttpServer());
  const admin = 'Bearer jwt-admin';

  describe('auth', () => {
    const routes: [string, (r: ReturnType<typeof http>) => request.Test][] = [
      ['GET status', (r) => r.get('/admin/shopify-sync/status')],
      ['PATCH', (r) => r.patch('/admin/shopify-sync').send({ enabled: true })],
      ['POST run', (r) => r.post('/admin/shopify-sync/run').send({})],
      [
        'GET instructor',
        (r) => r.get(`/admin/shopify-sync/instructors/${INSTRUCTOR_ID}`),
      ],
    ];

    it.each(routes)('%s needs a JWT (401)', async (_label, call) => {
      ctx = await build();
      await call(http()).expect(401);
    });

    it.each(routes)(
      '%s rejects non-admins (403) and changes nothing',
      async (_label, call) => {
        ctx = await build();
        ctx.settingsRepo.instructors.add(INSTRUCTOR_ID);
        await call(http())
          .set('Authorization', 'Bearer jwt-instructor')
          .expect(403);
        expect(ctx.settingsRepo.settings?.enabled).toBe(false);
        expect(ctx.syncRepo.queue.size).toBe(0);
        expect(ctx.audits.map((a) => a.action)).toEqual([
          'auth.admin_guard_failure',
        ]);
      },
    );
  });

  describe('GET /status', () => {
    it('reports settings, heartbeat, queue and entry counts', async () => {
      ctx = await build(liveEnv);
      Object.assign(ctx.settingsRepo.settings!, {
        enabled: true,
        last_tick_at: '2026-10-10T04:00:05.000Z',
        last_success_at: '2026-10-10T04:00:00.000Z',
        last_error: `${INSTRUCTOR_ID}: boom`,
        last_error_at: '2026-10-10T03:59:00.000Z',
      });
      const queue = ctx.syncRepo.queue;
      queue.set('a', row('a', '2026-10-10T03:00:00.000Z', 0));
      queue.set('b', row('b', '2026-10-10T03:30:00.000Z', 2));
      queue.set('c', row('c', '2026-10-10T03:10:00.000Z', MAX_SYNC_ATTEMPTS));
      await ctx.syncRepo.saveState('a', {
        shopify_metaobject_id: 'gid://a',
        last_status: 'active',
      });
      await ctx.syncRepo.saveState('b', {
        shopify_metaobject_id: 'gid://b',
        last_status: 'draft',
      });
      await ctx.syncRepo.saveState('c', { shopify_handle: 'c' });

      const res = await http()
        .get('/admin/shopify-sync/status')
        .set('Authorization', admin)
        .expect(200);

      expect(res.body).toEqual({
        enabled: true,
        masterSwitch: true,
        configured: true,
        lastTickAt: '2026-10-10T04:00:05.000Z',
        lastSuccessAt: '2026-10-10T04:00:00.000Z',
        lastError: `${INSTRUCTOR_ID}: boom`,
        lastErrorAt: '2026-10-10T03:59:00.000Z',
        queue: {
          pending: 1,
          retrying: 1,
          oldestEnqueuedAt: '2026-10-10T03:00:00.000Z',
        },
        entries: { synced: 2, active: 1, draft: 1, failed: 1 },
        storefrontPreviewBaseUrl: 'https://ssnow.club/pages/our-team-preview/',
      });
      expect(ctx.settingsRepo.statsCalls).toEqual([MAX_SYNC_ATTEMPTS]);
    });

    it('never returns Shopify credentials', async () => {
      ctx = await build(liveEnv);
      const res = await http()
        .get('/admin/shopify-sync/status')
        .set('Authorization', admin)
        .expect(200);
      expect(res.text).not.toContain(CLIENT_SECRET);
      expect(res.text).not.toContain(CLIENT_ID);
    });

    it.each([
      ['nothing set', {}, false, false],
      [
        'master switch off',
        { ...liveEnv, SHOPIFY_SYNC_ENABLED: 'false' },
        false,
        true,
      ],
      ['credentials missing', { SHOPIFY_SYNC_ENABLED: 'true' }, true, false],
    ])(
      'reports %s',
      async (_label, env: Record<string, string>, masterSwitch, configured) => {
        ctx = await build(env);
        ctx.settingsRepo.settings = null;
        const res = await http()
          .get('/admin/shopify-sync/status')
          .set('Authorization', admin)
          .expect(200);
        expect(res.body).toMatchObject({
          enabled: false,
          masterSwitch,
          configured,
          lastTickAt: null,
          queue: { pending: 0, retrying: 0, oldestEnqueuedAt: null },
        });
      },
    );

    it('takes the preview base URL from the environment', async () => {
      ctx = await build({
        SHOPIFY_STOREFRONT_PREVIEW_BASE_URL: 'https://example.test/preview',
      });
      const res = await http()
        .get('/admin/shopify-sync/status')
        .set('Authorization', admin)
        .expect(200);
      expect(
        (res.body as { storefrontPreviewBaseUrl: string })
          .storefrontPreviewBaseUrl,
      ).toBe('https://example.test/preview/');
    });
  });

  describe('PATCH', () => {
    it('turns sync on, records who did it, audits and applies at once', async () => {
      ctx = await build(liveEnv);
      await expect(ctx.settings.isEnabled()).resolves.toBe(false);

      const res = await http()
        .patch('/admin/shopify-sync')
        .set('Authorization', admin)
        .set('User-Agent', 'jest')
        .send({ enabled: true })
        .expect(200);

      expect(res.body).toMatchObject({ enabled: true, masterSwitch: true });
      expect(ctx.settingsRepo.settings).toMatchObject({
        enabled: true,
        updated_by: ADMIN_ID,
      });
      expect(ctx.audits).toEqual([
        {
          action: 'shopify_sync.enable',
          actor: { userId: ADMIN_ID, role: 'admin', userAgent: 'jest' },
          metadata: { from: false, to: true },
        },
      ]);
      const reads = ctx.settingsRepo.settingsReads;
      await expect(ctx.settings.isEnabled()).resolves.toBe(true);
      expect(ctx.settingsRepo.settingsReads).toBe(reads);
    });

    it('turns sync off and audits the disable', async () => {
      ctx = await build(liveEnv);
      ctx.settingsRepo.settings!.enabled = true;

      await http()
        .patch('/admin/shopify-sync')
        .set('Authorization', admin)
        .send({ enabled: false })
        .expect(200);

      expect(ctx.settingsRepo.settings?.enabled).toBe(false);
      expect(ctx.audits[0]).toMatchObject({
        action: 'shopify_sync.disable',
        metadata: { from: true, to: false },
      });
    });

    it.each([{}, { enabled: 'yes' }, { enabled: true, extra: 1 }])(
      'rejects %j with 400',
      async (body) => {
        ctx = await build();
        await http()
          .patch('/admin/shopify-sync')
          .set('Authorization', admin)
          .send(body)
          .expect(400);
        expect(ctx.settingsRepo.settings?.enabled).toBe(false);
        expect(ctx.audits).toHaveLength(0);
      },
    );

    it('fails with 500 and no audit when the settings row is missing', async () => {
      ctx = await build();
      ctx.settingsRepo.settings = null;
      await http()
        .patch('/admin/shopify-sync')
        .set('Authorization', admin)
        .send({ enabled: true })
        .expect(500);
      expect(ctx.audits).toHaveLength(0);
    });
  });

  describe('POST /run', () => {
    it('enqueues everyone and says rows wait while sync is off', async () => {
      ctx = await build(liveEnv);
      ctx.syncRepo.counts = { instructors: 4, orphaned: 1 };

      const res = await http()
        .post('/admin/shopify-sync/run')
        .set('Authorization', admin)
        .send({})
        .expect(200);

      expect(res.body).toEqual({ enqueued: 5, processing: false });
      expect(ctx.audits).toEqual([
        {
          action: 'shopify_sync.run',
          actor: { userId: ADMIN_ID, role: 'admin', userAgent: null },
          targetType: null,
          targetId: null,
          metadata: { scope: 'all', enqueued: 5 },
        },
      ]);
    });

    it.each([
      ['on with env on', liveEnv, true, true],
      [
        'on with master switch off',
        { ...liveEnv, SHOPIFY_SYNC_ENABLED: 'false' },
        true,
        false,
      ],
      ['on without credentials', { SHOPIFY_SYNC_ENABLED: 'true' }, true, false],
      ['off with env on', liveEnv, false, false],
    ])(
      'reports processing when sync is %s',
      async (_label, env: Record<string, string>, flag, processing) => {
        ctx = await build(env);
        ctx.settingsRepo.settings!.enabled = flag;
        const res = await http()
          .post('/admin/shopify-sync/run')
          .set('Authorization', admin)
          .expect(200);
        expect((res.body as { processing: boolean }).processing).toBe(
          processing,
        );
      },
    );

    it('enqueues one instructor with a fresh retry budget', async () => {
      ctx = await build(liveEnv);
      ctx.settingsRepo.instructors.add(INSTRUCTOR_ID);
      ctx.syncRepo.queue.set(
        INSTRUCTOR_ID,
        row(INSTRUCTOR_ID, '2026-10-10T03:00:00.000Z', MAX_SYNC_ATTEMPTS),
      );

      const res = await http()
        .post('/admin/shopify-sync/run')
        .set('Authorization', admin)
        .send({ instructorId: INSTRUCTOR_ID })
        .expect(200);

      expect(res.body).toEqual({ enqueued: 1, processing: false });
      expect(ctx.syncRepo.queue.get(INSTRUCTOR_ID)?.attempts).toBe(0);
      expect(ctx.audits[0]).toMatchObject({
        action: 'shopify_sync.run',
        targetType: 'instructor',
        targetId: INSTRUCTOR_ID,
        metadata: { scope: 'instructor', enqueued: 1 },
      });
    });

    it('enqueues a deleted instructor that still has a Shopify entry', async () => {
      ctx = await build();
      await ctx.syncRepo.saveState(ORPHAN_ID, {
        shopify_metaobject_id: 'gid://orphan',
      });
      await http()
        .post('/admin/shopify-sync/run')
        .set('Authorization', admin)
        .send({ instructorId: ORPHAN_ID })
        .expect(200);
      expect(ctx.syncRepo.queue.has(ORPHAN_ID)).toBe(true);
    });

    it('returns 404 for an unknown instructor and enqueues nothing', async () => {
      ctx = await build();
      await http()
        .post('/admin/shopify-sync/run')
        .set('Authorization', admin)
        .send({ instructorId: UNKNOWN_ID })
        .expect(404);
      expect(ctx.syncRepo.queue.size).toBe(0);
      expect(ctx.audits).toHaveLength(0);
    });

    it.each([{ instructorId: 'nope' }, { other: true }])(
      'rejects %j with 400',
      async (body) => {
        ctx = await build();
        await http()
          .post('/admin/shopify-sync/run')
          .set('Authorization', admin)
          .send(body)
          .expect(400);
        expect(ctx.audits).toHaveLength(0);
      },
    );
  });

  describe('GET /instructors/:id', () => {
    it('reports the stored Shopify state and queue row', async () => {
      ctx = await build();
      ctx.settingsRepo.instructors.add(INSTRUCTOR_ID);
      await ctx.syncRepo.saveState(INSTRUCTOR_ID, {
        shopify_handle: 'eddie',
        shopify_metaobject_id: 'gid://shopify/Metaobject/1',
        last_status: 'active',
        last_synced_at: '2026-10-10T03:00:00.000Z',
      });
      ctx.syncRepo.queue.set(INSTRUCTOR_ID, {
        ...row(INSTRUCTOR_ID, '2026-10-10T04:00:00.000Z', 2),
        last_error: 'is blank',
      });

      const res = await http()
        .get(`/admin/shopify-sync/instructors/${INSTRUCTOR_ID}`)
        .set('Authorization', admin)
        .expect(200);

      expect(res.body).toEqual({
        handle: 'eddie',
        metaobjectId: 'gid://shopify/Metaobject/1',
        status: 'active',
        lastSyncedAt: '2026-10-10T03:00:00.000Z',
        lastError: 'is blank',
        queued: true,
        attempts: 2,
        previewUrl: 'https://ssnow.club/pages/our-team-preview/eddie',
      });
    });

    it('reports an unrecognised stored status as null', async () => {
      ctx = await build();
      ctx.settingsRepo.instructors.add(INSTRUCTOR_ID);
      await ctx.syncRepo.saveState(INSTRUCTOR_ID, {
        shopify_handle: 'eddie',
        shopify_metaobject_id: 'gid://shopify/Metaobject/1',
        last_status: 'something-else',
        last_synced_at: '2026-10-10T03:00:00.000Z',
      });

      const res = await http()
        .get(`/admin/shopify-sync/instructors/${INSTRUCTOR_ID}`)
        .set('Authorization', admin)
        .expect(200);

      expect(res.body).toEqual(expect.objectContaining({ status: null }));
    });

    it('reports a never-synced instructor', async () => {
      ctx = await build();
      ctx.settingsRepo.instructors.add(INSTRUCTOR_ID);
      const res = await http()
        .get(`/admin/shopify-sync/instructors/${INSTRUCTOR_ID}`)
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toEqual({
        handle: null,
        metaobjectId: null,
        status: null,
        lastSyncedAt: null,
        lastError: null,
        queued: false,
        attempts: 0,
        previewUrl: null,
      });
    });

    it('has no preview URL until the entry exists in Shopify', async () => {
      ctx = await build();
      ctx.settingsRepo.instructors.add(INSTRUCTOR_ID);
      await ctx.syncRepo.saveState(INSTRUCTOR_ID, { shopify_handle: 'eddie' });
      const res = await http()
        .get(`/admin/shopify-sync/instructors/${INSTRUCTOR_ID}`)
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toMatchObject({ handle: 'eddie', previewUrl: null });
    });

    it('returns 404 for an unknown instructor', async () => {
      ctx = await build();
      await http()
        .get(`/admin/shopify-sync/instructors/${UNKNOWN_ID}`)
        .set('Authorization', admin)
        .expect(404);
    });

    it('returns 400 for a malformed id', async () => {
      ctx = await build();
      await http()
        .get('/admin/shopify-sync/instructors/not-a-uuid')
        .set('Authorization', admin)
        .expect(400);
    });
  });
});

function row(instructorId: string, enqueuedAt: string, attempts: number) {
  return {
    instructor_id: instructorId,
    enqueued_at: enqueuedAt,
    attempts,
    last_error: null,
  };
}
