import {
  DEFAULT_RATE_UNIT,
  type EffectiveRate,
  type RateUnit,
  resolveRate,
} from '../lessons/pay-rates';
import type { ClassStatus } from '../lessons/lessons.types';
import { localDate } from './payroll-time';

export const NEEDS_RATE = 'needs_rate';
export const ALREADY_PAID = 'already_paid';
export const LATE = 'late';
export const LATE_CANCEL = 'late_cancel';
export const CORRECTION = 'correction';
export const REASSIGNED = 'reassigned';
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
  rateUnit: RateUnit;
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
  rateUnit: RateUnit;
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

export function rateAmountCents(
  rate: number | string,
  unit: RateUnit,
  minutes: number,
): number {
  return unit === 'day' ? toCents(rate) : amountCents(rate, minutes);
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
    rateUnit: rate?.rateUnit ?? DEFAULT_RATE_UNIT,
    currency: rate?.currency ?? DEFAULT_CURRENCY,
    amount: rate
      ? fromCents(rateAmountCents(rate.hourlyRate, rate.rateUnit, minutes))
      : 0,
    flags: rate ? [] : [NEEDS_RATE],
  };
}

function isMarker(line: ClassLine): boolean {
  return line.flags.includes(ALREADY_PAID);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  }
  return groups;
}

function netCents(lines: readonly ClassLine[]): number {
  return lines.reduce((sum, line) => sum + toCents(line.amount), 0);
}

function paidTerms(lines: readonly ClassLine[]): ClassLine | null {
  return lines.find((line) => !isMarker(line)) ?? null;
}

function termsCents(line: ClassLine): number {
  return line.hourlyRate === null
    ? 0
    : rateAmountCents(line.hourlyRate, line.rateUnit, line.minutes);
}

function othersHold(
  instructorId: string,
  lines: readonly ClassLine[],
): boolean {
  return [
    ...groupBy(
      lines.filter((line) => line.instructorId !== instructorId),
      (line) => line.instructorId,
    ).values(),
  ].some((theirs) => netCents(theirs) !== 0);
}

function alreadyPaid(line: ClassLine): ClassLine {
  return { ...line, amount: 0, flags: [ALREADY_PAID] };
}

export function settledLine(
  line: ClassLine,
  elsewhere: readonly ClassLine[],
): ClassLine {
  const mine = elsewhere.filter((l) => l.instructorId === line.instructorId);
  return paidTerms(mine) || othersHold(line.instructorId, elsewhere)
    ? alreadyPaid(line)
    : line;
}

export function settleLines(
  lines: readonly ClassLine[],
  elsewhere: readonly ClassLine[],
): ClassLine[] {
  const byClass = groupBy(elsewhere, (line) => line.classId);
  return lines.map((line) =>
    settledLine(line, byClass.get(line.classId) ?? []),
  );
}

export function notSettledBy(
  settlements: readonly ClassLine[],
): (line: ClassLine) => boolean {
  const pair = (line: ClassLine) => `${line.classId}|${line.instructorId}`;
  const settled = new Set(settlements.map(pair));
  return (line) => !settled.has(pair(line));
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

function settlementLine(
  cls: PayableClass,
  reference: ClassLine,
  cents: number,
  flags: string[],
): ClassLine {
  return {
    classId: cls.id,
    instructorId: reference.instructorId,
    lessonTypeId: cls.lessonTypeId,
    description: cls.lessonTypeName,
    classStatus: cls.status,
    startsAt: cls.startsAt,
    endsAt: cls.endsAt,
    customerNames: cls.customerNames,
    minutes: reference.minutes,
    hourlyRate: reference.hourlyRate,
    rateUnit: reference.rateUnit,
    currency: reference.currency,
    amount: fromCents(cents),
    flags,
  };
}

function reversalLine(
  cls: PayableClass,
  paid: readonly ClassLine[],
  extraFlags: string[],
): ClassLine | null {
  const net = netCents(paid);
  if (net === 0) {
    return null;
  }
  const reference = paidTerms(paid) ?? paid[paid.length - 1];
  return settlementLine(cls, reference, -net, [
    LATE_CANCEL,
    ...(net < 0 ? [CORRECTION] : []),
    ...extraFlags,
  ]);
}

function owedLine(
  cls: PayableClass,
  paid: readonly ClassLine[],
  rates: readonly PayableRate[],
  reassigned: boolean,
  late: boolean,
): ClassLine | null {
  const terms = paidTerms(paid);
  if (!terms && !late) {
    return null;
  }
  const reference = terms ?? classLine(cls, rates);
  const needsRate = !terms && reference.flags.includes(NEEDS_RATE);
  const owed = terms ? termsCents(terms) : toCents(reference.amount);
  const diff = owed - netCents(paid);
  if (diff === 0 && !needsRate) {
    return null;
  }
  return settlementLine(
    cls,
    { ...reference, instructorId: cls.instructorId },
    diff,
    [
      LATE,
      ...(diff < 0 ? [CORRECTION] : []),
      ...(reassigned ? [REASSIGNED] : []),
      ...(needsRate ? [NEEDS_RATE] : []),
    ],
  );
}

export function lateLines(
  cls: PayableClass,
  paid: readonly ClassLine[],
  rates: readonly PayableRate[],
  ownPeriodFinalized: boolean,
): ClassLine[] {
  const byInstructor = groupBy(paid, (line) => line.instructorId);
  const mine = byInstructor.get(cls.instructorId) ?? [];
  byInstructor.delete(cls.instructorId);
  const lines = [
    isPaid(cls.status)
      ? owedLine(
          cls,
          mine,
          rates,
          byInstructor.size > 0,
          ownPeriodFinalized || othersHold(cls.instructorId, paid),
        )
      : reversalLine(cls, mine, []),
    ...[...byInstructor.values()].map((theirs) =>
      reversalLine(cls, theirs, [REASSIGNED]),
    ),
  ];
  return lines.filter((line): line is ClassLine => line !== null);
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
    if (line.flags.includes(ALREADY_PAID)) {
      continue;
    }
    const sign = line.flags.includes(CORRECTION)
      ? 0
      : line.flags.includes(LATE_CANCEL)
        ? -1
        : 1;
    total.lessons += sign;
    total.minutes += sign * line.minutes;
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
