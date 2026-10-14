import { Injectable } from '@nestjs/common';
import { ShopifyAdminClient } from '../shopify/shopify-admin.client';
import {
  ShopifyError,
  ShopifyGraphqlError,
  type ShopifyUserError,
} from '../shopify/shopify.errors';
import { assertNoUserErrors } from '../shopify/shopify-user-errors';

export const CUSTOMERS_PAGE_SIZE = 100;
export const CUSTOMER_IDS_PAGE_SIZE = 250;

const CUSTOMER_FIELDS = `
  legacyResourceId
  firstName
  lastName
  defaultEmailAddress {
    emailAddress
  }
  defaultPhoneNumber {
    phoneNumber
  }
  updatedAt
`;

export const CUSTOMERS_PAGE_QUERY = `
  query CustomerSyncPage($first: Int!, $after: String, $query: String) {
    customers(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {${CUSTOMER_FIELDS}}
    }
  }
`;

export const CUSTOMER_IDS_PAGE_QUERY = `
  query CustomerIdsPage($first: Int!, $after: String) {
    customers(first: $first, after: $after, sortKey: ID) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        legacyResourceId
      }
    }
  }
`;

export const CUSTOMER_CREATE_MUTATION = `
  mutation CustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer {${CUSTOMER_FIELDS}}
      userErrors {
        field
        message
      }
    }
  }
`;

export interface ShopifyCustomer {
  shopifyCustomerId: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  updatedAt: string | null;
}

export interface ShopifyCustomerPage {
  customers: ShopifyCustomer[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface ShopifyCustomerIdPage {
  ids: number[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface NewShopifyCustomer {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
}

export class ShopifyScopeMissingError extends ShopifyError {
  constructor(readonly scope: string) {
    super(`${scope} scope missing`);
  }
}

interface CustomerNode {
  legacyResourceId: string;
  firstName: string | null;
  lastName: string | null;
  defaultEmailAddress: { emailAddress: string | null } | null;
  defaultPhoneNumber: { phoneNumber: string | null } | null;
  updatedAt: string | null;
}

interface CustomersPageData {
  customers: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: CustomerNode[];
  };
}

interface CustomerIdsPageData {
  customers: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: { legacyResourceId: string }[];
  };
}

interface CustomerCreateData {
  customerCreate: {
    customer: CustomerNode | null;
    userErrors: ShopifyUserError[];
  } | null;
}

function toCustomerId(value: unknown): number {
  const id =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new ShopifyError(`Unexpected Shopify customer id '${String(value)}'`);
  }
  return id;
}

function toCustomer(node: CustomerNode): ShopifyCustomer {
  return {
    shopifyCustomerId: toCustomerId(node.legacyResourceId),
    firstName: node.firstName || null,
    lastName: node.lastName || null,
    email: node.defaultEmailAddress?.emailAddress || null,
    phone: node.defaultPhoneNumber?.phoneNumber || null,
    updatedAt: node.updatedAt ?? null,
  };
}

const CUSTOMER_GID = /^gid:\/\/shopify\/Customer\/(\d+)$/;

function field(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function asPayload(payload: unknown): Record<string, unknown> {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new ShopifyError('Shopify webhook payload is not a JSON object');
  }
  return payload as Record<string, unknown>;
}

export function webhookCustomerId(payload: unknown): number {
  const body = asPayload(payload);
  const gid = field(body, 'admin_graphql_api_id')?.match(CUSTOMER_GID);
  return toCustomerId(gid ? gid[1] : body.id);
}

export function fromWebhookPayload(payload: unknown): ShopifyCustomer {
  const body = asPayload(payload);
  const updatedAt = field(body, 'updated_at');
  if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) {
    throw new ShopifyError(
      `Unexpected Shopify customer updated_at '${String(body.updated_at)}'`,
    );
  }
  return {
    shopifyCustomerId: webhookCustomerId(body),
    firstName: field(body, 'first_name'),
    lastName: field(body, 'last_name'),
    email: field(body, 'email'),
    phone: field(body, 'phone'),
    updatedAt,
  };
}

function isAccessDenied(err: unknown, scope: string): boolean {
  return (
    err instanceof ShopifyGraphqlError &&
    err.errors.some(
      (e) =>
        e.extensions?.code === 'ACCESS_DENIED' || e.message.includes(scope),
    )
  );
}

@Injectable()
export class ShopifyCustomerDirectory {
  constructor(private readonly shopify: ShopifyAdminClient) {}

  async page(
    after: string | null,
    updatedSince: string | null,
  ): Promise<ShopifyCustomerPage> {
    let data: CustomersPageData;
    try {
      data = await this.shopify.graphql<CustomersPageData>(
        CUSTOMERS_PAGE_QUERY,
        {
          first: CUSTOMERS_PAGE_SIZE,
          after,
          query: updatedSince ? `updated_at:>='${updatedSince}'` : null,
        },
      );
    } catch (err) {
      if (isAccessDenied(err, 'read_customers')) {
        throw new ShopifyScopeMissingError('read_customers');
      }
      throw err;
    }
    return {
      customers: data.customers.nodes.map(toCustomer),
      hasNextPage: data.customers.pageInfo.hasNextPage,
      endCursor: data.customers.pageInfo.endCursor ?? null,
    };
  }

  async idsPage(after: string | null): Promise<ShopifyCustomerIdPage> {
    let data: CustomerIdsPageData;
    try {
      data = await this.shopify.graphql<CustomerIdsPageData>(
        CUSTOMER_IDS_PAGE_QUERY,
        { first: CUSTOMER_IDS_PAGE_SIZE, after },
      );
    } catch (err) {
      if (isAccessDenied(err, 'read_customers')) {
        throw new ShopifyScopeMissingError('read_customers');
      }
      throw err;
    }
    return {
      ids: data.customers.nodes.map((n) => toCustomerId(n.legacyResourceId)),
      hasNextPage: data.customers.pageInfo.hasNextPage,
      endCursor: data.customers.pageInfo.endCursor ?? null,
    };
  }

  async create(input: NewShopifyCustomer): Promise<ShopifyCustomer> {
    let data: CustomerCreateData;
    try {
      data = await this.shopify.graphql<CustomerCreateData>(
        CUSTOMER_CREATE_MUTATION,
        { input },
      );
    } catch (err) {
      if (isAccessDenied(err, 'write_customers')) {
        throw new ShopifyScopeMissingError('write_customers');
      }
      throw err;
    }
    const payload = assertNoUserErrors('customerCreate', data.customerCreate);
    if (!payload.customer) {
      throw new ShopifyError('customerCreate returned no customer.');
    }
    return toCustomer(payload.customer);
  }
}
