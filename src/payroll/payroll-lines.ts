import { type EffectiveRate, resolveRate } from '../lessons/pay-rates';
import type { ClassStatus } from '../lessons/lessons.types';
import { localDate } from './payroll-time';

export const NEEDS_RATE = 'needs_rate';
export const DEFAULT_CURRENCY = 'CAD';

export interface PayableClass {
  id: string;
  instructorId: string;
  lessonTypeId: string | null;
  lessonTypeName: string | null;
  status: ClassStatus;
  startsAt: string;
  endsAt: string;
  customerNames: string[];
}

export interface PayableRate extends EffectiveRate {
  hourlyRate: number | string;
  currency: string;
}

export interface ClassLine {
  classId: string;
  instructorId: string;
  lessonTypeId: string | null;
  description: string | null;
  classStatus: ClassStatus;
  startsAt: string;
  endsAt: string;
  customerNames: string[];
  minutes: number;
  hourlyRate: number | null;
  currency: string;
  amount: number;
  flags: string[];
}

export function toCents(value: number | string): number {
  return Math.round(Number(value) * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export function lessonMinutes(startsAt: string, endsAt: string): number {
  const ms = Date.parse(endsAt) - Date.parse(startsAt);
  return Math.max(0, Math.round(ms / 60_000));
}

export function amountCents(hourlyRate: number | string, minutes: number) {
  return Math.round((toCents(hourlyRate) * minutes) / 60);
}

export function isPaid(status: ClassStatus): boolean {
  return status !== 'cancelled';
}

export function classLine(
  cls: PayableClass,
  rates: readonly PayableRate[],
): ClassLine {
  const minutes = lessonMinutes(cls.startsAt, cls.endsAt);
  const rate = cls.lessonTypeId
    ? resolveRate(
        rates,
        cls.instructorId,
        cls.lessonTypeId,
        localDate(cls.startsAt),
      )
    : null;
  return {
    classId: cls.id,
    instructorId: cls.instructorId,
    lessonTypeId: cls.lessonTypeId,
    description: cls.lessonTypeName,
    classStatus: cls.status,
    startsAt: cls.startsAt,
    endsAt: cls.endsAt,
    customerNames: cls.customerNames,
    minutes,
    hourlyRate: rate ? fromCents(toCents(rate.hourlyRate)) : null,
    currency: rate?.currency ?? DEFAULT_CURRENCY,
    amount: rate ? fromCents(amountCents(rate.hourlyRate, minutes)) : 0,
    flags: rate ? [] : [NEEDS_RATE],
  };
}

export function classLinesFor(
  classes: readonly PayableClass[],
  rates: readonly PayableRate[],
  startsOn: string,
  endsOn: string,
): ClassLine[] {
  return classes
    .filter((cls) => isPaid(cls.status))
    .filter((cls) => {
      const date = localDate(cls.startsAt);
      return startsOn <= date && date <= endsOn;
    })
    .map((cls) => classLine(cls, rates))
    .sort(
      (a, b) =>
        a.startsAt.localeCompare(b.startsAt) ||
        a.classId.localeCompare(b.classId),
    );
}

export interface AmountLine {
  instructorId: string;
  currency: string;
  amount: number;
}

export interface InstructorTotal {
  instructorId: string;
  currency: string;
  lessons: number;
  minutes: number;
  lessonAmount: number;
  adjustmentAmount: number;
  total: number;
  needsRate: number;
}

export function instructorTotals(
  lines: readonly ClassLine[],
  adjustments: readonly AmountLine[],
): InstructorTotal[] {
  const totals = new Map<
    string,
    InstructorTotal & { lessonCents: number; adjustmentCents: number }
  >();
  const entry = (instructorId: string, currency: string) => {
    const key = `${instructorId}|${currency}`;
    let total = totals.get(key);
    if (!total) {
      total = {
        instructorId,
        currency,
        lessons: 0,
        minutes: 0,
        lessonAmount: 0,
        adjustmentAmount: 0,
        total: 0,
        needsRate: 0,
        lessonCents: 0,
        adjustmentCents: 0,
      };
      totals.set(key, total);
    }
    return total;
  };
  for (const line of lines) {
    const total = entry(line.instructorId, line.currency);
    total.lessons += 1;
    total.minutes += line.minutes;
    total.lessonCents += toCents(line.amount);
    if (line.flags.includes(NEEDS_RATE)) {
      total.needsRate += 1;
    }
  }
  for (const adjustment of adjustments) {
    entry(adjustment.instructorId, adjustment.currency).adjustmentCents +=
      toCents(adjustment.amount);
  }
  return [...totals.values()].map(
    ({ lessonCents, adjustmentCents, ...total }) => ({
      ...total,
      lessonAmount: fromCents(lessonCents),
      adjustmentAmount: fromCents(adjustmentCents),
      total: fromCents(lessonCents + adjustmentCents),
    }),
  );
}

export interface CurrencyTotal {
  currency: string;
  lessons: number;
  minutes: number;
  amount: number;
}

export function currencyTotals(
  totals: readonly InstructorTotal[],
): CurrencyTotal[] {
  const byCurrency = new Map<string, CurrencyTotal & { cents: number }>();
  for (const total of totals) {
    const entry = byCurrency.get(total.currency) ?? {
      currency: total.currency,
      lessons: 0,
      minutes: 0,
      amount: 0,
      cents: 0,
    };
    entry.lessons += total.lessons;
    entry.minutes += total.minutes;
    entry.cents += toCents(total.total);
    byCurrency.set(total.currency, entry);
  }
  return [...byCurrency.values()]
    .map(({ cents, ...entry }) => ({ ...entry, amount: fromCents(cents) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
