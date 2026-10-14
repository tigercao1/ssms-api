import { Injectable } from '@nestjs/common';
import { CustomersRepository } from './customers.repository';
import { ShopifyCustomerDirectory } from './shopify-customers';

export const RECONCILE_INTERVAL_MS = 24 * 60 * 60_000;
export const RECONCILE_MAX_PAGES = 200;
export const RECONCILE_MIN_SHOPIFY_RATIO = 0.5;

export interface CustomerReconcileResult {
  shopify: number;
  local: number;
  deleted: number;
  restored: number;
}

export class CustomerReconcileAbortedError extends Error {}

export function reconcileDue(
  lastReconcileAt: string | null | undefined,
  now: number,
): boolean {
  return (
    !lastReconcileAt ||
    now - Date.parse(lastReconcileAt) >= RECONCILE_INTERVAL_MS
  );
}

@Injectable()
export class CustomerReconcileService {
  constructor(
    private readonly directory: ShopifyCustomerDirectory,
    private readonly repo: CustomersRepository,
  ) {}

  async reconcile(): Promise<CustomerReconcileResult> {
    const startedAt = new Date().toISOString();
    const ids = await this.allShopifyIds();
    const local = await this.repo.countCustomers(false);
    if (ids.length < local * RECONCILE_MIN_SHOPIFY_RATIO) {
      throw new CustomerReconcileAbortedError(
        `Shopify listed ${ids.length} customers but ${local} are active here; deletions were not applied`,
      );
    }
    const counts = await this.repo.reconcileDeletions(ids, startedAt);
    return { shopify: ids.length, local, ...counts };
  }

  private async allShopifyIds(): Promise<number[]> {
    const ids: number[] = [];
    let after: string | null = null;
    for (let pages = 0; pages < RECONCILE_MAX_PAGES; pages++) {
      const page = await this.directory.idsPage(after);
      ids.push(...page.ids);
      if (!page.hasNextPage || !page.endCursor) {
        return ids;
      }
      after = page.endCursor;
    }
    throw new CustomerReconcileAbortedError(
      `Shopify still had more customers after ${RECONCILE_MAX_PAGES} pages; deletions were not applied`,
    );
  }
}
