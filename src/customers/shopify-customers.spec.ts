import {
  customersPage,
  fakeShopifyGraphql,
} from '../../test/helpers/customers-fakes';
import { ShopifyGraphqlError, ShopifyError } from '../shopify/shopify.errors';
import { toCustomerUpsert } from './customers.types';
import {
  CUSTOMER_IDS_PAGE_QUERY,
  fromWebhookPayload,
  ShopifyCustomerDirectory,
  ShopifyScopeMissingError,
  webhookCustomerId,
} from './shopify-customers';

const webhookPayload = {
  id: 7_210_000_000_001,
  email: 'mei@example.com',
  created_at: '2026-10-01T09:00:00-04:00',
  updated_at: '2026-10-13T08:00:00-04:00',
  first_name: 'Mei',
  last_name: 'Wang',
  state: 'disabled',
  note: 'private note',
  verified_email: true,
  tax_exempt: false,
  phone: '+16475550100',
  currency: 'CAD',
  addresses: [],
  tax_exemptions: [],
  admin_graphql_api_id: 'gid://shopify/Customer/7210000000001',
  default_address: { address1: '1 Main St' },
};

describe('Shopify webhook customer mapping', () => {
  it('maps the REST webhook payload to the same row as the GraphQL sync', async () => {
    const { client } = fakeShopifyGraphql([
      customersPage([
        {
          id: 7_210_000_000_001,
          firstName: 'Mei',
          lastName: 'Wang',
          email: 'mei@example.com',
          phone: '+16475550100',
          updatedAt: '2026-10-13T08:00:00-04:00',
        },
      ]),
    ]);
    const [fromSync] = (
      await new ShopifyCustomerDirectory(client).page(null, null)
    ).customers;
    expect(toCustomerUpsert(fromWebhookPayload(webhookPayload))).toEqual(
      toCustomerUpsert(fromSync),
    );
    expect(toCustomerUpsert(fromWebhookPayload(webhookPayload))).toEqual({
      shopify_customer_id: 7_210_000_000_001,
      first_name: 'Mei',
      last_name: 'Wang',
      email: 'mei@example.com',
      phone: '+16475550100',
      shopify_updated_at: '2026-10-13T08:00:00-04:00',
    });
  });

  it('turns blank and missing contact fields into null', () => {
    expect(
      fromWebhookPayload({
        id: 5,
        first_name: '',
        last_name: null,
        email: '',
        updated_at: '2026-10-13T12:00:00Z',
      }),
    ).toEqual({
      shopifyCustomerId: 5,
      firstName: null,
      lastName: null,
      email: null,
      phone: null,
      updatedAt: '2026-10-13T12:00:00Z',
    });
  });

  it('takes the id from admin_graphql_api_id, which JSON.parse cannot round', () => {
    expect(
      webhookCustomerId({
        id: 123.0000001,
        admin_graphql_api_id: 'gid://shopify/Customer/8000000000123',
      }),
    ).toBe(8_000_000_000_123);
    expect(webhookCustomerId({ id: 42 })).toBe(42);
    expect(webhookCustomerId({ id: '43' })).toBe(43);
    expect(
      webhookCustomerId({
        id: 44,
        admin_graphql_api_id: 'gid://shopify/Order/1',
      }),
    ).toBe(44);
  });

  it.each([
    [
      'an id above 2^53',
      { admin_graphql_api_id: 'gid://shopify/Customer/706405506930370084' },
    ],
    ['no id', { first_name: 'x' }],
    ['a zero id', { id: 0 }],
    ['a fractional id', { id: 1.5 }],
    ['a non-numeric id', { id: 'abc' }],
  ])('rejects %s', (_name, payload) => {
    expect(() => webhookCustomerId(payload)).toThrow(ShopifyError);
  });

  it.each([
    ['no updated_at', { id: 1 }],
    ['an unparseable updated_at', { id: 1, updated_at: 'yesterday' }],
    ['an array', []],
    ['null', null],
    ['a string', 'customer'],
  ])('rejects a create/update payload with %s', (_name, payload) => {
    expect(() => fromWebhookPayload(payload)).toThrow(ShopifyError);
  });
});

describe('ShopifyCustomerDirectory.idsPage', () => {
  it('pages ids only, 250 at a time, in id order', async () => {
    const { client, graphql } = fakeShopifyGraphql([
      {
        customers: {
          pageInfo: { hasNextPage: true, endCursor: 'c-1' },
          nodes: [{ legacyResourceId: '11' }, { legacyResourceId: '12' }],
        },
      },
    ]);
    await expect(
      new ShopifyCustomerDirectory(client).idsPage('c-0'),
    ).resolves.toEqual({ ids: [11, 12], hasNextPage: true, endCursor: 'c-1' });
    expect(graphql).toHaveBeenCalledWith(CUSTOMER_IDS_PAGE_QUERY, {
      first: 250,
      after: 'c-0',
    });
    expect(CUSTOMER_IDS_PAGE_QUERY).toMatch(/sortKey: ID/);
    expect(CUSTOMER_IDS_PAGE_QUERY).not.toMatch(/email|phone|firstName/);
  });

  it('reports a missing read_customers scope and passes other errors through', async () => {
    const denied = new ShopifyGraphqlError([
      { message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } },
    ]);
    const other = new ShopifyError('boom');
    const { client } = fakeShopifyGraphql([denied, other]);
    const directory = new ShopifyCustomerDirectory(client);
    await expect(directory.idsPage(null)).rejects.toBeInstanceOf(
      ShopifyScopeMissingError,
    );
    await expect(directory.idsPage(null)).rejects.toBe(other);
  });
});
