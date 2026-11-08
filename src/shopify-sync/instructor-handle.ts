import { pinyin } from 'pinyin-pro';
import type { SyncInstructorRow } from './instructor-sync.types';

const MAX_HANDLE_LENGTH = 60;

export type HandleSource = Pick<
  SyncInstructorRow,
  'id' | 'display_name_en' | 'display_name_zh' | 'first_name'
>;

export function baseHandle(instructor: HandleSource): string {
  const candidates = [
    instructor.display_name_en,
    instructor.first_name,
    romanized(instructor.display_name_zh),
  ];
  for (const candidate of candidates) {
    const slug = slugify(candidate ?? '');
    if (slug !== '') {
      return slug;
    }
  }
  return fallbackHandle(instructor.id);
}

export function isFallbackHandle(
  handle: string,
  instructorId: string,
): boolean {
  const fallback = fallbackHandle(instructorId);
  return handle === fallback || new RegExp(`^${fallback}-\\d+$`).test(handle);
}

export function handleCandidate(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base}-${attempt}`;
}

function fallbackHandle(instructorId: string): string {
  return `instructor-${instructorId.slice(0, 8)}`;
}

function romanized(chinese: string | null): string {
  if (!chinese) {
    return '';
  }
  return pinyin(chinese, {
    toneType: 'none',
    type: 'array',
    nonZh: 'consecutive',
  }).join('-');
}

function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_HANDLE_LENGTH)
    .replace(/^-+|-+$/g, '');
}
