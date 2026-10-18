import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH,
  INSTRUCTOR_AUTH,
  INSTRUCTOR_USER_ID,
  startDocumentsApp,
  UNVERIFIED_AUTH,
} from '../../test/helpers/documents-fakes';
import {
  goLiveFor,
  INSTRUCTOR_ID,
  InMemorySyncRepository,
  readySnapshotOf,
  verifiedUpload,
} from '../../test/helpers/shopify-sync-fakes';
import {
  AdminGoLiveController,
  MeGoLiveController,
} from './go-live.controller';
import { GoLiveService } from './go-live.service';
import type { InstructorSnapshot } from './instructor-sync.types';

const UNKNOWN_ID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';

async function build(
  snapshot: InstructorSnapshot = readySnapshotOf(),
  env: Record<string, string | undefined> = {},
) {
  const repo = new InMemorySyncRepository();
  repo.snapshots.set(INSTRUCTOR_ID, snapshot);
  const goLive = goLiveFor(repo, env);
  goLive.subjects.seedInstructor({
    id: INSTRUCTOR_ID,
    auth_user_id: INSTRUCTOR_USER_ID,
  });
  goLive.subjects.uploads.push(verifiedUpload('csia', 'regular', 3));
  const app = await startDocumentsApp(
    Test.createTestingModule({
      controllers: [MeGoLiveController, AdminGoLiveController],
      providers: [{ provide: GoLiveService, useValue: goLive.service }],
    }),
  );
  return { app, repo, ...goLive };
}

