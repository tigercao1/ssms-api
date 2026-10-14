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

/** The time zone the school operates in; certification dates are calendar dates there. */
export const SCHOOL_TIME_ZONE = 'America/Toronto';

const SCHOOL_CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: SCHOOL_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function wallClock(at: Date): Record<string, number> {
  const parts: Record<string, number> = {};
  for (const part of SCHOOL_CLOCK.formatToParts(at)) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return parts;
}

function offsetMs(instant: number): number {
  const w = wallClock(new Date(instant));
  const asUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The calendar date (YYYY-MM-DD) in {@link SCHOOL_TIME_ZONE} at `now`. Every
 * documents date (validity, expiry emails, upload checks, signing date) uses
 * it; the database runs in UTC, so it is passed in rather than read from
 * Postgres `current_date`.
 */
export function torontoToday(now: Date = new Date()): string {
  const w = wallClock(now);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** The instant (ISO, UTC) at which `date` (YYYY-MM-DD) starts in {@link SCHOOL_TIME_ZONE}. */
export function torontoStartOfDay(date: string): string {
  const wall = dayNumber(date) * MS_PER_DAY;
  const instant = wall - offsetMs(wall - offsetMs(wall));
  return new Date(instant).toISOString();
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

/** The two expiry emails an upload can get, once each. */
export type ExpiryReminder = 'expiring' | 'expired';

/** Days after `validUntil` during which a missed `expired` email is still sent. */
export const EXPIRED_REMINDER_GRACE_DAYS = 7;

/** The fields of an upload the expiry reminder rule reads. */
export interface ExpiryReminderStatus extends CertificationUploadStatus {
  expiryReminderSentAt: string | null;
}

/** `date` (YYYY-MM-DD) moved by `days` (may be negative). */
export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * Which expiry email `expiry_reminder_sent_at` records, read against the
 * upload's current `validUntil` using the Toronto date it was sent: sent after `validUntil` → `expired`; sent
 * within {@link EXPIRING_WITHIN_DAYS} days before it (inclusive) → `expiring`;
 * unset, or sent before that window (the date was moved later) → none.
 */
export function expiryReminderSent(
  sentAt: string | null,
  validUntil: string,
): ExpiryReminder | null {
  if (!sentAt) {
    return null;
  }
  const sentDaysAfter = daysBetween(validUntil, torontoToday(new Date(sentAt)));
  if (sentDaysAfter > 0) {
    return 'expired';
  }
  return sentDaysAfter >= -EXPIRING_WITHIN_DAYS ? 'expiring' : null;
}

/**
 * The expiry email due for a current upload on `today`, if any. `expiring`
 * while `validUntil` is 0–{@link EXPIRING_WITHIN_DAYS} days away and nothing
 * was sent; `expired` from the day after `validUntil` (for up to
 * {@link EXPIRED_REMINDER_GRACE_DAYS} days, so a missed run catches up) unless
 * it was already sent. Rejected uploads get neither.
 */
export function expiryReminderDue(
  upload: ExpiryReminderStatus,
  today: string,
): ExpiryReminder | null {
  if (upload.reviewStatus === 'rejected') {
    return null;
  }
  const daysLeft = daysBetween(today, upload.validUntil);
  const sent = expiryReminderSent(
    upload.expiryReminderSentAt,
    upload.validUntil,
  );
  if (daysLeft < 0) {
    return daysLeft >= -EXPIRED_REMINDER_GRACE_DAYS && sent !== 'expired'
      ? 'expired'
      : null;
  }
  return daysLeft <= EXPIRING_WITHIN_DAYS && sent === null ? 'expiring' : null;
}
