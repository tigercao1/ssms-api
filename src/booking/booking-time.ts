export const SCHOOL_TIME_ZONE = 'America/Toronto';

export const WEEKDAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHOOL_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export interface LocalParts {
  date: string;
  time: string;
  weekday: Weekday;
}

function wallClock(instant: number): number[] {
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return [
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ];
}

function offsetAt(instant: number): number {
  const [y, mo, d, h, mi, s] = wallClock(instant);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  return asUtc - (instant - (instant % 1000));
}

const pad = (n: number) => String(n).padStart(2, '0');

export function localParts(instant: string | number | Date): LocalParts {
  const ms = new Date(instant).getTime();
  const [y, mo, d, h, mi] = wallClock(ms);
  const weekdayIndex = (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;
  return {
    date: `${y}-${pad(mo)}-${pad(d)}`,
    time: `${pad(h)}:${pad(mi)}`,
    weekday: WEEKDAYS[weekdayIndex],
  };
}

export function isTimeOfDay(value: unknown): value is string {
  return typeof value === 'string' && TIME_OF_DAY.test(value);
}

export function minutesOfDay(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function weekdayOf(date: string): Weekday {
  const [, y, m, d] = DATE_ONLY.exec(date)!.map(Number);
  return WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
}

export function addDays(date: string, days: number): string {
  const [, y, m, d] = DATE_ONLY.exec(date)!.map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function zonedInstant(date: string, time: string): Date {
  const [, y, mo, d] = DATE_ONLY.exec(date)!.map(Number);
  const wall = Date.UTC(y, mo - 1, d) + minutesOfDay(time) * MINUTE_MS;
  let guess = wall - offsetAt(wall);
  const corrected = wall - offsetAt(guess);
  if (corrected !== guess) {
    guess = corrected;
  }
  return new Date(guess);
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MINUTE_MS);
}