describe('go-live HTTP', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());
  const mine = async () =>
    (await http().get('/me/go-live').set('Authorization', INSTRUCTOR_AUTH))
      .body as unknown;

  afterEach(async () => {
    await ctx.app.close();
  });

  describe('GET /me/go-live', () => {
    it('reports a ready instructor that is not live yet', async () => {
      ctx = await build();

      expect(await mine()).toEqual({
        live: false,
        ready: true,
        liveUrl: null,
        missing: [],
        certifications: [
          {
            org: 'csia',
            track: 'regular',
            level: 3,
            status: 'verified',
            validUntil: '2099-12-31',
          },
        ],
      });
    });

    it('links the live storefront page once the entry is active', async () => {
      ctx = await build();
      await ctx.repo.saveState(INSTRUCTOR_ID, {
        shopify_handle: 'eddie-chen',
        shopify_metaobject_id: 'gid://shopify/Metaobject/1',
        last_status: 'active',
      });

      expect(await mine()).toMatchObject({
        live: true,
        ready: true,
        liveUrl: 'https://ssnow.club/pages/our-team/eddie-chen',
      });
    });

    it('uses STOREFRONT_LIVE_BASE_URL for the live link', async () => {
      ctx = await build(readySnapshotOf(), {
        STOREFRONT_LIVE_BASE_URL: 'https://example.test/team',
      });
      await ctx.repo.saveState(INSTRUCTOR_ID, {
        shopify_handle: 'eddie-chen',
        last_status: 'active',
      });

      expect(await mine()).toMatchObject({
        liveUrl: 'https://example.test/team/eddie-chen',
      });
    });

    it('lists what is missing: profile, certification and outstanding documents', async () => {
      ctx = await build(
        readySnapshotOf({ instructor: { profile_photo_url: null } }),
      );
      ctx.subjects.uploads[0].verified_level = 2;
      const agreement = ctx.templates.seed({
        status: 'live',
        title_en: 'Instructor agreement',
        title_zh: '教练协议',
      });
      const signed = ctx.templates.seed({ status: 'live', sort_order: 1 });
      const assignment = ctx.assignments.seed({
        template_id: agreement.id,
        subject_id: INSTRUCTOR_ID,
      });
      ctx.assignments.seed({
        template_id: signed.id,
        subject_id: INSTRUCTOR_ID,
        status: 'completed',
        completed_at: '2026-10-01T00:00:00Z',
      });
      await ctx.repo.saveState(INSTRUCTOR_ID, {
        shopify_handle: 'eddie-chen',
        last_status: 'draft',
      });

      expect(await mine()).toEqual({
        live: false,
        ready: false,
        liveUrl: null,
        missing: [
          { group: 'profile', field: 'photo' },
          { group: 'certification', reason: 'none_verified' },
          {
            group: 'onboarding',
            assignmentId: assignment.id,
            titleEn: 'Instructor agreement',
            titleZh: '教练协议',
          },
        ],
        certifications: [
          {
            org: 'csia',
            track: 'regular',
            level: 3,
            status: 'level_mismatch',
            validUntil: '2099-12-31',
          },
        ],
      });
    });

    it('reports nothing missing for an instructor awaiting approval', async () => {
      ctx = await build(
        readySnapshotOf({
          instructor: { approval_status: 'pending', profile_photo_url: null },
        }),
      );

      expect(await mine()).toEqual({
        live: false,
        ready: false,
        liveUrl: null,
        missing: [],
        certifications: [expect.objectContaining({ status: 'verified' })],
      });
    });

    it.each([
      ['pending', { approval_status: 'pending' as const }],
      ['rejected', { approval_status: 'rejected' as const }],
      ['inactive', { is_active: false }],
    ])(
      'is not live for a %s instructor whose Shopify entry is still active',
      async (_label, instructor) => {
        ctx = await build(readySnapshotOf({ instructor }));
        await ctx.repo.saveState(INSTRUCTOR_ID, {
          shopify_handle: 'eddie-chen',
          last_status: 'active',
        });

        expect(await mine()).toEqual({
          live: false,
          ready: false,
          liveUrl: null,
          missing: [],
          certifications: [expect.objectContaining({ status: 'verified' })],
        });
        const admin = await http()
          .get(`/admin/instructors/${INSTRUCTOR_ID}/go-live`)
          .set('Authorization', ADMIN_AUTH)
          .expect(200);
        expect(admin.body).toMatchObject({ live: false, liveUrl: null });
      },
    );

    it('is 404 without an instructor profile', async () => {
      ctx = await build();
      await http()
        .get('/me/go-live')
        .set('Authorization', ADMIN_AUTH)
        .expect(404);
    });

    it('is 401 without a token and 403 for an unverified email', async () => {
      ctx = await build();
      await http().get('/me/go-live').expect(401);
      await http()
        .get('/me/go-live')
        .set('Authorization', UNVERIFIED_AUTH)
        .expect(403);
    });
  });

  describe('GET /admin/instructors/:id/go-live', () => {
    it('returns the same body for the instructor', async () => {
      ctx = await build(readySnapshotOf({ courseLevels: [] }));

      const res = await http()
        .get(`/admin/instructors/${INSTRUCTOR_ID}/go-live`)
        .set('Authorization', ADMIN_AUTH)
        .expect(200);

      expect(res.body).toEqual({
        live: false,
        ready: false,
        liveUrl: null,
        missing: [{ group: 'profile', field: 'courseLevels' }],
        certifications: [expect.objectContaining({ status: 'verified' })],
      });
      expect(res.body).toEqual(await mine());
    });

    it('is 404 for an unknown instructor', async () => {
      ctx = await build();
      await http()
        .get(`/admin/instructors/${UNKNOWN_ID}/go-live`)
        .set('Authorization', ADMIN_AUTH)
        .expect(404);
    });

    it('is 400 for an id that is not a UUID', async () => {
      ctx = await build();
      await http()
        .get('/admin/instructors/not-a-uuid/go-live')
        .set('Authorization', ADMIN_AUTH)
        .expect(400);
    });

    it('is 403 for an instructor', async () => {
      ctx = await build();
      await http()
        .get(`/admin/instructors/${INSTRUCTOR_ID}/go-live`)
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(403);
    });
  });
});
