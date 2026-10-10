import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  FakeShopify,
  INSTRUCTOR_ID,
  InMemorySettingsRepository,
  InMemorySyncRepository,
  snapshotOf,
} from '../../test/helpers/shopify-sync-fakes';
import { InstructorPhotoSync } from './instructor-photo.sync';
import { InstructorSyncService } from './instructor-sync.service';
import { InstructorTranslationsSync } from './instructor-translations.sync';
import {
  SETTINGS_CACHE_MS,
  ShopifySyncSettings,
} from './shopify-sync-settings.service';
import { ShopifyInstructorGateway } from './shopify-instructor.gateway';
import {
  MAX_SYNC_ATTEMPTS,
  ShopifySyncWorker,
  SYNC_BATCH_SIZE,
  SYNC_POLL_INTERVAL_MS,
} from './shopify-sync.worker';

const anyString: unknown = expect.any(String);
const enabledEnv = {
  SHOPIFY_SYNC_ENABLED: 'true',
  SHOPIFY_SHOP: 'acme',
  SHOPIFY_CLIENT_ID: 'id',
  SHOPIFY_CLIENT_SECRET: 'secret',
};
const T0 = '2026-10-10T03:00:00.000001+00:00';
const T1 = '2026-10-10T03:00:04.000002+00:00';

function setup(
  env: Record<string, string | undefined> = enabledEnv,
  flag = true,
) {
  const repo = new InMemorySyncRepository();
  const settingsRepo = new InMemorySettingsRepository(repo);
  settingsRepo.settings!.enabled = flag;
  repo.snapshots.set(INSTRUCTOR_ID, snapshotOf());
  const shopify = new FakeShopify();
  const gateway = new ShopifyInstructorGateway(shopify.client);
  const sync = new InstructorSyncService(
    repo,
    gateway,
    new InstructorPhotoSync(repo, gateway, { sleep: () => Promise.resolve() }),
    new InstructorTranslationsSync(gateway),
  );
  const config = { get: (key: string) => env[key] } as ConfigService;
  const worker = new ShopifySyncWorker(
    config,
    repo,
    sync,
    new ShopifySyncSettings(settingsRepo),
  );
  const enqueue = (instructorId: string, enqueuedAt: string, attempts = 0) =>
    repo.queue.set(instructorId, {
      instructor_id: instructorId,
      enqueued_at: enqueuedAt,
      attempts,
      last_error: null,
    });
  return { repo, settingsRepo, shopify, sync, worker, enqueue };
}

