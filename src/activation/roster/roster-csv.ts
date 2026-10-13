import { parseCsv } from '../../shopify/legacy-pairing/pairing-csv';
import {
  normalizeCertifications,
  normalizeLocations,
  type ProposedCertification,
  type ProposedTrainerStatus,
} from './roster-normalize';

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
  certifications: ProposedCertification[];
  trainerStatus: ProposedTrainerStatus[];
  unmappedCertifications: string[];
  locationKeys: string[];
  llmLocationKeys: string[];
  unmappedLocations: string[];
  llmRejected: { value: string; reason: string }[];
  llmResolved: { value: string; proposal: string }[];
  /** Raw certification and location cells, kept for review and the optional LLM pass. */
  raw: RosterRawValues;
  /** True when a value needed normalisation beyond the canonical form or stayed unresolved. */
  needsReview: boolean;
}

export interface RosterRawValues {
  certifications: string;
  certificationDetails: string;
  locations: string;
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

export const OPTIONAL_ROSTER_COLUMNS = {
  certificationDetails: 'when and where did you receive your highest',
} as const;

type ColumnKey =
  | keyof typeof ROSTER_COLUMNS
  | keyof typeof OPTIONAL_ROSTER_COLUMNS;

const DISPLAY_NAME_MAX = 100;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOB_SHAPE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function collapse(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
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
  for (const [key, prefix] of Object.entries(OPTIONAL_ROSTER_COLUMNS) as [
    ColumnKey,
    string,
  ][]) {
    result[key] = names.findIndex((n) => n.startsWith(prefix));
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
    const raw: RosterRawValues = {
      certifications: cell('certification'),
      certificationDetails: cell('certificationDetails'),
      locations: cell('locations'),
    };
    const certs = normalizeCertifications(
      raw.certifications,
      raw.certificationDetails,
    );
    const locations = normalizeLocations(raw.locations);
    byEmail.set(email, {
      line,
      email,
      displayNameEn: name.value,
      displayNameSource: name.source,
      dateOfBirth: dob.value,
      dateOfBirthStatus: dob.status,
      certifications: certs.certifications,
      trainerStatus: certs.trainerStatus,
      unmappedCertifications: certs.unresolved,
      locationKeys: locations.keys,
      llmLocationKeys: [],
      unmappedLocations: locations.unresolved,
      llmRejected: [],
      llmResolved: [],
      raw,
      needsReview: certs.normalized || locations.normalized,
    });
    linesByEmail.set(email, [...(linesByEmail.get(email) ?? []), line]);
  });

  const duplicates = [...linesByEmail.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([email, lines]) => ({ email, lines }));
  return { entries: [...byEmail.values()], invalidEmailLines, duplicates };
}
