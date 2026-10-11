import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import { ShopifyConfigError, ShopifyError } from '../shopify/shopify.errors';
import {
  buildInstructorHandleIndex,
  type InstructorHandleIndex,
  isLessonCandidate,
  suggestLessonProduct,
} from './lesson-title.parser';
import {
  type LessonProductSyncRow,
  LessonProductsRepository,
} from './lesson-products.repository';
import {
  type CatalogProduct,
  type CatalogSnapshot,
  ShopifyLessonCatalog,
  ShopifyScopeMissingError,
} from './shopify-lesson-catalog';
import type { LessonSuggestion } from './lessons.types';

export const LESSON_PRODUCT_SYNC_FLAG = 'LESSON_PRODUCT_SYNC_ENABLED';
export const LESSON_PRODUCT_SYNC_DISABLED = `Lesson product sync is off; set ${LESSON_PRODUCT_SYNC_FLAG}=true to enable it.`;
export const SHOPIFY_NOT_CONFIGURED = 'Shopify is not configured on the API.';
export const SHOPIFY_SYNC_FAILED = 'Shopify product sync failed';

export interface LessonProductSyncResult {
  productsScanned: number;
  lessonProducts: number;
  variants: number;
  inserted: number;
  updated: number;
  unchanged: number;
  truncatedProductIds: number[];
}

export function isLessonProductSyncEnabled(config: ConfigService): boolean {
  return config.get<string>(LESSON_PRODUCT_SYNC_FLAG)?.trim() === 'true';
}

@Injectable()
export class LessonProductSyncService {
  private readonly logger = new Logger(LessonProductSyncService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly catalog: ShopifyLessonCatalog,
    private readonly repo: LessonProductsRepository,
    private readonly audit: AuditService,
  ) {}

  isEnabled(): boolean {
    return isLessonProductSyncEnabled(this.config);
  }

  async sync(actor: AuditActor): Promise<LessonProductSyncResult> {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException(LESSON_PRODUCT_SYNC_DISABLED);
    }
    const snapshot = await this.fetchCatalog();
    const index = buildInstructorHandleIndex(
      await this.repo.instructorHandleSources(),
    );
    const planned = snapshot.products
      .map((product) => ({
        product,
        entries: this.rowsFor(product, snapshot.currency, index),
      }))
      .filter(({ entries }) =>
        entries.some((entry) => isLessonCandidate(entry.suggestion)),
      );
    const lessonProducts = planned.map(({ product }) => product);
    const rows = planned.flatMap(({ entries }) => entries.map((e) => e.row));
    const counts = await this.repo.sync(rows);
    const result: LessonProductSyncResult = {
      productsScanned: snapshot.products.length,
      lessonProducts: lessonProducts.length,
      variants: rows.length,
      inserted: counts.inserted,
      updated: counts.updated,
      unchanged: rows.length - counts.inserted - counts.updated,
      truncatedProductIds: lessonProducts
        .filter((p) => p.truncated)
        .map((p) => p.shopifyProductId),
    };
    await this.audit.record({
      action: AUDIT_ACTIONS.lessonProductSync,
      actor: { ...actor, role: 'admin' },
      metadata: { ...result },
    });
    return result;
  }

  private async fetchCatalog(): Promise<CatalogSnapshot> {
    try {
      return await this.catalog.fetchProducts();
    } catch (err) {
      if (err instanceof ShopifyScopeMissingError) {
        throw new BadGatewayException(err.message);
      }
      if (err instanceof ShopifyConfigError) {
        throw new ServiceUnavailableException(SHOPIFY_NOT_CONFIGURED);
      }
      if (err instanceof ShopifyError) {
        this.logger.error(`Lesson product sync failed: ${err.message}`);
        throw new BadGatewayException(SHOPIFY_SYNC_FAILED);
      }
      throw err;
    }
  }

  private rowsFor(
    product: CatalogProduct,
    currency: string | null,
    index: InstructorHandleIndex,
  ): { suggestion: LessonSuggestion; row: LessonProductSyncRow }[] {
    return product.variants.map((variant) => {
      const suggestion = suggestLessonProduct(
        {
          productTitle: product.title,
          variantTitle: variant.title,
          collectionHandles: product.collectionHandles,
        },
        index,
      );
      const row: LessonProductSyncRow = {
        shopify_product_id: product.shopifyProductId,
        shopify_variant_id: variant.shopifyVariantId,
        product_title: product.title,
        variant_title: variant.title,
        lesson_type: suggestion.lessonType,
        group_size: suggestion.groupSize,
        sessions: suggestion.sessions,
        duration_min: suggestion.durationMin,
        priced_per_student: suggestion.pricedPerStudent,
        instructor_id: suggestion.instructorId,
        price: variant.price,
        currency,
      };
      return { suggestion, row };
    });
  }
}
