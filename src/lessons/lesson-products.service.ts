import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, type AuditActor } from '../audit/audit.types';
import type { UpdateLessonProductDto } from './dto/update-lesson-product.dto';
import {
  type LessonProductPatch,
  LessonProductsRepository,
} from './lesson-products.repository';
import type {
  LessonProduct,
  LessonProductRow,
  LessonProductStatus,
} from './lessons.types';

export const LESSON_PRODUCT_NOT_FOUND = 'Lesson product not found';
export const LESSON_PRODUCT_INSTRUCTOR_NOT_FOUND = 'Instructor not found';
export const LESSON_PRODUCT_NOTHING_TO_UPDATE = 'Nothing to update';
export const LESSON_PRODUCT_SESSIONS_REQUIRED =
  'Set the number of sessions before confirming';
export const LESSON_PRODUCT_CONFLICT =
  'This lesson product was changed by someone else. Reload and try again.';

const PATCH_FIELDS: [keyof UpdateLessonProductDto, keyof LessonProductPatch][] =
  [
    ['lessonType', 'lesson_type'],
    ['groupSize', 'group_size'],
    ['sessions', 'sessions'],
    ['durationMin', 'duration_min'],
    ['pricedPerStudent', 'priced_per_student'],
    ['instructorId', 'instructor_id'],
    ['status', 'status'],
  ];

export function toLessonProduct(row: LessonProductRow): LessonProduct {
  return {
    id: row.id,
    shopifyProductId: Number(row.shopify_product_id),
    shopifyVariantId: Number(row.shopify_variant_id),
    productTitle: row.product_title,
    variantTitle: row.variant_title,
    lessonType: row.lesson_type,
    groupSize: row.group_size,
    sessions: row.sessions,
    durationMin: row.duration_min,
    pricedPerStudent: row.priced_per_student,
    instructorId: row.instructor_id,
    status: row.status,
    price: row.price === null ? null : Number(row.price),
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class LessonProductsService {
  constructor(
    private readonly repo: LessonProductsRepository,
    private readonly audit: AuditService,
  ) {}

  async list(status?: LessonProductStatus): Promise<LessonProduct[]> {
    return (await this.repo.list(status)).map(toLessonProduct);
  }

  async update(
    id: string,
    dto: UpdateLessonProductDto,
    actor: AuditActor,
  ): Promise<LessonProduct> {
    const patch = toPatch(dto);
    const fields = Object.keys(patch) as (keyof LessonProductPatch)[];
    if (fields.length === 0) {
      throw new BadRequestException(LESSON_PRODUCT_NOTHING_TO_UPDATE);
    }
    const before = await this.repo.findById(id);
    if (!before) {
      throw new NotFoundException(LESSON_PRODUCT_NOT_FOUND);
    }
    if (
      patch.instructor_id &&
      !(await this.repo.instructorExists(patch.instructor_id))
    ) {
      throw new BadRequestException(LESSON_PRODUCT_INSTRUCTOR_NOT_FOUND);
    }
    const merged = { ...before, ...patch };
    if (merged.status === 'confirmed' && merged.sessions === null) {
      throw new BadRequestException(LESSON_PRODUCT_SESSIONS_REQUIRED);
    }
    const row = await this.repo.update(id, before.updated_at, patch);
    if (!row) {
      throw new ConflictException(LESSON_PRODUCT_CONFLICT);
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.lessonProductUpdate,
      actor: { ...actor, role: 'admin' },
      targetType: 'lesson_product',
      targetId: row.id,
      metadata: {
        shopifyVariantId: Number(row.shopify_variant_id),
        before: pick(before, fields),
        after: pick(row, fields),
      },
    });
    return toLessonProduct(row);
  }
}

function toPatch(dto: UpdateLessonProductDto): LessonProductPatch {
  const patch: Record<string, unknown> = {};
  for (const [from, to] of PATCH_FIELDS) {
    if (dto[from] !== undefined) {
      patch[to] = dto[from];
    }
  }
  return patch;
}

function pick(
  row: LessonProductRow,
  fields: (keyof LessonProductPatch)[],
): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, row[field]]));
}
