import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CUSTOMER_SYNC_FLAG } from './customer-errors';
import { CustomerSyncStatusRepository } from './customer-sync-status.repository';
import {
  CustomerSyncService,
  type CustomerSyncResult,
} from './customer-sync.service';

export const CUSTOMER_SYNC_INTERVAL_KEY = 'CUSTOMER_SYNC_INTERVAL_MINUTES';
export const DEFAULT_CUSTOMER_SYNC_INTERVAL_MINUTES = 15;
export const MAX_CUSTOMER_SYNC_INTERVAL_MINUTES = 1440;
export const CUSTOMER_SYNC_TICK_MAX_PAGES = 20;
export const CUSTOMER_SYNC_LEASE_SECONDS = 600;
export const MAX_CUSTOMER_SYNC_ERROR_LENGTH = 2_000;

export type CustomerSyncTick =
  | { outcome: 'off' | 'locked' }
  | { outcome: 'synced'; result: CustomerSyncResult }
  | { outcome: 'failed'; error: string };

export interface CustomerSyncStatus {
  scheduled: boolean;
  intervalMinutes: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastFetched: number | null;
  lastError: string | null;
}

export function customerSyncIntervalMinutes(config: ConfigService): number {
  const raw = config.get<string>(CUSTOMER_SYNC_INTERVAL_KEY)?.trim();
  if (!raw) {
    return DEFAULT_CUSTOMER_SYNC_INTERVAL_MINUTES;
  }
  const minutes = Number(raw);
  return Number.isInteger(minutes) &&
    minutes >= 0 &&
    minutes <= MAX_CUSTOMER_SYNC_INTERVAL_MINUTES
    ? minutes
    : 0;
}

@Injectable()
export class CustomerSyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CustomerSyncWorker.name);
  private timer?: NodeJS.Timeout;
  private draining?: Promise<CustomerSyncTick>;

  constructor(
    private readonly config: ConfigService,
    private readonly sync: CustomerSyncService,
    private readonly statusRepo: CustomerSyncStatusRepository,
  ) {}

  intervalMinutes(): number {
    return customerSyncIntervalMinutes(this.config);
  }

  scheduled(): boolean {
    return this.sync.isEnabled() && this.intervalMinutes() > 0;
  }

  onModuleInit(): void {
    if (!this.sync.isEnabled()) {
      this.logger.log(
        `Scheduled customer sync disabled: ${CUSTOMER_SYNC_FLAG} is not "true"`,
      );
      return;
    }
    const minutes = this.intervalMinutes();
    if (minutes === 0) {
      this.logger.log(
        `Scheduled customer sync disabled: ${CUSTOMER_SYNC_INTERVAL_KEY} is 0 or invalid`,
      );
      return;
    }
    this.logger.log(`Scheduled customer sync every ${minutes} min`);
    this.timer = setInterval(() => void this.tick(), minutes * 60_000);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.draining;
  }

  tick(): Promise<CustomerSyncTick> {
    this.draining ??= this.run().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  async status(): Promise<CustomerSyncStatus> {
    const row = await this.statusRepo.status();
    return {
      scheduled: this.scheduled(),
      intervalMinutes: this.intervalMinutes(),
      lastStartedAt: row?.last_started_at ?? null,
      lastFinishedAt: row?.last_finished_at ?? null,
      lastSuccessAt: row?.last_success_at ?? null,
      lastFetched: row?.last_fetched ?? null,
      lastError: row?.last_error ?? null,
    };
  }

  private async run(): Promise<CustomerSyncTick> {
    if (!this.scheduled()) {
      return { outcome: 'off' };
    }
    let token: string | null;
    try {
      token = await this.statusRepo.tryLock(CUSTOMER_SYNC_LEASE_SECONDS);
    } catch (err) {
      const error = messageOf(err);
      this.logger.error(`Customer sync tick could not take the lock: ${error}`);
      return { outcome: 'failed', error };
    }
    if (!token) {
      this.logger.log('Customer sync tick skipped: another run holds the lock');
      return { outcome: 'locked' };
    }
    try {
      const result = await this.sync.syncIncremental(
        CUSTOMER_SYNC_TICK_MAX_PAGES,
      );
      await this.statusRepo.finish(token, {
        fetched: result.fetched,
        error: null,
      });
      this.logger.log(
        `Customer sync tick: mode=${result.mode} pages=${result.pages} fetched=${result.fetched} hasMore=${result.hasMore}`,
      );
      return { outcome: 'synced', result };
    } catch (err) {
      const error = messageOf(err).slice(0, MAX_CUSTOMER_SYNC_ERROR_LENGTH);
      this.logger.error(`Customer sync tick failed: ${error}`);
      await this.statusRepo
        .finish(token, { fetched: null, error })
        .catch((e) =>
          this.logger.error(
            `Could not record the customer sync failure: ${messageOf(e)}`,
          ),
        );
      return { outcome: 'failed', error };
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
