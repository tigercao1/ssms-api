import {
  campProduct,
  catalogPage,
  eddieProducts,
  fakeShopify,
} from '../../test/helpers/lessons-fakes';
import {
  ShopifyGraphqlError,
  ShopifyHttpError,
} from '../shopify/shopify.errors';
import {
  MAX_PRODUCT_PAGES,
  PRODUCTS_PAGE_SIZE,
  ShopifyLessonCatalog,
  ShopifyScopeMissingError,
} from './shopify-lesson-catalog';

describe('ShopifyLessonCatalog', () => {
  it('pages through every product and keeps variants, prices and collections', async () => {
    const { client, graphql } = fakeShopify([
      catalogPage([eddieProducts[0]], 'cursor-1'),
      catalogPage([eddieProducts[1], campProduct]),
    ]);

    const snapshot = await new ShopifyLessonCatalog(client).fetchProducts();

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[0][1]).toEqual({
      first: PRODUCTS_PAGE_SIZE,
      after: null,
    });
    expect(graphql.mock.calls[1][1]).toEqual({
      first: PRODUCTS_PAGE_SIZE,
      after: 'cursor-1',
    });
    expect(snapshot.currency).toBe('CAD');
    expect(snapshot.products).toHaveLength(3);
    expect(snapshot.products[0]).toEqual({
      shopifyProductId: 8827109769238,
      title: '一对一',
      collectionHandles: ['eddie', 'all-lessons'],
      variants: [
        { shopifyVariantId: 47123482771478, title: '单次', price: '280.00' },
        { shopifyVariantId: 47123482804246, title: '四次', price: '1080.00' },
      ],
      truncated: false,
    });
    expect(snapshot.products[2].variants[0].title).toBeNull();
  });

  it('flags products whose variants did not fit in one page', async () => {
    const { client } = fakeShopify([
      catalogPage([{ ...eddieProducts[0], moreVariants: true }]),
    ]);
    const snapshot = await new ShopifyLessonCatalog(client).fetchProducts();
    expect(snapshot.products[0].truncated).toBe(true);
  });

  it('reports a missing read_products scope clearly', async () => {
    const { client } = fakeShopify([
      new ShopifyGraphqlError([
        {
          message:
            'Access denied for products field. Required access: `read_products` access scope.',
          extensions: { code: 'ACCESS_DENIED' },
        },
      ]),
    ]);
    const fetching = new ShopifyLessonCatalog(client).fetchProducts();
    await expect(fetching).rejects.toBeInstanceOf(ShopifyScopeMissingError);
    await expect(fetching).rejects.toThrow('read_products scope missing');
  });

  it('passes other Shopify failures through', async () => {
    const failure = new ShopifyHttpError(500, 'boom');
    const { client } = fakeShopify([failure]);
    await expect(new ShopifyLessonCatalog(client).fetchProducts()).rejects.toBe(
      failure,
    );
  });

  it('rejects ids that are not positive integers', async () => {
    const page = catalogPage([eddieProducts[0]]);
    page.products.nodes[0].legacyResourceId = 'gid://shopify/Product/x';
    const { client } = fakeShopify([page]);
    await expect(
      new ShopifyLessonCatalog(client).fetchProducts(),
    ).rejects.toThrow("Unexpected Shopify id 'gid://shopify/Product/x'");
  });

  it('stops after the page limit instead of looping forever', async () => {
    const pages = Array.from({ length: MAX_PRODUCT_PAGES }, (_, i) =>
      catalogPage([], `cursor-${i}`),
    );
    const { client, graphql } = fakeShopify(pages);
    await expect(
      new ShopifyLessonCatalog(client).fetchProducts(),
    ).rejects.toThrow('more than');
    expect(graphql).toHaveBeenCalledTimes(MAX_PRODUCT_PAGES);
  });
});
