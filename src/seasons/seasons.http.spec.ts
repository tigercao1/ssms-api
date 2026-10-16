import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH as admin,
  ADMIN_ID,
  INSTRUCTOR_AUTH,
  startAdminApp,
} from '../../test/helpers/admin-http';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import {
  InMemorySeasonsRepository,
  SEASON_2026,
  seasonRow,
  seasonsProviders,
} from '../../test/helpers/seasons-fakes';
import { AdminController } from '../admin/admin.controller';
import { AdminService } from '../admin/admin.service';
import { AuditService } from '../audit/audit.service';
import { DatabaseError } from '../database/db-result';
import { ReferenceDataController } from '../reference-data/reference-data.controller';
import { ReferenceDataService } from '../reference-data/reference-data.service';
import {
  SEASON_DATES_REQUIRED,
  SEASON_IN_USE,
  SEASON_OVERLAP,
  SEASON_RANGE,
  UNKNOWN_SEASON,
} from './seasons.service';

const ENCODED = encodeURIComponent('2026/27');

async function build(
  repo = new InMemorySeasonsRepository(),
  env: Record<string, string> = {},
  now = '2026-10-15T16:00:00Z',
) {
  const audit = recordingAudit();
  const adminService = { listReferences: jest.fn().mockResolvedValue([]) };
  const app = await startAdminApp(
    Test.createTestingModule({
      controllers: [ReferenceDataController, AdminController],
      providers: [
        ...seasonsProviders(repo, () => new Date(now)),
        { provide: ReferenceDataService, useValue: {} },
        { provide: AdminService, useValue: adminService },
        { provide: AuditService, useValue: audit },
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      ],
    }),
  );
  return { app, repo, audit, adminService };
}

