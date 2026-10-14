import type { CertOrg, CertTrack, ReviewStatus } from './documents.types';

export const CERTIFICATION_STATES = [
  'missing',
  'pending',
  'valid',
  'expiring',
  'expired',
  'rejected',
] as const;
export type CertificationState = (typeof CERTIFICATION_STATES)[number];

/** A current upload counts as `expiring` when `validUntil` is at most this many days away. */
export const EXPIRING_WITHIN_DAYS = 30;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** The fields of an upload the validity rule reads. */
export interface CertificationUploadStatus {
  reviewStatus: ReviewStatus;
  validUntil: string;
}

/** The fields needed to pick the current upload per `(org, track)`. */
export interface KeyedCertificationUpload {
  org: CertOrg;
  track: CertTrack;
  insertedAt: string;
}

function dayNumber(date: string): number {
  if (!DATE_PATTERN.test(date)) {
    throw new Error(`Expected a YYYY-MM-DD date, got "${date}"`);
  }
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** Today's date (YYYY-MM-DD) in UTC, matching Postgres `current_date` on Supabase. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Checklist state of the current certification upload for one `(org, track)`:
 * `missing` without an upload, `rejected` when the admin rejected it, `expired`
 * once `validUntil` is before `today`, `pending` while awaiting review, then
 * `expiring` within {@link EXPIRING_WITHIN_DAYS} days and `valid` otherwise.
 * `validUntil` itself is the last valid day.
 */
export function certificationState(
  upload: CertificationUploadStatus | null | undefined,
  today: string,
): CertificationState {
  if (!upload) {
    return 'missing';
  }
  if (upload.reviewStatus === 'rejected') {
    return 'rejected';
  }
  const daysLeft = daysBetween(today, upload.validUntil);
  if (daysLeft < 0) {
    return 'expired';
  }
  if (upload.reviewStatus === 'pending') {
    return 'pending';
  }
  return daysLeft <= EXPIRING_WITHIN_DAYS ? 'expiring' : 'valid';
}

/** Whether a state satisfies the certification requirement (no new upload needed). */
export function isCertificationSatisfied(state: CertificationState): boolean {
  return state === 'valid' || state === 'expiring' || state === 'pending';
}

/** Map key for an `(org, track)` pair. */
export function certificationKey(org: CertOrg, track: CertTrack): string {
  return `${org}:${track}`;
}

/** The latest upload per `(org, track)` (by `insertedAt`), keyed by {@link certificationKey}. */
export function currentUploads<T extends KeyedCertificationUpload>(
  uploads: readonly T[],
): Map<string, T> {
  const current = new Map<string, T>();
  for (const upload of uploads) {
    const key = certificationKey(upload.org, upload.track);
    const seen = current.get(key);
    if (!seen || Date.parse(upload.insertedAt) > Date.parse(seen.insertedAt)) {
      current.set(key, upload);
    }
  }
  return current;
}
