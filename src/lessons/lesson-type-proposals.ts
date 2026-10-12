import { parseCsv } from '../shopify/legacy-pairing/pairing-csv';

export const BOOKING_EXPORT_COLUMNS = {
  eventName: 'event.name',
  startDate: 'date.startDate',
  endDate: 'date.endDate',
} as const;

export interface ParsedEventName {
  groupSize: number | null;
  openGroup: boolean;
  durationMin: number | null;
  isPromo: boolean;
  weekend: boolean;
}

export interface LessonTypeProposal {
  nameEn: string;
  nameZh: string;
  groupSize: number | null;
  durationMin: number | null;
  isPromo: boolean;
  bookings: number;
  observedDurationsMin: number[];
}

const CHINESE_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

export function parseEventName(name: string): ParsedEventName {
  const text = name.normalize('NFKC');
  const ratio =
    /1\s*[对vV]\s*(\d+)(\s*\/?\s*以上)?/.exec(text) ??
    /一\s*对\s*([一二两三四五六])(\s*\/?\s*以上)?/.exec(text);
  const size = ratio ? (CHINESE_DIGITS[ratio[1]] ?? Number(ratio[1])) : null;
  const openGroup = Boolean(ratio?.[2]) || /团课/.test(text);
  const hours = /(\d+(?:\.\d+)?)\s*(?:小时|h\b|hours?)/i.exec(text);
  const minutes = /(\d+)\s*(?:分钟|min)/i.exec(text);
  return {
    groupSize: openGroup ? null : size,
    openGroup,
    durationMin: hours
      ? Math.round(Number(hours[1]) * 60)
      : minutes
        ? Number(minutes[1])
        : null,
    isPromo: /特价|优惠|promo/i.test(text),
    weekend: /周末/.test(text),
  };
}

function englishName(parsed: ParsedEventName, durationMin: number | null) {
  const kind = parsed.openGroup
    ? 'Group'
    : parsed.groupSize === 1
      ? 'Private'
      : parsed.groupSize
        ? `1-on-${parsed.groupSize}`
        : 'Lesson';
  const length =
    durationMin === null
      ? ''
      : durationMin % 60 === 0
        ? ` ${durationMin / 60}h`
        : ` ${durationMin}min`;
  return `${parsed.isPromo ? 'Promo ' : ''}${kind}${length}${parsed.weekend ? ' (weekend)' : ''}`;
}

export function proposeLessonTypes(csvText: string): LessonTypeProposal[] {
  const [header, ...rows] = parseCsv(csvText);
  const index = (column: string) => {
    const i = (header ?? []).indexOf(column);
    if (i < 0) {
      throw new Error(`Booking export is missing the '${column}' column`);
    }
    return i;
  };
  const nameAt = index(BOOKING_EXPORT_COLUMNS.eventName);
  const startAt = index(BOOKING_EXPORT_COLUMNS.startDate);
  const endAt = index(BOOKING_EXPORT_COLUMNS.endDate);

  const byName = new Map<
    string,
    { bookings: number; durations: Set<number> }
  >();
  for (const row of rows) {
    const name = row[nameAt]?.trim();
    if (!name) {
      continue;
    }
    const entry = byName.get(name) ?? { bookings: 0, durations: new Set() };
    entry.bookings++;
    const minutes =
      (Date.parse(row[endAt] ?? '') - Date.parse(row[startAt] ?? '')) / 60000;
    if (Number.isFinite(minutes) && minutes > 0) {
      entry.durations.add(minutes);
    }
    byName.set(name, entry);
  }

  const used = new Map<string, number>();
  return [...byName.entries()]
    .sort((a, b) => b[1].bookings - a[1].bookings || a[0].localeCompare(b[0]))
    .map(([nameZh, entry]) => {
      const parsed = parseEventName(nameZh);
      const observed = [...entry.durations].sort((a, b) => a - b);
      const durationMin =
        parsed.durationMin ?? (observed.length === 1 ? observed[0] : null);
      const base = englishName(parsed, durationMin);
      const seen = (used.get(base) ?? 0) + 1;
      used.set(base, seen);
      return {
        nameEn: seen === 1 ? base : `${base} (${seen})`,
        nameZh,
        groupSize: parsed.groupSize,
        durationMin,
        isPromo: parsed.isPromo,
        bookings: entry.bookings,
        observedDurationsMin: observed,
      };
    });
}