describe('seasons HTTP', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());

  afterEach(async () => {
    await ctx.app.close();
  });

  describe('GET /reference/seasons', () => {
    it('lists seasons newest first with the current one flagged, without auth', async () => {
      ctx = await build(
        new InMemorySeasonsRepository([
          seasonRow('2025/26'),
          SEASON_2026,
          seasonRow('2027/28'),
        ]),
      );
      await http()
        .get('/reference/seasons')
        .expect(200, [
          {
            key: '2027/28',
            startsOn: '2027-11-01',
            endsOn: '2028-04-30',
            isCurrent: false,
          },
          {
            key: '2026/27',
            startsOn: '2026-11-01',
            endsOn: '2027-04-30',
            isCurrent: true,
          },
          {
            key: '2025/26',
            startsOn: '2025-11-01',
            endsOn: '2026-04-30',
            isCurrent: false,
          },
        ]);
    });

    it('honours CURRENT_SEASON when it names a season', async () => {
      ctx = await build(
        new InMemorySeasonsRepository([seasonRow('2025/26'), SEASON_2026]),
        { CURRENT_SEASON: '2025/26' },
      );
      const res = await http().get('/reference/seasons').expect(200);
      expect(
        (res.body as { key: string; isCurrent: boolean }[]).map((s) => [
          s.key,
          s.isCurrent,
        ]),
      ).toEqual([
        ['2026/27', false],
        ['2025/26', true],
      ]);
    });

    it('ignores a CURRENT_SEASON that is not a season', async () => {
      ctx = await build(new InMemorySeasonsRepository(), {
        CURRENT_SEASON: '2026-27',
      });
      const res = await http().get('/reference/seasons').expect(200);
      expect(res.body).toEqual([
        expect.objectContaining({ key: '2026/27', isCurrent: true }),
      ]);
    });
  });

  describe('admin CRUD', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    it('is admin only', async () => {
      await http().get('/admin/reference/seasons').expect(401);
      await http()
        .get('/admin/reference/seasons')
        .set('Authorization', INSTRUCTOR_AUTH)
        .expect(403);
      await http()
        .post('/admin/reference/seasons')
        .set('Authorization', INSTRUCTOR_AUTH)
        .send({ key: '2027/28', startsOn: '2027-11-01', endsOn: '2028-04-30' })
        .expect(403);
    });

    it('lists seasons with their usage, ahead of the generic reference routes', async () => {
      ctx.repo.references.set('2026/27', 2);
      await http()
        .get('/admin/reference/seasons')
        .set('Authorization', admin)
        .expect(200, [
          {
            key: '2026/27',
            startsOn: '2026-11-01',
            endsOn: '2027-04-30',
            isCurrent: true,
            inUse: true,
          },
        ]);
      await http()
        .get('/admin/reference/languages')
        .set('Authorization', admin)
        .expect(200, []);
      expect(ctx.adminService.listReferences).toHaveBeenCalledWith('languages');
    });

    it('creates a season and audits it', async () => {
      await http()
        .post('/admin/reference/seasons')
        .set('Authorization', admin)
        .send({ key: '2027/28', startsOn: '2027-11-01', endsOn: '2028-04-30' })
        .expect(201, {
          key: '2027/28',
          startsOn: '2027-11-01',
          endsOn: '2028-04-30',
          isCurrent: false,
          inUse: false,
        });
      expect(ctx.repo.rows.has('2027/28')).toBe(true);
      expect(ctx.audit.entries).toEqual([
        {
          action: 'season.create',
          actor: { userId: ADMIN_ID, role: 'admin', userAgent: null },
          targetType: 'season',
          metadata: {
            key: '2027/28',
            startsOn: '2027-11-01',
            endsOn: '2028-04-30',
          },
        },
      ]);
    });

    it.each([
      ['2027-28', '2027-11-01', '2028-04-30'],
      ['27/28', '2027-11-01', '2028-04-30'],
      ['2027/2028', '2027-11-01', '2028-04-30'],
      ['2027/28', '2027-13-01', '2028-04-30'],
      ['2027/28', '2027-11-01', 'April'],
    ])('400s a bad key or date (%s, %s, %s)', async (key, startsOn, endsOn) => {
      await http()
        .post('/admin/reference/seasons')
        .set('Authorization', admin)
        .send({ key, startsOn, endsOn })
        .expect(400);
      expect(ctx.repo.rows.size).toBe(1);
    });

    it('400s an end on or before the start', async () => {
      await http()
        .post('/admin/reference/seasons')
        .set('Authorization', admin)
        .send({ key: '2027/28', startsOn: '2027-11-01', endsOn: '2027-11-01' })
        .expect(400, {
          statusCode: 400,
          message: SEASON_RANGE,
          error: 'Bad Request',
        });
    });

    it('409s a duplicate key and overlapping dates', async () => {
      await http()
        .post('/admin/reference/seasons')
        .set('Authorization', admin)
        .send({ key: '2026/27', startsOn: '2030-11-01', endsOn: '2031-04-30' })
        .expect(409);
      await http()
        .post('/admin/reference/seasons')
        .set('Authorization', admin)
        .send({ key: '2027/28', startsOn: '2027-04-30', endsOn: '2028-04-30' })
        .expect(409, {
          statusCode: 409,
          message: SEASON_OVERLAP,
          error: 'Conflict',
        });
      expect(ctx.audit.entries).toHaveLength(0);
    });

    it('updates the dates of a URL-encoded key and audits the change', async () => {
      await http()
        .patch(`/admin/reference/seasons/${ENCODED}`)
        .set('Authorization', admin)
        .send({ endsOn: '2027-05-15' })
        .expect(200, {
          key: '2026/27',
          startsOn: '2026-11-01',
          endsOn: '2027-05-15',
          isCurrent: true,
          inUse: false,
        });
      expect(ctx.audit.entries[0]).toMatchObject({
        action: 'season.update',
        targetType: 'season',
        metadata: {
          key: '2026/27',
          from: { startsOn: '2026-11-01', endsOn: '2027-04-30' },
          to: { startsOn: '2026-11-01', endsOn: '2027-05-15' },
        },
      });
    });

    it('refuses a key change, empty, inverted, overlapping and unknown updates', async () => {
      ctx.repo.rows.set('2027/28', seasonRow('2027/28'));
      const patch = (key: string, body: object) =>
        http()
          .patch(`/admin/reference/seasons/${encodeURIComponent(key)}`)
          .set('Authorization', admin)
          .send(body);
      await patch('2026/27', { key: '2026/28' }).expect(400);
      await patch('2026/27', {}).expect(400, {
        statusCode: 400,
        message: SEASON_DATES_REQUIRED,
        error: 'Bad Request',
      });
      await patch('2026/27', { endsOn: '2026-10-01' }).expect(400);
      await patch('2026/27', { endsOn: '2027-11-15' }).expect(409);
      await patch('2030/31', { endsOn: '2031-04-30' }).expect(404);
      expect(ctx.repo.rows.get('2026/27')).toEqual(SEASON_2026);
      expect(ctx.audit.entries).toHaveLength(0);
    });

    it('404s an update the database no longer finds', async () => {
      jest.spyOn(ctx.repo, 'update').mockResolvedValueOnce(null);
      await http()
        .patch(`/admin/reference/seasons/${ENCODED}`)
        .set('Authorization', admin)
        .send({ endsOn: '2027-05-01' })
        .expect(404);
    });

    it('rethrows unexpected database errors', async () => {
      jest.spyOn(ctx.repo, 'insert').mockRejectedValueOnce('boom');
      await http()
        .post('/admin/reference/seasons')
        .set('Authorization', admin)
        .send({ key: '2027/28', startsOn: '2027-11-01', endsOn: '2028-04-30' })
        .expect(500);
    });

    it('reports usage, deletes an unused season with 204 and audits it', async () => {
      ctx.repo.references.set('2026/27', 3);
      await http()
        .get(`/admin/reference/seasons/${ENCODED}/usage`)
        .set('Authorization', admin)
        .expect(200, { referenceCount: 3 });
      await http()
        .get(`/admin/reference/seasons/${encodeURIComponent('2030/31')}/usage`)
        .set('Authorization', admin)
        .expect(404);
      ctx.repo.references.clear();
      const res = await http()
        .delete(`/admin/reference/seasons/${ENCODED}`)
        .set('Authorization', admin)
        .expect(204);
      expect(res.text).toBe('');
      expect(ctx.repo.rows.size).toBe(0);
      expect(ctx.audit.entries[0]).toMatchObject({
        action: 'season.delete',
        metadata: { key: '2026/27' },
      });
    });

    it('409s deleting a referenced season, also when a reference races in', async () => {
      ctx.repo.references.set('2026/27', 1);
      const del = () =>
        http()
          .delete(`/admin/reference/seasons/${ENCODED}`)
          .set('Authorization', admin);
      await del().expect(409, {
        statusCode: 409,
        message: SEASON_IN_USE,
        error: 'Conflict',
      });
      ctx.repo.references.clear();
      jest
        .spyOn(ctx.repo, 'delete')
        .mockRejectedValueOnce(
          new DatabaseError('delete season', '23503', 'fk'),
        )
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValueOnce(null);
      await del().expect(409);
      await del().expect(500);
      await del().expect(404);
      await http()
        .delete(`/admin/reference/seasons/${encodeURIComponent('2030/31')}`)
        .set('Authorization', admin)
        .expect(404);
      expect(ctx.repo.rows.has('2026/27')).toBe(true);
      expect(ctx.audit.entries).toHaveLength(0);
    });
  });

  it('exports the unknown season message used by every season write', () => {
    expect(UNKNOWN_SEASON).toBe('Unknown season');
  });
});
