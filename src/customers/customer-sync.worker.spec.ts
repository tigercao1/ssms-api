import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  customerIdsPage,
  customersPage,
  fakeShopifyGraphql,
  InMemoryCustomersRepository,
  InMemoryCustomerSyncStatusRepository,
  InMemoryShopifyWebhookEventsRepository,
} from '../../test/helpers/customers-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import type { AuditService } from '../audit/audit.service';
import { ShopifyHttpError } from '../shopify/shopify.errors';
import { SHOPIFY_REQUEST_FAILED } from './customer-errors';
import {
  CustomerReconcileService,
  RECONCILE_MAX_PAGES,
} from './customer-reconcile.service';
import { CustomerSyncService } from './customer-sync.service';
import {
  CUSTOMER_SYNC_LEASE_SECONDS,
  CUSTOMER_SYNC_TICK_MAX_PAGES,
  CustomerSyncWorker,
  customerSyncIntervalMinutes,
} from './customer-sync.worker';
import { ShopifyCustomerDirectory } from './shopify-customers';

const MINUTE = 60_000;

function build(
  env: Record<string, string>,
  responses: unknown[] = [],
  lastReconcileAt: string | null = new Date().toISOString(),
) {
  const config = new ConfigService(env);
  const repo = new InMemoryCustomersRepository();
  const status = new InMemoryCustomerSyncStatusRepository();
  status.row.last_reconcile_at = lastReconcileAt;
  const events = new InMemoryShopifyWebhookEventsRepository();
  const audit = recordingAudit();
  const shopify = fakeShopifyGraphql(responses);
  const directory = new ShopifyCustomerDirectory(shopify.client);
  const sync = new CustomerSyncService(
    config,
    directory,
    repo,
    audit as unknown as AuditService,
    status,
  );
  return {
    repo,
    status,
    events,
    audit,
    graphql: shopify.graphql,
    worker: new CustomerSyncWorker(
      config,
      sync,
      status,
      new CustomerReconcileService(directory, repo),
      repo,
      events,
    ),
  };
}

const ON = { CUSTOMER_SYNC_ENABLED: 'true' };

