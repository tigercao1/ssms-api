import type { CustomerRow, CustomerUpsert } from './customers.repository';
import type { ShopifyCustomer } from './shopify-customers';

export interface Customer {
  id: string;
  shopifyCustomerId: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  shopifyUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    shopifyCustomerId: Number(row.shopify_customer_id),
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    shopifyUpdatedAt: row.shopify_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toCustomerUpsert(customer: ShopifyCustomer): CustomerUpsert {
  return {
    shopify_customer_id: customer.shopifyCustomerId,
    first_name: customer.firstName,
    last_name: customer.lastName,
    email: customer.email,
    phone: customer.phone,
    shopify_updated_at: customer.updatedAt,
  };
}
