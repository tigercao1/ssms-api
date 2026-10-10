import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readShopifyConfig } from '../shopify/shopify.config';
import { ShopifyConfigError } from '../shopify/shopify.errors';
import { InstructorSyncRepository } from './instructor-sync.repository';
import { InstructorSyncService } from './instructor-sync.service';
import type { SyncQueueRow } from './instructor-sync.types';

export const SYNC_POLL_INTERVAL_MS = 5_000;
export const SYNC_BATCH_SIZE = 10;
export const MAX_SYNC_ATTEMPTS = 10;
export const MAX_ERROR_LENGTH = 2_000;

export type SyncMode =
  | { enabled: true; shop: string }
  | { enabled: false; reason: string };

@Injectable()
export class ShopifySyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShopifySyncWorker.name);
  private timer?: NodeJS.Timeout;
  private draining?: Promise<number>;

  constructor(
    private readonly config: ConfigService,
    private readonly repo: InstructorSyncRepository,
    private readonly sync: InstructorSyncService,
  ) {}

  mode(): SyncMode {
    if (this.config.get<string>('SHOPIFY_SYNC_ENABLED')?.trim() !== 'true') {
      return { enabled: false, reason: 'SHOPIFY_SYNC_ENABLED is not "true"' };
    }
    try {
      const { shop } = readShopifyConfig((key) => this.config.get<string>(key));
      return { enabled: true, shop };
    } catch (err) {
      if (err instanceof ShopifyConfigError) {
        return {
          enabled: false,
          reason: `missing ${err.missing.join(', ')}`,
        };
      }
      throw err;
    }
  }

  onModuleInit(): void {
    const mode = this.mode();
    if (!mode.enabled) {
      this.logger.log(`Shopify sync disabled: ${mode.reason}`);
      return;
    }
    this.logger.log(
      `Shopify sync enabled for ${mode.shop}; polling every ${SYNC_POLL_INTERVAL_MS / 1000}s`,
    );
    this.timer = setInterval(() => void this.tick(), SYNC_POLL_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.draining;
  }

  tick(): Promise<number> {
    this.draining ??= this.drain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async drain(): Promise<number> {
    let rows: SyncQueueRow[];
    try {
      rows = await this.repo.claimQueueBatch(
        SYNC_BATCH_SIZE,
        MAX_SYNC_ATTEMPTS,
      );
    } catch (err) {
      this.logger.error(`Could not claim sync rows: ${messageOf(err)}`);
      return 0;
    }
    for (const row of rows) {
      try {
        const outcome = await this.sync.sync(row.instructor_id);
        await this.repo.completeQueueRow(row);
        this.logger.log(`Synced instructor ${row.instructor_id}: ${outcome}`);
      } catch (err) {
        const message = messageOf(err).slice(0, MAX_ERROR_LENGTH);
        this.logger.warn(
          `Sync of instructor ${row.instructor_id} failed (attempt ${row.attempts + 1}): ${message}`,
        );
        await this.repo
          .recordQueueFailure(row, message)
          .catch((e) =>
            this.logger.error(
              `Could not record sync failure for ${row.instructor_id}: ${messageOf(e)}`,
            ),
          );
      }
    }
    return rows.length;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
