import {
  BadGatewayException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  campProduct,
  catalogPage,
  EDDIE_ID,
  eddieProducts,
  fakeShopify,
  InMemoryLessonProductsRepository,
} from '../../test/helpers/lessons-fakes';
import { recordingAudit } from '../../test/helpers/public-pages-fakes';
import type { AuditService } from '../audit/audit.service';
import {
  ShopifyConfigError,
  ShopifyGraphqlError,
  ShopifyHttpError,
} from '../shopify/shopify.errors';
import {
  LESSON_PRODUCT_SYNC_DISABLED,
  LessonProductSyncService,
  SHOPIFY_NOT_CONFIGURED,
  SHOPIFY_SYNC_FAILED,
} from './lesson-product-sync.service';
import { ShopifyLessonCatalog } from './shopify-lesson-catalog';

const ACTOR = { userId: 'admin-1', role: 'admin' as const };

function build(
  pages: unknown[],
  env: Record<string, string> = { LESSON_PRODUCT_SYNC_ENABLED: 'true' },
) {
  const repo = new InMemoryLessonProductsRepository();
  const audit = recordingAudit();
  const shopify = fakeShopify(pages);
  const config = new ConfigService(env);
  const service = new LessonProductSyncService(
    config,
    new ShopifyLessonCatalog(shopify.client),
    repo,
    audit as unknown as AuditService,
  );
  return { service, repo, audit, graphql: shopify.graphql };
}

describe('LessonProductSyncService', () => {
  it.each([undefined, 'false', 'TRUE '])(
    'refuses to run and never calls Shopify when the flag is %j',
    async (flag) => {
      const { service, graphql, repo } = build(
        [],
        flag === undefined ? {} : { LESSON_PRODUCT_SYNC_ENABLED: flag },
      );
      expect(service.isEnabled()).toBe(false);
      const run = service.sync(ACTOR);
      await expect(run).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(run).rejects.toThrow(LESSON_PRODUCT_SYNC_DISABLED);
      expect(graphql).not.toHaveBeenCalled();
      expect(repo.syncCalls).toHaveLength(0);
    },
  );

  it('stores suggestions for lesson products and skips everything else', async () => {
    const { service, repo, audit } = build([
      catalogPage([...eddieProducts, campProduct]),
    ]);

    const result = await service.sync(ACTOR);

    expect(result).toEqual({
      productsScanned: 3,
      lessonProducts: 2,
      variants: 4,
      inserted: 4,
      updated: 0,
      unchanged: 0,
      truncatedProductIds: [],
    });
    const fourPack = repo.rows.find(
      (r) => r.shopify_variant_id === 47123482804246,
    );
    expect(fourPack).toMatchObject({
      product_title: '一对一',
      variant_title: '四次',
      lesson_type: 'private',
      group_size: 1,
      sessions: 4,
      priced_per_student: false,
      instructor_id: EDDIE_ID,
      status: 'suggested',
      price: '1080.00',
      currency: 'CAD',
    });
    expect(repo.rows.some((r) => r.product_title.includes('Camp'))).toBe(false);
    expect(audit.entries).toEqual([
      expect.objectContaining({
        action: 'lesson_product.sync',
        actor: ACTOR,
        metadata: expect.objectContaining({ inserted: 4 }) as unknown,
      }),
    ]);
  });

  it('keeps an admin-confirmed row and only refreshes its price and titles', async () => {
    const { service, repo } = build([
      catalogPage(eddieProducts),
      catalogPage([
        {
          ...eddieProducts[0],
          title: '一对一 (新)',
          variants: [{ id: 47123482771478, title: '单次', price: '300.00' }],
        },
      ]),
    ]);
    await service.sync(ACTOR);
    const single = repo.rows.find(
      (r) => r.shopify_variant_id === 47123482771478,
    )!;
    Object.assign(single, {
      status: 'confirmed',
      lesson_type: 'semi_private',
      group_size: 2,
      sessions: 3,
      duration_min: 120,
      instructor_id: null,
    });

    const second = await service.sync(ACTOR);

    expect(second).toMatchObject({ inserted: 0, updated: 1, unchanged: 0 });
    expect(single).toMatchObject({
      status: 'confirmed',
      lesson_type: 'semi_private',
      group_size: 2,
      sessions: 3,
      duration_min: 120,
      instructor_id: null,
      product_title: '一对一 (新)',
      price: '300.00',
    });
  });

  it('reports products whose variants were cut off', async () => {
    const { service } = build([
      catalogPage([{ ...eddieProducts[0], moreVariants: true }]),
    ]);
    const result = await service.sync(ACTOR);
    expect(result.truncatedProductIds).toEqual([8827109769238]);
  });

  it('turns a missing read_products scope into a clear 502', async () => {
    const { service, repo } = build([
      new ShopifyGraphqlError([
        { message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } },
      ]),
    ]);
    const run = service.sync(ACTOR);
    await expect(run).rejects.toBeInstanceOf(BadGatewayException);
    await expect(run).rejects.toThrow('read_products scope missing');
    expect(repo.syncCalls).toHaveLength(0);
  });

  it('reports unconfigured Shopify as 503', async () => {
    const { service } = build([new ShopifyConfigError(['SHOPIFY_SHOP'])]);
    await expect(service.sync(ACTOR)).rejects.toThrow(SHOPIFY_NOT_CONFIGURED);
  });

  it('hides other Shopify failure detail behind a 502', async () => {
    const logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { service } = build([new ShopifyHttpError(500, 'secret detail')]);
    const run = service.sync(ACTOR);
    await expect(run).rejects.toBeInstanceOf(BadGatewayException);
    await expect(run).rejects.toThrow(SHOPIFY_SYNC_FAILED);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('secret detail'),
    );
    logged.mockRestore();
  });

  it('lets non-Shopify errors through untouched', async () => {
    const failure = new Error('database down');
    const { service } = build([failure]);
    await expect(service.sync(ACTOR)).rejects.toBe(failure);
  });
});
