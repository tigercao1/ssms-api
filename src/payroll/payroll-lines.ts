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
export const ADJUSTED = 'adjusted';
export const CHANGED_LENGTH = 'changed_length';
export const CHANGED_LESSON_TYPE = 'changed_lesson_type';
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

function latestTerms(lines: readonly ClassLine[]): ClassLine | null {
  return lines.filter((line) => !isMarker(line)).at(-1) ?? null;
}

function lessonCount(line: ClassLine): number {
  if (
    isMarker(line) ||
    line.flags.includes(CORRECTION) ||
    line.flags.includes(ADJUSTED)
  ) {
    return 0;
  }
  return line.flags.includes(LATE_CANCEL) ? -1 : 1;
}

function minuteCount(line: ClassLine): number {
  return line.flags.includes(ADJUSTED)
    ? line.minutes
    : lessonCount(line) * line.minutes;
}

function heldLessons(lines: readonly ClassLine[]): number {
  return lines.reduce((sum, line) => sum + lessonCount(line), 0);
}

function heldMinutes(lines: readonly ClassLine[]): number {
  const paying = lines.filter((line) => !isMarker(line));
  const base = paying.findLastIndex((line) => !line.flags.includes(ADJUSTED));
  const adjustments = paying
    .slice(base + 1)
    .reduce((sum, line) => sum + line.minutes, 0);
  return (base >= 0 ? paying[base].minutes : 0) + adjustments;
}

function othersHold(
  instructorId: string,
  lines: readonly ClassLine[],
): boolean {
  return [
    ...groupBy(
      lines.filter((line) => line.instructorId !== instructorId),
      (line) => `${line.instructorId}|${line.currency}`,
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
    lessonTypeId: reference.lessonTypeId,
    description: reference.description,
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

function byCurrency(lines: readonly ClassLine[]): ClassLine[][] {
  return [...groupBy(lines, (line) => line.currency).values()];
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
  const reference = latestTerms(paid) ?? paid[paid.length - 1];
  return settlementLine(
    cls,
    { ...reference, minutes: Math.max(0, heldMinutes(paid)) },
    -net,
    [LATE_CANCEL, ...(net < 0 ? [CORRECTION] : []), ...extraFlags],
  );
}

function changes(
  target: ClassLine,
  held: ClassLine,
  mine: readonly ClassLine[],
): string[] {
  return [
    ...(target.minutes !== heldMinutes(mine) ? [CHANGED_LENGTH] : []),
    ...(target.lessonTypeId !== held.lessonTypeId ? [CHANGED_LESSON_TYPE] : []),
  ];
}

function owedTarget(
  cls: PayableClass,
  mine: readonly ClassLine[],
  rates: readonly PayableRate[],
): ClassLine {
  const live = { ...classLine(cls, rates), instructorId: cls.instructorId };
  const paidAt = mine.find(
    (line) => !isMarker(line) && line.lessonTypeId === cls.lessonTypeId,
  );
  if (!paidAt) {
    return live;
  }
  return {
    ...live,
    hourlyRate: paidAt.hourlyRate,
    rateUnit: paidAt.rateUnit,
    currency: paidAt.currency,
    amount:
      paidAt.hourlyRate === null
        ? 0
        : fromCents(
            rateAmountCents(paidAt.hourlyRate, paidAt.rateUnit, live.minutes),
          ),
    flags: [],
  };
}

function owedLines(
  cls: PayableClass,
  mine: readonly ClassLine[],
  rates: readonly PayableRate[],
  reassigned: boolean,
  late: boolean,
): ClassLine[] {
  const target = owedTarget(cls, mine, rates);
  const needsRate = target.flags.includes(NEEDS_RATE);
  const terms = latestTerms(mine);
  if (!terms) {
    return late && (needsRate || toCents(target.amount) !== 0)
      ? [
          settlementLine(cls, target, toCents(target.amount), [
            LATE,
            ...(reassigned ? [REASSIGNED] : []),
            ...(needsRate ? [NEEDS_RATE] : []),
          ]),
        ]
      : [];
  }
  const held = heldLessons(mine);
  const adjusting = held === 1 || (held === 0 && netCents(mine) > 0);
  const reasons = changes(target, terms, mine);
  const groups = groupBy(mine, (line) => line.currency);
  const currencies = new Set([target.currency, ...groups.keys()]);
  const lines: ClassLine[] = [];
  for (const currency of currencies) {
    const paid = groups.get(currency) ?? [];
    const owing = currency === target.currency;
    const diff = (owing ? toCents(target.amount) : 0) - netCents(paid);
    if (diff === 0) {
      continue;
    }
    const reference = owing ? target : (latestTerms(paid) ?? paid[0]);
    const flags = adjusting
      ? [ADJUSTED, ...reasons]
      : [
          LATE,
          ...(diff < 0 ? [CORRECTION] : []),
          ...(reassigned ? [REASSIGNED] : []),
        ];
    lines.push(
      settlementLine(
        cls,
        {
          ...reference,
          instructorId: cls.instructorId,
          minutes: adjusting
            ? (owing ? target.minutes : 0) - heldMinutes(paid)
            : Math.max(0, reference.minutes),
        },
        diff,
        [...flags, ...(owing && needsRate ? [NEEDS_RATE] : [])],
      ),
    );
  }
  return lines;
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
    ...(isPaid(cls.status)
      ? owedLines(
          cls,
          mine,
          rates,
          byInstructor.size > 0,
          ownPeriodFinalized || othersHold(cls.instructorId, paid),
        )
      : byCurrency(mine).map((group) => reversalLine(cls, group, []))),
    ...[...byInstructor.values()].flatMap((theirs) =>
      byCurrency(theirs).map((group) => reversalLine(cls, group, [REASSIGNED])),
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
    total.lessons += lessonCount(line);
    total.minutes += minuteCount(line);
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
