import type { InstructorHandleSource } from '../../src/lessons/lesson-title.parser';
import {
  type LessonProductPatch,
  type LessonProductSyncCounts,
  type LessonProductSyncRow,
  LessonProductsRepository,
} from '../../src/lessons/lesson-products.repository';
import type {
  LessonProductRow,
  LessonProductStatus,
} from '../../src/lessons/lessons.types';
import type { ShopifyAdminClient } from '../../src/shopify/shopify-admin.client';
import {
  type ClassFilter,
  ClassesRepository,
  type ClassRow,
} from '../../src/lessons/classes.repository';
import {
  type InstructorCalendarRow,
  InstructorCalendarsRepository,
} from '../../src/lessons/instructor-calendars.repository';

export interface FakeVariant {
  id: number;
  title: string;
  price: string;
}

export interface FakeProduct {
  id: number;
  title: string;
  collections: string[];
  variants: FakeVariant[];
  moreVariants?: boolean;
}

export function catalogPage(
  products: FakeProduct[],
  next: string | null = null,
  currencyCode = 'CAD',
) {
  return {
    shop: { currencyCode },
    products: {
      pageInfo: { hasNextPage: next !== null, endCursor: next },
      nodes: products.map((p) => ({
        legacyResourceId: String(p.id),
        title: p.title,
        collections: {
          pageInfo: { hasNextPage: false },
          nodes: p.collections.map((handle) => ({ handle })),
        },
        variants: {
          pageInfo: { hasNextPage: p.moreVariants ?? false },
          nodes: p.variants.map((v) => ({
            legacyResourceId: String(v.id),
            title: v.title,
            price: v.price,
          })),
        },
      })),
    },
  };
}

export function fakeShopify(pages: unknown[]) {
  const graphql = jest.fn((...args: [string, Record<string, unknown>]) => {
    expect(args[0]).toContain('products(');
    const page = pages.shift();
    if (page instanceof Error) {
      return Promise.reject(page);
    }
    return Promise.resolve(page);
  });
  return {
    client: { graphql } as unknown as ShopifyAdminClient,
    graphql,
  };
}

export const EDDIE_ID = '0b6f4c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b';
export const ERIC_ID = '1c7a5d2f-3b4e-4f6a-9b0c-1d2e3f4a5b6c';

export const eddieProducts: FakeProduct[] = [
  {
    id: 8827109769238,
    title: '一对一',
    collections: ['eddie', 'all-lessons'],
    variants: [
      { id: 47123482771478, title: '单次', price: '280.00' },
      { id: 47123482804246, title: '四次', price: '1080.00' },
    ],
  },
  {
    id: 8827109802006,
    title: '一对二',
    collections: ['eddie'],
    variants: [
      { id: 47123482902550, title: '单次 每位学员单价', price: '180.00' },
      { id: 47123482935318, title: '四次 每位学员单价', price: '680.00' },
    ],
  },
];

export const campProduct: FakeProduct = {
  id: 9000000000001,
  title: 'Blue Mountain 4 Day Elite Camp - 2027',
  collections: ['camps'],
  variants: [{ id: 9100000000001, title: 'Default Title', price: '1999.00' }],
};

