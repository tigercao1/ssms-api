import { type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHmac, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import {
  InMemoryCustomersRepository,
  InMemoryShopifyWebhookEventsRepository,
} from '../../test/helpers/customers-fakes';
import { CustomersRepository } from '../customers/customers.repository';
import { ShopifyWebhookEventsRepository } from '../customers/shopify-webhook-events.repository';
import { ShopifyWebhookThrottlerGuard } from './shopify-webhook-throttler.guard';
import {
  SHOPIFY_WEBHOOK_NOT_CONFIGURED,
  SHOPIFY_WEBHOOK_SHOP_INVALID,
  SHOPIFY_WEBHOOK_SIGNATURE_INVALID,
  ShopifyWebhookVerifier,
} from './shopify-webhook.verifier';
import {
  WEBHOOK_BODY_INVALID,
  WEBHOOK_ID_MISSING,
  ShopifyWebhooksController,
} from './shopify-webhooks.controller';
import { ShopifyWebhooksService } from './shopify-webhooks.service';

const SECRET = randomBytes(24).toString('hex');
const SHOP = '7642c5-2';
const SHOP_DOMAIN = `${SHOP}.myshopify.com`;
const PATH = '/webhooks/shopify';
const CUSTOMER_ID = 7_210_000_000_001;

interface Harness {
  app: INestApplication;
  server: string;
  customers: InMemoryCustomersRepository;
  events: InMemoryShopifyWebhookEventsRepository;
}

async function createApp(
  env: Record<string, string> = {
    SHOPIFY_CLIENT_SECRET: SECRET,
    SHOPIFY_SHOP: SHOP,
  },
): Promise<Harness> {
  const customers = new InMemoryCustomersRepository();
  const events = new InMemoryShopifyWebhookEventsRepository();
  const moduleRef = await Test.createTestingModule({
    controllers: [ShopifyWebhooksController],
    providers: [
      ShopifyWebhookVerifier,
      ShopifyWebhookThrottlerGuard,
      ShopifyWebhooksService,
      { provide: ConfigService, useValue: new ConfigService(env) },
      { provide: CustomersRepository, useValue: customers },
      { provide: ShopifyWebhookEventsRepository, useValue: events },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(0, '127.0.0.1');
  const address = (app.getHttpServer() as Server).address() as AddressInfo;
  return {
    app,
    server: `http://127.0.0.1:${address.port}`,
    customers,
    events,
  };
}

function customerPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    email: 'mei@example.com',
    created_at: '2026-10-01T09:00:00-04:00',
    updated_at: '2026-10-13T08:00:00-04:00',
    first_name: 'Mei',
    last_name: 'Wang',
    state: 'disabled',
    note: null,
    verified_email: true,
    multipass_identifier: null,
    tax_exempt: false,
    phone: '+16475550100',
    currency: 'CAD',
    addresses: [],
    tax_exemptions: [],
    admin_graphql_api_id: `gid://shopify/Customer/${CUSTOMER_ID}`,
    default_address: null,
    ...overrides,
  };
}

const deletePayload = {
  id: CUSTOMER_ID,
  tax_exemptions: [],
  admin_graphql_api_id: `gid://shopify/Customer/${CUSTOMER_ID}`,
};

function sign(body: string | Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

let deliveries = 0;

function deliver(
  h: Harness,
  topic: string,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return request(h.server)
    .post(PATH)
    .set('Content-Type', 'application/json')
    .set({
      'X-Shopify-Topic': topic,
      'X-Shopify-Hmac-Sha256': sign(body),
      'X-Shopify-Shop-Domain': SHOP_DOMAIN,
      'X-Shopify-API-Version': '2026-07',
      'X-Shopify-Webhook-Id': `wh-${++deliveries}`,
      'X-Shopify-Event-Id': `ev-${deliveries}`,
      'X-Shopify-Triggered-At': '2026-10-13T12:00:00.123456789Z',
      ...headers,
    })
    .send(body);
}

describe('POST /webhooks/shopify (HTTP)', () => {
  let h: Harness;
  let warn: jest.SpyInstance;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    h = await createApp();
  });

  afterEach(async () => {
    await h.app.close();
    jest.restoreAllMocks();
  });

  it('upserts a correctly signed customers/create with every Shopify field present and records the delivery', async () => {
    const res = await deliver(h, 'customers/create', customerPayload(), {
      'X-Shopify-Webhook-Id': 'wh-create',
    }).expect(200);

    expect(res.body).toEqual({ outcome: 'inserted' });
    expect(h.customers.rows).toEqual([
      expect.objectContaining({
        shopify_customer_id: CUSTOMER_ID,
        first_name: 'Mei',
        last_name: 'Wang',
        email: 'mei@example.com',
        phone: '+16475550100',
        shopify_updated_at: '2026-10-13T08:00:00-04:00',
        shopify_deleted_at: null,
      }),
    ]);
    expect(h.events.rows).toEqual([
      expect.objectContaining({
        webhook_id: 'wh-create',
        topic: 'customers/create',
        shopify_customer_id: CUSTOMER_ID,
        triggered_at: '2026-10-13T12:00:00.123Z',
        processed_at: expect.any(String) as unknown,
        error: null,
      }),
    ]);
  });

  it('applies a newer customers/update and ignores an older one delivered late', async () => {
    await deliver(h, 'customers/create', customerPayload()).expect(200);
    const newer = await deliver(
      h,
      'customers/update',
      customerPayload({
        last_name: 'Wong',
        updated_at: '2026-10-13T09:00:00-04:00',
      }),
    ).expect(200);
    const older = await deliver(
      h,
      'customers/update',
      customerPayload({
        last_name: 'Stale',
        updated_at: '2026-10-13T08:30:00-04:00',
      }),
    ).expect(200);

    expect([newer.body, older.body]).toEqual([
      { outcome: 'updated' },
      { outcome: 'stale' },
    ]);
    expect(h.customers.rows).toHaveLength(1);
    expect(h.customers.rows[0]).toMatchObject({
      last_name: 'Wong',
      shopify_updated_at: '2026-10-13T09:00:00-04:00',
    });
    expect(h.events.rows.every((e) => e.processed_at && !e.error)).toBe(true);
  });

  it('treats a repeated X-Shopify-Webhook-Id as a no-op even with a different event id', async () => {
    const upsert = jest.spyOn(h.customers, 'upsertIfNewer');
    const headers = { 'X-Shopify-Webhook-Id': 'wh-dup' };
    await deliver(h, 'customers/update', customerPayload(), headers).expect(
      200,
    );
    const again = await deliver(
      h,
      'customers/update',
      customerPayload({
        last_name: 'Changed',
        updated_at: '2026-10-14T00:00:00Z',
      }),
      { ...headers, 'X-Shopify-Event-Id': 'ev-other' },
    ).expect(200);

    expect(again.body).toEqual({ outcome: 'duplicate' });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(h.customers.rows[0].last_name).toBe('Wang');
    expect(h.events.rows).toHaveLength(1);
  });

  it('processes distinct webhook ids that share one event id', async () => {
    const shared = { 'X-Shopify-Event-Id': 'ev-shared' };
    await deliver(h, 'customers/create', customerPayload(), shared).expect(200);
    await deliver(h, 'customers/delete', deletePayload, {
      ...shared,
      'X-Shopify-Triggered-At': '2026-10-13T13:00:00Z',
    }).expect(200);
    expect(h.events.rows).toHaveLength(2);
    expect(h.customers.rows[0].shopify_deleted_at).toBe(
      '2026-10-13T13:00:00.000Z',
    );
  });

  it('answers 500 on a database failure and reprocesses the same webhook id when Shopify retries', async () => {
    jest
      .spyOn(h.customers, 'upsertIfNewer')
      .mockRejectedValueOnce(new Error('db down'));
    const headers = { 'X-Shopify-Webhook-Id': 'wh-retry' };
    await deliver(h, 'customers/update', customerPayload(), headers).expect(
      500,
    );
    expect(h.events.rows[0]).toMatchObject({
      processed_at: null,
      error: 'db down',
    });

    const retry = await deliver(
      h,
      'customers/update',
      customerPayload(),
      headers,
    ).expect(200);
    expect(retry.body).toEqual({ outcome: 'inserted' });
    expect(h.events.rows[0]).toMatchObject({ error: null });
    expect(h.events.rows[0].processed_at).not.toBeNull();
  });

  it('soft-deletes on customers/delete, hides the customer from search, then restores it on a later update', async () => {
    await deliver(h, 'customers/create', customerPayload()).expect(200);
    const deleted = await deliver(h, 'customers/delete', deletePayload, {
      'X-Shopify-Triggered-At': '2026-10-13T14:00:00Z',
    }).expect(200);
    expect(deleted.body).toEqual({ outcome: 'deleted' });
    expect(h.customers.rows).toHaveLength(1);
    expect(h.customers.rows[0].shopify_deleted_at).toBe(
      '2026-10-13T14:00:00.000Z',
    );
    expect((await h.customers.search([], { limit: 10, offset: 0 })).total).toBe(
      0,
    );

    const repeat = await deliver(h, 'customers/delete', deletePayload).expect(
      200,
    );
    expect(repeat.body).toEqual({ outcome: 'unchanged' });

    const stale = await deliver(
      h,
      'customers/update',
      customerPayload({ updated_at: '2026-10-13T09:30:00-04:00' }),
    ).expect(200);
    expect(stale.body).toEqual({ outcome: 'updated' });
    expect(h.customers.rows[0].shopify_deleted_at).not.toBeNull();

    const restored = await deliver(
      h,
      'customers/update',
      customerPayload({
        first_name: 'Mei Mei',
        updated_at: '2026-10-13T11:00:00-04:00',
      }),
    ).expect(200);
    expect(restored.body).toEqual({ outcome: 'updated' });
    expect(h.customers.rows[0]).toMatchObject({
      first_name: 'Mei Mei',
      shopify_deleted_at: null,
    });
    expect((await h.customers.search([], { limit: 10, offset: 0 })).total).toBe(
      1,
    );
  });

  it('ignores a delete triggered before the stored update and a delete for an unknown customer', async () => {
    await deliver(
      h,
      'customers/update',
      customerPayload({ updated_at: '2026-10-13T15:00:00Z' }),
    ).expect(200);
    const early = await deliver(h, 'customers/delete', deletePayload, {
      'X-Shopify-Triggered-At': '2026-10-13T14:59:00Z',
    }).expect(200);
    const unknown = await deliver(h, 'customers/delete', {
      id: 99,
      admin_graphql_api_id: 'gid://shopify/Customer/99',
    }).expect(200);
    expect([early.body, unknown.body]).toEqual([
      { outcome: 'unchanged' },
      { outcome: 'unchanged' },
    ]);
    expect(h.customers.rows).toHaveLength(1);
    expect(h.customers.rows[0].shopify_deleted_at).toBeNull();
  });

  it('dates a delete without X-Shopify-Triggered-At by when it arrived', async () => {
    await deliver(
      h,
      'customers/create',
      customerPayload({ updated_at: '2026-01-01T00:00:00Z' }),
    ).expect(200);
    const before = Date.now();
    await deliver(h, 'customers/delete', deletePayload, {
      'X-Shopify-Triggered-At': 'not a date',
    }).expect(200);
    const deletedAt = Date.parse(h.customers.rows[0].shopify_deleted_at ?? '');
    expect(deletedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(h.events.rows[1].triggered_at).toBeNull();
  });

  it.each([
    ['a missing signature', { 'X-Shopify-Hmac-Sha256': '' }],
    ['a signature from another secret', { 'X-Shopify-Hmac-Sha256': '' }],
    ['a truncated signature', { 'X-Shopify-Hmac-Sha256': 'c2hvcnQ=' }],
  ])('rejects %s with 401 and stores nothing', async (name, headers) => {
    const body = JSON.stringify(customerPayload());
    const signature =
      name === 'a signature from another secret'
        ? sign(body, 'not-the-secret')
        : headers['X-Shopify-Hmac-Sha256'];
    const res = await deliver(h, 'customers/create', body, {
      'X-Shopify-Hmac-Sha256': signature,
    }).expect(401);
    expect((res.body as { message: string }).message).toBe(
      SHOPIFY_WEBHOOK_SIGNATURE_INVALID,
    );
    expect(h.customers.rows).toEqual([]);
    expect(h.events.rows).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'Shopify webhook signature rejected (topic customers/create)',
    );
  });

  it('rejects a correctly signed delivery from another shop with 401', async () => {
    const res = await deliver(h, 'customers/create', customerPayload(), {
      'X-Shopify-Shop-Domain': 'someone-else.myshopify.com',
    }).expect(401);
    expect((res.body as { message: string }).message).toBe(
      SHOPIFY_WEBHOOK_SHOP_INVALID,
    );
    await deliver(h, 'customers/create', customerPayload(), {
      'X-Shopify-Shop-Domain': '',
    }).expect(401);
    expect(h.customers.rows).toEqual([]);
    await deliver(h, 'customers/create', customerPayload(), {
      'X-Shopify-Shop-Domain': SHOP_DOMAIN.toUpperCase(),
    }).expect(200);
  });

  it('verifies the raw bytes: the exact signed whitespace passes, a reformatted body fails', async () => {
    const pretty = JSON.stringify(customerPayload(), null, 2);
    const compact = JSON.stringify(customerPayload());
    await request(h.server)
      .post(PATH)
      .set('Content-Type', 'application/json')
      .set({
        'X-Shopify-Topic': 'customers/create',
        'X-Shopify-Hmac-Sha256': sign(pretty),
        'X-Shopify-Shop-Domain': SHOP_DOMAIN,
        'X-Shopify-Webhook-Id': 'wh-pretty',
      })
      .send(pretty)
      .expect(200);
    await request(h.server)
      .post(PATH)
      .set('Content-Type', 'application/json')
      .set({
        'X-Shopify-Topic': 'customers/create',
        'X-Shopify-Hmac-Sha256': sign(pretty),
        'X-Shopify-Shop-Domain': SHOP_DOMAIN,
        'X-Shopify-Webhook-Id': 'wh-compact',
      })
      .send(compact)
      .expect(401);
    expect(h.events.rows.map((e) => e.webhook_id)).toEqual(['wh-pretty']);
  });

  it('answers 200 to any other topic and stores nothing', async () => {
    const res = await deliver(h, 'orders/create', {
      id: 1,
      total: '9.99',
    }).expect(200);
    expect(res.body).toEqual({ outcome: 'ignored' });
    expect(h.events.rows).toEqual([]);
    expect(h.customers.rows).toEqual([]);
  });

  it('records an unusable payload as processed with its error and answers 200 so Shopify does not retry', async () => {
    const res = await deliver(
      h,
      'customers/update',
      JSON.stringify(
        customerPayload({
          id: 0,
          admin_graphql_api_id: 'gid://shopify/Customer/706405506930370084',
        }),
      ).replace('"id":0', '"id":706405506930370084'),
      { 'X-Shopify-Webhook-Id': 'wh-sample' },
    ).expect(200);
    expect(res.body).toEqual({ outcome: 'invalid' });
    expect(h.customers.rows).toEqual([]);
    expect(h.events.rows).toEqual([
      expect.objectContaining({
        webhook_id: 'wh-sample',
        shopify_customer_id: null,
        processed_at: expect.any(String) as unknown,
        error: "Unexpected Shopify customer id '706405506930370084'",
      }),
    ]);
    const logged = warn.mock.calls.map(([m]) => String(m)).join('\n');
    expect(logged).not.toMatch(/mei|wang|example\.com|647/i);
  });

  it('needs X-Shopify-Webhook-Id and a JSON body', async () => {
    const missingId = await deliver(h, 'customers/create', customerPayload(), {
      'X-Shopify-Webhook-Id': '',
    }).expect(400);
    expect((missingId.body as { message: string }).message).toBe(
      WEBHOOK_ID_MISSING,
    );
    const notJson = await request(h.server)
      .post(PATH)
      .set('Content-Type', 'text/plain')
      .set({
        'X-Shopify-Topic': 'customers/create',
        'X-Shopify-Hmac-Sha256': sign(''),
        'X-Shopify-Shop-Domain': SHOP_DOMAIN,
        'X-Shopify-Webhook-Id': 'wh-text',
      })
      .send('')
      .expect(400);
    expect((notJson.body as { message: string }).message).toBe(
      WEBHOOK_BODY_INVALID,
    );
    expect(h.events.rows).toEqual([]);
  });
});

describe('POST /webhooks/shopify without Shopify config', () => {
  it.each([
    ['no client secret', { SHOPIFY_SHOP: SHOP }],
    ['no shop', { SHOPIFY_CLIENT_SECRET: SECRET }],
  ])('answers 503 with %s', async (_name, env) => {
    const h = await createApp(env);
    try {
      const body = JSON.stringify(customerPayload());
      const res = await request(h.server)
        .post(PATH)
        .set('Content-Type', 'application/json')
        .set({
          'X-Shopify-Topic': 'customers/create',
          'X-Shopify-Hmac-Sha256': sign(body),
          'X-Shopify-Shop-Domain': SHOP_DOMAIN,
          'X-Shopify-Webhook-Id': 'wh-x',
        })
        .send(body)
        .expect(503);
      expect((res.body as { message: string }).message).toBe(
        SHOPIFY_WEBHOOK_NOT_CONFIGURED,
      );
      expect(h.customers.rows).toEqual([]);
    } finally {
      await h.app.close();
    }
  });

  it('accepts SHOPIFY_SHOP given as the full myshopify.com domain', async () => {
    const h = await createApp({
      SHOPIFY_CLIENT_SECRET: SECRET,
      SHOPIFY_SHOP: ` ${SHOP_DOMAIN} `,
    });
    try {
      await deliver(h, 'customers/create', customerPayload()).expect(200);
    } finally {
      await h.app.close();
    }
  });
});
