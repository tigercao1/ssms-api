import type { SyncInstructorRow } from './instructor-sync.types';

const MAX_HANDLE_LENGTH = 60;
const SUFFIX_LENGTHS = [4, 6, 8];

export type HandleSource = Pick<
  SyncInstructorRow,
  'id' | 'display_name_en' | 'first_name'
>;

export function baseHandle(instructor: HandleSource): string {
  for (const candidate of [instructor.display_name_en, instructor.first_name]) {
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
  return (
    handle === fallback ||
    new RegExp(`^${fallback}-\\d+$`).test(handle) ||
    handleCandidates(fallback, instructorId).includes(handle)
  );
}

export function handleCandidates(base: string, instructorId: string): string[] {
  const hex = instructorId.replace(/-/g, '').toLowerCase();
  return [base, ...SUFFIX_LENGTHS.map((n) => `${base}-${hex.slice(0, n)}`)];
}

function fallbackHandle(instructorId: string): string {
  return `instructor-${instructorId.slice(0, 8)}`;
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
