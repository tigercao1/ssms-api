import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Logger,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  FakeDocsStorage,
  InMemoryPublicPagesRepository,
  recordingAudit,
} from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import {
  DOCS_STORAGE_UNAVAILABLE,
  DocsStorageClient,
} from './docs-storage.client';
import { PublicPagesController } from './public-pages.controller';
import { PublicPagesRepository } from './public-pages.repository';
import { PAGE_CONFLICT, PublicPagesService } from './public-pages.service';
import {
  PAGE_CONTENT_MAX_BYTES,
  type PublicPage,
  type PublicPageRow,
} from './public-pages.types';

const ADMIN_ID = '7d0f8a1e-5b2c-4e3d-9a8b-1c2d3e4f5a6b';
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

async function build() {
  const repo = new InMemoryPublicPagesRepository();
  const storage = new FakeDocsStorage();
  const audit = recordingAudit();
  const moduleRef = await Test.createTestingModule({
    controllers: [PublicPagesController],
    providers: [
      PublicPagesService,
      { provide: PublicPagesRepository, useValue: repo },
      { provide: DocsStorageClient, useValue: storage },
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
  return { app, repo, storage, audit };
}

describe('/admin/pages', () => {
  let ctx: Awaited<ReturnType<typeof build>>;

  beforeEach(async () => {
    ctx = await build();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await ctx.app.close();
  });

  const http = () => request(ctx.app.getHttpServer());
  const admin = 'Bearer jwt-admin';
  const html = '<!doctype html><h1>Rates</h1>';

  async function createPage(slug = 'winter-rates'): Promise<PublicPage> {
    const res = await http()
      .post('/admin/pages')
      .set('Authorization', admin)
      .send({ slug, title: 'Winter rates' })
      .expect(201);
    return res.body as PublicPage;
  }

  function upload(id: string, body: string | Buffer = html) {
    return http()
      .put(`/admin/pages/${id}/content`)
      .set('Authorization', admin)
      .set('Content-Type', 'text/html')
      .send(body);
  }

  describe('auth', () => {
    const routes: [string, (r: ReturnType<typeof http>) => request.Test][] = [
      ['GET list', (r) => r.get('/admin/pages')],
      ['POST', (r) => r.post('/admin/pages').send({ slug: 'a', title: 'A' })],
      ['PATCH', (r) => r.patch(`/admin/pages/${UNKNOWN_ID}`).send({})],
      [
        'PUT content',
        (r) =>
          r
            .put(`/admin/pages/${UNKNOWN_ID}/content`)
            .set('Content-Type', 'text/html')
            .send(html),
      ],
      ['GET content', (r) => r.get(`/admin/pages/${UNKNOWN_ID}/content`)],
      ['POST publish', (r) => r.post(`/admin/pages/${UNKNOWN_ID}/publish`)],
      ['POST unpublish', (r) => r.post(`/admin/pages/${UNKNOWN_ID}/unpublish`)],
      ['DELETE', (r) => r.delete(`/admin/pages/${UNKNOWN_ID}`)],
    ];

    it.each(routes)('%s → 401 without a token', async (_name, send) => {
      await send(http()).expect(401);
    });

    it.each(routes)('%s → 403 for a non-admin', async (_name, send) => {
      await send(http())
        .set('Authorization', 'Bearer jwt-instructor')
        .expect(403);
      expect(ctx.storage.calls).toEqual([]);
    });

    it.each(routes)(
      '%s → 503 when the docs Worker is not configured',
      async (_name, send) => {
        ctx.storage.configured = false;
        await send(http()).set('Authorization', admin).expect(503);
      },
    );
  });

  describe('POST /admin/pages', () => {
    it('creates a page (201)', async () => {
      const page = await createPage();
      expect(page).toMatchObject({
        slug: 'winter-rates',
        title: 'Winter rates',
        status: 'draft',
        hasContent: false,
      });
      expect(ctx.audit.entries.map((e) => e.action)).toEqual(['page.create']);
    });

    it.each([
      ['uppercase', 'Winter'],
      ['double hyphen', 'a--b'],
      ['leading hyphen', '-a'],
      ['trailing hyphen', 'a-'],
      ['underscore', 'a_b'],
      ['empty', ''],
      ['too long', 'a'.repeat(81)],
    ])('rejects an invalid slug (%s) with 400', async (_name, slug) => {
      await http()
        .post('/admin/pages')
        .set('Authorization', admin)
        .send({ slug, title: 'T' })
        .expect(400);
    });

    it.each([
      ['blank', '   '],
      ['too long', 'x'.repeat(201)],
    ])('rejects an invalid title (%s) with 400', async (_name, title) => {
      await http()
        .post('/admin/pages')
        .set('Authorization', admin)
        .send({ slug: 'ok', title })
        .expect(400);
    });

    it('rejects a duplicate slug with 409', async () => {
      await createPage('faq');
      await http()
        .post('/admin/pages')
        .set('Authorization', admin)
        .send({ slug: 'faq', title: 'Again' })
        .expect(409);
    });
  });

  it('GET /admin/pages lists newest updatedAt first', async () => {
    const a = await createPage('a');
    const b = await createPage('b');
    await upload(a.id).expect(200);
    const res = await http()
      .get('/admin/pages')
      .set('Authorization', admin)
      .expect(200);
    expect((res.body as PublicPage[]).map((p) => p.id)).toEqual([a.id, b.id]);
  });

  describe('PATCH /admin/pages/:id', () => {
    it('updates the title', async () => {
      const page = await createPage();
      const res = await http()
        .patch(`/admin/pages/${page.id}`)
        .set('Authorization', admin)
        .send({ title: 'Spring rates' })
        .expect(200);
      expect(res.body).toMatchObject({
        title: 'Spring rates',
        slug: 'winter-rates',
      });
      expect(ctx.audit.entries.map((e) => e.action)).toEqual([
        'page.create',
        'page.update',
      ]);
    });

    it('refuses to change the slug', async () => {
      const page = await createPage();
      await http()
        .patch(`/admin/pages/${page.id}`)
        .set('Authorization', admin)
        .send({ title: 'T', slug: 'other' })
        .expect(400);
    });

    it('404s for an unknown page and 400s for a non-uuid id', async () => {
      await http()
        .patch(`/admin/pages/${UNKNOWN_ID}`)
        .set('Authorization', admin)
        .send({ title: 'T' })
        .expect(404);
      await http()
        .patch('/admin/pages/not-a-uuid')
        .set('Authorization', admin)
        .send({ title: 'T' })
        .expect(400);
    });
  });

  describe('PUT /admin/pages/:id/content', () => {
    it('stores the raw HTML and records the size', async () => {
      const page = await createPage();
      const res = await upload(page.id).expect(200);
      expect(res.body).toMatchObject({
        hasContent: true,
        sizeBytes: Buffer.byteLength(html),
      });
      expect(ctx.storage.objects.get('drafts/winter-rates.html')).toEqual(
        Buffer.from(html),
      );
      expect(ctx.audit.entries.map((e) => e.action)).toEqual([
        'page.create',
        'page.upload',
      ]);
    });

    it('accepts exactly 2 MiB', async () => {
      const page = await createPage();
      const res = await upload(
        page.id,
        Buffer.alloc(PAGE_CONTENT_MAX_BYTES, 'a'),
      ).expect(200);
      expect((res.body as PublicPage).sizeBytes).toBe(PAGE_CONTENT_MAX_BYTES);
    });

    it('returns 413 above 2 MiB without touching the Worker', async () => {
      const page = await createPage();
      const res = await upload(
        page.id,
        Buffer.alloc(PAGE_CONTENT_MAX_BYTES + 1, 'a'),
      ).expect(413);
      expect(res.body).toMatchObject({ statusCode: 413 });
      expect(ctx.storage.calls).toEqual([]);
    });

    it('returns 415 for a non-HTML content type', async () => {
      const page = await createPage();
      await http()
        .put(`/admin/pages/${page.id}/content`)
        .set('Authorization', admin)
        .send({ html })
        .expect(415);
    });

    it('returns 415 for an unsupported content encoding', async () => {
      const page = await createPage();
      await upload(page.id).set('Content-Encoding', 'x-unknown').expect(415);
    });

    it('returns 400 for a corrupt compressed body', async () => {
      const page = await createPage();
      await upload(page.id).set('Content-Encoding', 'gzip').expect(400);
    });

    it('returns 400 for an empty body', async () => {
      const page = await createPage();
      await upload(page.id, '').expect(400);
    });

    it('returns 502 and leaves the row unchanged when the Worker fails', async () => {
      const page = await createPage();
      const before = ctx.repo.snapshot();
      ctx.storage.failing = true;
      const res = await upload(page.id).expect(502);
      expect(res.body).toMatchObject({
        message: 'Docs storage is unavailable',
      });
      expect(ctx.repo.snapshot()).toEqual(before);
    });
  });

  it('keeps JSON parsing for other routes', async () => {
    await http()
      .post('/admin/pages')
      .set('Authorization', admin)
      .set('Content-Type', 'text/html')
      .send(html)
      .expect(400);
  });

  describe('GET /admin/pages/:id/content', () => {
    it('returns the draft as text/plain', async () => {
      const page = await createPage();
      await upload(page.id).expect(200);
      const res = await http()
        .get(`/admin/pages/${page.id}/content`)
        .set('Authorization', admin)
        .expect(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.text).toBe(html);
    });

    it('404s when nothing was uploaded', async () => {
      const page = await createPage();
      await http()
        .get(`/admin/pages/${page.id}/content`)
        .set('Authorization', admin)
        .expect(404);
    });

    it('502s when the draft object is missing but the database has one', async () => {
      const page = await createPage();
      await upload(page.id).expect(200);
      ctx.storage.objects.clear();
      jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementationOnce(() => undefined);
      const res = await http()
        .get(`/admin/pages/${page.id}/content`)
        .set('Authorization', admin)
        .expect(502);
      expect(res.body).toMatchObject({ message: DOCS_STORAGE_UNAVAILABLE });
    });
  });

  describe('publish / unpublish / delete', () => {
    it('publish 400s without content', async () => {
      const page = await createPage();
      await http()
        .post(`/admin/pages/${page.id}/publish`)
        .set('Authorization', admin)
        .expect(400);
    });

    it('runs the full lifecycle', async () => {
      const page = await createPage();
      await upload(page.id).expect(200);

      const published = await http()
        .post(`/admin/pages/${page.id}/publish`)
        .set('Authorization', admin)
        .expect(200);
      expect(published.body).toMatchObject({
        status: 'published',
        hasUnpublishedChanges: false,
      });
      expect(ctx.storage.objects.get('published/winter-rates.html')).toEqual(
        Buffer.from(html),
      );

      const changed = await upload(page.id, '<h1>v2</h1>').expect(200);
      expect(changed.body).toMatchObject({ hasUnpublishedChanges: true });

      const unpublished = await http()
        .post(`/admin/pages/${page.id}/unpublish`)
        .set('Authorization', admin)
        .expect(200);
      expect(unpublished.body).toMatchObject({
        status: 'draft',
        publishedAt: null,
      });

      await http()
        .delete(`/admin/pages/${page.id}`)
        .set('Authorization', admin)
        .expect(204);
      expect(ctx.repo.rows.size).toBe(0);
      expect(ctx.storage.objects.size).toBe(0);
      expect(ctx.audit.entries.map((e) => e.action)).toEqual([
        'page.create',
        'page.upload',
        'page.publish',
        'page.upload',
        'page.unpublish',
        'page.delete',
      ]);
    });

    it('publish returns 409 and restores R2 when the page changed concurrently', async () => {
      const page = await createPage();
      await upload(page.id).expect(200);
      jest
        .spyOn(ctx.repo, 'findById')
        .mockImplementationOnce(
          async (id: string): Promise<PublicPageRow | null> => {
            const stale = { ...ctx.repo.rows.get(id)! };
            await upload(page.id, '<h1>v2</h1>').expect(200);
            return stale;
          },
        );
      const res = await http()
        .post(`/admin/pages/${page.id}/publish`)
        .set('Authorization', admin)
        .expect(409);
      expect(res.body).toMatchObject({ message: PAGE_CONFLICT });
      expect(ctx.storage.objects.has('published/winter-rates.html')).toBe(
        false,
      );
      expect(ctx.repo.rows.get(page.id)?.status).toBe('draft');
    });

    it('delete returns 502 and keeps the row when the Worker fails', async () => {
      const page = await createPage();
      ctx.storage.failing = true;
      await http()
        .delete(`/admin/pages/${page.id}`)
        .set('Authorization', admin)
        .expect(502);
      expect(ctx.repo.rows.has(page.id)).toBe(true);
    });
  });
});