describe('CustomerSyncWorker', () => {
  let log: jest.SpyInstance<void, [message: unknown]>;
  let error: jest.SpyInstance<void, [message: unknown]>;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([
    ['the flag is unset', {}],
    ['the flag is not "true"', { CUSTOMER_SYNC_ENABLED: 'yes' }],
    ['the interval is 0', { ...ON, CUSTOMER_SYNC_INTERVAL_MINUTES: '0' }],
  ])('never schedules or calls Shopify when %s', async (_name, env) => {
    jest.useFakeTimers();
    const { worker, graphql, status } = build(env);
    worker.onModuleInit();
    jest.advanceTimersByTime(24 * 60 * MINUTE);
    await expect(worker.tick()).resolves.toEqual({ outcome: 'off' });
    expect(graphql).not.toHaveBeenCalled();
    expect(status.leases).toEqual([]);
    await worker.onModuleDestroy();
  });

  it('ticks every 15 minutes by default, or as configured, and stops on shutdown', async () => {
    jest.useFakeTimers();
    const byDefault = build(ON, [customersPage([])]);
    byDefault.worker.onModuleInit();
    jest.advanceTimersByTime(15 * MINUTE - 1);
    expect(byDefault.status.leases).toEqual([]);
    jest.advanceTimersByTime(1);
    await byDefault.worker.onModuleDestroy();
    expect(byDefault.status.leases).toEqual([CUSTOMER_SYNC_LEASE_SECONDS]);
    jest.advanceTimersByTime(60 * MINUTE);
    expect(byDefault.status.leases).toHaveLength(1);

    const everyFive = build({ ...ON, CUSTOMER_SYNC_INTERVAL_MINUTES: ' 5 ' }, [
      customersPage([]),
    ]);
    everyFive.worker.onModuleInit();
    jest.advanceTimersByTime(5 * MINUTE);
    await everyFive.worker.onModuleDestroy();
    expect(everyFive.status.leases).toHaveLength(1);
  });

  it.each([
    [undefined, 15],
    ['', 15],
    ['30', 30],
    ['0', 0],
    ['-5', 0],
    ['2.5', 0],
    ['soon', 0],
    ['1441', 0],
  ])('reads CUSTOMER_SYNC_INTERVAL_MINUTES=%p as %i', (raw, minutes) => {
    const env: Record<string, string> =
      raw === undefined ? {} : { CUSTOMER_SYNC_INTERVAL_MINUTES: raw };
    expect(customerSyncIntervalMinutes(new ConfigService(env))).toBe(minutes);
  });

  it('runs the incremental sync from the newest stored update, pages until done, records the run and logs counts only', async () => {
    const ctx = build(ON, [
      customersPage(
        [
          {
            id: 501,
            firstName: 'Mei',
            lastName: 'Wang',
            email: 'mei@example.com',
            updatedAt: '2026-10-13T10:00:00Z',
          },
        ],
        'cursor-1',
      ),
      customersPage([
        { id: 502, lastName: 'Li', updatedAt: '2026-10-13T11:00:00Z' },
      ]),
    ]);
    await ctx.repo.upsertMany([
      {
        shopify_customer_id: 400,
        first_name: 'Old',
        last_name: 'Row',
        email: null,
        phone: null,
        shopify_updated_at: '2026-10-12T09:00:00.000+00:00',
      },
    ]);

    await expect(ctx.worker.tick()).resolves.toEqual({
      outcome: 'synced',
      result: expect.objectContaining({
        mode: 'incremental',
        pages: 2,
        fetched: 2,
        hasMore: false,
      }) as unknown,
    });

    expect(ctx.graphql.mock.calls.map((c) => c[1])).toEqual([
      { first: 100, after: null, query: "updated_at:>='2026-10-12T09:00:00Z'" },
      {
        first: 100,
        after: 'cursor-1',
        query: "updated_at:>='2026-10-12T09:00:00Z'",
      },
    ]);
    expect(ctx.repo.rows.map((r) => r.shopify_customer_id)).toEqual([
      400, 501, 502,
    ]);
    expect(await ctx.worker.status()).toEqual({
      scheduled: true,
      intervalMinutes: 15,
      lastStartedAt: '2026-10-13T12:00:00Z',
      lastFinishedAt: '2026-10-13T12:01:00Z',
      lastSuccessAt: '2026-10-13T12:01:00Z',
      lastFetched: 2,
      lastError: null,
      incrementalSince: expect.any(String) as unknown,
      lastWebhookAt: null,
      webhooksLast24h: 0,
      lastReconcileAt: ctx.status.row.last_reconcile_at,
      lastReconcileError: null,
      deletedCount: 0,
    });
    expect(ctx.status.row.lock_token).toBeNull();
    expect(ctx.audit.entries).toEqual([]);
    const logged = log.mock.calls.map(([message]) => String(message));
    expect(logged.join('\n')).not.toMatch(/mei|wang|example\.com/i);
    expect(logged.at(-1)).toBe(
      'Customer sync tick: mode=incremental pages=2 fetched=2 hasMore=false',
    );
  });

  it('stops at the per-tick page cap and continues on the next tick', async () => {
    const pages = Array.from(
      { length: CUSTOMER_SYNC_TICK_MAX_PAGES + 1 },
      (_, i) =>
        customersPage(
          [
            {
              id: 1000 + i,
              updatedAt: `2026-10-13T10:${String(i).padStart(2, '0')}:00Z`,
            },
          ],
          `cursor-${i + 1}`,
        ),
    );
    const ctx = build(ON, pages);
    await expect(ctx.worker.tick()).resolves.toMatchObject({
      outcome: 'synced',
      result: { pages: CUSTOMER_SYNC_TICK_MAX_PAGES, hasMore: true },
    });
    expect(ctx.graphql).toHaveBeenCalledTimes(CUSTOMER_SYNC_TICK_MAX_PAGES);
    await ctx.worker.tick();
    expect(ctx.graphql.mock.calls[CUSTOMER_SYNC_TICK_MAX_PAGES][1]).toEqual({
      first: 100,
      after: null,
      query: `updated_at:>='2026-10-13T10:${String(CUSTOMER_SYNC_TICK_MAX_PAGES - 1).padStart(2, '0')}:00Z'`,
    });
  });

  it('skips the tick without calling Shopify while another run holds the lock', async () => {
    const ctx = build(ON, [customersPage([])]);
    ctx.status.row.lock_token = 'held-by-another-machine';
    await expect(ctx.worker.tick()).resolves.toEqual({ outcome: 'locked' });
    expect(ctx.graphql).not.toHaveBeenCalled();
    expect(ctx.status.row.lock_token).toBe('held-by-another-machine');
  });

  it('shares one run between overlapping ticks in the same process', async () => {
    const ctx = build(ON, [customersPage([])]);
    const [a, b] = await Promise.all([ctx.worker.tick(), ctx.worker.tick()]);
    expect(a).toBe(b);
    expect(ctx.status.leases).toHaveLength(1);
    expect(ctx.graphql).toHaveBeenCalledTimes(1);
  });

  it('records a failed run, releases the lock and recovers on the next tick', async () => {
    const ctx = build(ON, [
      new ShopifyHttpError(500, 'upstream detail'),
      customersPage([{ id: 7 }]),
    ]);
    ctx.status.row.last_fetched = 3;
    await expect(ctx.worker.tick()).resolves.toEqual({
      outcome: 'failed',
      error: SHOPIFY_REQUEST_FAILED,
    });
    expect(ctx.status.row).toMatchObject({
      lock_token: null,
      last_error: SHOPIFY_REQUEST_FAILED,
      last_fetched: 3,
      last_success_at: null,
    });
    expect(error).toHaveBeenCalledWith(
      `Customer sync tick failed: ${SHOPIFY_REQUEST_FAILED}`,
    );

    await expect(ctx.worker.tick()).resolves.toMatchObject({
      outcome: 'synced',
    });
    expect(ctx.status.row).toMatchObject({ last_error: null, last_fetched: 1 });
  });

  it('does not crash when the lock or the status write fails', async () => {
    const ctx = build(ON, [new Error('socket hang up')]);
    jest.spyOn(ctx.status, 'tryLock').mockRejectedValueOnce('db down');
    await expect(ctx.worker.tick()).resolves.toEqual({
      outcome: 'failed',
      error: 'db down',
    });
    expect(ctx.graphql).not.toHaveBeenCalled();

    jest
      .spyOn(ctx.status, 'finish')
      .mockRejectedValueOnce(new Error('db still down'));
    await expect(ctx.worker.tick()).resolves.toEqual({
      outcome: 'failed',
      error: 'socket hang up',
    });
    expect(error).toHaveBeenCalledWith(
      'Could not record the customer sync failure: db still down',
    );
  });

  it('waits for a running tick on shutdown', async () => {
    const ctx = build(ON, [customersPage([{ id: 9 }])]);
    const running = ctx.worker.tick();
    await ctx.worker.onModuleDestroy();
    expect(ctx.repo.rows).toHaveLength(1);
    await expect(running).resolves.toMatchObject({ outcome: 'synced' });
  });

  describe('incremental watermark', () => {
    const T0 = '2026-10-13T12:00:00.000Z';

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      jest.setSystemTime(new Date(T0));
    });

    it('falls back to the newest stored update once, then syncs from its own watermark two minutes before the last run started', async () => {
      const ctx = build(ON, [
        customersPage([{ id: 1, updatedAt: '2026-10-13T11:00:00Z' }]),
        customersPage([]),
      ]);
      await ctx.repo.upsertMany([
        {
          shopify_customer_id: 1,
          first_name: null,
          last_name: null,
          email: null,
          phone: null,
          shopify_updated_at: '2026-10-13T09:00:00Z',
        },
      ]);

      await ctx.worker.tick();
      expect(ctx.status.watermarks).toEqual(['2026-10-13T11:58:00.000Z']);

      jest.setSystemTime(new Date('2026-10-13T12:15:00.000Z'));
      await ctx.worker.tick();
      expect(ctx.graphql.mock.calls.map((c) => c[1])).toEqual([
        {
          first: 100,
          after: null,
          query: "updated_at:>='2026-10-13T09:00:00Z'",
        },
        {
          first: 100,
          after: null,
          query: "updated_at:>='2026-10-13T11:58:00Z'",
        },
      ]);
      expect(ctx.status.watermarks.at(-1)).toBe('2026-10-13T12:13:00.000Z');
      expect((await ctx.worker.status()).incrementalSince).toBe(
        '2026-10-13T12:13:00.000Z',
      );
    });

    it('does not skip older unfetched changes after a webhook stores a newer updated_at', async () => {
      const ctx = build(ON, [
        customersPage([]),
        customersPage([
          { id: 20, lastName: 'Missed', updatedAt: '2026-10-13T12:05:00Z' },
          { id: 21, lastName: 'Webhook', updatedAt: '2026-10-13T12:20:00Z' },
        ]),
      ]);
      await ctx.worker.tick();

      await ctx.repo.upsertIfNewer({
        shopify_customer_id: 21,
        first_name: null,
        last_name: 'Webhook',
        email: null,
        phone: null,
        shopify_updated_at: '2026-10-13T12:20:00Z',
      });
      await expect(ctx.repo.latestShopifyUpdatedAt()).resolves.toBe(
        '2026-10-13T12:20:00Z',
      );

      jest.setSystemTime(new Date('2026-10-13T12:30:00.000Z'));
      await ctx.worker.tick();
      expect(ctx.graphql.mock.calls[1][1]).toEqual({
        first: 100,
        after: null,
        query: "updated_at:>='2026-10-13T11:58:00Z'",
      });
      expect(ctx.repo.rows.map((r) => r.last_name).sort()).toEqual([
        'Missed',
        'Webhook',
      ]);
    });

    it('keeps the watermark unchanged when the run fails', async () => {
      const ctx = build(ON, [new ShopifyHttpError(500, 'down')]);
      ctx.status.row.incremental_since = '2026-10-13T10:00:00.000Z';
      await expect(ctx.worker.tick()).resolves.toMatchObject({
        outcome: 'failed',
      });
      expect(ctx.status.row.incremental_since).toBe('2026-10-13T10:00:00.000Z');
      expect(ctx.status.watermarks).toEqual([]);
    });
  });

  describe('daily deletion reconcile', () => {
    const T0 = '2026-10-14T03:00:00.000Z';

    function seed(
      repo: InMemoryCustomersRepository,
      ids: number[],
      deletedAt: string | null = null,
    ) {
      for (const id of ids) {
        repo.rows.push({
          id: `row-${id}`,
          shopify_customer_id: id,
          first_name: 'Name',
          last_name: `Last${id}`,
          email: null,
          phone: null,
          shopify_updated_at: '2026-10-01T00:00:00Z',
          shopify_deleted_at: deletedAt,
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-01T00:00:00Z',
        });
      }
    }

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      jest.setSystemTime(new Date(T0));
    });

    it('pages every Shopify id once a day, soft-deletes the missing ones, restores the ones that reappear and logs counts only', async () => {
      const ctx = build(
        ON,
        [
          customersPage([]),
          customerIdsPage([1, 2], 'ids-1'),
          customerIdsPage([4]),
          customersPage([]),
          customersPage([]),
          customerIdsPage([1, 2, 4]),
        ],
        null,
      );
      seed(ctx.repo, [1, 2, 3]);
      seed(ctx.repo, [4], '2026-10-10T00:00:00Z');

      await expect(ctx.worker.tick()).resolves.toMatchObject({
        outcome: 'synced',
      });
      expect(ctx.graphql.mock.calls.slice(1, 3).map((c) => c[1])).toEqual([
        { first: 250, after: null },
        { first: 250, after: 'ids-1' },
      ]);
      expect(
        ctx.repo.rows.map((r) => [r.shopify_customer_id, r.shopify_deleted_at]),
      ).toEqual([
        [1, null],
        [2, null],
        [3, T0],
        [4, null],
      ]);
      expect(ctx.status.row).toMatchObject({
        last_reconcile_at: T0,
        last_reconcile_error: null,
      });
      const logged = log.mock.calls.map(([message]) => String(message));
      expect(logged).toContain(
        'Customer reconcile: shopify=3 local=3 deleted=1 restored=1',
      );
      expect(logged.join('\n')).not.toMatch(/Last\d/);

      jest.setSystemTime(new Date('2026-10-14T20:00:00.000Z'));
      await ctx.worker.tick();
      expect(ctx.graphql).toHaveBeenCalledTimes(4);

      jest.setSystemTime(new Date('2026-10-15T03:00:00.000Z'));
      await ctx.worker.tick();
      expect(ctx.graphql).toHaveBeenCalledTimes(6);
      expect(ctx.status.row.last_reconcile_at).toBe('2026-10-15T03:00:00.000Z');
      const status = await ctx.worker.status();
      expect(status).toMatchObject({
        lastReconcileAt: '2026-10-15T03:00:00.000Z',
        lastReconcileError: null,
        deletedCount: 1,
      });
    });

    it('refuses to mass-delete when Shopify lists fewer than half of the active customers and records why', async () => {
      const ctx = build(ON, [customersPage([]), customerIdsPage([1])], null);
      seed(ctx.repo, [1, 2, 3]);

      await expect(ctx.worker.tick()).resolves.toMatchObject({
        outcome: 'synced',
      });
      expect(ctx.repo.rows.every((r) => r.shopify_deleted_at === null)).toBe(
        true,
      );
      expect(ctx.repo.reconcileCalls).toEqual([]);
      const message =
        'Shopify listed 1 customers but 3 are active here; deletions were not applied';
      expect(ctx.status.row).toMatchObject({
        last_reconcile_at: T0,
        last_reconcile_error: message,
        last_error: null,
      });
      expect(error).toHaveBeenCalledWith(
        `Customer reconcile failed: ${message}`,
      );
      await expect(ctx.worker.status()).resolves.toMatchObject({
        lastReconcileError: message,
        deletedCount: 0,
      });
    });

    it('applies deletions when Shopify lists exactly half of the active customers', async () => {
      const ctx = build(ON, [customersPage([]), customerIdsPage([1, 2])], null);
      seed(ctx.repo, [1, 2, 3, 4]);
      await ctx.worker.tick();
      expect(ctx.repo.rows.filter((r) => r.shopify_deleted_at)).toHaveLength(2);
      expect(ctx.status.row.last_reconcile_error).toBeNull();
    });

    it('aborts without deleting when Shopify keeps paging past the cap', async () => {
      const pages = Array.from({ length: RECONCILE_MAX_PAGES }, (_, i) =>
        customerIdsPage([i + 1], `ids-${i + 1}`),
      );
      const ctx = build(ON, [customersPage([]), ...pages], null);
      seed(ctx.repo, [9999]);
      await ctx.worker.tick();
      expect(ctx.repo.reconcileCalls).toEqual([]);
      expect(ctx.status.row.last_reconcile_error).toBe(
        `Shopify still had more customers after ${RECONCILE_MAX_PAGES} pages; deletions were not applied`,
      );
    });

    it('records a Shopify failure during the reconcile without failing the sync', async () => {
      const ctx = build(
        ON,
        [customersPage([]), new ShopifyHttpError(503, 'busy')],
        null,
      );
      seed(ctx.repo, [1]);
      await expect(ctx.worker.tick()).resolves.toMatchObject({
        outcome: 'synced',
      });
      expect(ctx.status.row.last_reconcile_error).toMatch(/503/);
      expect(ctx.repo.rows[0].shopify_deleted_at).toBeNull();
    });
  });

  describe('webhook events', () => {
    it('prunes events older than 30 days on each tick and reports the last day of deliveries', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      jest.setSystemTime(new Date('2026-10-14T03:00:00.000Z'));
      const ctx = build(ON, [customersPage([])]);
      const event = (id: string, receivedAt: string) => ({
        webhook_id: id,
        topic: 'customers/update',
        shopify_customer_id: 1,
        triggered_at: null,
        received_at: receivedAt,
        processed_at: receivedAt,
        error: null,
      });
      ctx.events.rows.push(
        event('old', '2026-09-13T02:59:59.000Z'),
        event('kept', '2026-09-20T00:00:00.000Z'),
        event('recent', '2026-10-14T02:00:00.000Z'),
      );

      await ctx.worker.tick();

      expect(ctx.events.rows.map((r) => r.webhook_id)).toEqual([
        'kept',
        'recent',
      ]);
      await expect(ctx.worker.status()).resolves.toMatchObject({
        lastWebhookAt: '2026-10-14T02:00:00.000Z',
        webhooksLast24h: 1,
      });
    });

    it('logs a failed prune and still finishes the tick', async () => {
      const ctx = build(ON, [customersPage([])]);
      jest.spyOn(ctx.events, 'prune').mockRejectedValueOnce(new Error('gone'));
      await expect(ctx.worker.tick()).resolves.toMatchObject({
        outcome: 'synced',
      });
      expect(error).toHaveBeenCalledWith(
        'Could not prune Shopify webhook events: gone',
      );
      expect(ctx.status.row.last_error).toBeNull();
    });
  });
});
