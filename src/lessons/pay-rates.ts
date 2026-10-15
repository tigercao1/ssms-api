export const RATE_UNITS = ['hour', 'day'] as const;
export type RateUnit = (typeof RATE_UNITS)[number];
export const DEFAULT_RATE_UNIT: RateUnit = 'hour';

export interface EffectiveRate {
  lessonTypeId: string;
  instructorId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function isEffectiveOn(rate: EffectiveRate, date: string): boolean {
  return (
    rate.effectiveFrom <= date &&
    (rate.effectiveTo === null || date <= rate.effectiveTo)
  );
}

export function resolveRate<T extends EffectiveRate>(
  rates: readonly T[],
  instructorId: string,
  lessonTypeId: string,
  date: string,
): T | null {
  if (!isIsoDate(date)) {
    throw new RangeError(`Invalid lesson date '${date}'`);
  }
  const effective = rates
    .filter((r) => r.lessonTypeId === lessonTypeId && isEffectiveOn(r, date))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return (
    effective.find((r) => r.instructorId === instructorId) ??
    effective.find((r) => r.instructorId === null) ??
    null
  );
}