describe('ShopifySyncWorker', () => {
  let logs: jest.SpyInstance;

  beforeEach(() => {
    logs = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('kill switch', () => {
    it.each([
      ['unset', {}, 'SHOPIFY_SYNC_ENABLED is not "true"'],
      [
        'not exactly true',
        { ...enabledEnv, SHOPIFY_SYNC_ENABLED: '1' },
        'SHOPIFY_SYNC_ENABLED is not "true"',
      ],
      [
        'credentials missing',
        { SHOPIFY_SYNC_ENABLED: 'true', SHOPIFY_SHOP: 'acme' },
        'missing SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET',
      ],
    ])('stays off when %s and makes no calls', async (_label, env, reason) => {
      jest.useFakeTimers();
      const { repo, shopify, worker, enqueue } = setup(env);
      enqueue(INSTRUCTOR_ID, T0);

      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS * 3);

      expect(logs).toHaveBeenCalledTimes(1);
      expect(logs).toHaveBeenCalledWith(`Shopify sync disabled: ${reason}`);
      expect(repo.claimCalls).toHaveLength(0);
      expect(shopify.client.graphql).not.toHaveBeenCalled();
      expect(repo.queue.size).toBe(1);
      await worker.onModuleDestroy();
    });

    it('rethrows unexpected config errors', () => {
      const config = {
        get: (key: string) => {
          if (key === 'SHOPIFY_SYNC_ENABLED') return 'true';
          throw new Error('config exploded');
        },
      } as ConfigService;
      const worker = new ShopifySyncWorker(
        config,
        new InMemorySyncRepository(),
        {} as InstructorSyncService,
        {} as ShopifySyncSettings,
      );
      expect(() => worker.mode()).toThrow('config exploded');
    });

    it('polls every 5s when enabled and stops on shutdown', async () => {
      jest.useFakeTimers();
      const { repo, shopify, worker, enqueue } = setup();
      enqueue(INSTRUCTOR_ID, T0);

      worker.onModuleInit();
      expect(logs).toHaveBeenCalledWith(
        'Shopify sync enabled for acme; polling every 5s',
      );
      expect(repo.claimCalls).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS);

      expect(repo.claimCalls).toEqual([
        { limit: SYNC_BATCH_SIZE, maxAttempts: MAX_SYNC_ATTEMPTS },
      ]);
      expect(shopify.entry('eddie-chen')?.status).toBe('ACTIVE');
      expect(repo.queue.size).toBe(0);

      await worker.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS * 3);
      expect(repo.claimCalls).toHaveLength(1);
    });
  });

  it('deletes the queue row after a successful push', async () => {
    const { repo, worker, enqueue } = setup();
    enqueue(INSTRUCTOR_ID, T0);
    await expect(worker.tick()).resolves.toBe(1);
    expect(repo.queue.size).toBe(0);
  });

  it('keeps the row when the instructor was re-enqueued during the push', async () => {
    const { repo, worker, enqueue } = setup();
    enqueue(INSTRUCTOR_ID, T0);
    repo.onSync = () => enqueue(INSTRUCTOR_ID, T1);

    await worker.tick();

    expect(repo.queue.get(INSTRUCTOR_ID)).toMatchObject({
      enqueued_at: T1,
      attempts: 0,
    });
  });

  it('records the failure and bumps attempts so the claim backs off', async () => {
    const { repo, shopify, worker, enqueue } = setup();
    enqueue(INSTRUCTOR_ID, T0, 2);
    shopify.failNext('SsmsInstructorUpsert', [
      { field: ['name'], message: 'is blank', code: 'BLANK' },
    ]);

    await worker.tick();

    expect(repo.queue.get(INSTRUCTOR_ID)).toMatchObject({
      enqueued_at: T0,
      attempts: 3,
      last_error: 'metaobjectUpsert returned user errors: name: is blank',
    });
  });

  it('keeps processing the rest of the batch after one failure', async () => {
    const { repo, worker, enqueue } = setup();
    const other = '9b8a7c6d-0000-4000-8000-000000000001';
    enqueue(other, T0);
    enqueue(INSTRUCTOR_ID, T1);
    repo.loadSnapshot = (id: string) =>
      id === other
        ? Promise.reject(new Error('db down'))
        : Promise.resolve(snapshotOf());

    await expect(worker.tick()).resolves.toBe(2);

    expect(repo.queue.get(other)?.last_error).toBe('db down');
    expect(repo.queue.has(INSTRUCTOR_ID)).toBe(false);
  });

  it('truncates long errors and survives failing bookkeeping', async () => {
    const { repo, worker, enqueue } = setup();
    enqueue(INSTRUCTOR_ID, T0);
    repo.loadSnapshot = () => Promise.reject(new Error('x'.repeat(5_000)));
    const recorded: string[] = [];
    repo.recordQueueFailure = (_row, message) => {
      recorded.push(message);
      return Promise.reject(new Error('db down'));
    };

    await expect(worker.tick()).resolves.toBe(1);
    expect(recorded[0]).toHaveLength(2_000);
  });

  it('returns 0 when the claim fails', async () => {
    const { repo, worker } = setup();
    repo.claimQueueBatch = () => Promise.reject(new Error('rpc missing'));
    await expect(worker.tick()).resolves.toBe(0);
  });

  it('never runs two drains at once', async () => {
    const { repo, worker, enqueue } = setup();
    enqueue(INSTRUCTOR_ID, T0);
    const first = worker.tick();
    const second = worker.tick();
    expect(second).toBe(first);
    await first;
    expect(repo.claimCalls).toHaveLength(1);
  });

  describe('admin gate', () => {
    const masterOff = { ...enabledEnv, SHOPIFY_SYNC_ENABLED: 'false' };
    const unconfigured = { SHOPIFY_SYNC_ENABLED: 'true' };

    it.each([
      ['env on', enabledEnv, true, true],
      ['env on', enabledEnv, false, false],
      ['master switch off', masterOff, true, false],
      ['master switch off', masterOff, false, false],
      ['credentials missing', unconfigured, true, false],
      ['credentials missing', unconfigured, false, false],
    ])(
      'with %s and flag %s processes the queue: %s',
      async (_label, env, flag, processes) => {
        const { repo, settingsRepo, shopify, worker, enqueue } = setup(
          env,
          flag,
        );
        enqueue(INSTRUCTOR_ID, T0);

        await expect(worker.tick()).resolves.toBe(processes ? 1 : 0);

        expect(repo.claimCalls).toHaveLength(processes ? 1 : 0);
        expect(repo.queue.size).toBe(processes ? 0 : 1);
        expect(shopify.entry('eddie-chen')?.status).toBe(
          processes ? 'ACTIVE' : undefined,
        );
        expect(settingsRepo.heartbeats.length > 0).toBe(processes);
      },
    );

    it('stops at the next tick after being turned off and keeps the queue', async () => {
      jest.useFakeTimers();
      const { repo, settingsRepo, worker, enqueue } = setup();
      enqueue(INSTRUCTOR_ID, T0);
      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS);
      expect(repo.queue.size).toBe(0);

      settingsRepo.settings!.enabled = false;
      enqueue(INSTRUCTOR_ID, T1);
      await jest.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS * 3);

      expect(repo.claimCalls).toHaveLength(1);
      expect(repo.queue.get(INSTRUCTOR_ID)?.enqueued_at).toBe(T1);

      settingsRepo.settings!.enabled = true;
      await jest.advanceTimersByTimeAsync(SYNC_POLL_INTERVAL_MS);
      expect(repo.queue.size).toBe(0);
      await worker.onModuleDestroy();
    });

    it('reads the flag at most once per cache window', async () => {
      jest.useFakeTimers();
      const { settingsRepo, worker } = setup();

      await worker.tick();
      await worker.tick();
      expect(settingsRepo.settingsReads).toBe(1);

      await jest.advanceTimersByTimeAsync(SETTINGS_CACHE_MS);
      await worker.tick();
      expect(settingsRepo.settingsReads).toBe(2);
    });

    it('treats a missing settings row as off', async () => {
      const { repo, settingsRepo, worker, enqueue } = setup();
      settingsRepo.settings = null;
      enqueue(INSTRUCTOR_ID, T0);
      await expect(worker.tick()).resolves.toBe(0);
      expect(repo.claimCalls).toHaveLength(0);
    });

    it('treats an unreadable flag as off', async () => {
      const { repo, settingsRepo, worker, enqueue } = setup();
      settingsRepo.getSettings = () => Promise.reject(new Error('db down'));
      enqueue(INSTRUCTOR_ID, T0);
      await expect(worker.tick()).resolves.toBe(0);
      expect(repo.claimCalls).toHaveLength(0);
      expect(repo.queue.size).toBe(1);
    });
  });

  describe('heartbeat', () => {
    it('records the tick and the success time after a push', async () => {
      const { settingsRepo, worker, enqueue } = setup();
      enqueue(INSTRUCTOR_ID, T0);

      await worker.tick();

      expect(settingsRepo.settings).toMatchObject({
        last_tick_at: anyString,
        last_success_at: anyString,
        last_error: null,
        last_error_at: null,
      });
    });

    it('records a tick with no success when the queue is empty', async () => {
      const { settingsRepo, worker } = setup();
      await worker.tick();
      expect(settingsRepo.settings?.last_tick_at).toEqual(anyString);
      expect(settingsRepo.settings?.last_success_at).toBeNull();
    });

    it('records the failing instructor and error', async () => {
      const { settingsRepo, worker, enqueue } = setup();
      enqueue(INSTRUCTOR_ID, T0);
      settingsRepo.settings!.last_success_at = T0;
      jest
        .spyOn(InMemorySyncRepository.prototype, 'loadSnapshot')
        .mockRejectedValue(new Error('db down'));

      await worker.tick();

      expect(settingsRepo.settings).toMatchObject({
        last_success_at: T0,
        last_error: `${INSTRUCTOR_ID}: db down`,
        last_error_at: anyString,
      });
    });

    it('records a failed claim', async () => {
      const { repo, settingsRepo, worker } = setup();
      repo.claimQueueBatch = () => Promise.reject(new Error('rpc missing'));
      await worker.tick();
      expect(settingsRepo.settings?.last_error).toBe(
        'Could not claim sync rows: rpc missing',
      );
    });

    it('keeps syncing when the heartbeat cannot be written', async () => {
      const { repo, settingsRepo, worker, enqueue } = setup();
      enqueue(INSTRUCTOR_ID, T0);
      settingsRepo.recordHeartbeat = () => Promise.reject(new Error('db down'));

      await expect(worker.tick()).resolves.toBe(1);
      expect(repo.queue.size).toBe(0);
    });
  });
});
