export const LESSON_TYPES = [
  'private',
  'semi_private',
  'group',
  'other',
] as const;
export type LessonType = (typeof LESSON_TYPES)[number];

export const LESSON_PRODUCT_STATUSES = [
  'suggested',
  'confirmed',
  'ignored',
] as const;
export type LessonProductStatus = (typeof LESSON_PRODUCT_STATUSES)[number];

export type PurchaseStatus = 'active' | 'refunded' | 'void';

export type ClassStatus = 'scheduled' | 'completed' | 'no_show' | 'cancelled';
export type ClassSource = 'ssms' | 'app_import' | 'app_webhook';
export type Attendance = 'expected' | 'attended' | 'no_show';

export interface LessonSuggestion {
  lessonType: LessonType;
  groupSize: number | null;
  sessions: number | null;
  durationMin: number | null;
  pricedPerStudent: boolean;
  instructorId: string | null;
}

export interface LessonProductRow {
  id: string;
  shopify_product_id: number;
  shopify_variant_id: number;
  product_title: string;
  variant_title: string | null;
  lesson_type: LessonType;
  group_size: number | null;
  sessions: number | null;
  duration_min: number | null;
  priced_per_student: boolean;
  instructor_id: string | null;
  status: LessonProductStatus;
  price: number | string | null;
  currency: string | null;
  created_at: string;
  updated_at: string;
}

export interface LessonProduct {
  id: string;
  shopifyProductId: number;
  shopifyVariantId: number;
  productTitle: string;
  variantTitle: string | null;
  lessonType: LessonType;
  groupSize: number | null;
  sessions: number | null;
  durationMin: number | null;
  pricedPerStudent: boolean;
  instructorId: string | null;
  status: LessonProductStatus;
  price: number | null;
  currency: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseCredits {
  id: string;
  credits_total: number;
  credits_used: number;
  status: PurchaseStatus;
}
