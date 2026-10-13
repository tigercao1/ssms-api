export const SCHOOL_TIME_ZONE = 'America/Toronto';
export const PERIOD_DAYS = 14;

const DAY_MS = 86_400_000;

const partsFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: SCHOOL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(instant: Date): WallClock {
  const parts: Record<string, number> = {};
  for (const part of partsFormat.formatToParts(instant)) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

function toInstant(value: string | Date): Date {
  return typeof value === 'string' ? new Date(value) : value;
}

export function localDate(value: string | Date): string {
  const w = wallClock(toInstant(value));
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

export function localTime(value: string | Date): string {
  const w = wallClock(toInstant(value));
  return `${pad(w.hour)}:${pad(w.minute)}`;
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

function dateParts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y, m, d];
}

export function startOfLocalDay(date: string): string {
  const [y, m, d] = dateParts(date);
  const wall = Date.UTC(y, m - 1, d);
  let instant = wall - offsetMs(wall);
  instant = wall - offsetMs(instant);
  return new Date(instant).toISOString();
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = dateParts(date);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = dateParts(from);
  const [ty, tm, td] = dateParts(to);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS,
  );
}

export interface PeriodRange {
  startsOn: string;
  endsOn: string;
}

export function periodContaining(anchor: string, date: string): PeriodRange {
  const index = Math.floor(daysBetween(anchor, date) / PERIOD_DAYS);
  const startsOn = addDays(anchor, index * PERIOD_DAYS);
  return { startsOn, endsOn: addDays(startsOn, PERIOD_DAYS - 1) };
}

export function periodsAround(
  anchor: string,
  date: string,
  before: number,
  after: number,
): PeriodRange[] {
  const center = periodContaining(anchor, date).startsOn;
  const periods: PeriodRange[] = [];
  for (let i = -before; i <= after; i++) {
    const startsOn = addDays(center, i * PERIOD_DAYS);
    periods.push({ startsOn, endsOn: addDays(startsOn, PERIOD_DAYS - 1) });
  }
  return periods;
}
