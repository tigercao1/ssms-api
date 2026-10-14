import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ADMIN_AUTH as admin,
  ADMIN_ID,
  INSTRUCTOR_AUTH,
  startAdminApp,
} from '../../test/helpers/admin-http';
import {
  customerCreated,
  customersPage,
  fakeShopifyGraphql,
  InMemoryCustomersRepository,
  InMemoryCustomerSyncStatusRepository,
} from '../../test/helpers/customers-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import { AuditService } from '../audit/audit.service';
import { buildCorsOptions } from '../config/cors';
import { ShopifyAdminClient } from '../shopify/shopify-admin.client';
import {
  ShopifyConfigError,
  ShopifyGraphqlError,
  ShopifyHttpError,
} from '../shopify/shopify.errors';
import {
  CUSTOMER_EMAIL_TAKEN,
  CUSTOMER_PHONE_TAKEN,
  CUSTOMER_SYNC_DISABLED,
  SHOPIFY_NOT_CONFIGURED,
  SHOPIFY_REQUEST_FAILED,
} from './customer-errors';
import {
  CURSOR_NEEDS_FULL,
  CustomerSyncService,
  MAX_SYNC_PAGES_PER_RUN,
} from './customer-sync.service';
import { CustomerSyncStatusRepository } from './customer-sync-status.repository';
import { CustomerSyncWorker } from './customer-sync.worker';
import { CustomersController } from './customers.controller';
import { CustomersRepository } from './customers.repository';
import { CustomersService } from './customers.service';
import { ShopifyCustomerDirectory } from './shopify-customers';

const PORTAL_ORIGIN = 'https://portal.example';

async function build(
  options: {
    responses?: unknown[];
    enabled?: boolean;
    env?: Record<string, string>;
  } = {},
) {
  const repo = new InMemoryCustomersRepository();
  const syncStatus = new InMemoryCustomerSyncStatusRepository();
  const audit = recordingAudit();
  const shopify = fakeShopifyGraphql(options.responses ?? []);
  const app = await startAdminApp(
    Test.createTestingModule({
      controllers: [CustomersController],
      providers: [
        CustomersService,
        CustomerSyncService,
        CustomerSyncWorker,
        ShopifyCustomerDirectory,
        { provide: CustomersRepository, useValue: repo },
        { provide: CustomerSyncStatusRepository, useValue: syncStatus },
        { provide: ShopifyAdminClient, useValue: shopify.client },
        { provide: AuditService, useValue: audit },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            ...(options.enabled === false
              ? {}
              : { CUSTOMER_SYNC_ENABLED: 'true' }),
            ...options.env,
          }),
        },
      ],
    }),
    (app) => app.enableCors(buildCorsOptions([PORTAL_ORIGIN])),
  );
  return { app, repo, syncStatus, audit, graphql: shopify.graphql };
}

const message = (res: request.Response) =>
  (res.body as { message: unknown }).message;