let sequence = 0;
const nextId = () =>
  `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

export class InMemoryLessonProductsRepository extends LessonProductsRepository {
  rows: LessonProductRow[] = [];
  instructors: InstructorHandleSource[] = [
    { id: EDDIE_ID, displayNameEn: 'Eddie', shopifyHandle: 'eddie' },
    { id: ERIC_ID, displayNameEn: 'Eric Wang', shopifyHandle: null },
  ];
  syncCalls: LessonProductSyncRow[][] = [];
  private clock = Date.parse('2026-10-10T00:00:00.000Z');

  instructorHandleSources(): Promise<InstructorHandleSource[]> {
    return Promise.resolve(this.instructors);
  }

  instructorExists(id: string): Promise<boolean> {
    return Promise.resolve(this.instructors.some((i) => i.id === id));
  }

  sync(rows: LessonProductSyncRow[]): Promise<LessonProductSyncCounts> {
    this.syncCalls.push(rows);
    let inserted = 0;
    let updated = 0;
    for (const incoming of rows) {
      const existing = this.rows.find(
        (r) => r.shopify_variant_id === incoming.shopify_variant_id,
      );
      if (!existing) {
        this.rows.push({
          ...incoming,
          id: nextId(),
          status: 'suggested',
          created_at: this.tick(),
          updated_at: this.tick(),
        });
        inserted++;
        continue;
      }
      const refreshed: LessonProductRow = {
        ...existing,
        shopify_product_id: incoming.shopify_product_id,
        product_title: incoming.product_title,
        variant_title: incoming.variant_title,
        price: incoming.price,
        currency: incoming.currency,
        ...(existing.status === 'suggested'
          ? {
              lesson_type: incoming.lesson_type,
              group_size: incoming.group_size,
              sessions: incoming.sessions,
              duration_min: incoming.duration_min,
              priced_per_student: incoming.priced_per_student,
              instructor_id: incoming.instructor_id,
            }
          : {}),
      };
      if (JSON.stringify(refreshed) !== JSON.stringify(existing)) {
        Object.assign(existing, refreshed, { updated_at: this.tick() });
        updated++;
      }
    }
    return Promise.resolve({ inserted, updated });
  }

  list(status?: LessonProductStatus): Promise<LessonProductRow[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => !status || r.status === status)
        .map((r) => ({ ...r })),
    );
  }

  findById(id: string): Promise<LessonProductRow | null> {
    const row = this.rows.find((r) => r.id === id);
    return Promise.resolve(row ? { ...row } : null);
  }

  update(
    id: string,
    expectedUpdatedAt: string,
    patch: LessonProductPatch,
  ): Promise<LessonProductRow | null> {
    const row = this.rows.find(
      (r) => r.id === id && r.updated_at === expectedUpdatedAt,
    );
    if (!row) {
      return Promise.resolve(null);
    }
    Object.assign(row, patch, { updated_at: this.tick() });
    return Promise.resolve({ ...row });
  }

  seed(overrides: Partial<LessonProductRow> = {}): LessonProductRow {
    const row: LessonProductRow = {
      id: nextId(),
      shopify_product_id: 8827109769238,
      shopify_variant_id: 47123482771478,
      product_title: '一对一',
      variant_title: '单次',
      lesson_type: 'private',
      group_size: 1,
      sessions: 1,
      duration_min: null,
      priced_per_student: false,
      instructor_id: EDDIE_ID,
      status: 'suggested',
      price: '280.00',
      currency: 'CAD',
      created_at: this.tick(),
      updated_at: this.tick(),
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
}

export interface FakeResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

export interface RecordedQuery {
  table: string;
  ops: [string, ...unknown[]][];
}

export function recordingSupabase(
  results: Record<string, FakeResult | FakeResult[]> = {},
) {
  const queries: RecordedQuery[] = [];
  const next = (key: string): FakeResult => {
    const entry = results[key];
    if (Array.isArray(entry)) {
      return entry.shift() ?? { data: null, error: null };
    }
    return entry ?? { data: null, error: null };
  };
  const builderFor = (key: string, query: RecordedQuery) => {
    const builder: Record<string, unknown> = {
      then: (
        resolve: (r: FakeResult) => unknown,
        reject: (e: unknown) => void,
      ) => Promise.resolve(next(key)).then(resolve, reject),
    };
    for (const op of [
      'select',
      'eq',
      'in',
      'gte',
      'lt',
      'limit',
      'order',
      'insert',
      'update',
      'upsert',
      'delete',
      'single',
      'maybeSingle',
    ]) {
      builder[op] = (...args: unknown[]) => {
        query.ops.push([op, ...args]);
        return builder;
      };
    }
    return builder;
  };
  const client = {
    from(table: string) {
      const query: RecordedQuery = { table, ops: [] };
      queries.push(query);
      return builderFor(table, query);
    },
    rpc(name: string, args: unknown) {
      const query: RecordedQuery = {
        table: `rpc:${name}`,
        ops: [['args', args]],
      };
      queries.push(query);
      return builderFor(`rpc:${name}`, query);
    },
  };
  return { client: client as never, queries };
}

export class InMemoryClassesRepository extends ClassesRepository {
  rows: ClassRow[] = [];
  filters: ClassFilter[] = [];

  list(filter: ClassFilter): Promise<ClassRow[]> {
    this.filters.push(filter);
    return Promise.resolve(
      this.rows
        .filter(
          (r) =>
            (!filter.from || r.starts_at >= filter.from) &&
            (!filter.to || r.starts_at < filter.to) &&
            (!filter.instructorId || r.instructor_id === filter.instructorId),
        )
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    );
  }
}

export function classRow(overrides: Partial<ClassRow> = {}): ClassRow {
  return {
    id: nextId(),
    instructor_id: EDDIE_ID,
    lesson_product_id: null,
    location_id: null,
    starts_at: '2026-12-12T15:00:00.000Z',
    ends_at: '2026-12-12T16:00:00.000Z',
    status: 'scheduled',
    source: 'ssms',
    google_calendar_id: null,
    google_event_id: null,
    notes: null,
    created_at: '2026-10-10T00:00:00.000Z',
    updated_at: '2026-10-10T00:00:00.000Z',
    instructor: { display_name_en: 'Eddie', display_name_zh: '艾迪' },
    location: null,
    lesson_product: null,
    participants: [],
    ...overrides,
  };
}

export class InMemoryInstructorCalendarsRepository extends InstructorCalendarsRepository {
  instructorIds = new Set([EDDIE_ID, ERIC_ID]);
  rows = new Map<
    string,
    InstructorCalendarRow & { updated_by: string | null }
  >();
  private clock = Date.parse('2026-10-10T00:00:00.000Z');

  instructorExists(id: string): Promise<boolean> {
    return Promise.resolve(this.instructorIds.has(id));
  }

  find(instructorId: string): Promise<InstructorCalendarRow | null> {
    const row = this.rows.get(instructorId);
    return Promise.resolve(row ? { ...row } : null);
  }

  upsert(
    instructorId: string,
    googleCalendarId: string,
    userId: string | null,
  ): Promise<InstructorCalendarRow> {
    this.clock += 1000;
    const row = {
      instructor_id: instructorId,
      google_calendar_id: googleCalendarId,
      updated_at: new Date(this.clock).toISOString(),
      updated_by: userId,
    };
    this.rows.set(instructorId, row);
    return Promise.resolve({ ...row });
  }

  remove(instructorId: string): Promise<void> {
    this.rows.delete(instructorId);
    return Promise.resolve();
  }
}
