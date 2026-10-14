import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  customersPage,
  fakeShopifyGraphql,
  InMemoryCustomersRepository,
  InMemoryCustomerSyncStatusRepository,
} from '../../test/helpers/customers-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import type { AuditService } from '../audit/audit.service';
import { ShopifyHttpError } from '../shopify/shopify.errors';
import { SHOPIFY_REQUEST_FAILED } from './customer-errors';
import { CustomerSyncService } from './customer-sync.service';
import {
  CUSTOMER_SYNC_LEASE_SECONDS,
  CUSTOMER_SYNC_TICK_MAX_PAGES,
  CustomerSyncWorker,
  customerSyncIntervalMinutes,
} from './customer-sync.worker';
import { ShopifyCustomerDirectory } from './shopify-customers';

const MINUTE = 60_000;

function build(env: Record<string, string>, responses: unknown[] = []) {
  const config = new ConfigService(env);
  const repo = new InMemoryCustomersRepository();
  const status = new InMemoryCustomerSyncStatusRepository();
  const audit = recordingAudit();
  const shopify = fakeShopifyGraphql(responses);
  const sync = new CustomerSyncService(
    config,
    new ShopifyCustomerDirectory(shopify.client),
    repo,
    audit as unknown as AuditService,
  );
  return {
    repo,
    status,
    audit,
    graphql: shopify.graphql,
    worker: new CustomerSyncWorker(config, sync, status),
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
});
