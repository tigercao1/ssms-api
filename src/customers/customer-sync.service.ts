import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import {
  CUSTOMER_SYNC_FLAG,
  syncDisabled,
  toHttpError,
} from './customer-errors';
import { CustomerSyncStatusRepository } from './customer-sync-status.repository';
import { CustomersRepository } from './customers.repository';
import { toCustomerUpsert } from './customers.types';
import {
  type ShopifyCustomerPage,
  ShopifyCustomerDirectory,
} from './shopify-customers';

export const MAX_SYNC_PAGES_PER_RUN = 50;
export const CURSOR_NEEDS_FULL = 'cursor is only valid with full=true';
export const INCREMENTAL_OVERLAP_MS = 2 * 60_000;

export interface CustomerSyncOptions {
  full?: boolean;
  cursor?: string;
}

export interface CustomerSyncResult {
  mode: 'backfill' | 'incremental';
  updatedSince: string | null;
  pages: number;
  fetched: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export function isCustomerSyncEnabled(config: ConfigService): boolean {
  return config.get<string>(CUSTOMER_SYNC_FLAG)?.trim() === 'true';
}

function toShopifySearchTime(value: string): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

@Injectable()
export class CustomerSyncService {
  private readonly logger = new Logger(CustomerSyncService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly directory: ShopifyCustomerDirectory,
    private readonly repo: CustomersRepository,
    private readonly audit: AuditService,
    private readonly statusRepo: CustomerSyncStatusRepository,
  ) {}

  isEnabled(): boolean {
    return isCustomerSyncEnabled(this.config);
  }

  async sync(
    actor: AuditActor,
    options: CustomerSyncOptions = {},
  ): Promise<CustomerSyncResult> {
    if (!this.isEnabled()) {
      throw syncDisabled();
    }
    if (options.cursor && !options.full) {
      throw new BadRequestException(CURSOR_NEEDS_FULL);
    }
    const result = await this.run(options, MAX_SYNC_PAGES_PER_RUN);
    await this.audit.record({
      action: AUDIT_ACTIONS.customerSync,
      actor: { ...actor, role: 'admin' },
      metadata: { ...result },
    });
    return result;
  }

  syncIncremental(maxPages: number): Promise<CustomerSyncResult> {
    return this.run({}, maxPages);
  }

  private async run(
    options: CustomerSyncOptions,
    maxPages: number,
  ): Promise<CustomerSyncResult> {
    const startedAt = Date.now();
    const since = options.full ? null : await this.incrementalSince();
    const updatedSince = since ? toShopifySearchTime(since) : null;
    let after = options.full ? (options.cursor ?? null) : null;
    let pages = 0;
    let fetched = 0;
    let newest: number | null = null;
    let page: ShopifyCustomerPage | null = null;
    while (pages < maxPages) {
      try {
        page = await this.directory.page(after, updatedSince);
      } catch (err) {
        throw toHttpError(err, this.logger);
      }
      pages++;
      fetched += page.customers.length;
      newest = page.customers.reduce(
        (max, c) =>
          c.updatedAt ? Math.max(max ?? 0, Date.parse(c.updatedAt)) : max,
        newest,
      );
      await this.repo.upsertMany(page.customers.map(toCustomerUpsert));
      if (!page.hasNextPage || !page.endCursor) {
        break;
      }
      after = page.endCursor;
    }
    const hasMore = Boolean(page?.hasNextPage && page.endCursor);
    if (!options.full) {
      const watermark = hasMore ? newest : startedAt - INCREMENTAL_OVERLAP_MS;
      if (watermark !== null) {
        await this.statusRepo.setIncrementalSince(
          new Date(watermark).toISOString(),
        );
      }
    }
    return {
      mode: updatedSince ? 'incremental' : 'backfill',
      updatedSince,
      pages,
      fetched,
      hasMore,
      nextCursor: hasMore && options.full ? (page?.endCursor ?? null) : null,
    };
  }

  private async incrementalSince(): Promise<string | null> {
    const status = await this.statusRepo.status();
    return (
      status?.incremental_since ?? (await this.repo.latestShopifyUpdatedAt())
    );
  }
}