describe('customers admin HTTP', () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  const http = () => request(ctx.app.getHttpServer());

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(async () => {
    await ctx.app.close();
    jest.restoreAllMocks();
  });

  describe('auth', () => {
    beforeEach(async () => {
      ctx = await build();
    });

    const routes: [string, (r: ReturnType<typeof http>) => request.Test][] = [
      ['GET customers', (r) => r.get('/admin/customers?q=wang')],
      [
        'POST customer',
        (r) =>
          r.post('/admin/customers').send({ firstName: 'A', lastName: 'B' }),
      ],
      ['POST sync', (r) => r.post('/admin/customers/sync')],
      ['GET sync status', (r) => r.get('/admin/customers/sync-status')],
    ];

    it.each(routes)('%s → 401 without a token', async (_name, send) => {
      await send(http()).expect(401);
    });

    it.each(routes)('%s → 403 for a non-admin', async (_name, send) => {
      await send(http()).set('Authorization', INSTRUCTOR_AUTH).expect(403);
      expect(ctx.graphql).not.toHaveBeenCalled();
    });
  });

  describe('POST /admin/customers/sync', () => {
    it('is 503 while CUSTOMER_SYNC_ENABLED is off and never calls Shopify', async () => {
      ctx = await build({ enabled: false });
      const res = await http()
        .post('/admin/customers/sync')
        .set('Authorization', admin)
        .expect(503);
      expect(message(res)).toBe(CUSTOMER_SYNC_DISABLED);
      expect(ctx.graphql).not.toHaveBeenCalled();
    });

    it('backfills every page when nothing is stored yet, then audits the run', async () => {
      ctx = await build({
        responses: [
          customersPage(
            [
              {
                id: 501,
                firstName: 'Mei',
                lastName: 'Wang',
                email: 'mei@example.com',
                updatedAt: '2026-09-01T10:00:00Z',
              },
            ],
            'cursor-1',
          ),
          customersPage([
            {
              id: 502,
              firstName: '',
              lastName: 'Li',
              phone: '+16475550100',
              updatedAt: '2026-09-02T10:00:00Z',
            },
          ]),
        ],
      });
      const res = await http()
        .post('/admin/customers/sync')
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toEqual({
        mode: 'backfill',
        updatedSince: null,
        pages: 2,
        fetched: 2,
        hasMore: false,
        nextCursor: null,
      });
      expect(ctx.graphql.mock.calls.map((c) => c[1])).toEqual([
        { first: 100, after: null, query: null },
        { first: 100, after: 'cursor-1', query: null },
      ]);
      expect(ctx.graphql.mock.calls[0][0]).toContain('sortKey: UPDATED_AT');
      expect(ctx.graphql.mock.calls[0][0]).not.toMatch(/mutation/);
      expect(ctx.repo.rows).toEqual([
        expect.objectContaining({
          shopify_customer_id: 501,
          first_name: 'Mei',
          last_name: 'Wang',
          email: 'mei@example.com',
          phone: null,
          shopify_updated_at: '2026-09-01T10:00:00Z',
        }),
        expect.objectContaining({
          shopify_customer_id: 502,
          first_name: null,
          phone: '+16475550100',
        }),
      ]);
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: 'customer.sync',
          actor: expect.objectContaining({ userId: ADMIN_ID }) as unknown,
          metadata: expect.objectContaining({
            mode: 'backfill',
            fetched: 2,
          }) as unknown,
        }),
      ]);
    });

    it('runs incrementally from the newest stored Shopify update and overwrites changed rows', async () => {
      ctx = await build({
        responses: [
          customersPage([
            {
              id: 501,
              firstName: 'Mei',
              lastName: 'Wang-Li',
              updatedAt: '2026-10-05T08:00:00Z',
            },
          ]),
        ],
      });
      await ctx.repo.upsertMany([
        {
          shopify_customer_id: 501,
          first_name: 'Mei',
          last_name: 'Wang',
          email: null,
          phone: null,
          shopify_updated_at: '2026-10-01T12:34:56.789+00:00',
        },
      ]);
      const res = await http()
        .post('/admin/customers/sync')
        .set('Authorization', admin)
        .expect(200);
      expect(res.body).toMatchObject({
        mode: 'incremental',
        updatedSince: '2026-10-01T12:34:56Z',
        fetched: 1,
      });
      expect(ctx.graphql.mock.calls[0][1]).toEqual({
        first: 100,
        after: null,
        query: "updated_at:>='2026-10-01T12:34:56Z'",
      });
      expect(ctx.repo.rows).toHaveLength(1);
      expect(ctx.repo.rows[0].last_name).toBe('Wang-Li');
    });

    it('stops after the per-run page cap and hands back a cursor for a full resync', async () => {
      const pages = Array.from({ length: MAX_SYNC_PAGES_PER_RUN }, (_, i) =>
        customersPage([{ id: 1000 + i }], `cursor-${i + 1}`),
      );
      ctx = await build({ responses: pages });
      const res = await http()
        .post('/admin/customers/sync')
        .set('Authorization', admin)
        .send({ full: true, cursor: 'cursor-start' })
        .expect(200);
      expect(res.body).toMatchObject({
        mode: 'backfill',
        pages: MAX_SYNC_PAGES_PER_RUN,
        hasMore: true,
        nextCursor: `cursor-${MAX_SYNC_PAGES_PER_RUN}`,
      });
      expect(ctx.graphql.mock.calls[0][1]).toMatchObject({
        after: 'cursor-start',
        query: null,
      });
    });

    it('rejects a cursor without full=true and unknown fields', async () => {
      ctx = await build();
      const res = await http()
        .post('/admin/customers/sync')
        .set('Authorization', admin)
        .send({ cursor: 'abc' })
        .expect(400);
      expect(message(res)).toBe(CURSOR_NEEDS_FULL);
      await http()
        .post('/admin/customers/sync')
        .set('Authorization', admin)
        .send({ full: 'yes' })
        .expect(400);
      expect(ctx.graphql).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a missing read_customers scope',
        new ShopifyGraphqlError([
          {
            message: 'Access denied for customers field.',
            extensions: { code: 'ACCESS_DENIED' },
          },
        ]),
        502,
        'read_customers scope missing: grant read_customers to the Shopify app, then try again.',
      ],
      [
        'Shopify not configured',
        new ShopifyConfigError(['SHOPIFY_SHOP']),
        503,
        SHOPIFY_NOT_CONFIGURED,
      ],
      [
        'any other Shopify failure',
        new ShopifyHttpError(500, 'secret-ish detail'),
        502,
        SHOPIFY_REQUEST_FAILED,
      ],
    ])('maps %s to %i', async (_name, error, status, text) => {
      ctx = await build({ responses: [error] });
      const res = await http()
        .post('/admin/customers/sync')
        .set('Authorization', admin)
        .expect(status);
      expect(message(res)).toBe(text);
      expect(ctx.audit.entries).toEqual([]);
    });

    it('fails on a non-numeric Shopify id without storing anything', async () => {
      ctx = await build({
        responses: [
          {
            customers: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ legacyResourceId: 'gid://nope' }],
            },
          },
        ],
      });
      await http()
        .post('/admin/customers/sync')
        .set('Authorization', admin)
        .expect(502);
      expect(ctx.repo.rows).toEqual([]);
    });
  });

  describe('GET /admin/customers', () => {
    beforeEach(async () => {
      ctx = await build({ enabled: false });
      await ctx.repo.upsertMany([
        {
          shopify_customer_id: 1,
          first_name: 'Mei',
          last_name: 'Wang',
          email: 'mei@example.com',
          phone: '+1 (647) 555-0100',
          shopify_updated_at: null,
        },
        {
          shopify_customer_id: 2,
          first_name: '小明',
          last_name: '王',
          email: null,
          phone: null,
          shopify_updated_at: null,
        },
        {
          shopify_customer_id: 3,
          first_name: 'Eric',
          last_name: 'Li',
          email: 'eric.li@example.com',
          phone: null,
          shopify_updated_at: null,
        },
      ]);
    });

    const get = (qs: string) =>
      http().get(`/admin/customers${qs}`).set('Authorization', admin);
    const search = async (qs: string) =>
      (await get(qs).expect(200)).body as { shopifyCustomerId: number }[];

    it.each([
      ['?q=wang', [1]],
      ['?q=Mei%20Wang', [1]],
      ['?q=MEI%40EXAMPLE', [1]],
      ['?q=647-555', [1]],
      ['?q=(647)%20555%200100', [1]],
      ['?q=%E7%8E%8B%E5%B0%8F%E6%98%8E', [2]],
      ['?q=example.com', [3, 1]],
      ['?q=nobody', []],
      ['', [3, 1, 2]],
    ])('works even with sync off: %s → %j', async (qs, ids) => {
      expect((await search(qs)).map((c) => c.shopifyCustomerId)).toEqual(ids);
    });

    it('returns camelCase customers without any WeChat field', async () => {
      const [mei] = await search('?q=mei');
      expect(mei).toEqual({
        id: expect.any(String) as unknown,
        shopifyCustomerId: 1,
        firstName: 'Mei',
        lastName: 'Wang',
        email: 'mei@example.com',
        phone: '+1 (647) 555-0100',
        shopifyUpdatedAt: null,
        createdAt: expect.any(String) as unknown,
        updatedAt: expect.any(String) as unknown,
      });
    });

    it('passes the limit through with a default of 20 and rejects bad limits', async () => {
      await search('?q=a&limit=5');
      await search('?q=a');
      expect(ctx.repo.searches.map((s) => s.limit)).toEqual([5, 20]);
      await get('?limit=101').expect(400);
      await get('?limit=0').expect(400);
    });

    it('pages a plain array in stable order and reports the total matches in X-Total-Count', async () => {
      const pages = await Promise.all(
        ['?limit=2', '?limit=2&page=2', '?limit=2&page=3'].map((qs) =>
          get(qs).expect(200),
        ),
      );
      expect(
        pages.map((res) =>
          (res.body as { shopifyCustomerId: number }[]).map(
            (c) => c.shopifyCustomerId,
          ),
        ),
      ).toEqual([[3, 1], [2], []]);
      expect(pages.map((res) => res.headers['x-total-count'])).toEqual([
        '3',
        '3',
        '3',
      ]);
      const filtered = await get('?q=example.com&limit=1&page=2').expect(200);
      expect(filtered.headers['x-total-count']).toBe('2');
      expect(ctx.repo.searches.at(-1)).toMatchObject({ limit: 1, offset: 1 });
    });

    it('defaults to page 1 and rejects bad pages', async () => {
      await search('?q=a');
      expect(ctx.repo.searches.at(-1)?.offset).toBe(0);
      await get('?page=0').expect(400);
      await get('?page=1.5').expect(400);
      await get('?page=abc').expect(400);
      await get('?page=10001').expect(400);
    });

    it('lets the portal origin read X-Total-Count through CORS', async () => {
      const res = await get('?limit=1')
        .set('Origin', PORTAL_ORIGIN)
        .expect(200);
      expect(res.headers['access-control-allow-origin']).toBe(PORTAL_ORIGIN);
      expect(res.headers['access-control-expose-headers']).toBe(
        'X-Total-Count',
      );
    });
  });

  describe('GET /admin/customers/sync-status', () => {
    const status = async () =>
      (
        await http()
          .get('/admin/customers/sync-status')
          .set('Authorization', admin)
          .expect(200)
      ).body as unknown;

    it('reports the last scheduled run and the schedule', async () => {
      ctx = await build({ env: { CUSTOMER_SYNC_INTERVAL_MINUTES: '30' } });
      Object.assign(ctx.syncStatus.row, {
        last_started_at: '2026-10-13T12:00:00Z',
        last_finished_at: '2026-10-13T12:00:04Z',
        last_success_at: '2026-10-13T11:30:04Z',
        last_fetched: 12,
        last_error: 'Shopify request failed',
      });
      expect(await status()).toEqual({
        scheduled: true,
        intervalMinutes: 30,
        lastStartedAt: '2026-10-13T12:00:00Z',
        lastFinishedAt: '2026-10-13T12:00:04Z',
        lastSuccessAt: '2026-10-13T11:30:04Z',
        lastFetched: 12,
        lastError: 'Shopify request failed',
      });
    });

    it('is unscheduled when customer sync is off', async () => {
      ctx = await build({ enabled: false });
      expect(await status()).toMatchObject({
        scheduled: false,
        intervalMinutes: 15,
        lastStartedAt: null,
        lastFetched: null,
      });
    });
  });

  describe('POST /admin/customers', () => {
    const create = (body: object) =>
      http().post('/admin/customers').set('Authorization', admin).send(body);

    it('creates the customer in Shopify, stores it locally and audits it', async () => {
      ctx = await build({
        responses: [
          customerCreated({
            id: 9001,
            firstName: 'Lily',
            lastName: 'Chen',
            email: 'lily@example.com',
            phone: '+16475550111',
            updatedAt: '2026-10-11T22:00:00Z',
          }),
        ],
      });
      const res = await create({
        firstName: ' Lily ',
        lastName: 'Chen',
        email: 'lily@example.com',
        phone: '+16475550111',
      }).expect(201);
      expect(res.body).toMatchObject({
        shopifyCustomerId: 9001,
        firstName: 'Lily',
        lastName: 'Chen',
        email: 'lily@example.com',
        phone: '+16475550111',
        shopifyUpdatedAt: '2026-10-11T22:00:00Z',
      });
      expect(ctx.graphql.mock.calls[0][0]).toContain('customerCreate');
      expect(ctx.graphql.mock.calls[0][1]).toEqual({
        input: {
          firstName: 'Lily',
          lastName: 'Chen',
          email: 'lily@example.com',
          phone: '+16475550111',
        },
      });
      expect(ctx.repo.rows).toHaveLength(1);
      expect(ctx.audit.entries).toEqual([
        expect.objectContaining({
          action: 'customer.create',
          targetType: 'customer',
          targetId: (res.body as { id: string }).id,
          metadata: { shopifyCustomerId: 9001, hasEmail: true, hasPhone: true },
        }),
      ]);
    });

    it('omits blank email and phone from the Shopify input', async () => {
      ctx = await build({
        responses: [
          customerCreated({ id: 9002, firstName: 'A', lastName: 'B' }),
        ],
      });
      await create({
        firstName: 'A',
        lastName: 'B',
        email: ' ',
        phone: '',
      }).expect(201);
      expect(ctx.graphql.mock.calls[0][1]).toEqual({
        input: { firstName: 'A', lastName: 'B' },
      });
    });

    it.each([
      [['email'], 'Email has already been taken', CUSTOMER_EMAIL_TAKEN],
      [['phone'], 'Phone has already been taken', CUSTOMER_PHONE_TAKEN],
    ])(
      'is 409 when Shopify reports %j as a duplicate',
      async (field, shopifyMessage, expected) => {
        ctx = await build({
          responses: [
            customerCreated(null, [{ field, message: shopifyMessage }]),
          ],
        });
        const res = await create({
          firstName: 'Lily',
          lastName: 'Chen',
          email: 'lily@example.com',
          phone: '+16475550111',
        }).expect(409);
        expect(message(res)).toBe(expected);
        expect(ctx.repo.rows).toEqual([]);
        expect(ctx.audit.entries).toEqual([]);
      },
    );

    it('is 400 with Shopify’s message for other user errors', async () => {
      ctx = await build({
        responses: [
          customerCreated(null, [
            { field: ['phone'], message: 'Phone is invalid' },
          ]),
        ],
      });
      const res = await create({
        firstName: 'A',
        lastName: 'B',
        phone: '+1 555 0000',
      }).expect(400);
      expect(message(res)).toBe('Phone is invalid');
    });

    it('is 502 naming write_customers when the scope is missing', async () => {
      ctx = await build({
        responses: [
          new ShopifyGraphqlError([
            {
              message:
                'Access denied for customerCreate field. Required access: `write_customers`.',
            },
          ]),
        ],
      });
      const res = await create({ firstName: 'A', lastName: 'B' }).expect(502);
      expect(message(res)).toBe(
        'write_customers scope missing: grant write_customers to the Shopify app, then try again.',
      );
    });

    it('is 502 when Shopify returns neither a customer nor errors', async () => {
      ctx = await build({ responses: [customerCreated(null)] });
      await create({ firstName: 'A', lastName: 'B' }).expect(502);
      expect(ctx.repo.rows).toEqual([]);
    });

    it('is 503 while CUSTOMER_SYNC_ENABLED is off', async () => {
      ctx = await build({ enabled: false });
      const res = await create({ firstName: 'A', lastName: 'B' }).expect(503);
      expect(message(res)).toBe(CUSTOMER_SYNC_DISABLED);
      expect(ctx.graphql).not.toHaveBeenCalled();
    });

    it.each([
      [{ lastName: 'B' }],
      [{ firstName: '', lastName: 'B' }],
      [{ firstName: 'A' }],
      [{ firstName: 'A', lastName: 'B', email: 'not-an-email' }],
      [{ firstName: 'A', lastName: 'B', phone: 'call me' }],
      [{ firstName: 'A', lastName: 'B', wechatName: 'ab' }],
    ])('rejects %j with 400 before calling Shopify', async (body) => {
      ctx = await build();
      await create(body).expect(400);
      expect(ctx.graphql).not.toHaveBeenCalled();
    });
  });
});
