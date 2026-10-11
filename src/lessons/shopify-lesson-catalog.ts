import { Injectable } from '@nestjs/common';
import { ShopifyAdminClient } from '../shopify/shopify-admin.client';
import { ShopifyError, ShopifyGraphqlError } from '../shopify/shopify.errors';

export const PRODUCTS_PAGE_SIZE = 10;
export const VARIANTS_PER_PRODUCT = 50;
export const COLLECTIONS_PER_PRODUCT = 20;
export const MAX_PRODUCT_PAGES = 200;

export const LESSON_CATALOG_QUERY = `
  query LessonProductCatalog($first: Int!, $after: String) {
    shop {
      currencyCode
    }
    products(first: $first, after: $after, sortKey: ID) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        legacyResourceId
        title
        collections(first: ${COLLECTIONS_PER_PRODUCT}) {
          pageInfo {
            hasNextPage
          }
          nodes {
            handle
          }
        }
        variants(first: ${VARIANTS_PER_PRODUCT}) {
          pageInfo {
            hasNextPage
          }
          nodes {
            legacyResourceId
            title
            price
          }
        }
      }
    }
  }
`;

export const scopeMissingMessage = (scope: string): string =>
  `${scope} scope missing: grant ${scope} to the Shopify app, then sync again.`;

export class ShopifyScopeMissingError extends ShopifyError {
  constructor(readonly scope: string) {
    super(scopeMissingMessage(scope));
  }
}

export interface CatalogVariant {
  shopifyVariantId: number;
  title: string | null;
  price: string | null;
}

export interface CatalogProduct {
  shopifyProductId: number;
  title: string;
  collectionHandles: string[];
  variants: CatalogVariant[];
  truncated: boolean;
}

export interface CatalogSnapshot {
  currency: string | null;
  products: CatalogProduct[];
}

interface Connection<T> {
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  nodes: T[];
}

interface CatalogPage {
  shop?: { currencyCode?: string | null } | null;
  products: Connection<{
    legacyResourceId: string;
    title: string;
    collections: Connection<{ handle: string }>;
    variants: Connection<{
      legacyResourceId: string;
      title: string | null;
      price: string | null;
    }>;
  }>;
}

const DEFAULT_VARIANT_TITLE = 'Default Title';

function toId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ShopifyError(`Unexpected Shopify id '${value}'`);
  }
  return id;
}

function isAccessDenied(err: unknown): boolean {
  return (
    err instanceof ShopifyGraphqlError &&
    err.errors.some(
      (e) =>
        e.extensions?.code === 'ACCESS_DENIED' ||
        /read_products/.test(e.message),
    )
  );
}

@Injectable()
export class ShopifyLessonCatalog {
  constructor(private readonly shopify: ShopifyAdminClient) {}

  async fetchProducts(): Promise<CatalogSnapshot> {
    const products: CatalogProduct[] = [];
    let currency: string | null = null;
    let after: string | null = null;
    for (let page = 0; page < MAX_PRODUCT_PAGES; page++) {
      const data = await this.page(after);
      currency ??= data.shop?.currencyCode ?? null;
      for (const node of data.products.nodes) {
        products.push({
          shopifyProductId: toId(node.legacyResourceId),
          title: node.title,
          collectionHandles: node.collections.nodes.map((c) => c.handle),
          variants: node.variants.nodes.map((v) => ({
            shopifyVariantId: toId(v.legacyResourceId),
            title:
              v.title && v.title !== DEFAULT_VARIANT_TITLE ? v.title : null,
            price: v.price ?? null,
          })),
          truncated:
            node.variants.pageInfo.hasNextPage ||
            node.collections.pageInfo.hasNextPage,
        });
      }
      const { hasNextPage, endCursor } = data.products.pageInfo;
      if (!hasNextPage || !endCursor) {
        return { currency, products };
      }
      after = endCursor;
    }
    throw new ShopifyError(
      `Product catalog has more than ${MAX_PRODUCT_PAGES * PRODUCTS_PAGE_SIZE} products`,
    );
  }

  private async page(after: string | null): Promise<CatalogPage> {
    try {
      return await this.shopify.graphql<CatalogPage>(LESSON_CATALOG_QUERY, {
        first: PRODUCTS_PAGE_SIZE,
        after,
      });
    } catch (err) {
      if (isAccessDenied(err)) {
        throw new ShopifyScopeMissingError('read_products');
      }
      throw err;
    }
  }
}
