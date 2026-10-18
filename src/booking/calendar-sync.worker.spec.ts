import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { InMemoryBookingRepository } from '../../test/helpers/booking-fakes';
import type { CalendarSyncService } from './calendar-sync.service';
import {
  CALENDAR_SYNC_INTERVAL_MS,
  CalendarSyncWorker,
  calendarSyncBackoffMs,
} from './calendar-sync.worker';

function worker(flag: string | undefined, processGroup?: string) {
  const repo = new InMemoryBookingRepository();
  const sync = {
    isConnected: jest.fn(() => Promise.resolve(true)),
    syncClass: jest.fn(() => Promise.resolve(null)),
    processDeletions: jest.fn(() => Promise.resolve(null)),
  };
  const config = {
    get: (key: string) => (key === 'FLY_PROCESS_GROUP' ? processGroup : flag),
  } as unknown as ConfigService;
  const clock = { now: () => Date.parse('2026-12-10T17:00:00.000Z') };
  return {
    repo,
    sync,
    worker: new CalendarSyncWorker(
      config,
      repo,
      sync as unknown as CalendarSyncService,
      clock,
    ),
  };
}

describe('CalendarSyncWorker', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('never schedules itself unless the flag is "true"', async () => {
    jest.useFakeTimers();
    const { worker: w, sync } = worker(undefined);
    w.onModuleInit();
    jest.advanceTimersByTime(5 * CALENDAR_SYNC_INTERVAL_MS);
    expect(sync.isConnected).not.toHaveBeenCalled();
    await w.onModuleDestroy();
  });

  it('does not poll in the web process group', async () => {
    jest.useFakeTimers();
    const { worker: w, sync } = worker('true', 'app');
    w.onModuleInit();
    jest.advanceTimersByTime(5 * CALENDAR_SYNC_INTERVAL_MS);
    expect(sync.isConnected).not.toHaveBeenCalled();
    await w.onModuleDestroy();
  });

  it('polls every minute when enabled and stops on shutdown', async () => {
    jest.useFakeTimers();
    const { worker: w, sync } = worker(' true ');
    w.onModuleInit();
    jest.advanceTimersByTime(CALENDAR_SYNC_INTERVAL_MS);
    await w.onModuleDestroy();
    expect(sync.isConnected).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5 * CALENDAR_SYNC_INTERVAL_MS);
    expect(sync.isConnected).toHaveBeenCalledTimes(1);
  });

  it('shares one run between overlapping ticks', async () => {
    const { worker: w, sync } = worker('true');
    await Promise.all([w.tick(), w.tick()]);
    expect(sync.isConnected).toHaveBeenCalledTimes(1);
  });

  it('logs and backs off when the database fails', async () => {
    const { worker: w, repo } = worker('true');
    jest
      .spyOn(repo, 'classesToSync')
      .mockRejectedValueOnce(new Error('db down'));
    await expect(w.tick()).resolves.toEqual({ classes: 0, deletions: 0 });
    jest.spyOn(repo, 'classesToSync').mockRejectedValueOnce('db down');
    await expect(w.tick()).resolves.toEqual({ classes: 0, deletions: 0 });
  });

  it('doubles the backoff per attempt up to an hour', () => {
    expect([0, 1, 2, 9].map(calendarSyncBackoffMs)).toEqual([
      60_000, 120_000, 240_000, 3_600_000,
    ]);
  });
});
