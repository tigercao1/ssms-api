import { parseCsv } from '../../shopify/legacy-pairing/pairing-csv';

export type CertOrg = 'csia' | 'casi';
export type CertTrack = 'regular' | 'park';

export interface RosterCertification {
  org: CertOrg;
  track: CertTrack;
  level: number;
}

export type DisplayNameSource = 'preferred' | 'legal_first_token' | 'none';
export type DateOfBirthStatus = 'ok' | 'missing' | 'invalid';

/** One CSV row mapped onto SSMS fields. Holds no legal name, phone, address or SIN. */
export interface RosterEntry {
  line: number;
  email: string;
  displayNameEn: string;
  displayNameSource: DisplayNameSource;
  dateOfBirth: string | null;
  dateOfBirthStatus: DateOfBirthStatus;
  certifications: RosterCertification[];
  unmappedCertifications: string[];
  locationKeys: string[];
  unmappedLocations: string[];
}

export interface DuplicateEmail {
  email: string;
  lines: number[];
}

export interface RosterParseResult {
  entries: RosterEntry[];
  invalidEmailLines: number[];
  duplicates: DuplicateEmail[];
}

export class RosterCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RosterCsvError';
  }
}

export const ROSTER_COLUMNS = {
  preferredName: 'preferred name',
  certification: 'highest instructor certification',
  locations: 'preferred teaching locations',
  legalName: 'legal full name',
  dateOfBirth: 'date of birth',
  email: 'email address',
} as const;

type ColumnKey = keyof typeof ROSTER_COLUMNS;

export const LOCATION_KEYS: Record<string, string> = {
  msl: 'teaching_location.moonstone',
  'blue mountain': 'teaching_location.blue_mountain',
  tremblant: 'teaching_location.tremblant',
  'glen eden': 'teaching_location.glen_eden',
};

const DISPLAY_NAME_MAX = 100;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REGULAR_CERT = /^(CSIA|CASI)L([1-4])$/;
const PARK_CERT = /^(CSIA|CASI)PARK([12])$/;
const DOB_SHAPE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

function collapse(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** `CSIA L3`, `casi park 1`, … → `{ org, track, level }`; anything else → null. */
export function mapCertification(value: string): RosterCertification | null {
  const compact = value.toUpperCase().replace(/\s+/g, '');
  const regular = REGULAR_CERT.exec(compact);
  if (regular) {
    return {
      org: regular[1].toLowerCase() as CertOrg,
      track: 'regular',
      level: Number(regular[2]),
    };
  }
  const park = PARK_CERT.exec(compact);
  if (park) {
    return {
      org: park[1].toLowerCase() as CertOrg,
      track: 'park',
      level: Number(park[2]),
    };
  }
  return null;
}

/** Maps a comma-separated certification cell, keeping the highest level per (org, track). */
export function mapCertifications(cell: string): {
  certifications: RosterCertification[];
  unmapped: string[];
} {
  const best = new Map<string, RosterCertification>();
  const unmapped: string[] = [];
  for (const value of splitList(cell)) {
    const cert = mapCertification(value);
    if (!cert) {
      unmapped.push(value);
      continue;
    }
    const key = `${cert.org}:${cert.track}`;
    const current = best.get(key);
    if (!current || cert.level > current.level) {
      best.set(key, cert);
    }
  }
  return { certifications: [...best.values()], unmapped };
}

/** Maps a comma-separated location cell onto `teaching_locations.key` values. */
export function mapLocations(cell: string): {
  keys: string[];
  unmapped: string[];
} {
  const keys: string[] = [];
  const unmapped: string[] = [];
  for (const value of splitList(cell)) {
    const key = LOCATION_KEYS[collapse(value).toLowerCase()];
    if (key === undefined) {
      unmapped.push(value);
    } else if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return { keys, unmapped };
}

/** `M/D/YYYY` → ISO `YYYY-MM-DD` when it is a real past date. */
export function parseDateOfBirth(
  cell: string,
  today: Date = new Date(),
): { value: string | null; status: DateOfBirthStatus } {
  const trimmed = cell.trim();
  if (trimmed === '') {
    return { value: null, status: 'missing' };
  }
  const match = DOB_SHAPE.exec(trimmed);
  if (!match) {
    return { value: null, status: 'invalid' };
  }
  const [month, day, year] = [match[1], match[2], match[3]].map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!real || year < 1900 || date.getTime() >= today.getTime()) {
    return { value: null, status: 'invalid' };
  }
  return { value: date.toISOString().slice(0, 10), status: 'ok' };
}

/** Preferred Name, else the first token of the legal name (nothing else of it is kept). */
export function pickDisplayName(
  preferred: string,
  legal: string,
): { value: string; source: DisplayNameSource } {
  const name = collapse(preferred);
  if (name !== '') {
    return { value: name.slice(0, DISPLAY_NAME_MAX), source: 'preferred' };
  }
  const first = collapse(legal).split(' ')[0] ?? '';
  if (first !== '') {
    return {
      value: first.slice(0, DISPLAY_NAME_MAX),
      source: 'legal_first_token',
    };
  }
  return { value: '', source: 'none' };
}

function resolveColumns(header: string[]): Record<ColumnKey, number> {
  const names = header.map((h) => collapse(h).toLowerCase());
  const result = {} as Record<ColumnKey, number>;
  const missing: string[] = [];
  for (const [key, prefix] of Object.entries(ROSTER_COLUMNS) as [
    ColumnKey,
    string,
  ][]) {
    const index = names.findIndex((n) => n.startsWith(prefix));
    if (index === -1) {
      missing.push(prefix);
    }
    result[key] = index;
  }
  if (missing.length > 0) {
    throw new RosterCsvError(`CSV is missing column(s): ${missing.join(', ')}`);
  }
  return result;
}

/**
 * Parses the Google Form export (columns matched by header text) into one
 * entry per lowercased email. A repeated email keeps its last submission.
 */
export function parseRosterCsv(
  text: string,
  today: Date = new Date(),
): RosterParseResult {
  const [header, ...rows] = parseCsv(text);
  if (!header) {
    throw new RosterCsvError('CSV is empty');
  }
  const col = resolveColumns(header);
  const byEmail = new Map<string, RosterEntry>();
  const linesByEmail = new Map<string, number[]>();
  const invalidEmailLines: number[] = [];

  rows.forEach((row, i) => {
    const line = i + 2;
    const cell = (key: ColumnKey) => row[col[key]] ?? '';
    const email = cell('email').trim().toLowerCase();
    if (!EMAIL_SHAPE.test(email)) {
      invalidEmailLines.push(line);
      return;
    }
    const name = pickDisplayName(cell('preferredName'), cell('legalName'));
    const dob = parseDateOfBirth(cell('dateOfBirth'), today);
    const certs = mapCertifications(cell('certification'));
    const locations = mapLocations(cell('locations'));
    byEmail.set(email, {
      line,
      email,
      displayNameEn: name.value,
      displayNameSource: name.source,
      dateOfBirth: dob.value,
      dateOfBirthStatus: dob.status,
      certifications: certs.certifications,
      unmappedCertifications: certs.unmapped,
      locationKeys: locations.keys,
      unmappedLocations: locations.unmapped,
    });
    linesByEmail.set(email, [...(linesByEmail.get(email) ?? []), line]);
  });

  const duplicates = [...linesByEmail.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([email, lines]) => ({ email, lines }));
  return { entries: [...byEmail.values()], invalidEmailLines, duplicates };
}
