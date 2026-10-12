import { Injectable } from '@nestjs/common';
import { ShopifyAdminClient } from '../shopify/shopify-admin.client';
import {
  ShopifyError,
  ShopifyGraphqlError,
  type ShopifyUserError,
} from '../shopify/shopify.errors';
import { assertNoUserErrors } from '../shopify/shopify-user-errors';

export const CUSTOMERS_PAGE_SIZE = 100;

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

interface CustomerCreateData {
  customerCreate: {
    customer: CustomerNode | null;
    userErrors: ShopifyUserError[];
  } | null;
}

function toCustomer(node: CustomerNode): ShopifyCustomer {
  const id = Number(node.legacyResourceId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ShopifyError(
      `Unexpected Shopify customer id '${node.legacyResourceId}'`,
    );
  }
  return {
    shopifyCustomerId: id,
    firstName: node.firstName || null,
    lastName: node.lastName || null,
    email: node.defaultEmailAddress?.emailAddress || null,
    phone: node.defaultPhoneNumber?.phoneNumber || null,
    updatedAt: node.updatedAt ?? null,
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
