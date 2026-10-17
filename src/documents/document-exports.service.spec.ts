import { Logger } from '@nestjs/common';
import { DocumentExportQueue } from './document-export-queue';
import type { DocumentExportsRepository } from './document-exports.repository';
import {
  DocumentExportsService,
  EXPORT_HEARTBEAT_INTERVAL_MS,
  EXPORT_INTERRUPTED,
  EXPORT_RECOVERY_INTERVAL_MS,
} from './document-exports.service';

describe('DocumentExportsService timers', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-17T12:00:00Z') });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('recovers on boot, heartbeats every 15 s, recovers every minute, and stops on shutdown', async () => {
    const repo = {
      heartbeat: jest.fn().mockResolvedValue(0),
      failStale: jest.fn().mockResolvedValue(1),
    };
    const service = new DocumentExportsService(
      repo as unknown as DocumentExportsRepository,
      {} as never,
      {} as never,
      new DocumentExportQueue(),
      {} as never,
      { id: 'owner-a' },
    );

    await service.onApplicationBootstrap();
    expect(repo.failStale).toHaveBeenCalledWith(
      '2026-10-17T11:58:00.000Z',
      EXPORT_INTERRUPTED,
      '2026-10-17T12:00:00.000Z',
    );

    await jest.advanceTimersByTimeAsync(EXPORT_RECOVERY_INTERVAL_MS);
    expect(repo.heartbeat).toHaveBeenCalledTimes(
      EXPORT_RECOVERY_INTERVAL_MS / EXPORT_HEARTBEAT_INTERVAL_MS,
    );
    expect(repo.heartbeat).toHaveBeenLastCalledWith(
      'owner-a',
      '2026-10-17T12:01:00.000Z',
    );
    expect(repo.failStale).toHaveBeenCalledTimes(2);

    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(5 * EXPORT_RECOVERY_INTERVAL_MS);
    expect(repo.heartbeat).toHaveBeenCalledTimes(4);
    expect(repo.failStale).toHaveBeenCalledTimes(2);
  });
});
