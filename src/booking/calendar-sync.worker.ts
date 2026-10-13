import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BOOKING_CLOCK, type BookingClock } from './booking-calendars.service';
import { BookingRepository } from './booking.repository';
import { CalendarSyncService } from './calendar-sync.service';

export const CALENDAR_SYNC_FLAG = 'BOOKING_CALENDAR_SYNC_ENABLED';
export const CALENDAR_SYNC_INTERVAL_MS = 60_000;
export const MAX_CALENDAR_SYNC_ATTEMPTS = 10;
export const CALENDAR_SYNC_BATCH_SIZE = 25;
export const CALENDAR_SYNC_SCAN_SIZE = 200;
export const CALENDAR_SYNC_BASE_BACKOFF_MS = 60_000;
export const CALENDAR_SYNC_MAX_BACKOFF_MS = 3_600_000;

export interface CalendarSyncRun {
  classes: number;
  deletions: number;
}

export function calendarSyncBackoffMs(attempts: number): number {
  return Math.min(
    CALENDAR_SYNC_BASE_BACKOFF_MS * 2 ** attempts,
    CALENDAR_SYNC_MAX_BACKOFF_MS,
  );
}

@Injectable()
export class CalendarSyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CalendarSyncWorker.name);
  private timer?: NodeJS.Timeout;
  private draining?: Promise<CalendarSyncRun>;

  constructor(
    private readonly config: ConfigService,
    private readonly repo: BookingRepository,
    private readonly sync: CalendarSyncService,
    @Inject(BOOKING_CLOCK) private readonly clock: BookingClock,
  ) {}

  enabled(): boolean {
    return this.config.get<string>(CALENDAR_SYNC_FLAG)?.trim() === 'true';
  }

  onModuleInit(): void {
    if (!this.enabled()) {
      this.logger.log(
        `Calendar sync reconciler disabled: ${CALENDAR_SYNC_FLAG} is not "true"`,
      );
      return;
    }
    this.logger.log(
      `Calendar sync reconciler enabled; polling every ${CALENDAR_SYNC_INTERVAL_MS / 1000}s`,
    );
    this.timer = setInterval(() => void this.tick(), CALENDAR_SYNC_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.draining;
  }

  tick(): Promise<CalendarSyncRun> {
    this.draining ??= this.run().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async run(): Promise<CalendarSyncRun> {
    const idle = { classes: 0, deletions: 0 };
    if (!this.enabled()) {
      return idle;
    }
    try {
      if (!(await this.sync.isConnected())) {
        return idle;
      }
      const now = this.clock.now();
      const classes = (
        await this.repo.classesToSync(
          MAX_CALENDAR_SYNC_ATTEMPTS,
          CALENDAR_SYNC_SCAN_SIZE,
        )
      )
        .filter((c) => due(c.updated_at, c.google_sync_attempts, now))
        .slice(0, CALENDAR_SYNC_BATCH_SIZE);
      for (const candidate of classes) {
        await this.sync.syncClass(candidate.id);
      }
      const deletions = (
        await this.repo.openDeletions(
          MAX_CALENDAR_SYNC_ATTEMPTS,
          CALENDAR_SYNC_SCAN_SIZE,
        )
      )
        .filter((d) =>
          due(d.last_attempt_at ?? d.created_at, d.attempts, this.clock.now()),
        )
        .slice(0, CALENDAR_SYNC_BATCH_SIZE);
      await this.sync.processDeletions(deletions);
      return { classes: classes.length, deletions: deletions.length };
    } catch (err) {
      this.logger.error(
        `Calendar sync reconciler failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return idle;
    }
  }
}

function due(since: string, attempts: number, now: number): boolean {
  return Date.parse(since) + calendarSyncBackoffMs(attempts) <= now;
}
