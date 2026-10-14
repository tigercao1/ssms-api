import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import {
  CUSTOMER_SYNC_FLAG,
  syncDisabled,
  toHttpError,
} from './customer-errors';
import { CustomersRepository } from './customers.repository';
import { toCustomerUpsert } from './customers.types';
import {
  type ShopifyCustomerPage,
  ShopifyCustomerDirectory,
} from './shopify-customers';

export const MAX_SYNC_PAGES_PER_RUN = 50;
export const CURSOR_NEEDS_FULL = 'cursor is only valid with full=true';

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
    const latest = options.full
      ? null
      : await this.repo.latestShopifyUpdatedAt();
    const updatedSince = latest ? toShopifySearchTime(latest) : null;
    let after = options.full ? (options.cursor ?? null) : null;
    let pages = 0;
    let fetched = 0;
    let page: ShopifyCustomerPage | null = null;
    while (pages < maxPages) {
      try {
        page = await this.directory.page(after, updatedSince);
      } catch (err) {
        throw toHttpError(err, this.logger);
      }
      pages++;
      fetched += page.customers.length;
      await this.repo.upsertMany(page.customers.map(toCustomerUpsert));
      if (!page.hasNextPage || !page.endCursor) {
        break;
      }
      after = page.endCursor;
    }
    const hasMore = Boolean(page?.hasNextPage && page.endCursor);
    return {
      mode: updatedSince ? 'incremental' : 'backfill',
      updatedSince,
      pages,
      fetched,
      hasMore,
      nextCursor: hasMore && options.full ? (page?.endCursor ?? null) : null,
    };
  }
}
