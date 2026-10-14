import {
  type CustomerSyncOutcome,
  CustomerSyncStatusRepository,
  type CustomerSyncStatusRow,
} from '../../src/customers/customer-sync-status.repository';
import {
  type CustomerPageRequest,
  type CustomerRow,
  type CustomerRowPage,
  CustomersRepository,
  type CustomerUpsert,
} from '../../src/customers/customers.repository';
import type { ShopifyAdminClient } from '../../src/shopify/shopify-admin.client';

export interface FakeCustomerNode {
  id: number;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  updatedAt?: string;
}

export function customerNode(node: FakeCustomerNode) {
  return {
    legacyResourceId: String(node.id),
    firstName: node.firstName ?? null,
    lastName: node.lastName ?? null,
    defaultEmailAddress:
      node.email === undefined || node.email === null
        ? null
        : { emailAddress: node.email },
    defaultPhoneNumber:
      node.phone === undefined || node.phone === null
        ? null
        : { phoneNumber: node.phone },
    updatedAt: node.updatedAt ?? '2026-10-01T12:00:00Z',
  };
}

export function customersPage(
  nodes: FakeCustomerNode[],
  next: string | null = null,
) {
  return {
    customers: {
      pageInfo: { hasNextPage: next !== null, endCursor: next },
      nodes: nodes.map(customerNode),
    },
  };
}

export function customerCreated(
  node: FakeCustomerNode | null,
  userErrors: { field: string[] | null; message: string }[] = [],
) {
  return {
    customerCreate: {
      customer: node ? customerNode(node) : null,
      userErrors,
    },
  };
}

export function fakeShopifyGraphql(responses: unknown[]) {
  const graphql = jest.fn((...args: [string, unknown]) => {
    expect(typeof args[0]).toBe('string');
    const next = responses.shift();
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    if (next === undefined) {
      return Promise.reject(new Error('unexpected Shopify call'));
    }
    return Promise.resolve(next);
  });
  return { client: { graphql } as unknown as ShopifyAdminClient, graphql };
}

let sequence = 0;
const nextId = () =>
  `10000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

export class InMemoryCustomersRepository extends CustomersRepository {
  rows: CustomerRow[] = [];
  upsertCalls: CustomerUpsert[][] = [];
  searches: ({ tokens: string[] } & CustomerPageRequest)[] = [];

  search(
    tokens: string[],
    { limit, offset }: CustomerPageRequest,
  ): Promise<CustomerRowPage> {
    this.searches.push({ tokens, limit, offset });
    const text = (r: CustomerRow) =>
      [
        r.first_name,
        r.last_name,
        `${r.last_name ?? ''}${r.first_name ?? ''}`,
        r.email,
        r.phone,
        (r.phone ?? '').replace(/\D/g, ''),
      ]
        .join(' ')
        .toLowerCase();
    const key = (r: CustomerRow) =>
      [r.last_name ?? '\uffff', r.first_name ?? '\uffff', r.id].join('\u0000');
    const matches = this.rows
      .filter((r) => tokens.every((t) => text(r).includes(t.toLowerCase())))
      .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    return Promise.resolve({
      rows: matches.slice(offset, offset + limit).map((r) => ({ ...r })),
      total: matches.length,
    });
  }

  latestShopifyUpdatedAt(): Promise<string | null> {
    const times = this.rows
      .map((r) => r.shopify_updated_at)
      .filter((t): t is string => t !== null)
      .sort();
    return Promise.resolve(times.at(-1) ?? null);
  }

  upsertMany(rows: CustomerUpsert[]): Promise<void> {
    this.upsertCalls.push(rows);
    rows.forEach((row) => this.write(row));
    return Promise.resolve();
  }

  upsertOne(row: CustomerUpsert): Promise<CustomerRow> {
    return Promise.resolve({ ...this.write(row) });
  }

  private write(row: CustomerUpsert): CustomerRow {
    const existing = this.rows.find(
      (r) => Number(r.shopify_customer_id) === row.shopify_customer_id,
    );
    if (existing) {
      Object.assign(existing, row, { updated_at: '2026-10-11T00:00:00Z' });
      return existing;
    }
    const created: CustomerRow = {
      id: nextId(),
      ...row,
      created_at: '2026-10-11T00:00:00Z',
      updated_at: '2026-10-11T00:00:00Z',
    };
    this.rows.push(created);
    return created;
  }
}

export class InMemoryCustomerSyncStatusRepository extends CustomerSyncStatusRepository {
  row: CustomerSyncStatusRow & { lock_token: string | null } = {
    lock_token: null,
    last_started_at: null,
    last_finished_at: null,
    last_success_at: null,
    last_fetched: null,
    last_error: null,
  };
  leases: number[] = [];
  private tokens = 0;

  tryLock(leaseSeconds: number): Promise<string | null> {
    this.leases.push(leaseSeconds);
    if (this.row.lock_token) {
      return Promise.resolve(null);
    }
    this.row.lock_token = `lock-${++this.tokens}`;
    this.row.last_started_at = '2026-10-13T12:00:00Z';
    return Promise.resolve(this.row.lock_token);
  }

  finish(token: string, outcome: CustomerSyncOutcome): Promise<void> {
    if (this.row.lock_token === token) {
      this.row.lock_token = null;
      this.row.last_finished_at = '2026-10-13T12:01:00Z';
      this.row.last_error = outcome.error;
      if (outcome.error === null) {
        this.row.last_fetched = outcome.fetched;
        this.row.last_success_at = '2026-10-13T12:01:00Z';
      }
    }
    return Promise.resolve();
  }

  status(): Promise<CustomerSyncStatusRow | null> {
    return Promise.resolve({
      last_started_at: this.row.last_started_at,
      last_finished_at: this.row.last_finished_at,
      last_success_at: this.row.last_success_at,
      last_fetched: this.row.last_fetched,
      last_error: this.row.last_error,
    });
  }
}
